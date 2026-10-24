// V2.0 のホーム：カテゴリ（4つ）→ そのカテゴリのスタイルの写真を大きく → 「この髪型でAI予約する」（下のタブのすぐ上に固定）。
// 写真・カテゴリは今のスタイル図鑑のまま。値段は予約メニューの料金表（AI予約と同じ値段）、対応するメニューがないスタイルだけ手入力の値段。
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { loadStyles } from '../utils/styleStorage'
import { resolveStyleLibraryImageUrl } from '../data/styleLibraryImages'
import { UI_CATEGORIES } from '../data/styleCategories'
import { getReserveUrl, getStyleMenuCode } from '../data/reserveLinks'
import { ensurePriceRules, menuPrice } from '../utils/bookingCoupons'
import { requestJohnny } from '../features/johnny/bookingIntent'
import type { StyleCard } from '../data/styleCard'

const yen = (n: number) => `¥${n.toLocaleString()}`

/** そのスタイルの値段：予約メニューの料金表があればそちら（会員価格）、なければスタイルの手入力 */
function stylePrice(style: StyleCard): { price: number; normal: number | null } {
  const code = getStyleMenuCode(style.title)
  const live = code ? menuPrice(code) : null
  return live ?? { price: style.price, normal: null }
}

export function V2Home() {
  const reduce = useReducedMotion()
  const styles = useMemo(() => loadStyles().filter(s => s.isPublished), [])
  const [cat, setCat] = useState<string>(UI_CATEGORIES[0].id)
  const [index, setIndex] = useState(0)
  const [, setPricesReady] = useState(0)
  const rail = useRef<HTMLDivElement>(null)

  // 料金表を読み終えたら値段を出し直す
  useEffect(() => { let alive = true; void ensurePriceRules().then(() => { if (alive) setPricesReady(n => n + 1) }); return () => { alive = false } }, [])

  const list = useMemo(() => {
    const c = UI_CATEGORIES.find(x => x.id === cat) ?? UI_CATEGORIES[0]
    return c.titles.map(t => styles.find(s => s.title === t)).filter((s): s is StyleCard => !!s)
  }, [cat, styles])
  const selected = list.at(Math.min(index, list.length - 1)) ?? null

  const chooseCat = (id: string) => {
    setCat(id); setIndex(0)
    rail.current?.scrollTo({ left: 0, behavior: reduce ? 'auto' : 'smooth' })
  }
  // 真ん中に来たカードを「選んだスタイル」にする
  const onScroll = () => {
    const el = rail.current
    if (!el || !el.firstElementChild) return
    const w = (el.firstElementChild as HTMLElement).offsetWidth + 14
    setIndex(Math.max(0, Math.min(list.length - 1, Math.round(el.scrollLeft / w))))
  }

  const reserve = () => {
    if (!selected) { requestJohnny({ menuCode: null, label: '' }); return }
    requestJohnny({ menuCode: getStyleMenuCode(selected.title), label: selected.title })
  }

  return (
    <>
      <div className="v2-cats" role="tablist" aria-label="スタイルのカテゴリ">
        {UI_CATEGORIES.map(c => (
          <button key={c.id} type="button" role="tab" className="v2-cat v2-glass" aria-pressed={cat === c.id} aria-selected={cat === c.id} onClick={() => chooseCat(c.id)}>{c.id}</button>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={cat}
          initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -8 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
          <div className="v2-cards" ref={rail} onScroll={onScroll} aria-label={`${cat}のスタイル`}>
            {list.map((s, i) => {
              const p = stylePrice(s)
              return (
                <motion.article key={s.id} className="v2-card v2-glass" aria-current={i === index ? 'true' : undefined}
                  initial={reduce ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.32, delay: reduce ? 0 : Math.min(i, 4) * 0.05, ease: [0.22, 1, 0.36, 1] }}>
                  <div className="v2-card-photo"><img src={resolveStyleLibraryImageUrl(s)} alt={s.title} loading={i < 2 ? 'eager' : 'lazy'} decoding="async" /></div>
                  <div className="v2-card-body">
                    <h2 className="v2-card-name">{s.title}</h2>
                    {s.catchCopy && <p className="v2-card-copy">{s.catchCopy}</p>}
                    <div className="v2-card-meta">
                      <span className="v2-price">{yen(p.price)}</span>
                      {p.normal != null && p.normal !== p.price && <span className="v2-price-note">会員価格（通常 {yen(p.normal)}）</span>}
                    </div>
                  </div>
                </motion.article>
              )
            })}
          </div>
          {list.length > 1 && <div className="v2-dots" aria-hidden="true">{list.map((s, i) => <i key={s.id} className={i === index ? 'on' : ''} />)}</div>}
          {selected && getReserveUrl(selected.title) && (
            <p style={{ textAlign: 'center', margin: '6px 0 0' }}>
              <a href={getReserveUrl(selected.title)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'var(--v2-faint)' }}>HOT PEPPER Beauty で予約する</a>
            </p>
          )}
        </motion.div>
      </AnimatePresence>

      <button type="button" className="v2-cta v2-glass" onClick={reserve}>
        <span className="v2-cta-text">
          <b>{selected ? 'この髪型でAI予約する' : 'AI予約（Johnny に相談）'}</b>
          <small>{selected ? `${selected.title}・日時と担当をお聞きします` : '銀二郎専属AI Johnny が、日時と担当をお聞きします'}</small>
        </span>
        <span className="v2-cta-go" aria-hidden="true"><ArrowRight size={20} /></span>
      </button>
    </>
  )
}
