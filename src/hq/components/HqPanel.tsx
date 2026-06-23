import type { ReactNode } from 'react'
import { HQ_COLORS, HQ_SANS, HQ_SERIF } from '../hqTheme'

export function HqPanel({ title, code, children, style }: {
  title: string
  code?: string
  children: ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div style={{
      background: HQ_COLORS.panel,
      border: `1px solid ${HQ_COLORS.panelBorder}`,
      borderRadius: 4,
      padding: '16px 18px',
      ...style,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <h3 style={{
          fontFamily: HQ_SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.06em',
          color: HQ_COLORS.textPrimary, margin: 0,
        }}>
          {title}
        </h3>
        {code && (
          <span style={{
            fontFamily: HQ_SANS, fontSize: 9, letterSpacing: '0.18em',
            color: HQ_COLORS.goldDim,
          }}>
            {code}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
