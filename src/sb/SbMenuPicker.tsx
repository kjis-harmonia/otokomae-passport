// メニューの選び方：種類のタブ（よく使う・カット・カラー・パーマ…）＋2列の小さなボタン。選んだものは上にまとめて×で外せる。
// 「よく使う」はこの端末で予約に使った回数の多い順（端末の中だけに覚える。予約や料金には関係しない）。
import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { yen } from '../utils/bookingApi'
import { readMenuUsage } from './sbMenuUsage'

interface Menu { code: string; name: string; category: string | null; price: number | null; duration_min: number }

const FAVORITES = 'よく使う'
const MAX = 5

export function SbMenuPicker({ menus, codes, onChange }: { menus: readonly Menu[]; codes: string[]; onChange: (codes: string[]) => void }) {
  const [query, setQuery] = useState('')
  const favorites = useMemo(() => {
    const u = readMenuUsage()
    return menus.filter(m => (u[m.code] ?? 0) > 0).sort((a, b) => (u[b.code] ?? 0) - (u[a.code] ?? 0)).slice(0, 8)
  }, [menus])
  const categories = useMemo(() => {
    const seen: string[] = []
    for (const m of menus) { const c = m.category ?? 'その他'; if (!seen.includes(c)) seen.push(c) }
    return favorites.length ? [FAVORITES, ...seen] : seen
  }, [menus, favorites])
  const [tab, setTab] = useState(() => categories[0] ?? '')

  const q = query.trim()
  const shown = q ? menus.filter(m => `${m.name}${m.category ?? ''}`.includes(q))
    : tab === FAVORITES ? favorites
    : menus.filter(m => (m.category ?? 'その他') === tab)
  const selected = codes.map(c => menus.find(m => m.code === c)).filter((m): m is Menu => !!m)
  const toggle = (code: string) => onChange(codes.includes(code) ? codes.filter(c => c !== code) : codes.length >= MAX ? codes : [...codes, code])
  const total = selected.reduce((s, m) => ({ min: s.min + m.duration_min, yen: s.yen + (m.price ?? 0) }), { min: 0, yen: 0 })

  return (
    <div className="sb-picker">
      {selected.length > 0 && (
        <div className="sb-picker-selected" aria-label="選んだメニュー">
          {selected.map(m => (
            <button key={m.code} type="button" className="sb-picker-chip" onClick={() => toggle(m.code)} aria-label={`${m.name}を外す`}>
              {m.name}<X size={14} />
            </button>
          ))}
          <span className="sb-picker-total">{total.min}分・{yen(total.yen)}</span>
        </div>
      )}
      <label className="sb-search"><Search size={18} />
        <input aria-label="メニューを検索" value={query} onChange={e => setQuery(e.target.value)} placeholder="メニューを検索" />
      </label>
      {!q && (
        <div className="sb-picker-tabs" role="tablist" aria-label="メニューの種類">
          {categories.map(c => (
            <button key={c} type="button" role="tab" aria-selected={tab === c} onClick={() => setTab(c)}>{c}</button>
          ))}
        </div>
      )}
      <div className="sb-picker-grid">
        {shown.map(m => {
          const on = codes.includes(m.code)
          return (
            <button key={m.code} type="button" className="sb-picker-item" aria-pressed={on} disabled={!on && codes.length >= MAX} onClick={() => toggle(m.code)}>
              <span className="sb-picker-name">{m.name}</span>
              <span className="sb-picker-meta">{m.duration_min}分・{yen(m.price)}</span>
            </button>
          )
        })}
        {!shown.length && <p className="sb-muted">該当するメニューがありません</p>}
      </div>
    </div>
  )
}
