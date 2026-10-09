/**
 * チケットのデータアクセス（Supabase RPC 経由）。
 *
 * セキュリティ監査対応：
 *   - お客様：顧客セッション（p_session）で本人を特定する customer_* RPC。user_id を本人確認に使わない。
 *   - 店舗端末：スタッフセッション（p_staff）付きの staff_* RPC。
 *   - 保存失敗を localStorage に退避して成功扱いにする処理は行わない。失敗は必ず例外で返す。
 *   - 発行・使用はサーバー側で1トランザクション（全件成功 or 全件失敗）。
 *   - 移行期間（ステップB 適用前）に限り、セッションの無い既存会員の「読み取り」だけ従来の直接読み取りで表示する。
 */

import type { TicketRow, TicketType } from '../data/ticket'
import { removeStoredValue } from './storage'
import { supabase } from '../lib/supabase'
import { callRpc, callStaffRpc, isMissingRpc, RpcError } from './staffSession'
import { callCustomerRpc, hasCustomerSession, readAsCustomer, saveCustomerSession } from './customerSession'

const ACTIVE_TICKET_KEY = 'ginjiro_active_ticket'

/** 旧バージョンが残した activeTicket（1会計1枚制御の名残）を消す */
export function clearActiveTicket(): void {
  removeStoredValue(ACTIVE_TICKET_KEY)
}

// ── お客様アプリ ──────────────────────────────────────────────────────────────

/**
 * 本人のチケット一覧（使用済み含む・新しい順）。pending_transfer 付き。失敗時は例外。
 * userId は移行期間の直接読み取り（セッション未取得の既存会員）にのみ使う。
 */
export async function getUserTickets(userId: string): Promise<TicketRow[]> {
  const rows = await readAsCustomer<TicketRow[] | null>('customer_get_tickets', () => legacyReadTickets(userId))
  return rows ?? []
}

/** 移行期間のみ（ステップB 後は RLS により失敗する）。失敗時は例外。 */
async function legacyReadTickets(userId: string): Promise<TicketRow[]> {
  const { data, error } = await supabase
    .from('tickets')
    .select()
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const tickets = (data ?? []) as TicketRow[]
  const { data: pending } = await supabase
    .from('ticket_transfers')
    .select('ticket_id')
    .eq('from_user_id', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
  const pendingSet = new Set((pending ?? []).map((t: { ticket_id: string }) => t.ticket_id))
  return tickets.map(t => (pendingSet.has(t.id) ? { ...t, pending_transfer: true } : t))
}

// ── First-run onboarding / Welcome coupon ────────────────────────────────────

export interface WelcomeOnboardingResult {
  customerRegistered: boolean
  welcomeCouponIssued: boolean
  ticket: TicketRow | null
  skippedReason?: 'visited_before' | 'existing_customer' | 'already_issued'
}

interface RegisterRpcResponse {
  user_id: string
  session: string
  ticket: TicketRow | null
  welcome_coupon_issued: boolean
}

interface CompleteOnboardingRpcResponse {
  ticket?: TicketRow | null
  welcome_coupon_issued?: boolean
  existing_customer?: boolean
}

/**
 * 初回登録＋Welcomeクーポン発行。
 *   customer_register：サーバーが user_id を採番し、顧客セッションを同時に発行（端末に保存）。
 *   「いいえ」のときだけ Welcomeクーポンを1枚発行。DB 保存に成功した ticket が返った場合のみ発行済み扱い。
 * ステップA 適用前の環境に限り、旧 RPC（complete_customer_onboarding）で登録する。
 * 失敗時は例外（テーブル直接書き込みへの代替は行わない）。
 */
export async function completeCustomerOnboarding(
  userId: string,
  name: string,
  hasVisitedBefore: boolean,
): Promise<WelcomeOnboardingResult> {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('名前を入力してください。')

  try {
    const r = await callRpc<RegisterRpcResponse>('customer_register', {
      p_name: trimmedName,
      p_has_visited_before: hasVisitedBefore,
    })
    saveCustomerSession(r.user_id, r.session)
    const ticket = r.ticket ?? null
    return {
      customerRegistered: true,
      welcomeCouponIssued: Boolean(r.welcome_coupon_issued && ticket),
      ticket,
      skippedReason: hasVisitedBefore ? 'visited_before' : undefined,
    }
  } catch (err) {
    if (!isMissingRpc(err)) throw err
  }

  // ── 移行期間：ステップA 未適用の環境のみ ──
  const result = (await callRpc<CompleteOnboardingRpcResponse | null>('complete_customer_onboarding', {
    p_user_id: userId,
    p_name: trimmedName,
    p_has_visited_before: hasVisitedBefore,
  })) ?? {}
  const ticket = result.ticket ?? null
  return {
    customerRegistered: true,
    welcomeCouponIssued: Boolean(result.welcome_coupon_issued && ticket),
    ticket,
    skippedReason: hasVisitedBefore
      ? 'visited_before'
      : result.existing_customer
        ? 'existing_customer'
        : result.welcome_coupon_issued
          ? undefined
          : ticket
            ? 'already_issued'
            : undefined,
  }
}

// ── 店舗端末（スタッフセッション必須） ────────────────────────────────────────

/** 店舗端末用：会員のチケット一覧（スタッフ認証で取得） */
export async function getTicketsForStaff(userId: string): Promise<TicketRow[]> {
  const r = await callStaffRpc<{ tickets: TicketRow[] | null }>('staff_customer_context', { p_user_id: userId })
  return r.tickets ?? []
}

export interface IssueTicketsInput {
  userId:       string
  type:         Extract<TicketType, 'otoku' | 'discount'>
  amount:       number
  quantity:     number
  staffName:    string
  customerName: string
}

/** チケット一括発行。全件成功で発行済みチケットを返し、1枚でも失敗すれば何も発行されない。 */
export async function issueTickets(input: IssueTicketsInput): Promise<TicketRow[]> {
  const r = await callStaffRpc<{ tickets: TicketRow[] }>('staff_issue_tickets', {
    p_user_id:       input.userId,
    p_type:          input.type,
    p_amount:        input.amount,
    p_quantity:      input.quantity,
    p_staff_name:    input.staffName,
    p_customer_name: input.customerName,
  })
  return r.tickets ?? []
}

export interface UseTicketsInput {
  userId:       string
  ticketIds:    string[]
  staffName:    string
  customerName: string
}

/**
 * チケット使用確定（複数枚も1トランザクション）。
 * サーバー側で本人・未使用・同一種別・当日の併用ルール・Welcome平日限定を検証し、
 * used化・使用ログ・来店日更新をまとめて行う。失敗時は RpcError。
 */
export async function redeemTickets(input: UseTicketsInput): Promise<{ tickets: TicketRow[]; visitDate: string }> {
  const ticketIds = [...new Set(input.ticketIds)]
  if (ticketIds.length === 0) throw new RpcError('no_tickets')
  const r = await callStaffRpc<{ tickets: TicketRow[]; visit_date: string }>('staff_use_tickets', {
    p_user_id:       input.userId,
    p_ticket_ids:    ticketIds,
    p_staff_name:    input.staffName,
    p_customer_name: input.customerName,
  })
  const redeemedIds = new Set(r?.tickets?.filter(t => t.used).map(t => t.id))
  if (!r?.visit_date || redeemedIds.size !== ticketIds.length || ticketIds.some(id => !redeemedIds.has(id))) {
    throw new Error('使用結果を確認できませんでした。QRを読み取り直してチケットの状態を確認してください。')
  }
  return { tickets: r.tickets, visitDate: r.visit_date }
}

// ── Transfer（顧客セッション必須） ─────────────────────────────────────────────

function needsBind(err: unknown): boolean {
  return err instanceof RpcError && err.code === 'customer_auth_required'
}

/** 譲渡開始。ワンタイムトークン（24時間有効）を返す。 */
export async function initiateTransfer(ticketId: string): Promise<string> {
  try {
    const r = await callCustomerRpc<{ token: string }>('customer_create_transfer', { p_ticket_id: ticketId })
    return r.token
  } catch (err) {
    if (needsBind(err)) throw new Error('チケットを譲るには、以前のチケットの引き継ぎが必要です。', { cause: err })
    if (err instanceof RpcError && err.detail && typeof err.detail === 'object' && 'error' in (err.detail as object)) {
      throw new Error(err.code, { cause: err }) // RPC は日本語メッセージを返す
    }
    throw new Error('譲渡の開始に失敗しました。通信環境を確認してください。', { cause: err })
  }
}

/** 譲渡を取りやめる。失敗時は例外。 */
export async function cancelTransfer(ticketId: string): Promise<void> {
  await callCustomerRpc('customer_cancel_transfer', { p_ticket_id: ticketId })
}

/** トークンで譲渡チケットを確認（受け取り前プレビュー）。無効なら null、通信失敗は例外。 */
export async function getTicketByTransferToken(token: string): Promise<TicketRow | null> {
  return (await callRpc<TicketRow | null>('get_transfer_preview', { p_token: token })) ?? null
}

/**
 * 譲渡受け取り確定。受け取る人も顧客セッションで特定する（customer_claim_transfer・1トランザクション）。
 * 移行期間に限り、セッションの無い既存会員は旧 RPC（claim_ticket_transfer）で受け取る。
 */
export async function acceptTransfer(token: string, toUserId: string): Promise<TicketRow> {
  try {
    const r = hasCustomerSession()
      ? await callCustomerRpc<{ ticket?: TicketRow }>('customer_claim_transfer', { p_token: token })
      : await callRpc<{ ticket?: TicketRow }>('claim_ticket_transfer', { p_token: token, p_to_user_id: toUserId })
    if (!r.ticket) throw new Error('トークンが無効または期限切れです')
    return r.ticket
  } catch (err) {
    if (needsBind(err)) throw new Error('チケットを受け取るには、以前のチケットの引き継ぎが必要です。', { cause: err })
    if (err instanceof RpcError && err.detail && typeof err.detail === 'object' && 'error' in (err.detail as object)) {
      throw new Error(err.code, { cause: err }) // claim_ticket_transfer は日本語メッセージを返す
    }
    throw err instanceof Error ? err : new Error('受け取りに失敗しました。')
  }
}
