// アプリを開いたときのキャンペーン（10/30 慶一郎さん：APACHI を季節限定に）。ホームの上に写真を1枚大きく出し、「この髪型でAI予約する」か「閉じる」。
// アプリを開くたびに1回出す（タブを行き来しても出し直さない）。「次回から表示しない」にチェックして閉じたら、その端末ではもう出さない（10/30 慶一郎さん）。
// 次のキャンペーンは CAMPAIGN を書き換える（id を変えれば、前のを止めた人にも出る）。終わりの日は決めない（ホットペッパーからアパッチが消えたら CAMPAIGN を外す・10/30 慶一郎さん）
import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check } from 'lucide-react'
import { requestJohnny } from '../features/johnny/bookingIntent'
import { getStoredValue, setStoredValue } from '../utils/storage'
import { GachaShowcase } from './GachaShowcase'

type Campaign = {
  id: string; image: string; wide?: boolean; kaikin?: boolean; alt: string; label: string; kicker: string; title: string; lead?: string; detail: string[]
  action: { text: string; kind: 'johnny'; menuCode: string } | { text: string; kind: 'lineup' | 'gacha' }
}

const APACHI: Campaign = {
  id: 'apachi-2026-autumn',
  image: '/assets/styles/apachi.jpg',
  alt: 'APACHI　ショートピンパーマ × ホワイトメッシュ',
  label: 'APACHI',
  kicker: 'NEW MENU',
  title: '新メニュー登場',
  detail: ['季節限定', 'アパッチ', '¥18,000', '約4時間'],
  action: { text: 'この髪型でAI予約する', kind: 'johnny', menuCode: 'perm-apache' },
}

// ガチャの告知（11/5 慶一郎さん）。11/11 より前は予告（ラインナップを見せる）、11/11〜11/30 は「はじまりました」（ガチャへ）。
//   日付は Staging でも本当の日付で切り替える（予告を Staging で確かめられるように）。id が別なので、予告を止めた人にも開始の告知は出る
const GACHA_OPENS = '2026-11-11'
const GACHA_NEWS_UNTIL = '2026-11-30'
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
const GACHA_SOON: Campaign = {
  id: 'gacha-2026-11-soon', image: '/gacha/dino/wait.jpg?v=seam2', kaikin: true, alt: '', label: 'ガチャ',
  kicker: 'COMING SOON', title: '11月11日（水）ガチャ解禁',
  lead: 'APACHI・銀パラが無料になる券も入っています。',
  detail: ['毎日1回無料', 'ハズレなし', 'AI予約で使える'],
  action: { text: '今月のラインナップを見る', kind: 'lineup' },
}
const GACHA_OPEN: Campaign = {
  ...GACHA_SOON, id: 'gacha-2026-11-open', kicker: 'NEW', title: 'ガチャ、はじまりました',
  action: { text: 'ガチャを回す', kind: 'gacha' },
}
function pickCampaign(): Campaign {
  const d = jstToday()
  if (d < GACHA_OPENS) return GACHA_SOON
  if (d <= GACHA_NEWS_UNTIL) return GACHA_OPEN
  return APACHI
}
const CAMPAIGN = pickCampaign()
// 解禁までの日数（JST の日付どうし）
const daysLeft = () => Math.round((Date.parse(GACHA_OPENS) - Date.parse(jstToday())) / 86400e3)

// 「解禁」の告知（11/5 慶一郎さん「狩猟解禁みたいにカッコよく」）：暗い岩に光る足跡（恐竜編の絵）の上に、大きな「解禁」と日付・残りの日数だけ
function Kaikin({ reduce }: { reduce: boolean | null }) {
  const soon = jstToday() < GACHA_OPENS
  const n = daysLeft()
  const rise = (d: number) => reduce ? {} : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.7, delay: d, ease: [0.22, 1, 0.36, 1] as const } }
  return (
    <div className="v2-kaikin-stage">
      <motion.p className="v2-kaikin-date" {...rise(0.15)}>2026.11.11 WED</motion.p>
      <motion.h2 className="v2-kaikin-title" {...(reduce ? {} : { initial: { opacity: 0, scale: 1.12, letterSpacing: '0.5em' }, animate: { opacity: 1, scale: 1, letterSpacing: '0.12em' }, transition: { duration: 1.1, delay: 0.35, ease: [0.16, 1, 0.3, 1] as const } })}>
        <small>ガチャ</small>解禁
      </motion.h2>
      <motion.p className="v2-kaikin-count" {...rise(0.9)}>
        {soon ? (n <= 1 ? <>いよいよ<b>明日</b>解禁</> : <>解禁まで あと<b>{n}</b>日</>) : jstToday() === GACHA_OPENS ? <><b>本日</b>解禁</> : <>ただいま解禁中</>}
      </motion.p>
    </div>
  )
}
const HIDE_KEY = 'ginjiro_campaign_hidden'
let shownThisLaunch = false

export function V2Campaign({ onGacha }: { onGacha: () => void }) {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [hide, setHide] = useState(false)
  const [lineup, setLineup] = useState(false)

  // ホームが出てから少し待って出す（いきなり覆わない）
  useEffect(() => {
    if (shownThisLaunch || getStoredValue<string>(HIDE_KEY, '') === CAMPAIGN.id) return
    const img = new Image()
    img.src = CAMPAIGN.image
    const t = window.setTimeout(() => { shownThisLaunch = true; setOpen(true) }, 700)
    return () => window.clearTimeout(t)
  }, [])

  const close = () => { if (hide) setStoredValue(HIDE_KEY, CAMPAIGN.id); setOpen(false) }
  const act = () => {
    const a = CAMPAIGN.action
    if (a.kind === 'lineup') { setLineup(true); return } // ラインナップを閉じたら、告知に戻る
    close()
    if (a.kind === 'johnny') requestJohnny({ menuCode: a.menuCode, label: CAMPAIGN.label })
    else onGacha()
  }

  return (
    <>
    <AnimatePresence>
      {open && (
        <motion.div className="v2-campaign" role="dialog" aria-modal="true" aria-label={CAMPAIGN.label} onClick={close}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <motion.div className="v2-campaign-body" onClick={e => e.stopPropagation()}
            initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? undefined : { opacity: 0, y: 8 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
            {CAMPAIGN.kaikin ? (
              <div className="v2-kaikin" style={{ backgroundImage: `url(${CAMPAIGN.image})` }}><Kaikin reduce={reduce} /></div>
            ) : (
              <>
                <header className="v2-campaign-head">
                  <span>{CAMPAIGN.kicker}</span>
                  <h2>{CAMPAIGN.title}</h2>
                </header>
                <img src={CAMPAIGN.image} alt={CAMPAIGN.alt} className={CAMPAIGN.wide ? 'is-wide' : undefined} />
              </>
            )}
            {CAMPAIGN.lead && <p className="v2-campaign-lead">{CAMPAIGN.lead}</p>}
            <p className="v2-campaign-detail">{CAMPAIGN.detail.map(d => <span key={d}>{d}</span>)}</p>
            <button type="button" className="v2-campaign-go" onClick={act}>{CAMPAIGN.action.text}</button>
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
    {lineup && <GachaShowcase onClose={() => setLineup(false)} />}
    </>
  )
}
