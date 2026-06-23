import type { ReactNode } from 'react'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

export function HqTable({ columns, children }: {
  columns: { label: string; align?: 'left' | 'right' }[]
  children: ReactNode
}) {
  return (
    // 横スクロールでラップ：狭い画面でも列が潰れず、スワイプで全列を確認できる。
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 420, borderCollapse: 'collapse', fontFamily: HQ_SANS }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} style={{
                textAlign: c.align ?? 'left', fontSize: 10, letterSpacing: '0.08em',
                color: HQ_COLORS.textMute, fontWeight: 500, padding: '0 8px 10px 0',
                borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
                whiteSpace: 'nowrap',
              }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
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
