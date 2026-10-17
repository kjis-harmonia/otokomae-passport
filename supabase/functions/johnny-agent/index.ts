// JOHNNY の予約 AI の入口（Edge Function）。お客様アプリの予約アシスタントから呼ぶ。
//   入力：{ session: 顧客セッション, message: お客様の言葉（300字まで）, history: 直前の会話（10往復まで）, shown: 画面に出している候補 }
//         声で話したときは message の代わりに audio（録音の base64）と mime。transcribe_only なら文字にするだけ（確認画面の「はい」など）
//         speak（話す言葉）なら、JOHNNY の声（PCM 16bit・24kHz・モノラル）を少しずつ返す
//   出力：{ heard?: 聞き取った文, say: 話す言葉, ui: 画面に出すもの }（agent.ts の AgentReply）。聞き取れたが AI が失敗したら { heard, error }
// 決まり：
//   ・空き・予約は、お客様のセッションで DB の customer_* RPC を呼んで調べる（他のお客様のものは見えない）
//   ・予約の確定・キャンセル・変更はしない。ui の確認画面で「はい」が押されたら、アプリが RPC を呼ぶ
//   ・名前・電話番号は AI に送らない。API キーは Secrets（OPENAI_API_KEY）だけ。無ければ 503（アプリは決まった規則の JOHNNY に切り替える）
// モデルは OPENAI_MODEL（既定 gpt-6-luna）。
import { runAgent, type AgentContext, type AgentTools, type DayOverview, type MenuInfo, type Reservation, type StaffInfo, type Turn } from './agent.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-6-luna'
const STT_MODEL = Deno.env.get('OPENAI_TRANSCRIBE_MODEL') ?? 'gpt-transcribe'
const TTS_MODEL = Deno.env.get('OPENAI_TTS_MODEL') ?? 'gpt-4o-mini-tts'
const TTS_VOICE = Deno.env.get('OPENAI_TTS_VOICE') ?? 'cedar'
const TTS_STYLE = '理容室「二代目銀二郎」の受付。親しみやすく落ち着いた話し方で、はっきり、少し速めに。日本語の自然な抑揚で。'
/** 録音の上限（base64 で約 2MB＝20 秒ほど） */
const MAX_AUDIO_B64 = 2_000_000

/** 録音を文字にする。メニュー名・スタッフ名を手がかりに渡して、聞き間違いを減らす */
async function transcribe(b64: string, mime: string, menus: MenuInfo[], staff: StaffInfo[]): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const ext = /mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime || 'audio/webm' }), `voice.${ext}`)
  form.append('model', STT_MODEL)
  form.append('language', 'ja')
  form.append('prompt', `理容室の予約の会話。メニュー：${menus.map(m => m.name).join('、').slice(0, 600)}。スタッフ：${staff.map(x => x.name).join('、')}。`)
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form })
  if (!r.ok) throw new Error(`stt_unavailable ${r.status} ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  return typeof data.text === 'string' ? data.text.trim().slice(0, 300) : ''
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

class RpcFailed extends Error { constructor(public code: string, public status: number) { super(code) } }

/** お客様のセッションで RPC を呼ぶ。DB が { error } を返したら RpcFailed */
async function rpc<T>(name: string, session: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_session: session, ...args }),
  })
  if (!r.ok) throw new RpcFailed(r.status === 400 || r.status === 401 || r.status === 403 ? 'customer_auth_required' : 'db_unavailable', r.status)
  const data = await r.json()
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { error?: unknown }).error === 'string') throw new RpcFailed(String((data as { error: string }).error), 200)
  return data as T
}

const addDays = (date: string, n: number) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)

interface CustomerReservation { id: string; starts_at: string; status: string; staff_name: string; nominated?: boolean; items: { menu_code: string; name: string }[] }

function tools(session: string, staff: StaffInfo[]): AgentTools {
  const slotsOf = async (date: string, code: string, staffId: string | null) =>
    (await rpc<{ starts_at: string }[]>('customer_available_slots', session, { p_date: date, p_menu_codes: [code], p_staff_id: staffId })).map(s => s.starts_at)
  return {
    dayOverview: date => rpc<DayOverview>('customer_day_overview', session, { p_date: date }),
    slots: slotsOf,
    async nextSlots(code, from, staffId) {
      if (!staffId) return (await rpc<{ starts_at: string }[]>('customer_next_slots', session, { p_menu_codes: [code], p_from: from, p_limit: 10 })).map(s => s.starts_at)
      // 指名ありは、その担当の空きを1週間ずつまとめて探す（最大4週間）
      const out: string[] = []
      for (let week = 0; week < 4 && out.length < 10; week++) {
        const days = Array.from({ length: 7 }, (_, i) => addDays(from, week * 7 + i))
        const found = await Promise.all(days.map(d => slotsOf(d, code, staffId).catch(() => [] as string[])))
        for (const times of found) out.push(...times.slice(0, 10 - out.length))
      }
      return out
    },
    async reservations() {
      const list = await rpc<CustomerReservation[]>('customer_list_reservations', session)
      return list
        .filter(r => r.status === 'confirmed' && Date.parse(r.starts_at) > Date.now())
        .map((r): Reservation => ({ id: r.id, starts_at: r.starts_at, status: r.status, staff_name: r.staff_name, menu: r.items.map(i => i.name).join('・'), menu_code: r.items[0]?.menu_code ?? '', staff_id: r.nominated ? staff.find(s => s.name === r.staff_name)?.id ?? null : null }))
    },
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isoOk = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v))

function cleanHistory(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(-20).flatMap((t): Turn[] => {
    const role = (t as { role?: unknown })?.role, text = str((t as { text?: unknown })?.text, 300)
    return (role === 'user' || role === 'assistant') && text ? [{ role, text }] : []
  })
}

function cleanShown(raw: unknown, menus: MenuInfo[], staff: StaffInfo[]): AgentContext['shown'] {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const menuOk = (c: unknown): c is string => typeof c === 'string' && menus.some(m => m.code === c)
  const staffOf = (s: unknown) => (typeof s === 'string' && staff.some(x => x.id === s) ? s : null)
  const shown: NonNullable<AgentContext['shown']> = {}
  if (menuOk(r.menu_code) && Array.isArray(r.times)) {
    shown.menu_code = r.menu_code
    shown.times = r.times.filter(isoOk).slice(0, 6)
    shown.staff_id = staffOf(r.staff_id)
  }
  const c = r.confirm as Record<string, unknown> | undefined
  if (c && menuOk(c.menu_code) && isoOk(c.starts_at)) shown.confirm = { menu_code: c.menu_code, starts_at: c.starts_at, staff_id: staffOf(c.staff_id) }
  return shown.times?.length || shown.confirm ? shown : undefined
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (!OPENAI_KEY) return json(503, { error: 'not_configured' })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'invalid_request' }) }
  const session = str(body.session, 200)
  // JOHNNY の声：OpenAI の音声をそのまま流す（アプリは届いた分から再生する）
  const speakText = str(body.speak, 300)
  if (speakText) {
    if (session.length < 32) return json(401, { error: 'customer_auth_required' })
    // ログインの確認と音声づくりを同時に始める（確認できなければ音声は返さない）
    const authed = rpc('customer_get_tickets', session).then(() => true, () => false)
    const speech = fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: speakText, instructions: TTS_STYLE, response_format: 'pcm' }),
    })
    if (!(await authed)) { speech.then(x => x.body?.cancel()).catch(() => {}); return json(401, { error: 'customer_auth_required' }) }
    const r = await speech
    if (!r.ok || !r.body) return json(502, { error: 'tts_unavailable' })
    return new Response(r.body, { status: 200, headers: { ...CORS, 'Content-Type': 'audio/pcm', 'Cache-Control': 'no-store' } })
  }
  let message = str(body.message, 300)
  const audio = typeof body.audio === 'string' && body.audio.length <= MAX_AUDIO_B64 ? body.audio : ''
  if (!message && !audio) return json(400, { error: 'invalid_request' })
  if (session.length < 32) return json(401, { error: 'customer_auth_required' })

  try {
    // セッションの確認と、予約できるメニュー・スタッフを一度に
    // 「いつもの」用に、これまでの予約も同時に読む（いちばん新しい過去の予約のメニュー）
    const [opts, past] = await Promise.all([
      rpc<{ menus: MenuInfo[]; staff: StaffInfo[] }>('customer_booking_options', session),
      rpc<CustomerReservation[]>('customer_list_reservations', session).catch(() => [] as CustomerReservation[]),
    ])
    const t = tools(session, opts.staff)
    let heard: string | undefined
    if (audio) {
      heard = await transcribe(audio, str(body.mime, 60), opts.menus, opts.staff)
      // 聞き取れなかった・文字にするだけ：AI には聞かない
      if (!heard || body.transcribe_only === true) return json(200, { heard })
      message = heard
    }
    const last = past.filter(r => Date.parse(r.starts_at) <= Date.now() && r.status !== 'cancelled' && r.status !== 'no_show').sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at))[0]
    const ctx: AgentContext = {
      now: new Date().toISOString(),
      menus: opts.menus,
      staff: opts.staff,
      lastMenuCode: last?.items[0]?.menu_code ?? null,
      shown: cleanShown(body.shown, opts.menus, opts.staff),
    }
    try {
      const reply = await runAgent(ctx, cleanHistory(body.history), message, t, { apiKey: OPENAI_KEY, model: MODEL })
      return json(200, { heard, say: reply.say, ui: reply.ui })
    } catch (e) {
      // 声は聞き取れたのに AI が失敗：聞き取った文だけ返す（アプリは決まった規則の JOHNNY で続ける）
      if (heard) { console.error('[johnny-agent]', String((e as Error)?.message ?? e).slice(0, 300)); return json(200, { heard, error: 'ai_failed' }) }
      throw e
    }
  } catch (e) {
    if (e instanceof RpcFailed) {
      if (e.code === 'customer_auth_required') return json(401, { error: e.code })
      if (e.code === 'booking_disabled') return json(409, { error: e.code })
      return json(502, { error: e.code })
    }
    const msg = String((e as Error)?.message ?? e)
    console.error('[johnny-agent]', msg.slice(0, 300))
    return json(502, { error: /^(ai|stt)_/.test(msg) ? msg.split(' ')[0] : 'agent_failed' })
  }
})
