// スタッフ端末：予約のお客様の「お会計」（本当に受け取る金額）。来店チェックインのあとに出す。
//   料金：その日の予約の料金（DB）。プレミアムクーポン（GINJIRO CLASSICS など）の対象で使える時間なら、ふつうの料金 → 会員価格
//   券：お客様が JOHNNY の予約で選んでおいた券（会員 QR から選んだ状態になる）や、スタッフが選んだ券
//   メンテナンスカットは、クーポンは使えない
import type { TicketRow } from '../data/ticket'
import { TICKET_TYPE_LABELS } from '../data/ticket'
import { priceFor, yen } from '../utils/bookingCoupons'
import type { VisitInfo } from './VisitMenuPicker'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

export function CheckoutSummary({ info, selected }: { info: VisitInfo; selected: readonly TicketRow[] }) {
  if (!info.reservation_starts_at || !info.menu_code) return null
  if (info.menu_code === 'maintenance') {
    return (
      <div style={box}>
        <p style={eyebrow}>お会計</p>
        <p style={{ fontFamily: SERIF, fontSize: 13, color: '#1c1f1d' }}>メンテナンスカットのため、割引券・クーポンは使えません。</p>
      </div>
    )
  }
  const price = priceFor(info.menu_code, info.reservation_price ?? null, info.reservation_starts_at, selected)
  if (!price) return null
  const p = price.premium
  const row = (label: string, value: string, key?: string) => (
    <div key={key ?? label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 14, color: '#1c1f1d', marginTop: 6 }}>
      <span>{label}</span><span>{value}</span>
    </div>
  )
  return (
    <div style={box}>
      <p style={eyebrow}>お会計（予約から）</p>
      {row(`料金（${info.menu_name ?? 'ご予約のメニュー'}）`, yen(price.normal ?? price.base))}
      {p && price.normal != null && row(p.def.title, `−${yen(price.normal - price.base)}`)}
      {p && !p.eligible && <p style={{ fontSize: 11, color: '#6b716d', marginTop: 4 }}>{p.def.title} は土日祝 17:00〜19:00 開始のみ（この予約は対象外）</p>}
      {selected.map(t => row(TICKET_TYPE_LABELS[t.type], `−${yen(t.amount)}`, t.id))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(151,115,43,0.25)' }}>
        <span style={{ fontFamily: SERIF, fontSize: 14, color: '#1c1f1d' }}>お会計</span>
        <span style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: '#1c1f1d' }}>{yen(price.total)}</span>
      </div>
      {selected.length > 0 && <p style={{ fontSize: 11, color: '#6b716d', marginTop: 6 }}>券は下の「使用する」で使用済みにしてください</p>}
    </div>
  )
}

const box = { marginTop: 16, padding: '14px 16px', borderRadius: 14, textAlign: 'left' as const, background: '#f8f7f4', border: '1px solid rgba(151,115,43,0.28)' }
const eyebrow = { fontSize: 9, letterSpacing: '0.26em', color: '#97732b', marginBottom: 8 }
