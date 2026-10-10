// 会計画面の合計の表示（B-2B-2）。表示専用。どの金額を出すかと、その出所だけを決める。
//   - 有効な見積もり（サーバーの計算）があれば、その金額。
//   - 管理者承認待ちなら、承認を求めたときにサーバーが返した小計・合計（承認画面と同じ金額）。
//   - どちらも無い・見積もりが失効したときは、画面の暫定の金額であることを明示する（確定した金額としては出さない）。
// 金額を計算し直さない（暫定の金額は会計画面がすでに持っているものをそのまま使う）。確定できるかの条件にも関わらない。

export type CheckoutTotalSource = 'quote' | 'approval_pending' | 'provisional'

export interface CheckoutTotalDisplay {
  source: CheckoutTotalSource
  label: string
  /** 金額の出所の説明。有効な見積もりのときは無し */
  note: string | null
  /** 小計（出所に無ければ null） */
  subtotal: number | null
  /** 値引き（出所に無ければ null） */
  discount: number | null
  total: number
}

/** 残高予測も支払額と同じ表示基準を使う。決済の判定・確定処理には使わない。 */
export function ginpayBalancePreview(balance: number, display: CheckoutTotalDisplay) {
  const paymentAmount = Math.max(0, display.total)
  const provisional = display.source === 'provisional'
  return {
    paymentAmount,
    remainingBalance: balance - paymentAmount,
    insufficient: balance < paymentAmount,
    paymentLabel: provisional ? '今回のお支払い（暫定）' : '今回のお支払い',
    remainingLabel: provisional ? '支払後の残高（暫定）' : '支払後の残高',
  }
}

export function checkoutTotalDisplay(a: {
  quote: { subtotal: number; discount_total: number; total: number } | null
  /** 見積もりが今の内容のもので、失効・エラーが無い */
  quoteUsable: boolean
  /** 承認待ちの、承認を求めた応答の小計・合計 */
  approval: { subtotal: number; total: number } | null
  /** 承認のあとの見積もりか */
  approved: boolean
  quoteLoading: boolean
  /** 画面の暫定の金額 */
  local: { subtotal: number; discount: number; total: number }
}): CheckoutTotalDisplay {
  if (a.quote && a.quoteUsable) {
    return {
      source: 'quote', label: 'お支払い', note: a.approved ? '管理者承認済みの見積もりです。' : null,
      subtotal: a.quote.subtotal, discount: a.quote.discount_total, total: a.quote.total,
    }
  }
  if (a.approval) {
    return {
      source: 'approval_pending', label: 'お支払い', note: '管理者承認待ち（サーバーで計算した金額）',
      subtotal: a.approval.subtotal, discount: null, total: a.approval.total,
    }
  }
  return {
    source: 'provisional', label: 'お支払い（暫定）',
    note: a.quoteLoading ? '見積もりを計算中です。表示は暫定の金額です。' : '見積もりが無いため暫定の金額です。確定には最新の見積もりが必要です。',
    subtotal: a.local.subtotal, discount: a.local.discount, total: a.local.total,
  }
}
