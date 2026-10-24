// ホームのいちばん上：銀Pay の残高。押すと会員QR（支払い・チャージはこの画面をスタッフに見せる）へ。
// まだ店頭で本人確認していない人には残高の代わりに「店頭で使えます」と出す（赤いエラーは出さない）
import { useEffect, useState } from 'react'
import { ChevronRight, Wallet } from 'lucide-react'
import { getCustomerGinpayLedger, yen } from '../utils/ginpayApi'

export function V2GinpayBar({ onOpen }: { onOpen: () => void }) {
  const [balance, setBalance] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const load = () => getCustomerGinpayLedger(1).then(l => { if (alive) setBalance(l.balance) }).catch(() => { if (alive) setBalance(null) })
    load()
    const reload = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', reload)
    return () => { alive = false; document.removeEventListener('visibilitychange', reload) }
  }, [])

  return (
    <button type="button" className="v2-pay v2-glass" onClick={onOpen} aria-label="銀Pay：支払い・チャージ（会員QRを開く）">
      <span className="v2-pay-icon" aria-hidden="true"><Wallet size={18} /></span>
      <span className="v2-pay-name">銀Pay</span>
      <span className={balance === null ? 'v2-pay-bal is-off' : 'v2-pay-bal'}>{balance === undefined ? '…' : balance === null ? '店頭でご利用いただけます' : yen(balance)}</span>
      <span className="v2-pay-go">支払う・チャージ<ChevronRight size={16} /></span>
    </button>
  )
}
