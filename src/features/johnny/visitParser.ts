// お客様の話し言葉（「明日の15時」「今日か明日の夕方」「来週の土曜 3時半」など）から来店の希望を取り出す。
// AI に推測させず、決まった規則だけで読む。読めなかった部分は null のまま返し、聞き直す。
// 日付・時刻はすべて日本時間（Asia/Tokyo）で扱う。

export interface TimeRange { from: string; to: string }

export interface VisitRequest {
  /** 候補の日付（YYYY-MM-DD、日本時間）。「今日か明日」なら2件。読めなければ空 */
  dates: string[]
  /** 時刻の指定（HH:MM）。「15時」「3時半」 */
  time: string | null
  /** 時間帯の指定（「夕方」「15時以降」など） */
  range: TimeRange | null
  /** 「一番早い」「空いてる時間」など、最短の枠でよい */
  earliest: boolean
}

const WEEKDAYS: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 }

// 上から順に見る（「午後イチ」は「午後」より、「昼過ぎ」は「昼」より先）
const PERIODS: { words: string[]; range: TimeRange }[] = [
  { words: ['朝イチ', '開店'], range: { from: '09:00', to: '11:00' } },
  { words: ['午後イチ'], range: { from: '13:00', to: '14:00' } },
  { words: ['昼過ぎ', '昼すぎ'], range: { from: '13:00', to: '15:00' } },
  { words: ['朝', '午前中', '午前'], range: { from: '09:00', to: '12:00' } },
  { words: ['お昼', '昼'], range: { from: '11:00', to: '14:00' } },
  { words: ['夕方'], range: { from: '15:00', to: '18:00' } },
  { words: ['夜', '仕事終わり', '仕事帰り', '閉店前'], range: { from: '18:00', to: '21:00' } },
  { words: ['午後'], range: { from: '12:00', to: '19:00' } },
]

const KANJI_DIGITS: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 「十五」「二十三」「三十」など 99 までの漢数字を算用数字にする */
function kanjiToDigits(s: string): string {
  return s.replace(/[〇零一二三四五六七八九十]+/g, m => {
    if (!m.includes('十')) return [...m].map(c => KANJI_DIGITS[c]).join('')
    const [tens, ones] = m.split('十')
    const t = tens === '' ? 1 : KANJI_DIGITS[tens] ?? 0
    const o = ones === '' || ones === undefined ? 0 : KANJI_DIGITS[ones] ?? 0
    return String(t * 10 + o)
  })
}

/** 全角→半角、ひらがなの言い回しを漢字に寄せる、空白を除く */
export function normalizeUtterance(raw: string): string {
  let s = raw.normalize('NFKC').toLowerCase()
  const words: [RegExp, string][] = [
    [/きょう|ほんじつ|本日/g, '今日'],
    [/あした|あす/g, '明日'],
    [/あさって|みょうごにち/g, '明後日'],
    [/らいしゅう/g, '来週'],
    [/こんしゅう/g, '今週'],
    [/しゅうまつ/g, '週末'],
    [/ゆうがた/g, '夕方'],
    [/ごご/g, '午後'],
    [/ごぜん/g, '午前'],
    [/よる/g, '夜'],
    [/ひる/g, '昼'],
    [/あさ/g, '朝'],
    [/こんど/g, '今度'],
    [/つぎの/g, '次の'],
    [/どにち/g, '土日'],
    [/いこう/g, '以降'],
    [/すぎ/g, '過ぎ'],
    [/いちばんはやい|一番早い|最短|いちばん早い|なるべく早く|できるだけ早く|空いてる時間|あいてる時間/g, '最短'],
    // 「朝イチ」「午後イチ」は漢数字の変換（一→1）より先にそろえる
    [/朝(いち|イチ|一番|一)/g, '朝イチ'],
    [/午後(いち|イチ|一番|一)/g, '午後イチ'],
  ]
  for (const [re, to] of words) s = s.replace(re, to)
  // 音声認識がかなで返す時刻（「さんじ」「じゅうごじはん」）を数字にする。「じゃ」「じゅ…」は時刻にしない
  s = s.replace(/(じゅう)?(いち|に|さん|よ|ご|ろく|しち|なな|はち|く)?じ(?![ゃゅょ])/g, (m, ten: string | undefined, one: string | undefined) => {
    if (!ten && !one) return m
    const ones: Record<string, number> = { いち: 1, に: 2, さん: 3, よ: 4, ご: 5, ろく: 6, しち: 7, なな: 7, はち: 8, く: 9 }
    return `${(ten ? 10 : 0) + (one ? ones[one] : 0)}じ`
  })
  s = kanjiToDigits(s)
  // 「3じはん」「15じ」「10ふん」：数字の直後のかなだけを時刻の漢字にする（ほかの「じ」は変えない）
  s = s.replace(/(\d)\s*じ\s*はん/g, '$1時半').replace(/(\d)\s*じ/g, '$1時').replace(/(\d)\s*(ふん|ぷん)/g, '$1分')
  return s.replace(/\s+/g, '')
}

// ── 日本時間の日付計算 ─────────────────────────────────────────────

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 日本時間の年・月・日・曜日 */
function jstParts(now: Date): { y: number; m: number; d: number; dow: number } {
  const t = new Date(now.getTime() + JST_OFFSET_MS)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() }
}

function ymd(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

function addDays(base: { y: number; m: number; d: number }, days: number): string {
  return ymd(base.y, base.m, base.d + days)
}

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

// ── 日付 ──────────────────────────────────────────────────────────

function parseDates(s: string, now: Date): string[] {
  const today = jstParts(now)
  const found: { at: number; date: string }[] = []
  const push = (at: number, date: string) => { if (!found.some(f => f.date === date)) found.push({ at, date }) }

  for (const m of s.matchAll(/明後日/g)) push(m.index, addDays(today, 2))
  for (const m of s.matchAll(/明日/g)) push(m.index, addDays(today, 1))
  for (const m of s.matchAll(/今日/g)) push(m.index, addDays(today, 0))

  // M月D日 / M/D
  for (const m of s.matchAll(/(\d{1,2})月(\d{1,2})日?|(?<![\d:])(\d{1,2})\/(\d{1,2})(?![\d:])/g)) {
    const mo = Number(m[1] ?? m[3]); const d = Number(m[2] ?? m[4])
    let y = today.y
    if (!validDate(y, mo, d)) continue
    if (ymd(y, mo, d) < addDays(today, 0)) y += 1
    if (validDate(y, mo, d)) push(m.index, ymd(y, mo, d))
    // 「10/20か21」「10月20日か21日」：続けて日だけ言った2つ目の候補は同じ月
    const tail = s.slice(m.index + m[0].length).match(/^(?:か|と|、|,|or|または|もしくは)(\d{1,2})(?![\d:時分月/])/)
    if (tail && validDate(y, mo, Number(tail[1]))) push(m.index + m[0].length, ymd(y, mo, Number(tail[1])))
  }
  // N日後
  for (const m of s.matchAll(/(\d{1,2})日後/g)) push(m.index, addDays(today, Number(m[1])))
  // D日（月なし）：今月、過ぎていれば来月（「3日後」「2日間」は除く）
  for (const m of s.matchAll(/(?<![\d月/])(\d{1,2})日(?!曜|後|間)/g)) {
    const d = Number(m[1])
    let y = today.y; let mo = today.m
    if (!validDate(y, mo, d) || ymd(y, mo, d) < addDays(today, 0)) { mo += 1; if (mo > 12) { mo = 1; y += 1 } }
    if (validDate(y, mo, d)) push(m.index, ymd(y, mo, d))
  }
  // 曜日（来週・今週の指定つきも）
  // 週は月曜はじまり。「来週の土曜」= 次の月曜から始まる週の土曜
  const fromMonday = (dow: number) => (dow + 6) % 7
  const weekday = (target: number, prefix: string | undefined) => {
    let diff = (target - today.dow + 7) % 7
    // 「次の土曜」「今度の土曜」：今日が土曜なら来週の土曜
    if ((prefix === '次' || prefix === '今度') && diff === 0) diff = 7
    if (prefix === '来週') diff = 7 - fromMonday(today.dow) + fromMonday(target)
    if (prefix === '再来週') diff = 14 - fromMonday(today.dow) + fromMonday(target)
    return diff
  }
  for (const m of s.matchAll(/(来週|今週|再来週|次|今度)?の?([日月火水木金土])曜/g)) push(m.index, addDays(today, weekday(WEEKDAYS[m[2]], m[1])))
  // 土日・週末（今週末・来週末）：土曜と日曜の2日
  // 「来週末」は「来週」+「末」ではなく「来」+「週末」なので、両方の形を見る
  for (const m of s.matchAll(/(再来週|来週|今週)?の?土日|(再来|来|今)?週末/g)) {
    const prefix = m[1] ?? (m[2] ? `${m[2]}週` : undefined)
    const sat = weekday(6, prefix)
    // 今日が日曜で「土日」「週末」なら、今日（日曜）も候補に入れる
    if (!prefix && today.dow === 0) push(m.index, addDays(today, 0))
    push(m.index, addDays(today, sat))
    push(m.index, addDays(today, sat + 1))
  }
  // 明日以降・明日から・来週以降：その日から1週間
  const from = s.match(/(今日|明日|明後日|来週)(以降|から|以後)/)
  if (from) {
    const start = from[1] === '今日' ? 0 : from[1] === '明日' ? 1 : from[1] === '明後日' ? 2 : 7 - fromMonday(today.dow)
    found.length = 0
    for (let i = 0; i < 7; i++) push(i, addDays(today, start + i))
  }

  return found.sort((a, b) => a.at - b.at).map(f => f.date)
}

// ── 時刻 ──────────────────────────────────────────────────────────

function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 店の営業時間（およそ 9〜21 時）に合わせて、午前・午後の指定が無い 1〜8 時は午後とみなす */
function toBusinessHour(h: number, ampm: '午前' | '午後' | null): number {
  if (ampm === '午後' && h < 12) return h + 12
  if (ampm === '午前') return h === 12 ? 0 : h
  if (h >= 1 && h <= 8) return h + 12
  return h
}

function parseTime(s: string): { time: string | null; boundary: 'after' | 'before' | null } {
  // 15:00 / 15:30
  let m = s.match(/(午前|午後)?(\d{1,2}):(\d{2})/)
  if (m) {
    const h = toBusinessHour(Number(m[2]), (m[1] as '午前' | '午後') ?? null); const mi = Number(m[3])
    if (h <= 23 && mi <= 59) return { time: hhmm(h, mi), boundary: boundaryAfter(s, m.index! + m[0].length) }
  }
  // 15時 / 3時半 / 午後3時15分
  m = s.match(/(午前|午後|朝|夜|夕方)?(\d{1,2})時(半|(\d{1,2})分)?/)
  if (m) {
    const word = m[1]
    const ampm = word === '午後' || word === '夜' || word === '夕方' ? '午後' : word === '午前' || word === '朝' ? '午前' : null
    const h = toBusinessHour(Number(m[2]), ampm)
    const mi = m[3] === '半' ? 30 : m[4] ? Number(m[4]) : 0
    if (h <= 23 && mi <= 59) return { time: hhmm(h, mi), boundary: boundaryAfter(s, m.index! + m[0].length) }
  }
  return { time: null, boundary: null }
}

function boundaryAfter(s: string, end: number): 'after' | 'before' | null {
  const rest = s.slice(end, end + 4)
  if (/^(以降|から|過ぎ|すぎ|以後)/.test(rest)) return 'after'
  if (/^(まで|前|より前|以前)/.test(rest)) return 'before'
  return null
}

/** 「15時台」「15時から17時（まで・の間）」「3時半〜5時」：はっきりした時間帯。無ければ null */
function parseTimeRange(s: string): TimeRange | null {
  const hm = (h: string, half: string | undefined, ampm: string | undefined) => {
    const hour = toBusinessHour(Number(h), ampm === '午前' || ampm === '朝' ? '午前' : ampm ? '午後' : null)
    return hour <= 23 ? hhmm(hour, half ? 30 : 0) : null
  }
  let m = s.match(/(午前|午後|朝|夜|夕方)?(\d{1,2})時台/)
  if (m) {
    const from = hm(m[2], undefined, m[1])
    return from ? { from, to: `${from.slice(0, 2)}:59` } : null
  }
  m = s.match(/(午前|午後|朝|夜|夕方)?(\d{1,2})(?:時|:00)(半)?(?:から|〜|~|-|ー)(午前|午後|朝|夜|夕方)?(\d{1,2})(?:時|:00)(半)?/)
  if (m) {
    const from = hm(m[2], m[3], m[1])
    const to = hm(m[5], m[6], m[4] ?? m[1])
    if (from && to && from < to) return { from, to }
  }
  return null
}

function parsePeriod(s: string): TimeRange | null {
  for (const p of PERIODS) if (p.words.some(w => s.includes(w))) return p.range
  return null
}

// ── 入口 ──────────────────────────────────────────────────────────

export function parseVisitRequest(raw: string, now: Date = new Date()): VisitRequest {
  const s = normalizeUtterance(raw)
  const dates = parseDates(s, now)
  const earliest = /最短|いつでも|何時でも|何時でもいい|朝イチ|午後イチ/.test(s)
  const explicit = parseTimeRange(s)
  if (explicit) return { dates, time: null, range: explicit, earliest }
  const { time, boundary } = parseTime(s)
  let range: TimeRange | null = null
  let exact: string | null = time
  if (time && boundary === 'after') { range = { from: time, to: '23:59' }; exact = null }
  if (time && boundary === 'before') { range = { from: '00:00', to: time }; exact = null }
  if (!time) range = parsePeriod(s)
  // 「夕方以降」「午後以降」：時間帯の始まりから閉店まで
  if (!time && range && /(夕方|午後|昼)(以降|から|以後)/.test(s)) range = { from: range.from, to: '23:59' }
  return { dates, time: exact, range, earliest }
}

/** 日付も時刻も時間帯も読めなかった */
export function isEmptyRequest(r: VisitRequest): boolean {
  return r.dates.length === 0 && !r.time && !r.range && !r.earliest
}

/** 「はい」「いいえ」の聞き取り。どちらでもなければ null */
export function parseYesNo(raw: string): boolean | null {
  const s = raw.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  // 「間違いない」は「違」を含むので、先に「はい」として見る
  if (/間違いない|まちがいない|間違いありません|まちがいありません/.test(s)) return true
  // 文のどこにあっても拾う（「えっと、はい」「それでお願いします」）。打ち消しを先に見る
  if (/いいえ|いや(?!す)|違う|ちがう|違い|ちがい|やめ|キャンセル|だめ|ダメ|^no\b|別の|べつの|変え|かえ(?:て|たい)/.test(s)) return false
  if (/はい|ええ|うん|お願い|おねがい|それで|大丈夫|だいじょうぶ|^ok|オッケー|オーケー|yes|いいです|いいよ|問題ない|もんだいない|了解|りょうかい/.test(s)) return true
  return null
}
