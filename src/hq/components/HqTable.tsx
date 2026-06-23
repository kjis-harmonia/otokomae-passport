import type { ReactNode } from 'react'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

export function HqTable({ columns, children }: {
  columns: { label: string; align?: 'left' | 'right' }[]
  children: ReactNode
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: HQ_SANS }}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.label} style={{
              textAlign: c.align ?? 'left', fontSize: 10, letterSpacing: '0.08em',
              color: HQ_COLORS.textMute, fontWeight: 500, padding: '0 8px 10px 0',
              borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
            }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

export function HqTr({ children }: { children: ReactNode }) {
  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      {children}
    </tr>
  )
}

export function HqTd({ children, align, mono, color }: {
  children: ReactNode
  align?: 'left' | 'right'
  mono?: boolean
  color?: string
}) {
  return (
    <td style={{
      padding: '10px 8px 10px 0', fontSize: 12.5, textAlign: align ?? 'left',
      fontFamily: mono ? HQ_MONO : HQ_SANS,
      color: color ?? HQ_COLORS.textPrimary,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </td>
  )
}
