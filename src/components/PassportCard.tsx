import { useState, useEffect } from 'react'
import { ReadableQr } from './ReadableQr'
import { getUserId } from '../utils/userId'
import { loadMemberStatus, getStoredValue, ONBOARDING_NAME_KEY } from '../utils/storage'
import { getCustomerByUserId, fetchLastVisitDateStrict } from '../utils/customerStore'
import type { CustomerRow } from '../utils/customerStore'
import {
  CURRENT_RESERVATION_CHANGED_EVENT, loadCurrentReservation, toCurrentReservationQrPayload,
} from '../utils/currentReservation'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

export function PassportCard() {
  const memberStatus = loadMemberStatus()
  const userId = getUserId()
  const memberName = getStoredValue<string>(ONBOARDING_NAME_KEY, memberStatus.memberName) || 'ゲスト'
  const [lastVisitDate, setLastVisitDate] = useState<string | null>(null)
  const [customerData, setCustomerData] = useState<CustomerRow | null | undefined>(undefined)
  const [currentReservation, setCurrentReservation] = useState(() => loadCurrentReservation())

  useEffect(() => {
    let alive = true
    fetchLastVisitDateStrict(userId).then(date => { if (alive) setLastVisitDate(date) }).catch(() => {
      const local = getStoredValue<Record<string, string>>('ginjiro_maintenance_visits', {})
      if (alive && local[userId]) setLastVisitDate(local[userId])
    })
    getCustomerByUserId(userId).then(customer => { if (alive) setCustomerData(customer ?? null) }).catch(() => {
      // Unknown is distinct from a confirmed missing member/recovery code.
      if (alive) setCustomerData(undefined)
    })
    return () => { alive = false }
  }, [userId])

  useEffect(() => {
    const refresh = () => setCurrentReservation(loadCurrentReservation())
    window.addEventListener(CURRENT_RESERVATION_CHANGED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener(CURRENT_RESERVATION_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // Keep the existing member ID and reservation protocol; no credentials enter this QR.
  const value = JSON.stringify({
    type: 'ginjiro-member', userId, name: memberName,
    reservation: toCurrentReservationQrPayload(currentReservation),
  })

  return (
    <div style={{ width: '100%', padding: '0 16px', boxSizing: 'border-box', color: '#202321' }}>
      <section aria-label="会員QR" style={{ background: '#fff', borderRadius: 20, padding: '24px 12px 20px', textAlign: 'center', border: '1px solid #e8e8e4' }}>
        <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, letterSpacing: '0.1em', margin: '0 0 6px' }}>銀二郎</p>
        <p style={{ color: '#676c68', fontSize: 14, margin: '0 0 18px', lineHeight: 1.6 }}>このQRを店舗端末にかざしてください</p>
        <ReadableQr value={value} />
        <p style={{ fontSize: 22, fontWeight: 600, margin: '20px 0 0', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          {memberName}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 6 }}>様</span>
        </p>
        <p style={{ fontSize: 12, color: '#767b77', letterSpacing: '0.08em', margin: '6px 0 0' }}>ID · {userId.slice(0, 8).toUpperCase()}</p>
      </section>

      <p style={{ textAlign: 'center', fontSize: 13, color: '#666d67', lineHeight: 1.7, margin: '16px 0 20px' }}>
        読みにくいときは画面を明るくして、<br />少し離してかざしてください。
      </p>

      {currentReservation && (
        <div style={{ borderTop: '1px solid #dedfd9', padding: '16px 4px', lineHeight: 1.65 }}>
          <p style={{ fontSize: 12, color: '#72776f', margin: '0 0 4px' }}>現在の予約</p>
          <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{currentReservation.title}</p>
          <p style={{ fontSize: 13, color: '#646b64', margin: '4px 0 0' }}>{currentReservation.menuLabel} · ¥{currentReservation.memberPrice.toLocaleString()}</p>
        </div>
      )}

      <details style={{ borderTop: '1px solid #dedfd9', fontSize: 14, lineHeight: 1.75 }}>
        <summary style={{ padding: '16px 4px', cursor: 'pointer', minHeight: 48, boxSizing: 'border-box', color: '#4f574f' }}>会員情報・機種変更時の復旧</summary>
        <div style={{ padding: '0 4px 20px' }}>
          {lastVisitDate && <p style={{ margin: '0 0 16px' }}>最終来店日{' '}{lastVisitDate.replaceAll('-', '/')}</p>}
          {customerData ? (
            <>
              <p style={{ fontSize: 13, color: '#646b64', margin: '0 0 8px' }}>機種変更・データ削除時は、スタッフにこちらのコードをお伝えください。</p>
              <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 20, fontWeight: 600, overflowWrap: 'anywhere', margin: '0 0 8px' }}>{customerData.recovery_code}</p>
              <p style={{ fontSize: 12, color: '#747a73', margin: 0 }}>スクリーンショットで保存しておくと安心です。</p>
            </>
          ) : (
            <p style={{ fontSize: 13, color: '#646b64', margin: 0 }}>{customerData === null ? '復旧コードは初回ご来店時にスタッフが登録します。' : '復旧情報を確認できません。必要なときは電波の良い場所で開き直してください。'}</p>
          )}
        </div>
      </details>
    </div>
  )
}
