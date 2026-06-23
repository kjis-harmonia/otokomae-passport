import { HqPanel } from '../components/HqPanel'
import { HqTable, HqTr, HqTd } from '../components/HqTable'
import { HQ_STYLISTS } from '../hqMockData'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from '../hqTheme'

export function HqStylistScreen() {
  const top = [...HQ_STYLISTS].sort((a, b) => b.sales - a.sales)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 14 }}>
        {top.map((s, i) => (
          <div key={s.name} style={{
            flex: '1 1 0', minWidth: 0,
            background: HQ_COLORS.panel, border: `1px solid ${i === 0 ? HQ_COLORS.panelBorderStrong : HQ_COLORS.panelBorder}`,
            borderRadius: 4, padding: '16px 18px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span style={{ fontFamily: HQ_MONO, fontSize: 10, color: HQ_COLORS.goldDim, letterSpacing: '0.1em' }}>RANK #{i + 1}</span>
              <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: HQ_COLORS.goldHi }}>★ {s.rating}</span>
            </div>
            <p style={{ fontFamily: HQ_SERIF, fontSize: 20, fontWeight: 700, color: '#fff', margin: 0, marginBottom: 6 }}>{s.name}</p>
            <p style={{ fontFamily: HQ_MONO, fontSize: 18, color: HQ_COLORS.goldHi, margin: 0, marginBottom: 10 }}>
              ¥{s.sales.toLocaleString()}
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: HQ_SANS, fontSize: 10.5, color: HQ_COLORS.textSecondary }}>
              <span>稼働率 {s.occupancy}%</span>
              <span>リピート {s.repeatRate}%</span>
            </div>
          </div>
        ))}
      </div>

      <HqPanel title="スタイリスト一覧" code="ALL STAFF">
        <HqTable columns={[
          { label: '名前' },
          { label: '指名数', align: 'right' },
          { label: '売上', align: 'right' },
          { label: '客単価', align: 'right' },
          { label: 'リピート率', align: 'right' },
          { label: '稼働率', align: 'right' },
          { label: '評価', align: 'right' },
        ]}>
          {HQ_STYLISTS.map((s) => (
            <HqTr key={s.name}>
              <HqTd>{s.name}</HqTd>
              <HqTd align="right" mono>{s.nominations}</HqTd>
              <HqTd align="right" mono>¥{s.sales.toLocaleString()}</HqTd>
              <HqTd align="right" mono>¥{s.unitPrice.toLocaleString()}</HqTd>
              <HqTd align="right" mono>{s.repeatRate}%</HqTd>
              <HqTd align="right" mono color={HQ_COLORS.goldHi}>{s.occupancy}%</HqTd>
              <HqTd align="right" mono>★{s.rating}</HqTd>
            </HqTr>
          ))}
        </HqTable>
      </HqPanel>
    </div>
  )
}
