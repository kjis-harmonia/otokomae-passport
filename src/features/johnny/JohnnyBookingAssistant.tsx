// 予約アシスタント（JOHNNY）。「いつのご来店をご希望ですか？」から、確認の「はい」まで一直線に案内する。
//   いつ → （メニュー）→ 空き枠の確認 → 提案 → この日時でお間違いないですか？ → はい → 予約完了
// お客様の言葉は、まず予約の AI（Edge Function johnny-agent）が読む。AI は DB で確かめた空き・予約だけを提案し、
// 予約・キャンセル・変更は確認画面の「はい」でアプリが RPC で行う。AI が使えないときは、決まった規則（visitParser）の
// 案内に切り替える。空き枠・仮押さえ・確定はどちらも DB の予約エンジン（customer_* RPC）が決める。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Keyboard, Mic, Volume2, VolumeX, X } from 'lucide-react'
import { RpcError } from '../../utils/staffSession'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../../data/wallet'
import { PreviousTicketsBindDialog } from '../../components/PreviousTicketsBind'
import { normalizePhone } from '../../utils/customerContact'
import { bookingAssistantApi, type AssistantOptions, type CustomerReservation } from './bookingAssistantApi'
import { matchMenu, type MenuOption } from './menuMatcher'
import { answerMenuInfo, detectAsk } from './askIntent'
import { planOffer, type Offer, type Slot, jstMinutes } from './slotPlanner'
import { isEmptyRequest, parseVisitRequest, parseYesNo, type VisitRequest } from './visitParser'
import { forgetReservation, formatVisit, rememberReservation } from './nextReservation'
import type { AgentAnswer, AgentShown, AgentTurn } from './agentClient'
import { useVoice } from './useVoice'
import { adviseDay, adviceSpeech, spreadSlots, type DayAdvice } from './dayAdvisor'
import { JohnnyRider, type OrbState } from './JohnnyRider'
import { planCompanion } from './partyPlanner'
import { buildWelcome, welcomeText, type Welcome } from './welcome'
import { takeAiTurn } from './aiQuota'
import { PushToggle } from '../../components/PushToggle'
import { MAINTENANCE_CUT_URL } from '../../data/reserveLinks'
import type { TicketRow } from '../../data/ticket'
import { TICKET_TYPE_LABELS } from '../../data/ticket'
import { clearCouponPlan, priceFor, saveCouponPlan, usableTickets, yen as yenOf, type PriceBreakdown } from '../../utils/bookingCoupons'
import { suspendBgm } from '../../audio/bgm'

// ── 見た目（黒・白・グレーだけ） ─────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Hiragino Sans", "Noto Sans JP", sans-serif'
const C = {
  bg: '#000000',
  text: '#FFFFFF',
  secondary: 'rgba(235,235,245,0.6)',
  tertiary: 'rgba(235,235,245,0.3)',
  fill: '#1C1C1E',
  fillPressed: '#2C2C2E',
  separator: 'rgba(84,84,88,0.6)',
  danger: '#FF453A',
}

// ── 会話の段階 ─────────────────────────────────────────────────

type Step =
  | { k: 'loading' }
  | { k: 'contact'; name: string }
  /** 2回目以降：おかえりなさい（前回からの日数・メンテナンスカットの期限・いつものメニュー） */
  | { k: 'welcome'; w: Welcome }
  | { k: 'askWhen'; again?: 'unclear' | 'retry' | 'none' | 'menu'; menu?: MenuOption }
  | { k: 'askMenu'; req: VisitRequest }
  /** その日の空き状況を先に見て、入れられるメニューと時刻を案内（note：希望の日が埋まっていて別の日にしたときの一言） */
  | { k: 'overview'; req: VisitRequest; advice: DayAdvice; note?: string }
  | { k: 'searching'; label?: string }
  | { k: 'pick'; req: VisitRequest; menu: MenuOption; offer: Offer; note?: string }
  /** 予約の確認。staffId：指名、change：この予約を新しい日時に変える、say：AI の言葉 */
  | { k: 'confirm'; req: VisitRequest; menu: MenuOption; slot: Slot; staffId?: string | null; change?: CustomerReservation; say?: string }
  | { k: 'booking'; menu: MenuOption; slot: Slot }
  | { k: 'done'; reservation: CustomerReservation; changedFrom?: CustomerReservation; oldKept?: boolean; companion?: CustomerReservation; companionFailed?: boolean }
  /** お連れ様：メニューを聞く → 2人分の確認（お連れ様は予約者の時間から一番早く。togetherAt：お二人同時に入れる時刻） */
  | { k: 'companionMenu'; primary: PartyPrimary }
  | { k: 'confirmParty'; primary: PartyPrimary; companion: { menu: MenuOption; slot: Slot }; togetherAt: string | null }
  /** AI の返事（話す言葉と、出す一覧） */
  | { k: 'ai'; say: string; view: AiView }
  | { k: 'confirmCancel'; reservation: CustomerReservation; say: string }
  | { k: 'cancelling'; reservation: CustomerReservation }
  | { k: 'cancelled'; reservation: CustomerReservation }
  | { k: 'unknown'; menu: MenuOption; slot: Slot }
  | { k: 'unavailable'; reason: 'booking_disabled' | 'auth' | 'network' }

interface PartyPrimary { menu: MenuOption; slot: Slot; staffId: string | null; req: VisitRequest }

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

interface Props {
  onClose: () => void
  onShowQr?: () => void
}

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

const AI_STEPS = new Set<Step['k']>(['welcome', 'askWhen', 'askMenu', 'overview', 'pick', 'confirm', 'ai', 'confirmCancel'])

const BUSINESS_ERRORS = new Set(['slot_taken', 'too_late', 'date_not_open', 'invalid_starts_at', 'menu_not_available', 'hold_expired', 'hold_not_found'])

export function JohnnyBookingAssistant({ onClose, onShowQr }: Props) {
  const api = useMemo(() => bookingAssistantApi(), [])
  const [step, setStep] = useState<Step>({ k: 'loading' })
  const [options, setOptions] = useState<AssistantOptions | null>(null)
  const [lastMenuCode, setLastMenuCode] = useState<string | null>(null)
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
  // 手持ちの券と、確認画面で選んだ券（key：その確認画面のメニューと時刻）
  const [myTickets, setMyTickets] = useState<TicketRow[]>([])
  const [couponPick, setCouponPick] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] })
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
    ])
      .then(([opts, list, contact, lastVisit, visits]) => {
        if (!alive) return
        setOptions(opts)
        setMyReservations(list)
        api.tickets().then(setMyTickets).catch(() => {})
        // 前回のメニュー（キャンセル以外で一番新しい予約）を選択肢の先頭に出す
        const last = [...list].filter(r => r.status !== 'cancelled').sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0]
        setLastMenuCode(last?.items[0]?.menu_code ?? null)
        // 連絡先（本名・電話番号）が未登録なら、日時の前に1回だけ聞く。仕組みが無い環境（null）では聞かない
        if (contact && !contact.registered) { setStep({ k: 'contact', name: contact.name }); return }
        // 2回目以降のお客様は「おかえりなさい」から
        const w = buildWelcome(lastVisit, list, opts.menus, Date.now(), visits)
        if (w) {
          turnsRef.current = [{ role: 'assistant', text: `おかえりなさい！${welcomeText(w).lines.join('')}ご予約はどうしますか？` }]
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

  const menus = useMemo(() => {
    const list = options?.menus ?? []
    return lastMenuCode ? [...list].sort((a, b) => (a.code === lastMenuCode ? -1 : b.code === lastMenuCode ? 1 : 0)) : list
  }, [options, lastMenuCode])

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
  const book = useCallback(async (menu: MenuOption, slot: Slot, req: VisitRequest, staffId: string | null = null, change?: CustomerReservation) => {
    setStep({ k: 'booking', menu, slot })
    stopListening()
    let holdId: string | null = null
    try {
      const hold = await api.hold(slot.starts_at, menu.code, staffId)
      holdId = hold.hold_id
      const reservation = await api.confirm(hold.hold_id)
      // 変更：新しい予約が取れてから、元の予約をキャンセルする（取り消せなければ両方残っていることを伝える）
      let oldKept = false
      if (change) {
        try { await api.cancel(change.id); forgetReservation(change.id) } catch { oldKept = true }
      }
      rememberReservation(reservation)
      // 一緒に使う券（予約の日の会員 QR に入る）。変更なら元の予約の券は外す
      if (change) clearCouponPlan(change.id)
      const pickKey = `${menu.code}|${slot.starts_at}`
      const pickedIds = couponPickRef.current.key === pickKey ? couponPickRef.current.ids : []
      if (pickedIds.length) saveCouponPlan({ date: slotDate(reservation.starts_at), reservationId: reservation.id, ticketIds: pickedIds })
      api.reservations().then(setMyReservations).catch(() => {})
      setStep({ k: 'done', reservation, changedFrom: change, oldKept })
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
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
    rememberReservation(reservation)
    let companion: CustomerReservation | undefined
    try {
      const hold = await api.hold(s.companion.slot.starts_at, s.companion.menu.code, null)
      companion = await api.confirm(hold.hold_id, 'お連れ様')
      rememberCompanion(companion.id)
    } catch { /* 下で伝える */ }
    api.reservations().then(setMyReservations).catch(() => {})
    setStep({ k: 'done', reservation, companion, companionFailed: !companion })
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
        return menu && change ? { k: 'confirm', req: reqFromSlot(ui.starts_at), menu, slot: { starts_at: ui.starts_at }, staffId: ui.staff_id, change, say: a.say } : null
      }
      case 'confirm_cancel': {
        const reservation = await findReservation(ui.reservation_id)
        return reservation ? { k: 'confirmCancel', reservation, say: a.say } : null
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

  const handleText = useCallback((raw: string) => {
    const text = raw.trim()
    if (!text) return
    setHeard(text)
    setVoiceNote(null)
    const s = stepRef.current
    // メンテナンスカットはアプリのメニューではなくホットペッパーのクーポン：予約のボタンを出す
    if (AI_STEPS.has(s.k) && s.k !== 'confirm' && s.k !== 'confirmCancel' && /メンテ|めんて/.test(text)) {
      setStep({ k: 'ai', say: 'メンテナンスカットは、ホットペッパーのクーポンでご予約いただけます。下のボタンからどうぞ。', view: { kind: 'maintenance' } })
      return
    }
    // お連れ様の段階（AI に聞かない）
    if (s.k === 'confirm' && !s.change && parseYesNo(text) === null && COMPANION_WORDS.test(text)) {
      setStep({ k: 'companionMenu', primary: { menu: s.menu, slot: s.slot, staffId: s.staffId ?? null, req: s.req } })
      return
    }
    if (s.k === 'companionMenu') {
      const menu = matchMenu(text, menus)
      if (menu) { void planParty(s.primary, menu); return }
      if (parseYesNo(text) === false) { setStep({ k: 'confirm', req: s.primary.req, menu: s.primary.menu, slot: s.primary.slot, staffId: s.primary.staffId }); return }
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
      if (yes === true) { if (s.k === 'confirm') void book(s.menu, s.slot, s.req, s.staffId ?? null, s.change); else void cancelReservation(s.reservation); return }
      if (yes === false) { declineConfirm(s.k === 'confirm' ? s.menu : undefined); return }
    }
    // 髪型の相談（日時・メニューの話が無いもの）だけは、相談用の AI に聞く
    const consultOnly = detectAsk(text, menus)?.kind === 'consult' && isEmptyRequest(parseVisitRequest(text)) && !matchMenu(text, menus)
    if (aiOnRef.current && AI_STEPS.has(s.k) && !consultOnly) { void viaAgent(text, s); return }
    legacyRef.current(text, s.k === 'ai' || s.k === 'confirmCancel' || s.k === 'welcome' ? { k: 'askWhen' } : s)
  }, [book, bookParty, cancelReservation, declineConfirm, menus, planParty, viaAgent])

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
      if (yes === true) { void book(s.menu, s.slot, s.req, s.staffId ?? null, s.change); return }
      if (yes === false) { setStep({ k: 'askWhen', again: 'retry', menu: s.menu }); return }
      setStep({ ...s })
    }
  }, [advise, api, ask, book, menus, pickFromOverview, search])
  useEffect(() => { handleTextRef.current = handleText }, [handleText])
  useEffect(() => { legacyRef.current = handleLegacy }, [handleLegacy])

  /** 録音した声：サーバーで文字にして、そのまま AI の答えまで受け取る（確認画面・AI が使えないときは文字にするだけ） */
  const handleAudio = useCallback(async (audio: Blob) => {
    const s = stepRef.current
    const partyStep = s.k === 'companionMenu' || s.k === 'confirmParty'
    if (!AI_STEPS.has(s.k) && !partyStep) return
    let transcribeOnly = !aiOnRef.current || partyStep || s.k === 'confirm' || s.k === 'confirmCancel'
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
  }, [api, handleText, stepFromAgent])
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
    const usable = usableTickets(myTickets, step.slot.starts_at)
    const ids = couponPick.key === key ? couponPick.ids : []
    const selected = usable.filter(t => ids.includes(t.id))
    const price = priceFor(step.menu.code, step.menu.price, step.slot.starts_at, selected)
    return price ? { key, usable, selected, price } : null
  }, [step, myTickets, couponPick])
  const toggleCoupon = (key: string, id: string) => setCouponPick(p => {
    const ids = p.key === key ? p.ids : []
    return { key, ids: ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id] }
  })

  // ── 段階ごとの言葉（画面と読み上げ） ──
  const prompt = useMemo((): { title: string; sub?: string; speech?: string; listen?: boolean } => {
    switch (step.k) {
      case 'loading': return { title: '' }
      case 'contact': return {
        title: 'お名前とお電話番号を教えてください',
        sub: 'ご予約の確認でお店からご連絡することがあります。',
        speech: 'ご予約のために、お名前とお電話番号を教えてください。',
      }
      case 'welcome': {
        const t = welcomeText(step.w)
        return { title: 'おかえりなさい！', sub: t.lines.join(''), speech: t.speech, listen: true }
      }
      case 'askWhen': {
        const title = step.again === 'unclear' ? 'すみません、日時を聞き取れませんでした。'
          : step.again === 'none' ? 'その日は空きがありませんでした。'
          : step.again === 'retry' ? '別の日時をお聞かせください。'
          : step.again === 'menu' && step.menu ? `${step.menu.name}ですね。`
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
      case 'confirmCancel': return { title: 'この予約をキャンセルしますか？', speech: step.say, listen: true }
      case 'cancelling': return { title: 'キャンセルしています' }
      case 'companionMenu': return { title: 'お連れ様のメニューは何にしますか？', speech: 'お連れ様のメニューは何にしますか？', listen: true }
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
      case 'cancelled': return { title: 'ご予約をキャンセルしました', sub: 'またのご来店をお待ちしています。', speech: 'ご予約をキャンセルしました。またのご来店をお待ちしています。' }
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
          sub: step.note ? `${step.menu.name}のいちばん早い空きです。どれにしますか？` : '近い時間をご案内します。どれにしますか？',
          speech: step.note ? `${head}いちばん早いのは、${spoken}です。どれにしますか？` : `${head}${spoken}が空いています。どれにしますか？`,
          listen: true,
        }
      }
      case 'confirm': return {
        title: step.change ? 'この日時に変更しますか？' : 'この日時でお間違いないですか？',
        speech: `${step.say ?? `${spokenVisit(step.slot.starts_at)}、${step.menu.name}でお取りできます。この日時でお間違いないですか？`}${couponSpeech(step.change ? null : priceFor(step.menu.code, step.menu.price, step.slot.starts_at, []), step.change ? 0 : usableTickets(myTickets, step.slot.starts_at).length)}`,
        listen: true,
      }
      case 'booking': return { title: 'ご予約を確定しています' }
      case 'done': return step.companion || step.companionFailed
        ? step.companionFailed
          ? { title: 'ご本人のご予約をお取りしました', sub: 'お連れ様の時間はちょうど埋まってしまいました。お連れ様の分は、もう一度お伝えください。', speech: 'ご本人のご予約をお取りしました。お連れ様の時間はちょうど埋まってしまいました。' }
          : { title: 'お二人のご予約が完了しました', sub: '当日は QR をご提示ください。', speech: 'お二人のご予約が完了しました。当日はQRをご提示ください。' }
        : step.oldKept
        ? { title: '新しいご予約をお取りしました', sub: '元のご予約を取り消せませんでした。お手数ですが、お電話でご連絡ください。', speech: '新しいご予約をお取りしました。元のご予約は取り消せなかったので、お電話でご連絡ください。' }
        : step.changedFrom
          ? { title: 'ご予約を変更しました', sub: '当日は QR をご提示ください。', speech: 'ご予約を変更しました。当日はQRをご提示ください。' }
          : { title: 'ご予約が完了しました', sub: '当日は QR をご提示ください。', speech: 'ご予約が完了しました。当日はQRをご提示ください。' }
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
  const canTalk = ['welcome', 'askWhen', 'askMenu', 'overview', 'pick', 'confirm', 'ai', 'confirmCancel', 'companionMenu', 'confirmParty'].includes(step.k)
  // 一覧や確認を出す段階は球を小さくして、内容を1画面に収める
  const compact = ['welcome', 'askMenu', 'overview', 'pick', 'confirm', 'booking', 'done', 'unknown', 'confirmCancel', 'cancelling', 'cancelled', 'companionMenu', 'confirmParty'].includes(step.k)
    || (step.k === 'ai' && step.view.kind !== 'talk')
  const voiceOff = voice.listen === 'unsupported' || voice.listen === 'denied'

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="予約アシスタント"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10030, background: C.bg, color: C.text, fontFamily: FONT,
        display: 'flex', flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {/* 上：閉じる・読み上げ */}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 8px 0' }}>
        <IconButton label="閉じる" onClick={onClose}><X size={22} strokeWidth={2} /></IconButton>
        <IconButton label={voice.muted ? '読み上げをオンにする' : '読み上げをオフにする'} onClick={() => voice.setMuted(!voice.muted)}>
          {voice.muted ? <VolumeX size={20} strokeWidth={1.8} /> : <Volume2 size={20} strokeWidth={1.8} />}
        </IconButton>
      </div>

      {/* 中央：JOHNNY・質問・聞き取った言葉・選択肢 */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 20px 16px' }}>
        <div style={{ marginTop: 'min(4vh, 32px)', width: '100%', display: 'flex', justifyContent: 'center' }}>
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
              <h1 style={{ margin: '20px 0 0', fontSize: step.k === 'ai' && prompt.title.length > 24 ? 20 : 26, fontWeight: 600, lineHeight: 1.3, textAlign: 'center', letterSpacing: '-0.01em' }}>
                {prompt.title}
              </h1>
            )}
            {prompt.sub && (
              <p style={{ margin: '8px 0 0', fontSize: 15, lineHeight: 1.5, color: C.secondary, textAlign: 'center' }}>{prompt.sub}</p>
            )}

            {step.k === 'welcome' && (
              <List>
                {step.w.maintenanceLeft != null && (
                  <Row href={MAINTENANCE_CUT_URL} title="メンテナンスカットで予約" detail={step.w.maintenanceLeft === 0 ? '今日まで' : `あと${step.w.maintenanceLeft}日`} />
                )}
                {step.w.usual.map(m => m.code === 'maintenance' ? (
                  <Row key={m.code} href={MAINTENANCE_CUT_URL} title="メンテナンスカットで予約" detail="ホットペッパー" note="いつもの" />
                ) : (
                  <Row key={m.code} onClick={() => handleText(m.name)} title={`${m.name}で予約`} detail={`${m.duration_min}分・${yen(m)}`} note="いつもの" />
                ))}
                <Row onClick={() => setStep({ k: 'askWhen' })} title="日時を伝えて予約する" muted />
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

            {step.k === 'ai' && step.view.kind === 'maintenance' && (
              <List>
                <Row href={MAINTENANCE_CUT_URL} title="メンテナンスカットで予約" detail="ホットペッパー" />
              </List>
            )}

            {step.k === 'ai' && step.view.kind === 'talk' && step.view.handoff && (
              <List>
                <Row href={SHOP_PHONE_TEL} title="電話で問い合わせる" detail={SHOP_PHONE_DISPLAY} />
              </List>
            )}

            {(step.k === 'confirm' || step.k === 'booking') && (
              <Summary menu={step.menu} slot={step.slot} hidePrice={step.k === 'confirm' && !!confirmPrice}
                staffName={step.k === 'confirm' && step.staffId ? options?.staff?.find(x => x.id === step.staffId)?.name ?? '指名あり' : undefined}
                before={step.k === 'confirm' ? step.change : undefined} />
            )}

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
                onToggle={id => toggleCoupon(confirmPrice.key, id)} />
            )}

            {step.k === 'done' && <ReservationSummary r={step.reservation} />}
            {step.k === 'done' && <PushToggle tone="mono" />}
            {step.k === 'done' && step.companion && <ReservationSummary r={step.companion} companion />}

            {(step.k === 'confirmCancel' || step.k === 'cancelling' || step.k === 'cancelled') && <ReservationSummary r={step.reservation} />}

            {step.k === 'contact' && (
              <ContactForm
                initialName={step.name}
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
      <div style={{ padding: '12px 20px 20px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'stretch', maxWidth: 460, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        {step.k === 'confirm' && (
          <>
            {voice.listen === 'listening' && (
              <p style={{ margin: '0 0 2px', fontSize: 13, color: C.secondary, textAlign: 'center' }}>「はい」「いいえ」と話しても進めます</p>
            )}
            <PrimaryButton onClick={() => book(step.menu, step.slot, step.req, step.staffId ?? null, step.change)}>はい</PrimaryButton>
            {!step.change && (
              <SecondaryButton onClick={() => setStep({ k: 'companionMenu', primary: { menu: step.menu, slot: step.slot, staffId: step.staffId ?? null, req: step.req } })}>お連れ様を追加</SecondaryButton>
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
          <form onSubmit={e => { e.preventDefault(); submitDraft() }} style={{ display: 'flex', gap: 8 }}>
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              autoFocus={typing}
              enterKeyHint="send"
              placeholder={step.k === 'askMenu' ? 'メニュー名' : '明日の15時'}
              aria-label="ご希望を入力"
              style={{
                flex: 1, height: 48, borderRadius: 24, border: 'none', outline: 'none', padding: '0 18px',
                background: C.fill, color: C.text, fontSize: 17, fontFamily: FONT,
              }}
            />
            <button type="submit" aria-label="送信" disabled={!draft.trim()} style={{
              width: 48, height: 48, borderRadius: 24, border: 'none', background: draft.trim() ? C.text : C.fill,
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

function PrimaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} style={{ ...buttonBase, background: C.text, color: C.bg }}>{children}</button>
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
function ContactForm({ initialName, onSave, onSaved }: {
  initialName: string
  onSave: (name: string, phone: string) => Promise<void>
  onSaved: () => void
}) {
  const [name, setName] = useState(initialName)
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
        <input value={name} onChange={e => setName(e.target.value)} placeholder="お名前（本名）" aria-label="お名前（本名）"
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
function PriceBox({ menuName, price, usable, selected, onToggle }: { menuName: string; price: PriceBreakdown; usable: TicketRow[]; selected: TicketRow[]; onToggle: (id: string) => void }) {
  const p = price.premium
  return (
    <div style={{ width: '100%', marginTop: 12 }}>
      {/* レシートのように：料金 → クーポンの割引 → 券の割引 → お会計 */}
      <div style={{ borderRadius: 14, overflow: 'hidden', background: C.fill }}>
        <SummaryRow label={`料金（${menuName}）`} value={yenOf(price.normal ?? price.base)} />
        {price.normal != null && p && <SummaryRow label={p.def.title} value={`−${yenOf(price.normal - price.base)}`} />}
        {selected.map(t => <SummaryRow key={t.id} label={TICKET_TYPE_LABELS[t.type]} value={`−${yenOf(t.amount)}`} />)}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 54, padding: '0 16px', borderTop: `0.5px solid ${C.separator}` }}>
          <span style={{ fontSize: 15, color: C.secondary }}>お会計（店頭で）</span>
          <span style={{ fontSize: 22, fontWeight: 700 }}>{yenOf(price.total)}</span>
        </div>
      </div>
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
      <SummaryRow label="担当" value={r.nominated ? r.staff_name : '指名なし'} />
    </div>
  )
}

