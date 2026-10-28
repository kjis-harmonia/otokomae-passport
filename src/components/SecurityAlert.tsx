// 登録していない端末が PIN で入ろうとしたときの警告（10/28 慶一郎さん）。
// 店舗端末・銀二郎SB の両方で、登録済みの端末の画面全体を赤くして、誰かが「了解」を押すまで出し続ける（了解はすべての端末で共通）
import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { callStaffRpc, deviceHint } from '../utils/staffSession'
import './securityAlert.css'

type Alert = { id: number; created_at: string; reason: 'pin_ok' | 'pin_fail'; app: 'staff' | 'sb' | null; hint: string | null }

const POLL_MS = 20_000

function time(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function SecurityAlert({ app }: { app: 'staff' | 'sb' }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await callStaffRpc<{ alerts: Alert[] }>('staff_security_check', { p_app: app, p_hint: deviceHint() })
        if (alive) setAlerts(r.alerts ?? [])
      } catch { /* 仕組みが無い・通信切れ：次の見回りで */ }
    }
    void load()
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    const onMessage = (e: MessageEvent) => { if (e.data?.type === 'sb-intrusion') void load() }
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      alive = false
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [app])

  if (!alerts.length) return null

  const ack = async () => {
    setBusy(true)
    try {
      await callStaffRpc('staff_ack_device_alerts', { p_ids: alerts.map(a => a.id) })
      setAlerts([])
    } catch { /* 押し直してもらう */ }
    setBusy(false)
  }

  return (
    <div className="sec-alert" role="alertdialog" aria-modal="true" aria-labelledby="sec-alert-title">
      <div className="sec-alert-noise" aria-hidden="true" />
      <div className="sec-alert-scan" aria-hidden="true" />
      <div className="sec-alert-body">
        <p className="sec-alert-code">SECURITY ALERT</p>
        <ShieldAlert className="sec-alert-icon" size={72} strokeWidth={1.6} aria-hidden="true" />
        <h1 id="sec-alert-title">登録していない端末が<br />PINで入ろうとしました</h1>
        <p className="sec-alert-call">慶一郎まで急いで報告してください</p>
        <ul className="sec-alert-list">
          {alerts.slice(-3).map(a => (
            <li key={a.id}>
              <span>{time(a.created_at)}</span>
              <span>{a.app === 'sb' ? '銀二郎SB' : '店舗端末'}{a.hint ? `・${a.hint}` : ''}</span>
              <b>{a.reason === 'pin_ok' ? 'PINは合っていました' : 'PINを3回まちがえました'}</b>
            </li>
          ))}
          {alerts.length > 3 && <li className="sec-alert-more">ほか {alerts.length - 3}件</li>}
        </ul>
        <button type="button" className="sec-alert-ok" onClick={() => void ack()} disabled={busy}>{busy ? '送っています…' : '了解'}</button>
      </div>
    </div>
  )
}
