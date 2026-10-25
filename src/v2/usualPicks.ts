// V2 ホームの「いつもの」：来店の記録から、次に頼みそうなものを最大2つ。
//   いつものスタイル（履歴でいちばん多いメニュー）と、使える間のメンテナンスカット。
//   パンチパーマ → メンテナンス → パンチパーマ… の順で来るので、前回がスタイルならメンテナンスを先に、前回がメンテナンスならスタイルを先に。
//   数え方は Johnny の「おかえりなさい」と同じ（buildWelcome）。初めてのお客様・履歴が無いお客様は空（チップを出さない）。
import { bookingAssistantApi, type CustomerReservation } from '../features/johnny/bookingAssistantApi'
import { buildWelcome, type VisitRecord } from '../features/johnny/welcome'
import { STYLE_MENU_CODES } from '../data/reserveLinks'
import { UI_CATEGORIES } from '../data/styleCategories'

export type UsualPick =
  | { kind: 'style'; code: string; name: string; title: string | null }
  | { kind: 'maintenance'; left: number; days: number }

let cache: { at: number; picks: Promise<UsualPick[]> } | null = null

/** 写真に使うスタイル：そのメニューのスタイルのうち、メニュー名を含むもの（パンチパーマ → バチバチパンチパーマ）、無ければホームのカテゴリで最初に出てくるもの */
function styleTitleFor(code: string, name: string): string | null {
  const titles = UI_CATEGORIES.flatMap(c => [...c.titles]).filter(t => STYLE_MENU_CODES[t] === code)
  return titles.find(t => t.includes(name)) ?? titles[0] ?? null
}

async function load(): Promise<UsualPick[]> {
  const api = bookingAssistantApi()
  const [opts, list, lastVisit, visits] = await Promise.all([
    api.options(),
    api.reservations().catch(() => [] as CustomerReservation[]),
    api.lastVisit().catch(() => null),
    api.recentVisits().catch(() => [] as VisitRecord[]),
  ])
  const w = buildWelcome(lastVisit, list, opts.menus, Date.now(), visits)
  if (!w) return []
  const usual = w.usual.find(m => m.code !== 'maintenance') ?? (w.lastMenu && w.lastMenu.code !== 'maintenance' ? w.lastMenu : null)
  const style: UsualPick | null = usual ? { kind: 'style', code: usual.code, name: usual.name, title: styleTitleFor(usual.code, usual.name) } : null
  const maint: UsualPick | null = w.maintenanceLeft != null ? { kind: 'maintenance', left: w.maintenanceLeft, days: w.days } : null
  const maintFirst = w.lastMenu?.code !== 'maintenance'
  return (maintFirst ? [maint, style] : [style, maint]).filter((p): p is UsualPick => !!p)
}

/** 5分はホームを開き直しても読み直さない。読めなかったら空 */
export function loadUsualPicks(): Promise<UsualPick[]> {
  if (cache && Date.now() - cache.at < 5 * 60000) return cache.picks
  const picks = load().catch(() => [] as UsualPick[])
  cache = { at: Date.now(), picks }
  return picks
}
