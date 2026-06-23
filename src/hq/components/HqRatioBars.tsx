import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

export function HqRatioBars({ data, unit = '%' }: {
  data: { label: string; ratio: number; color: string }[]
  unit?: string
}) {
  const max = Math.max(...data.map(d => d.ratio), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {data.map((d) => (
        <div key={d.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontFamily: HQ_SANS, fontSize: 11, color: HQ_COLORS.textPrimary }}>{d.label}</span>
            <span style={{ fontFamily: HQ_MONO, fontSize: 11, color: HQ_COLORS.textSecondary }}>{d.ratio}{unit}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${(d.ratio / max) * 100}%`,
              background: d.color, borderRadius: 3,
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}
