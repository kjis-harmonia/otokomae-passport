// JOHNNY の頭脳：お客様の言葉を AI が読み取り、空き状況の道具を呼んで、話す言葉と画面に出すものを決める。
//   ・空き・予約の事実は道具（DB の customer_* RPC）の結果だけ。AI は時刻・予約を作らない
//   ・AI が返した時刻・メニュー・予約は、この回に道具が返したもの（または画面に出ている候補）かを必ず確かめる
//   ・予約の確定・キャンセル・変更は、お客様が確認画面で「はい」と答えたときだけアプリが行う（ここでは提案だけ）
// Deno（Edge Function）と Node（試験）の両方から使うので、外の API は fetch と、渡された道具だけを使う。

export interface MenuInfo { code: string; name: string; category?: string | null; duration_min: number; price: number | null; price_from?: boolean | null }
export interface StaffInfo { id: string; name: string }
/** staff_id：指名の予約だけ（変更のときも同じ担当のままにする） */
export interface Reservation { id: string; starts_at: string; status: string; staff_name: string; menu: string; menu_code: string; staff_id?: string | null }
export interface DayOverview { date: string; open: boolean; hours: { start: string; end: string } | null; groups: { codes: string[]; slots: string[] }[] }

/** 道具（本番は DB、試験は決まった答え） */
export interface AgentTools {
  dayOverview(date: string): Promise<DayOverview>
  nextSlots(menuCode: string, from: string, staffId: string | null): Promise<string[]>
  slots(date: string, menuCode: string, staffId: string | null): Promise<string[]>
  reservations(): Promise<Reservation[]>
}

export interface ShownConfirm { menu_code: string; starts_at: string; staff_id: string | null }
export interface AgentContext {
  /** 今（ISO）。試験では決まった日時にする */
  now: string
  menus: MenuInfo[]
  staff: StaffInfo[]
  lastMenuCode: string | null
  /** 直前に画面に出している候補（「2つ目で」「さっきの11時」に使う） */
  shown?: { menu_code?: string; times?: string[]; staff_id?: string | null; confirm?: ShownConfirm }
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

// 試験（Node）で JOHNNY_DEBUG=1 のときだけ、AI の使った量と差し戻しを出す（Deno には process が無いことがある）
const DEBUG = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.JOHNNY_DEBUG
const JST = 9 * 3600000
const jstParts = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + JST)
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), wd: '日月火水木金土'[d.getUTCDay()] }
}
const addDays = (date: string, n: number) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
const toIso = (date: string, hm: string) => new Date(`${date}T${hm}:00+09:00`).toISOString()
/** 時刻の表記を揃えて比べる（AI は「2026-10-17T10:00:00+09:00」「…Z」どちらでも書くことがある） */
const sameInstant = (a: string, b: string) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && x === y }

const WD = '日月火水木金土'
/** 今日から n 日分の日付と呼び方（今日・明日・あさって・今週の火曜・来週の火曜・再来週の火曜） */
function calendar(today: string, n: number) {
  const wdOf = (d: string) => new Date(d + 'T12:00:00Z').getUTCDay()
  const monday = addDays(today, -((wdOf(today) + 6) % 7))
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(today, i), wd = WD[wdOf(date)]
    const week = Math.floor((Date.parse(date) - Date.parse(monday)) / (7 * 86400000))
    const labels = [i === 0 ? '今日' : i === 1 ? '明日' : i === 2 ? 'あさって' : '', week === 0 ? `今週の${wd}曜` : week === 1 ? `来週の${wd}曜` : week === 2 ? `再来週の${wd}曜` : ''].filter(Boolean)
    return { date, wd, week, labels }
  })
}

const KNUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const kanjiToNum = (x: string) => {
  if (!x.includes('十')) return x.split('').reduce((a, c) => a * 10 + (KNUM[c] ?? 0), 0)
  const [a, b] = x.split('十'); return (a ? KNUM[a] : 1) * 10 + (b ? KNUM[b] : 0)
}
const KANA_NUM: Record<string, number> = { いち: 1, に: 2, さん: 3, よ: 4, ご: 5, ろく: 6, しち: 7, なな: 7, はち: 8, く: 9 }
/** 音声の聞き取りで出る数字の書き方を揃える：「さんじ」「十五時」「ごご3じ」→ 15時・午後3時、「10/22」→ 10月22日 */
export function normalizeSpoken(utterance: string): string {
  let t = utterance.normalize('NFKC')
  t = t.replace(/ごご/g, '午後').replace(/ごぜん/g, '午前').replace(/みょうにち/g, '明日')
  t = t.replace(/[一二三四五六七八九十]{1,3}(?=時|日|月|分)/g, x => String(kanjiToNum(x)))
  t = t.replace(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, '$1月$2日')
  t = t.replace(/(\d{1,2})じ(はん)?/g, (_, n, h) => `${n}時${h ? '半' : ''}`)
  t = t.replace(/(?<=^|[のにでは、\s]|午後|午前|夕方|夜)(じゅう)?(いち|に|さん|よ|ご|ろく|しち|なな|はち|く)?じ(?!かん)(はん)?/g, (all, ju, u, han) => {
    if (!ju && !u) return all
    return `${(ju ? 10 : 0) + (u ? KANA_NUM[u] : 0)}時${han ? '半' : ''}`
  })
  return t
}
const CORRECTION = /いや|じゃなく|やなく|やっぱ|違う|ちがう/

/** お客様の言葉の日付を、決まった規則で日付に直す（AI に読ませる前のヒント） */
export function readDates(utterance: string, today: string): { phrase: string; date: string }[] {
  const t = normalizeSpoken(utterance)
  const cal = calendar(today, 60)
  const out: { phrase: string; date: string }[] = []
  const add = (phrase: string, date: string | undefined) => { if (date && !out.some(o => o.date === date)) out.push({ phrase, date }) }
  if (/今日|本日|きょう/.test(t)) add('今日', today)
  if (/今から|これから|このあと|この後|今すぐ|\d+時間半?後|\d+分後/.test(t)) add('今から', today)
  if (/しあさって|明々後日|明明後日/.test(t)) add('しあさって', addDays(today, 3))
  else if (/明後日|あさって/.test(t)) add('あさって', addDays(today, 2))
  else if (/明日|あした|あす(?!か)/.test(t)) add('明日', addDays(today, 1))
  for (const m of t.matchAll(/(再来週|来週|今週)(?:の)?\s*([月火水木金土日])(?:曜日?)?/g)) {
    const week = m[1] === '今週' ? 0 : m[1] === '来週' ? 1 : 2
    add(m[0], cal.find(c => c.week === week && c.wd === m[2])?.date)
  }
  for (const m of t.matchAll(/(再来週|来週|今週)末/g)) {
    const week = m[1] === '今週' ? 0 : m[1] === '来週' ? 1 : 2
    cal.filter(c => c.week === week && (c.wd === '土' || c.wd === '日')).forEach(c => add(m[0], c.date))
  }
  if (/(?<![再来今])週末/.test(t)) cal.filter(c => c.week === 0 && (c.wd === '土' || c.wd === '日')).forEach(c => add('週末', c.date))
  // 「火曜」「火曜日」だけ（今週・来週が付かない）：今日以降でいちばん近い日
  for (const m of t.matchAll(/(?<!(?:再来週|来週|今週)(?:の)?\s*)([月火水木金土日])曜/g)) add(m[0], cal.find(c => c.wd === m[1] && c.date !== today)?.date)
  for (const m of t.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
    const mm = Number(m[1]), dd = Number(m[2]); let y = Number(today.slice(0, 4))
    let d = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    if (d < today) { y++; d = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` }
    add(m[0], d)
  }
  for (const m of t.matchAll(/(?<![\d月])(\d{1,2})日(?!間)/g)) {
    const dd = Number(m[1]); const c = cal.find(x => Number(x.date.slice(8, 10)) === dd)
    add(m[0], c?.date)
  }
  // 「火曜、じゃなくて木曜」：言い直したあとの日を先に
  if (CORRECTION.test(t) && out.length > 1) out.reverse()
  return out.slice(0, 3)
}

/** お客様の言葉の時刻（お店は10〜20時なので「3時」は15時）。「朝一」「一番早い」は first */
export function readTime(utterance: string, nowHm?: string): string | 'first' | null {
  const t = normalizeSpoken(utterance)
  if (/朝一|朝イチ|あさいち|一番早い時間/.test(t)) return 'first'
  const hm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  const rel = t.match(/(\d{1,2})時間(半)?後|(\d{1,3})分後/)
  if (rel && nowHm) {
    const [h0, m0] = nowHm.split(':').map(Number)
    const x = Math.ceil((h0 * 60 + m0 + (rel[1] ? Number(rel[1]) * 60 + (rel[2] ? 30 : 0) : Number(rel[3]))) / 15) * 15
    return hm(Math.floor(x / 60), x % 60)
  }
  const found: { at: number; v: string }[] = []
  for (const m of t.matchAll(/(\d{1,2}):(\d{2})/g)) { let h = Number(m[1]); if (h < 10) h += 12; found.push({ at: m.index ?? 0, v: hm(h, Number(m[2])) }) }
  for (const m of t.matchAll(/(午前|午後|夕方|夜)?\s*(\d{1,2})時(?!間)(半|\s*(\d{1,2})分)?/g)) {
    let h = Number(m[2]); const min = m[3] === '半' ? 30 : m[4] ? Number(m[4]) : 0
    if (m[1] !== '午前' && h < 10) h += 12
    if (h >= 10 && h <= 20 && min <= 59) found.push({ at: m.index ?? 0, v: hm(h, min) })
  }
  if (!found.length) return null
  found.sort((a, b) => a.at - b.at)
  return (CORRECTION.test(t) ? found[found.length - 1] : found[0]).v
}

const MENU_WORDS: [RegExp, string][] = [[/ぬれぱん|濡れぱん|ヌレパン/g, '濡れパン'], [/ぱんち/g, 'パンチ'], [/かっと/g, 'カット'], [/ぱーま/g, 'パーマ'], [/ぎんぱら/g, 'ギンパラ'], [/坊主|ぼうず/g, '丸刈り'], [/顔剃り|顔ぞり|かおそり|ひげそり|髭剃り/g, '顔そり男性'], [/白髪ぞめ|しらがぞめ/g, '白髪染め'], [/(?:子供|こども|子ども|キッズ)の?(?:スキン)?フェード/g, '子供スキンフェード'], [/(?:子供|こども|子ども|小学生)の?(?:子の?)?(?:散髪|カット|髪)/g, '小学生'], [/アフロ(?!系)/g, 'アフロ系'], [/(?<![ヘ白])カラー/g, 'ヘアカラー']]
/** 言葉に名前がそのまま出てくるメニュー（いちばん長く一致したもの）。事前に空きを調べるためだけに使う */
function mentionedMenu(utterance: string, ctx: AgentContext): MenuInfo | null {
  let t = normalizeSpoken(utterance)
  for (const [re, to] of MENU_WORDS) t = t.replace(re, to)
  if (/いつもの|前回|前と同じ/.test(t) && ctx.lastMenuCode) return ctx.menus.find(m => m.code === ctx.lastMenuCode) ?? null
  const set = ctx.menus.filter(m => m.name.includes('&')).filter(m => m.name.split('&').every(part => [part, part.replace(/^通常/, ''), part.replace(/パーマ$/, ''), part.replace(/^スキン/, '')].some(p => t.includes(p)))).sort((a, b) => b.name.length - a.name.length)[0]
  if (set) return set
  // 「白髪染め/ぼかし」は「白髪染め」でも「ぼかし」でも
  const names = (m: MenuInfo) => [m.name, ...m.name.split('/'), ...(m.name.length > 3 ? [m.name.replace(/パーマ|カット$/, '')] : [])].filter(x => x.length >= 2)
  // いちばん長く一致した呼び方のメニュー（「子供スキンフェード」は「スキンフェード」より先）
  const hit = (m: MenuInfo) => Math.max(0, ...names(m).filter(n => t.includes(n)).map(n => n.length))
  const best = ctx.menus.filter(m => hit(m) > 0).sort((a, b) => hit(b) - hit(a) || b.name.length - a.name.length)[0]
  if (best) return best
  // 「カット」「髪切りたい」だけ → 通常カット
  if (/カット|髪切|散髪/.test(t)) return ctx.menus.find(m => m.code === 'cut-regular') ?? null
  return null
}

/** 画面に出ているもの（日本時間で）。「2つ目」「13時のやつ」「16時にして」に使う */
function shownText(ctx: AgentContext): string {
  const sh = ctx.shown
  if (!sh) return ''
  const name = (c?: string) => ctx.menus.find(m => m.code === c)?.name ?? c
  const staff = (id?: string | null) => (id ? ctx.staff.find(s => s.id === id)?.name ?? id : '指名なし')
  const parts: string[] = []
  if (sh.times?.length) parts.push(`時刻の候補（${name(sh.menu_code)}・${staff(sh.staff_id)}）：${sh.times.map((t, i) => `${i + 1}つ目 ${jstParts(t).date} ${jstParts(t).time}`).join('、')}`)
  if (sh.confirm) parts.push(`確認中の予約案：${jstParts(sh.confirm.starts_at).date} ${jstParts(sh.confirm.starts_at).time}・${name(sh.confirm.menu_code)}（${sh.confirm.menu_code}）・${staff(sh.confirm.staff_id)}`)
  return parts.length ? `\n（画面に出ているもの：${parts.join('／')}）` : ''
}

function systemPrompt(ctx: AgentContext): string {
  const now = jstParts(ctx.now)
  const week = calendar(now.date, 21).map(c => `${c.date}（${c.wd}）${c.labels.join('・')}`).join('\n')
  const menus = ctx.menus.map(m => `${m.code}\t${m.name}\t${m.category ?? ''}\t${m.duration_min}分\t${m.price == null ? '店頭' : `${m.price}円${m.price_from ? '〜' : ''}`}${m.code === ctx.lastMenuCode ? '\t前回' : ''}`).join('\n')
  const staff = ctx.staff.map(s => `${s.id}\t${s.name}`).join('\n')
  return `あなたは理容室「ピシャッと二代目銀二郎」の予約アシスタント JOHNNY です。お客様（会員）とアプリで話して、予約・キャンセル・日時の変更を手伝います。
いまは ${now.date}（${now.wd}）${now.time}（日本時間）です。週は月曜はじまり。これから3週間の日付（「来週の火曜」などはこの表のとおりに読む）：
${week}

# 守ること
- 空き時間・予約の有無は、必ず道具で確かめる。道具の結果に無い時刻・予約を言わない、作らない。
- 予約・キャンセル・変更は、あなたが確定しない。必ず respond の ui で確認画面（confirm_*）を出し、お客様の「はい」を待つ。
- 時刻は道具の結果の date と HH:MM から「YYYY-MM-DDTHH:MM:00+09:00」の形で ui に入れる。「10:00〜11:45」は、その間の15分おきのどの時刻からでも始められるという意味。
- お客様の言葉の日付は、メッセージに添えた「日付の読み」があればそれを使う。
- 「事前に調べた結果」として道具の結果が渡されていれば、それを使う。足りないときだけ道具を呼ぶ。
- メニューは下の表の code だけを使う。表に無いメニューは作らない。料金と時間は表の数字だけを言う。
- 話す言葉（say）は日本語で、短く、話し言葉で。2〜3文、80字くらいまで。時刻は「18時半」「11時15分」のように読む。日付は「今日」「明日」「10月20日の火曜」のように言う。
- 1回の返事で、お客様が次に答えることは1つだけにする。
- 予約と関係ない話・医療の話はしない。分からない・できないこと（3人以上の予約、遠い先の予約など）は、お電話（090-2800-5425）をご案内する（ui: handoff）。

# 進め方（先回りして提案する）
- 日だけ・「空いてる？」だけ → day_overview で見て、受付時間と、入れられるメニューと一番早い時刻を2〜3個言い、ui: menus（空きのあるメニューだけ）。その日に空きが無ければ次の日も見て案内する。
- メニューだけ（日時なし） → next_slots で一番早い空きを探し、間をあけて2〜3個言い、ui: slots。
- 日とメニュー（時刻なし） → その日の空きから時刻を2〜4個（ui: slots）。その日に空きが無ければ next_slots で次の日以降（ui: slots）。
- 日時とメニューの両方 → slots で確かめる（事前に調べた結果に requested_free があればそれが答え）。ぴったり空いていれば ui: confirm_booking（「朝一」はその日のいちばん早い空きで confirm_booking）。埋まっていれば近い時刻や次の日を提案（ui: slots）。
- メニューが分かっているときは ui: menus にしない（必ず slots か confirm_booking）。空きがあると言ったら、必ず ui に候補を出す（none にしない）。
- 「〜してもいい？」「〜できる？」のような聞き方でも、メニューや日時が入っていれば予約したいと受け取って空きを案内する。
- 「前回と同じ」「いつもの」 → 表で「前回」のメニュー。
- 「カット」「髪切りたい」だけなら通常カット。「顔剃り」は顔そり男性。
- 担当の指名（「テイテイさんで」など） → staff の id を slots / next_slots の staff_id に入れて確かめ、ui にも staff_id を入れる。指名が無ければ staff_id は null。日が決まっていなければ next_slots で近い日から探す。
- 「2つ目で」「さっきの11時で」「一番最初の」「最後の」 → 画面に出ている候補（shown）の中から選ぶ（画面に候補があるときの「一番最初」は、候補の1つ目）。
- 確認画面（shown.confirm）が出ているときの「16時にして」「メニューはスキンフェードで」「テイテイさんで」は、その予約案の一部を変えるだけ。変えたところを slots で確かめて、ui: confirm_booking を出し直す。このときの「ずらして」「遅らせて」は予約の変更ではないので my_reservations は呼ばない。
- 予約一覧の wd・label で読む：「日曜の予約」「来週の日曜のやつ」はその曜日の予約（日付の読みより予約一覧が先）。今ある予約の日時を変える話は confirm_booking ではなく confirm_change。「両方キャンセル」は1つずつ（近い方から confirm_cancel）。
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
  { type: 'function', function: { name: 'next_slots', description: 'メニューの空きを、from の日から近い順に探す（最大10件）。staff_id を入れるとその担当だけ', parameters: { type: 'object', properties: { menu_code: { type: 'string' }, from: { type: 'string', description: 'YYYY-MM-DD' }, staff_id: { type: ['string', 'null'] } }, required: ['menu_code', 'from'], additionalProperties: false } } },
  { type: 'function', function: { name: 'slots', description: 'その日・そのメニューの空き時間。staff_id を入れるとその担当だけ', parameters: { type: 'object', properties: { date: { type: 'string' }, menu_code: { type: 'string' }, staff_id: { type: ['string', 'null'] } }, required: ['date', 'menu_code', 'staff_id'], additionalProperties: false } } },
  { type: 'function', function: { name: 'my_reservations', description: 'このお客様のこれからの予約', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'respond', description: 'お客様への返事と、画面に出すもの。最後に必ず1回呼ぶ', parameters: {
    type: 'object', additionalProperties: false, required: ['say', 'ui'],
    properties: {
      say: { type: 'string' },
      ui: { type: 'object', additionalProperties: false, required: ['type'], description: 'type に必要な欄だけ書く（ほかは書かない）',
        properties: {
          type: { type: 'string', enum: ['none', 'menus', 'slots', 'confirm_booking', 'confirm_cancel', 'confirm_change', 'reservations', 'handoff'] },
          menu_codes: { type: 'array', items: { type: 'string' }, description: 'menus のとき：特におすすめのメニューを3つまで（空きのあるメニューの一覧はこちらで全部出す）' },
          date: { type: ['string', 'null'], description: 'menus のときの日付' },
          menu_code: { type: ['string', 'null'] },
          staff_id: { type: ['string', 'null'] },
          times: { type: 'array', items: { type: 'string' }, description: 'slots のとき：2〜4個（YYYY-MM-DDTHH:MM:00+09:00）' },
          starts_at: { type: ['string', 'null'], description: 'confirm_booking / confirm_change のとき（YYYY-MM-DDTHH:MM:00+09:00）' },
          reservation_id: { type: ['string', 'null'] },
          reservation_ids: { type: 'array', items: { type: 'string' } },
        } },
    } } } },
] as const

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }

/** 空いている開始時刻（HH:MM）を、つながっている分はまとめる：["10:00","10:15","10:30","15:00"] → ["10:00〜10:30","15:00"]（15分おきなど、間隔は step 分） */
function ranges(times: string[], step: number): string[] {
  const m = [...new Set(times)].map(t => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi }).sort((a, b) => a - b)
  const hm = (x: number) => String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0")
  const out: string[] = []
  for (let i = 0; i < m.length; i++) {
    let j = i
    while (j + 1 < m.length && m[j + 1] - m[j] === step) j++
    out.push(i === j ? hm(m[i]) : hm(m[i]) + "〜" + hm(m[j]))
    i = j
  }
  return out
}

/** 道具の結果を AI に渡す形にする（メニューの名前つき・時刻は日本時間の読みも添える） */
function describeReservations(list: Reservation[], today: string) {
  const cal = calendar(today, 90)
  return list.map(r => { const p = jstParts(r.starts_at); return { id: r.id, date: p.date, wd: p.wd, label: cal.find(c => c.date === p.date)?.labels.join('・') ?? '', time: p.time, menu: r.menu, menu_code: r.menu_code, staff: r.staff_name, status: r.status } })
}

function describeOverview(o: DayOverview, ctx: AgentContext) {
  if (!o.open || !o.hours) return { date: o.date, open: false }
  const names = new Map(ctx.menus.map(m => [m.code, m]))
  // 同じ空き方のメニューはまとめて、空いている開始時刻（HH:MM）を全部渡す
  const groups = o.groups.map(g => ({ menus: g.codes.map(c => `${c}（${names.get(c)?.name ?? c}・${names.get(c)?.duration_min ?? '?'}分）`), times: ranges(g.slots.map(s => jstParts(s).time), 15) }))
  const none = ctx.menus.filter(m => !o.groups.some(g => g.codes.includes(m.code))).map(m => m.code)
  return { date: o.date, open: true, hours: o.hours, groups, no_slots: none }
}

export async function runAgent(ctx: AgentContext, history: Turn[], utterance: string, tools: AgentTools, llm: LlmConfig): Promise<AgentReply> {
  const fetchImpl = llm.fetchImpl ?? fetch
  const seenTimes = new Map<string, Set<string>>() // menu_code → 道具が返した時刻
  const remember = (code: string, times: string[]) => { const s = seenTimes.get(code) ?? new Set<string>(); times.forEach(t => s.add(t)); seenTimes.set(code, s) }
  let seenReservations: Reservation[] | null = null
  const overviews = new Map<string, DayOverview>()
  if (ctx.shown?.menu_code && ctx.shown.times) remember(ctx.shown.menu_code, ctx.shown.times)
  if (ctx.shown?.confirm) remember(ctx.shown.confirm.menu_code, [ctx.shown.confirm.starts_at])

  const today = jstParts(ctx.now).date
  let dates = readDates(utterance, today)
  let time = readTime(utterance, jstParts(ctx.now).time)
  const prevUser = history.filter(t => t.role === 'user').slice(-1)[0]?.text
  if (prevUser && dates.length === 0 && !time && !ctx.shown?.times?.length && !ctx.shown?.confirm && !/予約|キャンセル/.test(utterance)) {
    dates = readDates(prevUser, today)
    time = dates.length ? readTime(prevUser, jstParts(ctx.now).time) : null
  }
  const hint = (dates.length ? `\n（日付の読み：${dates.map(d => `${d.phrase}＝${d.date}（${jstParts(toIso(d.date, '12:00')).wd}）`).join('、')}）` : '') + (time ? `\n（時刻の読み：${time === 'first' ? 'その日のいちばん早い空き' : time}）` : '')
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(ctx) },
    ...history.slice(-10).map(t => ({ role: t.role, content: t.text }) as ChatMessage),
    { role: 'user', content: `${utterance}${hint}${shownText(ctx)}` },
  ]
  let toolCalls = 0
  let rejects = 0
  // 事前に調べる：日付が分かればその日の空き、メニューだけならその近い空き、予約の話なら予約一覧（DB は速いので先に並べて調べる）
  // 今の言葉にメニューが無ければ、画面の候補・確認中の案・直前の会話から（「やっぱり火曜日にして」）
  const fromScreen = ctx.shown?.confirm?.menu_code ?? ctx.shown?.menu_code
  const adding = !!ctx.shown?.confirm && /追加|も(?:お願い|して|やって|入れ)|一緒に/.test(utterance)
  const confirmName = ctx.menus.find(m => m.code === ctx.shown?.confirm?.menu_code)?.name
  const said = (adding && confirmName ? mentionedMenu(`${confirmName}と${utterance}`, ctx) : null) ?? mentionedMenu(utterance, ctx)
  const onScreen = fromScreen ? ctx.menus.find(m => m.code === fromScreen) ?? null : null
  const menu = said ?? onScreen ?? mentionedMenu(history.filter(t => t.role === 'user').slice(-2).map(t => t.text).join('、'), ctx)
  const pre: { name: string; args: Record<string, unknown>; run: () => Promise<unknown> }[] = []
  for (const d of dates.slice(0, 2)) pre.push({ name: 'day_overview', args: { date: d.date }, run: async () => { const o = await tools.dayOverview(d.date); overviews.set(o.date, o); o.groups.forEach(g => g.codes.forEach(c => remember(c, g.slots))); return describeOverview(o, ctx) } })
  const aboutReservation = !ctx.shown?.confirm && /キャンセル|取り消|取消|予約.{0,12}(?:やめ|変|ずら|遅|早|いつ|何時|日にち|担当|メニュー)|(?:やめ|変|ずら|遅らせ|早め).{0,6}予約|次の予約|行けん|行けな|いけな|のやつを|なしにし|無しにし|ずらせ|ずらし|ずらす|予約[、,を]?.{0,14}に(?:し|でき|変|ずら|$)/.test(utterance)
  const cancelTalk = aboutReservation && /キャンセル|取り消|取消|やめ|なしにし|無しにし/.test(utterance)
  // 取り消しの話：日付の読み（「日曜」＝明日）とその日の空きは使わず、予約一覧から合う予約を選ばせる
  if (cancelTalk) {
    pre.splice(0, pre.length, ...pre.filter(p => p.name !== 'day_overview'))
    messages[messages.length - 1].content = `${utterance}${shownText(ctx)}
（予約の取り消しの話：予約一覧の wd・label・日付・メニュー・担当が合う予約を選ぶ）`
  }
  const staffHit = ctx.staff.find(x => utterance.normalize('NFKC').includes(x.name) || (x.name === 'テイテイ' && /ていてい/.test(utterance)) || (x.name === '銀二郎' && /ぎんじろう/.test(utterance))) ?? null
  if (menu && dates.length === 0 && !ctx.shown?.confirm && !ctx.shown?.times?.length) pre.push({ name: 'next_slots', args: { menu_code: menu.code, from: today, staff_id: staffHit?.id ?? null }, run: async () => { const times = await tools.nextSlots(menu.code, today, staffHit?.id ?? null); remember(menu.code, times); return times.map(t => ({ date: jstParts(t).date, time: jstParts(t).time })) } })
  const slotDates = dates.length ? dates.slice(0, 1) : ctx.shown?.confirm && (staffHit || time) ? [{ phrase: '確認中の案の日', date: jstParts(ctx.shown.confirm.starts_at).date }] : []
  if (menu && (staffHit || time)) for (const d of slotDates) pre.push({ name: 'slots', args: { date: d.date, menu_code: menu.code, staff_id: staffHit?.id ?? null }, run: async () => {
    const times = await tools.slots(d.date, menu.code, staffHit?.id ?? null)
    remember(menu.code, times)
    const hms = times.map(t => jstParts(t).time)
    const asked = time === 'first' ? hms[0] ?? null : time
    return { date: d.date, menu_code: menu.code, staff_id: staffHit?.id ?? null, times: hms, ...(asked ? { requested: asked, requested_free: hms.includes(asked), requested_iso: hms.includes(asked) ? toIso(d.date, asked) : null } : {}) }
  } })
  if (aboutReservation) pre.push({ name: 'my_reservations', args: {}, run: async () => { seenReservations = await tools.reservations(); return describeReservations(seenReservations, today) } })
  let preNo = 0
  const runPre = async (list: typeof pre) => {
    if (!list.length) return
    const results = await Promise.all(list.map(p => p.run().catch(e => ({ error: String((e as Error).message ?? e) }))))
    const ids = list.map(() => `pre_${preNo++}`)
    messages.push({ role: 'assistant', content: '事前に調べた結果', tool_calls: list.map((p, i) => ({ id: ids[i], type: 'function', function: { name: p.name, arguments: JSON.stringify(p.args) } })) })
    list.forEach((_, i) => messages.push({ role: 'tool', tool_call_id: ids[i], content: JSON.stringify(results[i]) }))
  }
  await runPre(pre)
  const mine = seenReservations as Reservation[] | null
  if (aboutReservation && !cancelTalk && mine?.length === 1 && (dates.length || time || said || staffHit)) {
    const r = mine[0], day = dates[0]?.date ?? jstParts(r.starts_at).date, code = said?.code ?? r.menu_code, sid = staffHit?.id ?? r.staff_id ?? null
    await runPre([{ name: 'slots', args: { date: day, menu_code: code, staff_id: sid }, run: async () => {
      const times = await tools.slots(day, code, sid); remember(code, times)
      const hms = times.map(t => jstParts(t).time)
      return { note: `予約 ${r.id} の変更先の候補（${day}・${code}）`, date: day, menu_code: code, times: hms, ...(time && time !== 'first' ? { requested: time, requested_free: hms.includes(time) } : {}) }
    } }])
  }
  const d0 = dates[0]?.date
  if (menu && d0 && !aboutReservation && overviews.has(d0) && !overviews.get(d0)!.groups.some(g => g.codes.includes(menu.code))) {
    const from = addDays(d0, 1)
    await runPre([{ name: 'next_slots', args: { menu_code: menu.code, from, staff_id: staffHit?.id ?? null }, run: async () => { const times = await tools.nextSlots(menu.code, from, staffHit?.id ?? null); remember(menu.code, times); return { note: `${d0} は ${menu.name} の空きが無いので、次の日からの空き`, times: times.map(t => ({ date: jstParts(t).date, time: jstParts(t).time })) } } }])
  }
  for (let round = 0; round < 6; round++) {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llm.model, messages, tools: TOOLS, tool_choice: round >= 3 ? { type: 'function', function: { name: 'respond' } } : 'required', parallel_tool_calls: true, reasoning_effort: 'none', max_completion_tokens: 900 }),
    })
    if (!res.ok) throw new Error(`ai_unavailable ${res.status} ${(await res.text()).slice(0, 300)}`)
    const data = await res.json()
    if (DEBUG) console.error(`[llm] ${JSON.stringify(data.usage)}`)
    const msg = data.choices?.[0]?.message
    const calls = (msg?.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[]
    if (calls.length === 0) throw new Error('ai_no_tool_call')
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls })
    for (const call of calls) {
      toolCalls++
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { /* 空のまま */ }
      if (call.function.name === 'respond') {
        const checked = validate(args, ctx, seenTimes, seenReservations, overviews, { menu: menu?.code ?? null, said: !!said, staffId: staffHit?.id ?? null, time: time === 'first' ? null : time, aboutReservation, cancel: cancelTalk, declined: !!ctx.shown?.confirm && !time && !staffHit && !said && dates.length === 0 && /^(?:いいえ|いや|違う|ちがう|だめ)[。、!！ぁー]*(?:です|ます)?[。!！]*$|やめ|考え|けっこう|結構|いらない|また今度|大丈夫です|キャンセル/.test(utterance.normalize('NFKC').trim()), dates: dates.map(d => d.date), picking: !!ctx.shown?.times?.length && /つ目|番目|最初|最後|それで|そこで|そこに|その時間/.test(utterance) }, rejects === 0, 2 - rejects++)
        if (checked.ok) return { say: checked.say, ui: checked.ui, tool_calls: toolCalls }
        // 道具に無い時刻・予約を出そうとした：理由を返して、もう一度考えさせる
        if (DEBUG) console.error(`[reject] ${checked.error} :: ${JSON.stringify(args.ui)}`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: checked.error }) })
        continue
      }
      let out: unknown
      try {
        if (call.function.name === 'day_overview') {
          const o = await tools.dayOverview(String(args.date))
          overviews.set(o.date, o)
          o.groups.forEach(g => g.codes.forEach(c => remember(c, g.slots)))
          out = describeOverview(o, ctx)
        } else if (call.function.name === 'next_slots') {
          const code = String(args.menu_code)
          const times = await tools.nextSlots(code, String(args.from), typeof args.staff_id === 'string' ? args.staff_id : null)
          remember(code, times)
          out = times.map(t => ({ date: jstParts(t).date, time: jstParts(t).time }))
        } else if (call.function.name === 'slots') {
          const code = String(args.menu_code)
          const times = await tools.slots(String(args.date), code, typeof args.staff_id === 'string' ? args.staff_id : null)
          remember(code, times)
          out = { date: String(args.date), times: times.map(t => jstParts(t).time) }
        } else if (call.function.name === 'my_reservations') {
          seenReservations = await tools.reservations()
          out = describeReservations(seenReservations, today)
        } else out = { error: 'unknown_tool' }
      } catch (e) { out = { error: String((e as Error).message ?? e) } }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) })
    }
  }
  throw new Error('ai_too_many_rounds')
}

type Checked = { ok: true; say: string; ui: AgentUi } | { ok: false; error: string }

interface Heard { menu: string | null; said: boolean; staffId: string | null; time: string | null; aboutReservation: boolean; cancel: boolean; declined: boolean; dates: string[]; picking: boolean }

function validate(args: Record<string, unknown>, ctx: AgentContext, seenTimes: Map<string, Set<string>>, reservations: Reservation[] | null, overviews: Map<string, DayOverview>, heard: Heard, strict: boolean, rejectsLeft = 0): Checked {
  const mentioned = heard.menu
  const say = typeof args.say === 'string' ? args.say.trim().slice(0, 240) : ''
  const u = { ...((args.ui ?? {}) as Record<string, unknown>) }
  if (['slots', 'confirm_booking', 'confirm_change'].includes(String(u.type)) && typeof u.staff_id !== 'string') u.staff_id = heard.staffId ?? (u.type === 'confirm_booking' ? ctx.shown?.confirm?.staff_id ?? ctx.shown?.staff_id ?? null : u.type === 'confirm_change' ? reservations?.find(r => r.id === u.reservation_id)?.staff_id ?? null : null)
  // menu_code が書かれていないとき：会話の流れから決まるものは補う
  if (typeof u.menu_code !== 'string' && ['slots', 'confirm_booking', 'confirm_change'].includes(String(u.type))) {
    const fromRes = u.type === 'confirm_change' ? reservations?.find(r => r.id === u.reservation_id)?.menu_code : undefined
    const times = (u.type === 'slots' ? (Array.isArray(u.times) ? u.times : []) : [u.starts_at]).filter((t): t is string => typeof t === 'string')
    const holders = [...seenTimes.entries()].filter(([, set]) => times.length > 0 && times.every(t => [...set].some(x => sameInstant(x, t)))).map(([c]) => c)
    u.menu_code = (mentioned && holders.includes(mentioned) ? mentioned : undefined) ?? fromRes ?? (holders.length === 1 ? holders[0] : undefined) ?? ctx.shown?.confirm?.menu_code ?? ctx.shown?.menu_code
  }
  if (!say) return { ok: false, error: 'say が空です' }
  if (heard.declined && (u.type === 'confirm_booking' || u.type === 'slots')) return { ok: true, say, ui: { type: 'none' } }
  if (u.type === 'confirm_booking' && mentioned && ctx.shown?.confirm && u.menu_code === ctx.shown.confirm.menu_code && mentioned !== u.menu_code && typeof u.starts_at === 'string' && [...(seenTimes.get(mentioned) ?? [])].some(x => sameInstant(x, u.starts_at as string))) u.menu_code = mentioned
  const menuOk = (c: unknown): c is string => typeof c === 'string' && ctx.menus.some(m => m.code === c)
  const staffOk = (s: unknown) => s == null || (typeof s === 'string' && ctx.staff.some(x => x.id === s))
  const staffOf = (s: unknown) => (typeof s === 'string' ? s : null)
  const timeSeen = (code: string, t: unknown) => typeof t === 'string' && [...(seenTimes.get(code) ?? [])].some(x => sameInstant(x, t))
  const canon = (code: string, t: string) => [...(seenTimes.get(code) ?? [])].find(x => sameInstant(x, t)) ?? t
  const resOk = (id: unknown) => typeof id === 'string' && !!reservations?.some(r => r.id === id)
  // 今ある予約の話なのに新しい予約の確認を出した：どの予約か決まれば、その予約の変更にする
  if (heard.aboutReservation && !heard.cancel && u.type === 'confirm_booking' && (reservations?.length ?? 0) > 0) {
    const same = reservations!.filter(r => r.menu_code === u.menu_code)
    const target = reservations!.length === 1 ? reservations![0] : same.length === 1 ? same[0] : null
    if (target) { u.type = 'confirm_change'; u.reservation_id = target.id; if (typeof u.staff_id !== 'string') u.staff_id = target.staff_id ?? null }
  }
  // 画面の候補にある時刻を言った（「13時のやつ」）：その候補の時刻にする
  if (u.type === 'confirm_booking' && ctx.shown?.times?.length && ctx.shown.menu_code && heard.time && heard.dates.length === 0) {
    const hit = ctx.shown.times.find(x => jstParts(x).time === heard.time)
    if (hit && !(typeof u.starts_at === 'string' && sameInstant(u.starts_at, hit))) { u.starts_at = hit; u.menu_code = ctx.shown.menu_code }
  }
  // 「探します」「確認します」と言って何も出さない（お客様が待たされる）：調べた結果を出させる
  if (rejectsLeft > 0 && u.type === 'none' && /探します|探しますね|確認します|確認しますね|お調べします|調べます|お探しします/.test(say)) {
    return { ok: false, error: '「探します」「確認します」と言うだけで終わらせず、いま道具（next_slots・slots・day_overview・my_reservations）で調べて、その結果を ui に出してください' }
  }
  if (strict && heard.picking && u.type === 'confirm_booking' && !(ctx.shown?.times ?? []).some(x => typeof u.starts_at === 'string' && sameInstant(x, u.starts_at))) {
    return { ok: false, error: '画面の時刻の候補から選んでいます。starts_at は shown の times の中から（「最初」は1つ目、「最後」は最後）選んでください' }
  }
  if (strict && heard.picking && u.type !== 'confirm_booking') {
    return { ok: false, error: '画面の時刻の候補から選んでいます。選ばれた時刻（shown の times の中）で ui: confirm_booking を出してください' }
  }
  if (strict && ctx.shown?.confirm && !heard.declined && u.type === 'none' && (heard.time || heard.said || heard.staffId)) {
    return { ok: false, error: '確認中の予約案の一部を変える話です。変えたところを slots で確かめて、ui: confirm_booking を出し直してください（予約の変更ではありません）' }
  }
  if (strict && heard.aboutReservation && (reservations?.length ?? 0) > 0 && (u.type === 'none' || u.type === 'slots') && heard.dates.length > 0 && heard.time) {
    return { ok: false, error: '予約の変更です。新しい日時が空いていれば ui: confirm_change（reservation_id・starts_at）を出してください。空いていなければ近い時刻を slots で' }
  }
  if (strict && heard.aboutReservation && !heard.cancel && (reservations?.length ?? 0) === 1 && (heard.dates.length > 0 || heard.menu || heard.staffId) && (u.type === 'menus' || u.type === 'none')) {
    return { ok: false, error: '今ある予約の変更です。事前に調べた変更先の空きから、言われた時刻（無ければ予約と同じ時刻）が空いていれば ui: confirm_change、無ければ近い時刻を ui: slots にしてください' }
  }
  if (strict && heard.aboutReservation && (reservations?.length ?? 0) > 0 && u.type === 'confirm_booking') {
    return { ok: false, error: '今ある予約の変更です。新しい予約ではなく ui: confirm_change（reservation_id・menu_code・starts_at）にしてください' }
  }
  if (strict && heard.cancel && (reservations?.length ?? 0) > 0 && ['none', 'slots', 'menus', 'handoff'].includes(String(u.type))) {
    return { ok: false, error: 'キャンセルの話です。どの予約か分かれば ui: confirm_cancel、分からなければ ui: reservations で選んでもらってください（「日曜の予約」は予約一覧の wd が日の予約）' }
  }
  if (strict && !heard.aboutReservation && mentioned && (u.type === 'menus' || u.type === 'none')) {
    return { ok: false, error: `お客様はメニュー（${mentioned}）を言っています。聞き返さずに、空き時間の候補（ui: slots）か確認（ui: confirm_booking）を出してください。その日に空きが無ければ next_slots で次の日以降を探して slots に` }
  }
  if (strict && !heard.aboutReservation && !mentioned && u.type === 'none' && heard.dates.some(d => (overviews.get(d)?.groups.length ?? 0) > 0)) {
    return { ok: false, error: '聞き返さずに、その日（時刻）に入れられるメニューを ui: menus（date つき）で出してください' }
  }
  switch (u.type) {
    case 'none': case 'handoff': return { ok: true, say, ui: { type: u.type } }
    case 'menus': {
      const picked = (Array.isArray(u.menu_codes) ? u.menu_codes : []).filter(menuOk)
      const date = typeof u.date === 'string' && overviews.has(u.date) ? u.date : [...overviews.keys()].find(d => (overviews.get(d)?.groups.length ?? 0) > 0) ?? null
      const o = date ? overviews.get(date) : undefined
      if (!o) {
        if (picked.length === 0) return { ok: false, error: 'menus は day_overview で調べた日について出してください' }
        return { ok: true, say, ui: { type: 'menus', items: picked.map(c => ({ menu_code: c, first_time: [...(seenTimes.get(c) ?? [])].sort()[0] ?? null })), date: null } }
      }
      const first = new Map<string, string>()
      const at = heard.time && heard.dates.includes(o.date) ? toIso(o.date, heard.time) : null
      o.groups.forEach(g => { const sorted = [...g.slots].sort(); const pick = at ? sorted.find(x => sameInstant(x, at)) ?? sorted.find(x => Date.parse(x) >= Date.parse(at)) : sorted[0]; if (pick) g.codes.forEach(c => first.set(c, pick)) })
      if (first.size === 0) return { ok: false, error: `${o.date} は空きがありません。別の日を day_overview で調べてください` }
      const order = [...picked.filter(c => first.has(c)), ...(ctx.lastMenuCode && first.has(ctx.lastMenuCode) ? [ctx.lastMenuCode] : []), ...ctx.menus.map(m => m.code).filter(c => first.has(c))]
      const items = [...new Set(order)].map(c => ({ menu_code: c, first_time: first.get(c) ?? null }))
      return { ok: true, say, ui: { type: 'menus', items, date: o.date } }
    }
    case 'slots': {
      if (!menuOk(u.menu_code)) return { ok: false, error: typeof u.menu_code === 'string' ? 'slots の menu_code がメニュー表にありません' : 'ui に menu_code（メニュー表の code）を必ず書いてください' }
      const code = u.menu_code
      const times = (Array.isArray(u.times) ? u.times : []).filter(t => timeSeen(code, t)).map(t => canon(code, t as string))
      if (times.length === 0) return { ok: false, error: 'slots の times が、道具で確かめた空き時間にありません。道具で確かめてから出してください' }
      if (!staffOk(u.staff_id)) return { ok: false, error: 'staff_id がスタッフ表にありません' }
      return { ok: true, say, ui: { type: 'slots', menu_code: code, staff_id: staffOf(u.staff_id), times: times.slice(0, 4) } }
    }
    case 'confirm_booking': case 'confirm_change': {
      if (!menuOk(u.menu_code)) return { ok: false, error: typeof u.menu_code === 'string' ? 'menu_code がメニュー表にありません' : 'ui に menu_code（メニュー表の code）を必ず書いてください' }
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
