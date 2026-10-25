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

export function setUsualMenu(menu: UsualMenu): void {
  setStoredValue(USUAL_MENU_KEY, { code: menu.code, name: menu.name })
}
