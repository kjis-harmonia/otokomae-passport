import { supabase } from '../lib/supabase'
import type { TicketRow, IssueTicketInput } from '../data/ticket'

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
  const { data, error } = await supabase
    .from('tickets')
    .select()
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as TicketRow[]
}

export async function markTicketUsed(ticketId: string, staffId: string): Promise<void> {
  const { error } = await supabase
    .from('tickets')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', ticketId)
  if (error) throw error
  void staffId // Phase2: write audit log with staffId
}
