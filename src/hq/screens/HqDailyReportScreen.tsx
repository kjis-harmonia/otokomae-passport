import { useEffect, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { getDailyReports } from '../hqDailyReportStore'
import type { DailyReport } from '../hqDailyReportStore'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from '../hqTheme'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; reports: DailyReport[] }

function yen(v: number): string {
  return `¥${v.toLocaleString()}`
}

function fmtReportDate(dateStr: string): string {
  return dateStr.replaceAll('-', '/')
}

export function HqDailyReportScreen() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [expandedDate, setExpandedDate] = useState<string | null>(null)

  useEffect(() => {
    getDailyReports(30)
      .then((reports) => setState({ phase: 'ready', reports }))
      .catch((e) => {
        console.error('[HqDailyReportScreen] getDailyReports error:', e)
        setState({ phase: 'error', message: '日報データの取得に失敗しました。' })
      })
  }, [])

  if (state.phase === 'loading') {
    return (
      <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textSecondary }}>
        読み込み中…
      </p>
    )
  }

  if (state.phase === 'error') {
    return (
      <div style={{
        background: 'rgba(140,31,26,0.10)', border: `1px solid ${HQ_COLORS.red}`,
        borderRadius: 4, padding: '16px 18px',
      }}>
        <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.negative, margin: 0 }}>
          {state.message}
        </p>
      </div>
    )
  }

  if (state.reports.length === 0) {
    return (
      <HqPanel title="日報一覧" code="0件">
        <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
          日報がまだありません（営業終了時に自動生成されます）
        </p>
      </HqPanel>
    )
  }

  return (
    <HqPanel title="日報一覧" code={`${state.reports.length}件`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state.reports.map((r) => {
          const expanded = expandedDate === r.report_date
          return (
            <div
              key={r.report_date}
              style={{
                border: `1px solid ${expanded ? HQ_COLORS.panelBorderStrong : HQ_COLORS.panelBorder}`,
                borderRadius: 4, background: 'rgba(0,0,0,0.25)', overflow: 'hidden',
              }}
            >
              <button
                type="button"
                onClick={() => setExpandedDate(expanded ? null : r.report_date)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                  gap: 12, padding: '12px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontFamily: HQ_SERIF, fontSize: 15, fontWeight: 700, color: HQ_COLORS.textPrimary }}>
                  {fmtReportDate(r.report_date)}
                </span>
                <span style={{ display: 'flex', gap: 16, fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.textSecondary, flexShrink: 0 }}>
                  <span style={{ color: HQ_COLORS.goldHi }}>{yen(r.total_sales)}</span>
                  <span>{r.customer_count}名</span>
                </span>
              </button>

              {expanded && <DailyReportDetail report={r} />}
            </div>
          )
        })}
      </div>
    </HqPanel>
  )
}

function DailyReportDetail({ report }: { report: DailyReport }) {
  return (
    <div style={{
      borderTop: `1px solid ${HQ_COLORS.panelBorder}`, padding: '14px',
      display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <ReportStat label="本日売上" value={yen(report.total_sales)} />
        <ReportStat label="来客数" value={`${report.customer_count}名`} />
        <ReportStat label="客単価" value={yen(report.average_spend)} />
      </div>

      <div>
        <ReportSectionTitle>スタイリスト</ReportSectionTitle>
        {report.stylist_summary.length === 0 ? (
          <ReportEmpty />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {report.stylist_summary.map((s) => (
              <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textPrimary }}>{s.name}</span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.goldHi }}>{yen(s.sales)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <ReportSectionTitle>人気メニュー</ReportSectionTitle>
        {report.menu_summary.length === 0 ? (
          <ReportEmpty />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {report.menu_summary.map((m) => (
              <div key={m.name} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textPrimary }}>
                  <span style={{ fontFamily: HQ_MONO, color: HQ_COLORS.goldHi, marginRight: 6 }}>{m.rank}位</span>
                  {m.name}
                </span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: HQ_COLORS.textSecondary }}>{m.count}件</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <ReportSectionTitle>店販</ReportSectionTitle>
        {report.retail_summary.length === 0 ? (
          <ReportEmpty />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {report.retail_summary.map((r) => (
              <div key={r.name} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textPrimary }}>{r.name}</span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: HQ_COLORS.textSecondary }}>{r.count}個</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <ReportSectionTitle>在庫アラート</ReportSectionTitle>
        {report.inventory_alerts.length === 0 ? (
          <ReportEmpty text="在庫アラートなし" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {report.inventory_alerts.map((a) => (
              <div key={a.name} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textPrimary }}>
                  {a.status === 'reorder' ? '🔴' : '🟡'} {a.name}
                </span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: a.status === 'reorder' ? HQ_COLORS.negative : '#E0B84A' }}>
                  {a.status === 'reorder' ? '要発注' : '少ない'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ReportStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 90 }}>
      <p style={{ fontFamily: HQ_SANS, fontSize: 9, letterSpacing: '0.1em', color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 4 }}>
        {label}
      </p>
      <p style={{ fontFamily: HQ_MONO, fontSize: 17, fontWeight: 700, color: HQ_COLORS.goldHi, margin: 0 }}>
        {value}
      </p>
    </div>
  )
}

function ReportSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontFamily: HQ_SANS, fontSize: 10.5, letterSpacing: '0.1em', color: HQ_COLORS.textMute, margin: 0, marginBottom: 8 }}>
      {children}
    </p>
  )
}

function ReportEmpty({ text = '本日のデータなし' }: { text?: string }) {
  return (
    <p style={{ fontFamily: HQ_SANS, fontSize: 12, color: HQ_COLORS.textMute, margin: 0 }}>{text}</p>
  )
}
