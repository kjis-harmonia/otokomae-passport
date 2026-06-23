import { HqPanel } from '../components/HqPanel'
import { HqRatioBars } from '../components/HqRatioBars'
import { HqTable, HqTr, HqTd } from '../components/HqTable'
import { HQ_MEMBER_RANKS, HQ_MEMBER_TREND, HQ_TOP_MEMBERS } from '../hqMockData'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'

export function HqMembersScreen() {
  const total = HQ_MEMBER_RANKS.reduce((s, r) => s + r.count, 0)
  const maxTrend = Math.max(...HQ_MEMBER_TREND.map(m => m.newCount), 1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 18, alignItems: 'stretch' }}>
        <HqPanel title="会員ランク分布" code={`TOTAL ${total}`} style={{ flex: '1 1 0' }}>
          <HqRatioBars unit="名" data={HQ_MEMBER_RANKS.map(r => ({ label: r.label, ratio: r.count, color: r.color }))} />
        </HqPanel>

        <HqPanel title="新規 / 離脱トレンド" code="6M" style={{ flex: '2 1 0' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 130 }}>
            {HQ_MEMBER_TREND.map((m) => (
              <div key={m.month} style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: '100%' }}>
                  <div style={{
                    width: 14, height: `${(m.newCount / maxTrend) * 100}%`,
                    background: `linear-gradient(180deg, ${HQ_COLORS.goldHi}, ${HQ_COLORS.gold})`,
                    borderRadius: '2px 2px 0 0',
                  }} />
                  <div style={{
                    width: 14, height: `${(m.churnCount / maxTrend) * 100}%`,
                    background: `linear-gradient(180deg, ${HQ_COLORS.negative}, ${HQ_COLORS.red})`,
                    borderRadius: '2px 2px 0 0',
                  }} />
                </div>
                <p style={{ fontFamily: HQ_SANS, fontSize: 10, color: HQ_COLORS.textSecondary, margin: 0, marginTop: 8 }}>{m.month}</p>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 14, fontFamily: HQ_SANS, fontSize: 10.5, color: HQ_COLORS.textSecondary }}>
            <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: HQ_COLORS.goldHi, marginRight: 6 }} />新規</span>
            <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: HQ_COLORS.negative, marginRight: 6 }} />離脱</span>
          </div>
        </HqPanel>
      </div>

      <HqPanel title="LTV ランキング（上位会員）" code="TOP MEMBERS">
        <HqTable columns={[
          { label: '順位' }, { label: '会員' }, { label: 'ランク' },
          { label: '来店回数', align: 'right' }, { label: 'LTV', align: 'right' },
        ]}>
          {HQ_TOP_MEMBERS.map((m) => (
            <HqTr key={m.rank}>
              <HqTd color={HQ_COLORS.goldHi} mono>#{m.rank}</HqTd>
              <HqTd>{m.name}</HqTd>
              <HqTd>{m.rankTier}</HqTd>
              <HqTd align="right" mono>{m.visits}</HqTd>
              <HqTd align="right" mono color={HQ_COLORS.goldHi}>¥{m.ltv.toLocaleString()}</HqTd>
            </HqTr>
          ))}
        </HqTable>
      </HqPanel>
    </div>
  )
}
