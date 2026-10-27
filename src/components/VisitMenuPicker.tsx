// スタッフ端末：来店チェックインのあとに「今日のメニュー」を記録する（JOHNNY の「いつもの」に使う）。
//   その日の予約があればメニューは自動で入っている（変えるときだけ押す）。無ければ1つ押す。
//   候補：このお客様の最近のメニュー → よく出るメニュー → その他（一覧）。保存は staff_set_visit_menu。
import { useEffect, useState } from 'react'
import { callStaffRpc, rpcErrorMessage } from '../utils/staffSession'

export interface VisitInfo {
  menu_code: string | null
  menu_name: string | null
  menu_source: 'reservation' | 'staff' | null
  recent: { visit_date: string; menu_code: string | null; menu_name: string | null }[]
  /** その日の予約の開始時刻と料金（予約があるとき） */
  reservation_starts_at?: string | null
  reservation_price?: number | null
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
/** 'maintenance' はメンテナンスカット（アプリのメニューには無い。ホットペッパーのクーポン） */
const COMMON = ['maintenance', 'cut-regular', 'cut-skin-fade', 'perm-punch', 'perm-nurepan']

export function VisitMenuPicker({ userId, info, staffName }: { userId: string; info: VisitInfo; staffName: string }) {
  const [current, setCurrent] = useState<{ code: string; name: string; source: 'reservation' | 'staff' } | null>(
    info.menu_code && info.menu_name ? { code: info.menu_code, name: info.menu_name, source: info.menu_source ?? 'staff' } : null)
  const [editing, setEditing] = useState(!current)
  const [menus, setMenus] = useState<{ code: string; name: string }[] | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing || menus) return
    callStaffRpc<{ menus: { code: string; name: string }[] }>('staff_booking_options', {})
      .then(o => setMenus(o.menus ?? []))
      .catch(() => setMenus([]))
  }, [editing, menus])

  const save = async (code: string) => {
    setSaving(code)
    setError(null)
    try {
      const r = await callStaffRpc<{ menu_code?: string; menu_name?: string; error?: string }>('staff_set_visit_menu', { p_user_id: userId, p_menu_code: code, p_staff_name: staffName || null })
      if (r.error || !r.menu_code || !r.menu_name) throw new Error(r.error ?? 'failed')
      setCurrent({ code: r.menu_code, name: r.menu_name, source: 'staff' })
      setEditing(false)
    } catch (err) {
      setError(rpcErrorMessage(err, 'メニューを記録できませんでした。もう一度押してください。'))
    } finally {
      setSaving(null)
    }
  }

  // 候補：最近のメニュー（重複なし）→ よく出るメニュー
  const nameOf = (code: string) => (code === 'maintenance' ? 'メンテナンスカット' : menus?.find(m => m.code === code)?.name ?? info.recent.find(v => v.menu_code === code)?.menu_name ?? null)
  const recentCodes = [...new Set(info.recent.map(v => v.menu_code).filter((c): c is string => !!c && c !== 'hotpepper'))]
  const quick = [...new Set(['maintenance', ...recentCodes, ...COMMON])].filter(c => nameOf(c)).slice(0, 6)

  const chip = (code: string, label: string) => (
    <button key={code} type="button" disabled={!!saving} onClick={() => save(code)} style={{
      padding: '10px 14px', borderRadius: 12, border: '1px solid rgba(151,115,43,0.45)',
      background: current?.code === code ? 'rgba(151,115,43,0.22)' : '#f3f1ed', color: '#1c1f1d',
      fontFamily: SERIF, fontSize: 14, cursor: saving ? 'default' : 'pointer', opacity: saving && saving !== code ? 0.5 : 1,
    }}>
      {saving === code ? '記録中…' : label}
    </button>
  )

  return (
    <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 14, textAlign: 'left', background: '#f8f7f4', border: '1px solid rgba(151,115,43,0.28)' }}>
      {/* 予約があれば「ご予約のメニュー」（10/28 慶一郎さん）。予約なしのときだけ選んでもらう */}
      <p style={{ fontSize: 9, letterSpacing: '0.26em', color: '#97732b', marginBottom: 8 }}>{current?.source === 'reservation' && !editing ? 'ご予約のメニュー' : '今日のメニュー'}</p>
      {current && !editing ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#1c1f1d' }}>{current.name}</p>
            <p style={{ fontSize: 11, color: '#6b716d', marginTop: 2 }}>{current.source === 'reservation' ? 'ご予約のメニューです（予約から自動で記録）' : '記録しました'}</p>
          </div>
          <button type="button" onClick={() => setEditing(true)} style={{
            padding: '8px 12px', borderRadius: 10, border: '1px solid rgba(151,115,43,0.45)', background: 'transparent',
            color: '#97732b', fontSize: 13, cursor: 'pointer',
          }}>変える</button>
        </div>
      ) : (
        <>
          <p style={{ fontFamily: SERIF, fontSize: 13, color: '#1c1f1d', marginBottom: 10 }}>今日のメニューを1つ選んでください</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {quick.map(c => chip(c, nameOf(c) ?? c))}
          </div>
          {menus && menus.length > 0 && (
            <select
              value=""
              disabled={!!saving}
              onChange={e => { if (e.target.value) void save(e.target.value) }}
              aria-label="ほかのメニュー"
              style={{ marginTop: 10, width: '100%', padding: '11px 12px', borderRadius: 12, background: '#f8f7f4', color: '#1c1f1d', border: '1px solid rgba(151,115,43,0.35)', fontSize: 14 }}
            >
              <option value="">ほかのメニュー…</option>
              {menus.map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
            </select>
          )}
          {current && <button type="button" onClick={() => setEditing(false)} style={{ marginTop: 10, background: 'none', border: 'none', color: '#6b716d', fontSize: 12, cursor: 'pointer' }}>変えない（{current.name}のまま）</button>}
        </>
      )}
      {error && <p style={{ fontSize: 12, color: '#b23a3a', marginTop: 8 }}>{error}</p>}
    </div>
  )
}
