import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { JOHNNY_UI_ENABLED } from '../../utils/johnnyFlag'
import { getJapanDateString } from '../../utils/dateUtils'
import {
  hqBookingApi,
  jstTime,
  STATUS_LABEL,
  yen,
  type BookingOptions,
  type Ledger,
  type Reservation,
  type ReservationStatus,
} from '../../utils/bookingApi'
import { hqCustomerApi } from '../../utils/customerApi'
import { hqGinpayApi } from '../../utils/ginpayApi'
import { rpcErrorMessage } from '../../utils/staffSession'
import { getHqDashboardData, type HqDashboardData } from '../hqDataStore'
import type { HqNavigate } from '../hqMockData'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'
import { CustomerLedger } from '../../components/booking/CustomerLedger'
import { ReservationDetail } from '../../components/booking/ReservationDetail'

type TodayFilter = 'all' | 'arrived' | 'awaiting_payment'

interface NextSlot {
  starts_at: string
  staff_name: string
  menu_name: string
}

interface TodayState {
  loading: boolean
  error: string | null
  ledger: Ledger | null
  options: BookingOptions | null
  dashboard: HqDashboardData | null
  nextSlot: NextSlot | null
  updatedAt: Date | null
}

const FILTER_LABEL: Record<TodayFilter, string> = {
  all: '直近予約',
  arrived: '来店済み・施術中',
  awaiting_payment: '会計待ち',
}

const BOOKED_STATUSES = new Set<ReservationStatus>(['confirmed', 'checked_in', 'in_service', 'awaiting_payment', 'completed'])

function fmtDateLabel(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).format(date)
}

function statusTone(status: ReservationStatus): CSSProperties {
  if (status === 'awaiting_payment') return { color: '#9A4E00', background: '#FFF4D8', borderColor: '#F5D38A' }
  if (status === 'checked_in' || status === 'in_service') return { color: '#067647', background: '#E9F8EF', borderColor: '#B7E4CA' }
  if (status === 'confirmed') return { color: '#1D4ED8', background: '#EAF1FF', borderColor: '#BCD3FF' }
  if (status === 'completed') return { color: '#475467', background: '#F2F4F7', borderColor: '#D0D5DD' }
  return { color: '#B42318', background: '#FEF3F2', borderColor: '#FECACA' }
}

async function findNextSlot(date: string, options: BookingOptions): Promise<NextSlot | null> {
  const menus = options.menus.slice(0, 8)
  if (menus.length === 0) return null
  const now = Date.now()
  const results = await Promise.allSettled(
    menus.map(async (menu) => {
      const slots = await hqBookingApi.slots(date, [menu.code], null)
      const future = slots.filter((slot) => new Date(slot.starts_at).getTime() >= now)
      return future.map((slot): NextSlot => ({ starts_at: slot.starts_at, staff_name: slot.staff_name, menu_name: menu.name }))
    }),
  )
  const all = results.flatMap((r) => r.status === 'fulfilled' ? r.value : [])
  all.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  return all[0] ?? null
}

export function HqTodayScreen({ onNavigate }: { onNavigate: HqNavigate }) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [filter, setFilter] = useState<TodayFilter>('all')
  const [clientId, setClientId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Reservation | null>(null)
  const [state, setState] = useState<TodayState>({
    loading: true,
    error: null,
    ledger: null,
    options: null,
    dashboard: null,
    nextSlot: null,
    updatedAt: null,
  })

  const load = useCallback(async () => {
    const today = getJapanDateString()
    const [ledgerResult, optionsResult, dashboardResult] = await Promise.allSettled([
      hqBookingApi.ledger(today),
      hqBookingApi.options(),
      getHqDashboardData(),
    ])
    const ledger = ledgerResult.status === 'fulfilled' ? ledgerResult.value : null
    const options = optionsResult.status === 'fulfilled' ? optionsResult.value : null
    const dashboard = dashboardResult.status === 'fulfilled' ? dashboardResult.value : null
    let nextSlot: NextSlot | null = null
    if (options) {
      try {
        nextSlot = await findNextSlot(today, options)
      } catch {
        nextSlot = null
      }
    }
    const errors = [ledgerResult, optionsResult, dashboardResult]
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => rpcErrorMessage(r.reason))
    setState({
      loading: false,
      error: errors.length ? errors[0] : null,
      ledger,
      options,
      dashboard,
      nextSlot,
      updatedAt: new Date(),
    })
  }, [])

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      setState((s) => ({ ...s, loading: true }))
      void load().finally(() => {
        if (!alive) return
      })
    }, 0)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [load])

  const reservations = useMemo(() => {
    const rows = state.ledger?.reservations ?? []
    return [...rows].sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  }, [state.ledger])

  const bookedCount = reservations.filter((r) => BOOKED_STATUSES.has(r.status)).length
  const arrivedCount = reservations.filter((r) => r.status === 'checked_in' || r.status === 'in_service').length
  const awaitingPaymentCount = reservations.filter((r) => r.status === 'awaiting_payment').length
  const filteredReservations = reservations.filter((r) => {
    if (filter === 'arrived') return r.status === 'checked_in' || r.status === 'in_service'
    if (filter === 'awaiting_payment') return r.status === 'awaiting_payment'
    return true
  }).slice(0, 5)

  function showList(next: TodayFilter) {
    setFilter(next)
    window.requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  function openReservation(r: Reservation) {
    if (state.options) {
      setDetail(r)
    } else {
      onNavigate('ledger')
    }
  }

  return (
    <div style={{ display: 'grid', gap: 20, fontFamily: HQ_SANS, color: HQ_COLORS.textPrimary }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.15, letterSpacing: 0 }}>今日の営業</h1>
          <p style={{ margin: '8px 0 0', color: HQ_COLORS.textSecondary, fontSize: 14 }}>
            本日の予約・来店・売上の状況です。実データが取れない項目は空表示にしています。
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: HQ_COLORS.textSecondary }}>
            {state.updatedAt ? `最終更新 ${fmtDateLabel(state.updatedAt)} ${state.updatedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : '最終更新 —'}
          </span>
          <button type="button" onClick={() => void load()} style={smallButtonStyle}>
            更新
          </button>
        </div>
      </header>

      {state.error && (
        <div style={{
          border: `1px solid ${HQ_COLORS.panelBorder}`,
          background: '#FFF7ED',
          color: HQ_COLORS.negative,
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 13,
        }}>
          一部の実データを取得できませんでした。{state.error}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <MetricCard label="本日の予約" value={state.loading && !state.ledger ? '—' : `${bookedCount}件`} sub="今日の予約一覧" onClick={() => showList('all')} />
        <MetricCard label="来店済み" value={state.loading && !state.ledger ? '—' : `${arrivedCount}件`} sub="来店済み・施術中" onClick={() => showList('arrived')} />
        <MetricCard label="会計待ち" value={state.loading && !state.ledger ? '—' : `${awaitingPaymentCount}件`} sub="該当予約を表示" onClick={() => showList('awaiting_payment')} />
        <MetricCard label="本日売上" value={state.dashboard ? yen(state.dashboard.todaySales) : '—'} sub="売上分析を今日で開く" onClick={() => onNavigate('sales', { salesPreset: 'today' })} />
        <MetricCard label="次の空き時間" value={state.nextSlot ? jstTime(state.nextSlot.starts_at) : '—'} sub={state.nextSlot ? `${state.nextSlot.staff_name} / ${state.nextSlot.menu_name}` : '予約台帳で確認'} onClick={() => onNavigate('ledger')} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: JOHNNY_UI_ENABLED ? 'repeat(auto-fit, minmax(280px, 1fr))' : 'minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <section ref={listRef} style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div>
              <h2 style={sectionTitleStyle}>本日の予約・来店状況</h2>
              <p style={{ margin: '4px 0 0', color: HQ_COLORS.textSecondary, fontSize: 13 }}>{FILTER_LABEL[filter]}を最大5件表示</p>
            </div>
            <button type="button" onClick={() => onNavigate('ledger')} style={linkButtonStyle}>
              すべて見る
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {(Object.keys(FILTER_LABEL) as TodayFilter[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => showList(id)}
                style={{
                  ...segmentedButtonStyle,
                  background: filter === id ? '#EAF1FF' : '#FFFFFF',
                  color: filter === id ? HQ_COLORS.goldHi : HQ_COLORS.textSecondary,
                  borderColor: filter === id ? '#BCD3FF' : HQ_COLORS.panelBorder,
                }}
              >
                {FILTER_LABEL[id]}
              </button>
            ))}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 680, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['時刻', '顧客', 'メニュー', '担当', '状態'].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredReservations.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: '20px 0', color: HQ_COLORS.textMute, fontSize: 14 }}>
                      {state.loading ? '読み込み中…' : '該当する予約はありません。'}
                    </td>
                  </tr>
                ) : filteredReservations.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${HQ_COLORS.panelBorder}` }}>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => openReservation(r)} style={rowButtonStyle}>
                        {jstTime(r.starts_at)}
                      </button>
                    </td>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => setClientId(r.client_id)} style={customerButtonStyle}>
                        {r.customer_name}
                      </button>
                    </td>
                    <td style={tdStyle}>{r.items.map((item) => item.name).join(' / ') || '—'}</td>
                    <td style={tdStyle}>{r.staff_name || '—'}</td>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => openReservation(r)} style={{ ...pillButtonStyle, ...statusTone(r.status) }}>
                        {STATUS_LABEL[r.status]}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {JOHNNY_UI_ENABLED && (
          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <div>
                <h2 style={sectionTitleStyle}>JOHNNYからの今日の提案</h2>
                <p style={{ margin: '4px 0 0', color: HQ_COLORS.textSecondary, fontSize: 13 }}>AI提案はHQ JOHNNYで実データ確認後に表示します。</p>
              </div>
              <button type="button" onClick={() => onNavigate('johnny')} style={linkButtonStyle}>
                もっと見る
              </button>
            </div>
            <div style={{ borderTop: `1px solid ${HQ_COLORS.panelBorder}`, paddingTop: 14 }}>
              <p style={{ margin: 0, color: HQ_COLORS.textSecondary, fontSize: 14, lineHeight: 1.7 }}>
                ここには偽の分析や固定文言を出しません。JOHNNYが有効な環境で、HQセッションと監査付きtool callから得た提案だけを表示します。
              </p>
            </div>
          </section>
        )}
      </div>

      {detail && state.options && (
        <ReservationDetail
          api={hqBookingApi}
          options={state.options}
          reservation={detail}
          ensureActor={() => true}
          onClose={() => setDetail(null)}
          onChanged={(next) => {
            setDetail(next)
            void load()
          }}
          onOpenCustomer={() => setClientId(detail.client_id)}
        />
      )}

      {clientId && (
        <CustomerLedger
          api={hqCustomerApi}
          ginpayApi={hqGinpayApi}
          target={{ clientId }}
          backLabel="今日の営業に戻る"
          ensureActor={() => true}
          onClose={() => setClientId(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  )
}

function MetricCard({ label, value, sub, onClick }: { label: string; value: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      display: 'block',
      textAlign: 'left',
      minHeight: 112,
      padding: '16px 16px 14px',
      borderRadius: 8,
      border: `1px solid ${HQ_COLORS.panelBorder}`,
      background: HQ_COLORS.panel,
      cursor: 'pointer',
      boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    }}>
      <span style={{ display: 'block', color: HQ_COLORS.textSecondary, fontSize: 13, marginBottom: 8 }}>{label}</span>
      <span style={{ display: 'block', color: HQ_COLORS.textPrimary, fontSize: 27, fontWeight: 700, letterSpacing: 0 }}>{value}</span>
      <span style={{ display: 'block', color: HQ_COLORS.textMute, fontSize: 12, marginTop: 8, lineHeight: 1.4 }}>{sub}</span>
    </button>
  )
}

const sectionStyle: CSSProperties = {
  background: HQ_COLORS.panel,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  borderRadius: 8,
  padding: 16,
  boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
}

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 14,
}

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  lineHeight: 1.3,
  fontWeight: 700,
  letterSpacing: 0,
}

const smallButtonStyle: CSSProperties = {
  minHeight: 36,
  padding: '0 14px',
  borderRadius: 7,
  border: `1px solid ${HQ_COLORS.panelBorderStrong}`,
  background: '#FFFFFF',
  color: HQ_COLORS.goldHi,
  fontFamily: HQ_SANS,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
}

const linkButtonStyle: CSSProperties = {
  minHeight: 36,
  padding: '0 6px',
  border: 'none',
  background: 'transparent',
  color: HQ_COLORS.goldHi,
  fontFamily: HQ_SANS,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const segmentedButtonStyle: CSSProperties = {
  minHeight: 34,
  padding: '0 12px',
  borderRadius: 7,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  fontFamily: HQ_SANS,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}

const thStyle: CSSProperties = {
  padding: '0 10px 10px 0',
  color: HQ_COLORS.textMute,
  fontFamily: HQ_MONO,
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'left',
  whiteSpace: 'nowrap',
}

const tdStyle: CSSProperties = {
  padding: '12px 10px 12px 0',
  color: HQ_COLORS.textPrimary,
  fontSize: 14,
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
}

const rowButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: HQ_COLORS.textPrimary,
  fontFamily: HQ_MONO,
  fontSize: 14,
  fontWeight: 700,
  padding: 0,
  cursor: 'pointer',
}

const customerButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: HQ_COLORS.goldHi,
  fontFamily: HQ_SANS,
  fontSize: 14,
  fontWeight: 700,
  padding: 0,
  cursor: 'pointer',
}

const pillButtonStyle: CSSProperties = {
  minHeight: 28,
  padding: '0 9px',
  borderRadius: 999,
  border: '1px solid',
  fontFamily: HQ_SANS,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
}
