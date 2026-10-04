// JOHNNY operator の本体（Deno でも Node でも動く。Deno.serve からは index.ts で呼ぶ）。
// 順序：JOHNNY_ENABLED → 入力 → 認証（お客様セッション／本部セッションを DB で確認）→ 事実の取得 → 監査の記録。
// 認証と事実の取得が終わるまで、監査テーブルには一切書かない。汎用 SQL は持たない（モード別の RPC だけ）。

export type JohnnyMode = 'style' | 'booking' | 'hq'
type ActorType = 'customer' | 'hq'

export interface RpcResult { data: unknown; error: { message?: string; code?: string } | null }
export interface JohnnyDeps {
  env: (name: string) => string | undefined
  rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  now?: () => Date
  uuid?: () => string
}

interface JohnnyRequest {
  mode?: JohnnyMode
  message?: string
  sessionToken?: string
  hqToken?: string
  requestId?: string
  correlationId?: string
  handoff?: { styleTitle?: string; styleSlug?: string; tryonStyleId?: string | null }
  range?: { from?: string; to?: string }
}

interface StyleFact {
  slug: string
  title: string
  category: string
  catch_copy: string | null
  description: string | null
  image_url: string | null
  tags: string[]
  tryon_style_id: string | null
  booking_menu: { code: string; name: string } | null
}
interface BookingMenu { code: string; name: string; duration_min: number; price: number | null; staff_ids?: string[] }
interface BookingOptions { error?: string; menus?: BookingMenu[] }
interface AvailableSlot { starts_at: string; staff_id?: string; staff_name?: string }
interface ToolCallAudit {
  name: string
  args: Record<string, unknown>
  status: 'ok' | 'error'
  summary: Record<string, unknown>
  factAt: string
  factVersion: string
}

export const MODE_TOOL_WHITELIST: Record<JohnnyMode, string[]> = {
  style: ['customer_johnny_profile', 'customer_johnny_style_catalog'],
  booking: ['customer_johnny_profile', 'customer_johnny_style_catalog', 'customer_johnny_booking_options', 'customer_johnny_available_slots'],
  hq: ['hq_johnny_snapshot'],
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'content-type': 'application/json' } })
}
const textOrEmpty = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const validUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return 'sha256:' + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function ymdJst(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
function addDaysJst(now: Date, days: number): string {
  const base = new Date(`${ymdJst(now)}T00:00:00+09:00`)
  base.setUTCDate(base.getUTCDate() + days)
  return ymdJst(base)
}
function inferDate(message: string, now: Date): string | null {
  if (/今日|本日/.test(message)) return ymdJst(now)
  if (/明日/.test(message)) return addDaysJst(now, 1)
  const weekdays: [RegExp, number][] = [[/日曜/, 0], [/月曜/, 1], [/火曜/, 2], [/水曜/, 3], [/木曜/, 4], [/金曜/, 5], [/土曜/, 6]]
  const today = new Date(`${ymdJst(now)}T00:00:00+09:00`).getUTCDay()
  for (const [re, day] of weekdays) {
    if (!re.test(message)) continue
    let delta = (day - today + 7) % 7
    if (delta === 0) delta = 7
    return addDaysJst(now, delta)
  }
  return null
}

function scoreStyle(style: StyleFact, message: string): number {
  const haystack = [style.title, style.category, style.catch_copy ?? '', style.description ?? '', ...style.tags].join(' ')
  let score = 0
  for (const token of message.split(/[\s,，。！？!?.、]+/).filter((t) => t.length >= 2)) if (haystack.includes(token)) score += 4
  const rules: [RegExp, string[], number][] = [
    [/仕事|会社|ビジネス|派手すぎ|怒られ/, ['ビジネス', '清潔感', '短髪', 'ギリギリ'], 5],
    [/セット|手入れ|楽|メンテ|時間ない/, ['メンテフリー', '短髪', '刈り上げ'], 5],
    [/派手|個性|目立|覚悟|攻め/, ['個性', '覚醒', '大胆', 'パンチパーマ'], 4],
    [/色気|モテ|艶|夜/, ['色気', 'モテ', '艶', 'ウェット'], 4],
    [/短|さっぱり|暑|夏/, ['短髪', 'さっぱり', '夏', '刈り上げ'], 4],
    [/威圧|硬派|昭和/, ['威圧', '硬派', '昭和', 'クラシック'], 4],
  ]
  for (const [re, tags, weight] of rules) {
    if (re.test(message) && (style.tags.some((tag) => tags.includes(tag)) || tags.some((tag) => haystack.includes(tag)))) score += weight
  }
  return score
}

/** 引き継いだスタイルの予約メニュー：確認済みの対応（DB）だけ。複数・未確認なら決めない */
export function confirmedMenuForHandoff(styles: StyleFact[], handoff: JohnnyRequest['handoff']): { code: string; name: string } | null {
  if (!handoff) return null
  const candidates = handoff.styleSlug
    ? styles.filter((s) => s.slug === handoff.styleSlug)
    : handoff.tryonStyleId ? styles.filter((s) => s.tryon_style_id === handoff.tryonStyleId) : []
  const codes = [...new Set(candidates.map((s) => s.booking_menu?.code).filter((c): c is string => !!c))]
  if (codes.length !== 1) return null
  return candidates.find((s) => s.booking_menu?.code === codes[0])?.booking_menu ?? null
}

function summarize(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return { count: data.length }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (typeof obj.error === 'string') return { error: obj.error }
    return { keys: Object.keys(obj).slice(0, 12) }
  }
  return { value_type: typeof data }
}
function scrubArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) out[key] = key.includes('session') || key.includes('token') || key === 'p_hq' ? '[redacted]' : value
  return out
}
function slotLabel(slot: AvailableSlot): string {
  const time = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(slot.starts_at))
  return slot.staff_name ? `${time} ${slot.staff_name}` : time
}

export async function handleJohnny(req: Request, deps: JohnnyDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  // サーバー側の有効化（既定は無効）。無効なら何も呼ばない
  if (deps.env('JOHNNY_ENABLED') !== 'true') return json({ error: 'johnny_disabled' }, 404)
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let body: JohnnyRequest
  try { body = await req.json() as JohnnyRequest } catch { return json({ error: 'invalid_json' }, 400) }
  const mode = body.mode
  if (!mode || !['style', 'booking', 'hq'].includes(mode)) return json({ error: 'invalid_mode' }, 400)
  const message = textOrEmpty(body.message)
  if (!message || message.length > 2000) return json({ error: 'invalid_message' }, 400)

  const now = deps.now ?? (() => new Date())
  const uuid = deps.uuid ?? (() => crypto.randomUUID())
  const rid = validUuid(textOrEmpty(body.requestId)) ? textOrEmpty(body.requestId) : uuid()
  const cid = validUuid(textOrEmpty(body.correlationId)) ? textOrEmpty(body.correlationId) : rid
  const actorType: ActorType = mode === 'hq' ? 'hq' : 'customer'
  const token = actorType === 'hq' ? textOrEmpty(body.hqToken) : textOrEmpty(body.sessionToken)
  if (!token) return json({ error: actorType === 'hq' ? 'hq_auth_required' : 'customer_auth_required' }, 401)

  const toolCalls: ToolCallAudit[] = []
  // 事実の取得（モード別の許可リストにある RPC だけ）。呼んだ時刻と結果のハッシュを残す
  const tool = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    if (!MODE_TOOL_WHITELIST[mode].includes(name)) throw new Error(`tool_not_allowed:${name}`)
    const factAt = now().toISOString()
    const { data, error } = await deps.rpc(name, args)
    if (error) {
      toolCalls.push({ name, args: scrubArgs(args), status: 'error', summary: { code: error.code ?? 'error' }, factAt, factVersion: 'unavailable' })
      throw Object.assign(new Error('tool_failed'), { tool: name, code: error.code, message: error.message })
    }
    toolCalls.push({ name, args: scrubArgs(args), status: 'ok', summary: summarize(data), factAt, factVersion: await sha256(data) })
    return data as T
  }

  // ── 1. 認証（DB で確認できるまで監査に書かない）──
  let profile: Record<string, unknown> = {}
  let snapshot: Record<string, unknown> | null = null
  try {
    if (actorType === 'customer') profile = await tool<Record<string, unknown>>('customer_johnny_profile', { p_session: token })
    else snapshot = await tool<Record<string, unknown>>('hq_johnny_snapshot', { p_hq: token, p_from: body.range?.from ?? null, p_to: body.range?.to ?? null })
  } catch {
    return json({ error: actorType === 'hq' ? 'hq_auth_required' : 'customer_auth_required' }, 401)
  }

  // ── 2. 事実の取得 ──
  let answer: string
  let extra: Record<string, unknown>
  let primaryFactAt = toolCalls[0].factAt
  let primaryFactVersion = toolCalls[0].factVersion
  let suggestions: StyleFact[] = []
  try {
    if (mode === 'style') {
      const styles = await tool<StyleFact[]>('customer_johnny_style_catalog', { p_session: token })
      const last = toolCalls[toolCalls.length - 1]
      primaryFactAt = last.factAt; primaryFactVersion = last.factVersion
      suggestions = [...styles].map((s) => ({ s, score: scoreStyle(s, message) }))
        .sort((a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title, 'ja')).slice(0, 3).map((x) => x.s)
      answer = suggestions.length === 0
        ? '今の希望に合う公開スタイルを絞り込めませんでした。条件を少し変えて相談してください。'
        : `候補は ${suggestions.map((s) => s.title).join('、')} です。実在する銀二郎スタイルだけから選んでいます。気になるものは試着か予約相談に進めます。`
      extra = { suggestions }
    } else if (mode === 'booking') {
      // 引き継ぎのスタイル → 予約メニューは確認済みの対応だけ（画面から送られたコードは使わない）
      let handoffMenu: { code: string; name: string } | null = null
      if (body.handoff) handoffMenu = confirmedMenuForHandoff(await tool<StyleFact[]>('customer_johnny_style_catalog', { p_session: token }), body.handoff)
      const options = await tool<BookingOptions>('customer_johnny_booking_options', { p_session: token })
      const last = toolCalls[toolCalls.length - 1]
      primaryFactAt = last.factAt; primaryFactVersion = last.factVersion
      const bookingDisabled = options.error === 'booking_disabled'
      const menus = options.menus ?? []
      let menuStatus: 'confirmed' | 'unconfirmed' | 'none' = 'none'
      let matched: BookingMenu | null = null
      if (body.handoff) {
        // 未確認のスタイルは予約メニューを決めない（文章からも推測しない）
        matched = handoffMenu ? menus.find((m) => m.code === handoffMenu.code) ?? null : null
        menuStatus = handoffMenu ? 'confirmed' : 'unconfirmed'
      } else {
        // 引き継ぎなし：お客様がメニュー名をそのまま書いたときだけ（予約できるメニューの正式名と完全一致）
        matched = menus.find((m) => message.includes(m.name)) ?? null
      }
      const date = inferDate(message, now())
      let slots: AvailableSlot[] = []
      if (!bookingDisabled && matched && date) {
        const r = await tool<AvailableSlot[] | { error?: string }>('customer_johnny_available_slots', { p_session: token, p_date: date, p_menu_codes: [matched.code], p_staff_id: null })
        slots = Array.isArray(r) ? r.slice(0, 5) : []
      }
      answer = bookingDisabled
        ? '現在アプリ内予約は受付停止中です。予約は電話またはHOT PEPPERからお願いします。'
        : menuStatus === 'unconfirmed'
          ? 'このスタイルの予約メニューは未確定です。メニューは店舗で確認しますので、電話またはHOT PEPPERからご予約ください。'
          : slots.length > 0
            ? `予約の空き状況（予約システムで確認）：${slots.slice(0, 3).map(slotLabel).join('、')}`
            : '条件に合う空き枠はまだ提示できません。メニュー、日付、担当の希望を教えてください。'
      extra = { booking_disabled: bookingDisabled, menu_status: menuStatus, matched_menu: matched, slots }
    } else {
      const s = snapshot as { source_fact_at?: string; source_fact_version?: string; sales?: { gross_sales?: number; average_ticket?: number }; booking?: { future_confirmed?: number }; ginpay?: { consistent?: boolean } }
      primaryFactAt = s.source_fact_at ?? primaryFactAt
      primaryFactVersion = s.source_fact_version ?? primaryFactVersion
      const ginpay = s.ginpay?.consistent === false ? 'GINPay台帳に不整合があります。先にreconciliationを確認してください。' : 'GINPay台帳は集計上整合しています。'
      answer = `対象期間の売上は¥${Number(s.sales?.gross_sales ?? 0).toLocaleString()}、客単価は¥${Number(s.sales?.average_ticket ?? 0).toLocaleString()}です。今後の確定予約は${s.booking?.future_confirmed ?? 0}件です。${ginpay}`
      extra = { snapshot }
    }
  } catch {
    answer = 'JOHNNYの取得処理で失敗しました。予約・会計・GINPayの確定処理は実行していません。'
    extra = { failed: true }
  }

  // ── 3. 監査（認証済み・事実の時刻と版つき）──
  const sessionRes = await deps.rpc('johnny_record_session', {
    p_mode: mode, p_actor_type: actorType, p_request_id: rid, p_correlation_id: cid,
    p_source_fact_at: primaryFactAt, p_source_fact_version: primaryFactVersion,
    p_customer_user_id: typeof profile.user_id === 'string' ? profile.user_id : null,
    p_client_id: typeof profile.client_id === 'string' ? profile.client_id : null,
    p_metadata: { tool_whitelist: MODE_TOOL_WHITELIST[mode], handoff: body.handoff ?? null },
  })
  if (sessionRes.error || typeof sessionRes.data !== 'string') return json({ error: 'audit_unavailable' }, 500)
  const sessionId = sessionRes.data
  const base = { p_request_id: rid, p_correlation_id: cid }
  await deps.rpc('johnny_record_message', { p_session_id: sessionId, p_role: mode === 'hq' ? 'hq' : 'customer', p_content: message, ...base,
    p_source_fact_at: primaryFactAt, p_source_fact_version: primaryFactVersion, p_provider: null, p_model: null, p_metadata: {} })
  for (const t of toolCalls) {
    await deps.rpc('johnny_record_tool_call', { p_session_id: sessionId, p_mode: mode, p_tool_name: t.name, p_arguments: t.args, p_result_summary: t.summary,
      p_status: t.status, ...base, p_source_fact_at: t.factAt, p_source_fact_version: t.factVersion })
  }
  await deps.rpc('johnny_record_message', { p_session_id: sessionId, p_role: 'operator', p_content: answer, ...base,
    p_source_fact_at: primaryFactAt, p_source_fact_version: primaryFactVersion, p_provider: 'local-deterministic', p_model: 'johnny-phase1-local',
    p_metadata: { tool_count: toolCalls.length } })
  if (mode === 'style' && suggestions[0]) {
    await deps.rpc('johnny_create_action_intent', {
      p_session_id: sessionId, p_mode: mode, p_intent_type: 'tryon_handoff',
      p_payload: { style_slug: suggestions[0].slug, style_title: suggestions[0].title, tryon_style_id: suggestions[0].tryon_style_id },
      p_idempotency_key: `johnny:${rid}:tryon:${suggestions[0].slug}`,
      p_expires_at: new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString(), ...base,
      p_source_fact_at: primaryFactAt, p_source_fact_version: primaryFactVersion,
    })
  }
  if (extra.failed) return json({ error: 'johnny_failed' }, 500)
  return json({ mode, request_id: rid, correlation_id: cid, answer, provider: 'local-deterministic', ...extra,
    audit: { session_id: sessionId, source_fact_at: primaryFactAt, source_fact_version: primaryFactVersion } })
}
