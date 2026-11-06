// いつものメンバー（11/6 慶一郎さん「いつものメンバーに追加も入れたいねー！次回から楽じゃね？」）
//   お連れ様のお名前とメニューを、この端末に覚えておく（DB は変えない）。次のお連れ様の予約で、押すだけで選べる
//   4名まで。同じお名前は新しいメニューで上書きして先頭へ
import { getStoredValue, setStoredValue } from '../../utils/storage'

export const USUAL_MEMBERS_KEY = 'ginjiro_usual_members'
export interface UsualMember { name: string; menuCode: string }

export function getUsualMembers(): UsualMember[] {
  const v = getStoredValue<unknown>(USUAL_MEMBERS_KEY, [])
  return Array.isArray(v) ? v.filter((x): x is UsualMember => !!x && typeof x.name === 'string' && typeof x.menuCode === 'string').slice(0, 4) : []
}

export function isUsualMember(name: string): boolean {
  return getUsualMembers().some(m => m.name === name)
}

/** 追加する。保存できなければ false */
export function addUsualMember(m: UsualMember): boolean {
  const next = [m, ...getUsualMembers().filter(x => x.name !== m.name)].slice(0, 4)
  try { setStoredValue(USUAL_MEMBERS_KEY, next); return getUsualMembers().some(x => x.name === m.name) } catch { return false }
}
