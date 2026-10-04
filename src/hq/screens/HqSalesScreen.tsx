import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { getJapanDateString } from '../../utils/dateUtils'
import { rpcErrorMessage } from '../../utils/staffSession'
import { yen } from '../../utils/bookingApi'
import { fetchHqSessionItems, fetchHqSessions, type HqSessionItemRow, type HqSessionRow } from '../hqDataStore'
import type { HqNavigate, HqSalesPreset } from '../hqMockData'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

interface SalesState {
  loading: boolean
  error: string | null
  sessions: HqSessionRow[]
  items: HqSessionItemRow[]
}

interface MenuRow {
  name: string
  count: number
}

interface StaffRow {
  name: string
  sales: number
  count: number
}

function addDays(ymd: string, days: number): string {
  const [year, month, date] = ymd.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, date + days))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`
}

function nextMonthStart(ymd: string): string {
  const [year, month] = ymd.split('-').map(Number)
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  return `${next.year}-${String(next.month).padStart(2, '0')}-01`
}

function labelForPreset(preset: HqSalesPreset): string {
  if (preset === 'today') return '今日'
  if (preset === 'month') return '今月'
  return '任意期間'
}

export function HqSalesScreen({ initialPreset = 'today', onNavigate }: { initialPreset?: HqSalesPreset; onNavigate?: HqNavigate }) {
  const today = getJapanDateString()
  const [preset, setPreset] = useState<HqSalesPreset>(initialPreset)
  const [customFrom, setCustomFrom] = useState(today)
  const [customTo, setCustomTo] = useState(today)
  const range = useMemo(() => {
    if (preset === 'today') return { from: today, to: addDays(today, 1) }
    if (preset === 'month') return { from: monthStart(today), to: nextMonthStart(today) }
    return { from: customFrom, to: addDays(customTo, 1) }
  }, [customFrom, customTo, preset, today])

  const [state, setState] = useState<SalesState>({ loading: true, error: null, sessions: [], items: [] })

  const load = useCallback(async () => {
    try {
      const sessions = await fetchHqSessions({ fromJst: range.from, toJst: range.to })
      const items = await fetchHqSessionItems(sessions.map((s) => s.id))
      setState({ loading: false, error: null, sessions, items })
    } catch (err) {
      setState({ loading: false, error: rpcErrorMessage(err), sessions: [], items: [] })
    }
  }, [range.from, range.to])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setState((s) => ({ ...s, loading: true }))
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const totalSales = state.sessions.reduce((sum, s) => sum + (s.total ?? 0), 0)
  const checkoutCount = state.sessions.length
  const unitPrice = checkoutCount > 0 ? Math.round(totalSales / checkoutCount) : 0
  const menuRows = useMemo(() => buildMenuRows(state.items), [state.items])
  const staffRows = useMemo(() => buildStaffRows(state.sessions), [state.sessions])

  return (
    <div style={{ display: 'grid', gap: 18, fontFamily: HQ_SANS, color: HQ_COLORS.textPrimary }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.2, letterSpacing: 0 }}>売上分析</h1>
          <p style={{ margin: '8px 0 0', color: HQ_COLORS.textSecondary, fontSize: 14 }}>
            completed会計を本部RPC経由で集計します。UI側では存在しない売上を補完しません。
          </p>
        </div>
        {onNavigate && (
          <button type="button" onClick={() => onNavigate('register')} style={outlineButtonStyle}>
            会計履歴を見る
          </button>
        )}
      </header>

      <section style={sectionStyle}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['today', 'month', 'custom'] as HqSalesPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(p)}
              style={{
                ...segmentStyle,
                background: preset === p ? '#EAF1FF' : '#FFFFFF',
                borderColor: preset === p ? '#BCD3FF' : HQ_COLORS.panelBorder,
                color: preset === p ? HQ_COLORS.goldHi : HQ_COLORS.textSecondary,
              }}
            >
              {labelForPreset(p)}
            </button>
          ))}
          {preset === 'custom' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={dateInputStyle} aria-label="開始日" />
              <span style={{ color: HQ_COLORS.textMute }}>〜</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={dateInputStyle} aria-label="終了日" />
            </span>
          )}
        </div>
      </section>

      {state.error && (
        <div style={{ ...sectionStyle, color: HQ_COLORS.negative, background: '#FFF7ED' }}>
          売上データを取得できませんでした。{state.error}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <Kpi label="売上" value={state.loading ? '—' : yen(totalSales)} />
        <Kpi label="会計件数" value={state.loading ? '—' : `${checkoutCount}件`} />
        <Kpi label="客単価" value={state.loading ? '—' : yen(unitPrice)} />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, alignItems: 'start' }}>
        <div style={sectionStyle}>
          <h2 style={titleStyle}>メニュー別売上</h2>
          <p style={noteStyle}>既存RPCは明細金額を返さないため、売上列は—、件数のみ実データです。</p>
          <DataTable columns={['メニュー', '件数', '売上']}>
            {menuRows.length === 0 ? (
              <EmptyRow colSpan={3} loading={state.loading} />
            ) : menuRows.map((row) => (
              <tr key={row.name} style={trStyle}>
                <td style={tdStyle}>{row.name}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: HQ_MONO }}>{row.count}</td>
                <td style={{ ...tdStyle, textAlign: 'right', color: HQ_COLORS.textMute }}>—</td>
              </tr>
            ))}
          </DataTable>
        </div>

        <div style={sectionStyle}>
          <h2 style={titleStyle}>担当者別売上</h2>
          <p style={noteStyle}>会計セッションのstylist_name / staff_nameとtotalを集計しています。</p>
          <DataTable columns={['担当', '件数', '売上']}>
            {staffRows.length === 0 ? (
              <EmptyRow colSpan={3} loading={state.loading} />
            ) : staffRows.map((row) => (
              <tr key={row.name} style={trStyle}>
                <td style={tdStyle}>{row.name}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: HQ_MONO }}>{row.count}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: HQ_MONO }}>{yen(row.sales)}</td>
              </tr>
            ))}
          </DataTable>
        </div>
      </section>
    </div>
  )
}

function buildMenuRows(items: HqSessionItemRow[]): MenuRow[] {
  const map = new Map<string, number>()
  for (const item of items) {
    if (item.category !== 'menu') continue
    map.set(item.item_name, (map.get(item.item_name) ?? 0) + (item.quantity ?? 1))
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'))
}

function buildStaffRows(sessions: HqSessionRow[]): StaffRow[] {
  const map = new Map<string, { sales: number; count: number }>()
  for (const session of sessions) {
    const name = session.stylist_name || session.staff_name || '未設定'
    const prev = map.get(name) ?? { sales: 0, count: 0 }
    map.set(name, { sales: prev.sales + (session.total ?? 0), count: prev.count + 1 })
  }
  return [...map.entries()]
    .map(([name, row]) => ({ name, ...row }))
    .sort((a, b) => b.sales - a.sales || b.count - a.count || a.name.localeCompare(b.name, 'ja'))
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={sectionStyle}>
      <p style={{ margin: 0, color: HQ_COLORS.textSecondary, fontSize: 13 }}>{label}</p>
      <p style={{ margin: '8px 0 0', color: HQ_COLORS.textPrimary, fontSize: 28, lineHeight: 1.1, fontWeight: 700 }}>{value}</p>
    </div>
  )
}

function DataTable({ columns, children }: { columns: string[]; children: ReactNode }) {
  return (
    <div style={{ width: '100%', overflowX: 'auto', marginTop: 12 }}>
      <table style={{ width: '100%', minWidth: 420, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={column} style={{ ...thStyle, textAlign: index === 0 ? 'left' : 'right' }}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function EmptyRow({ colSpan, loading }: { colSpan: number; loading: boolean }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: '18px 0', color: HQ_COLORS.textMute, fontSize: 14 }}>
        {loading ? '読み込み中…' : '該当データはありません。'}
      </td>
    </tr>
  )
}

const sectionStyle: CSSProperties = {
  background: HQ_COLORS.panel,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  borderRadius: 8,
  padding: 16,
  boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  lineHeight: 1.3,
  fontWeight: 700,
}

const noteStyle: CSSProperties = {
  margin: '6px 0 0',
  color: HQ_COLORS.textSecondary,
  fontSize: 13,
  lineHeight: 1.6,
}

const segmentStyle: CSSProperties = {
  minHeight: 36,
  padding: '0 14px',
  borderRadius: 7,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  fontFamily: HQ_SANS,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
}

const outlineButtonStyle: CSSProperties = {
  minHeight: 38,
  padding: '0 14px',
  borderRadius: 7,
  border: `1px solid ${HQ_COLORS.panelBorderStrong}`,
  background: '#FFFFFF',
  color: HQ_COLORS.goldHi,
  fontFamily: HQ_SANS,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
}

const dateInputStyle: CSSProperties = {
  height: 36,
  borderRadius: 7,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  background: '#FFFFFF',
  color: HQ_COLORS.textPrimary,
  fontFamily: HQ_SANS,
  fontSize: 13,
  padding: '0 10px',
}

const thStyle: CSSProperties = {
  padding: '0 10px 10px 0',
  borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
  color: HQ_COLORS.textMute,
  fontFamily: HQ_MONO,
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const trStyle: CSSProperties = {
  borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
}

const tdStyle: CSSProperties = {
  padding: '12px 10px 12px 0',
  color: HQ_COLORS.textPrimary,
  fontSize: 14,
  whiteSpace: 'nowrap',
}
