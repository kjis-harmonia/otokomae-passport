// 本日のガチャの景品（11/3）：抽選はサーバー（customer_gacha_draw）。1会員1日1回・同じ日は同じ結果。
// ガチャ券は1枚だけ持てる。新しい券が出たら今の券とどちらを残すかをお客様が選ぶ（customer_gacha_keep）。
import { callCustomerRpc, hasCustomerSession } from '../../utils/customerSession'

export type GachaPrize = {
  code: string
  title: string
  amount: number | null
  free_menu: string | null
  weekday_only: boolean
  rank: 'normal' | 'rare' | 'legend'
}
export type GachaHeld = GachaPrize & { expires_at: string }
export type GachaChoice = 'auto' | 'new' | 'old'
export type GachaState = {
  today: { id: string; prize: GachaPrize; choice: GachaChoice | null } | null
  held: GachaHeld | null
  error?: string
}

function check(s: GachaState): GachaState {
  if (s && typeof s === 'object' && 'error' in s && s.error) throw new Error(s.error)
  return s
}

export const canUseGacha = hasCustomerSession
export const loadGacha = async () => check(await callCustomerRpc<GachaState>('customer_gacha_state'))
export const drawGacha = async () => check(await callCustomerRpc<GachaState>('customer_gacha_draw'))
export const keepGacha = async (choice: 'new' | 'old') => check(await callCustomerRpc<GachaState>('customer_gacha_keep', { p_choice: choice }))

/** 「12月4日まで」（期限は翌日 0:00 で持っているので1秒戻す） */
export function gachaUntil(expiresAt: string): string {
  const d = new Date(new Date(expiresAt).getTime() - 1000)
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getMonth() + 1}月${jst.getDate()}日まで`
}

/** 使える日の一言 */
export const gachaDays = (p: GachaPrize) => (p.weekday_only ? '平日のみ' : '曜日を問わず')
