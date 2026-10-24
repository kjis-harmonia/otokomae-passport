// V2.0 の「ログインと引き継ぎ」：Face ID などの設定・機種変更、以前のチケットの引き継ぎ（店頭の6桁コード）。
// 仕組みは今のまま（CustomerAccessSettings・PreviousTicketsBindDialog）。入口だけ ☰ にまとめる。
import { useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { CustomerAccessSettings } from '../features/customerAccess/CustomerAccess'
import { PreviousTicketsBindDialog } from '../components/PreviousTicketsBind'

export function V2Account({ onBack }: { onBack: () => void }) {
  const [binding, setBinding] = useState(false)
  return (
    <div className="v2-page">
      <button type="button" className="v2-back" onClick={onBack}><ChevronLeft size={18} />戻る</button>
      <h1 className="v2-title">ログインと引き継ぎ</h1>
      <section className="v2-panel v2-glass v2-account">
        <CustomerAccessSettings />
      </section>
      <section className="v2-panel v2-glass" style={{ marginTop: 14 }}>
        <p className="v2-label">以前のチケットを引き継ぐ</p>
        <p className="v2-note" style={{ margin: '0 0 12px' }}>以前の端末のチケットを移すときは、店頭でスタッフから6桁のコードを受け取って入力してください。</p>
        <button type="button" className="v2-btn v2-btn-quiet v2-glass" onClick={() => setBinding(true)}>6桁のコードを入力する</button>
      </section>
      {binding && <PreviousTicketsBindDialog onClose={() => setBinding(false)} onBound={() => setBinding(false)} zIndex={70} />}
    </div>
  )
}
