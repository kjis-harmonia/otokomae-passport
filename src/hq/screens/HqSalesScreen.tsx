import { useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HqBarChart } from '../components/HqBarChart'
import { HqRatioBars } from '../components/HqRatioBars'
import { HqTable, HqTr, HqTd } from '../components/HqTable'
import { HQ_MENU_RANKING, HQ_MONTHLY_SALES, HQ_PAYMENT_MIX, HQ_WEEKLY_SALES, HQ_YEARLY_SALES } from '../hqMockData'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'

type Period = 'week' | 'month' | 'year'

const PERIOD_LABEL: Record<Period, string> = { week: '週間', month: '月間', year: '年間' }
const PERIOD_DATA = { week: HQ_WEEKLY_SALES, month: HQ_MONTHLY_SALES, year: HQ_YEARLY_SALES }

export function HqSalesScreen() {
  const [period, setPeriod] = useState<Period>('week')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <HqPanel title="売上トレンド" code="REVENUE">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['week', 'month', 'year'] as Period[]).map((p) => {
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
        <HqBarChart data={PERIOD_DATA[period]} />
      </HqPanel>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'stretch' }}>
        <HqPanel title="メニュー別ランキング" code="MENU" style={{ flex: '2 1 320px', minWidth: 0 }}>
          <HqTable columns={[
            { label: '順位' }, { label: 'メニュー' }, { label: '件数', align: 'right' }, { label: '売上', align: 'right' },
          ]}>
            {HQ_MENU_RANKING.map((m) => (
              <HqTr key={m.rank}>
                <HqTd color={HQ_COLORS.goldHi} mono>#{m.rank}</HqTd>
                <HqTd>{m.name}</HqTd>
                <HqTd align="right" mono>{m.count}</HqTd>
                <HqTd align="right" mono>¥{m.sales.toLocaleString()}</HqTd>
              </HqTr>
            ))}
          </HqTable>
        </HqPanel>

        <HqPanel title="支払い方法比率" code="PAYMENT" style={{ flex: '1 1 240px', minWidth: 0 }}>
          <HqRatioBars data={HQ_PAYMENT_MIX} />
        </HqPanel>
      </div>
    </div>
  )
}
