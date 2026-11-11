// 本日のガチャの景品（11/3）：抽選はサーバー（customer_gacha_draw）。1会員1日1回・同じ日は同じ結果。
// ガチャ券は1枚だけ持てる。新しい券が出たら今の券とどちらを残すかをお客様が選ぶ。
// 11/4 工程②：AI 予約の確認で使える券なら自動で付ける（customer_gacha_attach）。付いた券は予約が終わるまで交換できない。
import { callCustomerRpc, hasCustomerSession } from '../../utils/customerSession'
import { supabase } from '../../lib/supabase'

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
  /** ゲージで受け取った券（ご本人の予約だけ） */
  self_only?: boolean
}
/** ゲージ（11/6）：ガチャ券を使ったご来店でポイントがたまり、狙う景品の分たまったら受け取れる */
export type GachaGoal = GachaPrize & { points: number }
/** 今月のガチャの分：引くたびに 0.1pt・月 cap まで。visited＝今月ポイントの付く来店があった（その月の分がゲージに入る） */
export type GachaGaugeMonth = { draw_pt: number; cap: number; visited: boolean }
export type GachaGauge = { open: false } | { open: true; points: number; target: string | null; goals: GachaGoal[]; month?: GachaGaugeMonth }
export type GachaChoice ='auto' | 'new' | 'old'
type GachaDraw = { id: string; prize: GachaPrize; choice: GachaChoice | null }
export type GachaState = {
  today: GachaDraw | null
  held: GachaHeld | null
  repeat?: boolean // true＝何回でも引ける（Staging の試し用）
  gauge?: GachaGauge
  error?: string
}
export type GachaKeepResult = GachaState & { current_today?: GachaDraw | null; replayed?: boolean }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))

function isPrize(value: unknown): boolean {
  return record(value) && text(value.code) && text(value.title) &&
    (value.amount === null || number(value.amount)) &&
    (value.free_menu === null || text(value.free_menu)) && typeof value.weekday_only === 'boolean' &&
    (value.rank === 'normal' || value.rank === 'rare' || value.rank === 'legend')
}

function isHeld(value: unknown): boolean {
  return value === null || (record(value) && isPrize(value) && timestamp(value.expires_at) &&
    (value.menu_codes == null || (Array.isArray(value.menu_codes) && value.menu_codes.every(text))) &&
    (value.self_only === undefined || typeof value.self_only === 'boolean') &&
    (value.reserved == null || (record(value.reserved) && text(value.reserved.id) && timestamp(value.reserved.starts_at))))
}

function isGauge(value: unknown): boolean {
  if (!record(value)) return false
  if (value.open === false) return true
  return value.open === true && number(value.points) && (value.target === null || text(value.target)) &&
    Array.isArray(value.goals) && value.goals.every(goal => record(goal) && isPrize(goal) && number(goal.points)) &&
    (value.month === undefined || (record(value.month) && number(value.month.draw_pt) &&
      number(value.month.cap) && typeof value.month.visited === 'boolean'))
}

function isDraw(value: unknown): value is GachaDraw | null {
  return value === null || (record(value) && text(value.id) && isPrize(value.prize) &&
    (value.choice === null || value.choice === 'auto' || value.choice === 'new' || value.choice === 'old'))
}

function isState(value: unknown): value is GachaState {
  if (!record(value) || value.error !== undefined || !isHeld(value.held)) return false
  const { today, repeat, gauge } = value
  return isDraw(today) &&
    (repeat === undefined || typeof repeat === 'boolean') && (gauge === undefined || isGauge(gauge))
}

function check(value: unknown): GachaState {
  if (record(value) && text(value.error)) throw new Error(value.error)
  if (!isState(value)) throw new Error('gacha_state_invalid')
  return value
}

export const canUseGacha = hasCustomerSession
/** 今月のラインナップ（ログインなしで読める・確率は出さない） */
export async function loadLineup(): Promise<(GachaPrize & { value?: number | null })[]> {
  const { data, error } = await supabase.rpc('gacha_lineup')
  if (error || !Array.isArray(data)) throw new Error(error?.message ?? 'lineup_failed')
  return data as (GachaPrize & { value?: number | null })[]
}
export const loadGacha = async () => check(await callCustomerRpc<GachaState>('customer_gacha_state'))
export const peekGacha = async () => check(await callCustomerRpc<unknown>('customer_gacha_peek'))
export const drawGacha = async () => check(await callCustomerRpc<GachaState>('customer_gacha_draw'))
export const keepGacha = async (choice: 'new' | 'old', drawId: string): Promise<GachaKeepResult> => {
  const raw = await callCustomerRpc<Record<string, unknown>>('customer_gacha_keep_checked', { p_choice: choice, p_draw_id: drawId })
  const state = check(raw)
  const { current_today, replayed } = raw
  if ((current_today !== undefined && !isDraw(current_today)) ||
      (replayed !== undefined && typeof replayed !== 'boolean')) {
    throw new Error('gacha_state_invalid')
  }
  return { ...state, current_today, replayed }
}
export const setGaugeTarget = async (code: string) => check(await callCustomerRpc<GachaState>('customer_gacha_gauge_target', { p_code: code }))
export const claimGauge = async () => check(await callCustomerRpc<GachaState>('customer_gacha_gauge_claim'))
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
