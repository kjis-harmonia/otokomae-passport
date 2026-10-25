// V2.0 のホーム：カテゴリ（来店したことがあれば先頭に「いつもの」＝「漢は黙っていつもので」の1枚＋4つ）→ そのカテゴリのスタイルの写真を大きく → 「この髪型でAI予約する」（下のタブのすぐ上に固定）。
// 写真・カテゴリは今のスタイル図鑑のまま。値段は予約メニューの料金表（AI予約と同じ値段）、対応するメニューがないスタイルだけ手入力の値段。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Sparkle } from 'lucide-react'
import { loadStyles } from '../utils/styleStorage'
import { resolveStyleLibraryImageUrl } from '../data/styleLibraryImages'
import { UI_CATEGORIES } from '../data/styleCategories'
import { getReserveUrl, getStyleMenuCode } from '../data/reserveLinks'
import { ensurePriceRules, menuPrice } from '../utils/bookingCoupons'
import { requestJohnny } from '../features/johnny/bookingIntent'
import type { StyleCard } from '../data/styleCard'
import { V2GinpayBar } from './V2GinpayBar'
import { loadUsual, type Usual } from './usualPicks'

const yen = (n: number) => `¥${n.toLocaleString()}`

/** そのスタイルの値段：予約メニューの料金表があればそちら（会員価格）、なければスタイルの手入力 */
function stylePrice(style: StyleCard): { price: number; normal: number | null } {
  const code = getStyleMenuCode(style.title)
  const live = code ? menuPrice(code) : null
  return live ?? { price: style.price, normal: null }
}

const USUAL = 'いつもの'
const USUAL_POSTER = '/assets/styles/itsumono.jpg'

/** カードに並べるもの：スタイルの写真か、「いつもの」のポスター（メニューは来店の記録で分かるときだけ） */
type Item =
  | { key: string; kind: 'style'; style: StyleCard; code: string | null; label: string }
  | { key: string; kind: 'usual'; code: string | null; label: string; title: string | null }

function itemPrice(item: Item): { price: number; normal: number | null } | null {
  if (item.kind === 'style') return (item.code ? menuPrice(item.code) : null) ?? stylePrice(item.style)
  return item.code ? menuPrice(item.code) : null
}

export function V2Home({ onGinpay }: { onGinpay: () => void }) {
  const reduce = useReducedMotion()
  const styles = useMemo(() => loadStyles().filter(s => s.isPublished), [])
  const [cat, setCat] = useState<string>(UI_CATEGORIES[0].id)
  const [usual, setUsual] = useState<Usual>(null)
  const touched = useRef(false)
  const catsRail = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [, setPricesReady] = useState(0)
  const rail = useRef<HTMLDivElement>(null)

  // 料金表を読み終えたら値段を出し直す
  useEffect(() => { let alive = true; void ensurePriceRules().then(() => { if (alive) setPricesReady(n => n + 1) }); return () => { alive = false } }, [])
  // 来店したことがあれば「いつもの」を先頭に出して、まだカテゴリを触っていなければそこを開く
  useEffect(() => {
    let alive = true
    void loadUsual().then(u => {
      if (!alive || !u) return
      setUsual(u)
      if (!touched.current) { setCat(USUAL); setIndex(0) }
    })
    return () => { alive = false }
  }, [])
  // 先頭にチップが増えると、ブラウザは前に吸い付いていたチップ（昭和の漢）へ戻ろうとして「いつもの」が左に隠れる → 描いた直後に先頭へ
  useLayoutEffect(() => { if (usual) catsRail.current?.scrollTo({ left: 0 }) }, [usual])
  const cats = useMemo(() => [...(usual ? [USUAL] : []), ...UI_CATEGORIES.map(c => c.id)], [usual])

  const list = useMemo((): Item[] => {
    if (cat === USUAL && usual) return [{ key: 'usual', kind: 'usual', code: usual.menu?.code ?? null, label: usual.menu?.name ?? '', title: usual.menu?.title ?? null }]
    const c = UI_CATEGORIES.find(x => x.id === cat) ?? UI_CATEGORIES[0]
    return c.titles.map(t => styles.find(s => s.title === t)).filter((s): s is StyleCard => !!s)
      .map((s): Item => ({ key: s.id, kind: 'style', style: s, code: getStyleMenuCode(s.title), label: s.title }))
  }, [cat, styles, usual])
  const selected = list[Math.min(index, list.length - 1)] ?? null

  const chooseCat = (id: string) => {
    touched.current = true
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
    // いつものでメニューが分からないときは、メニューを決めずに Johnny（おかえりなさい から聞く）
    if (!selected) { requestJohnny({ menuCode: null, label: '' }); return }
    requestJohnny({ menuCode: selected.code, label: selected.label })
  }
  const price = selected ? itemPrice(selected) : null
  const hpTitle = selected?.kind === 'style' ? selected.style.title : selected?.title ?? null
  const hpUrl = hpTitle ? getReserveUrl(hpTitle) : undefined

  return (
    <>
      <div className="v2-pay-wrap"><V2GinpayBar onOpen={onGinpay} /></div>
      <div className="v2-cats" ref={catsRail} role="tablist" aria-label="スタイルのカテゴリ">
        {cats.map(id => (
          <button key={id} type="button" role="tab" className="v2-cat v2-glass" aria-pressed={cat === id} aria-selected={cat === id} onClick={() => chooseCat(id)}>{id}</button>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={cat} className="v2-stage"
          initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -8 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
          <div className="v2-cards" ref={rail} onScroll={onScroll} aria-label={`${cat}のスタイル`}>
            {list.map((item, i) => {
              const p = itemPrice(item)
              return (
                <motion.article key={item.key} className="v2-card v2-glass" aria-current={i === index ? 'true' : undefined}
                  initial={reduce ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.32, delay: reduce ? 0 : Math.min(i, 4) * 0.05, ease: [0.22, 1, 0.36, 1] }}>
                  {/* 写真が主役：髪型の名前は写真に入っているので、写真の上には何も載せない（名前・値段は読み上げ用。値段は下のAI予約ボタンに出す） */}
                  <div className="v2-card-photo">
                    <img src={item.kind === 'style' ? resolveStyleLibraryImageUrl(item.style) : USUAL_POSTER} alt="" loading={i < 2 ? 'eager' : 'lazy'} decoding="async" />
                    <h2 className="v2-sr">{item.kind === 'usual' ? `いつもの${item.label ? '（' + item.label + '）' : ''}` : item.label}{p ? `・${yen(p.price)}` : ''}</h2>
                  </div>
                </motion.article>
              )
            })}
          </div>
          {list.length > 1 && <div className="v2-dots" aria-hidden="true">{list.map((item, i) => <i key={item.key} className={i === index ? 'on' : ''} />)}</div>}
          {hpUrl && (
            <p style={{ textAlign: 'center', margin: '6px 0 0' }}>
              <a href={hpUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'var(--v2-faint)' }}>HOT PEPPER Beauty で予約する</a>
            </p>
          )}
        </motion.div>
      </AnimatePresence>

      <button type="button" className="v2-cta v2-glass" onClick={reserve}>
        <span className="v2-cta-spark" aria-hidden="true"><Sparkle size={22} strokeWidth={1.6} /></span>
        <span className="v2-cta-text">
          <b>{!selected ? 'AI予約（Johnny に相談）' : selected.kind === 'usual' ? 'いつものでAI予約する' : 'この髪型でAI予約する'}</b>
          <small>{!selected ? '銀二郎専属AI Johnny がお聞きします'
            : selected.kind === 'usual' && !selected.code ? '銀二郎専属AI Johnny がお聞きします'
            : price ? <>{selected.kind === 'usual' ? selected.label + '　' : ''}<span className="v2-cta-price">{yen(price.price)}</span>{price.normal != null && price.normal !== price.price ? '　会員価格' : ''}</> : selected.label}</small>
        </span>
        <span className="v2-cta-go" aria-hidden="true"><ArrowRight size={20} /></span>
      </button>
    </>
  )
}
