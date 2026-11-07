// 「いつものメニュー」の登録（1つだけ）。ホームの「いつもの」と Johnny が使う。
//   登録はこの端末に保存する（DB は変えない）。消えたら Johnny がまた聞く／来店の記録から決める。
//   メンテナンスカットのお知らせの登録は JOHNNY のお知らせ（PushToggle・webPush）のまま。
import { getStoredValue, setStoredValue } from '../../utils/storage'

export const USUAL_MENU_KEY = 'ginjiro_usual_menu'
/** いつもの担当（担当の画面で「次回からもこの担当にする」を選んだ人。登録していれば担当の確認を省く・10/27） */
export const USUAL_STAFF_KEY = 'ginjiro_usual_staff'

export interface UsualMenu { code: string; name: string }

export function getUsualMenu(): UsualMenu | null {
  const v = getStoredValue<UsualMenu | null>(USUAL_MENU_KEY, null)
  return v && typeof v.code === 'string' && typeof v.name === 'string' ? v : null
}

/** いつものメニューに選ばれやすい順（ほかはこのあとに料金表の順） */
const USUAL_FIRST = ['cut-regular', 'cut-skin-fade', 'perm-iper', 'perm-punch', 'cut-skin-fade-plus', 'perm-nurepan', 'perm-curl-iper', 'perm-negro', 'perm-spain', 'store-teitei-gari', 'perm-ginpara-curly', 'cut-buzz']

/** いつものメニューにならないもの：メンテナンス・顔そり・オプション（眉・シャンプーなど）・前髪だけ */
export function canBeUsual(code: string): boolean {
  // オプション（ライン・前髪など）とメンテナンスカットはいつものにしない。シェービングはいつものにできる（11/8 お母さん＝レディースシェービング）
  return !/^(maintenance|opt-)/.test(code) && code !== 'cut-bangs'
}

/** いつものメニューを選ぶ一覧：なれないものを除いて、選ばれやすい順 */
export function usualMenuOrder<T extends { code: string }>(menus: readonly T[]): T[] {
  const rank = (c: string) => { const i = USUAL_FIRST.indexOf(c); return i < 0 ? USUAL_FIRST.length : i }
  return menus.filter(m => canBeUsual(m.code)).map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.code) - rank(b.m.code) || a.i - b.i).map(x => x.m)
}

/** 保存できたか（プライベートブラウズ・容量いっぱいなどで保存できないと false） */
export function setUsualMenu(menu: UsualMenu): boolean {
  setStoredValue(USUAL_MENU_KEY, { code: menu.code, name: menu.name })
  // 会員の記録にも残す（機種変更しても消えない・お店の登録より新しい方を使う・11/6）。届かなくても端末には残る
  void import('../../utils/customerSession').then(({ callCustomerRpc, hasCustomerSession }) => { if (hasCustomerSession()) return callCustomerRpc('customer_set_usual_menu', { p_code: menu.code }) }).catch(() => {})
  return getUsualMenu()?.code === menu.code
}

/** 会員の記録のいつものメニュー（お店で登録したもの・ほかの端末で登録したもの）。読めなければ null */
export async function fetchServerUsualMenu(): Promise<UsualMenu | null> {
  const v = await fetchServerUsualMenuState()
  return v === 'none' || v === 'unknown' ? null : v
}

/** 'none'＝会員の記録に無いと分かった・'unknown'＝読めなかった（ログイン前・通信など） */
export async function fetchServerUsualMenuState(): Promise<UsualMenu | 'none' | 'unknown'> {
  try {
    const { callCustomerRpc, hasCustomerSession } = await import('../../utils/customerSession')
    if (!hasCustomerSession()) return 'unknown'
    const v = await callCustomerRpc<{ code?: string; name?: string } | null>('customer_usual_menu')
    return v && typeof v.code === 'string' && typeof v.name === 'string' ? { code: v.code, name: v.name } : 'none'
  } catch { return 'unknown' }
}

/** いつもの担当の id（登録していなければ null＝どちらでもいい・毎回聞く） */
export function getUsualStaff(): string | null {
  const v = getStoredValue<string | null>(USUAL_STAFF_KEY, null)
  return typeof v === 'string' && v ? v : null
}
/** いつもの担当を登録する（null で取り消し＝毎回聞く） */
export function setUsualStaff(staffId: string | null): void {
  setStoredValue(USUAL_STAFF_KEY, staffId)
}
