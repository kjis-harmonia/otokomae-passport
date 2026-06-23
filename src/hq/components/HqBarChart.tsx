import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

export function HqBarChart({ data, valueFormatter }: {
  data: { day: string; value: number }[]
  valueFormatter?: (v: number) => string
}) {
  const max = Math.max(...data.map(d => d.value), 1)
  const fmt = valueFormatter ?? ((v: number) => `¥${v.toLocaleString()}`)

  return (
    // 横スクロールでラップ：データ点数が多い（年間=12本など）場合でもバーが潰れて
    // 値ラベルが重なるのを防ぎ、各列に最低幅（48px）を確保する。
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 140, minWidth: data.length * 48 }}>
      {data.map((d) => {
        const h = Math.max((d.value / max) * 100, 4)
        return (
          <div key={d.day} style={{ flex: '1 1 38px', minWidth: 38, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
            <p style={{
              fontFamily: HQ_MONO, fontSize: 9, color: HQ_COLORS.textSecondary,
              margin: 0, marginBottom: 6, whiteSpace: 'nowrap',
            }}>
              {fmt(d.value)}
            </p>
            <div style={{
              width: '100%', maxWidth: 28, height: `${h}%`,
              background: `linear-gradient(180deg, ${HQ_COLORS.goldHi} 0%, ${HQ_COLORS.gold} 55%, ${HQ_COLORS.goldDim} 100%)`,
              borderRadius: '2px 2px 0 0',
              boxShadow: `0 0 10px rgba(201,162,74,0.25)`,
            }} />
            <p style={{
              fontFamily: HQ_SANS, fontSize: 10, color: HQ_COLORS.textSecondary,
              margin: 0, marginTop: 8,
            }}>
              {d.day}
            </p>
          </div>
        )
      })}
      </div>
    </div>
  )
}
