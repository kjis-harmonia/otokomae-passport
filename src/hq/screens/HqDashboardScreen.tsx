import { HqPanel } from '../components/HqPanel'
import { HqStatTile } from '../components/HqStatTile'
import { HqBarChart } from '../components/HqBarChart'
import { HqRatioBars } from '../components/HqRatioBars'
import { HqTable, HqTr, HqTd } from '../components/HqTable'
import { HQ_ALERTS, HQ_KPI, HQ_MEMBER_RANKS, HQ_STYLISTS, HQ_WEEKLY_SALES } from '../hqMockData'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

const ALERT_TONE: Record<'warn' | 'info' | 'ok', string> = {
  warn: HQ_COLORS.negative,
  info: HQ_COLORS.gold,
  ok: HQ_COLORS.positive,
}

export function HqDashboardScreen() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 14 }}>
        {HQ_KPI.map((k) => <HqStatTile key={k.label} {...k} />)}
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'stretch' }}>
        <HqPanel title="週間売上トレンド" code="7D" style={{ flex: '2 1 0' }}>
          <HqBarChart data={HQ_WEEKLY_SALES} />
        </HqPanel>

        <HqPanel title="アラート" code="STATUS" style={{ flex: '1 1 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {HQ_ALERTS.map((a) => (
              <div key={a.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 11.5, color: HQ_COLORS.textSecondary }}>{a.label}</span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: ALERT_TONE[a.tone], fontWeight: 700 }}>{a.value}</span>
              </div>
            ))}
          </div>
        </HqPanel>
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'stretch' }}>
        <HqPanel title="スタイリスト本日スナップショット" code="STAFF" style={{ flex: '2 1 0' }}>
          <HqTable columns={[
            { label: '名前' }, { label: '指名数', align: 'right' },
            { label: '売上', align: 'right' }, { label: '稼働率', align: 'right' },
          ]}>
            {HQ_STYLISTS.map((s) => (
              <HqTr key={s.name}>
                <HqTd>{s.name}</HqTd>
                <HqTd align="right" mono>{s.nominations}</HqTd>
                <HqTd align="right" mono>¥{s.sales.toLocaleString()}</HqTd>
                <HqTd align="right" mono color={HQ_COLORS.goldHi}>{s.occupancy}%</HqTd>
              </HqTr>
            ))}
          </HqTable>
        </HqPanel>

        <HqPanel title="会員ランク分布" code="MBRS" style={{ flex: '1 1 0' }}>
          <HqRatioBars unit="名" data={HQ_MEMBER_RANKS.map(r => ({ label: r.label, ratio: r.count, color: r.color }))} />
        </HqPanel>
      </div>
    </div>
  )
}
