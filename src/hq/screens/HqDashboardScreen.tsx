import { useEffect, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HqStatTile } from '../components/HqStatTile'
import { getHqDashboardData } from '../hqDataStore'
import type { HqDashboardData } from '../hqDataStore'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from '../hqTheme'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: HqDashboardData }

function yen(v: number): string {
  return `¥${v.toLocaleString()}`
}

export function HqDashboardScreen() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    getHqDashboardData()
      .then((data) => { if (!cancelled) setState({ phase: 'ready', data }) })
      .catch((e) => {
        console.error('[HqDashboardScreen] getHqDashboardData error:', e)
        if (!cancelled) setState({ phase: 'error', message: '売上データの取得に失敗しました。' })
      })
    return () => { cancelled = true }
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

  const { data } = state
  const isOpen = data.shopStatus === 'open'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <HqStatTile label="本日売上" value={yen(data.todaySales)} />
        <HqStatTile label="本日来客" value={`${data.todayVisitors}名`} />
        <HqStatTile label="客単価" value={yen(data.todayUnitPrice)} />
        <HqStatTile label="今月売上" value={yen(data.monthSales)} />

        <div style={{
          flex: '1 1 0', minWidth: 0,
          background: HQ_COLORS.panel,
          border: `1px solid ${isOpen ? 'rgba(123,201,123,0.35)' : HQ_COLORS.panelBorder}`,
          borderRadius: 4, padding: '14px 16px',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <p style={{ fontFamily: HQ_SANS, fontSize: 10, letterSpacing: '0.12em', color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 8 }}>
            営業状態
          </p>
          <p style={{
            fontFamily: HQ_SERIF, fontSize: 20, fontWeight: 700, margin: 0,
            color: data.shopStatus === null ? HQ_COLORS.textMute : isOpen ? HQ_COLORS.positive : HQ_COLORS.textSecondary,
          }}>
            {data.shopStatus === null ? '不明' : isOpen ? '営業中' : '営業終了'}
          </p>
        </div>
      </div>

      <HqPanel title="スタイリスト別集計（本日）" code="STAFF">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {data.stylists.map((s) => (
            <div key={s.name} style={{
              flex: '1 1 0', minWidth: 140,
              background: 'rgba(0,0,0,0.25)', border: `1px solid ${HQ_COLORS.panelBorder}`,
              borderRadius: 4, padding: '12px 14px',
            }}>
              <p style={{ fontFamily: HQ_SERIF, fontSize: 15, fontWeight: 700, color: '#fff', margin: 0, marginBottom: 8 }}>
                {s.name}
              </p>
              <p style={{ fontFamily: HQ_MONO, fontSize: 11.5, color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 3 }}>
                売上 <span style={{ color: HQ_COLORS.goldHi }}>{yen(s.sales)}</span>
              </p>
              <p style={{ fontFamily: HQ_MONO, fontSize: 11.5, color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 3 }}>
                来客 {s.visitors}名
              </p>
              <p style={{ fontFamily: HQ_MONO, fontSize: 11.5, color: HQ_COLORS.textSecondary, margin: 0 }}>
                客単価 {yen(s.unitPrice)}
              </p>
            </div>
          ))}
        </div>
      </HqPanel>

      <div style={{ display: 'flex', gap: 18, alignItems: 'stretch' }}>
        <HqPanel title="人気メニュー（本日）" code="TOP5" style={{ flex: '1 1 0' }}>
          {data.menuRanking.length === 0 ? (
            <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
              本日のデータなし
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.menuRanking.map((m) => (
                <div key={m.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textPrimary }}>
                    <span style={{ fontFamily: HQ_MONO, color: HQ_COLORS.goldHi, marginRight: 8 }}>{m.rank}位</span>
                    {m.name}
                  </span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.textSecondary }}>{m.count}件</span>
                </div>
              ))}
            </div>
          )}
        </HqPanel>

        <HqPanel title="店販（本日）" code="RETAIL" style={{ flex: '1 1 0' }}>
          {data.retailRanking.length === 0 ? (
            <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
              本日のデータなし
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.retailRanking.map((r) => (
                <div key={r.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textPrimary }}>{r.name}</span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.textSecondary }}>{r.count}個</span>
                </div>
              ))}
            </div>
          )}
        </HqPanel>
      </div>
    </div>
  )
}
