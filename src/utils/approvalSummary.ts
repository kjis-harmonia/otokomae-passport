// 店長の承認で「何を承認するか」の表示（表示専用）。
//   - 承認のあとに実際に送る内容（送信用の入力そのもの）から作る。画面の別の状態から作らない。
//   - 承認の要否・金額の判定はサーバーが行う。ここは何も判定しない。
//   - 会計の金額は、承認を求めたサーバー応答の小計・合計だけを使う。フロントで明細や合計を計算・推測しない。
//   - 承認・操作者トークン、見積もりハッシュ、PIN は受け取らず、表示もしない（念のため値も検査して落とす）。

export interface ApprovalDetail { label: string; value: string }

export interface ApprovalSummary {
  /** 操作名 */
  operation: string
  /** 金額（円） */
  amount: number
  /** 金額の見出し（例：会計の合計）。無ければ見出しなし */
  amountLabel?: string
  /** 対象・内容 */
  details: ApprovalDetail[]
  /** 申請した内容（会計の価格変更）。金額は上の合計に含まれる。サーバーが確定した明細ではない */
  changes?: { title: string; lines: ApprovalDetail[] }
}

/** 承認を求めたサーバー応答（staff_pos_quote の approval_required）の小計・合計。request_hash と同じ計算から返る */
export interface ServerQuoteAmounts { requestHash: string; subtotal: number; total: number }

/** サーバーは小計・合計を文字列で返す（->>）。整数として読めないときは null（推測値を表示しない） */
function yenValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v)
  return null
}

/** approval_required 応答から小計・合計を読む。どれかが欠けている・壊れているときは null（承認画面を開かない） */
export function quoteApprovalAmounts(res: Record<string, unknown>): ServerQuoteAmounts | null {
  const subtotal = yenValue(res.subtotal)
  const total = yenValue(res.total)
  const requestHash = typeof res.request_hash === 'string' && res.request_hash !== '' ? res.request_hash : null
  if (subtotal === null || total === null || requestHash === null) return null
  return { requestHash, subtotal, total }
}

const SECRET_PATTERN = /(APR1|AUTH1|QTE1)\.|token/i
const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`
const PAYMENT_LABEL: Record<string, string> = { cash: '現金', credit: 'カード', card: 'カード', qr: 'QR', other: 'その他' }

function clean(details: (ApprovalDetail | null)[]): ApprovalDetail[] {
  return details.filter((d): d is ApprovalDetail => !!d && d.value.trim() !== '' && !SECRET_PATTERN.test(d.value) && !SECRET_PATTERN.test(d.label))
}

function customer(name: string | null | undefined): ApprovalDetail | null {
  const n = name?.trim()
  return n ? { label: '対象', value: `${n} 様` } : null
}

/** 店舗チャージ（staff_ginpay_charge_store に送る入力から） */
export function chargeApprovalSummary(
  input: { amount: number; paymentMethod: string },
  ctx: { customerName?: string | null; accountLabel?: string | null },
): ApprovalSummary {
  return {
    operation: 'GINPayチャージ',
    amount: input.amount,
    details: clean([
      customer(ctx.customerName),
      ctx.accountLabel ? { label: 'チャージ先', value: ctx.accountLabel } : null,
      { label: '支払方法', value: PAYMENT_LABEL[input.paymentMethod] ?? input.paymentMethod },
    ]),
  }
}

/** GINPay 返金（staff_ginpay_refund に送る入力から） */
export function refundApprovalSummary(
  input: { amount: number; reason: string },
  ctx: { customerName?: string | null; originalLabel?: string | null },
): ApprovalSummary {
  return {
    operation: 'GINPay返金',
    amount: input.amount,
    details: clean([
      customer(ctx.customerName),
      ctx.originalLabel ? { label: '元の取引', value: ctx.originalLabel } : null,
      { label: '理由', value: input.reason },
    ]),
  }
}

const TICKET_LABEL: Record<string, string> = { discount: '割引券', otoku: '漢トク券' }

/** チケット発行（staff_issue_tickets に送る入力から） */
export function ticketApprovalSummary(input: { type: string; amount: number; quantity: number; customerName: string }): ApprovalSummary {
  return {
    operation: 'チケット発行',
    amount: input.amount * input.quantity,
    details: clean([
      customer(input.customerName),
      { label: '内容', value: `${TICKET_LABEL[input.type] ?? input.type} ${yen(input.amount)} × ${input.quantity}枚` },
    ]),
  }
}

/** 承認画面の「申請した内容」の見出し。サーバーが確定した明細ではないことを示す */
export const CHECKOUT_REQUEST_TITLE = '申請した内容（金額は上の合計で確定）'

/**
 * 会計の価格変更。2つに分けて表示する。
 *   A. サーバーが確定した金額：承認を求めたときにサーバーが返した小計・合計だけ。
 *      承認対象（requestHash）と違う応答の金額は使わない（null を返す。呼び出し元は承認画面を開かない）。
 *   B. スタッフが申請した内容：承認のあとに送る入力のうち、サーバーが価格として読む値をすべて出す。
 *      - 価格変更の指定（price_override）
 *      - 予約以外の明細の入力単価（price_from メニューの増額など、指定なしの価格変更もここに含まれる）
 *      - 追加品目（手入力）・手動値引き
 *      どの単価が価格の例外かはサーバーが決める。ここでは判定せず、送る価格入力を漏れなく並べる。
 *      予約の明細はサーバーが予約時の価格・数量1で計算し入力単価を使わないため、価格変更の指定が無ければ出さない。
 *      数量は「入力数量」として出し、確定した数量としては出さない。
 */
export function checkoutApprovalSummary(
  input: {
    items: { source?: string; name?: string; quantity?: number; unit_price?: number; price_override?: { price: number; reason: string } }[]
    manual_discount?: { amount: number; label: string }
  },
  server: ServerQuoteAmounts,
  requestHash: string,
  ctx: { customerName?: string | null },
): ApprovalSummary | null {
  if (server.requestHash !== requestHash || yenValue(server.subtotal) === null || yenValue(server.total) === null) return null
  const qty = (q: number | undefined) => ((q ?? 1) > 1 ? `・入力数量 ${q}` : '')
  const lines = clean([
    ...input.items.map((i, k): ApprovalDetail | null => {
      const name = i.name?.trim() || `明細${k + 1}`
      if (i.price_override) return { label: name, value: `価格変更 ${yen(i.price_override.price)}${i.source === 'reservation' ? '' : qty(i.quantity)}` }
      if (i.source === 'reservation' || i.unit_price === undefined) return null
      if (i.source === 'manual') return { label: `追加：${name}`, value: `入力単価 ${yen(i.unit_price)}${qty(i.quantity)}` }
      return { label: name, value: `入力単価 ${yen(i.unit_price)}${qty(i.quantity)}` }
    }),
    input.manual_discount && input.manual_discount.amount > 0
      ? { label: `値引き：${input.manual_discount.label}`, value: `−${yen(input.manual_discount.amount)}` }
      : null,
  ])
  return {
    operation: '会計の価格変更',
    amount: server.total,
    amountLabel: '会計の合計',
    details: clean([
      customer(ctx.customerName) ?? { label: '対象', value: '顧客の指定なし' },
      { label: '小計', value: yen(server.subtotal) },
    ]),
    changes: lines.length > 0 ? { title: CHECKOUT_REQUEST_TITLE, lines } : undefined,
  }
}
