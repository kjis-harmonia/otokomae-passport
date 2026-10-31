// V2 ホームの「いつもの」：「漢は黙っていつもので」のポスター1枚。
//   メニューは、登録した「いつものメニュー」（Johnny で登録・この端末）→ 来店の記録でいちばん多いもの（Johnny の「おかえりなさい」と同じ数え方）。
//   どちらも無いがご来店はある（QR の来店登録だけ）ときはメニューを決めずに Johnny へ（Johnny がいつものメニューを聞いて登録する）。
//   来店も登録も無いお客様には出さない。予約のメニューで推測はしない。
import { bookingAssistantApi, type CustomerReservation } from '../features/johnny/bookingAssistantApi'
import { buildWelcome, type VisitRecord } from '../features/johnny/welcome'
import { canBeUsual, getUsualMenu } from '../features/johnny/usualMenu'
import { STYLE_MENU_CODES } from '../data/reserveLinks'
import { UI_CATEGORIES } from '../data/styleCategories'
import { getCustomerSession } from '../utils/customerSession'

type UsualMenu = { code: string; name: string; title: string | null }
/** null = 出さない。menu が null = ご来店はあるがメニューが分からない */
export type Usual = { menu: UsualMenu | null } | null

// 来店の記録は会員（セッション）ごと。別の会員に切り替えたら読み直す（10/30 監査 R8）
let cache: { at: number; owner: string | null; visited: Promise<{ visited: boolean; menu: UsualMenu | null }> } | null = null

/** ホットペッパーのリンク用のスタイル：そのメニューのスタイルのうち、メニュー名を含むもの（パンチパーマ → バチバチパンチパーマ）、無ければ最初のもの */
function styleTitleFor(code: string, name: string): string | null {
  const titles = UI_CATEGORIES.flatMap(c => [...c.titles]).filter(t => STYLE_MENU_CODES[t] === code)
  return titles.find(t => t.includes(name)) ?? titles[0] ?? null
}

async function loadVisited(): Promise<{ visited: boolean; menu: UsualMenu | null }> {
  const api = bookingAssistantApi()
  const [opts, list, lastVisit, visits] = await Promise.all([
    api.options(),
    api.reservations().catch(() => [] as CustomerReservation[]),
    api.lastVisit().catch(() => null),
    api.recentVisits().catch(() => [] as VisitRecord[]),
  ])
  const w = buildWelcome(lastVisit, list, opts.menus, Date.now(), visits)
  if (!w) return { visited: false, menu: null }
  const m = w.usual.find(x => canBeUsual(x.code)) ?? (w.lastMenu && canBeUsual(w.lastMenu.code) ? w.lastMenu : null)
  return { visited: true, menu: m ? { code: m.code, name: m.name, title: styleTitleFor(m.code, m.name) } : null }
}

/** 登録したいつものメニューは毎回読み直す（Johnny で登録した直後にも反映）。来店の記録は5分読み直さない
 *  ただし「まだ来店なし」「読めなかった」は覚えない：店で来店登録・初回の本人確認をした直後に出るように（10/27） */
export async function loadUsual(): Promise<Usual> {
  const reg = getUsualMenu()
  if (reg && canBeUsual(reg.code)) return { menu: { ...reg, title: styleTitleFor(reg.code, reg.name) } }
  const owner = getCustomerSession()
  if (!cache || cache.owner !== owner || Date.now() - cache.at >= 5 * 60000) cache = { at: Date.now(), owner, visited: loadVisited().catch(() => ({ visited: false, menu: null })) }
  const mine = cache
  const v = await mine.visited
  if (!v.visited && cache === mine) cache = null
  return v.visited ? { menu: v.menu } : null
}
