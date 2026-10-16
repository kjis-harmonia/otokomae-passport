// JOHNNY の頭脳：お客様の言葉を AI が読み取り、空き状況の道具を呼んで、話す言葉と画面に出すものを決める。
//   ・空き・予約の事実は道具（DB の customer_* RPC）の結果だけ。AI は時刻・予約を作らない
//   ・AI が返した時刻・メニュー・予約は、この回に道具が返したもの（または画面に出ている候補）かを必ず確かめる
//   ・予約の確定・キャンセル・変更は、お客様が確認画面で「はい」と答えたときだけアプリが行う（ここでは提案だけ）
// Deno（Edge Function）と Node（試験）の両方から使うので、外の API は fetch と、渡された道具だけを使う。

export interface MenuInfo { code: string; name: string; category?: string | null; duration_min: number; price: number | null; price_from?: boolean | null }
export interface StaffInfo { id: string; name: string }
export interface Reservation { id: string; starts_at: string; status: string; staff_name: string; menu: string; menu_code: string }
export interface DayOverview { date: string; open: boolean; hours: { start: string; end: string } | null; groups: { codes: string[]; slots: string[] }[] }

/** 道具（本番は DB、試験は決まった答え） */
export interface AgentTools {
  dayOverview(date: string): Promise<DayOverview>
  nextSlots(menuCode: string, from: string): Promise<string[]>
  slots(date: string, menuCode: string, staffId: string | null): Promise<string[]>
  reservations(): Promise<Reservation[]>
}

export interface AgentContext {
  /** 今（ISO）。試験では決まった日時にする */
  now: string
  menus: MenuInfo[]
  staff: StaffInfo[]
  lastMenuCode: string | null
  /** 直前に画面に出している候補（「2つ目で」「さっきの11時」に使う） */
  shown?: { menu_code?: string; times?: string[]; staff_id?: string | null }
}

export interface Turn { role: 'user' | 'assistant'; text: string }

export type AgentUi =
  | { type: 'none' }
  | { type: 'menus'; items: { menu_code: string; first_time: string | null }[]; date: string | null }
  | { type: 'slots'; menu_code: string; staff_id: string | null; times: string[] }
  | { type: 'confirm_booking'; menu_code: string; staff_id: string | null; starts_at: string }
  | { type: 'confirm_cancel'; reservation_id: string }
  | { type: 'confirm_change'; reservation_id: string; menu_code: string; staff_id: string | null; starts_at: string }
  | { type: 'reservations'; ids: string[] }
  | { type: 'handoff' }

export interface AgentReply { say: string; ui: AgentUi; tool_calls: number }

export interface LlmConfig { apiKey: string; model: string; fetchImpl?: typeof fetch }

const JST = 9 * 3600000
const jstParts = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + JST)
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), wd: '日月火水木金土'[d.getUTCDay()] }
}
const addDays = (date: string, n: number) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
const toIso = (date: string, hm: string) => new Date(`${date}T${hm}:00+09:00`).toISOString()
/** 時刻の表記を揃えて比べる（AI は「2026-10-17T10:00:00+09:00」「…Z」どちらでも書くことがある） */
const sameInstant = (a: string, b: string) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && x === y }

function systemPrompt(ctx: AgentContext): string {
  const now = jstParts(ctx.now)
  const week = Array.from({ length: 14 }, (_, i) => { const d = addDays(now.date, i); const p = jstParts(toIso(d, '12:00')); return `${d}（${p.wd}）${i === 0 ? '今日' : i === 1 ? '明日' : i === 2 ? 'あさって' : ''}` }).join('、')
  const menus = ctx.menus.map(m => `${m.code}\t${m.name}\t${m.category ?? ''}\t${m.duration_min}分\t${m.price == null ? '店頭' : `${m.price}円${m.price_from ? '〜' : ''}`}${m.code === ctx.lastMenuCode ? '\t前回' : ''}`).join('\n')
  const staff = ctx.staff.map(s => `${s.id}\t${s.name}`).join('\n')
  return `あなたは理容室「ピシャッと二代目銀二郎」の予約アシスタント JOHNNY です。お客様（会員）とアプリで話して、予約・キャンセル・日時の変更を手伝います。
いまは ${now.date}（${now.wd}）${now.time}（日本時間）です。これから2週間の日付：${week}

# 守ること
- 空き時間・予約の有無は、必ず道具で確かめる。道具の結果に無い時刻・予約を言わない、作らない。
- 予約・キャンセル・変更は、あなたが確定しない。必ず respond の ui で確認画面（confirm_*）を出し、お客様の「はい」を待つ。
- 時刻は道具が返した ISO 文字列をそのまま ui に入れる。
- メニューは下の表の code だけを使う。表に無いメニューは作らない。料金と時間は表の数字だけを言う。
- 話す言葉（say）は日本語で、短く、話し言葉で。2〜3文、80字くらいまで。時刻は「18時半」「11時15分」のように読む。日付は「今日」「明日」「10月20日の火曜」のように言う。
- 1回の返事で、お客様が次に答えることは1つだけにする。
- 予約と関係ない話・医療の話はしない。分からない・できないこと（3人以上の予約、遠い先の予約など）は、お電話（090-2800-5425）をご案内する（ui: handoff）。

# 進め方（先回りして提案する）
- 日だけ・「空いてる？」だけ → day_overview で見て、受付時間と、入れられるメニューと一番早い時刻を2〜3個言い、ui: menus（空きのあるメニューだけ）。その日に空きが無ければ次の日も見て案内する。
- メニューだけ（日時なし） → next_slots で一番早い空きを探し、間をあけて2〜3個言い、ui: slots。
- 日時とメニューの両方 → slots で確かめる。ぴったり空いていれば ui: confirm_booking。埋まっていれば近い時刻や次の日を提案（ui: slots）。
- 「前回と同じ」「いつもの」 → 表で「前回」のメニュー。
- 担当の指名（「テイテイさんで」など） → staff の id を slots の staff_id に入れて確かめ、ui にも staff_id を入れる。指名が無ければ staff_id は null。
- 「2つ目で」「さっきの11時で」 → 画面に出ている候補（shown）から選ぶ。
- キャンセル・変更・「予約いつだっけ」 → my_reservations で確かめる。予約が1つなら ui: confirm_cancel / 変更なら新しい日時を確かめて ui: confirm_change。複数あって分からなければ ui: reservations で選んでもらう。
- 料金や時間の質問は表の数字で答え、予約の話に戻す。
- 2人以上（「わしと息子で」など）は、まだアプリでは1人ずつ。「おひとりずつご予約ください。お急ぎならお電話でも承ります」と案内する。

# メニュー表（code・名前・種類・時間・料金）
${menus}

# スタッフ（id・名前）
${staff}

最後は必ず respond を呼ぶ。`
}

const TOOLS = [
  { type: 'function', function: { name: 'day_overview', description: 'その日の受付時間と、メニューごとの空き時間（空きのあるメニューだけ）', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD（日本時間）' } }, required: ['date'], additionalProperties: false } } },
  { type: 'function', function: { name: 'next_slots', description: 'メニューの空きを、from の日から近い順に探す（最大10件）', parameters: { type: 'object', properties: { menu_code: { type: 'string' }, from: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['menu_code', 'from'], additionalProperties: false } } },
  { type: 'function', function: { name: 'slots', description: 'その日・そのメニューの空き時間。staff_id を入れるとその担当だけ', parameters: { type: 'object', properties: { date: { type: 'string' }, menu_code: { type: 'string' }, staff_id: { type: ['string', 'null'] } }, required: ['date', 'menu_code', 'staff_id'], additionalProperties: false } } },
  { type: 'function', function: { name: 'my_reservations', description: 'このお客様のこれからの予約', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'respond', description: 'お客様への返事と、画面に出すもの。最後に必ず1回呼ぶ', parameters: {
    type: 'object', additionalProperties: false, required: ['say', 'ui'],
    properties: {
      say: { type: 'string' },
      ui: { type: 'object', additionalProperties: false, required: ['type', 'menu_codes', 'menu_code', 'staff_id', 'times', 'starts_at', 'reservation_id', 'reservation_ids', 'date'],
        properties: {
          type: { type: 'string', enum: ['none', 'menus', 'slots', 'confirm_booking', 'confirm_cancel', 'confirm_change', 'reservations', 'handoff'] },
          menu_codes: { type: 'array', items: { type: 'string' }, description: 'menus のとき' },
          date: { type: ['string', 'null'], description: 'menus のときの日付' },
          menu_code: { type: ['string', 'null'] },
          staff_id: { type: ['string', 'null'] },
          times: { type: 'array', items: { type: 'string' }, description: 'slots のとき（ISO）' },
          starts_at: { type: ['string', 'null'], description: 'confirm_booking / confirm_change のとき（ISO）' },
          reservation_id: { type: ['string', 'null'] },
          reservation_ids: { type: 'array', items: { type: 'string' } },
        } },
    } } } },
] as const

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }

/** 道具の結果を AI に渡す形にする（メニューの名前つき・時刻は日本時間の読みも添える） */
function describeOverview(o: DayOverview, ctx: AgentContext) {
  if (!o.open || !o.hours) return { date: o.date, open: false }
  const names = new Map(ctx.menus.map(m => [m.code, m]))
  const menus = o.groups.flatMap(g => g.codes.map(code => ({ code, name: names.get(code)?.name ?? code, minutes: names.get(code)?.duration_min ?? null, times: g.slots.slice(0, 8).map(s => ({ iso: s, jst: jstParts(s).time })), count: g.slots.length })))
  return { date: o.date, open: true, hours: o.hours, menus }
}

export async function runAgent(ctx: AgentContext, history: Turn[], utterance: string, tools: AgentTools, llm: LlmConfig): Promise<AgentReply> {
  const fetchImpl = llm.fetchImpl ?? fetch
  const seenTimes = new Map<string, Set<string>>() // menu_code → 道具が返した時刻
  const remember = (code: string, times: string[]) => { const s = seenTimes.get(code) ?? new Set<string>(); times.forEach(t => s.add(t)); seenTimes.set(code, s) }
  let seenReservations: Reservation[] | null = null
  if (ctx.shown?.menu_code && ctx.shown.times) remember(ctx.shown.menu_code, ctx.shown.times)

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(ctx) },
    ...history.slice(-10).map(t => ({ role: t.role, content: t.text }) as ChatMessage),
    { role: 'user', content: ctx.shown ? `${utterance}\n（画面に出ている候補：${JSON.stringify(ctx.shown)}）` : utterance },
  ]
  let toolCalls = 0
  for (let round = 0; round < 6; round++) {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llm.model, messages, tools: TOOLS, tool_choice: 'required', parallel_tool_calls: true, reasoning_effort: 'none', max_completion_tokens: 900 }),
    })
    if (!res.ok) throw new Error(`ai_unavailable ${res.status} ${(await res.text()).slice(0, 300)}`)
    const data = await res.json()
    const msg = data.choices?.[0]?.message
    const calls = (msg?.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[]
    if (calls.length === 0) throw new Error('ai_no_tool_call')
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls })
    for (const call of calls) {
      toolCalls++
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { /* 空のまま */ }
      if (call.function.name === 'respond') {
        const checked = validate(args, ctx, seenTimes, seenReservations)
        if (checked.ok) return { say: checked.say, ui: checked.ui, tool_calls: toolCalls }
        // 道具に無い時刻・予約を出そうとした：理由を返して、もう一度考えさせる
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: checked.error }) })
        continue
      }
      let out: unknown
      try {
        if (call.function.name === 'day_overview') {
          const o = await tools.dayOverview(String(args.date))
          o.groups.forEach(g => g.codes.forEach(c => remember(c, g.slots)))
          out = describeOverview(o, ctx)
        } else if (call.function.name === 'next_slots') {
          const code = String(args.menu_code)
          const times = await tools.nextSlots(code, String(args.from))
          remember(code, times)
          out = times.map(t => ({ iso: t, jst: `${jstParts(t).date} ${jstParts(t).time}` }))
        } else if (call.function.name === 'slots') {
          const code = String(args.menu_code)
          const times = await tools.slots(String(args.date), code, typeof args.staff_id === 'string' ? args.staff_id : null)
          remember(code, times)
          out = times.map(t => ({ iso: t, jst: jstParts(t).time }))
        } else if (call.function.name === 'my_reservations') {
          seenReservations = await tools.reservations()
          out = seenReservations.map(r => ({ id: r.id, when: `${jstParts(r.starts_at).date} ${jstParts(r.starts_at).time}`, iso: r.starts_at, menu: r.menu, menu_code: r.menu_code, staff: r.staff_name, status: r.status }))
        } else out = { error: 'unknown_tool' }
      } catch (e) { out = { error: String((e as Error).message ?? e) } }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) })
    }
  }
  throw new Error('ai_too_many_rounds')
}

type Checked = { ok: true; say: string; ui: AgentUi } | { ok: false; error: string }

function validate(args: Record<string, unknown>, ctx: AgentContext, seenTimes: Map<string, Set<string>>, reservations: Reservation[] | null): Checked {
  const say = typeof args.say === 'string' ? args.say.trim().slice(0, 240) : ''
  const u = (args.ui ?? {}) as Record<string, unknown>
  if (!say) return { ok: false, error: 'say が空です' }
  const menuOk = (c: unknown): c is string => typeof c === 'string' && ctx.menus.some(m => m.code === c)
  const staffOk = (s: unknown) => s == null || (typeof s === 'string' && ctx.staff.some(x => x.id === s))
  const staffOf = (s: unknown) => (typeof s === 'string' ? s : null)
  const timeSeen = (code: string, t: unknown) => typeof t === 'string' && [...(seenTimes.get(code) ?? [])].some(x => sameInstant(x, t))
  const canon = (code: string, t: string) => [...(seenTimes.get(code) ?? [])].find(x => sameInstant(x, t)) ?? t
  const resOk = (id: unknown) => typeof id === 'string' && !!reservations?.some(r => r.id === id)
  switch (u.type) {
    case 'none': case 'handoff': return { ok: true, say, ui: { type: u.type } }
    case 'menus': {
      const codes = (Array.isArray(u.menu_codes) ? u.menu_codes : []).filter(menuOk)
      if (codes.length === 0) return { ok: false, error: 'menus の menu_codes が表に無いか空です' }
      const items = codes.slice(0, 12).map(c => { const first = [...(seenTimes.get(c) ?? [])].sort()[0] ?? null; return { menu_code: c, first_time: first } })
      return { ok: true, say, ui: { type: 'menus', items, date: typeof u.date === 'string' ? u.date : null } }
    }
    case 'slots': {
      if (!menuOk(u.menu_code)) return { ok: false, error: 'slots の menu_code が表に無いです' }
      const code = u.menu_code
      const times = (Array.isArray(u.times) ? u.times : []).filter(t => timeSeen(code, t)).map(t => canon(code, t as string))
      if (times.length === 0) return { ok: false, error: 'slots の times が、道具で確かめた空き時間にありません。道具で確かめてから出してください' }
      if (!staffOk(u.staff_id)) return { ok: false, error: 'staff_id がスタッフ表にありません' }
      return { ok: true, say, ui: { type: 'slots', menu_code: code, staff_id: staffOf(u.staff_id), times: times.slice(0, 4) } }
    }
    case 'confirm_booking': case 'confirm_change': {
      if (!menuOk(u.menu_code)) return { ok: false, error: 'menu_code が表に無いです' }
      const code = u.menu_code
      if (!timeSeen(code, u.starts_at)) return { ok: false, error: 'starts_at が道具で確かめた空き時間にありません。slots で確かめてください' }
      if (!staffOk(u.staff_id)) return { ok: false, error: 'staff_id がスタッフ表にありません' }
      if (u.type === 'confirm_change' && !resOk(u.reservation_id)) return { ok: false, error: '変更する予約が my_reservations にありません' }
      const starts_at = canon(code, u.starts_at as string)
      return u.type === 'confirm_booking'
        ? { ok: true, say, ui: { type: 'confirm_booking', menu_code: code, staff_id: staffOf(u.staff_id), starts_at } }
        : { ok: true, say, ui: { type: 'confirm_change', reservation_id: u.reservation_id as string, menu_code: code, staff_id: staffOf(u.staff_id), starts_at } }
    }
    case 'confirm_cancel':
      if (!resOk(u.reservation_id)) return { ok: false, error: '取り消す予約が my_reservations にありません。my_reservations で確かめてください' }
      return { ok: true, say, ui: { type: 'confirm_cancel', reservation_id: u.reservation_id as string } }
    case 'reservations': {
      const ids = (Array.isArray(u.reservation_ids) ? u.reservation_ids : []).filter(resOk) as string[]
      if (ids.length === 0) return { ok: false, error: 'reservation_ids が my_reservations にありません' }
      return { ok: true, say, ui: { type: 'reservations', ids } }
    }
    default: return { ok: false, error: `ui.type が不正です：${String(u.type)}` }
  }
}
