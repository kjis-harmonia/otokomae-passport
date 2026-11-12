// 銀オク（Staging だけ）の計算と言葉。画面とテスト（scripts/ginoku-auction.test.mjs）で使う。
// 正はサーバー（supabase/staging-only/20261112_ginoku.sql・_free_and_hold.sql）。ここは表示と入力の手助けだけ

/** 次に入札できる最低額（入札が無ければ開始価格、あれば現在価格＋刻み）。サーバーの ginoku_min_bid と同じ */
export function nextMinBid(current: number | null, start: number, increment: number): number {
  return current === null ? start : current + increment
}

/** 入札できる上限（即決価格があればその手前まで。それ以上は即決で） */
export function maxBid(buyNow: number | null, increment: number): number {
  return buyNow === null ? 1_000_000 : buyNow - increment
}

/** 入力の額を、最低額〜上限・刻みに収める（刻みは最低額から数える） */
export function clampBid(amount: number, min: number, buyNow: number | null, increment: number): number {
  const max = Math.max(min, maxBid(buyNow, increment))
  if (!Number.isFinite(amount) || amount <= min) return min
  const stepped = min + Math.round((amount - min) / increment) * increment
  return Math.min(Math.max(stepped, min), max)
}

/** 終了5分前からの入札は、終了を5分延ばす（サーバーの customer_ginoku_bid と同じ） */
export const EXTEND_MS = 5 * 60_000
export function extendedEnd(endsAt: number, bidAt: number): number {
  return endsAt - bidAt <= EXTEND_MS ? endsAt + EXTEND_MS : endsAt
}

/** 残り時間（「2日 3時間」「4時間 12分」「12分 05秒」）。終わっていれば null */
export function timeLeft(endsAt: number, now: number): string | null {
  const ms = endsAt - now
  if (ms <= 0) return null
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d > 0) return `${d}日 ${h}時間`
  if (h > 0) return `${h}時間 ${m}分`
  return `${m}分 ${String(sec).padStart(2, '0')}秒`
}

/** 終了の日時（「11月13日（金）20:58」・日本時間） */
export function endLabel(endsAt: number): string {
  const d = new Date(endsAt + 9 * 3600_000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${'日月火水木金土'[d.getUTCDay()]}）${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export type AuctionMine = 'leading' | 'outbid' | 'won' | 'lost' | null
export type AuctionStatus = 'open' | 'ending' | 'sold' | 'unsold' | 'cancelled'

/** 自分の状況の一言 */
export function mineLabel(mine: AuctionMine): string | null {
  switch (mine) {
    case 'leading': return '最高額で入札中です'
    case 'outbid': return 'より高い入札がありました'
    case 'won': return '落札しました'
    case 'lost': return '落札できませんでした'
    default: return null
  }
}

const ERRORS: Record<string, string> = {
  too_low: '最低入札額に届いていません。金額を確かめてください。',
  insufficient_balance: '銀Payの残高が足りません（入札・予約で押さえている分は使えません）。店頭でチャージできます。',
  use_buy_now: '即決価格以上は、即決でお申し込みください。',
  already_leading: 'いまは最高額で入札中です。',
  ended: 'このオークションは終了しました。',
  not_found: 'このオークションは見つかりませんでした。',
  no_buy_now: 'このオークションには即決価格がありません。',
  client_not_found: '店頭で本人確認が済むと、入札できます。',
  account_not_found: '銀Payをお使いいただくと、入札できます。店頭でお声がけください。',
  account_selection_required: '銀Payの口座の確認が必要です。店頭でお声がけください。',
  account_not_active: 'この銀Payは現在お使いいただけません。',
  held_funds: '押さえている分（入札・予約の仮支払い）は使えません。',
  customer_auth_required: '店頭で本人確認が済むと、入札できます。',
}

export function auctionErrorMessage(code: string): string {
  return ERRORS[code] ?? '処理できませんでした。通信を確かめて、もう一度お試しください。'
}

/** 銀オクで落札した「平日のみ」の券（発行は銀オク・メモに「平日のみ」）。土日・祝日の予約には使えない（11/12 慶一郎さん） */
export const isAuctionWeekdayTicket = (t: { issued_by?: string | null; memo?: string | null }) => t.issued_by === '銀オク' && !!t.memo?.includes('平日のみ')

/** 券の決まりの一行：無料券は「銀パラのお会計が無料・平日のみ・30日間有効」、割引券は「お会計から500円引き・平日のみ・30日間有効」 */
export function ticketRule(a: { free_menu?: string | null; ticket_amount: number | null; weekday_only: boolean; ticket_days: number }): string {
  const what = a.free_menu ? `${a.free_menu}のお会計が無料` : `お会計から${(a.ticket_amount ?? 0).toLocaleString('ja-JP')}円引き`
  return `${what}・${a.weekday_only ? '平日のみ' : '曜日を問わず'}・${a.ticket_days}日間有効`
}

/** 最高額のあいだの押さえの一言（「6,300 銀Payを押さえています。負けたら戻ります」） */
export const holdNote = (held: number) => `${held.toLocaleString('ja-JP')} 銀Payで入札中です。銀Payは落札したときに支払います（いまは減っていません）`
