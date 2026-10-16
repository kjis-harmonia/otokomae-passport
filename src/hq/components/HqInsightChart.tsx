import { useState, useSyncExternalStore } from 'react'
import type { InsightPoint } from '../hqInsights'

const compactQuery = '(max-width: 760px)'
const subscribeCompact = (notify: () => void) => { const media = window.matchMedia(compactQuery); media.addEventListener('change', notify); return () => media.removeEventListener('change', notify) }
const readCompact = () => window.matchMedia(compactQuery).matches

export function HqInsightChart({ points }: { points: InsightPoint[] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const compact = useSyncExternalStore(subscribeCompact, readCompact, () => false)
  const width = compact ? 360 : 700, height = compact ? 215 : 230, left = compact ? 37 : 45, right = 14, top = 17, bottom = 33
  const maximum = Math.max(...points.flatMap(p => [p.current, p.previous]), 1)
  const scale = Math.max(Math.ceil(maximum / 4 / 1000) * 1000 * 4, 4000)
  const x = (i: number) => left + i / Math.max(points.length - 1, 1) * (width - left - right)
  const y = (value: number) => top + (1 - value / scale) * (height - top - bottom)
  const line = (key: 'current' | 'previous') => points.map((p, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(p[key])).join(' ')
  const ticks = new Set([0, Math.round((points.length - 1) * .25), Math.round((points.length - 1) * .5), Math.round((points.length - 1) * .75), points.length - 1])
  const active = selected === null ? null : points[selected]
  const area = points.length ? line('current') + 'L' + x(points.length - 1) + ',' + y(0) + 'L' + x(0) + ',' + y(0) + 'Z' : ''
  return <div className="hq-chart">
    <svg viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label="選択期間と直前の同日数の累計売上。左右キーで数値を確認できます。" tabIndex={0} onPointerMove={event => {
      const bounds = event.currentTarget.getBoundingClientRect()
      const px = (event.clientX - bounds.left) / bounds.width * width
      setSelected(Math.max(0, Math.min(points.length - 1, Math.round((px - left) / (width - left - right) * (points.length - 1)))))
    }} onPointerLeave={() => setSelected(null)} onBlur={() => setSelected(null)} onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSelected(i => Math.max(0, Math.min(points.length - 1, (i ?? 0) + (event.key === 'ArrowRight' ? 1 : -1)))) }
    }}>
      {[0, 1, 2, 3, 4].map(i => { const value = scale / 4 * i; return <g key={i}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#eeeef2" strokeDasharray={i ? '3 4' : undefined} /><text x={left - 10} y={y(value) + 4} textAnchor="end">{value === 0 ? '0' : (value / 10000).toLocaleString('ja-JP', { maximumFractionDigits: 1 }) + '万'}</text></g> })}
      <path d={area} fill="#eaf2fc" opacity=".8" />
      <path d={line('previous')} fill="none" stroke="#bdc5cf" strokeWidth="1.6" strokeDasharray="4 5" strokeLinejoin="round" />
      <path d={line('current')} fill="none" stroke="#0071e3" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((point, i) => ticks.has(i) ? <text key={i} x={x(i)} y={height - 9} textAnchor="middle">{point.label}</text> : null)}
      {active && selected !== null && <g><line x1={x(selected)} x2={x(selected)} y1={top} y2={y(0)} stroke="#b9cbe0" /><circle cx={x(selected)} cy={y(active.current)} r="4" fill="#0071e3" stroke="#fff" strokeWidth="2" /></g>}
    </svg>
    {active && <div className="hq-chart-tooltip" role="status">{active.label}<strong>¥{active.current.toLocaleString()}</strong></div>}
    <details className="hq-chart-details"><summary>数値で見る</summary><table><thead><tr><th>時点</th><th>選択期間</th><th>比較期間</th></tr></thead><tbody>{points.map(p => <tr key={p.label}><td>{p.label}</td><td>¥{p.current.toLocaleString()}</td><td>¥{p.previous.toLocaleString()}</td></tr>)}</tbody></table></details>
  </div>
}
