// 銀オク（Staging だけ）：一覧・詳細・入札・即決。正はサーバー（customer_ginoku_*）。
// 入札・即決が断られたときも、サーバーは最新の詳細を一緒に返す（画面をすぐ最新にする）
import { supabase } from '../../lib/supabase'
import { callCustomerRpc, getCustomerSession } from '../../utils/customerSession'
import { RpcError } from '../../utils/staffSession'
import type { AuctionMine, AuctionStatus } from './auctionLogic'

export type Auction = {
  id: string
  title: string
  prize_code: string | null
  rank: 'normal' | 'rare' | 'legend'
  /** 割引券の額（無料券は null） */
  ticket_amount: number | null
  /** 無料券のメニューの名前（「銀パラ」。割引券は null・古い DB には無い） */
  free_menu?: string | null
  ticket_days: number
  weekday_only: boolean
  note: string | null
  start_price: number
  increment: number
  buy_now_price: number | null
  current_price: number | null
  min_bid: number
  bid_count: number
  starts_at: string
  ends_at: string
  extended: boolean
  status: AuctionStatus
  sold_via: 'bid' | 'buy_now' | null
  final_price: number | null
  my_bid: number | null
  /** 最高額のあいだ押さえている自分の銀Pay（無ければ null・古い DB には無い） */
  held?: number | null
  mine: AuctionMine
  ticket_id: string | null
}
export type AuctionWallet = { balance: number; available: number } | { error: string } | null
export type AuctionBid = { amount: number; at: string; mine: boolean; bidder: string }
export type AuctionList = { now: string; signed_in: boolean; wallet: AuctionWallet; auctions: Auction[] }
export type AuctionDetail = { now: string; signed_in: boolean; wallet: AuctionWallet; auction: Auction; bids: AuctionBid[] }
export type AuctionAction = AuctionDetail & { ok?: boolean; extended?: boolean; error?: string }

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isAuction = (v: unknown): v is Auction =>
  record(v) && typeof v.id === 'string' && typeof v.title === 'string' && typeof v.min_bid === 'number' &&
  typeof v.ends_at === 'string' && typeof v.status === 'string'

function list(v: unknown): AuctionList {
  if (!record(v) || !Array.isArray(v.auctions) || !v.auctions.every(isAuction)) throw new Error('ginoku_invalid')
  return v as AuctionList
}
function detail(v: unknown): AuctionAction {
  if (!record(v)) throw new Error('ginoku_invalid')
  if (!isAuction(v.auction)) throw new RpcError(typeof v.error === 'string' ? v.error : 'ginoku_invalid')
  return v as AuctionAction
}

/** ログイン前でも一覧・詳細は見られる（入札はできない） */
async function read<T>(fn: string, params: Record<string, unknown>): Promise<T> {
  if (getCustomerSession()) return callCustomerRpc<T>(fn, params)
  const { data, error } = await supabase.rpc(fn, { p_session: null, ...params })
  if (error) throw new RpcError(error.code ?? 'rpc_failed', error.message)
  return data as T
}

export const loadAuctions = async () => list(await read<unknown>('customer_ginoku_list', {}))
export const loadAuction = async (id: string) => detail(await read<unknown>('customer_ginoku_detail', { p_id: id }))

/** 断られた（{error} が返った）ときも、一緒に返った最新の詳細を使う */
async function act(fn: string, params: Record<string, unknown>): Promise<AuctionAction> {
  try {
    return detail(await callCustomerRpc<unknown>(fn, params))
  } catch (err) {
    if (err instanceof RpcError && record(err.detail) && isAuction(err.detail.auction)) return err.detail as AuctionAction
    throw err
  }
}
export const placeBid = (id: string, amount: number) => act('customer_ginoku_bid', { p_id: id, p_amount: amount })
export const buyNow = (id: string) => act('customer_ginoku_buy_now', { p_id: id })

export const walletAvailable = (w: AuctionWallet): number | null => (w && 'available' in w ? w.available : null)
