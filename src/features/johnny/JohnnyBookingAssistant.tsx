// 予約アシスタント（JOHNNY）。「いつのご来店をご希望ですか？」から、確認の「はい」まで一直線に案内する。
//   いつ → （メニュー）→ 空き枠の確認 → 提案 → この日時でお間違いないですか？ → はい → 予約完了
// お客様の言葉は、まず予約の AI（Edge Function johnny-agent）が読む。AI は DB で確かめた空き・予約だけを提案し、
// 予約・キャンセル・変更は確認画面の「はい」でアプリが RPC で行う。AI が使えないときは、決まった規則（visitParser）の
// 案内に切り替える。空き枠・仮押さえ・確定はどちらも DB の予約エンジン（customer_* RPC）が決める。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, ChevronLeft, Keyboard, Mic, Volume2, VolumeX, X } from 'lucide-react'
import { RpcError } from '../../utils/staffSession'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../../data/wallet'
import { PreviousTicketsBindDialog } from '../../components/PreviousTicketsBind'
import { normalizePhone } from '../../utils/customerContact'
import { bookingAssistantApi, type AiBookingStatus, type AssistantOptions, type BookingAssistantApi, type CustomerReservation, type HoldOffer } from './bookingAssistantApi'
import { matchMenu, type MenuOption } from './menuMatcher'
import { answerMenuInfo, detectAsk } from './askIntent'
import { planOffer, type Offer, type Slot, jstMinutes } from './slotPlanner'
import { isEmptyRequest, parseVisitRequest, parseYesNo, type VisitRequest } from './visitParser'
import { forgetReservation, formatVisit, pickNext, rememberReservation } from './nextReservation'
import { clearCurrentReservation, loadCurrentReservation } from '../../utils/currentReservation'
import { heldFor, holdGinpay, useGinpayHolds, type GinpayHoldSummary } from '../ginpay/holds'
import type { AgentAnswer, AgentShown, AgentTurn } from './agentClient'
import { useVoice } from './useVoice'
import { adviseDay, adviceSpeech, spreadSlots, type DayAdvice } from './dayAdvisor'
import { JohnnyRider, type OrbState } from './JohnnyRider'
import { planCompanion } from './partyPlanner'
import { buildWelcome, welcomeText, type Welcome } from './welcome'
import { takeAiTurn } from './aiQuota'
import { PushToggle } from '../../components/PushToggle'
import { canBeUsual, getUsualMenu, getUsualStaff, setUsualMenu, setUsualStaff, usualMenuOrder } from './usualMenu'
import { pushState } from '../../utils/webPush'
import { MAINTENANCE_CUT_URL } from '../../data/reserveLinks'
import type { TicketRow } from '../../data/ticket'
import { TICKET_TYPE_LABELS } from '../../data/ticket'
import { clearCouponPlan, priceFor, saveCouponPlan, usableTickets, yen as yenOf, type PriceBreakdown } from '../../utils/bookingCoupons'
import { suspendBgm } from '../../audio/bgm'
import { observeVisibleViewport } from '../../utils/visibleViewport'
import { infoRequest, isMaintenanceBookingRequest, type InfoRequest } from './infoRequest'
import { getCustomerGinpayLedger } from '../../utils/ginpayApi'
import { getDaysUntilRecommended, getNextRecommendedDate } from '../../utils/maintenanceSchedule'

// ── 見た目（黒・白・グレーだけ） ─────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Hiragino Sans", "Noto Sans JP", sans-serif'
// V2.0：パールホワイトの画面（文字は墨色、面は白、主なボタンは墨色）。バイクの Johnny は角丸の黒い枠の中
const C = {
  bg: '#F5F2EC',
  text: '#1F1C18',
  secondary: 'rgba(31,28,24,0.6)',
  tertiary: 'rgba(31,28,24,0.35)',
  fill: '#FFFFFF',
  fillPressed: '#EFEBE3',
  separator: 'rgba(31,28,24,0.12)',
  danger: '#C2362F',
}

// ── 会話の段階 ─────────────────────────────────────────────────

type Step =
  | { k: 'loading' }
  | { k: 'contact'; name: string }
  /** 2回目以降：おかえりなさい（前回からの日数・メンテナンスカットの期限・いつものメニュー） */
  | { k: 'welcome'; w: Welcome }
  | { k: 'askWhen'; again?: 'unclear' | 'retry' | 'none' | 'menu'; menu?: MenuOption; label?: string }
  | { k: 'askMenu'; req: VisitRequest }
  /** その日の空き状況を先に見て、入れられるメニューと時刻を案内（note：希望の日が埋まっていて別の日にしたときの一言） */
  | { k: 'overview'; req: VisitRequest; advice: DayAdvice; note?: string }
  | { k: 'searching'; label?: string }
  | { k: 'pick'; req: VisitRequest; menu: MenuOption; offer: Offer; note?: string; wholeDay?: boolean }
  /** 予約の確認。staffId：指名、change：この予約を新しい日時に変える、say：AI の言葉 */
  | { k: 'confirm'; req: VisitRequest; menu: MenuOption; slot: Slot; staffId?: string | null; change?: CustomerReservation; say?: string; staffChosen?: boolean; usualStaff?: boolean }
  /** 担当（指名）を選ぶ：確定の前に必ず聞く。avail はその時間にその担当が空いているか */
  | { k: 'pickStaff'; next: ConfirmStep; avail?: Record<string, boolean>; note?: string }
  | { k: 'booking'; menu: MenuOption; slot: Slot }
  | { k: 'done'; reservation: CustomerReservation; changedFrom?: CustomerReservation; oldKept?: boolean; companion?: CustomerReservation; companionFailed?: boolean; ginpay?: number | 'failed' }
  /** お連れ様：メニューを聞く → 2人分の確認（お連れ様は予約者の時間から一番早く。togetherAt：お二人同時に入れる時刻） */
  | { k: 'companionMenu'; primary: PartyPrimary }
  /** ホームの「いつもの」から来たが、いつものメニューが分からない：声かボタンで教えてもらって登録する */
  | { k: 'askUsual'; note?: string }
  /** いつものメニューを登録した：メンテナンスカットのお知らせも受け取るか → そのメニューで日時へ */
  | { k: 'usualSaved'; menu: MenuOption; failed?: boolean }
  | { k: 'confirmParty'; primary: PartyPrimary; companion: { menu: MenuOption; slot: Slot }; togetherAt: string | null }
  /** AI の返事（話す言葉と、出す一覧） */
  | { k: 'ai'; say: string; view: AiView }
  | { k: 'confirmCancel'; reservation: CustomerReservation; say: string }
  | { k: 'cancelling'; reservation: CustomerReservation }
  | { k: 'cancelled'; reservation: CustomerReservation }
  | { k: 'unknown'; menu: MenuOption; slot: Slot }
  | { k: 'unavailable'; reason: 'booking_disabled' | 'auth' | 'network' }
  /** キャンセル待ちのお知らせから開いた：押さえている枠を確定するか */
  | { k: 'offer'; hold: HoldOffer; busy?: boolean }
  /** お知らせの枠が、もう押さえられていない（時間切れ・予約済み） */
  | { k: 'offerGone'; reason: 'expired' | 'booked' }

interface PartyPrimary { menu: MenuOption; slot: Slot; staffId: string | null; req: VisitRequest; replace?: CustomerReservation }

/** お連れ様の予約（端末に覚えて、一覧・確認で「お連れ様」と出す） */
const COMPANION_KEY = 'ginjiro_companion_reservations'
function companionIds(): string[] {
  try { const v = JSON.parse(localStorage.getItem(COMPANION_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
function rememberCompanion(id: string): void {
  try { localStorage.setItem(COMPANION_KEY, JSON.stringify([...companionIds(), id].slice(-30))) } catch { /* 表示用なので保存できなくても続ける */ }
}
/** お連れ様の話（確認画面で「息子の分も」「もう1人」など） */
const COMPANION_WORDS = /もう1人|もう一人|もう1名|もう一名|お連れ|連れ|息子|娘|子供|こども|子ども|嫁|妻|旦那|主人|友達|友人|2人|二人|ふたり|2名|二名/

type AiView =
  | { kind: 'talk'; handoff: boolean }
  | { kind: 'menus'; date: string | null; items: { menu: MenuOption; first: string | null }[] }
  | { kind: 'slots'; menu: MenuOption; staffId: string | null; slots: Slot[] }
  | { kind: 'reservations'; list: CustomerReservation[] }
  /** メンテナンスカット（ホットペッパーのクーポンで予約） */
  | { kind: 'maintenance' }
  | { kind: 'maintenanceChoice' }
  /** キャンセル待ちに入れるか */
  | { kind: 'waitlist'; menu: MenuOption; staffId: string | null; date: string; from: string; to: string }

interface Props {
  onClose: () => void
  onShowQr?: () => void
  /** スタイルの「予約する」から：このメニューを入れて始める（日時 → 担当を聞く） */
  initialMenuCode?: string | null
  /** スタイルの名前（メニューに対応しない髪型・メニューが休止中のときに、Johnny へ髪型の名前だけ伝える） */
  initialLabel?: string | null
  /** ホームの「いつもの」から（メニューが分からなければ、いつものメニューを聞いて登録する） */
  initialUsual?: boolean
}

/** 「戻る」で戻れる画面（読み込み中・送信中・終わった画面は数えない） */
const BACKABLE = new Set<Step['k']>(['welcome', 'askWhen', 'askMenu', 'overview', 'pick', 'confirm', 'pickStaff', 'companionMenu', 'confirmParty', 'ai', 'askUsual', 'usualSaved'])
/** 戻り先にできる画面。担当が決まっていない確認画面は、すぐ担当の画面に差し替わるので数えない（戻るとまた担当の画面になってしまう） */
// 担当の画面は、空きを確かめ終わったものだけ戻り先にする（確かめる前の画面へ戻ると、また確かめて「どちらも埋まっています」へ
//   進み直し、戻るを押しても抜けられなかった・10/29 慶一郎さん）
const canReturnTo = (s: Step) => BACKABLE.has(s.k) && !(s.k === 'confirm' && !s.staffChosen && !s.staffId) && !(s.k === 'pickStaff' && !s.avail)
/** ここまで来たら、戻る先を忘れる（予約・キャンセルが終わった） */
const FORGET = new Set<Step['k']>(['done', 'cancelled', 'unavailable', 'offer', 'offerGone'])
/** 時間を選んだ画面（「時間を選び直す」の戻り先） */
const isTimeChoice = (s: Step) => s.k === 'pick' || s.k === 'overview' || (s.k === 'ai' && s.view.kind === 'slots')
const BACK_WORDS = /戻|もど|前の画面|ひとつ前|一つ前/
const TIME_AGAIN = /(時間|時刻|じかん).{0,6}(変|かえ|替|ずら|選び直)|別の時間|ほかの時間|他の時間|違う時間/

const JST = 9 * 60 * 60 * 1000
function jstDate(offsetDays = 0): string {
  const t = new Date(Date.now() + JST + offsetDays * 86400000)
  return t.toISOString().slice(0, 10)
}

function addDays(date: string, n: number): string {
  return new Date(new Date(date + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
}

/** 本日・明日・あさって・10月20日（火） */
function dayWord(date: string): string {
  if (date === jstDate(0)) return '本日'
  if (date === jstDate(1)) return '明日'
  if (date === jstDate(2)) return 'あさって'
  const d = new Date(date + 'T00:00:00Z')
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${'日月火水木金土'[d.getUTCDay()]}）`
}

const slotDate = (iso: string) => new Date(new Date(iso).getTime() + JST).toISOString().slice(0, 10)

function yen(menu: MenuOption): string {
  if (menu.price == null) return '店頭でご案内'
  return `¥${menu.price.toLocaleString('ja-JP')}${menu.price_from ? '〜' : ''}`
}

function visitLabel(iso: string): string {
  const v = formatVisit(iso)
  return `${v.relative ? `${v.relative} ` : ''}${v.date} ${v.time}`
}

function spokenTime(iso: string): string {
  const m = jstMinutes(iso)
  const h = Math.floor(m / 60)
  const mi = m % 60
  return mi === 0 ? `${h}時` : mi === 30 ? `${h}時半` : `${h}時${mi}分`
}

function spokenVisit(iso: string): string {
  const v = formatVisit(iso)
  return `${v.relative ?? v.date.replace(/（.）/, '')}の${spokenTime(iso)}`
}

/** 予約の時刻から、決まった規則の JOHNNY でも使える希望の形を作る（直前に埋まったときの探し直しに使う） */
function reqFromSlot(iso: string): VisitRequest {
  const m = jstMinutes(iso)
  return { dates: [slotDate(iso)], time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, range: null, earliest: false }
}

/** 「10月20日（火）」の形の日付（AI に一覧から選んだことを伝える言葉に使う） */
function dateWord(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

type ConfirmStep = Extract<Step, { k: 'confirm' }>
// 「指名なし」の言い方（指名なしは選べない。言われたら担当を選んでもらう）
const ANY_STAFF = /どちら|どっち|おまかせ|お任せ|指名なし|しめいなし|指名しない|しめいしない|指名は(?:いい|大丈夫|なし)|なしで|誰でも|だれでも|どなたでも|フリー|空いて(?:いる|る)(?:方|ほう)|あいて(?:いる|る)(?:方|ほう)|早い(?:方|ほう)|はやい(?:方|ほう)/
/** いつものメニューを登録する（1つだけ・入れ替え） */
const saveUsual = (m: MenuOption): boolean => setUsualMenu({ code: m.code, name: m.name })

const AI_STEPS = new Set<Step['k']>(['welcome', 'askWhen', 'askMenu', 'overview', 'pick', 'confirm', 'ai', 'confirmCancel'])

// 当日キャンセル防止（お店の決まり）：開始2時間前を切ってからのアプリのキャンセルは、30日間 AI の新規予約を止める。
// 判定と記録はサーバー（customer_cancel_reservation・予約の入口）。ここは先に知らせるための表示だけ。
const LATE_CANCEL_MIN = 120
const PENALTY_DAYS = 30
const isLateForAi = (startsAt: string) => Date.parse(startsAt) - Date.now() < LATE_CANCEL_MIN * 60_000
const monthDay = (ymd: string) => { const [, m, d] = ymd.split('-').map(Number); return `${m}月${d}日` }
/** 今日（日本時間）＋30日：止めた場合に再開できる日 */
const resumeIfCancelledNow = () => new Date(Date.now() + 9 * 3_600_000 + PENALTY_DAYS * 86_400_000).toISOString().slice(0, 10)
const BOOKING_RULE_NOTE = `ご来店2時間前を過ぎてからのAIキャンセルは、${PENALTY_DAYS}日間AI予約をご利用いただけません。お電話でのキャンセルは対象外です。`
const pausedSay = (resumeOn?: string) =>
  `${resumeOn ? `${monthDay(resumeOn)}から、` : 'しばらくの間、'}AI予約はお休みです。それまでは、お電話でのご予約をお願いします。今のご予約の確認とキャンセルは、このままできます。`
const pausedStep = (s?: AiBookingStatus | null): Step => ({ k: 'ai', say: pausedSay(s?.resume_on), view: { kind: 'talk', handoff: true } })

const BUSINESS_ERRORS = new Set(['slot_taken', 'too_late', 'date_not_open', 'invalid_starts_at', 'menu_not_available', 'hold_expired', 'hold_not_found'])

export function JohnnyBookingAssistant({ onClose, onShowQr, initialMenuCode = null, initialLabel = null, initialUsual = false }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (viewportRef.current) return observeVisibleViewport(viewportRef.current)
  }, [])
  const api = useMemo(() => bookingAssistantApi(), [])
  const [step, setStep] = useState<Step>({ k: 'loading' })
  const [options, setOptions] = useState<AssistantOptions | null>(null)
  const [lastMenuCode, setLastMenuCode] = useState<string | null>(null)
  /** メンテナンスカットのあと何日使えるか（14日以内でなければ null） */
  const [maintLeft, setMaintLeft] = useState<number | null>(null)
  const [heard, setHeard] = useState('')
  // 質問・相談への答え（どの段階で答えたかを覚え、段階が変わったら出さない）
  const [answer, setAnswer] = useState<{ forStep: Step; text: string; menus: MenuOption[]; thinking?: boolean } | null>(null)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const stepRef = useRef(step)
  useEffect(() => { stepRef.current = step }, [step])
  // 予約の AI：使えなくなったら、この画面のあいだは決まった規則の JOHNNY で続ける
  const aiOnRef = useRef(true)
  const couponPickRef = useRef<{ key: string; ids: string[] }>({ key: '', ids: [] })
  const turnsRef = useRef<AgentTurn[]>([{ role: 'assistant', text: 'いつのご来店をご希望ですか？' }])
  const [myReservations, setMyReservations] = useState<CustomerReservation[]>([])
  // ご本人の予約は1つまで（お連れ様の予約は数えない）。新しく予約するときに本人の予約があれば「キャンセルしてこちらにしますか？」＝変更として確定する
  const ownActive = useMemo(() => pickNext(myReservations.filter(r => !companionIds().includes(r.id))), [myReservations])
  // お電話のクーポン予約（端末に覚えた予約日つきのメモ）。AI 予約を取ったら、これと入れ替える（ご予約は1つ）
  const [phoneReservation] = useState(loadCurrentReservation)
  const ownActiveRef = useRef(ownActive)
  useEffect(() => { ownActiveRef.current = ownActive }, [ownActive])
  /** 確定のときに入れ替える予約（変更ならその予約、新規でも本人の予約があればそれ） */
  const replaceOf = (s: { change?: CustomerReservation }) => s.change ?? ownActiveRef.current ?? undefined
  // 手持ちの券と、確認画面で選んだ券（key：その確認画面のメニューと時刻）
  const [myTickets, setMyTickets] = useState<TicketRow[]>([])
  const [couponPick, setCouponPick] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] })
  // 銀Pay の仮支払い：確認画面で「銀Payで今すぐ支払う」を選ぶと、予約の確定のあとに残高を押さえる（支払いの確定はレジで会員QR を読んだとき）
  const ginpay = useGinpayHolds()
  const ginpayRef = useRef<GinpayHoldSummary | null>(ginpay)
  useEffect(() => { ginpayRef.current = ginpay }, [ginpay])
  const [payGinpay, setPayGinpay] = useState(true)
  const ginpayPlanRef = useRef<{ key: string; amount: number }>({ key: '', amount: 0 })
  useEffect(() => { couponPickRef.current = couponPick }, [couponPick])

  // 聞き取った言葉 → 今の段階で処理（下で定義する handleText を ref 経由で呼ぶ）
  const handleTextRef = useRef<(text: string) => void>(() => {})
  // 声は録音してサーバーで文字にする（デモだけ端末の音声認識）
  const handleAudioRef = useRef<(audio: Blob) => void>(() => {})
  const onAudio = useCallback((audio: Blob) => handleAudioRef.current(audio), [])
  const voice = useVoice(useCallback((text: string) => handleTextRef.current(text), []), { server: api.serverVoice, onAudio, aiVoice: api.serverVoice })
  const { speak, startListening, stopListening, finishListening } = voice
  /** 録音を送れなかった・聞き取れなかったときの一言 */
  const [voiceNote, setVoiceNote] = useState<string | null>(null)

  // 戻る：見せた画面を覚えておき、「戻る」で1つずつ前の画面へ（確定の手前で「やっぱり時間を変えたい」に応える・10/27 慶一郎さん）
  //   同じ画面の言い直し（「空いていません」の一言など）は1つと数える。予約が終わったら忘れる
  const historyRef = useRef<Step[]>([])
  const shownRef = useRef<Step | null>(null)
  const goingBackRef = useRef(false)
  // 画面に出す用（戻れるか・時間を選び直せるか）
  const [backList, setBackList] = useState<Step[]>([])
  const canBack = backList.length > 0
  useEffect(() => {
    const prev = shownRef.current
    if (canReturnTo(step)) shownRef.current = step
    if (goingBackRef.current) { goingBackRef.current = false; return }
    if (FORGET.has(step.k)) {
      historyRef.current = []; shownRef.current = null
      setBackList([]) // eslint-disable-line react-hooks/set-state-in-effect
      return
    }
    if (!canReturnTo(step) || !prev || prev === step || prev.k === step.k) return
    historyRef.current = [...historyRef.current, prev].slice(-12)
    setBackList(historyRef.current)
  }, [step])
  /** 1つ前の画面へ。where を渡すと、それに合ういちばん近い前の画面へ（「時間を選び直す」） */
  const goBack = useCallback((where?: (s: Step) => boolean) => {
    const h = historyRef.current
    if (!h.length) return
    let i = h.length - 1
    if (where) { while (i >= 0 && !where(h[i])) i--; if (i < 0) i = h.length - 1 }
    const target = h[i]
    historyRef.current = h.slice(0, i)
    setBackList(historyRef.current)
    stopListening(); setAnswer(null); setHeard('')
    goingBackRef.current = true
    shownRef.current = target
    stepRef.current = target
    setStep(target)
  }, [stopListening])

  /** 質問を読み上げて、終わったら聞き取りを始める */
  const ask = useCallback((text: string, listenAfter = true) => {
    speak(text, () => { if (listenAfter && voice.listen !== 'unsupported' && voice.listen !== 'denied') startListening() })
  }, [speak, startListening, voice.listen])

  // Stop every BGM before the assistant is painted; keep it stopped until unmount.
  useLayoutEffect(() => suspendBgm(), [])

  // ── 読み込み（引き継ぎのあと・再試行で読み直す） ──
  const [loadKey, setLoadKey] = useState(0)
  const [binding, setBinding] = useState(false)
  const reload = useCallback(() => { setStep({ k: 'loading' }); setLoadKey(k => k + 1) }, [])
  useEffect(() => {
    let alive = true
    Promise.all([
      api.options(),
      api.reservations().catch(() => [] as CustomerReservation[]),
      api.contact().catch(() => null),
      api.lastVisit().catch(() => null),
      api.recentVisits().catch(() => []),
      api.aiStatus ? api.aiStatus().catch(() => null) : Promise.resolve(null),
    ])
      .then(([opts, list, contact, lastVisit, visits, aiStatus]) => {
        if (!alive) return
        setOptions(opts)
        setMyReservations(list)
        api.tickets().then(setMyTickets).catch(() => {})
        // 当日キャンセル・無断キャンセルのあと：新しい予約は電話へ。今の予約の確認・キャンセルはできる
        if (aiStatus?.paused) { setStep(pausedStep(aiStatus)); return }
        // 前回のメニュー（キャンセル以外で一番新しい予約）を選択肢の先頭に出す
        const last = [...list].filter(r => r.status !== 'cancelled').sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0]
        setLastMenuCode(last?.items[0]?.menu_code ?? null)
        // 連絡先（本名・電話番号）が未登録なら、日時の前に1回だけ聞く。仕組みが無い環境（null）では聞かない
        if (contact && !contact.registered) { setStep({ k: 'contact', name: contact.name }); return }
        // キャンセル待ちのお知らせから開いた（?hold=…）：押さえている枠を見せる
        const holdId = takeHoldParam()
        if (holdId) {
          api.getHold(holdId).then(
            hold => { if (alive) setStep({ k: 'offer', hold }) },
            (err: unknown) => { if (alive) setStep({ k: 'offerGone', reason: err instanceof RpcError && err.code === 'already_booked' ? 'booked' : 'expired' }) })
          return
        }
        // 2回目以降のお客様は「おかえりなさい」から
        const w0 = buildWelcome(lastVisit, list, opts.menus, Date.now(), visits)
        // 登録したいつものメニューがあれば、それを「いつもの」の先頭に
        const reg = getUsualMenu()
        const regMenu = reg && canBeUsual(reg.code) ? opts.menus.find(m => m.code === reg.code) : undefined
        setMaintLeft(w0?.maintenanceLeft ?? null)
        // いつものは1つだけ（パンチパーマの人に通常カットは出さない・10/29 慶一郎さん）：登録したもの、なければ来店でいちばん多いもの
        const w = w0 ? { ...w0, usual: (regMenu ? [regMenu] : w0.usual).slice(0, 1) } : w0
        if (w) {
          turnsRef.current = [{ role: 'assistant', text: welcomeText(w).speech }]
          setStep({ k: 'welcome', w })
        } else setStep({ k: 'askWhen' })
      })
      .catch((err: unknown) => {
        if (!alive) return
        const code = err instanceof RpcError ? err.code : ''
        setStep({ k: 'unavailable', reason: code === 'booking_disabled' ? 'booking_disabled' : code === 'customer_auth_required' ? 'auth' : 'network' })
      })
    return () => { alive = false }
  }, [api, loadKey])

  // ── キャンセル待ちで押さえた枠：確定・見送り ──
  const confirmOffer = useCallback(async (hold: HoldOffer) => {
    setStep({ k: 'offer', hold, busy: true })
    try {
      const reservation = await api.confirm(hold.hold_id)
      rememberReservation(reservation)
      setMyReservations(list => [...list.filter(r => r.id !== reservation.id), reservation])
      setStep({ k: 'done', reservation })
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      setStep(code === 'hold_expired' || code === 'hold_not_found' ? { k: 'offerGone', reason: 'expired' } : { k: 'unavailable', reason: 'network' })
    }
  }, [api])
  const declineOffer = useCallback(async (hold: HoldOffer) => {
    if (hold.waitlist_id) await api.leaveWaitlist(hold.waitlist_id).catch(() => {})
    else await api.release(hold.hold_id).catch(() => {})
    setStep({ k: 'ai', say: '承知しました。キャンセル待ちを外しておきますね。', view: { kind: 'talk', handoff: false } })
  }, [api])

  // メンテナンスカット（code: maintenance）は、前回のご来店（QR の来店登録）から14日以内のお客様だけ予約メニューに出す
  const maintenanceMenu = options?.menus.find(m => m.code === 'maintenance')
  const menus = useMemo(() => {
    const list = (options?.menus ?? []).filter(m => m.code !== 'maintenance' || maintLeft != null)
    return lastMenuCode ? [...list].sort((a, b) => (a.code === lastMenuCode ? -1 : b.code === lastMenuCode ? 1 : 0)) : list
  }, [options, lastMenuCode, maintLeft])

  /** 「メンテナンスで予約」：14日以内ならそのまま日時へ。過ぎていたら理由を伝える。メニューが無い環境（DB が古い）はホットペッパーのクーポンへ */
  const startMaintenance = useCallback(() => {
    if (!maintenanceMenu) { setStep({ k: 'ai', say: 'メンテナンスカットは、ホットペッパーのクーポンでご予約いただけます。下のボタンからどうぞ。', view: { kind: 'maintenance' } }); return }
    if (maintLeft == null) { setStep({ k: 'ai', say: 'メンテナンスカットは、前回のご来店から14日以内にご利用いただけます。今回は、通常のメニューでご予約ください。', view: { kind: 'talk', handoff: false } }); return }
    turnsRef.current = [{ role: 'user', text: 'メンテナンスカットで予約したい' }, { role: 'assistant', text: 'メンテナンスカットですね。いつのご来店をご希望ですか？' }]
    setStep({ k: 'askWhen', again: 'menu', menu: maintenanceMenu })
  }, [maintenanceMenu, maintLeft])

  // スタイルの「予約する」から来たとき：最初の場面（おかえり／日時）を、そのメニュー入りの「いつにしますか？」に差し替える（担当は確定の前に聞く）
  // メニューが無い髪型は、名前だけ会話に入れて「いつにしますか？」から（メニューはあとで聞く）。料金表を読み終える前には受け取らない
  // メンテナンスカットのお知らせ（JOHNNY のお知らせ）をまだ受け取っていない端末だけ「登録しますか？」と聞く
  const [pushAsk, setPushAsk] = useState(false)
  useEffect(() => { pushState().then(st => setPushAsk(st === 'off' || st === 'needs-install'), () => {}) }, [])
  const [usualDone, setUsualDone] = useState<string | null>(null)
  const initialMenuRef = useRef(initialMenuCode)
  const initialLabelRef = useRef(initialLabel)
  const initialUsualRef = useRef(initialUsual)
  useEffect(() => {
    if ((!initialMenuRef.current && !initialLabelRef.current && !initialUsualRef.current) || !options || (step.k !== 'welcome' && step.k !== 'askWhen')) return
    // 開いてすぐの切り替え（ようこそ → ○○ですね）は「戻る」の戻り先にしない（いつもので開くと、見ていない画面へ戻る「戻る」が出ていた・10/29 慶一郎さん）
    goingBackRef.current = true
    // 「いつもの」でメニューが分からない：いつものメニューを聞く
    if (initialUsualRef.current && !initialMenuRef.current) {
      initialUsualRef.current = false
      initialLabelRef.current = null
      setStep({ k: 'askUsual' })
      return
    }
    initialUsualRef.current = false
    const menu = initialMenuRef.current ? options.menus.find(m => m.code === initialMenuRef.current) : undefined
    const label = initialLabelRef.current
    initialMenuRef.current = null
    initialLabelRef.current = null
    if (!menu) {
      if (!label) return
      turnsRef.current = [{ role: 'user', text: `「${label}」の髪型で予約したい` }, { role: 'assistant', text: `「${label}」ですね。いつのご来店をご希望ですか？` }]
      setStep({ k: 'askWhen', again: 'menu', label })
      return
    }
    turnsRef.current = [{ role: 'user', text: `${menu.name}で予約したい` }, { role: 'assistant', text: `${menu.name}ですね。いつのご来店をご希望ですか？` }]
    setStep({ k: 'askWhen', again: 'menu', menu })
  }, [step, options])

  // ── メニューが決まっていて、日が決まっていない／希望の日が埋まっている：近い日から探して、間をあけて3件 ──
  const soonest = useCallback(async (menu: MenuOption, req: VisitRequest, from: string, note: string) => {
    setStep({ k: 'searching' })
    stopListening()
    try {
      const picks = spreadSlots(await api.nextSlots(menu.code, from, 10), 3)
      if (picks.length === 0) { setStep({ k: 'askWhen', again: 'none', menu }); return }
      const dates = [...new Set(picks.map(x => slotDate(x.starts_at)))]
      setStep({ k: 'pick', req: { ...req, dates, time: null }, menu, offer: { kind: 'choices', slots: picks }, note })
    } catch {
      setStep({ k: 'unavailable', reason: 'network' })
    }
  }, [api, stopListening])

  // ── 日にちのボタン（今日・明日・明後日）：その日の空きを朝から夜まで散らして6件。空きが無ければ次に早い日 ──
  const pickDay = useCallback(async (menu: MenuOption, date: string) => {
    setStep({ k: 'searching' })
    stopListening()
    const req: VisitRequest = { dates: [date], time: null, range: null, earliest: false }
    try {
      const slots = [...await api.slots(date, menu.code)].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      if (slots.length === 0) { void soonest(menu, req, addDays(date, 1), `${menu.name}は${dayWord(date)}は空きがありません。`); return }
      const n = Math.min(6, slots.length)
      const picks = n === 1 ? slots : [...new Set(Array.from({ length: n }, (_, i) => Math.round(i * (slots.length - 1) / (n - 1))))].map(i => slots[i])
      setStep({ k: 'pick', req, menu, offer: { kind: 'choices', slots: picks }, note: `${dayWord(date)}の${menu.name}の空きです。`, wholeDay: true })
    } catch {
      setStep({ k: 'unavailable', reason: 'network' })
    }
  }, [api, soonest, stopListening])

  // ── 空き枠を探して提案 ──
  const search = useCallback(async (reqIn: VisitRequest, menu: MenuOption) => {
    setStep({ k: 'searching' })
    stopListening()
    const windowDays = options?.settings.booking_window_days ?? 60
    const today = jstDate(0)
    const last = jstDate(windowDays)
    // 日付の指定が無ければ、近い日から探す
    if (reqIn.dates.length === 0) { void soonest(menu, reqIn, today, `${menu.name}ですね。`); return }
    const dates = reqIn.dates.filter(d => d >= today && d <= last)
    const req = { ...reqIn, dates }
    if (dates.length === 0) { setStep({ k: 'askWhen', again: 'none', menu }); return }
    try {
      const results = await Promise.all(dates.map(d => api.slots(d, menu.code).then(s => [d, s] as const)))
      const offer = planOffer(req, Object.fromEntries(results))
      if (offer.kind === 'exact') setStep({ k: 'confirm', req, menu, slot: offer.slots[0] })
      // 希望の日に空きが無い：「空きがありません」で止めず、次に早い日時を案内する
      else if (offer.kind === 'none') void soonest(menu, req, addDays(dates[dates.length - 1], 1), `${menu.name}は${dayWord(dates[0])}は空きがありません。`)
      else setStep({ k: 'pick', req, menu, offer })
    } catch {
      setStep({ k: 'unavailable', reason: 'network' })
    }
  }, [api, options, soonest, stopListening])

  // ── メニューがまだ決まっていない：その日の空き状況を先に見て、入れられるメニューと時刻を案内する ──
  const advise = useCallback(async (reqIn: VisitRequest) => {
    setStep({ k: 'searching' })
    stopListening()
    const today = jstDate(0)
    const last = jstDate(options?.settings.booking_window_days ?? 60)
    const wanted = (reqIn.dates.length > 0 ? reqIn.dates : [today]).filter(d => d >= today && d <= last)
    try {
      for (const d of wanted) {
        const advice = adviseDay(await api.dayOverview(d), menus, reqIn)
        if (advice && advice.available.length > 0) { setStep({ k: 'overview', req: { ...reqIn, dates: [d] }, advice }); return }
      }
      // 希望の日（時刻）に入れるメニューが無い：次に空いている日（1週間先まで）を案内する
      const first = wanted[0] ?? today
      const missed = `${dayWord(first)}は${reqIn.time ? `${reqIn.time.replace(/^0/, '')}には` : ''}空きがありません。`
      for (let i = 1; i <= 7; i++) {
        const d = addDays(wanted[wanted.length - 1] ?? today, i)
        if (d > last) break
        const advice = adviseDay(await api.dayOverview(d), menus, { time: null, range: reqIn.range })
        if (advice && advice.available.length > 0) { setStep({ k: 'overview', req: { ...reqIn, dates: [d], time: null }, advice, note: missed }); return }
      }
      setStep({ k: 'askWhen', again: 'none' })
    } catch {
      setStep({ k: 'unavailable', reason: 'network' })
    }
  }, [api, menus, options, stopListening])

  /** その日の空きから、選んだメニューの時刻を出す（時刻の指定どおりならそのまま確認へ） */
  const pickFromOverview = useCallback((s: Extract<Step, { k: 'overview' }>, menu: MenuOption) => {
    const hit = s.advice.available.find(x => x.menu.code === menu.code)
    if (!hit) { void soonest(menu, s.req, addDays(s.advice.date, 1), `${menu.name}は${dayWord(s.advice.date)}は空きがありません。`); return }
    if (s.req.time && hit.slots.length === 1) { setStep({ k: 'confirm', req: s.req, menu, slot: hit.slots[0] }); return }
    setStep({ k: 'pick', req: s.req, menu, offer: { kind: 'choices', slots: spreadSlots(hit.slots, 3) } })
  }, [soonest])

  // ── 予約の確定（仮押さえ → 確定）。通信が切れたら予約一覧で結果を確かめる ──
  // ── 担当：指名なしの予約は無い。担当が決まっていなければ確定の前に必ず聞く（担当が1人なら、その人に決める） ──
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options }, [options])
  const [rememberStaff, setRememberStaff] = useState(() => !!getUsualStaff())
  // ようこその「いつもの担当」：押すたびに 担当1 → 担当2 → 毎回選ぶ（null）
  const [usualStaffId, setUsualStaffId] = useState<string | null>(() => getUsualStaff())
  const cycleUsualStaff = useCallback(() => {
    const ids = (optionsRef.current?.staff ?? []).map(st => st.id)
    const order: (string | null)[] = [...ids, null]
    const next = order[(order.indexOf(usualStaffId) + 1) % order.length] ?? null
    setUsualStaff(next); setUsualStaffId(next); setRememberStaff(!!next)
  }, [usualStaffId])
  const rememberStaffRef = useRef(rememberStaff)
  useEffect(() => { rememberStaffRef.current = rememberStaff }, [rememberStaff])
  const chooseStaff = useCallback((s: Extract<Step, { k: 'pickStaff' }>, staffId: string | null) => {
    if (staffId && s.avail?.[staffId] === false) {
      const name = optionsRef.current?.staff?.find(st => st.id === staffId)?.name ?? 'その担当'
      setStep({ ...s, note: `${name}は、この時間は空いていません。ほかの担当をお選びください。` })
      return
    }
    // 「次回からもこの担当にする」：オンなら登録、オフなら取り消し（毎回聞く）
    if (staffId) { const v = rememberStaffRef.current ? staffId : null; setUsualStaff(v); setUsualStaffId(v) }
    setStep({ ...s.next, staffId, staffChosen: true })
  }, [])
  useEffect(() => {
    if (step.k !== 'confirm' || step.staffChosen || step.staffId) return
    const staff = options?.staff ?? []
    if (staff.length === 0) return
    if (staff.length === 1) { setStep({ ...step, staffId: staff[0].id, staffChosen: true }); return } // eslint-disable-line react-hooks/set-state-in-effect -- 担当が1人ならその人。2人以上なら確定の前に担当の画面へ差し替える
    // いつもの担当を登録している人は、担当の確認を省く（その担当がその時間に空いていなければ、担当の画面で選んでもらう・10/27 慶一郎さん）
    const usual = step.change ? null : getUsualStaff()
    const usualStaff = usual ? staff.find(st => st.id === usual) : undefined
    if (usualStaff) {
      let alive = true
      const at = Date.parse(step.slot.starts_at)
      void api.staffSlots(slotDate(step.slot.starts_at), step.menu.code, usualStaff.id)
        .then(list => list.some(x => Date.parse(x.starts_at) === at), () => false)
        .then(free => {
          if (!alive) return
          if (free) setStep({ ...step, staffId: usualStaff.id, staffChosen: true, usualStaff: true })
          else setStep({ k: 'pickStaff', next: step, note: `いつもの担当の${usualStaff.name}は、この時間は空いていません。ほかの担当をお選びください。` })
        })
      return () => { alive = false }
    }
    setStep({ k: 'pickStaff', next: step })
  }, [step, options, api])
  // 担当を選ぶ画面：その時間にそれぞれの担当が空いているか（空いていない担当は押せない表示に）
  useEffect(() => {
    if (step.k !== 'pickStaff' || step.avail) return
    const staff = options?.staff ?? []
    const at = Date.parse(step.next.slot.starts_at)
    const date = slotDate(step.next.slot.starts_at)
    let alive = true
    void Promise.all(staff.map(st => api.staffSlots(date, step.next.menu.code, st.id)
      .then(list => [st.id, list.some(x => Date.parse(x.starts_at) === at)] as const)
      .catch(() => [st.id, true] as const)))
      // 担当は必ずどちらかを選ぶ（指名なしは無い）。どの担当もその時間は空いていなければ、ほかの日時を聞き直す
      .then(pairs => { if (alive) setStep(cur => cur.k !== 'pickStaff' || cur.next !== step.next ? cur : pairs.every(([, ok]) => !ok)
        ? { k: 'ai', say: `その時間は、${staff.map(st => st.name).join('も')}も埋まっています。ほかのご希望の日時をお聞かせください。`, view: { kind: 'talk', handoff: false } }
        : { ...cur, avail: Object.fromEntries(pairs) }) })
    return () => { alive = false }
  }, [step, options, api])

  const book = useCallback(async (menu: MenuOption, slot: Slot, req: VisitRequest, staffId: string | null = null, change?: CustomerReservation) => {
    setStep({ k: 'booking', menu, slot })
    stopListening()
    let holdId: string | null = null
    try {
      const hold = await api.hold(slot.starts_at, menu.code, staffId)
      holdId = hold.hold_id
      const reservation = await api.confirm(hold.hold_id)
      const oldHeld = change ? heldFor(ginpayRef.current, change.id) : null
      // 変更：新しい予約が取れてから、元の予約をキャンセルする（取り消せなければ両方残っていることを伝える）
      let oldKept = false
      if (change) {
        try { await api.cancel(change.id); forgetReservation(change.id) } catch { oldKept = true }
      }
      rememberReservation(reservation)
      clearCurrentReservation()
      // 一緒に使う券（予約の日の会員 QR に入る）。変更なら元の予約の券は外す
      if (change) clearCouponPlan(change.id)
      const pickKey = `${menu.code}|${slot.starts_at}`
      const pickedIds = couponPickRef.current.key === pickKey ? couponPickRef.current.ids : []
      if (pickedIds.length) saveCouponPlan({ date: slotDate(reservation.starts_at), reservationId: reservation.id, ticketIds: pickedIds })
      // 銀Pay の仮支払い：確認画面で選んだ額。変更で元の予約に押さえがあれば、新しい予約に付け直す（元の予約のキャンセルで押さえは外れている）
      const plan = ginpayPlanRef.current
      ginpayPlanRef.current = { key: '', amount: 0 }
      const payAmount = plan.key === pickKey ? plan.amount : oldHeld ? Math.min(oldHeld, reservation.total_price ?? oldHeld) : 0
      let ginpayResult: number | 'failed' | undefined
      if (payAmount > 0) {
        try { await holdGinpay(reservation.id, payAmount); ginpayResult = payAmount } catch { ginpayResult = 'failed' }
      }
      api.reservations().then(setMyReservations).catch(() => {})
      setStep({ k: 'done', reservation, changedFrom: change, oldKept, ginpay: ginpayResult })
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      if (code === 'ai_booking_paused') {
        if (holdId) api.release(holdId).catch(() => {})
        setStep(pausedStep(api.aiStatus ? await api.aiStatus().catch(() => null) : null))
        return
      }
      if (BUSINESS_ERRORS.has(code)) {
        if (holdId) api.release(holdId).catch(() => {})
        if (aiOnRef.current) {
          setStep({ k: 'ai', say: 'その時間は、ちょうど埋まってしまいました。ほかのご希望の日時をお聞かせください。', view: { kind: 'talk', handoff: false } })
          return
        }
        // 直前に埋まった：同じ希望で探し直す（取れた枠は DB が決める）
        await search({ ...req, time: req.time ?? null }, menu)
        return
      }
      if (code === 'customer_auth_required') { setStep({ k: 'unavailable', reason: 'auth' }); return }
      // 確定まで届いたか分からない（通信切れなど）：「失敗」とは言わず、予約一覧で確かめる
      setStep({ k: 'unknown', menu, slot })
    }
  }, [api, search, stopListening])

  const cancelReservation = useCallback(async (reservation: CustomerReservation) => {
    setStep({ k: 'cancelling', reservation })
    stopListening()
    try {
      const r = await api.cancel(reservation.id)
      forgetReservation(reservation.id)
      clearCouponPlan(reservation.id)
      api.reservations().then(setMyReservations).catch(() => {})
      setStep({ k: 'cancelled', reservation: r })
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      if (code === 'customer_auth_required') { setStep({ k: 'unavailable', reason: 'auth' }); return }
      const say = code === 'cancel_deadline_passed'
        ? 'この予約は、アプリからキャンセルできる時間を過ぎています。お手数ですが、お電話でご連絡ください。'
        : 'キャンセルできませんでした。お手数ですが、お電話でご連絡ください。'
      setStep({ k: 'ai', say, view: { kind: 'talk', handoff: true } })
    }
  }, [api, stopListening])

  /** お連れ様の時間を決める（担当ごとの空きを見て、予約者の時間から一番早く） */
  const planParty = useCallback(async (primary: PartyPrimary, menu: MenuOption) => {
    setStep({ k: 'searching', label: '空き状況を確認しています' })
    stopListening()
    const date = slotDate(primary.slot.starts_at)
    try {
      const staff = options?.staff?.length ? options.staff : null
      const lists = staff
        ? await Promise.all(staff.map(async st => ({
            staffId: st.id,
            primary: (await api.staffSlots(date, primary.menu.code, st.id)).map(x => x.starts_at),
            companion: (await api.staffSlots(date, menu.code, st.id)).map(x => x.starts_at),
          })))
        : [{ staffId: 'any', primary: (await api.slots(date, primary.menu.code)).map(x => x.starts_at), companion: (await api.slots(date, menu.code)).map(x => x.starts_at) }]
      const plan = planCompanion(primary.slot.starts_at, primary.menu.duration_min, staff ? primary.staffId : null, lists)
      if (!plan.companion) {
        setStep({ k: 'ai', say: `${dayWord(date)}は、お連れ様の${menu.name}の空きがありません。別の日をお伝えください。`, view: { kind: 'talk', handoff: false } })
        return
      }
      setStep({ k: 'confirmParty', primary, companion: { menu, slot: { starts_at: plan.companion } }, togetherAt: plan.togetherAt })
    } catch {
      setStep({ k: 'unavailable', reason: 'network' })
    }
  }, [api, options, stopListening])

  /** 2人分を予約（予約者 → お連れ様の順に押さえて確定。お連れ様だけ取れなかったら、そう伝える） */
  const bookParty = useCallback(async (s: Extract<Step, { k: 'confirmParty' }>) => {
    setStep({ k: 'booking', menu: s.primary.menu, slot: s.primary.slot })
    stopListening()
    let reservation: CustomerReservation
    try {
      const hold = await api.hold(s.primary.slot.starts_at, s.primary.menu.code, s.primary.staffId)
      reservation = await api.confirm(hold.hold_id)
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      if (code === 'customer_auth_required') { setStep({ k: 'unavailable', reason: 'auth' }); return }
      setStep({ k: 'ai', say: 'その時間は、ちょうど埋まってしまいました。ほかのご希望の日時をお聞かせください。', view: { kind: 'talk', handoff: false } })
      return
    }
    if (s.primary.replace) {
      try { await api.cancel(s.primary.replace.id); forgetReservation(s.primary.replace.id); clearCouponPlan(s.primary.replace.id) } catch { /* 取り消せなければ一覧に両方出る */ }
    }
    rememberReservation(reservation)
    clearCurrentReservation()
    // 銀Pay の仮支払いはご本人の分だけ（確認画面で選んでいたとき）
    const plan = ginpayPlanRef.current
    ginpayPlanRef.current = { key: '', amount: 0 }
    let ginpayResult: number | 'failed' | undefined
    if (plan.amount > 0 && plan.key === `${s.primary.menu.code}|${s.primary.slot.starts_at}`) {
      try { await holdGinpay(reservation.id, plan.amount); ginpayResult = plan.amount } catch { ginpayResult = 'failed' }
    }
    let companion: CustomerReservation | undefined
    try {
      // お連れ様も担当を決めて取る（指名なしは無い）。予約者と違う担当から順に、空いている人で押さえる
      const staff = optionsRef.current?.staff ?? []
      const order = [...staff.filter(st => st.id !== s.primary.staffId), ...staff.filter(st => st.id === s.primary.staffId)]
      for (const st of order) {
        try {
          const hold = await api.hold(s.companion.slot.starts_at, s.companion.menu.code, st.id)
          companion = await api.confirm(hold.hold_id, 'お連れ様')
          rememberCompanion(companion.id)
          break
        } catch { /* 次の担当で試す */ }
      }
    } catch { /* 下で伝える */ }
    api.reservations().then(setMyReservations).catch(() => {})
    setStep({ k: 'done', reservation, companion, companionFailed: !companion, ginpay: ginpayResult })
  }, [api, stopListening])

  const verifyUnknown = useCallback(async (menu: MenuOption, slot: Slot) => {
    setStep({ k: 'booking', menu, slot })
    try {
      const list = await api.reservations()
      const found = list.find(r => r.starts_at && new Date(r.starts_at).getTime() === new Date(slot.starts_at).getTime()
        && r.status !== 'cancelled' && r.items.some(i => i.menu_code === menu.code))
      if (found) { rememberReservation(found); setStep({ k: 'done', reservation: found }); return }
      setStep({ k: 'unknown', menu, slot })
    } catch {
      setStep({ k: 'unknown', menu, slot })
    }
  }, [api])

  // ── 言葉の処理（段階ごと） ──
  /** 画面に出している候補（「2つ目で」「16時にして」を AI が読むため） */
  const shownFor = (s: Step): AgentShown | undefined => {
    if (s.k === 'confirm') return { confirm: { menu_code: s.menu.code, starts_at: s.slot.starts_at, staff_id: s.staffId ?? null } }
    if (s.k === 'pick') return { menu_code: s.menu.code, times: s.offer.slots.map(x => x.starts_at), staff_id: null }
    if (s.k === 'ai' && s.view.kind === 'slots') return { menu_code: s.view.menu.code, times: s.view.slots.map(x => x.starts_at), staff_id: s.view.staffId }
    return undefined
  }

  /** AI の答え → 次の段階。分からないメニュー・予約が来たら null（決まった規則に切り替える） */
  const stepFromAgent = useCallback(async (a: AgentAnswer): Promise<Step | null> => {
    const all = options?.menus ?? []
    const menuOf = (code: string) => all.find(m => m.code === code) ?? null
    const findReservation = async (id: string) => {
      const hit = myReservations.find(r => r.id === id)
      if (hit) return hit
      const list = await api.reservations().catch(() => [] as CustomerReservation[])
      setMyReservations(list)
      return list.find(r => r.id === id) ?? null
    }
    const ui = a.ui
    switch (ui.type) {
      case 'none': case 'handoff': return { k: 'ai', say: a.say, view: { kind: 'talk', handoff: ui.type === 'handoff' } }
      case 'menus': {
        const items = ui.items.flatMap(i => { const menu = menuOf(i.menu_code); return menu ? [{ menu, first: i.first_time }] : [] })
        return { k: 'ai', say: a.say, view: items.length ? { kind: 'menus', date: ui.date, items } : { kind: 'talk', handoff: false } }
      }
      case 'slots': {
        const menu = menuOf(ui.menu_code)
        return menu ? { k: 'ai', say: a.say, view: { kind: 'slots', menu, staffId: ui.staff_id, slots: ui.times.map(t => ({ starts_at: t })) } } : null
      }
      case 'confirm_booking': {
        const menu = menuOf(ui.menu_code)
        return menu ? { k: 'confirm', req: reqFromSlot(ui.starts_at), menu, slot: { starts_at: ui.starts_at }, staffId: ui.staff_id, say: a.say } : null
      }
      case 'confirm_change': {
        const menu = menuOf(ui.menu_code)
        const change = await findReservation(ui.reservation_id)
        // 2時間前を切った予約の変更は、AI では受けず電話へ
        if (change && isLateForAi(change.starts_at)) {
          return { k: 'ai', say: 'ご予約の2時間前を過ぎているため、AIでは変更できません。お手数ですが、お電話でご連絡ください。お電話なら、ペナルティーはありません。', view: { kind: 'talk', handoff: true } }
        }
        return menu && change ? { k: 'confirm', req: reqFromSlot(ui.starts_at), menu, slot: { starts_at: ui.starts_at }, staffId: ui.staff_id, change, say: a.say } : null
      }
      case 'confirm_cancel': {
        const reservation = await findReservation(ui.reservation_id)
        return reservation ? { k: 'confirmCancel', reservation, say: a.say } : null
      }
      case 'waitlist': {
        const menu = menuOf(ui.menu_code)
        return menu ? { k: 'ai', say: a.say, view: { kind: 'waitlist', menu, staffId: ui.staff_id, date: ui.date, from: ui.from, to: ui.to } } : null
      }
      case 'reservations': {
        const found = await Promise.all(ui.ids.map(findReservation))
        const list = found.filter((r): r is CustomerReservation => !!r)
        return list.length ? { k: 'ai', say: a.say, view: { kind: 'reservations', list } } : null
      }
    }
  }, [api, myReservations, options])

  const legacyRef = useRef<(text: string, s: Step) => void>(() => {})
  /** AI に聞く。使えなければ、この画面のあいだは決まった規則の JOHNNY に切り替えて、同じ言葉を読み直す */
  const viaAgent = useCallback(async (text: string, s: Step) => {
    stopListening()
    setStep({ k: 'searching', label: '考えています' })
    const history = turnsRef.current
    // 1日の上限を超えたら、その日は決まった規則の JOHNNY
    const a = takeAiTurn() ? await api.agent(text, history, shownFor(s)) : null
    const next = a ? await stepFromAgent(a) : null
    if (!a || !next) {
      aiOnRef.current = false
      const back: Step = s.k === 'ai' || s.k === 'confirmCancel' || s.k === 'welcome' ? { k: 'askWhen' } : s
      stepRef.current = back
      legacyRef.current(text, back)
      return
    }
    turnsRef.current = [...history, { role: 'user' as const, text }, { role: 'assistant' as const, text: a.say }].slice(-20)
    setStep(next)
  }, [api, stepFromAgent, stopListening])

  /** 確認画面で「いいえ」：AI なら次の希望を聞く、決まった規則なら日時から聞き直す */
  const declineConfirm = useCallback((menu?: MenuOption) => {
    if (aiOnRef.current) {
      const say = 'かしこまりました。ほかにご希望の日時やメニューはありますか？'
      turnsRef.current = [...turnsRef.current, { role: 'user' as const, text: 'いいえ' }, { role: 'assistant' as const, text: say }].slice(-20)
      setStep({ k: 'ai', say, view: { kind: 'talk', handoff: false } })
      return
    }
    setStep({ k: 'askWhen', again: 'retry', menu })
  }, [])

  // 見るだけの頼みごと（V2.0）：会員QR を開く・使える券・銀Pay の残高・次のメンテナンス。答えるだけで、お金と券は動かさない
  const answerInfo = useCallback(async (kind: InfoRequest) => {
    if (kind === 'maintenanceChoice') {
      setStep({ k: 'ai', say: 'メンテナンスについて、どちらをご希望ですか？', view: { kind: 'maintenanceChoice' } })
      return
    }
    if (kind === 'qr') {
      if (onShowQr) { onShowQr(); return }
      setStep({ k: 'ai', say: '会員QRは、下の「会員QR」から開けます。', view: { kind: 'talk', handoff: false } })
      return
    }
    setStep({ k: 'searching', label: '確認しています' })
    const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`
    let say: string
    if (kind === 'tickets') {
      const list = usableTickets(myTickets, new Date().toISOString())
      say = list.length
        ? `今使える券は、${list.slice(0, 5).map(t => t.title).join('、')}${list.length > 5 ? `ほか${list.length - 5}枚` : ''}です。お会計のときに会員QRをお見せください。`
        : '今使える割引券はありません。'
    } else if (kind === 'ginpay') {
      try { const l = await getCustomerGinpayLedger(1); say = `銀Payの残高は${yenOf(l.balance)}です。チャージは店頭でどうぞ。` }
      catch { say = '銀Payの残高は、会員QRの画面でご確認ください。' }
    } else {
      const last = await api.lastVisit().catch(() => null)
      if (!last) say = 'まだご来店の記録がありません。ご来店のあと、次のメンテナンスの目安をお知らせします。'
      else {
        const d = getDaysUntilRecommended(last)
        say = d > 0 ? `次のメンテナンスの目安は${md(getNextRecommendedDate(last))}ごろ、あと${d}日です。` : d === 0 ? 'メンテナンスの目安は今日です。' : `メンテナンスの目安を${-d}日過ぎています。`
      }
    }
    turnsRef.current = [...turnsRef.current, { role: 'assistant' as const, text: say }].slice(-20)
    setStep({ k: 'ai', say, view: { kind: 'talk', handoff: false } })
  }, [api, myTickets, onShowQr])

  // 声と文字で同じ案内を使い、曖昧な一言を AI が勝手に予約へ進めないようにする。
  const handleLocalRequest = useCallback((text: string, s: Step): boolean => {
    if (!AI_STEPS.has(s.k) || s.k === 'confirm' || s.k === 'confirmCancel') return false
    const maintenanceChoice = s.k === 'ai' && s.view.kind === 'maintenanceChoice'
    const info = infoRequest(text, maintenanceChoice)
    if (info) { void answerInfo(info); return true }
    if (isMaintenanceBookingRequest(text, maintenanceChoice)) { startMaintenance(); return true }
    // いつものメニューを変える（10/29 慶一郎さん）：「いつものメニューを変えたい」「いつものをパンチパーマにして」
    //   「いつもので明日にして」は予約なので、変える言葉か「いつもの（メニュー）を○○に」とメニューの名前があるときだけ
    const usualMenu = matchMenu(text, menus)
    if (/いつも/.test(text) && (/(変え|かえ|変更|替え|登録し直)/.test(text) || (/いつもの(メニュー)?を.{1,20}に(して|したい|登録)/.test(text) && usualMenu))) {
      if (usualMenu && canBeUsual(usualMenu.code)) { setStep({ k: 'usualSaved', menu: usualMenu, failed: !saveUsual(usualMenu) }); return true }
      const now = getUsualMenu()
      setStep({ k: 'askUsual', note: `${now ? `今のいつものメニューは${now.name}です。` : ''}いつものメニューを、どれに変えますか？` })
      return true
    }
    return false
  }, [answerInfo, startMaintenance, menus])

  const handleText = useCallback((raw: string) => {
    const text = raw.trim()
    if (!text) return
    setHeard(text)
    setVoiceNote(null)
    const s = stepRef.current
    // 「戻って」「やっぱり時間を変えたい」：前の画面へ（AI に聞かない）
    if ((s.k === 'confirm' || s.k === 'pickStaff' || s.k === 'confirmParty') && historyRef.current.length) {
      if (TIME_AGAIN.test(text) && historyRef.current.some(isTimeChoice)) { goBack(isTimeChoice); return }
      if (BACK_WORDS.test(text)) { goBack(); return }
    }
    if (handleLocalRequest(text, s)) return
    // 担当を選ぶ段階（AI に聞かない）：担当の名前
    if (s.k === 'pickStaff') {
      const staff = optionsRef.current?.staff ?? []
      const hit = staff.find(st => text.includes(st.name) || (st.name === '銀二郎' && /ぎんじろう|ギンジロウ|ギンジロー|銀次郎|銀ちゃん|ぎんちゃん|ギンちゃん/.test(text)) || (st.name === 'テイテイ' && /ていてい|てぃてぃ|ティティ|テイテー|ていてー|TT/i.test(text)))
      if (hit) { chooseStaff(s, hit.id); return }
      const names = staff.map(st => st.name).join('か')
      setStep({ ...s, note: ANY_STAFF.test(text) ? `お手数ですが、担当は${names}からお選びください。` : `担当のお名前（${names}）をお伝えください。` })
      return
    }
    // お連れ様の段階（AI に聞かない）
    if (s.k === 'confirm' && !s.change && parseYesNo(text) === null && COMPANION_WORDS.test(text)) {
      setStep({ k: 'companionMenu', primary: { menu: s.menu, slot: s.slot, staffId: s.staffId ?? null, req: s.req } })
      return
    }
    if (s.k === 'askUsual') {
      const menu = matchMenu(text, menus)
      if (menu && canBeUsual(menu.code)) { setStep({ k: 'usualSaved', menu, failed: !saveUsual(menu) }); return }
      if (menu) { setStep({ k: 'askUsual', note: `${menu.name}は、いつものメニューにはできません。カット・パーマ・カラーからお選びください。` }); return }
      setStep({ k: 'askUsual', note: 'すみません、メニューが分かりませんでした。下から選ぶか、もう一度お伝えください。' })
      return
    }
    if (s.k === 'companionMenu') {
      const menu = matchMenu(text, menus)
      if (menu) { void planParty(s.primary, menu); return }
      if (parseYesNo(text) === false) { setStep({ k: 'confirm', req: s.primary.req, menu: s.primary.menu, slot: s.primary.slot, staffId: s.primary.staffId, staffChosen: true }); return }
      setStep({ ...s })
      return
    }
    if (s.k === 'confirmParty') {
      const yes = parseYesNo(text)
      if (yes === true) { void bookParty(s); return }
      if (s.togetherAt && /同時|一緒/.test(text)) { setStep({ ...s, primary: { ...s.primary, slot: { starts_at: s.togetherAt }, req: reqFromSlot(s.togetherAt) }, companion: { ...s.companion, slot: { starts_at: s.togetherAt } }, togetherAt: null }); return }
      if (yes === false) { declineConfirm(s.primary.menu); return }
      setStep({ ...s })
      return
    }
    // 確認画面の「はい」「いいえ」は、その場で決める（AI に聞かない）
    if (s.k === 'confirm' || s.k === 'confirmCancel') {
      const yes = parseYesNo(text)
      if (yes === true) { if (s.k === 'confirm') void book(s.menu, s.slot, s.req, s.staffId ?? null, replaceOf(s)); else void cancelReservation(s.reservation); return }
      if (yes === false) { declineConfirm(s.k === 'confirm' ? s.menu : undefined); return }
    }
    // 髪型の相談（日時・メニューの話が無いもの）だけは、相談用の AI に聞く
    const consultOnly = detectAsk(text, menus)?.kind === 'consult' && isEmptyRequest(parseVisitRequest(text)) && !matchMenu(text, menus)
    if (aiOnRef.current && AI_STEPS.has(s.k) && !consultOnly) { void viaAgent(text, s); return }
    legacyRef.current(text, s.k === 'ai' || s.k === 'confirmCancel' || s.k === 'welcome' ? { k: 'askWhen' } : s)
  }, [handleLocalRequest, book, bookParty, cancelReservation, chooseStaff, declineConfirm, goBack, menus, planParty, viaAgent])

  /** 決まった規則の JOHNNY（AI が使えないとき・デモ） */
  const handleLegacy = useCallback((text: string, s: Step) => {
    // 予約の途中の質問：時間・料金はメニュー表で答える（無料）。髪型の相談だけ AI に聞く。答えたら今の質問に戻る
    if (s.k === 'askWhen' || s.k === 'askMenu' || s.k === 'pick' || s.k === 'overview') {
      const question = detectAsk(text, menus)
      const follow = s.k === 'askWhen' ? 'ご希望の日時をお聞かせください。' : s.k === 'askMenu' || s.k === 'overview' ? 'メニューはどれにしますか？' : 'どの時間にしますか？'
      if (question?.kind === 'menu_info') {
        const reply = answerMenuInfo(question)
        setAnswer({ forStep: s, text: reply, menus: [question.menu] })
        ask(`${reply}${follow}`)
        return
      }
      if (question?.kind === 'consult') {
        setAnswer({ forStep: s, text: '', menus: [], thinking: true })
        void api.consult(text, menus).then(r => {
          if (stepRef.current !== s) return
          const reply = r?.reply ?? '髪型のご相談は、ご来店のときにスタッフが一緒に考えます。'
          const suggested = (r?.menuCodes ?? []).map(c => menus.find(m => m.code === c)).filter((m): m is MenuOption => !!m)
          setAnswer({ forStep: s, text: reply, menus: suggested })
          ask(`${reply}${follow}`)
        })
        return
      }
    }
    if (s.k === 'askWhen') {
      const req = parseVisitRequest(text)
      // 今回の言葉にメニューが無ければ、先に聞いたメニュー（「濡れパンで」→「明日の15時」）を使う
      const menu = matchMenu(text, menus) ?? s.menu ?? null
      if (isEmptyRequest(req)) {
        // 日時は無いがメニューだけ言った → 日時を聞き返さず、近い日から空きを探して案内する
        if (menu) void search(req, menu)
        else setStep({ k: 'askWhen', again: 'unclear', menu: s.menu })
        return
      }
      if (menu) { void search(req, menu); return }
      if (menus.length === 1) { void search(req, menus[0]); return }
      // メニューがまだ：その日の空き状況を先に見て、入れられるメニューと時刻を案内する
      void advise(req)
      return
    }
    if (s.k === 'overview') {
      const menu = matchMenu(text, menus)
      if (menu) { pickFromOverview(s, menu); return }
      const req = parseVisitRequest(text)
      if (!isEmptyRequest(req)) { void advise(req); return }
      setStep({ ...s })
      return
    }
    if (s.k === 'askMenu') {
      const menu = matchMenu(text, menus)
      if (menu) void search(s.req, menu)
      else setStep({ ...s })
      return
    }
    if (s.k === 'pick') {
      const req = parseVisitRequest(text)
      if (req.time) {
        const hit = s.offer.slots.find(x => {
          const sameTime = `${String(Math.floor(jstMinutes(x.starts_at) / 60)).padStart(2, '0')}:${String(jstMinutes(x.starts_at) % 60).padStart(2, '0')}` === req.time
          const sameDay = req.dates.length === 0 || req.dates.includes(new Date(new Date(x.starts_at).getTime() + JST).toISOString().slice(0, 10))
          return sameTime && sameDay
        })
        if (hit) { setStep({ k: 'confirm', req: s.req, menu: s.menu, slot: hit }); return }
      }
      if (!isEmptyRequest(req)) { void search({ ...req, dates: req.dates.length ? req.dates : s.req.dates }, s.menu); return }
      setStep({ ...s })
      return
    }
    if (s.k === 'confirm') {
      const yes = parseYesNo(text)
      if (yes === true) { void book(s.menu, s.slot, s.req, s.staffId ?? null, replaceOf(s)); return }
      if (yes === false) { setStep({ k: 'askWhen', again: 'retry', menu: s.menu }); return }
      setStep({ ...s })
    }
  }, [advise, api, ask, book, menus, pickFromOverview, search])
  useEffect(() => { handleTextRef.current = handleText }, [handleText])
  useEffect(() => { legacyRef.current = handleLegacy }, [handleLegacy])

  /** 録音した声：サーバーで文字にして、そのまま AI の答えまで受け取る（確認画面・AI が使えないときは文字にするだけ） */
  const handleAudio = useCallback(async (audio: Blob) => {
    const s = stepRef.current
    const partyStep = s.k === 'companionMenu' || s.k === 'confirmParty' || s.k === 'askUsual'
    // 担当を選ぶ画面の声も受け取る（文字にするだけ。ここで捨てると、話しても反応しない）
    if (!AI_STEPS.has(s.k) && !partyStep && s.k !== 'pickStaff') return
    let transcribeOnly = !aiOnRef.current || partyStep || s.k === 'confirm' || s.k === 'confirmCancel' || s.k === 'pickStaff'
    if (!transcribeOnly && !takeAiTurn()) { aiOnRef.current = false; transcribeOnly = true }
    setVoiceNote(null)
    setHeard('')
    setStep({ k: 'searching', label: transcribeOnly ? '聞き取っています' : '考えています' })
    const history = turnsRef.current
    const r = await api.agentVoice(audio, history, shownFor(s), transcribeOnly)
    if (!r || !r.heard) {
      setVoiceNote(r ? '聞き取れませんでした。もう一度話してください。' : '通信できませんでした。もう一度話すか、キーボードで入力してください。')
      stepRef.current = s
      setStep({ ...s })
      return
    }
    setHeard(r.heard)
    if (transcribeOnly) { stepRef.current = s; setStep(s); handleText(r.heard); return }
    // 音声でも文字と同じ意図確認・案内を優先し、AI の誤った時刻候補を表示しない。
    if (handleLocalRequest(r.heard, s)) { stepRef.current = s; return }
    const next = r.answer ? await stepFromAgent(r.answer) : null
    if (!r.answer || !next) {
      // 聞き取れたが AI が答えられなかった：決まった規則の JOHNNY で続ける
      aiOnRef.current = false
      const back: Step = s.k === 'ai' || s.k === 'welcome' ? { k: 'askWhen' } : s
      stepRef.current = back
      legacyRef.current(r.heard, back)
      return
    }
    turnsRef.current = [...history, { role: 'user' as const, text: r.heard }, { role: 'assistant' as const, text: r.answer.say }].slice(-20)
    setStep(next)
  }, [handleLocalRequest, api, handleText, stepFromAgent])
  useEffect(() => { handleAudioRef.current = audio => { void handleAudio(audio) } }, [handleAudio])

  /** 答えに出したおすすめのメニューを選ぶ（今の段階に合わせて続ける） */
  const chooseMenu = useCallback((menu: MenuOption) => {
    const s = stepRef.current
    setAnswer(null)
    if (aiOnRef.current) { handleText(menu.name); return }
    if (s.k === 'askWhen') void search({ dates: [], time: null, range: null, earliest: true }, menu)
    else if (s.k === 'overview') pickFromOverview(s, menu)
    else if (s.k === 'askMenu' || s.k === 'pick') void search(s.req, menu)
  }, [handleText, pickFromOverview, search])

  /** 確認画面のお会計と、使える券 */
  const confirmPrice = useMemo((): { key: string; usable: TicketRow[]; selected: TicketRow[]; price: PriceBreakdown } | null => {
    if (step.k !== 'confirm' || step.change) return null
    const key = `${step.menu.code}|${step.slot.starts_at}`
    const usable = usableTickets(myTickets, step.slot.starts_at, step.menu.code)
    const ids = couponPick.key === key ? couponPick.ids : []
    const selected = usable.filter(t => ids.includes(t.id))
    const price = priceFor(step.menu.code, step.menu.price, step.slot.starts_at, selected)
    return price ? { key, usable, selected, price } : null
  }, [step, myTickets, couponPick])
  // 銀Pay で払える（口座があり、使える額がお会計以上）なら、選んでいる間は確定のあとに押さえる
  const ginpayChoice = confirmPrice && ginpay && confirmPrice.price.total > 0
    ? { available: ginpay.available, enough: ginpay.available >= confirmPrice.price.total, on: payGinpay && ginpay.available >= confirmPrice.price.total }
    : null
  const ginpayOn = !!ginpayChoice?.on
  // 確認画面にいる間だけ書き換える（確定を押すと画面が「予約中」に変わるので、そこで消さない。使ったら book 側で消す）
  useEffect(() => {
    if (confirmPrice) ginpayPlanRef.current = ginpayOn ? { key: confirmPrice.key, amount: confirmPrice.price.total } : { key: '', amount: 0 }
  }, [confirmPrice, ginpayOn])
  const toggleCoupon = (key: string, id: string) => setCouponPick(p => {
    const ids = p.key === key ? p.ids : []
    return { key, ids: ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id] }
  })

  // ── 段階ごとの言葉（画面と読み上げ） ──
  const prompt = useMemo((): { title: string; sub?: string; speech?: string; listen?: boolean } => {
    switch (step.k) {
      case 'loading': return { title: '' }
      case 'contact': return {
        title: 'ご予約のお名前（フルネーム）とお電話番号を教えてください',
        sub: '下のお名前だけ・ニックネームではなく、姓と名の両方をご入力ください。ご予約の確認でお店からご連絡することがあります。',
        speech: 'ご予約のために、フルネームのお名前と、お電話番号を教えてください。',
      }
      case 'welcome': {
        const t = welcomeText(step.w)
        return { title: t.title, sub: t.lines.join(''), speech: t.speech, listen: true }
      }
      case 'askWhen': {
        const title = step.again === 'unclear' ? 'すみません、日時を聞き取れませんでした。'
          : step.again === 'none' ? 'その日は空きがありませんでした。'
          : step.again === 'retry' ? '別の日時をお聞かせください。'
          : step.again === 'menu' && step.menu ? `${step.menu.name}ですね。`
          : step.again === 'menu' && step.label ? `「${step.label}」ですね。`
          : 'いつのご来店をご希望ですか？'
        const follow = step.again === 'unclear' ? 'もう一度、ご希望の日時をお聞かせください。'
          : step.again === 'none' ? 'ほかのご希望の日時をお聞かせください。'
          : step.again === 'menu' ? 'いつのご来店をご希望ですか？' : undefined
        return { title, sub: follow ?? '例：明日の15時、今日か明日の夕方', speech: follow ? `${title}${follow}` : title, listen: true }
      }
      case 'askMenu': return { title: 'メニューはどれにしますか？', speech: 'メニューはどれにしますか？', listen: true }
      case 'overview': {
        const word = dayWord(step.advice.date)
        const a = adviceSpeech(step.advice, word, { isToday: step.advice.date === jstDate(0), time: step.req.time })
        return { title: step.note ?? a.title, sub: step.note ? `${a.title}・${a.sub}` : a.sub, speech: `${step.note ?? ''}${a.speech}`, listen: true }
      }
      case 'searching': return { title: step.label ?? '空き状況を確認しています' }
      case 'ai': return { title: step.say, listen: true, speech: step.say }
      case 'confirmCancel': return isLateForAi(step.reservation.starts_at)
        ? { title: 'この予約をキャンセルしますか？', speech: `${step.say}ご予約の2時間前を過ぎています。今キャンセルすると、${monthDay(resumeIfCancelledNow())}までAI予約がご利用いただけません。お電話でのキャンセルなら対象外です。`, listen: true }
        : { title: 'この予約をキャンセルしますか？', speech: step.say, listen: true }
      case 'cancelling': return { title: 'キャンセルしています' }
      case 'companionMenu': return { title: 'お連れ様のメニューは何にしますか？', speech: 'お連れ様のメニューは何にしますか？', listen: true }
      case 'askUsual': return step.note
        ? { title: step.note, speech: step.note, listen: true }
        : { title: 'まだいつものメニューが登録されていません', sub: 'いつものメニューを、声で教えてください。', speech: 'まだいつものメニューが登録されていません。いつものメニューを、声で教えてください。', listen: true }
      case 'usualSaved': return step.failed
        ? { title: `${step.menu.name}を、いつものメニューに登録できませんでした`, sub: 'この端末では保存できませんでした。予約はこのまま続けられます。', speech: `すみません、この端末では、いつものメニューを保存できませんでした。予約は${step.menu.name}で、このまま続けられます。` }
        : pushAsk
        ? { title: `${step.menu.name}を、いつものメニューに登録しました`, sub: '14日以内なら、メンテナンスカットのお知らせもできます。', speech: `ありがとうございます。${step.menu.name}を、いつものメニューに登録しますね。14日以内だと、メンテナンスカットのお知らせもできます。こちらも登録しますか？` }
        : { title: `${step.menu.name}を、いつものメニューに登録しました`, sub: '次回からは、ホームの「いつもの」で予約できます。', speech: `ありがとうございます。${step.menu.name}を、いつものメニューに登録しますね。次回からは、いつもので予約ができますよ。` }
      case 'confirmParty': {
        const same = step.companion.slot.starts_at === step.primary.slot.starts_at
        const head = same ? `${spokenVisit(step.primary.slot.starts_at)}、お二人同時にご案内できます。`
          : `お連れ様は${spokenTime(step.companion.slot.starts_at)}からご案内できます。`
        const alt = step.togetherAt ? `お二人同時なら${spokenTime(step.togetherAt)}からいけます。` : ''
        return {
          title: same ? 'お二人同時にご案内できます' : `お連れ様は ${formatVisit(step.companion.slot.starts_at).time} からご案内できます`,
          sub: alt || undefined,
          speech: `${head}${alt}この内容でよろしいですか？`,
          listen: true,
        }
      }
      case 'cancelled': return step.reservation.ai_paused_until
        ? { title: 'ご予約をキャンセルしました', sub: `${monthDay(step.reservation.ai_paused_until)}から、AI予約をまたご利用いただけます。それまではお電話でご予約ください。`, speech: `ご予約をキャンセルしました。${monthDay(step.reservation.ai_paused_until)}から、AI予約をまたご利用いただけます。それまではお電話でご予約ください。` }
        : { title: 'ご予約をキャンセルしました', sub: 'またのご来店をお待ちしています。', speech: 'ご予約をキャンセルしました。またのご来店をお待ちしています。' }
      case 'pick': {
        const times = step.offer.slots.map(x => spokenTime(x.starts_at)).join('、')
        const missed = step.offer.kind === 'nearby' && step.req.time
        const day = formatVisit(step.offer.slots[0].starts_at)
        const head = step.note ?? (missed ? `${step.req.time?.replace(/^0/, '')}は埋まっています。` : '')
        // 近い日から探した候補は日をまたぐことがある：「明日の11時、あさっての10時」
        const multiDay = new Set(step.offer.slots.map(x => slotDate(x.starts_at))).size > 1
        const spoken = multiDay ? step.offer.slots.map(x => spokenVisit(x.starts_at)).join('、') : `${day.relative ?? day.date}は${times}`
        return {
          title: step.note ? step.note : missed ? `${step.req.time?.replace(/^0/, '')} は埋まっています` : `${day.relative ?? day.date} の空き`,
          sub: step.wholeDay ? '朝から夜までの空きから選べます。どれにしますか？' : step.note ? `${step.menu.name}のいちばん早い空きです。どれにしますか？` : '近い時間をご案内します。どれにしますか？',
          speech: step.wholeDay ? `${head}${spoken}が空いています。どれにしますか？` : step.note ? `${head}いちばん早いのは、${spoken}です。どれにしますか？` : `${head}${spoken}が空いています。どれにしますか？`,
          listen: true,
        }
      }
      case 'pickStaff': {
        const names = (options?.staff ?? []).map(st => st.name).join('と')
        return {
          title: '担当をお選びください',
          sub: step.note ?? `${visitLabel(step.next.slot.starts_at)}・${step.next.menu.name}`,
          speech: step.note ?? `担当は、${names}、どちらにしますか？`,
          listen: true,
        }
      }
      case 'confirm': {
        const rep = !step.change ? ownActive : null
        if (!rep && !step.change && phoneReservation) {
          const day = `${Number(phoneReservation.visitDate.slice(5, 7))}月${Number(phoneReservation.visitDate.slice(8, 10))}日`
          return {
            title: `現在、${day}にお電話で${phoneReservation.title}をご予約されています。こちらのご予約に変えますか？`,
            sub: 'お電話のご予約は、お手数ですがお店にキャンセルをお伝えください。',
            speech: `現在、${day}にお電話で${phoneReservation.title}をご予約されています。ご予約はおひとり1つまでです。${spokenVisit(step.slot.starts_at)}の${step.menu.name}に変えますか？お電話のご予約は、お店にキャンセルをお伝えください。`,
            listen: true,
          }
        }
        if (rep) {
          const names = rep.items.map(i => i.name).join('・')
          return {
            title: `現在、${visitLabel(rep.starts_at)}に${names}をご予約されています。キャンセルして、こちらをご予約しますか？`,
            speech: `現在、${spokenVisit(rep.starts_at)}に${names}をご予約されています。ご予約はおひとり1つまでです。そちらをキャンセルして、${spokenVisit(step.slot.starts_at)}の${step.menu.name}をご予約しますか？`,
            listen: true,
          }
        }
        return {
        title: step.change ? 'この日時に変更しますか？' : 'この日時でお間違いないですか？',
        speech: `${step.say ?? `${spokenVisit(step.slot.starts_at)}、${step.menu.name}でお取りできます。この日時でお間違いないですか？`}${couponSpeech(step.change ? null : priceFor(step.menu.code, step.menu.price, step.slot.starts_at, []), step.change ? 0 : usableTickets(myTickets, step.slot.starts_at, step.menu.code).length)}`,
        listen: true,
        }
      }
      case 'booking': return { title: 'ご予約を確定しています' }
      case 'done': return step.companion || step.companionFailed
        ? step.companionFailed
          ? { title: 'ご本人のご予約をお取りしました', sub: 'お連れ様の時間はちょうど埋まってしまいました。お連れ様の分は、もう一度お伝えください。', speech: 'ご本人のご予約をお取りしました。お連れ様の時間はちょうど埋まってしまいました。' }
          : { title: 'お二人のご予約が完了しました', sub: '当日は QR をご提示ください。', speech: 'お二人のご予約が完了しました。当日はQRをご提示ください。' }
        : step.oldKept
        ? { title: '新しいご予約をお取りしました', sub: '元のご予約を取り消せませんでした。お手数ですが、お電話でご連絡ください。', speech: '新しいご予約をお取りしました。元のご予約は取り消せなかったので、お電話でご連絡ください。' }
        : step.changedFrom
          ? { title: 'ご予約を変更しました', sub: '当日は QR をご提示ください。万一お時間の調整が必要なときは、お店からお電話します。', speech: 'ご予約を変更しました。当日はQRをご提示ください。' }
          : { title: 'ご予約が完了しました', sub: '当日は QR をご提示ください。万一お時間の調整が必要なときは、お店からお電話します。', speech: 'ご予約が完了しました。当日はQRをご提示ください。' }
      case 'offer': {
        const v = formatVisit(step.hold.starts_at)
        const menu = step.hold.menu_names ?? 'ご希望のメニュー'
        return {
          title: 'キャンセルが出ました！',
          sub: `${v.relative ?? v.date} ${v.time}〜 ${menu}を、${formatVisit(step.hold.expires_at).time}までお取りしています。`,
          speech: `キャンセルが出ました。${spokenVisit(step.hold.starts_at)}、${menu}をお取りしています。この時間でご予約しますか？`,
        }
      }
      case 'offerGone': return step.reason === 'booked'
        ? { title: 'このお時間は、もうご予約済みです', sub: '当日は QR をご提示ください。', speech: 'このお時間は、もうご予約済みです。' }
        : { title: 'お取りしていた時間が過ぎました', sub: '次にお待ちの方へお回ししました。ほかの日時もお探しできます。', speech: 'お取りしていた時間が過ぎてしまいました。ほかの日時もお探しできますよ。' }
      case 'unknown': return { title: '予約の結果を確認できませんでした', sub: '通信が切れた可能性があります。予約が入っているか確認します。' }
      case 'unavailable': return step.reason === 'booking_disabled'
        ? { title: 'アプリからのご予約は準備中です', sub: 'お電話か HOT PEPPER Beauty でご予約ください。' }
        : step.reason === 'auth'
          ? { title: 'ご予約には会員の引き継ぎが必要です', sub: '店頭で受け取った6桁の引き継ぎコードを入力してください。お電話でもご予約いただけます。' }
          : { title: '通信できませんでした', sub: '電波の良い場所で、もう一度お試しください。' }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 券の読み込みで読み上げ直さない
  }, [step])

  // 段階が変わったら読み上げ（同じ段階の聞き直しでも読み上げる）
  useEffect(() => {
    if (prompt.speech) ask(prompt.speech, prompt.listen ?? false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 段階の切り替わりだけで読み上げる
  }, [step])

  const submitDraft = () => { const t = draft; setDraft(''); handleText(t) }

  const orb: OrbState = voice.listen === 'listening' ? 'listening'
    : step.k === 'searching' || step.k === 'booking' || step.k === 'loading' || step.k === 'cancelling' ? 'thinking'
    : voice.speaking ? 'speaking' : 'idle'
  // いつものメニュー：予約が済んだら、そのメニューを登録するか聞く（変更の予約・今のいつものと同じメニューは聞かない）
  const usualNow = getUsualMenu()
  const doneCode = step.k === 'done' && !step.changedFrom ? step.reservation.items[0]?.menu_code : undefined
  const doneMenu = doneCode && canBeUsual(doneCode) ? menus.find(m => m.code === doneCode) : undefined
  const doneUsual = doneMenu && (usualDone === doneMenu.code || usualNow?.code !== doneMenu.code) ? doneMenu : undefined
  const canTalk = ['pickStaff', 'welcome', 'askWhen', 'askMenu', 'overview', 'pick', 'confirm', 'ai', 'confirmCancel', 'companionMenu', 'confirmParty', 'askUsual'].includes(step.k)
  // 一覧や確認を出す段階は球を小さくして、内容を1画面に収める
  const compact = ['pickStaff', 'welcome', 'askMenu', 'overview', 'pick', 'confirm', 'booking', 'done', 'unknown', 'confirmCancel', 'cancelling', 'cancelled', 'companionMenu', 'confirmParty', 'askUsual', 'usualSaved'].includes(step.k)
    || (step.k === 'ai' && step.view.kind !== 'talk')
  const voiceOff = voice.listen === 'unsupported' || voice.listen === 'denied'

  return (
    <motion.div
      ref={viewportRef}
      className="customer-johnny"
      role="dialog"
      aria-modal="true"
      aria-label="予約アシスタント"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      style={{
        position: 'fixed', left: 0, right: 0, top: 'var(--customer-visual-top, 0px)', height: 'var(--customer-visual-height, 100%)', zIndex: 10030, background: C.bg, color: C.text, fontFamily: FONT,
        display: 'flex', flexDirection: 'column', minHeight: 0, boxSizing: 'border-box',
        paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      {/* 上：閉じる・読み上げ */}
      <div style={{ display: 'flex', flexShrink: 0, justifyContent: 'space-between', padding: '8px 8px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <IconButton label="閉じる" onClick={onClose}><X size={22} strokeWidth={2} /></IconButton>
          {/* 考えている・送っている間は出さない（あとから届いた答えで戻った画面が上書きされないように） */}
          {canBack && canReturnTo(step) && (
            <button type="button" onClick={() => goBack()} aria-label="ひとつ前の画面に戻る" style={{
              height: 40, padding: '0 14px 0 8px', borderRadius: 20, border: 'none', background: C.fill, color: C.text,
              display: 'flex', alignItems: 'center', gap: 2, fontSize: 15, fontFamily: FONT, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
            }}><ChevronLeft size={20} strokeWidth={2} />戻る</button>
          )}
        </div>
        <IconButton label={voice.muted ? '読み上げをオンにする' : '読み上げをオフにする'} onClick={() => voice.setMuted(!voice.muted)}>
          {voice.muted ? <VolumeX size={20} strokeWidth={1.8} /> : <Volume2 size={20} strokeWidth={1.8} />}
        </IconButton>
      </div>

      {/* 中央：JOHNNY・質問・聞き取った言葉・選択肢 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 20px 16px' }}>
        <div className="johnny-rider-wrap" style={{ marginTop: 'min(4vh, 32px)', width: '100%', display: 'flex', justifyContent: 'center' }}>
          <JohnnyRider state={orb} width={compact ? 200 : 340} />
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={`${step.k}-${'again' in step ? step.again ?? '' : ''}-${step.k === 'ai' ? step.say : ''}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            {prompt.title && (
              <h1 className="johnny-question-title" style={{ margin: '20px 0 0', fontSize: step.k === 'ai' && prompt.title.length > 24 ? 20 : 26, fontWeight: 600, lineHeight: 1.3, textAlign: 'center', letterSpacing: '-0.01em' }}>
                {prompt.title}
              </h1>
            )}
            {prompt.sub && (
              <p style={{ margin: '8px 0 0', fontSize: 15, lineHeight: 1.5, color: C.secondary, textAlign: 'center' }}>{prompt.sub}</p>
            )}

            {step.k === 'welcome' && (
              <List>
                {/* 並び（10/29 慶一郎さん）：いつものメニュー → メンテナンスカット → いつもの担当 → いつものメニューを変える → ほか */}
                {step.w.usual.filter(m => m.code !== 'maintenance').map(m => (
                  <Row key={m.code} onClick={() => handleText(m.name)} title={`${m.name}で予約`} detail={yen(m)} note="いつもの" />
                ))}
                {step.w.maintenanceLeft != null ? (
                  <Row onClick={startMaintenance} title="メンテナンスカットで予約" detail={step.w.maintenanceLeft === 0 ? '今日まで' : `あと${step.w.maintenanceLeft}日`} />
                ) : step.w.usual.some(m => m.code === 'maintenance') && (
                  <Row onClick={startMaintenance} title="メンテナンスカットで予約" detail={maintenanceMenu ? `${maintenanceMenu.duration_min}分・${yen(maintenanceMenu)}` : 'ホットペッパー'} note="いつもの" />
                )}
                {/* いつもの担当：押すたびに 担当1 → 担当2 → 毎回選ぶ と切り替わる */}
                {(options?.staff?.length ?? 0) > 1 && (
                  <Row onClick={cycleUsualStaff} title="いつもの担当" detail={options?.staff?.find(st => st.id === usualStaffId)?.name ?? '毎回選ぶ'} />
                )}
                <Row onClick={() => { const now = getUsualMenu(); setStep({ k: 'askUsual', note: `${now ? `今のいつものメニューは${now.name}です。` : ''}いつものメニューを、どれに変えますか？` }) }} title="いつものメニューを変える" />
                {/* いつもの・メンテナンスカットだけしか選べないと思われないように（10/27 慶一郎さん） */}
                <Row onClick={() => setStep({ k: 'askMenu', req: { dates: [], time: null, range: null, earliest: true } })} title="ほかのメニューから選ぶ" />
                <Row onClick={() => setStep({ k: 'askWhen' })} title="日時を伝えて予約する" muted />
              </List>
            )}

            {/* メニューが決まったとき（「いつもの」など）：日にちを押して進める。前回のご来店から14日以内ならメンテナンスカットにも切り替えられる（過ぎていたら出さない） */}
            {step.k === 'askWhen' && step.again === 'menu' && step.menu && step.menu.code !== 'maintenance' && (
              <List>
                {/* 日にちを押すだけで進める（話さなくても予約できる・10/29 慶一郎さん）：今日・明日・明後日・もっと先 */}
                {[0, 1, 2].map(i => {
                  const d = jstDate(i)
                  return <Row key={d} onClick={() => void pickDay(step.menu!, d)} title={['今日', '明日', '明後日'][i]} detail={`${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${'日月火水木金土'[new Date(`${d}T12:00:00Z`).getUTCDay()]}）`} />
                })}
                <Row onClick={() => { const m = step.menu!; void soonest(m, { dates: [], time: null, range: null, earliest: true }, jstDate(3), `${m.name}の、明々後日からの空きです。`) }} title="もっと先の日" detail="近い空きから" />
                {maintLeft != null && maintenanceMenu && <Row onClick={startMaintenance} title="メンテナンスカット" detail={`${maintLeft === 0 ? '今日まで' : `あと${maintLeft}日`}・${yen(maintenanceMenu)}`} />}
              </List>
            )}

            {step.k === 'askMenu' && (
              <List>
                {menus.map(m => (
                  <Row key={m.code} onClick={() => handleText(m.name)}
                    title={m.name} detail={`${m.duration_min}分・${yen(m)}`} note={m.code === lastMenuCode ? '前回' : undefined} />
                ))}
              </List>
            )}

            {step.k === 'overview' && (
              <List>
                {step.advice.available.map(x => (
                  <Row key={x.menu.code} onClick={() => pickFromOverview(step, x.menu)}
                    title={x.menu.name}
                    detail={`${step.req.time ? formatVisit(x.slots[0].starts_at).time : `${formatVisit(x.slots[0].starts_at).time}から`}・${x.menu.duration_min}分・${yen(x.menu)}`}
                    note={x.menu.code === lastMenuCode ? '前回' : undefined} />
                ))}
              </List>
            )}

            {step.k === 'pick' && (
              <List>
                {step.offer.slots.map(x => (
                  <Row key={x.starts_at} onClick={() => setStep({ k: 'confirm', req: step.req, menu: step.menu, slot: x })}
                    title={formatVisit(x.starts_at).time} detail={formatVisit(x.starts_at).date} />
                ))}
                <Row onClick={() => setStep({ k: 'askWhen', again: 'retry', menu: step.menu })} title="別の日時にする" muted />
              </List>
            )}

            {step.k === 'ai' && step.view.kind === 'menus' && (
              <AiMenuList view={step.view} lastMenuCode={lastMenuCode}
                onPick={(menu, date) => handleText(date ? `${dateWord(date)}の${menu.name}` : menu.name)} />
            )}

            {step.k === 'ai' && step.view.kind === 'slots' && (
              <AiSlotList view={step.view}
                onPick={(v, slot) => setStep({ k: 'confirm', req: reqFromSlot(slot.starts_at), menu: v.menu, slot, staffId: v.staffId })}
                onOther={() => setStep({ k: 'ai', say: 'ご希望の日時をお聞かせください。', view: { kind: 'talk', handoff: false } })} />
            )}

            {step.k === 'ai' && step.view.kind === 'reservations' && (
              <List>
                {step.view.list.map(r => (
                  <Row key={r.id} onClick={() => handleText(`${visitLabel(r.starts_at)}の予約`)}
                    title={visitLabel(r.starts_at)} detail={`${r.items.map(i => i.name).join('・')}${companionIds().includes(r.id) ? '（お連れ様）' : ''}`} />
                ))}
              </List>
            )}

            {step.k === 'ai' && step.view.kind === 'maintenanceChoice' && (
              <List>
                <Row onClick={() => { setHeard('次のメンテナンスの目安'); void answerInfo('maintenance') }} title="次のメンテナンスの目安" />
                <Row onClick={() => handleText('メンテナンスカットを予約したい')} title="メンテナンスカットを予約" detail={maintenanceMenu ? `${maintenanceMenu.duration_min}分・${yen(maintenanceMenu)}` : 'ホットペッパー'} />
              </List>
            )}

            {step.k === 'ai' && step.view.kind === 'maintenance' && (
              <List>
                <Row href={MAINTENANCE_CUT_URL} title="メンテナンスカットで予約" detail="ホットペッパー" />
              </List>
            )}

            {step.k === 'ai' && step.view.kind === 'waitlist' && (
              <WaitlistCard api={api} view={step.view} />
            )}

            {step.k === 'offer' && (
              <List>
                <Row title={step.hold.menu_names ?? 'ご予約'} detail={`${formatVisit(step.hold.starts_at).date} ${formatVisit(step.hold.starts_at).time}〜${step.hold.staff_name ? '・' + step.hold.staff_name : ''}`} />
              </List>
            )}

            {step.k === 'ai' && step.view.kind === 'talk' && step.view.handoff && (
              <List>
                <Row href={SHOP_PHONE_TEL} title="電話で問い合わせる" detail={SHOP_PHONE_DISPLAY} />
              </List>
            )}

            {(step.k === 'confirm' || step.k === 'booking') && (
              <Summary menu={step.menu} slot={step.slot} hidePrice={step.k === 'confirm' && !!confirmPrice}
                staffName={step.k !== 'confirm' ? undefined : step.staffId ? options?.staff?.find(x => x.id === step.staffId)?.name ?? '指名あり' : undefined}
                before={step.k === 'confirm' ? step.change ?? ownActive ?? undefined : undefined} />
            )}

            {step.k === 'askUsual' && (
              <List>
                {usualMenuOrder(menus).map(m => (
                  <Row key={m.code} onClick={() => handleText(m.name)} title={m.name} detail={`${m.duration_min}分・${yen(m)}`} />
                ))}
              </List>
            )}
            {step.k === 'usualSaved' && !step.failed && <PushToggle tone="mono" />}

            {step.k === 'companionMenu' && (
              <List>
                {menus.map(m => (
                  <Row key={m.code} onClick={() => handleText(m.name)} title={m.name} detail={`${m.duration_min}分・${yen(m)}`} />
                ))}
              </List>
            )}

            {step.k === 'confirmParty' && (
              <div style={{ width: '100%', marginTop: 24, borderRadius: 14, overflow: 'hidden', background: C.fill }}>
                <SummaryRow label="ご本人" value={`${visitLabel(step.primary.slot.starts_at)}・${step.primary.menu.name}`} />
                <SummaryRow label="お連れ様" value={`${formatVisit(step.companion.slot.starts_at).time}・${step.companion.menu.name}`} />
              </div>
            )}

            {step.k === 'confirm' && confirmPrice && (
              <PriceBox menuName={step.menu.name} price={confirmPrice.price} usable={confirmPrice.usable} selected={confirmPrice.selected}
                onToggle={id => toggleCoupon(confirmPrice.key, id)} ginpay={ginpayChoice} onGinpay={() => setPayGinpay(v => !v)} />
            )}
            {step.k === 'confirm' && !step.change && <p style={{ margin: '10px 2px 0', fontSize: 12, lineHeight: 1.6, color: C.secondary }}>{BOOKING_RULE_NOTE}</p>}

            {step.k === 'confirmCancel' && isLateForAi(step.reservation.starts_at) && (
              <div role="note" style={{ margin: '0 0 12px', padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(214,82,82,0.45)', background: 'rgba(214,82,82,0.08)', fontSize: 13, lineHeight: 1.7, color: C.text }}>
                <b>ご予約の2時間前を過ぎています。</b><br />
                今アプリでキャンセルすると、{monthDay(resumeIfCancelledNow())}までAI予約がご利用いただけません。
                お電話でのキャンセルなら対象外です。<br />
                <a href={SHOP_PHONE_TEL} style={{ color: 'inherit', fontWeight: 700 }}>☎ {SHOP_PHONE_DISPLAY}</a>
              </div>
            )}

            {step.k === 'done' && <ReservationSummary r={step.reservation} />}
            {step.k === 'done' && step.ginpay !== undefined && (
              <p style={{ width: '100%', margin: '10px 0 0', padding: '12px 14px', borderRadius: 14, background: step.ginpay === 'failed' ? C.fill : 'rgba(168,130,63,0.10)', fontSize: 14, lineHeight: 1.6, color: C.text }}>
                {step.ginpay === 'failed'
                  ? '銀Payの仮支払いはできませんでした。お支払いは店頭でどうぞ。'
                  : <><b>✓ 銀Pay 仮支払い済み {yenOf(step.ginpay)}</b><br /><span style={{ color: C.secondary, fontSize: 13 }}>ご来店時にレジで会員QRを読むと、お支払いが確定します。</span></>}
              </p>
            )}
            {step.k === 'done' && doneUsual && usualDone === 'failed' && (
              <p role="alert" style={{ width: '100%', margin: '10px 0 0', padding: '12px 14px', borderRadius: 14, background: C.fill, fontSize: 14, lineHeight: 1.6, color: C.text }}>
                この端末では、いつものメニューを保存できませんでした。ご予約はお取りできています。
              </p>
            )}
            {step.k === 'done' && doneUsual && usualDone !== 'failed' && (usualDone === doneUsual.code
              ? <p style={{ width: '100%', margin: '10px 0 0', padding: '12px 14px', borderRadius: 14, background: C.fill, fontSize: 14, lineHeight: 1.6, color: C.text }}>
                  <b>✓ {doneUsual.name}を、いつものメニューに登録しました</b><br />
                  <span style={{ color: C.secondary, fontSize: 13 }}>次回は、ホームの「いつもの」で予約ができますよ。14日以内なら、メンテナンスカットのお知らせもできます。</span>
                </p>
              : <div style={{ width: '100%', margin: '10px 0 0', padding: '12px 14px', borderRadius: 14, background: C.fill }}>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: C.text }}>{doneUsual.name}を、いつものメニューに登録しますか？</p>
                  <p style={{ margin: '2px 0 10px', fontSize: 12, lineHeight: 1.6, color: C.secondary }}>{usualNow ? `今のいつものメニュー（${usualNow.name}）と入れ替わります。` : '次回から、ホームの「いつもの」で予約できます。'}</p>
                  <button type="button" onClick={() => setUsualDone(saveUsual(doneUsual) ? doneUsual.code : 'failed')} style={{ minHeight: 44, padding: '0 18px', borderRadius: 12, border: 'none', background: C.text, color: C.bg, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>登録する</button>
                </div>)}
            {step.k === 'done' && <PushToggle tone="mono" />}
            {step.k === 'done' && step.companion && <ReservationSummary r={step.companion} companion />}

            {(step.k === 'confirmCancel' || step.k === 'cancelling' || step.k === 'cancelled') && <ReservationSummary r={step.reservation} />}

            {step.k === 'contact' && (
              <ContactForm
                onSave={(name, phone) => api.saveContact(name, phone)}
                onSaved={() => setStep({ k: 'askWhen' })}
              />
            )}

            {step.k === 'unavailable' && (
              <List>
                <Row href={SHOP_PHONE_TEL} title="電話で予約する" detail={SHOP_PHONE_DISPLAY} />
              </List>
            )}
          </motion.div>
        </AnimatePresence>

        {/* 質問・相談への答え（おすすめのメニューは押すとそのまま選べる） */}
        {answer && answer.forStep === step && (
          <div aria-live="polite" style={{ width: '100%', maxWidth: 420, marginTop: 20 }}>
            <p style={{ margin: 0, padding: '14px 16px', borderRadius: 14, background: C.fill, fontSize: 16, lineHeight: 1.6, color: answer.thinking ? C.secondary : C.text }}>
              {answer.thinking ? '考えています…' : answer.text}
            </p>
            {!answer.thinking && answer.menus.length > 0 && (step.k === 'askWhen' || step.k === 'askMenu' || step.k === 'pick' || step.k === 'overview') && (
              <List>
                {answer.menus.map(m => (
                  <Row key={m.code} title={m.name} detail={`${m.duration_min}分・${yen(m)}`} onClick={() => chooseMenu(m)} />
                ))}
              </List>
            )}
          </div>
        )}

        {/* 聞き取った言葉 */}
        {canTalk && (voice.interim || heard) && (
          <p aria-live="polite" style={{ margin: '20px 0 0', fontSize: 17, color: voice.interim ? C.text : C.tertiary, textAlign: 'center', maxWidth: 360 }}>
            「{voice.interim || heard}」
          </p>
        )}
      </div>

      {/* 下：操作 */}
      <div style={{ padding: '12px 20px 20px', display: 'flex', flexDirection: 'column', flexShrink: 0, maxHeight: '70%', overflowY: 'auto', overscrollBehavior: 'contain', gap: 10, alignItems: 'stretch', maxWidth: 460, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        {step.k === 'pickStaff' && (
          <>
            {(options?.staff ?? []).map(st => step.avail?.[st.id] === false
              ? <SecondaryButton key={st.id} onClick={() => setStep({ ...step, note: `${st.name}は、この時間は空いていません。ほかの担当をお選びください。` })}>{st.name}（この時間は空いていません）</SecondaryButton>
              : <PrimaryButton key={st.id} onClick={() => chooseStaff(step, st.id)}>{st.name}</PrimaryButton>)}
            {!step.next.change && (
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '6px 0 2px', fontSize: 14, color: C.text, cursor: 'pointer' }}>
                <input type="checkbox" checked={rememberStaff} onChange={e => setRememberStaff(e.target.checked)} style={{ width: 20, height: 20, accentColor: C.text }} />
                次回からもこの担当にする（担当の確認を省きます）
              </label>
            )}
          </>
        )}
        {step.k === 'confirm' && (
          <>
            {voice.listen === 'listening' && (
              <p style={{ margin: '0 0 2px', fontSize: 13, color: C.secondary, textAlign: 'center' }}>「はい」「いいえ」と話しても進めます</p>
            )}
            {/* 担当がまだ決まっていない間（いつもの担当の空きを確かめている間）は押せない */}
            <PrimaryButton disabled={!step.staffChosen && !step.staffId && (options?.staff?.length ?? 0) > 1} onClick={() => book(step.menu, step.slot, step.req, step.staffId ?? null, replaceOf(step))}>はい</PrimaryButton>
            {!step.change && (
              <SecondaryButton onClick={() => setStep({ k: 'companionMenu', primary: { menu: step.menu, slot: step.slot, staffId: step.staffId ?? null, req: step.req, replace: ownActive ?? undefined } })}>お連れ様を追加</SecondaryButton>
            )}
            {backList.some(isTimeChoice) && <SecondaryButton onClick={() => goBack(isTimeChoice)}>時間を選び直す</SecondaryButton>}
            {!step.change && step.staffChosen && (options?.staff?.length ?? 0) > 1 && (
              <SecondaryButton onClick={() => setStep({ k: 'pickStaff', next: { ...step, staffId: null, staffChosen: false, usualStaff: false } })}>担当を変える</SecondaryButton>
            )}
            <SecondaryButton onClick={() => declineConfirm(step.menu)}>いいえ</SecondaryButton>
          </>
        )}
        {step.k === 'confirmParty' && (
          <>
            <PrimaryButton onClick={() => bookParty(step)}>はい</PrimaryButton>
            {step.togetherAt && (
              <SecondaryButton onClick={() => handleText('同時で')}>{`お二人同時（${formatVisit(step.togetherAt).time}）にする`}</SecondaryButton>
            )}
            <SecondaryButton onClick={() => declineConfirm(step.primary.menu)}>いいえ</SecondaryButton>
          </>
        )}
        {step.k === 'confirmCancel' && (
          <>
            {voice.listen === 'listening' && (
              <p style={{ margin: '0 0 2px', fontSize: 13, color: C.secondary, textAlign: 'center' }}>「はい」「いいえ」と話しても進めます</p>
            )}
            <PrimaryButton onClick={() => cancelReservation(step.reservation)}>キャンセルする</PrimaryButton>
            <SecondaryButton onClick={() => declineConfirm()}>やめる</SecondaryButton>
          </>
        )}
        {step.k === 'cancelled' && <SecondaryButton onClick={onClose}>閉じる</SecondaryButton>}
        {step.k === 'offer' && (
          <>
            <PrimaryButton onClick={() => void confirmOffer(step.hold)}>{step.busy ? '確定しています…' : 'この時間で予約する'}</PrimaryButton>
            <SecondaryButton onClick={() => void declineOffer(step.hold)}>今回は見送る</SecondaryButton>
          </>
        )}
        {step.k === 'offerGone' && (
          <>
            {step.reason === 'expired' && <PrimaryButton onClick={() => setStep({ k: 'askWhen' })}>ほかの日時を探す</PrimaryButton>}
            <SecondaryButton onClick={onClose}>閉じる</SecondaryButton>
          </>
        )}
        {step.k === 'usualSaved' && (
          <PrimaryButton onClick={() => {
            turnsRef.current = [{ role: 'user', text: `${step.menu.name}で予約したい` }, { role: 'assistant', text: `${step.menu.name}ですね。いつのご来店をご希望ですか？` }]
            setStep({ k: 'askWhen', again: 'menu', menu: step.menu })
          }}>{step.menu.name}で日時を決める</PrimaryButton>
        )}
        {step.k === 'done' && (
          <>
            {onShowQr && <PrimaryButton onClick={() => { onClose(); onShowQr() }}>QR を表示</PrimaryButton>}
            <SecondaryButton onClick={onClose}>閉じる</SecondaryButton>
          </>
        )}
        {step.k === 'unknown' && (
          <PrimaryButton onClick={() => verifyUnknown(step.menu, step.slot)}>予約を確認する</PrimaryButton>
        )}
        {step.k === 'unavailable' && step.reason === 'auth' && (
          <PrimaryButton onClick={() => setBinding(true)}>引き継ぎコードを入力する</PrimaryButton>
        )}
        {step.k === 'unavailable' && step.reason === 'network' && (
          <PrimaryButton onClick={reload}>もう一度試す</PrimaryButton>
        )}
        {step.k === 'unavailable' && (
          <SecondaryButton onClick={onClose}>閉じる</SecondaryButton>
        )}
        {binding && (
          <PreviousTicketsBindDialog
            zIndex={10040}
            onClose={() => setBinding(false)}
            onBound={() => { setBinding(false); reload() }}
          />
        )}

        {canTalk && step.k !== 'confirm' && step.k !== 'confirmCancel' && step.k !== 'confirmParty' && (typing || voiceOff) && (
          <form onSubmit={e => { e.preventDefault(); submitDraft() }} style={{ display: 'flex', gap: 8, width: '100%', minWidth: 0 }}>
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              autoFocus={typing}
              enterKeyHint="send"
              placeholder={step.k === 'askMenu' ? 'メニュー名' : '明日の15時'}
              aria-label="ご希望を入力"
              style={{
                flex: 1, minWidth: 0, height: 48, borderRadius: 24, border: 'none', outline: 'none', padding: '0 18px',
                background: C.fill, color: C.text, fontSize: 17, fontFamily: FONT,
              }}
            />
            <button type="submit" aria-label="送信" disabled={!draft.trim()} style={{
              width: 48, height: 48, flexShrink: 0, borderRadius: 24, border: 'none', background: draft.trim() ? C.text : C.fill,
              color: draft.trim() ? C.bg : C.tertiary, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ArrowUp size={22} strokeWidth={2.2} />
            </button>
          </form>
        )}

        {canTalk && step.k !== 'confirm' && step.k !== 'confirmCancel' && step.k !== 'confirmParty' && !voiceOff && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28, paddingTop: 4 }}>
            <IconButton label={typing ? '音声で答える' : '文字で入力する'} onClick={() => setTyping(t => !t)}>
              <Keyboard size={22} strokeWidth={1.8} />
            </IconButton>
            <MicButton listening={voice.listen === 'listening'} onClick={() => (voice.listen === 'listening' ? (voice.recordMode ? finishListening() : stopListening()) : startListening())} />
            <div style={{ width: 44 }} />
          </div>
        )}
        {canTalk && voice.listen === 'denied' && (
          <p style={{ margin: 0, fontSize: 13, color: C.secondary, textAlign: 'center' }}>マイクが使えないため、文字で入力してください。</p>
        )}
        {canTalk && voice.listen !== 'denied' && (voice.notice || voiceNote) && (
          <p role="status" style={{ margin: 0, fontSize: 13, color: C.secondary, textAlign: 'center' }}>{voice.notice ?? voiceNote}</p>
        )}
      </div>
    </motion.div>
  )
}

// ── 部品 ─────────────────────────────────────────────────────────

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} style={{
      width: 44, height: 44, borderRadius: 22, border: 'none', background: 'transparent', color: C.secondary,
      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
    }}>
      {children}
    </button>
  )
}

function MicButton({ listening, onClick }: { listening: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={listening ? '聞き取りを止める' : '話す'} aria-pressed={listening} style={{
      position: 'relative', width: 72, height: 72, borderRadius: 36, border: 'none', cursor: 'pointer',
      background: listening ? C.bg : C.text, color: listening ? C.text : C.bg,
      boxShadow: listening ? `inset 0 0 0 2px ${C.text}` : 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center', WebkitTapHighlightColor: 'transparent',
      transition: 'background 0.2s, color 0.2s, box-shadow 0.2s',
    }}>
      {listening && (
        <motion.span aria-hidden="true" style={{ position: 'absolute', inset: -6, borderRadius: 42, border: `1px solid ${C.tertiary}` }}
          animate={{ scale: [1, 1.12, 1], opacity: [0.8, 0, 0.8] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }} />
      )}
      <Mic size={28} strokeWidth={2} />
    </button>
  )
}

const buttonBase: CSSProperties = {
  height: 54, borderRadius: 14, border: 'none', fontSize: 17, fontWeight: 600, fontFamily: FONT, cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
}

/** お知らせのリンクの ?hold=… を1回だけ読む（読んだら URL から消す） */
function takeHoldParam(): string | null {
  try {
    const url = new URL(window.location.href)
    const id = url.searchParams.get('hold')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null
    url.searchParams.delete('hold')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    return id
  } catch { return null }
}

/** キャンセル待ちに入れるカード（入れたら、お知らせを受け取っていない人には受け取りのボタン） */
function WaitlistCard({ api, view }: { api: BookingAssistantApi; view: { menu: MenuOption; staffId: string | null; date: string; from: string; to: string } }) {
  const [state, setState] = useState<'ask' | 'busy' | 'joined' | 'error'>('ask')
  const [hasPush, setHasPush] = useState(true)
  const [error, setError] = useState('')
  const whole = view.from === '00:00' && view.to === '23:59'
  const when = dayWord(view.date) + (whole ? '' : ' ' + view.from + '〜' + view.to)
  const join = async () => {
    setState('busy')
    try {
      const r = await api.joinWaitlist(view.date, view.from, view.to, view.menu.code, view.staffId)
      setHasPush(r.has_push)
      setState('joined')
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      setError(code === 'waitlist_full' ? 'キャンセル待ちは3件までです。' : code === 'date_not_open' ? 'その日はまだ予約を受け付けていません。' : '登録できませんでした。もう一度お試しください。')
      setState('error')
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <List>
        <Row title={'キャンセル待ち：' + view.menu.name} detail={when} />
      </List>
      {state === 'ask' || state === 'busy' ? (
        <PrimaryButton onClick={() => void join()}>{state === 'busy' ? '登録しています…' : 'キャンセル待ちに入れる'}</PrimaryButton>
      ) : state === 'joined' ? (
        <>
          <p style={{ margin: 0, fontSize: 15, color: C.text, lineHeight: 1.6 }}>
            キャンセル待ちに入れました。空きが出たら、先に入れた方から順に 10 分間お取りして、スマホにお知らせします。
          </p>
          {!hasPush && <p style={{ margin: 0, fontSize: 13, color: C.secondary }}>お知らせを受け取るには、下のボタンを押してください。</p>}
          {!hasPush && <PushToggle tone="mono" />}
        </>
      ) : (
        <p role="alert" style={{ margin: 0, fontSize: 14, color: C.danger }}>{error}</p>
      )}
    </div>
  )
}

function PrimaryButton({ onClick, children, disabled = false }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} style={{ ...buttonBase, background: C.text, color: C.bg, opacity: disabled ? 0.45 : 1 }}>{children}</button>
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} style={{ ...buttonBase, background: C.fill, color: C.text, fontWeight: 500 }}>{children}</button>
}

function List({ children }: { children: ReactNode }) {
  return (
    <div style={{ width: '100%', marginTop: 24, borderRadius: 14, overflow: 'hidden', background: C.fill }}>
      {children}
    </div>
  )
}

function Row({ title, detail, note, onClick, href, muted }: {
  title: string; detail?: string; note?: string; onClick?: () => void; href?: string; muted?: boolean
}) {
  const style: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 56, padding: '0 16px', boxSizing: 'border-box',
    background: 'transparent', border: 'none', borderTop: `0.5px solid ${C.separator}`, marginTop: -0.5,
    color: muted ? C.secondary : C.text, fontSize: 17, fontFamily: FONT, textAlign: 'left', textDecoration: 'none', cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  }
  const body = (
    <>
      <span style={{ flex: 1 }}>{title}</span>
      {note && <span style={{ fontSize: 13, color: C.secondary }}>{note}</span>}
      {detail && <span style={{ fontSize: 15, color: C.secondary }}>{detail}</span>}
    </>
  )
  return href ? <a href={href} style={style}>{body}</a> : <button type="button" onClick={onClick} style={style}>{body}</button>
}

/** 連絡先の登録（本名・電話番号）。保存はサーバー（customer_set_contact） */
function ContactForm({ onSave, onSaved }: {
  onSave: (name: string, phone: string) => Promise<void>
  onSaved: () => void
}) {
  // アプリ登録の名前（ニックネーム・下の名前だけのことがある）は最初から入れない。入れるとそのまま進んでしまう（10/28 慶一郎さん）
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim() !== '' && normalizePhone(phone) !== null

  const submit = async () => {
    if (busy) return
    if (!name.trim()) { setError('お名前を入力してください。'); return }
    if (!normalizePhone(phone)) { setError('電話番号を確認してください（例：090-1234-5678）。'); return }
    setBusy(true)
    setError(null)
    try {
      await onSave(name, phone)
      onSaved()
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      setError(code === 'invalid_phone' ? '電話番号を確認してください。'
        : code === 'invalid_name' ? 'お名前を確認してください。'
        : code === 'rate_limited' ? 'しばらくしてからもう一度お試しください。'
        : '保存できませんでした。通信環境を確認してください。')
      setBusy(false)
    }
  }

  const field: CSSProperties = {
    width: '100%', height: 52, boxSizing: 'border-box', padding: '0 16px', border: 'none', outline: 'none',
    background: 'transparent', color: C.text, fontSize: 17, fontFamily: FONT,
  }
  return (
    <form onSubmit={e => { e.preventDefault(); void submit() }} style={{ width: '100%', marginTop: 24 }}>
      <div style={{ borderRadius: 14, overflow: 'hidden', background: C.fill }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder={`お名前（フルネーム）例：銀二 太郎`} aria-label="ご予約のお名前（フルネーム）"
          autoComplete="name" maxLength={40} style={field} />
        <div style={{ height: 0.5, background: C.separator, marginLeft: 16 }} />
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="電話番号（090-1234-5678）" aria-label="電話番号"
          type="tel" inputMode="tel" autoComplete="tel" maxLength={16} enterKeyHint="done" style={field} />
      </div>
      {error && <p role="alert" style={{ margin: '10px 4px 0', fontSize: 14, color: C.danger }}>{error}</p>}
      <button type="submit" disabled={busy} style={{
        ...buttonBase, width: '100%', marginTop: 16,
        background: valid ? C.text : C.fill, color: valid ? C.bg : C.tertiary,
      }}>
        {busy ? '保存しています' : '次へ'}
      </button>
    </form>
  )
}

function AiMenuList({ view, lastMenuCode, onPick }: { view: Extract<AiView, { kind: 'menus' }>; lastMenuCode: string | null; onPick: (menu: MenuOption, date: string | null) => void }) {
  return (
    <List>
      {view.items.map(x => (
        <Row key={x.menu.code} onClick={() => onPick(x.menu, view.date)}
          title={x.menu.name}
          detail={`${x.first ? `${formatVisit(x.first).time}から・` : ''}${x.menu.duration_min}分・${yen(x.menu)}`}
          note={x.menu.code === lastMenuCode ? '前回' : undefined} />
      ))}
    </List>
  )
}

function AiSlotList({ view, onPick, onOther }: { view: Extract<AiView, { kind: 'slots' }>; onPick: (view: Extract<AiView, { kind: 'slots' }>, slot: Slot) => void; onOther: () => void }) {
  return (
    <List>
      {view.slots.map(x => (
        <Row key={x.starts_at} onClick={() => onPick(view, x)} title={formatVisit(x.starts_at).time} detail={formatVisit(x.starts_at).date} />
      ))}
      <Row onClick={onOther} title="別の日時にする" muted />
    </List>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, minHeight: 50, alignItems: 'center', padding: '0 16px',
      borderTop: `0.5px solid ${C.separator}`, marginTop: -0.5 }}>
      <span style={{ fontSize: 15, color: C.secondary }}>{label}</span>
      <span style={{ fontSize: 17, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

/** 読み上げ：プレミアムクーポンと券のひとこと */
function couponSpeech(price: PriceBreakdown | null, usableCount: number): string {
  const p = price?.premium
  const head = p ? (p.eligible ? `${p.def.title}で${p.memberPrice.toLocaleString('ja-JP')}円です。`
    : `土日祝は17時から19時のご来店なら、${p.def.title}で${p.memberPrice.toLocaleString('ja-JP')}円になります。`) : ''
  return head + (usableCount > 0 ? '割引券や漢トク券も使えますよ。' : '')
}

/** お会計（プレミアムクーポン・選んだ券）と、使える券のボタン */
function PriceBox({ menuName, price, usable, selected, onToggle, ginpay, onGinpay }: {
  menuName: string; price: PriceBreakdown; usable: TicketRow[]; selected: TicketRow[]; onToggle: (id: string) => void
  /** 銀Pay の仮支払い（口座があるときだけ）。enough：使える額がお会計以上 */
  ginpay?: { available: number; enough: boolean; on: boolean } | null; onGinpay?: () => void
}) {
  const p = price.premium
  return (
    <div style={{ width: '100%', marginTop: 12 }}>
      {/* レシートのように：料金 → クーポンの割引 → 券の割引 → お会計 */}
      <div style={{ borderRadius: 14, overflow: 'hidden', background: C.fill }}>
        <SummaryRow label={`料金（${menuName}）`} value={yenOf(price.normal ?? price.base)} />
        {price.normal != null && p && <SummaryRow label={p.def.title} value={`−${yenOf(price.normal - price.base)}`} />}
        {selected.map(t => <SummaryRow key={t.id} label={TICKET_TYPE_LABELS[t.type]} value={`−${yenOf(t.amount)}`} />)}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 54, padding: '0 16px', borderTop: `0.5px solid ${C.separator}` }}>
          <span style={{ fontSize: 15, color: C.secondary }}>{ginpay?.on ? 'お会計（銀Pay）' : 'お会計（店頭で）'}</span>
          <span style={{ fontSize: 22, fontWeight: 700 }}>{yenOf(price.total)}</span>
        </div>
      </div>
      {ginpay?.enough ? (
        <>
          <button type="button" onClick={onGinpay} aria-pressed={ginpay.on}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 56, marginTop: 10, padding: '0 16px', borderRadius: 14, cursor: 'pointer', textAlign: 'left',
              border: ginpay.on ? '1.5px solid #A8823F' : `1px solid ${C.separator}`, background: ginpay.on ? 'rgba(168,130,63,0.10)' : C.fill, color: C.text, fontFamily: 'inherit' }}>
            <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 12, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700,
              color: '#fff', background: ginpay.on ? '#A8823F' : 'transparent', border: ginpay.on ? 'none' : `1.5px solid ${C.secondary}` }}>{ginpay.on ? '✓' : ''}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>銀Payで今すぐ支払う</span>
              <span style={{ display: 'block', fontSize: 12, color: C.secondary, marginTop: 2 }}>使える額 {yenOf(ginpay.available)}</span>
            </span>
          </button>
          <p style={{ margin: '8px 4px 0', fontSize: 13, color: C.secondary, lineHeight: 1.5 }}>
            {ginpay.on
              ? 'ご予約と同時に銀Payで仮支払いします。ご来店時にレジで会員QRを読むと、お支払いが確定します。キャンセルすると全額戻ります。'
              : 'お支払いは店頭で。現金・カード・銀Payが使えます。'}
          </p>
        </>
      ) : (
        <p style={{ margin: '8px 4px 0', fontSize: 13, color: C.secondary, lineHeight: 1.5 }}>
          {ginpay ? `お支払いは店頭で。銀Payの使える額（${yenOf(ginpay.available)}）が足りないため、今すぐの支払いはできません。` : 'お支払いは店頭で。現金・カードのほか、銀Payも使えます。'}
        </p>
      )}
      {p && !p.eligible && (
        <p style={{ margin: '8px 4px 0', fontSize: 13, color: C.secondary, lineHeight: 1.5 }}>
          土日祝は 17:00〜19:00 のご来店なら {p.def.title} で {yenOf(p.memberPrice)} になります。
        </p>
      )}
      {usable.length > 0 && (
        <>
          <p style={{ margin: '14px 4px 8px', fontSize: 13, color: C.secondary }}>使える券（押すと使う・もう一度押すと外す）</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {usable.map(t => {
              const on = selected.some(s => s.id === t.id)
              return (
                <button key={t.id} type="button" aria-pressed={on} onClick={() => onToggle(t.id)} style={{
                  padding: '9px 14px', borderRadius: 20, fontSize: 15, fontFamily: FONT, cursor: 'pointer',
                  border: `1px solid ${on ? C.text : C.separator}`, background: on ? C.text : 'transparent', color: on ? C.bg : C.text,
                }}>
                  {TICKET_TYPE_LABELS[t.type]} {yenOf(t.amount)}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function Summary({ menu, slot, staffName, before, hidePrice }: { menu: MenuOption; slot: Slot; staffName?: string; before?: CustomerReservation; hidePrice?: boolean }) {
  return (
    <div style={{ width: '100%', marginTop: 24, borderRadius: 14, overflow: 'hidden', background: C.fill }}>
      {before && <SummaryRow label="変更前" value={visitLabel(before.starts_at)} />}
      <SummaryRow label={before ? '変更後' : '日時'} value={visitLabel(slot.starts_at)} />
      <SummaryRow label="メニュー" value={menu.name} />
      {staffName && <SummaryRow label="担当" value={staffName} />}
      <SummaryRow label="所要時間" value={`${menu.duration_min}分`} />
      {!hidePrice && <SummaryRow label="料金" value={yen(menu)} />}
    </div>
  )
}

function ReservationSummary({ r, companion }: { r: CustomerReservation; companion?: boolean }) {
  const names = r.items.map(i => i.name).join('・')
  return (
    <div style={{ width: '100%', marginTop: companion ? 12 : 24, borderRadius: 14, overflow: 'hidden', background: C.fill }}>
      {(companion || companionIds().includes(r.id)) && <SummaryRow label="ご来店" value="お連れ様" />}
      <SummaryRow label="日時" value={visitLabel(r.starts_at)} />
      <SummaryRow label="メニュー" value={names} />
      <SummaryRow label="担当" value={r.staff_name} />
    </div>
  )
}

