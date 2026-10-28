// 本部の設定：店舗端末の2段階認証。承認した端末だけスタッフPINでログインできる（10/27 慶一郎さん）
//   知らない端末で PIN を入れると「承認待ち」としてここに出る。店の端末を承認してから「登録した端末だけ」をオンにする
//   10/28：種類ごとの台数の上限（店舗端末 2台・SB 6台）。登録していない端末が入ろうとした記録も出す
import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { callHqRpc } from '../hqSession'
import { isHqPreview } from '../hqPreview'

type App = 'staff' | 'sb'
interface Device { id: string; label: string | null; hint: string | null; app?: App | null; created_at: string; last_seen_at: string; approved_at: string | null }
interface Intrusion { id: number; created_at: string; reason: 'pin_ok' | 'pin_fail'; app: App | 'hq' | null; hint: string | null; acked_at: string | null; acked_by: string | null; ip?: string | null; user_agent?: string | null }
interface DeviceList { require_approval: boolean; devices: Device[]; limits?: Record<App, number>; alerts?: Intrusion[]; locked_at?: string | null }
const APP_NAME: Record<App, string> = { staff: '店舗端末', sb: '銀二郎SB' }
/** 端末の画面の右下に出る「端末 3F9A」と同じ番号 */
const code = (d: Device) => d.id.slice(0, 4).toUpperCase()

const when = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const ERRORS: Record<string, string> = {
  no_approved_device: '先に、お店で使う端末を1台以上承認してください（誰も入れなくなるため）。',
  not_found: 'この端末は見つかりませんでした。一覧を読み直してください。',
  limit_reached: '登録できる台数を超えます。先に、使っていない端末を取り消してください。',
  own_device: 'いま使っているこの端末は取り消せません。',
  own_device_not_approved: '先に、いま使っているこの端末（右下の「本部端末」の番号）を承認してください。',
}

export function HqStaffDevices() {
  const [data, setData] = useState<DeviceList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})
  const [confirmRelease, setConfirmRelease] = useState(false)
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
  const limits: Record<App, number> = data?.limits ?? { staff: 2, sb: 6 }
  const used = (app: App) => approved.filter(d => (d.app ?? 'staff') === app).length
  const full = (app: App) => used(app) >= limits[app]
  const approveButton = (d: Device, app: App, label: string) => (
    <button key={app} className="hq-button hq-button-primary" disabled={disabled || full(app)} title={full(app) ? `${APP_NAME[app]}は${limits[app]}台までです` : undefined}
      onClick={() => void run('hq_approve_staff_device', { p_id: d.id, p_label: names[d.id] ?? '', p_app: app })}>{label}</button>
  )
  return (
    <section className="hq-surface" style={{ marginTop: 20 }}>
      <div className="hq-surface-header"><h2>店舗端末・SB の登録（2段階認証）</h2></div>
      {data?.locked_at && (
        <div className="hq-setting-row" role="alert" style={{ flexWrap: 'wrap', gap: 10, background: '#fdecec', borderLeft: '4px solid #c0392b' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <strong style={{ color: '#c0392b' }}>ロック中（{when(data.locked_at)}から）：店舗端末・銀二郎SB を止めています</strong>
            <p>登録していない端末が PIN で入ろうとしました。下の記録を確かめ、必要なら PIN を変えてから解除してください。お客様のアプリは動いています。</p>
          </div>
          {confirmRelease
            ? <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button className="hq-button hq-button-primary" disabled={disabled} onClick={() => { setConfirmRelease(false); void run('hq_release_lockdown', {}) }}>確認した・解除する</button>
                <button className="hq-button hq-button-quiet" disabled={disabled} onClick={() => setConfirmRelease(false)}>やめる</button>
              </span>
            : <button className="hq-button" disabled={disabled} onClick={() => setConfirmRelease(true)}>ロックを解除する</button>}
        </div>
      )}
      <p className="hq-setting-row" style={{ fontWeight: 600 }}>
        登録済み：店舗端末 {used('staff')} / {limits.staff} 台・銀二郎SB {used('sb')} / {limits.sb} 台
      </p>
      <div className="hq-setting-row">
        <div>
          <strong>登録した端末だけログインできる</strong>
          <p>オンにすると、ここで承認した端末だけがスタッフPINで入れます。PINが漏れても、知らない端末からは入れません。各端末の画面の右下に出る「端末 ○○○○」の番号で見分けてください。</p>
        </div>
        <button className={`hq-button${data?.require_approval ? ' hq-button-primary' : ''}`} disabled={disabled}
          onClick={() => void run('hq_set_staff_device_policy', { p_require: !data?.require_approval })}>
          <ShieldCheck size={14} />{data ? (data.require_approval ? 'オン（承認した端末だけ）' : 'オフ（どの端末でも入れる）') : '読み込み中…'}
        </button>
      </div>
      {error && <p className="hq-setting-row" role="alert" style={{ color: '#c0392b' }}>{error}</p>}
      {pending.length > 0 && <p className="hq-setting-row" style={{ fontWeight: 600 }}>承認待ち {pending.length} 台</p>}
      {pending.map(d => (
        <div className="hq-setting-row" key={d.id} style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <strong>端末 {code(d)}・{d.app ? `${APP_NAME[d.app]}・` : ''}{d.hint ?? '種類不明の端末'}</strong>
            <p>最後に使った日時 {when(d.last_seen_at)}（初めて {when(d.created_at)}）</p>
          </div>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input value={names[d.id] ?? ''} onChange={e => setNames(n => ({ ...n, [d.id]: e.target.value }))} placeholder="名前（例：お店のiPad）" aria-label="端末の名前" maxLength={40}
              style={{ height: 34, border: '1px solid #dddde3', borderRadius: 8, padding: '0 10px', fontSize: 12, width: 150 }} />
            {d.app ? approveButton(d, d.app, full(d.app) ? `${APP_NAME[d.app]}は満杯` : '承認') : <>{approveButton(d, 'staff', full('staff') ? '店舗端末は満杯' : '店舗端末で承認')}{approveButton(d, 'sb', full('sb') ? 'SBは満杯' : 'SBで承認')}</>}
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
        <div className="hq-setting-row" key={d.id} style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <strong>端末 {code(d)}・{APP_NAME[d.app ?? 'staff']}・{d.label ?? d.hint ?? '名前なし'}</strong>
            <p>{d.label && d.hint ? `${d.hint}・` : ''}最後に使った日時 {when(d.last_seen_at)}</p>
          </div>
          <button className="hq-button hq-button-quiet" disabled={disabled} onClick={() => void run('hq_revoke_staff_device', { p_id: d.id })}>取り消し（ログインも切る）</button>
        </div>
      ))}
      {(data?.alerts?.length ?? 0) > 0 && <p className="hq-setting-row" style={{ fontWeight: 600, color: '#c0392b' }}>登録していない端末からの試み（30日）</p>}
      {data?.alerts?.map(a => (
        <div className="hq-setting-row" key={a.id}>
          <div>
            <strong style={{ color: '#c0392b' }}>{when(a.created_at)}・{a.reason === 'pin_ok' ? 'PINは合っていました（PINを変えてください）' : 'PINをまちがえました'}</strong>
            <p>{a.app ? `${a.app === 'hq' ? '本部' : APP_NAME[a.app]}・` : ''}{a.hint ?? '種類不明'}・{a.acked_at ? `了解：${when(a.acked_at)}（${a.acked_by ?? 'スタッフ'}）` : 'まだ誰も了解していません'}</p>
            {(a.ip || a.user_agent) && <p style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.ip ? `IP ${a.ip}` : ''}{a.ip && a.user_agent ? '・' : ''}{a.user_agent ?? ''}</p>}
          </div>
        </div>
      ))}
      {data && data.devices.length === 0 && <p className="hq-setting-row">まだ端末がありません。お店の端末でスタッフPINを入れると、ここに出ます。</p>}
    </section>
  )
}

// 本部の端末（10/28）：本部も登録した端末だけ。上限3台。いま使っている端末は取り消せない
interface HqDevice { id: string; label: string | null; hint: string | null; created_at: string; last_seen_at: string; approved_at: string | null; mine: boolean }
interface HqDeviceList { require_approval: boolean; limit: number; devices: HqDevice[] }

export function HqHqDevices() {
  const [data, setData] = useState<HqDeviceList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    try { setData(await callHqRpc<HqDeviceList>('hq_hq_devices')); setError(null) }
    catch { setError('本部の端末の一覧を読めませんでした。') }
  }, [])
  useEffect(() => { void load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect -- 読み込みが終わってから入れる

  async function run(fn: string, params: Record<string, unknown>) {
    setBusy(true); setError(null)
    try {
      const r = await callHqRpc<{ ok?: boolean; error?: string }>(fn, params)
      if (r.error) setError(ERRORS[r.error] ?? '変更できませんでした。')
      await load()
    } catch (err) {
      const code = (err as { code?: string })?.code ?? ''
      setError(ERRORS[code] ?? '変更できませんでした。')
    } finally { setBusy(false) }
  }

  const disabled = busy || isHqPreview() || !data
  const approved = data?.devices?.filter(d => d.approved_at) ?? []
  const pending = data?.devices?.filter(d => !d.approved_at) ?? []
  const full = approved.length >= (data?.limit ?? 3)
  const code = (d: HqDevice) => d.id.slice(0, 4).toUpperCase()
  return (
    <section className="hq-surface" style={{ marginTop: 20 }}>
      <div className="hq-surface-header"><h2>本部の端末</h2></div>
      <p className="hq-setting-row" style={{ fontWeight: 600 }}>登録済み：{approved.length} / {data?.limit ?? 3} 台</p>
      <div className="hq-setting-row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <strong>本部も登録した端末だけ</strong>
          <p>オンにすると、ここで承認した端末だけが本部に入れます。本部PINが漏れても、知らない端末からは入れません（入ろうとするとロック）。各端末の右下の「本部端末 ○○○○」で見分けてください。</p>
        </div>
        <button className={`hq-button${data?.require_approval ? ' hq-button-primary' : ''}`} disabled={disabled}
          onClick={() => void run('hq_set_hq_device_policy', { p_require: !data?.require_approval })}>
          <ShieldCheck size={14} />{data ? (data.require_approval ? 'オン（承認した端末だけ）' : 'オフ（どの端末でも入れる）') : '読み込み中…'}
        </button>
      </div>
      {error && <p className="hq-setting-row" role="alert" style={{ color: '#c0392b' }}>{error}</p>}
      {pending.map(d => (
        <div className="hq-setting-row" key={d.id} style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <strong>本部端末 {code(d)}・{d.hint ?? '種類不明の端末'}{d.mine ? '（この端末）' : ''}</strong>
            <p>最後に使った日時 {when(d.last_seen_at)}（初めて {when(d.created_at)}）</p>
          </div>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input value={names[d.id] ?? ''} onChange={e => setNames(n => ({ ...n, [d.id]: e.target.value }))} placeholder="名前（例：テイテイ iPhone）" aria-label="端末の名前" maxLength={40}
              style={{ height: 34, border: '1px solid #dddde3', borderRadius: 8, padding: '0 10px', fontSize: 12, width: 160 }} />
            <button className="hq-button hq-button-primary" disabled={disabled || full} onClick={() => void run('hq_approve_hq_device', { p_id: d.id, p_label: names[d.id] ?? '' })}>{full ? '満杯' : '承認'}</button>
            {!d.mine && <button className="hq-button hq-button-quiet" disabled={disabled} onClick={() => void run('hq_revoke_hq_device', { p_id: d.id })}>取り消し</button>}
          </span>
        </div>
      ))}
      {approved.map(d => (
        <div className="hq-setting-row" key={d.id} style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <strong>本部端末 {code(d)}・{d.label ?? d.hint ?? '名前なし'}{d.mine ? '（この端末）' : ''}</strong>
            <p>{d.label && d.hint ? `${d.hint}・` : ''}最後に使った日時 {when(d.last_seen_at)}</p>
          </div>
          {!d.mine && <button className="hq-button hq-button-quiet" disabled={disabled} onClick={() => void run('hq_revoke_hq_device', { p_id: d.id })}>取り消し（ログインも切る）</button>}
        </div>
      ))}
    </section>
  )
}
