// 'cut-ticket' は旧型名 — 既存レコードの後方互換のため残す
export type TicketType = 'coupon' | 'discount' | 'otoku' | 'cut-ticket'

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  coupon:       'クーポン',
  discount:     '割引券',
  otoku:        '漢トク券',
  'cut-ticket': '漢トク券', // legacy
}

export const TICKET_TYPE_COLORS: Record<TicketType, {
  bg: string      // badge / label 背景
  border: string  // badge / カード枠
  text: string    // 文字色
  cardBg: string  // チケットカード背景グラデーション
  btnBg: string   // 「使用する」ボタン背景
}> = {
  // 深いワインレッド（メンテナンスクーポン）
  coupon: {
    bg:     'rgba(110,12,28,0.18)',
    border: 'rgba(168,28,52,0.46)',
    text:   '#D45570',
    cardBg: 'linear-gradient(155deg, #1B0508 0%, #0D0203 100%)',
    btnBg:  'linear-gradient(135deg, rgba(110,12,28,0.36) 0%, rgba(70,5,18,0.18) 100%)',
  },
  // ブロンズ系（割引券）
  discount: {
    bg:     'rgba(95,58,0,0.22)',
    border: 'rgba(153,96,18,0.48)',
    text:   '#C4893A',
    cardBg: 'linear-gradient(155deg, #160C04 0%, #0A0503 100%)',
    btnBg:  'linear-gradient(135deg, rgba(95,58,0,0.40) 0%, rgba(60,35,0,0.20) 100%)',
  },
  // 黒金系（漢トク券）
  otoku: {
    bg:     'rgba(12,10,2,0.38)',
    border: 'rgba(183,148,58,0.54)',
    text:   '#D4AF5A',
    cardBg: 'linear-gradient(155deg, #0D0B04 0%, #060604 100%)',
    btnBg:  'linear-gradient(135deg, rgba(18,14,3,0.65) 0%, rgba(8,7,1,0.30) 100%)',
  },
  'cut-ticket': {
    bg:     'rgba(12,10,2,0.38)',
    border: 'rgba(183,148,58,0.54)',
    text:   '#D4AF5A',
    cardBg: 'linear-gradient(155deg, #0D0B04 0%, #060604 100%)',
    btnBg:  'linear-gradient(135deg, rgba(18,14,3,0.65) 0%, rgba(8,7,1,0.30) 100%)',
  },
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
