// V2.0 の会員QR：来店したら開いて見せるだけ。QR の中身（会員ID・選んだ券・本人確認）は今の会員証（PassportCard）のまま。
// その下に銀Pay の残高（公開日から）、すべてのチケットへの入口。
import { ChevronRight, Ticket } from 'lucide-react'
import { PassportCard } from '../components/PassportCard'
import { CustomerGinpayCard } from '../components/ginpay/CustomerGinpayCard'

export function V2Qr({ onTickets }: { onTickets: () => void }) {
  return (
    <div className="v2-page">
      <h1 className="v2-title">会員QR</h1>
      <p className="v2-note" style={{ margin: '-8px 0 14px' }}>ご来店時に、この画面をスタッフにお見せください。</p>
      <div className="v2-pass"><PassportCard /><CustomerGinpayCard /></div>
      <div className="v2-panel v2-glass" style={{ marginTop: 16, padding: '4px 14px' }}>
        <button type="button" className="v2-row" onClick={onTickets}>
          <Ticket size={20} /><span style={{ flex: 1 }}>すべてのチケット<small>割引券・特典・プレゼント</small></span><ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
