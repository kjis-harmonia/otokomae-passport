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
const today = (now: Date) => new Date(now.getTime() + JST).toISOString().slice(0, 10)

/** 「田中さん」「田中太郎様」「タナカ君」：敬称の直前の名前。担当者の名前とメニュー名は除く */
function findCustomer(raw: string, staff: readonly SbCommandStaff[]): string | null {
  const tokens = raw.normalize('NFKC').split(/[\s、,。]+/).filter(Boolean)
  const i = tokens.findIndex(t => /(さん|様|さま|サマ|くん|君|ちゃん)$/.test(t) && !/^(さん|様|さま|サマ|くん|君|ちゃん)$/.test(t))
  if (i < 0) return null
  let name = tokens[i].replace(/(さん|様|さま|サマ|くん|君|ちゃん)$/, '')
  // 「明日の田中さん」：前に付いた言葉を外す（最後の「の」より後ろ）
  if (name.includes('の')) name = name.slice(name.lastIndexOf('の') + 1)
  name = name.replace(/^(お客様は?|お客さんは?|名前は?|予約は?)/, '')
  // 「鈴木 次郎さん」：直前が漢字だけの短い語（日付・時刻・担当でない）なら姓として前に付ける
  const prev = tokens[i - 1]
  if (prev && /^[\p{Script=Han}]{1,4}$/u.test(prev) && !staff.some(st => st.name === prev)
      && parseVisitRequest(prev).dates.length === 0 && !/今日|明日|明後日|本日|週|曜/.test(prev)) {
    name = `${prev} ${name}`
  }
  if (!name || staff.some(st => st.name === name)) return null
  return name
}

/** 担当の指名。「銀二郎で」「テイテイ指名」→ その人。「フリー」「指名なし」「誰でも」→ null */
function findStaff(raw: string, staff: readonly SbCommandStaff[]): { id: string | null; said: boolean } {
  const s = raw.normalize('NFKC').replace(/\s+/g, '')
  if (/フリー|ふりー|指名なし|しめいなし|誰でも|だれでも/.test(s)) return { id: null, said: true }
  // 名前の長い順に見る（「銀二郎」と「二郎」のような部分一致を避ける）
  const hit = [...staff].sort((a, b) => b.name.length - a.name.length).find(st => s.includes(st.name.replace(/\s+/g, '')))
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

  const customerName = findCustomer(raw, staff)
  if (customerName) understood.push('お客様')

  const phoneMatch = raw.normalize('NFKC').match(/(?:\+81[\s-]?|0)\d{1,4}[\s-]?\d{1,4}[\s-]?\d{3,4}/)
  const phone = phoneMatch ? normalizePhone(phoneMatch[0]) : null
  if (phone) understood.push('電話番号')

  const st = findStaff(raw, staff)
  if (st.said) understood.push('担当')

  // メニュー探しでは、担当・お客様の名前を除いて誤読を防ぐ（「銀パラ」と担当「銀二郎」など）
  const menuCodes = findMenus(raw, menus, [customerName ?? '', ...staff.map(s2 => s2.name)]).map(m => m.code)
  if (menuCodes.length) understood.push('メニュー')

  const n = normalizeUtterance(raw)
  const source = /ホットペッパー|ほっとぺっぱー|hotpepper|hpb|サロンボード/i.test(n) ? 'hotpepper' : /電話/.test(n) ? 'phone' : null
  const ref = raw.normalize('NFKC').match(/\b([A-Z]{2}\d{8,10})\b/i)
  return {
    date, minutes, customerName, phone, menuCodes, staffId: st.id, source,
    externalRef: source === 'hotpepper' && ref ? ref[1].toUpperCase() : null, understood,
  }
}
