// 登録していない端末が PIN で入ろうとしたときの警告（10/28 慶一郎さん）。
// 店舗端末・銀二郎SB の両方で、画面全体を赤い砂嵐にする。侵入があるとロックがかかり、店舗端末・SB のすべての操作が止まる。
// 了解は「見た」の記録だけで、砂嵐は消えない。慶一郎さんの確認のあと、本部の「解除」で再開する
import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { callStaffRpc, deviceCode, deviceHint, STAFF_LOCKED_EVENT } from '../utils/staffSession'
import './securityAlert.css'

type Alert = { id: number; created_at: string; reason: 'pin_ok' | 'pin_fail'; app: 'staff' | 'sb' | null; hint: string | null; acked_at?: string | null; acked_by?: string | null }
type State = { locked: boolean; since?: string | null; alerts: Alert[] }

const POLL_MS = 20_000

function time(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 画面の隅に、この端末の番号（本部の端末一覧の番号と同じ）。どの端末を登録するか見分けるため */
export function DeviceTag() {
  const [code, setCode] = useState<string | null>(null)
  useEffect(() => { void deviceCode().then(setCode) }, [])
  return code ? <span className="device-tag">端末 {code}</span> : null
}

/** authed：ログイン中（侵入の中身まで出す）。PIN の画面ではロック中かどうかだけ */
export function SecurityAlert({ app, authed = true }: { app: 'staff' | 'sb'; authed?: boolean }) {
  const [state, setState] = useState<State>({ locked: false, alerts: [] })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        if (authed) {
          const r = await callStaffRpc<State>('staff_security_check', { p_app: app, p_hint: deviceHint() })
          if (alive) setState({ locked: !!r.locked, since: r.since, alerts: r.alerts ?? [] })
        } else {
          const { data } = await supabase.rpc('staff_lockdown_status')
          const r = data as { locked?: boolean; since?: string | null } | null
          if (alive && r) setState({ locked: !!r.locked, since: r.since, alerts: [] })
        }
      } catch { /* 仕組みが無い・通信切れ：次の見回りで */ }
    }
    void load()
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    const onMessage = (e: MessageEvent) => { if (e.data?.type === 'sb-intrusion') void load() }
    // どれかの操作が「ロック中」で断られたら、すぐ砂嵐を出す
    const onLocked = () => { void load() }
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    window.addEventListener(STAFF_LOCKED_EVENT, onLocked)
    return () => {
      alive = false
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
      window.removeEventListener(STAFF_LOCKED_EVENT, onLocked)
    }
  }, [app, authed])

  const unacked = state.alerts.filter(a => !a.acked_at)
  if (!state.locked && !unacked.length) return null
  const acked = state.alerts.find(a => a.acked_at)

  const ack = async () => {
    setBusy(true)
    try {
      await callStaffRpc('staff_ack_device_alerts', { p_ids: unacked.map(a => a.id) })
      const now = new Date().toISOString()
      setState(s => ({ ...s, alerts: s.alerts.map(a => a.acked_at ? a : { ...a, acked_at: now, acked_by: 'スタッフ' }) }))
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
        {state.locked && <p className="sec-alert-lock">安全のため、店舗端末と銀二郎SB のすべての機能を止めています{state.since ? `（${time(state.since)}から）` : ''}。<br />慶一郎の確認が終わると、本部から再開します。</p>}
        {state.alerts.length > 0 && (
          <ul className="sec-alert-list">
            {state.alerts.slice(-3).map(a => (
              <li key={a.id}>
                <span>{time(a.created_at)}</span>
                <span>{a.app === 'sb' ? '銀二郎SB' : '店舗端末'}{a.hint ? `・${a.hint}` : ''}</span>
                <b>{a.reason === 'pin_ok' ? 'PINは合っていました' : 'PINをまちがえました'}</b>
              </li>
            ))}
            {state.alerts.length > 3 && <li className="sec-alert-more">ほか {state.alerts.length - 3}件</li>}
          </ul>
        )}
        {authed && unacked.length > 0
          ? <button type="button" className="sec-alert-ok" onClick={() => void ack()} disabled={busy}>{busy ? '送っています…' : '了解'}</button>
          : acked && <p className="sec-alert-acked">了解済み（{acked.acked_by ?? 'スタッフ'}・{time(acked.acked_at!)}）。慶一郎の確認を待っています</p>}
      </div>
    </div>
  )
}
