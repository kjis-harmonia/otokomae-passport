// アプリを開いたときのキャンペーン（10/30 慶一郎さん：APACHI を季節限定に）。ホームの上に写真を1枚大きく出し、「この髪型でAI予約する」か「閉じる」。
// アプリを開くたびに1回出す（タブを行き来しても出し直さない）。「次回から表示しない」にチェックして閉じたら、その端末ではもう出さない（10/30 慶一郎さん）。
// 次のキャンペーンは CAMPAIGN を書き換える（id を変えれば、前のを止めた人にも出る）。終わりの日は決めない（ホットペッパーからアパッチが消えたら CAMPAIGN を外す・10/30 慶一郎さん）
import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check } from 'lucide-react'
import { requestJohnny } from '../features/johnny/bookingIntent'
import { getStoredValue, setStoredValue } from '../utils/storage'

const CAMPAIGN = {
  id: 'apachi-2026-autumn',
  image: '/assets/styles/apachi.jpg',
  alt: 'APACHI　ショートピンパーマ × ホワイトメッシュ',
  menuCode: 'perm-apache',
  label: 'APACHI',
  kicker: 'NEW MENU',
  title: '新メニュー登場',
  detail: ['季節限定', 'アパッチ', '¥18,000', '約4時間'],
}
const HIDE_KEY = 'ginjiro_campaign_hidden'
let shownThisLaunch = false

export function V2Campaign() {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [hide, setHide] = useState(false)

  // ホームが出てから少し待って出す（いきなり覆わない）
  useEffect(() => {
    if (shownThisLaunch || getStoredValue<string>(HIDE_KEY, '') === CAMPAIGN.id) return
    const img = new Image()
    img.src = CAMPAIGN.image
    const t = window.setTimeout(() => { shownThisLaunch = true; setOpen(true) }, 700)
    return () => window.clearTimeout(t)
  }, [])

  const close = () => { if (hide) setStoredValue(HIDE_KEY, CAMPAIGN.id); setOpen(false) }
  const reserve = () => { close(); requestJohnny({ menuCode: CAMPAIGN.menuCode, label: CAMPAIGN.label }) }

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="v2-campaign" role="dialog" aria-modal="true" aria-label={CAMPAIGN.label} onClick={close}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <motion.div className="v2-campaign-body" onClick={e => e.stopPropagation()}
            initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? undefined : { opacity: 0, y: 8 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
            <header className="v2-campaign-head">
              <span>{CAMPAIGN.kicker}</span>
              <h2>{CAMPAIGN.title}</h2>
            </header>
            <img src={CAMPAIGN.image} alt={CAMPAIGN.alt} />
            <p className="v2-campaign-detail">{CAMPAIGN.detail.map(d => <span key={d}>{d}</span>)}</p>
            <button type="button" className="v2-campaign-go" onClick={reserve}>この髪型でAI予約する</button>
            <div className="v2-campaign-foot">
              <label className="v2-campaign-hide">
                <input type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)} />
                <i aria-hidden="true">{hide && <Check size={14} strokeWidth={3} />}</i>
                次回から表示しない
              </label>
              <button type="button" className="v2-campaign-close" onClick={close}>閉じる</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
