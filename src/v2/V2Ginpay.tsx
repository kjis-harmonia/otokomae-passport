// 銀Pay のページ（ホームの銀Pay の帯から開く。銀Pay の入口はここだけ）：残高・使い方・利用履歴。
// 支払い・チャージは店頭で、会員QR をスタッフが読み取る（仕組みは今のまま）
import { useEffect, useState } from 'react'
import { ChevronLeft, QrCode } from 'lucide-react'
import { GINPAY_CUSTOMER_LABEL, getCustomerGinpayLedger, ginpayTxLabel, type GinpayLedger, yen } from '../utils/ginpayApi'
import { RpcError } from '../utils/staffSession'
import { auctionHeld, useGinpayHolds } from '../features/ginpay/holds'

const when = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))

export function V2Ginpay({ onBack, onShowQr }: { onBack: () => void; onShowQr: () => void }) {
  const [ledger, setLedger] = useState<GinpayLedger | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'signedOut' | 'error'>('loading')
  const holds = useGinpayHolds()
  // 予約の仮支払いと、銀オクの入札の押さえ（Staging だけ）を分けて出す
  const bidHeld = auctionHeld(holds)
  const reserveHeld = (holds?.held ?? 0) - bidHeld

  useEffect(() => {
    let alive = true
    getCustomerGinpayLedger(20)
      .then(l => { if (alive) { setLedger(l); setState('ok') } })
      .catch((err: unknown) => {
        if (!alive) return
        const signedOut = err instanceof RpcError && (err.code === 'customer_auth_required' || err.message.includes('customer_auth_required'))
        setState(signedOut ? 'signedOut' : 'error')
      })
    return () => { alive = false }
  }, [])

  const allSuspended = ledger !== null && ledger.accounts.length > 0 && ledger.accounts.every(account => account.status === 'suspended')

  return (
    <div className="v2-page">
      <button type="button" className="v2-back" onClick={onBack}><ChevronLeft size={18} />戻る</button>
      <h1 className="v2-title">銀Pay</h1>

      <section className="v2-panel v2-glass">
        <p className="v2-label">残高</p>
        <p className="v2-big" style={{ fontSize: 40, color: 'var(--v2-gold-deep)', fontVariantNumeric: 'tabular-nums' }}>
          {state === 'ok' && ledger ? yen(ledger.balance) : state === 'loading' ? '…' : '—'}
        </p>
        {holds && reserveHeld > 0 && <p className="v2-note" style={{ marginTop: 6 }}>うち予約の仮支払い {yen(reserveHeld)}。レジで会員QRを読むと確定し、キャンセルすると戻ります。</p>}
        {holds?.auction_holds?.map(h => <p key={h.auction_id} className="v2-note" style={{ marginTop: 6 }}>銀オクで入札中 {yen(h.amount)}（{h.title}）</p>)}
        {holds && holds.held > 0 && <p className="v2-note" style={{ marginTop: 6 }}>今使える額 {yen(holds.available)}</p>}
        {state === 'signedOut' && <p className="v2-note" style={{ marginTop: 6 }}>店頭で本人確認が済むと、残高が表示されます。</p>}
        {state === 'error' && <p className="v2-note" style={{ marginTop: 6 }}>表示できませんでした。通信を確認してください。</p>}
        {ledger && !ledger.consistent && <p className="v2-note" style={{ marginTop: 6, color: '#a3402f' }}>残高の確認が必要です。店舗へお声がけください。</p>}
        <p className="v2-note" style={{ margin: '14px 0 14px' }}>{allSuspended ? 'この銀Payは現在お使いいただけません。くわしくはお店にお問い合わせください。' : 'お支払い・チャージは店頭で。会員QR をスタッフにお見せください。'}</p>
        <button type="button" className="v2-btn v2-btn-gold" onClick={onShowQr}><QrCode size={18} />会員QR を表示する</button>
      </section>

      {state === 'ok' && ledger && (
        <section className="v2-panel v2-glass" style={{ marginTop: 14, padding: '14px 18px 4px' }} aria-label="利用履歴">
          <p className="v2-label">利用履歴</p>
          {ledger.transactions.length === 0
            ? <p className="v2-note" style={{ padding: '6px 0 12px' }}>まだありません</p>
            : ledger.transactions.slice(0, 12).map(tx => (
              <div key={tx.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid var(--v2-line)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 15 }}>{ginpayTxLabel(tx, GINPAY_CUSTOMER_LABEL)}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--v2-faint)', marginTop: 2 }}>{when(tx.created_at)}</span>
                </span>
                <span style={{ font: '700 16px/1 var(--v2-serif)', fontVariantNumeric: 'tabular-nums', color: tx.amount > 0 ? 'var(--v2-gold-deep)' : 'var(--v2-ink)' }}>
                  {/* +¥11,000 と −¥11,000 で書き方をそろえる（「¥-11,000」になっていた・11/9 点検） */}
                  {tx.amount > 0 ? '+' : tx.amount < 0 ? '−' : ''}{yen(Math.abs(tx.amount))}
                </span>
              </div>
            ))}
        </section>
      )}
    </div>
  )
}
