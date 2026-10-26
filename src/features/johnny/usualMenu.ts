// 「いつものメニュー」の登録（1つだけ）。ホームの「いつもの」と Johnny が使う。
//   登録はこの端末に保存する（DB は変えない）。消えたら Johnny がまた聞く／来店の記録から決める。
//   メンテナンスカットのお知らせの登録は JOHNNY のお知らせ（PushToggle・webPush）のまま。
import { getStoredValue, setStoredValue } from '../../utils/storage'

export const USUAL_MENU_KEY = 'ginjiro_usual_menu'

export interface UsualMenu { code: string; name: string }

export function getUsualMenu(): UsualMenu | null {
  const v = getStoredValue<UsualMenu | null>(USUAL_MENU_KEY, null)
  return v && typeof v.code === 'string' && typeof v.name === 'string' ? v : null
}

/** いつものメニューに選ばれやすい順（ほかはこのあとに料金表の順） */
const USUAL_FIRST = ['cut-regular', 'cut-skin-fade', 'perm-iper', 'perm-punch', 'cut-skin-fade-plus', 'perm-nurepan', 'perm-curl-iper', 'perm-negro', 'perm-spain', 'store-teitei-gari', 'perm-ginpara-curly', 'cut-buzz']

/** いつものメニューにならないもの：メンテナンス・顔そり・オプション（眉・シャンプーなど）・前髪だけ */
export function canBeUsual(code: string): boolean {
  return !/^(maintenance|shave-|opt-)/.test(code) && code !== 'cut-bangs'
}

/** いつものメニューを選ぶ一覧：なれないものを除いて、選ばれやすい順 */
export function usualMenuOrder<T extends { code: string }>(menus: readonly T[]): T[] {
  const rank = (c: string) => { const i = USUAL_FIRST.indexOf(c); return i < 0 ? USUAL_FIRST.length : i }
  return menus.filter(m => canBeUsual(m.code)).map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.code) - rank(b.m.code) || a.i - b.i).map(x => x.m)
}

/** 保存できたか（プライベートブラウズ・容量いっぱいなどで保存できないと false） */
export function setUsualMenu(menu: UsualMenu): boolean {
  setStoredValue(USUAL_MENU_KEY, { code: menu.code, name: menu.name })
  return getUsualMenu()?.code === menu.code
}
