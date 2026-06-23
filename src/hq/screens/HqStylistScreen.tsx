import { useEffect, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HqTable, HqTr, HqTd } from '../components/HqTable'
import { getHqStylistAnalysis } from '../hqDataStore'
import type { HqStylistAnalysisData, HqStylistPeriod, StylistAnalysis } from '../hqDataStore'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from '../hqTheme'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: HqStylistAnalysisData }

const PERIOD_LABEL: Record<HqStylistPeriod, string> = { today: '今日', month: '今月' }
const MEDALS = ['🥇', '🥈', '🥉']

function yen(v: number): string {
  return `¥${v.toLocaleString()}`
}

export function HqStylistScreen() {
  const [period, setPeriod] = useState<HqStylistPeriod>('today')
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    getHqStylistAnalysis(period)
      .then((data) => { if (!cancelled) setState({ phase: 'ready', data }) })
      .catch((e) => {
        console.error('[HqStylistScreen] getHqStylistAnalysis error:', e)
        if (!cancelled) setState({ phase: 'error', message: 'スタイリスト分析データの取得に失敗しました' })
      })
    return () => { cancelled = true }
  }, [period])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['today', 'month'] as HqStylistPeriod[]).map((p) => {
          const active = p === period
          return (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              style={{
                padding: '6px 14px', borderRadius: 3,
                background: active ? 'rgba(201,162,74,0.16)' : 'transparent',
                border: `1px solid ${active ? HQ_COLORS.panelBorderStrong : HQ_COLORS.panelBorder}`,
                color: active ? HQ_COLORS.goldHi : HQ_COLORS.textSecondary,
                fontFamily: HQ_SANS, fontSize: 11.5, letterSpacing: '0.04em',
                cursor: 'pointer',
              }}
            >
              {PERIOD_LABEL[p]}
            </button>
          )
        })}
      </div>

      {state.phase === 'loading' && (
        <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textSecondary }}>
          読み込み中…
        </p>
      )}

      {state.phase === 'error' && (
        <div style={{
          background: 'rgba(140,31,26,0.10)', border: `1px solid ${HQ_COLORS.red}`,
          borderRadius: 4, padding: '16px 18px',
        }}>
          <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.negative, margin: 0 }}>
            {state.message}
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <>
          <HqPanel title={period === 'today' ? '本日のMVP' : '今月のMVP'} code="MVP">
            {state.data.mvp ? (
              <div>
                <p style={{ fontFamily: HQ_SERIF, fontSize: 26, fontWeight: 700, color: '#fff', margin: 0, marginBottom: 10 }}>
                  {state.data.mvp.name}
                </p>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 14, color: HQ_COLORS.goldHi }}>
                    売上 {yen(state.data.mvp.sales)}
                  </span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 14, color: HQ_COLORS.textSecondary }}>
                    来客 {state.data.mvp.visitors}名
                  </span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 14, color: HQ_COLORS.textSecondary }}>
                    客単価 {yen(state.data.mvp.unitPrice)}
                  </span>
                </div>
              </div>
            ) : (
              <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
                データなし
              </p>
            )}
          </HqPanel>

          <HqPanel title="ランキング" code="RANKING">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {state.data.ranking.map((s, i) => (
                <div key={s.name} style={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                  padding: '8px 0',
                }}>
                  <span style={{ fontFamily: HQ_SERIF, fontSize: 16, fontWeight: 700, color: '#fff' }}>
                    {MEDALS[i] ? `${MEDALS[i]} ` : `${i + 1}. `}{s.name}
                  </span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 16, color: HQ_COLORS.goldHi }}>
                    {yen(s.sales)}
                  </span>
                </div>
              ))}
            </div>
          </HqPanel>

          <HqPanel title="スタイリスト一覧" code="ALL STAFF">
            <HqTable columns={[
              { label: '名前' },
              { label: '売上', align: 'right' },
              { label: '来客数', align: 'right' },
              { label: '客単価', align: 'right' },
              { label: '売上シェア', align: 'right' },
            ]}>
              {state.data.stylists.map((s: StylistAnalysis) => (
                <HqTr key={s.name}>
                  <HqTd>{s.name}</HqTd>
                  <HqTd align="right" mono color={HQ_COLORS.goldHi}>{yen(s.sales)}</HqTd>
                  <HqTd align="right" mono>{s.visitors}名</HqTd>
                  <HqTd align="right" mono>{yen(s.unitPrice)}</HqTd>
                  <HqTd align="right" mono>{s.share}%</HqTd>
                </HqTr>
              ))}
            </HqTable>
          </HqPanel>
        </>
      )}
    </div>
  )
}
