// 話した・打った1文から、予約フォームの下書きを作る（例：「明日15時 田中さん パンチ 銀二郎で」）。
// 決まった規則だけで読む（AI に推測させない）。読めなかった項目は空のまま返し、フォームでスタッフが埋める。
// 空き・料金・担当の可否はここでは決めない（フォームの「内容を確認」で DB の予約エンジンが決める）。
import { parseVisitRequest, normalizeUtterance } from '../features/johnny/visitParser.ts'
import { matchMenu, type MenuOption } from '../features/johnny/menuMatcher.ts'
import { normalizePhone } from '../utils/phone.ts'

export interface SbCommandStaff { id: string; name: string }

export interface SbDraft {
  /** YYYY-MM-DD（日本時間）。言わなければ今日 */
  date: string
  /** 0時からの分。言わなければ null（フォームで選ぶ） */
  minutes: number | null
  customerName: string | null
  phone: string | null
  menuCodes: string[]
  /** 指名する担当。null = 指名なし（言わなかった・「フリー」） */
  staffId: string | null
  source: 'phone' | 'hotpepper' | 'staff' | null
  externalRef: string | null
  /** 読み取れた項目（画面で「読み取った内容」として見せる） */
  understood: string[]
}

const JST = 9 * 60 * 60 * 1000

/**
 * 音声認識は担当の名前を別の字で返すことがある（「銀二郎」→「銀次郎」「ぎんじろう」）。
 * 担当ごとに聞き間違えやすい書き方を足し、ひらがな・カタカナの両方で探す。
 */
const STAFF_ALIASES: Record<string, string[]> = {
  銀二郎: ['銀次郎', '銀二朗', '銀次朗', '銀治郎', '銀司郎', '金二郎', '金次郎', 'ぎんじろう', 'ぎんじろー', 'ギンジロウ', 'ギンジロー', 'ギンジロ'],
  テイテイ: ['ていてい', 'テーテー', 'ティーティー', 'ティティ', 'TT'],
}
const toKatakana = (v: string) => v.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
const toHiragana = (v: string) => v.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
/** その担当を指す書き方（長い順） */
function spellings(st: SbCommandStaff): string[] {
  const name = st.name.replace(/\s+/g, '').normalize('NFKC')
  const all = [name, ...(STAFF_ALIASES[name] ?? [])].flatMap(v => [v, toKatakana(v), toHiragana(v)])
  return [...new Set(all)].sort((a, b) => b.length - a.length)
}
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const today = (now: Date) => new Date(now.getTime() + JST).toISOString().slice(0, 10)

/**
 * 音声認識は空白なしで返す（「明日15時スキンフェード田中さん」）。敬称の前の語から、日付・時刻・メニュー・担当・助詞を
 * 先頭側から取り除き、最後に残った部分を名前にする。
 */
function stripLeading(word: string, staff: readonly SbCommandStaff[], menus: readonly MenuOption[]): string {
  let cut = 0
  const mark = (re: RegExp) => { for (const m of word.matchAll(re)) cut = Math.max(cut, m.index + m[0].length) }
  mark(/(今日|明日|明後日|あした|きょう|あさって|本日|来週|今週|再来週|週末|土日)/g)
  mark(/(\d{1,2}月)?\d{1,2}日(後)?|\d{1,2}\/\d{1,2}/g)
  mark(/[日月火水木金土]曜日?/g)
  mark(/(午前|午後|朝|夜|夕方)?\d{1,2}(時半?|:\d{2})(\d{1,2}分)?(以降|から|頃|ごろ|くらい)?/g)
  mark(/(朝|昼|夕方|夜|午前|午後)(イチ|いち)?/g)
  // かなの時刻（音声認識）：「さんじ」「じゅうごじはん」。数字のかなが前にある「じ」だけ
  mark(/(じゅう(いち|に|さん|よ|ご|ろく|しち|なな|はち|く)?|いち|に|さん|よ|ご|ろく|しち|なな|はち|く)じ(はん)?/g)
  mark(/(電話|ホットペッパー|フリー|指名なし)/g)
  for (const st of staff) for (const v of spellings(st)) mark(new RegExp(escapeRe(v), 'g'))
  // メニュー名（先頭3文字以上の一致も。「スキンフェード」→「スキンフェードカット」）と、よく使う呼び方
  for (const m of menus) {
    const n = m.name.normalize('NFKC')
    for (let len = n.length; len >= 3; len--) { const i = word.lastIndexOf(n.slice(0, len)); if (i >= 0) { cut = Math.max(cut, i + len); break } }
  }
  mark(/(パンチ|パーマ|カット|カラー|メンテ|メッシュ|ブリーチ|白髪染め|顔そり|シャンプー|ぬれぱん|濡れパン|ぱんち|スキンフェード|フェード|アイパー|ツイスト|スペイン|ニグロ|アフロ|ギンパラ|銀パラ|丸刈り|前髪|眉|ライン|ゴッソ)/g)
  return word.slice(cut).replace(/^(の|で|に|は|と|、)+/, '')
}

/** 「田中さん」「田中太郎様」「タナカ君」：敬称の直前の名前。担当者の名前とメニュー名は除く */
function findCustomer(raw: string, staff: readonly SbCommandStaff[], menus: readonly MenuOption[]): string | null {
  // 敬称（「さんじ」＝3時の「さん」は除く）。敬称の後ろに続く言葉（「田中さんパンチ」）は名前に入れない
  const HONORIFIC = /(さん(?![じ時])|様|さま|サマ|くん|君|ちゃん)/
  const tokens = raw.normalize('NFKC').split(/[\s、,。]+/).filter(Boolean)
  const i = tokens.findIndex(t => { const m = t.match(HONORIFIC); return !!m && m.index! > 0 })
  if (i < 0) return null
  let name = stripLeading(tokens[i].slice(0, tokens[i].match(HONORIFIC)!.index), staff, menus)
  // 「明日の田中さん」：前に付いた言葉を外す（最後の「の」より後ろ）
  if (name.includes('の')) name = name.slice(name.lastIndexOf('の') + 1)
  name = name.replace(/^(お客様は?|お客さんは?|名前は?|予約は?)/, '')
  // 「鈴木 次郎さん」：直前が漢字だけの短い語（日付・時刻・担当でない）なら姓として前に付ける
  const prev = tokens[i - 1]
  if (prev && /^[\p{Script=Han}]{1,4}$/u.test(prev) && !staff.some(st => spellings(st).includes(prev))
      && parseVisitRequest(prev).dates.length === 0 && !/今日|明日|明後日|本日|週|曜/.test(prev)) {
    name = `${prev} ${name}`
  }
  if (!name || staff.some(st => spellings(st).includes(name))) return null
  return name
}

/** 担当の指名。「銀二郎で」「テイテイ指名」→ その人。「フリー」「指名なし」「誰でも」→ null */
function findStaff(raw: string, staff: readonly SbCommandStaff[]): { id: string | null; said: boolean } {
  const s = raw.normalize('NFKC').replace(/\s+/g, '')
  if (/フリー|ふりー|指名なし|しめいなし|誰でも|だれでも/.test(s)) return { id: null, said: true }
  // 名前の長い順に見る（「銀二郎」と「二郎」のような部分一致を避ける）
  const hit = [...staff].sort((a, b) => b.name.length - a.name.length).find(st => spellings(st).some(v => s.includes(v)))
  return hit ? { id: hit.id, said: true } : { id: null, said: false }
}

/** メニュー（複数可）：「カットとシェービング」「パンチ＋カラー」 */
function findMenus<T extends MenuOption>(raw: string, menus: readonly T[], exclude: string[]): T[] {
  let s = raw.normalize('NFKC')
  for (const word of exclude) if (word) s = s.split(word).join(' ')
  const found: T[] = []
  for (const part of s.split(/[とと、,+＋&\s]+|それと|あと|プラス/)) {
    const m = part.trim() ? matchMenu(part, menus) : null
    if (m && !found.some(f => f.code === m.code)) found.push(m)
  }
  // 区切りで見つからなければ全文で1つ
  if (found.length === 0) { const m = matchMenu(s, menus); if (m) found.push(m) }
  return found.slice(0, 5)
}

export function parseSbCommand<T extends MenuOption>(
  raw: string, staff: readonly SbCommandStaff[], menus: readonly T[], now: Date = new Date(),
): SbDraft {
  const understood: string[] = []
  const req = parseVisitRequest(raw, now)
  const date = req.dates[0] ?? today(now)
  if (req.dates[0]) understood.push('日付')
  let minutes: number | null = null
  const t = req.time ?? req.range?.from ?? null
  if (t) { const [h, m] = t.split(':').map(Number); minutes = h * 60 + m; understood.push('時刻') }

  const customerName = findCustomer(raw, staff, menus)
  if (customerName) understood.push('お客様')

  const phoneMatch = raw.normalize('NFKC').match(/(?:\+81[\s-]?|0)\d{1,4}[\s-]?\d{1,4}[\s-]?\d{3,4}/)
  const phone = phoneMatch ? normalizePhone(phoneMatch[0]) : null
  if (phone) understood.push('電話番号')

  const st = findStaff(raw, staff)
  if (st.said) understood.push('担当')

  // メニュー探しでは、担当・お客様の名前を除いて誤読を防ぐ（「銀パラ」と担当「銀二郎」など）
  const menuCodes = findMenus(raw, menus, [customerName ?? '', ...staff.flatMap(spellings)]).map(m => m.code)
  if (menuCodes.length) understood.push('メニュー')

  const n = normalizeUtterance(raw)
  const source = /ホットペッパー|ほっとぺっぱー|hotpepper|hpb|サロンボード/i.test(n) ? 'hotpepper' : /電話/.test(n) ? 'phone' : null
  const ref = raw.normalize('NFKC').match(/\b([A-Z]{2}\d{8,10})\b/i)
  return {
    date, minutes, customerName, phone, menuCodes, staffId: st.id, source,
    externalRef: source === 'hotpepper' && ref ? ref[1].toUpperCase() : null, understood,
  }
}
