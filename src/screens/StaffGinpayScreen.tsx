import { useEffect, useRef, useState } from 'react'
import { GinpayPanel } from '../components/ginpay/GinpayPanel'
import { ActorSheet } from '../components/booking/ActorSheet'
import { C, SANS, inputStyle, linkStyle } from '../components/booking/ledgerTheme'
import type { ClientListRow } from '../utils/customerApi'
import { callStaffRpc, rpcErrorMessage } from '../utils/staffSession'
import { parseQR, QrCameraScanner } from './AdminScreen'
import { useStaffActor } from './staffActor'

// 銀Payチャージ：お客様を会員QRか名前・電話で探し、段階チャージ（現金）をする。
// 探す → チャージの2段だけ。チャージの中身（段階・確認・記録）は顧客台帳と同じ GinpayPanel。

type Picked = { clientId: string; name: string; last4: string | null }

export function StaffGinpayScreen() {
  const a = useStaffActor()
  const [picked, setPicked] = useState<Picked | null>(null)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ClientListRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (!q) { setRows(null); return } // eslint-disable-line react-hooks/set-state-in-effect
    const my = ++seq.current
    const t = window.setTimeout(() => {
      a.customerApi.list(q, 'all', 0)
        .then(res => { if (my === seq.current) { setRows(res.rows.slice(0, 8)); setError(null) } })
        .catch(err => { if (my === seq.current) setError(rpcErrorMessage(err, 'お客様を探せませんでした。')) })
    }, 250)
    return () => window.clearTimeout(t)
  }, [query, a.customerApi])

  async function scanned(text: string) {
    const d = parseQR(text)
    const userId = d && 'userId' in d ? d.userId : null
    if (!userId) { setError('会員QRを読み取ってください。'); return }
    try {
      const res = await callStaffRpc<{ client_id: string; name: string; phone_last4: string | null }>('staff_client_for_member', { p_user_id: userId })
      setPicked({ clientId: res.client_id, name: res.name, last4: res.phone_last4 })
      setError(null)
    } catch (err) {
      setError(rpcErrorMessage(err, 'このQRのお客様が見つかりません。名前か電話番号で探してください。'))
    }
  }

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS, minHeight: 'calc(100dvh - 57px)', padding: '16px 16px 40px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>銀Pay チャージ</h1>
          <button type="button" onClick={() => a.setPicking(true)} style={linkStyle}>操作者 {a.actor || '未選択'}</button>
        </div>

        {picked ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, paddingBottom: 4 }}>
              <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
                {picked.name}<span style={{ fontSize: 14, fontWeight: 400, color: C.sub }}> 様{picked.last4 ? `（下4桁 ${picked.last4}）` : ''}</span>
              </p>
              <button type="button" onClick={() => { setPicked(null); setQuery(''); setRows(null) }} style={linkStyle}>別のお客様</button>
            </div>
            <GinpayPanel key={picked.clientId} clientId={picked.clientId} api={a.ginpayApi} ensureActor={a.ensureActor} startCharging />
          </>
        ) : (
          <>
            <QrCameraScanner
              elId="gj-qr-reader-ginpay"
              onScan={text => void scanned(text)}
              onCameraError={setError}
              boxHeight={240}
              placeholder={<p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>お客様の会員QRを読み取る</p>}
            />
            <label style={{ display: 'block', marginTop: 8, fontSize: 13, color: C.sub }}>
              名前・電話番号で探す
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="例：田中 / 0901234" style={{ ...inputStyle, marginTop: 6 }} />
            </label>
            {rows && (rows.length === 0 ? <p style={{ marginTop: 12, fontSize: 14, color: C.sub }}>見つかりません</p> : (
              <div style={{ marginTop: 8, borderTop: `1px solid ${C.line}` }}>
                {rows.map(r => (
                  <button key={r.id} type="button" onClick={() => setPicked({ clientId: r.id, name: r.name, last4: r.phone_last4 })} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, width: '100%', minHeight: 56,
                    padding: '8px 4px', background: 'transparent', border: 0, borderBottom: `1px solid ${C.line}`,
                    color: C.text, fontFamily: SANS, fontSize: 16, textAlign: 'left', cursor: 'pointer',
                  }}>
                    <span style={{ fontWeight: 600 }}>{r.name}{r.kana ? <small style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: C.sub }}>{r.kana}</small> : null}</span>
                    <span style={{ fontSize: 13, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{r.phone_last4 ? `下4桁 ${r.phone_last4}` : ''}</span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
        {error && <p style={{ marginTop: 12, fontSize: 14, color: C.danger, lineHeight: 1.6 }}>{error}</p>}
      </div>
      {a.picking && <ActorSheet api={a.bookingApi} actor={a.actor} onPick={a.choose} onClose={() => a.setPicking(false)} />}
    </div>
  )
}
