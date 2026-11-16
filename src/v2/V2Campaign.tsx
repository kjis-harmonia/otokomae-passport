// アプリを開いたときのキャンペーン（10/30 慶一郎さん：APACHI を季節限定に）。ホームの上に写真を1枚大きく出し、「この髪型でAI予約する」か「閉じる」。
// アプリを開くたびに1回出す（タブを行き来しても出し直さない）。「次回から表示しない」にチェックして閉じたら、その端末ではもう出さない（10/30 慶一郎さん）。
// 次のキャンペーンは CAMPAIGN を書き換える（id を変えれば、前のを止めた人にも出る）。終わりの日は決めない（ホットペッパーからアパッチが消えたら CAMPAIGN を外す・10/30 慶一郎さん）
import { isStaging } from '../utils/env'
import { launched, launchHm } from '../utils/launch'
import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check } from 'lucide-react'
import { requestJohnny } from '../features/johnny/bookingIntent'
import { ginFlow } from '../utils/env'
import { getStoredValue, setStoredValue } from '../utils/storage'
import { GachaShowcase } from './GachaShowcase'
import { useThemeColor } from '../utils/themeColor'
import { MEMBER_ISSUED_AT_KEY } from '../utils/userId'

/** 登録したばかり（6時間以内）：Welcome クーポン・使い方の案内と重ならないよう、お知らせは次に開いたときに（11/10 夜の点検） */
function justRegistered(): boolean {
  const at = Date.parse(getStoredValue<string | null>(MEMBER_ISSUED_AT_KEY, null) ?? '')
  return Number.isFinite(at) && Date.now() - at < 6 * 3600_000
}

type Campaign = {
  id: string; image: string; wide?: boolean; kaikin?: boolean; blackMonday?: boolean; alt: string; label: string; kicker: string; title: string; lead?: string; detail: string[]
  action?: { text: string; kind: 'johnny'; menuCode: string } | { text: string; kind: 'lineup' | 'gacha' | 'book' }
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

// Black Monday（11/17 オーナー決定）：毎週月曜・アプリ予約限定でパーマ ¥2,000 OFF。写真は使わず、黒地に文字だけの告知。
//   「AI予約する」は銀ちゃん（メニューは決めずに始める）。額・対象メニューの正はサーバーの設定（app_private.black_monday_settings）
const BLACK_MONDAY_STARTS = '2026-11-23'
const BLACK_MONDAY_MENUS = ['パンチパーマ', '濡れパン', 'アイパー', 'カーリーパーマ', 'スペインパーマ', 'ツイストパーマ', 'ピンパーマ']
const BLACK_MONDAY: Campaign = {
  id: 'black-monday-2026', image: '', blackMonday: true, alt: '', label: 'Black Monday', kicker: '', title: '',
  detail: [], action: { text: 'AI予約する', kind: 'book' },
}

// ガチャの告知（11/5 慶一郎さん）。11/11 より前は予告（ラインナップを見せる）、11/11〜11/30 は「はじまりました」（ガチャへ）。
//   日付は Staging でも本当の日付で切り替える（予告を Staging で確かめられるように）。id が別なので、予告を止めた人にも開始の告知は出る
const GACHA_OPENS = '2026-11-11'
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
const GACHA_SOON: Campaign = {
  id: 'gacha-2026-11-soon', image: '/gacha/dino/wait.jpg?v=seam2', kaikin: true, alt: '', label: 'ガチャ',
  kicker: 'COMING SOON', title: '11月11日（水）ガチャ解禁',
  lead: 'APACHI・銀パラが無料になる券も入っています。',
  detail: ['毎日1回無料', 'ハズレなし', 'AI予約で使える'],
  // 解禁日までは中身（ラインナップ）を見せない。ボタンは出さず「閉じる」だけ（11/6 慶一郎さん）
}
function pickCampaign(): Campaign | null {
  const d = jstToday()
  // 当日も 12:00（launched）までは予告のまま。タイトルは「本日 12:00 ガチャ解禁」・ボタンなし（11/11）
  if (d === GACHA_OPENS && !launched() && !isStaging()) return { ...GACHA_SOON, id: 'gacha-2026-11-today', title: `本日 ${launchHm()} ガチャ解禁` }
  if (d < GACHA_OPENS) return GACHA_SOON
  // 「ガチャ、はじまりました」の告知は 11/12 で終わり（慶一郎さん「告知ポップ消していいよ」）。
  // 11/17 から Black Monday の告知（11/30 以降に出す予定だった APACHI より優先・オーナー決定）
  return BLACK_MONDAY
}
const PICKED = pickCampaign()
/** 今出すお知らせがあるか（無ければホームに何も重ねない） */
export const hasCampaign = PICKED !== null
const CAMPAIGN = PICKED ?? APACHI
// 解禁までの日数（JST の日付どうし）
const daysLeft = () => Math.round((Date.parse(GACHA_OPENS) - Date.parse(jstToday())) / 86400e3)

/** Black Monday の告知：黒地に白い文字、金は細い線と小さな見出しだけ（写真なしで成り立つ） */
function BlackMondayPoster() {
  const soon = jstToday() < BLACK_MONDAY_STARTS
  const [more, setMore] = useState(false)
  // 日本語は Noto Sans JP（iPhone には入っていないので、この告知を開いたときだけ読み込む・11/17 慶一郎さん）
  useEffect(() => {
    if (document.getElementById('noto-sans-jp')) return
    const link = document.createElement('link')
    link.id = 'noto-sans-jp'
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600&display=swap'
    document.head.appendChild(link)
  }, [])
  // 11/17 慶一郎さんの見本どおり：黒のカードに白い文字（金の文字は白に）。大きな ¥2,000 OFF と、対象メニュー・利用条件は押して開く
  // 11/17 慶一郎さんの見本の並び：一番上は必ず「毎週月曜日だけの特別なご案内」→ Black Monday → ¥2,000OFF（1行）→ アプリからのご予約限定 → 開始日。
  //   書体は見本をまねない（英字・数字は SF、日本語は Noto Sans JP）
  return (
    <div className="v2-bm">
      <p className="v2-bm-eyebrow">毎週月曜日だけの特別なご案内</p>
      <h2 className="v2-bm-title">Black Monday</h2>
      <span className="v2-bm-rule" aria-hidden="true" />
      <p className="v2-bm-price" aria-label="パーマ 2,000円オフ"><b>¥2,000</b><span>OFF</span></p>
      <p className="v2-bm-only">パーマ・アプリからのご予約限定</p>
      <hr className="v2-bm-hr" />
      {soon && <p className="v2-bm-start">{Number(BLACK_MONDAY_STARTS.slice(5, 7))}月{Number(BLACK_MONDAY_STARTS.slice(8, 10))}日（月・祝）より開始</p>}
      <button type="button" className="v2-bm-more" aria-expanded={more} onClick={() => setMore(v => !v)}>
        {more ? '閉じる' : '対象メニュー・利用条件'}<span aria-hidden="true">{more ? '−' : '›'}</span>
      </button>
      {more && (
        <div className="v2-bm-detail">
          <p className="v2-bm-detail-h">対象メニュー</p>
          <p className="v2-bm-menus">{BLACK_MONDAY_MENUS.map((m, i) => <span key={m}>{m}{i < BLACK_MONDAY_MENUS.length - 1 ? '、' : ''}</span>)}</p>
          <p className="v2-bm-detail-h">利用条件</p>
          <ul className="v2-bm-rules">
            <li>毎週月曜（祝日を含む）のご来店が対象です。</li>
            <li>アプリ（銀ちゃん）でのご予約に限ります。お電話・HOT PEPPER・当日のご来店は対象外です。</li>
            <li>対象メニュー1つにつき ¥2,000 を、お会計で差し引きます。</li>
            <li>Welcome クーポン・再来店パーマクーポンとは一緒に使えません。ガチャ券とは一緒に使えます。</li>
          </ul>
        </div>
      )}
    </div>
  )
}

// 「解禁」の告知（11/5 慶一郎さん「狩猟解禁みたいにカッコよく」）：暗い岩に光る足跡（恐竜編の絵）の上に、大きな「解禁」と日付・残りの日数だけ
function Kaikin({ reduce }: { reduce: boolean | null }) {
  const soon = jstToday() < GACHA_OPENS
  const n = daysLeft()
  const rise = (d: number) => reduce ? {} : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.7, delay: d, ease: [0.22, 1, 0.36, 1] as const } }
  return (
    <div className="v2-kaikin-stage">
      <motion.p className="v2-kaikin-date" {...rise(0.15)}>2026.11.11 WED</motion.p>
      <motion.h2 className="v2-kaikin-title" {...(reduce ? {} : { initial: { opacity: 0, scale: 1.25 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.55, delay: 0.35, ease: [0.2, 1.4, 0.4, 1] as const } })}>
        {/* 筆文字の「解禁」（11/5 慶一郎さんが GPT で作った書）。読み上げは文字で */}
        <small>ガチャ</small><img src="/gacha/kaikin-brush.png" alt="解禁" draggable={false} />
      </motion.h2>
      <motion.p className="v2-kaikin-count" {...rise(0.9)}>
        {soon ? (n <= 1 ? <>いよいよ<b>明日</b>解禁</> : <>解禁まで あと<b>{n}</b>日</>) : jstToday() === GACHA_OPENS ? (launched() ? <><b>本日</b>解禁</> : <><b>本日 {launchHm()}</b> 解禁</>) : <>ただいま解禁中</>}
      </motion.p>
    </div>
  )
}
const HIDE_KEY = 'ginjiro_campaign_hidden'
let shownThisLaunch = false

export function V2Campaign({ onGacha }: { onGacha: () => void }) {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  // 開いている間は、上の帯（時計・電池）も暗い色に（11/6「上部、見切れてる」）
  useThemeColor(open ? '#3c3a36' : null)
  const [hide, setHide] = useState(false)
  const [lineup, setLineup] = useState(false)

  // ホームが出てから少し待って出す（いきなり覆わない）
  useEffect(() => {
    // 新しい銀二郎の公開の直後（解禁→銀ちゃんの案内）は、この起動ではキャンペーンを重ねない（11/11）
    let guided = false
    try { guided = !!sessionStorage.getItem('ginjiro_launch_guided') } catch { /* なし */ }
    if (shownThisLaunch || guided || getStoredValue<string>(HIDE_KEY, '') === CAMPAIGN.id || justRegistered()) return
    // 写真の無い告知（Black Monday）は読み込むものが無い
    if (CAMPAIGN.image) new Image().src = CAMPAIGN.image
    if (CAMPAIGN.kaikin) new Image().src = '/gacha/kaikin-brush.png'
    const t = window.setTimeout(() => { shownThisLaunch = true; setOpen(true) }, 700)
    return () => window.clearTimeout(t)
  }, [])

  const close = () => { if (hide) setStoredValue(HIDE_KEY, CAMPAIGN.id); setOpen(false) }
  const act = () => {
    const a = CAMPAIGN.action
    if (!a) return
    if (a.kind === 'lineup') { setLineup(true); return } // ラインナップを閉じたら、告知に戻る
    close()
    // メニューを決めずに AI予約（銀ちゃんが「どなたの・何を」から聞く）
    if (a.kind === 'book') {
      if (ginFlow()) window.dispatchEvent(new CustomEvent('ginjiro:gin-book', { detail: { menuCode: null, label: '' } }))
      else requestJohnny({ menuCode: null, label: '' })
      return
    }
    // Staging：AI予約は銀ちゃんの会話（髪型のメニューを入れて始める）。本番は承認のあと
    if (a.kind === 'johnny' && ginFlow()) window.dispatchEvent(new CustomEvent('ginjiro:gin-book', { detail: { menuCode: a.menuCode, label: CAMPAIGN.label } }))
    else if (a.kind === 'johnny') requestJohnny({ menuCode: a.menuCode, label: CAMPAIGN.label })
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
            {CAMPAIGN.blackMonday ? <BlackMondayPoster /> : CAMPAIGN.kaikin ? (
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
            {CAMPAIGN.action && <button type="button" className="v2-campaign-go" onClick={act}>{CAMPAIGN.action.text}</button>}
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
