// V2.0 の次回予約：いつ・何を・誰に、を大きく。変更・キャンセルは AI予約（Johnny）、または電話。
// 予約がなければ「現在、ご予約はありません」と AI予約へ。メンテナンスの目安（前回の来店から14日）もここに出す。
// AI予約は投げた時点で「予約確定」（サロンボードへの転記はお店の仕事なので、お客様には見せない）。
import { useEffect, useState } from 'react'
import { CalendarClock, Phone, Scissors } from 'lucide-react'
import { companionName, formatVisit, useNextVisit } from '../features/johnny/nextReservation'
import { heldFor, useGinpayHolds } from '../features/ginpay/holds'
import { requestJohnny } from '../features/johnny/bookingIntent'
import { ginFlow } from '../utils/env'
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

function ReservationRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <button type="button" className="v2-btn v2-btn-quiet v2-glass" onClick={onRetry}>再読み込み</button>
      <a href={SHOP_PHONE_TEL} style={{ display: 'block', textAlign: 'center', minHeight: 44, padding: '12px 0', marginTop: 2, fontSize: 13, color: 'var(--v2-sub)' }}>お店に電話で確認する（{SHOP_PHONE_DISPLAY}）</a>
    </>
  )
}

export function V2Next({ onJohnny }: { onJohnny: () => void }) {
  const { next, companions, status, reload } = useNextVisit()
  const holds = useGinpayHolds()
  const prepaid = heldFor(holds, next?.id)
  const visit = next ? formatVisit(next.starts_at) : null
  const last = useLastVisit()
  const days = last ? getDaysUntilRecommended(last) : null
  return (
    <div className="v2-page">
      <h1 className="v2-title">次回予約</h1>
      <div data-guide="next-panel">
      {next && visit ? (
        <section className="v2-panel v2-glass" aria-label="次のご予約">
          {status === 'failed' ? (
            <p className="v2-note">最新のご予約を確認できませんでした。前に確認した内容を表示しています。</p>
          ) : (
            <p className="v2-label">{status === 'loading' ? 'ご予約' : next.status === 'confirmed' ? 'ご予約確定' : 'ご来店中'}</p>
          )}
          <p className="v2-big">{visit.relative ? `${visit.relative}・` : ''}{visit.date}</p>
          <p className="v2-big" style={{ color: 'var(--v2-gold-deep)' }}>{visit.time}〜</p>
          <div style={{ marginTop: 14, display: 'grid', gap: 6, fontSize: 15 }}>
            <span>{next.items.map(i => i.name).join('・')}</span>
            <span style={{ color: 'var(--v2-sub)' }}>担当：{next.staff_name}</span>
            {prepaid != null && <span style={{ color: 'var(--v2-gold-deep)', fontWeight: 700 }}>✓ 銀Pay 仮支払い済み ¥{prepaid.toLocaleString()}<br /><small style={{ fontWeight: 400, color: 'var(--v2-sub)' }}>ご来店時にレジで会員QRを読むと、お支払いが確定します</small></span>}
          </div>
          {/* お連れ様の予約（同じ日のほかの予約・10/30 慶一郎さん） */}
          {companions.map(c => {
            const paid = heldFor(holds, c.id)
            return (
              <div key={c.id} style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--v2-line)', display: 'grid', gap: 4, fontSize: 15 }}>
                <span className="v2-label" style={{ margin: 0 }}>{companionName(c) ? `お連れ様（${companionName(c)}様）` : 'お連れ様'}</span>
                <span><b style={{ color: 'var(--v2-gold-deep)' }}>{formatVisit(c.starts_at).time}〜</b>{' '}{c.items.map(i => i.name).join('・')}</span>
                <span style={{ color: 'var(--v2-sub)' }}>担当：{c.staff_name}</span>
                {paid != null && <span style={{ color: 'var(--v2-gold-deep)', fontWeight: 700 }}>✓ 銀Pay 仮支払い済み ¥{paid.toLocaleString()}</span>}
              </div>
            )
          })}
          {/* AI予約は受けた時点で確定。サロンボードへの転記はお店の仕事。重なったときだけお店から電話する（そのことを1行だけ） */}
          {next.status === 'confirmed' && <p className="v2-note" style={{ margin: '10px 0 0', fontSize: 12 }}>万一お時間の調整が必要なときは、<br />お店からお電話します。</p>}
          <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
            {status === 'failed' && <ReservationRetry onRetry={reload} />}
            <button type="button" className="v2-btn v2-btn-quiet v2-glass" data-guide="next-change" onClick={() => { if (ginFlow()) { window.dispatchEvent(new Event('ginjiro:gin-change')); return } requestJohnny({ menuCode: null, label: '', manage: true }); onJohnny() }}>{ginFlow() ? '変更・キャンセル' : '変更・キャンセル（AI予約）'}</button>
            {status !== 'failed' && <a className="v2-btn v2-btn-quiet v2-glass" href={SHOP_PHONE_TEL}><Phone size={18} />お店に電話する</a>}
          </div>
        </section>
      ) : status === 'loading' ? (
        <section className="v2-panel v2-glass" aria-label="次のご予約" aria-busy="true">
          <p className="v2-note" style={{ margin: 0 }}>ご予約を確認しています…</p>
        </section>
      ) : status === 'failed' ? (
        // 確認できなかったときに「ご予約はありません」と言い切らない（10/30 監査 R3）
        <section className="v2-panel v2-glass" aria-label="次のご予約">
          <CalendarClock size={26} color="var(--v2-gold-deep)" />
          <p className="v2-big" style={{ fontSize: 20, marginTop: 10 }}>ご予約を確認できませんでした</p>
          <p className="v2-note" style={{ margin: '6px 0 16px' }}>電波のよい所で、もう一度お試しください。</p>
          <ReservationRetry onRetry={reload} />
        </section>
      ) : (
        <section className="v2-panel v2-glass" aria-label="次のご予約">
          <CalendarClock size={26} color="var(--v2-gold-deep)" />
          <p className="v2-big" style={{ fontSize: 22, marginTop: 10 }}>現在、ご予約はありません</p>
          <p className="v2-note" style={{ margin: '6px 0 16px' }}>日時と髪型を伝えるだけで、AI が予約します。</p>
          {/* Staging：AI予約は銀ちゃんの会話（11/9 慶一郎さん「バイクの Johnny は古い」）。本番は承認のあと */}
          <button type="button" className="v2-btn v2-btn-gold" onClick={() => {
            if (ginFlow()) { window.dispatchEvent(new CustomEvent('ginjiro:gin-book', { detail: { menuCode: null, label: '' } })); return }
            onJohnny()
          }}>AI予約する</button>
          <a href={SHOP_PHONE_TEL} style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--v2-sub)' }}>電話で予約する（{SHOP_PHONE_DISPLAY}）</a>
        </section>
      )}
      </div>

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
