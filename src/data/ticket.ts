export type TicketType = 'coupon' | 'discount' | 'cut-ticket'

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  coupon:       'クーポン',
  discount:     '割引券',
  'cut-ticket': '漢トク券',
}

export const TICKET_TYPE_COLORS: Record<TicketType, { bg: string; border: string; text: string }> = {
  coupon:       { bg: 'rgba(201,162,74,0.14)', border: 'rgba(201,162,74,0.4)',  text: '#C9A24A' },
  discount:     { bg: 'rgba(176,32,53,0.14)',  border: 'rgba(176,32,53,0.4)',   text: '#E06070' },
  'cut-ticket': { bg: 'rgba(74,127,201,0.14)', border: 'rgba(74,127,201,0.4)', text: '#6AABF0' },
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
  pending_transfer?:  boolean       // 譲渡手続き中
  transfer_token?:    string | null // ワンタイムトークン（使用後 null）
  transferred_from?:  string | null // 元のオーナーuserID
  transferred_to?:    string | null // 譲渡先 userID
  transferred_at?:    string | null // 譲渡確定日時 ISO 8601
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
