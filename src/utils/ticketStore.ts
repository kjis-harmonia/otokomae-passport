import { supabase } from '../lib/supabase'
import type { TicketRow, TicketTransferRow, IssueTicketInput } from '../data/ticket'
import { getStoredValue, setStoredValue, removeStoredValue } from './storage'

// ── LocalStorage keys ─────────────────────────────────────────────────────────

const LOCAL_TICKETS_KEY   = 'ginjiro_local_tickets'
const LOCAL_TRANSFERS_KEY = 'ginjiro_local_transfers'
const ACTIVE_TICKET_KEY   = 'ginjiro_active_ticket'

// ── localStorage helpers (tickets) ───────────────────────────────────────────

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

// ── localStorage helpers (transfers) ─────────────────────────────────────────

function getAllLocalTransfers(): TicketTransferRow[] {
  return getStoredValue<TicketTransferRow[]>(LOCAL_TRANSFERS_KEY, [])
}

function upsertLocalTransfer(transfer: TicketTransferRow): void {
  const others = getAllLocalTransfers().filter(t => t.id !== transfer.id)
  setStoredValue(LOCAL_TRANSFERS_KEY, [...others, transfer])
}

// ── Active ticket (1会計1枚制御) ──────────────────────────────────────────────

export function setActiveTicket(ticketId: string): void {
  setStoredValue(ACTIVE_TICKET_KEY, ticketId)
}

export function clearActiveTicket(): void {
  removeStoredValue(ACTIVE_TICKET_KEY)
}

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
  try {
    const { data, error } = await supabase
      .from('tickets')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    const ticket = data as TicketRow
    patchLocalTickets([ticket])
    return ticket
  } catch (err) {
    console.error('[issueTicket] Supabase error — falling back to localStorage:', err)
    const ticket: TicketRow = {
      id:         `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      user_id:    input.user_id,
      type:       input.type,
      title:      input.title,
      amount:     input.amount,
      memo:       input.memo ?? null,
      used:       false,
      issued_by:  input.issued_by,
      created_at: new Date().toISOString(),
      used_at:    null,
      expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
    }
    patchLocalTickets([ticket])
    return ticket
  }
}

export async function getUserTickets(userId: string): Promise<TicketRow[]> {
  try {
    const { data, error } = await supabase
      .from('tickets')
      .select()
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    const supabaseTickets = (data ?? []) as TicketRow[]

    // pending_transfer フラグを ticket_transfers から取得してマージ
    try {
      const { data: pendingTransfers } = await supabase
        .from('ticket_transfers')
        .select('ticket_id')
        .eq('from_user_id', userId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
      const pendingSet = new Set(
        (pendingTransfers ?? []).map((t: { ticket_id: string }) => t.ticket_id)
      )
      for (const ticket of supabaseTickets) {
        if (pendingSet.has(ticket.id)) ticket.pending_transfer = true
      }
    } catch { /* pending_transfer 表示は非必須 */ }

    const localOnly = getLocalTickets(userId).filter(
      lt => lt.id.startsWith('local-') && !supabaseTickets.some(st => st.id === lt.id)
    )
    const merged = [...localOnly, ...supabaseTickets]
    saveLocalTickets(userId, merged)
    return merged
  } catch {
    return getLocalTickets(userId)
  }
}

export async function markTicketUsed(ticketId: string, staffId: string): Promise<void> {
  if (ticketId.startsWith('local-')) {
    markLocalTicketUsed(ticketId)
    void staffId
    return
  }
  const { error } = await supabase
    .from('tickets')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', ticketId)
  if (error) throw error
  void staffId
}

// ── Transfer ──────────────────────────────────────────────────────────────────
//
// 設計: tickets テーブルには pending_transfer / transfer_token カラムを持たない。
// 譲渡状態は ticket_transfers テーブルで管理する。
// token の有効期限は 24 時間。
//
// ── ValidationError: 論理エラー（ネットワークエラーと区別して localStorage fallback を回避）

class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** Supabase の uuid 型として有効かチェック */
function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

/** Supabase エラーの詳細を文字列で返す */
function supabaseErrDetail(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    return JSON.stringify({ message: e['message'], details: e['details'], hint: e['hint'], code: e['code'] })
  }
  return String(err)
}

/**
 * 譲渡開始。ticket_transfers にレコードを挿入し、ワンタイムトークンを返す。
 * UUID 形式でないチケット（local-, dev-, 数値IDなど）は譲渡不可として throw する。
 */
export async function initiateTransfer(ticketId: string, fromUserId: string): Promise<string> {
  const token     = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24時間後
  console.log('[Transfer] initiateTransfer start', { ticketId, fromUserId, token, expiresAt })

  // UUID 形式でないチケット（local-xxx, dev-xxx, 数値など）は Supabase に保存できない
  // → 譲渡不可として throw し、UI で明示的なエラーを表示する
  if (!isValidUUID(ticketId)) {
    console.warn('[Transfer] ticket_id is not a valid UUID, cannot transfer:', ticketId)
    throw new ValidationError('このチケットは旧ローカル保存のため譲渡できません。店舗端末で再発行してください。')
  }

  const { data, error } = await supabase
    .from('ticket_transfers')
    .insert({
      token,
      ticket_id:    ticketId,
      from_user_id: fromUserId,
      status:       'pending',
      expires_at:   expiresAt,
    })
    .select()
    .single()

  if (error) {
    console.error('[Transfer] initiateTransfer Supabase INSERT error:', supabaseErrDetail(error))
    throw new Error(`譲渡の開始に失敗しました。(${error.message ?? error.code ?? 'unknown'})`)
  }

  console.log('[Transfer] initiateTransfer INSERT success:', data)
  return token
}

/** 譲渡をキャンセルし ticket_transfers を 'cancelled' に更新。 */
export async function cancelTransfer(ticketId: string, fromUserId: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('ticket_transfers')
      .update({ status: 'cancelled' })
      .eq('ticket_id', ticketId)
      .eq('from_user_id', fromUserId)
      .eq('status', 'pending')
    if (error) throw error
  } catch {
    const all = getAllLocalTransfers().map(t =>
      t.ticket_id === ticketId && t.from_user_id === fromUserId && t.status === 'pending'
        ? { ...t, status: 'cancelled' as const }
        : t
    )
    setStoredValue(LOCAL_TRANSFERS_KEY, all)
  }
}

/**
 * トークンで譲渡先を確認（受け取り前プレビュー用）。
 * token が未発見/期限切れ/使用済みなら null。
 * Supabase が利用不可の場合のみ localStorage fallback。
 */
export async function getTicketByTransferToken(token: string): Promise<TicketRow | null> {
  console.log('[Transfer] getTicketByTransferToken called', { token })
  try {
    const now = new Date().toISOString()
    const { data: transfer, error: xferErr } = await supabase
      .from('ticket_transfers')
      .select()
      .eq('token', token)
      .eq('status', 'pending')
      .gt('expires_at', now)
      .maybeSingle()
    console.log('[Transfer] getTicketByTransferToken ticket_transfers query result:', { transfer, xferErr, now })
    if (xferErr) throw xferErr                 // ネットワークエラー → fallback
    if (!transfer) {
      console.warn('[Transfer] token not found in Supabase (no error, just not found)')
      return null                              // Supabase 確認済みで存在しない
    }

    const ticketId = (transfer as { ticket_id: string }).ticket_id
    const { data: ticket, error: ticketErr } = await supabase
      .from('tickets')
      .select()
      .eq('id', ticketId)
      .maybeSingle()
    console.log('[Transfer] getTicketByTransferToken tickets query result:', { ticket, ticketErr, ticketId })
    return (ticket ?? null) as TicketRow | null
  } catch (err) {
    console.warn('[Transfer] getTicketByTransferToken Supabase error, trying localStorage:', supabaseErrDetail(err))
    // localStorage fallback（Supabase 未設定・オフライン時の同端末テスト用）
    const transfer = getAllLocalTransfers().find(t =>
      t.token === token &&
      t.status === 'pending' &&
      new Date(t.expires_at) > new Date()
    )
    console.log('[Transfer] getTicketByTransferToken localStorage fallback result:', transfer)
    if (!transfer) return null
    return getAllLocalTickets().find(t => t.id === transfer.ticket_id) ?? null
  }
}

/**
 * 譲渡受け取り確定。RPC claim_ticket_transfer を呼ぶ。
 * RPC が利用不可の場合は順次クエリで代替、それも失敗なら localStorage fallback。
 *
 * 成功: 更新後の TicketRow を返す。
 * 失敗: ValidationError（再試行不可）またはネットワークエラーを throw。
 */
export async function acceptTransfer(token: string, toUserId: string): Promise<TicketRow> {
  const now = new Date().toISOString()
  console.log('[Transfer] acceptTransfer called', { token, toUserId })

  // ── Try RPC (推奨: atomic) ────────────────────────────────────────────────
  try {
    console.log('[Transfer] calling RPC claim_ticket_transfer...')
    const { data, error } = await supabase.rpc('claim_ticket_transfer', {
      p_token:      token,
      p_to_user_id: toUserId,
    })
    console.log('[Transfer] RPC result:', { data, error })
    if (error) throw error
    const result = data as { error?: string; ticket?: TicketRow }
    if (result.error) throw new ValidationError(result.error)
    if (!result.ticket) throw new ValidationError('トークンが無効または期限切れです')
    console.log('[Transfer] RPC success, ticket:', result.ticket)
    patchLocalTickets([result.ticket])
    return result.ticket
  } catch (rpcErr) {
    if (rpcErr instanceof ValidationError) {
      console.warn('[Transfer] RPC returned validation error:', (rpcErr as Error).message)
      throw rpcErr
    }
    console.warn('[Transfer] RPC failed (non-validation), falling back to sequential queries:', supabaseErrDetail(rpcErr))
    // RPC が存在しない場合やネットワークエラー → 順次クエリで代替
  }

  // ── Fallback: 順次クエリ ─────────────────────────────────────────────────
  try {
    console.log('[Transfer] sequential fallback: querying ticket_transfers...')
    const { data: transfer, error: xferErr } = await supabase
      .from('ticket_transfers')
      .select()
      .eq('token', token)
      .maybeSingle()
    console.log('[Transfer] sequential ticket_transfers result:', { transfer, xferErr })
    if (xferErr) throw xferErr

    if (!transfer) throw new ValidationError('トークンが無効または期限切れです')
    const tr = transfer as TicketTransferRow
    if (tr.status !== 'pending') throw new ValidationError('すでに受け取り済みです')
    if (new Date(tr.expires_at) <= new Date()) throw new ValidationError('トークンが期限切れです')

    const { data: ticket, error: ticketErr } = await supabase
      .from('tickets')
      .select()
      .eq('id', tr.ticket_id)
      .maybeSingle()
    console.log('[Transfer] sequential tickets result:', { ticket, ticketErr })
    if (ticketErr) throw ticketErr
    if (!ticket) throw new ValidationError('チケットが存在しません')

    const t = ticket as TicketRow
    if (t.used) throw new ValidationError('使用済みチケットは受け取れません')
    if (t.user_id === toUserId) throw new ValidationError('自分自身へは譲渡できません')

    const { data: updated, error: updErr } = await supabase
      .from('tickets')
      .update({ user_id: toUserId })
      .eq('id', tr.ticket_id)
      .select()
      .single()
    console.log('[Transfer] sequential tickets UPDATE result:', { updated, updErr })
    if (updErr) throw updErr

    const { error: claimErr } = await supabase
      .from('ticket_transfers')
      .update({ status: 'claimed', to_user_id: toUserId, claimed_at: now })
      .eq('id', tr.id)
    console.log('[Transfer] sequential ticket_transfers claimed UPDATE result:', { claimErr })

    const result = updated as TicketRow
    patchLocalTickets([result])
    return result
  } catch (supaErr) {
    if (supaErr instanceof ValidationError) {
      console.warn('[Transfer] sequential validation error:', (supaErr as Error).message)
      throw supaErr
    }
    console.warn('[Transfer] sequential Supabase error, falling back to localStorage:', supabaseErrDetail(supaErr))

    // ── localStorage fallback（同端末テスト用） ───────────────────────────
    const transfers = getAllLocalTransfers()
    const transfer  = transfers.find(t => t.token === token)
    console.log('[Transfer] localStorage fallback: found transfer?', !!transfer)
    if (!transfer) throw new ValidationError('トークンが無効または期限切れです')
    if (transfer.status !== 'pending') throw new ValidationError('すでに受け取り済みです')
    if (new Date(transfer.expires_at) <= new Date()) throw new ValidationError('トークンが期限切れです')

    const ticket = getAllLocalTickets().find(t => t.id === transfer.ticket_id)
    if (!ticket) throw new ValidationError('チケットが存在しません')
    if (ticket.used) throw new ValidationError('使用済みチケットは受け取れません')
    if (ticket.user_id === toUserId) throw new ValidationError('自分自身へは譲渡できません')

    const updatedTicket: TicketRow = { ...ticket, user_id: toUserId }
    patchLocalTickets(getAllLocalTickets().map(t => t.id === ticket.id ? updatedTicket : t))
    upsertLocalTransfer({ ...transfer, status: 'claimed', to_user_id: toUserId, claimed_at: now })
    console.log('[Transfer] localStorage fallback success')
    return updatedTicket
  }
}
