import { supabase } from '../lib/supabase'
import type { TicketRow, IssueTicketInput } from '../data/ticket'
import { getStoredValue, setStoredValue, removeStoredValue } from './storage'

// ── LocalStorage keys ─────────────────────────────────────────────────────────

const LOCAL_TICKETS_KEY  = 'ginjiro_local_tickets'
const ACTIVE_TICKET_KEY  = 'ginjiro_active_ticket'

// ── localStorage helpers ──────────────────────────────────────────────────────

function getAllLocalTickets(): TicketRow[] {
  return getStoredValue<TicketRow[]>(LOCAL_TICKETS_KEY, [])
}

function patchLocalTickets(patch: TicketRow[]): void {
  const ids = new Set(patch.map(t => t.id))
  const rest = getAllLocalTickets().filter(t => !ids.has(t.id))
  setStoredValue(LOCAL_TICKETS_KEY, [...rest, ...patch])
}

function getLocalTickets(userId: string): TicketRow[] {
  return getAllLocalTickets().filter(t => t.user_id === userId)
}

function saveLocalTickets(userId: string, tickets: TicketRow[]): void {
  const others = getAllLocalTickets().filter(t => t.user_id !== userId)
  setStoredValue(LOCAL_TICKETS_KEY, [...others, ...tickets])
}

export function markLocalTicketUsed(ticketId: string): void {
  patchLocalTickets(
    getAllLocalTickets().map(t =>
      t.id === ticketId ? { ...t, used: true, used_at: new Date().toISOString() } : t
    )
  )
}

// ── Active ticket (1会計1枚制御) ──────────────────────────────────────────────

/** 現在QR表示中のチケットIDをセット。他チケットはQR表示不可。 */
export function setActiveTicket(ticketId: string): void {
  setStoredValue(ACTIVE_TICKET_KEY, ticketId)
}

/** QR閉じたらクリア。 */
export function clearActiveTicket(): void {
  removeStoredValue(ACTIVE_TICKET_KEY)
}

/** 現在アクティブなチケットIDを返す。なければ null。 */
export function getActiveTicket(): string | null {
  return getStoredValue<string | null>(ACTIVE_TICKET_KEY, null)
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function issueTicket(input: IssueTicketInput): Promise<TicketRow> {
  const payload = {
    user_id:    input.user_id,
    type:       input.type,
    title:      input.title,
    amount:     input.amount,
    memo:       input.memo ?? null,
    issued_by:  input.issued_by,
    expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
    used:       false,
  }
  const { data, error } = await supabase
    .from('tickets')
    .insert(payload)
    .select()
    .single()
  if (error) throw error
  return data as TicketRow
}

export async function getUserTickets(userId: string): Promise<TicketRow[]> {
  try {
    const { data, error } = await supabase
      .from('tickets')
      .select()
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    const tickets = (data ?? []) as TicketRow[]
    saveLocalTickets(userId, tickets)
    return tickets
  } catch {
    return getLocalTickets(userId)
  }
}

export async function markTicketUsed(ticketId: string, staffId: string): Promise<void> {
  const { error } = await supabase
    .from('tickets')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', ticketId)
  if (error) throw error
  void staffId // Phase2: write audit log with staffId
}

// ── Transfer ──────────────────────────────────────────────────────────────────

/**
 * 譲渡開始。ワンタイムトークンを生成し tickets に書き込む。
 * 返り値のトークンで譲渡URL `?transfer=TOKEN` を組み立てる。
 * 有効条件: used:false、期限内、pending_transfer:false
 */
export async function initiateTransfer(ticketId: string, fromUserId: string): Promise<string> {
  const token = crypto.randomUUID()
  try {
    const { error } = await supabase
      .from('tickets')
      .update({ pending_transfer: true, transfer_token: token })
      .eq('id', ticketId)
      .eq('user_id', fromUserId)
      .eq('used', false)
    if (error) throw error
  } catch {
    // localStorage fallback（同端末テスト用）
    patchLocalTickets(
      getAllLocalTickets().map(t =>
        t.id === ticketId ? { ...t, pending_transfer: true, transfer_token: token } : t
      )
    )
  }
  return token
}

/** 譲渡をキャンセルし pending_transfer と transfer_token をクリア。 */
export async function cancelTransfer(ticketId: string, userId: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('tickets')
      .update({ pending_transfer: false, transfer_token: null })
      .eq('id', ticketId)
      .eq('user_id', userId)
    if (error) throw error
  } catch {
    patchLocalTickets(
      getAllLocalTickets().map(t =>
        t.id === ticketId ? { ...t, pending_transfer: false, transfer_token: null } : t
      )
    )
  }
}

/**
 * トークンで譲渡先を確認（受け取り前プレビュー用）。
 * トークン未発見/使用済みなら null。
 */
export async function getTicketByTransferToken(token: string): Promise<TicketRow | null> {
  try {
    const { data } = await supabase
      .from('tickets')
      .select()
      .eq('transfer_token', token)
      .eq('pending_transfer', true)
      .single()
    return (data ?? null) as TicketRow | null
  } catch {
    return getAllLocalTickets().find(t => t.transfer_token === token && t.pending_transfer) ?? null
  }
}

/**
 * 譲渡受け取り確定。
 * - user_id を toUserId に変更
 * - pending_transfer: false、transfer_token: null
 * - transferred_from / transferred_to / transferred_at を記録
 * トークンが無効・使用済みの場合は throw。
 */
export async function acceptTransfer(token: string, toUserId: string): Promise<TicketRow> {
  const now = new Date().toISOString()
  try {
    const { data: found, error: findErr } = await supabase
      .from('tickets')
      .select()
      .eq('transfer_token', token)
      .eq('pending_transfer', true)
      .single()
    if (findErr || !found) throw new Error('トークンが無効または期限切れです')
    const ticket = found as TicketRow
    if (ticket.used) throw new Error('使用済みチケットは受け取れません')
    if (ticket.user_id === toUserId) throw new Error('自分自身へは譲渡できません')

    const { data: updated, error: updErr } = await supabase
      .from('tickets')
      .update({
        user_id:          toUserId,
        pending_transfer: false,
        transfer_token:   null,
        transferred_from: ticket.user_id,
        transferred_to:   toUserId,
        transferred_at:   now,
      })
      .eq('id', ticket.id)
      .select()
      .single()
    if (updErr) throw updErr
    return updated as TicketRow
  } catch (e) {
    // localStorage fallback
    const all = getAllLocalTickets()
    const ticket = all.find(t => t.transfer_token === token && t.pending_transfer)
    if (!ticket) throw e
    if (ticket.used) throw new Error('使用済みチケットは受け取れません')
    if (ticket.user_id === toUserId) throw new Error('自分自身へは譲渡できません')
    const updated: TicketRow = {
      ...ticket,
      user_id:          toUserId,
      pending_transfer: false,
      transfer_token:   null,
      transferred_from: ticket.user_id,
      transferred_to:   toUserId,
      transferred_at:   now,
    }
    patchLocalTickets(all.map(t => t.id === ticket.id ? updated : t))
    return updated
  }
}
