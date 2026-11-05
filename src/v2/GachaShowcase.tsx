// 今月のラインナップ（11/5 慶一郎さん「景品を一枚ずつ鑑賞できる3D立体カルーセル」「Apple のこの見せ方がかっちょえー」）
// Apple の製品の並べ方のように、明るい面の上に景品の券を1枚ずつ大きく置き、横にすべらせて見ていく。
// まん中の券は正面を向いて大きく、となりの券は少し奥へ回って小さくなる（指の動きにそのまま付いてくる）。止まると1枚ずつぴたっと止まる。
// 券の見た目：大当たりは金、当たりは銀、そのほかは白。確率は出さない（「ハズレなし」だけ添える）。動きを減らす設定では回転をつけない
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { loadLineup, type GachaPrize } from '../features/gacha/gachaApi'

const RANK: Record<GachaPrize['rank'], string> = { legend: '大当たり', rare: '当たり', normal: '' }
// 髪型の券は、ホーム・スタイルと同じ髪型の写真をパネルにする（11/5 慶一郎さん「せっかく画像あるけん」）。写真の無い券は券の絵
const PHOTO: Record<string, string> = {
  'free-nigro': '/assets/styles/library-nigro.jpg',
  'free-punch': '/assets/styles/library-punch-perm.jpg',
  'free-aipa': '/assets/styles/library-curl-iper.jpg',
  'free-ginpara': '/assets/styles/ginpara-v2.jpg',
  'free-apachi': '/assets/styles/apachi.jpg',
  'teitei1000': '/assets/styles/library-teitei.jpg',
}

export function GachaShowcase({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<GachaPrize[] | 'error' | null>(null)
  const [index, setIndex] = useState(0)
  const track = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    loadLineup().then(l => { if (live) setList(l) }).catch(() => { if (live) setList('error') })
    return () => { live = false }
  }, [])

  // 閉じるキー・裏のスクロールを止める
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = prev }
  }, [onClose])

  const items = Array.isArray(list) ? list : []

  // すべらせた量から、券ごとの回転・大きさ・奥行きを決める（まん中＝正面）
  const layout = useCallback(() => {
    const el = track.current
    if (!el) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const mid = el.scrollLeft + el.clientWidth / 2
    let best = 0, bestD = Infinity
    el.querySelectorAll<HTMLElement>('[data-i]').forEach(c => {
      const center = c.offsetLeft + c.offsetWidth / 2
      const d = (center - mid) / c.offsetWidth // 0＝まん中、±1＝となり
      const k = Math.max(-1.6, Math.min(1.6, d))
      const obj = c.firstElementChild as HTMLElement | null
      if (obj) {
        obj.style.transform = still ? `scale(${1 - Math.min(1, Math.abs(k)) * 0.18})`
          : `translateZ(${-Math.abs(k) * 120}px) rotateY(${-k * 38}deg) scale(${1 - Math.min(1, Math.abs(k)) * 0.12})`
        obj.style.opacity = String(1 - Math.min(1, Math.abs(k)) * 0.35)
      }
      if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = Number(c.dataset.i) }
    })
    setIndex(best)
  }, [])

  useEffect(() => {
    if (!items.length) return
    layout()
    const el = track.current
    let raf = 0
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout) }
    el?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => { cancelAnimationFrame(raf); el?.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll) }
  }, [items.length, layout])

  const go = (i: number) => {
    const el = track.current
    const c = el?.querySelector<HTMLElement>(`[data-i="${i}"]`)
    if (el && c) el.scrollTo({ left: c.offsetLeft + c.offsetWidth / 2 - el.clientWidth / 2, behavior: 'smooth' })
  }
  const now = items[index]

  return (
    <div className="v2-showcase" role="dialog" aria-modal="true" aria-label="今月のラインナップ">
      <button type="button" className="v2-showcase-close" onClick={onClose} aria-label="閉じる"><X size={22} /></button>
      <h2>今月のラインナップ</h2>
      <p className="v2-showcase-sub">毎日1回・ハズレなし</p>
      {list === null && <p className="v2-showcase-msg">読み込んでいます…</p>}
      {list === 'error' && <p className="v2-showcase-msg">表示できませんでした。電波のよい所で開き直してください。</p>}
      {items.length > 0 && (
        <>
          <div className="v2-showcase-track" ref={track}>
            {items.map((p, i) => (
              <div key={p.code} data-i={i} className="v2-showcase-slot" onClick={() => i !== index && go(i)}>
                {PHOTO[p.code] ? (
                  <div className={`v2-showcase-ticket is-photo is-${p.rank}`} aria-hidden={i !== index}>
                    <img src={PHOTO[p.code]} alt="" loading={i < 3 ? 'eager' : 'lazy'} decoding="async" draggable={false} />
                    {RANK[p.rank] && <em>{RANK[p.rank]}</em>}
                  </div>
                ) : (
                  <div className={`v2-showcase-ticket is-${p.rank}`} aria-hidden={i !== index}>
                    <span className="v2-showcase-brand">GINJIRO</span>
                    <b>{p.title}</b>
                    {RANK[p.rank] && <em>{RANK[p.rank]}</em>}
                  </div>
                )}
              </div>
            ))}
          </div>
          {now && (
            <div className="v2-showcase-caption" aria-live="polite">
              <b>{now.title}</b>
              <small>{now.free_menu ? `${now.free_menu}が1回無料` : `お会計から${(now.amount ?? 0).toLocaleString('ja-JP')}円引き`}・{now.weekday_only ? '平日のみ' : '土日もご利用いただけます'}</small>
            </div>
          )}
          <div className="v2-showcase-dots" aria-hidden="true">{items.map((p, i) => <i key={p.code} className={i === index ? 'on' : ''} />)}</div>
        </>
      )}
      <p className="v2-showcase-fine">ガチャ券は30日間有効・AI予約でご利用いただけます。</p>
    </div>
  )
}
