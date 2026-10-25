// V2.0 の次回予約：いつ・何を・誰に、を大きく。変更・キャンセルは AI予約（Johnny）、または電話。
// 予約がなければ「現在、ご予約はありません」と AI予約へ。メンテナンスの目安（前回の来店から14日）もここに出す。
// AI予約は投げた時点で「予約確定」（サロンボードへの転記はお店の仕事なので、お客様には見せない）。
import { useEffect, useState } from 'react'
import { CalendarClock, Phone, Scissors } from 'lucide-react'
import { formatVisit, useNextReservation } from '../features/johnny/nextReservation'
import { heldFor, useGinpayHolds } from '../features/ginpay/holds'
import { bookingAssistantApi } from '../features/johnny/bookingAssistantApi'
import { hasCustomerSession } from '../utils/customerSession'
import { getMaintenanceVisit, getDaysUntilRecommended, getNextRecommendedDate, fmtDate, MAINTENANCE_CYCLE_DAYS } from '../utils/maintenanceSchedule'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../data/wallet'

function useLastVisit(): string | null {
  const [last, setLast] = useState<string | null>(() => getMaintenanceVisit()?.lastVisitDate ?? null)
  useEffect(() => {
    if (!hasCustomerSession()) return
    let alive = true
    bookingAssistantApi().lastVisit().then(d => { if (alive && d) setLast(d) }).catch(() => { /* 端末の記録のまま */ })
    return () => { alive = false }
  }, [])
  return last
}

export function V2Next({ onJohnny }: { onJohnny: () => void }) {
  const next = useNextReservation()
  const prepaid = heldFor(useGinpayHolds(), next?.id)
  const visit = next ? formatVisit(next.starts_at) : null
  const last = useLastVisit()
  const days = last ? getDaysUntilRecommended(last) : null
  return (
    <div className="v2-page">
      <h1 className="v2-title">次回予約</h1>
      {next && visit ? (
        <section className="v2-panel v2-glass" aria-label="次のご予約">
          <p className="v2-label">{next.status === 'confirmed' ? 'ご予約確定' : 'ご来店中'}</p>
          <p className="v2-big">{visit.relative ? `${visit.relative}・` : ''}{visit.date}</p>
          <p className="v2-big" style={{ color: 'var(--v2-gold-deep)' }}>{visit.time}〜</p>
          <div style={{ marginTop: 14, display: 'grid', gap: 6, fontSize: 15 }}>
            <span>{next.items.map(i => i.name).join('・')}</span>
            <span style={{ color: 'var(--v2-sub)' }}>担当：{next.staff_name}</span>
            {prepaid != null && <span style={{ color: 'var(--v2-gold-deep)', fontWeight: 700 }}>✓ 銀Pay 仮支払い済み ¥{prepaid.toLocaleString()}<br /><small style={{ fontWeight: 400, color: 'var(--v2-sub)' }}>ご来店時にレジで会員QRを読むと、お支払いが確定します</small></span>}
          </div>
          {/* AI予約は受けた時点で確定。サロンボードへの転記はお店の仕事。重なったときだけお店から電話する（そのことを1行だけ） */}
          {next.status === 'confirmed' && <p className="v2-note" style={{ margin: '10px 0 0', fontSize: 12 }}>万一お時間の調整が必要なときは、お店からお電話します。</p>}
          <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
            <button type="button" className="v2-btn v2-btn-quiet v2-glass" onClick={onJohnny}>変更・キャンセル（AI予約）</button>
            <a className="v2-btn v2-btn-quiet v2-glass" href={SHOP_PHONE_TEL}><Phone size={18} />お店に電話する</a>
          </div>
        </section>
      ) : (
        <section className="v2-panel v2-glass" aria-label="次のご予約">
          <CalendarClock size={26} color="var(--v2-gold-deep)" />
          <p className="v2-big" style={{ fontSize: 22, marginTop: 10 }}>現在、ご予約はありません</p>
          <p className="v2-note" style={{ margin: '6px 0 16px' }}>日時と髪型を伝えるだけで、Johnny が予約します。</p>
          <button type="button" className="v2-btn v2-btn-gold" onClick={onJohnny}>AI予約する</button>
          <a href={SHOP_PHONE_TEL} style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--v2-sub)' }}>電話で予約する（{SHOP_PHONE_DISPLAY}）</a>
        </section>
      )}

      <section className="v2-panel v2-glass" style={{ marginTop: 14 }} aria-label="メンテナンスの目安">
        <p className="v2-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Scissors size={14} />メンテナンスの目安</p>
        {last && days !== null ? (
          <>
            <p style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
              {days > 0 ? `あと ${days} 日（${fmtDate(getNextRecommendedDate(last))} ごろ）` : days === 0 ? '今日が目安です' : `目安を ${-days} 日過ぎています`}
            </p>
            <p className="v2-note" style={{ margin: '4px 0 0' }}>前回のご来店 {fmtDate(last)}。{MAINTENANCE_CYCLE_DAYS}日以内のメンテナンスカットはお得な料金です。</p>
          </>
        ) : (
          <p className="v2-note" style={{ margin: 0 }}>ご来店のあと、次のメンテナンスの目安をここでお知らせします。</p>
        )}
      </section>
    </div>
  )
}
