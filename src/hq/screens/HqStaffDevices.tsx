// 本部の設定：店舗端末の2段階認証。承認した端末だけスタッフPINでログインできる（10/27 慶一郎さん）
//   知らない端末で PIN を入れると「承認待ち」としてここに出る。店の端末を承認してから「登録した端末だけ」をオンにする
import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { callHqRpc } from '../hqSession'
import { isHqPreview } from '../hqPreview'

interface Device { id: string; label: string | null; hint: string | null; created_at: string; last_seen_at: string; approved_at: string | null }
interface DeviceList { require_approval: boolean; devices: Device[] }

const when = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const ERRORS: Record<string, string> = {
  no_approved_device: '先に、お店で使う端末を1台以上承認してください（誰も入れなくなるため）。',
  not_found: 'この端末は見つかりませんでした。一覧を読み直してください。',
}

export function HqStaffDevices() {
  const [data, setData] = useState<DeviceList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    try { setData(await callHqRpc<DeviceList>('hq_staff_devices')); setError(null) }
    catch { setError('端末の一覧を読めませんでした。') }
  }, [])
  useEffect(() => { void load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect -- 読み込みが終わってから入れる

  async function run(fn: string, params: Record<string, unknown> | Record<string, unknown>[]) {
    setBusy(true); setError(null)
    try {
      for (const p of Array.isArray(params) ? params : [params]) {
        const r = await callHqRpc<{ ok?: boolean; error?: string }>(fn, p)
        if (r.error) { setError(ERRORS[r.error] ?? '変更できませんでした。'); break }
      }
      await load()
    } catch (err) {
      const code = (err as { code?: string })?.code ?? ''
      setError(ERRORS[code] ?? '変更できませんでした。')
    } finally { setBusy(false) }
  }

  const disabled = busy || isHqPreview() || !data
  // 承認待ち：種類が分かる端末（この仕組みのあとに PIN を入れた端末）は1台ずつ、以前の種類不明の端末はまとめて
  const pending = data?.devices.filter(d => !d.approved_at && d.hint) ?? []
  const unknown = data?.devices.filter(d => !d.approved_at && !d.hint) ?? []
  const approved = data?.devices.filter(d => d.approved_at) ?? []
  return (
    <section className="hq-surface" style={{ marginTop: 20 }}>
      <div className="hq-surface-header"><h2>店舗端末の承認（2段階認証）</h2></div>
      <div className="hq-setting-row">
        <div>
          <strong>登録した端末だけログインできる</strong>
          <p>オンにすると、ここで承認した端末だけがスタッフPINで入れます。PINが漏れても、知らない端末からは入れません。</p>
        </div>
        <button className={`hq-button${data?.require_approval ? ' hq-button-primary' : ''}`} disabled={disabled}
          onClick={() => void run('hq_set_staff_device_policy', { p_require: !data?.require_approval })}>
          <ShieldCheck size={14} />{data ? (data.require_approval ? 'オン（承認した端末だけ）' : 'オフ（どの端末でも入れる）') : '読み込み中…'}
        </button>
      </div>
      {error && <p className="hq-setting-row" role="alert" style={{ color: '#c0392b' }}>{error}</p>}
      {pending.length > 0 && <p className="hq-setting-row" style={{ fontWeight: 600 }}>承認待ち {pending.length} 台</p>}
      {pending.map(d => (
        <div className="hq-setting-row" key={d.id}>
          <div>
            <strong>{d.hint ?? '種類不明の端末'}</strong>
            <p>最後に使った日時 {when(d.last_seen_at)}（初めて {when(d.created_at)}）</p>
          </div>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={names[d.id] ?? ''} onChange={e => setNames(n => ({ ...n, [d.id]: e.target.value }))} placeholder="名前（例：お店のiPad）" aria-label="端末の名前" maxLength={40}
              style={{ height: 34, border: '1px solid #dddde3', borderRadius: 8, padding: '0 10px', fontSize: 12, width: 150 }} />
            <button className="hq-button hq-button-primary" disabled={disabled} onClick={() => void run('hq_approve_staff_device', { p_id: d.id, p_label: names[d.id] ?? '' })}>承認</button>
            <button className="hq-button hq-button-quiet" disabled={disabled} onClick={() => void run('hq_revoke_staff_device', { p_id: d.id })}>取り消し</button>
          </span>
        </div>
      ))}
      {unknown.length > 0 && (
        <details className="hq-setting-row" style={{ display: 'block' }}>
          <summary style={{ cursor: 'pointer' }}><strong>以前に PIN を入れた端末（種類不明） {unknown.length} 台</strong></summary>
          <p style={{ margin: '8px 0' }}>この仕組みの前に PIN を入れた端末です。お店の端末は、もう一度 PIN を入れると種類つきで上に出るので、そちらを承認してください。</p>
          <button className="hq-button" disabled={disabled} onClick={() => void run('hq_revoke_staff_device', unknown.map(d => ({ p_id: d.id })))}>{unknown.length} 台をまとめて取り消す</button>
        </details>
      )}
      {approved.length > 0 && <p className="hq-setting-row" style={{ fontWeight: 600 }}>承認済み {approved.length} 台</p>}
      {approved.map(d => (
        <div className="hq-setting-row" key={d.id}>
          <div>
            <strong>{d.label ?? d.hint ?? '名前なし'}</strong>
            <p>{d.label && d.hint ? `${d.hint}・` : ''}最後に使った日時 {when(d.last_seen_at)}</p>
          </div>
          <button className="hq-button hq-button-quiet" disabled={disabled} onClick={() => void run('hq_revoke_staff_device', { p_id: d.id })}>取り消し（ログインも切る）</button>
        </div>
      ))}
      {data && data.devices.length === 0 && <p className="hq-setting-row">まだ端末がありません。お店の端末でスタッフPINを入れると、ここに出ます。</p>}
    </section>
  )
}
