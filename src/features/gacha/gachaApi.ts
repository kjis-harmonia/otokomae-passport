// 本日のガチャの景品（11/3）：抽選はサーバー（customer_gacha_draw）。1会員1日1回・同じ日は同じ結果。
// ガチャ券は1枚だけ持てる。新しい券が出たら今の券とどちらを残すかをお客様が選ぶ（customer_gacha_keep）。
// 11/4 工程②：AI 予約の確認で使える券なら自動で付ける（customer_gacha_attach）。付いた券は予約が終わるまで交換できない。
import { callCustomerRpc, hasCustomerSession } from '../../utils/customerSession'

export type GachaPrize = {
  code: string
  title: string
  amount: number | null
  free_menu: string | null
  weekday_only: boolean
  rank: 'normal' | 'rare' | 'legend'
}
export type GachaHeld = GachaPrize & {
  expires_at: string
  /** 使えるメニュー（null＝メンテナンスカット以外のどれでも） */
  menu_codes?: string[] | null
  /** 付いている予約（まだ終わっていないもの） */
  reserved?: { id: string; starts_at: string } | null
}
export type GachaChoice = 'auto' | 'new' | 'old'
export type GachaState = {
  today: { id: string; prize: GachaPrize; choice: GachaChoice | null } | null
  held: GachaHeld | null
  repeat?: boolean // true＝何回でも引ける（Staging の試し用）
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
/** お連れ様の予約をご本人の予約につなぐ（工程③。無料券をお連れ様に使えるのはつながった予約だけ） */
export const linkCompanion = async (primaryId: string, companionId: string) => {
  const r = await callCustomerRpc<{ ok?: boolean; error?: string }>('customer_link_companion', { p_primary: primaryId, p_companion: companionId })
  if (r?.error) throw new Error(r.error)
}
export const attachGacha = async (reservationId: string) => check(await callCustomerRpc<GachaState>('customer_gacha_attach', { p_reservation_id: reservationId }))

/** 「11月10日（火）のご予約」 */
export function gachaReservedLabel(startsAt: string): string {
  const d = new Date(Date.parse(startsAt) + 9 * 3600000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${'日月火水木金土'[d.getUTCDay()]}）のご予約`
}

/** 「12月4日まで」（期限は翌日 0:00 で持っているので1秒戻す） */
export function gachaUntil(expiresAt: string): string {
  const d = new Date(new Date(expiresAt).getTime() - 1000)
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getMonth() + 1}月${jst.getDate()}日まで`
}

/** 使える日の一言 */
export const gachaDays = (p: GachaPrize) => (p.weekday_only ? '平日のみ' : '曜日を問わず')
