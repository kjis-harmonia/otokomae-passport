import { useState } from 'react'
import { ClientList } from '../../components/booking/ClientList'
import { C, SANS, linkStyle } from '../../components/booking/ledgerTheme'
import { hqCustomerApi } from '../../utils/customerApi'
import { hqGinpayApi } from '../../utils/ginpayApi'
import { HqCustomerKarteScreen } from './HqCustomerKarteScreen'

// 本部の顧客。顧客マスター（clients）の一覧・顧客台帳（店舗と同じ画面）。
// 旧「顧客カルテ」（App 会員だけ）は移行期間の参照用として残す。旧カルテで追加したメモも顧客のメモとして台帳に表示される。
export function HqClientsScreen() {
  const [legacy, setLegacy] = useState(false)
  if (legacy) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontFamily: SANS }}>
          <button type="button" onClick={() => setLegacy(false)} style={{ ...linkStyle, color: '#E8E2D4' }}>‹ 顧客一覧に戻る</button>
          <span style={{ fontSize: 13, color: '#9A9488' }}>旧・顧客カルテ（App会員のみ・移行期間の参照用）。顧客の確認・編集は顧客一覧で行ってください。</span>
        </div>
        <HqCustomerKarteScreen />
      </div>
    )
  }
  return (
    <div style={{ background: C.bg }}>
      <ClientList api={hqCustomerApi} ginpayApi={hqGinpayApi} ensureActor={() => true} />
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 16px 24px' }}>
        <button type="button" onClick={() => setLegacy(true)} style={{ ...linkStyle, fontSize: 13 }}>旧・顧客カルテ（App会員のみ）を開く</button>
      </div>
    </div>
  )
}
