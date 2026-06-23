import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

export function HqStatTile({ label, value, delta, positive, sub }: {
  label: string
  value: string
  delta?: string
  positive?: boolean
  sub?: string
}) {
  return (
    <div style={{
      background: HQ_COLORS.panel,
      border: `1px solid ${HQ_COLORS.panelBorder}`,
      borderRadius: 4,
      padding: '14px 16px',
      flex: '1 1 0',
      minWidth: 0,
    }}>
      <p style={{
        fontFamily: HQ_SANS, fontSize: 10, letterSpacing: '0.12em',
        color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 8, whiteSpace: 'nowrap',
      }}>
        {label}
      </p>
      <p style={{
        fontFamily: HQ_MONO, fontSize: 24, fontWeight: 700,
        color: HQ_COLORS.goldHi, margin: 0, marginBottom: 6, lineHeight: 1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {value}
      </p>
      {delta && (
        <p style={{
          fontFamily: HQ_MONO, fontSize: 11, margin: 0,
          color: positive ? HQ_COLORS.positive : HQ_COLORS.negative,
          whiteSpace: 'nowrap',
        }}>
          {positive ? '▲' : '▼'} {delta} <span style={{ color: HQ_COLORS.textMute, marginLeft: 4 }}>{sub}</span>
        </p>
      )}
    </div>
  )
}
