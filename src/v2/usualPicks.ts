// V2 ホームの「いつもの」：来店したことがあるお客様だけに出す1枚（「漢は黙っていつもので」のポスター）。
//   メニューは来店の記録でいちばん多いもの（Johnny の「おかえりなさい」と同じ数え方・buildWelcome）。
//   記録にメニューが無い（QR の来店登録だけ）ときはメニューを決めずに Johnny を開く（おかえりなさい から聞く）。予約のメニューで推測はしない。
import { bookingAssistantApi, type CustomerReservation } from '../features/johnny/bookingAssistantApi'
import { buildWelcome, type VisitRecord } from '../features/johnny/welcome'
import { STYLE_MENU_CODES } from '../data/reserveLinks'
import { UI_CATEGORIES } from '../data/styleCategories'

/** null = 来店したことが無い（「いつもの」を出さない）。menu が null = 来店はあるがメニューが分からない */
export type Usual = { menu: { code: string; name: string; title: string | null } | null } | null

let cache: { at: number; usual: Promise<Usual> } | null = null

/** ホットペッパーのリンク用のスタイル：そのメニューのスタイルのうち、メニュー名を含むもの（パンチパーマ → バチバチパンチパーマ）、無ければ最初のもの */
function styleTitleFor(code: string, name: string): string | null {
  const titles = UI_CATEGORIES.flatMap(c => [...c.titles]).filter(t => STYLE_MENU_CODES[t] === code)
  return titles.find(t => t.includes(name)) ?? titles[0] ?? null
}

async function load(): Promise<Usual> {
  const api = bookingAssistantApi()
  const [opts, list, lastVisit, visits] = await Promise.all([
    api.options(),
    api.reservations().catch(() => [] as CustomerReservation[]),
    api.lastVisit().catch(() => null),
    api.recentVisits().catch(() => [] as VisitRecord[]),
  ])
  const w = buildWelcome(lastVisit, list, opts.menus, Date.now(), visits)
  if (!w) return null
  const m = w.usual.find(x => x.code !== 'maintenance') ?? (w.lastMenu && w.lastMenu.code !== 'maintenance' ? w.lastMenu : null)
  return { menu: m ? { code: m.code, name: m.name, title: styleTitleFor(m.code, m.name) } : null }
}

/** 5分はホームを開き直しても読み直さない。読めなかったら null */
export function loadUsual(): Promise<Usual> {
  if (cache && Date.now() - cache.at < 5 * 60000) return cache.usual
  const usual = load().catch(() => null)
  cache = { at: Date.now(), usual }
  return usual
}
