// 'cut-ticket' は旧型名 — 既存レコードの後方互換のため残す
export type TicketType = 'coupon' | 'discount' | 'otoku' | 'cut-ticket'

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  coupon:       'クーポン',
  discount:     '割引券',
  otoku:        '漢トク券',
  'cut-ticket': '漢トク券', // legacy
}

export const TICKET_TYPE_COLORS: Record<TicketType, { bg: string; border: string; text: string }> = {
  coupon:       { bg: 'rgba(201,162,74,0.14)', border: 'rgba(201,162,74,0.4)',  text: '#C9A24A' },
  discount:     { bg: 'rgba(176,32,53,0.14)',  border: 'rgba(176,32,53,0.4)',   text: '#E06070' },
  otoku:        { bg: 'rgba(74,127,201,0.14)', border: 'rgba(74,127,201,0.4)', text: '#6AABF0' },
  'cut-ticket': { bg: 'rgba(74,127,201,0.14)', border: 'rgba(74,127,201,0.4)', text: '#6AABF0' }, // legacy
}

export interface TicketRow {
  id:         string
  user_id:    string
  type:       TicketType
  title:      string
  amount:     number
  memo:       string | null
  used:       boolean
  issued_by:  string
  created_at: string
  used_at:    string | null
  expires_at: string | null
  // Transfer fields
  pending_transfer?:  boolean
  transfer_token?:    string | null
  transferred_from?:  string | null
  transferred_to?:    string | null
  transferred_at?:    string | null
}

export interface IssueTicketInput {
  user_id:    string
  type:       TicketType
  title:      string
  amount:     number
  memo?:      string
  issued_by:  string
  expires_at?: string
}
