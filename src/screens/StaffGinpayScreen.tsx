import { useCallback, useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { ChevronRight, QrCode, Search, X } from 'lucide-react'
import { GinpayPanel } from '../components/ginpay/GinpayPanel'
import { ActorSheet } from '../components/booking/ActorSheet'
import type { ClientListRow } from '../utils/customerApi'
import { callStaffRpc, rpcErrorMessage } from '../utils/staffSession'
import { parseQR } from './AdminScreen'
import { useStaffActor } from './staffActor'
import './staffTerminal.css'

// 銀Payチャージ：お客様を会員QRか名前・電話で探し、段階チャージ（現金）をする。
// 探す → チャージの2段だけ。チャージの中身（段階・確認・記録）は顧客台帳と同じ GinpayPanel。

type Picked = { clientId: string; name: string; last4: string | null }
const CAMERA_ID = 'st-ginpay-camera'

export function StaffGinpayScreen() {
  const a = useStaffActor()
  const [picked, setPicked] = useState<Picked | null>(null)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ClientListRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const scanner = useRef<Html5Qrcode | null>(null)
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

  const stopCamera = useCallback(async () => {
    const s = scanner.current
    scanner.current = null
    setScanning(false)
    if (s) { try { if (s.isScanning) await s.stop(); s.clear() } catch { /* already stopped */ } }
  }, [])
  useEffect(() => () => { void stopCamera() }, [stopCamera])

  async function scanned(text: string) {
    await stopCamera()
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

  async function startCamera() {
    setError(null)
    setScanning(true)
    // カメラの枠が描かれてから起動する
    await new Promise(r => requestAnimationFrame(r))
    try {
      const s = new Html5Qrcode(CAMERA_ID)
      scanner.current = s
      await s.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } }, text => { void scanned(text) }, undefined)
    } catch {
      await stopCamera()
      setError('カメラを使えません。名前か電話番号で探してください。')
    }
  }

  return (
    <div className="st-page">
      <div className="st-title-row">
        <h1>銀Pay チャージ</h1>
        <button type="button" className="st-link" onClick={() => a.setPicking(true)}>操作者 <strong>{a.actor || '未選択'}</strong></button>
      </div>

      {picked ? (
        <>
          <div className="st-customer">
            <span className="st-avatar" aria-hidden="true">{picked.name.slice(0, 1)}</span>
            <span className="st-customer-main"><strong>{picked.name} 様</strong>{picked.last4 && <small>電話 下4桁 {picked.last4}</small>}</span>
            <button type="button" className="st-link" onClick={() => { setPicked(null); setQuery(''); setRows(null) }}>別のお客様</button>
          </div>
          <div className="st-panel">
            <GinpayPanel key={picked.clientId} clientId={picked.clientId} api={a.ginpayApi} ensureActor={a.ensureActor} startCharging />
          </div>
        </>
      ) : (
        <>
          {scanning ? (
            <>
              <div className="st-camera"><div id={CAMERA_ID} /></div>
              <button type="button" className="st-secondary" onClick={() => void stopCamera()}><X size={18} />やめる</button>
            </>
          ) : (
            <button type="button" className="st-primary" onClick={() => void startCamera()}><QrCode size={22} />会員QRを読み取る</button>
          )}

          <p className="st-or">または</p>
          <label className="st-search">
            <Search size={18} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="名前・電話番号で探す" aria-label="名前・電話番号で探す" enterKeyHint="search" />
          </label>
          {rows && (rows.length === 0 ? <p className="st-empty">見つかりません</p> : (
            <div className="st-group st-results">
              {rows.map(r => (
                <button key={r.id} type="button" className="st-row" onClick={() => setPicked({ clientId: r.id, name: r.name, last4: r.phone_last4 })}>
                  <span className="st-row-main"><strong>{r.name}</strong><small>{[r.kana, r.phone_last4 ? `下4桁 ${r.phone_last4}` : null].filter(Boolean).join('・') || ' '}</small></span>
                  <ChevronRight size={20} />
                </button>
              ))}
            </div>
          ))}
        </>
      )}
      {error && <p className="st-error">{error}</p>}
      {a.picking && <ActorSheet api={a.bookingApi} actor={a.actor} onPick={a.choose} onClose={() => a.setPicking(false)} />}
    </div>
  )
}
