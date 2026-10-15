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
      borderRadius: 12,
      padding: '22px 24px',
      ...style,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <h3 style={{
          fontFamily: HQ_SERIF, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em',
          color: HQ_COLORS.textPrimary, margin: 0,
        }}>
          {title}
        </h3>
        {code && (
          <span style={{
            fontFamily: HQ_SANS, fontSize: 10, letterSpacing: '0.02em',
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
