// 店舗端末：会員QR を読んだら、その会員の今日のご予約（ご本人・お連れ様）を確かめて受付する（11/8 慶一郎さん）
//   「3名様でご予約を承っています。3名様ともご来店されていますか？」【はい】【いいえ】
//   はい＝全員を受付。いいえ＝実際に来た方だけ選んで受付。来ていない方は受付しない
//   お連れ様だけのご予約（お父さんだけ）も、ここでその方の予約を受付する
import { useState } from 'react'
import { callStaffRpc, RpcError } from '../utils/staffSession'
import type { PartyEntry } from '../utils/partyCheckIn'


const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const INK = '#1c1f1d'
const GOLD = '#97732b'

const time = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
const label = (p: PartyEntry) => (p.is_owner ? `${p.name}様（ご本人）` : `${p.name}様（お連れ様）`)

export function PartyCheckIn({ userId, party, staffName, onDone }: {
  userId: string
  party: PartyEntry[]
  staffName: string
  /** 閉じる。受付したら新しい一覧 */
  onDone: (party: PartyEntry[] | null) => void
}) {
  const waiting = party.filter(p => p.status === 'confirmed')
  const [mode, setMode] = useState<'ask' | 'choose'>('ask')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = party.length

  const checkIn = async (ids: string[]) => {
    if (!ids.length) return
    setBusy(true); setError(null)
    try {
      const r = await callStaffRpc<{ ok: boolean; party: PartyEntry[] }>('staff_check_in_party', { p_user_id: userId, p_reservation_ids: ids, p_staff_name: staffName || '店舗端末' })
      onDone(Array.isArray(r.party) ? r.party : null)
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      setError(code === 'reservation_mismatch' ? 'このお客様の今日のご予約ではありません。読み取り直してください。'
        : code === 'invalid_status' ? 'キャンセル・済みのご予約が含まれています。予約表でお確かめください。'
        : '受付できませんでした。通信を確かめて、もう一度押してください。')
      setBusy(false)
    }
  }

  const btn = (primary: boolean): React.CSSProperties => ({
    flex: 1, minHeight: 56, borderRadius: 14, fontSize: 17, fontWeight: 700, cursor: 'pointer',
    border: primary ? 'none' : `1px solid rgba(151,115,43,0.35)`, background: primary ? INK : '#fff', color: primary ? '#fff' : INK,
  })
  const question = n >= 2
    ? `${n}名様でご予約を承っています。${n}名様ともご来店されていますか？`
    : `${party[0]?.name ?? 'お連れ様'}様のご予約を承っています。ご来店されていますか？`

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 450, background: 'rgba(28,31,29,0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px' }}>
      <div role="dialog" aria-modal="true" aria-label="ご予約の受付" data-guide="party-checkin" data-step={mode} style={{ width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto', borderRadius: 24, background: '#fff', border: '1px solid rgba(151,115,43,0.32)', boxShadow: '0 32px 80px rgba(28,31,29,0.42)', padding: '26px 24px 22px', color: INK }}>
        <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1.5, margin: 0 }}>
          {mode === 'ask' ? question : 'ご来店された方を選んでください'}
        </p>
        <div style={{ marginTop: 16, borderTop: '1px solid rgba(151,115,43,0.15)' }}>
          {party.map(p => {
            const done = p.status !== 'confirmed'
            const on = picked.includes(p.id)
            const row = (
              <>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{label(p)}</span>
                  <span style={{ display: 'block', fontSize: 13, color: 'rgba(28,31,29,0.62)', marginTop: 2 }}>
                    {[`${time(p.starts_at)}〜`, p.menu, p.staff_name ? `担当 ${p.staff_name}` : null].filter(Boolean).join(' / ')}
                  </span>
                </span>
                {done ? <span style={{ fontSize: 13, color: GOLD, fontWeight: 700 }}>受付済み</span>
                  : mode === 'choose' && <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 8, border: `2px solid ${on ? INK : 'rgba(28,31,29,0.3)'}`, background: on ? INK : '#fff', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 16 }}>{on ? '✓' : ''}</span>}
              </>
            )
            const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 64, padding: '10px 2px', background: 'none', border: 'none', borderBottom: '1px solid rgba(151,115,43,0.15)', textAlign: 'left', color: INK }
            return mode === 'choose' && !done
              ? <button key={p.id} type="button" role="checkbox" aria-checked={on} style={{ ...rowStyle, cursor: 'pointer' }} onClick={() => setPicked(x => (on ? x.filter(i => i !== p.id) : [...x, p.id]))}>{row}</button>
              : <div key={p.id} style={rowStyle}>{row}</div>
          })}
        </div>
        {error && <p role="alert" style={{ margin: '12px 0 0', fontSize: 14, color: '#B03A2E' }}>{error}</p>}
        {mode === 'ask' ? (
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button type="button" data-guide="party-no" style={btn(false)} disabled={busy} onClick={() => { setMode('choose'); setPicked([]); setError(null) }}>いいえ</button>
            <button type="button" data-guide="party-yes" style={btn(true)} disabled={busy} onClick={() => void checkIn(waiting.map(p => p.id))}>{busy ? '受付しています…' : 'はい'}</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button type="button" style={btn(false)} disabled={busy} onClick={() => onDone(null)}>今は受付しない</button>
            <button type="button" data-guide="party-submit" style={{ ...btn(true), opacity: picked.length ? 1 : 0.4 }} disabled={busy || !picked.length} onClick={() => void checkIn(picked)}>
              {busy ? '受付しています…' : picked.length ? `${picked.length}名様を受付` : '受付'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
