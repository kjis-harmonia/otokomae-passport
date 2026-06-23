import { useEffect, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HqTable, HqTr, HqTd } from '../components/HqTable'
import { getHqStylistAnalysis } from '../hqDataStore'
import type { HqStylistAnalysisData, HqStylistPeriod, StylistAnalysis } from '../hqDataStore'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: HqStylistAnalysisData }

const PERIOD_LABEL: Record<HqStylistPeriod, string> = { today: '今日', month: '今月' }

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
      )}
    </div>
  )
}
