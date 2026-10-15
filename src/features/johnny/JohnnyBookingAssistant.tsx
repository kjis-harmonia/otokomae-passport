// 予約アシスタント（JOHNNY）。「いつのご来店をご希望ですか？」から、確認の「はい」まで一直線に案内する。
//   いつ → （メニュー）→ 空き枠の確認 → 提案 → この日時でお間違いないですか？ → はい → 予約完了
// 日時の読み取りは決まった規則（visitParser）、空き枠・仮押さえ・確定は DB の予約エンジン（customer_* RPC）。
// AI が空き枠や料金を作ることはない。聞き取れないときは聞き直す。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Keyboard, Mic, Volume2, VolumeX, X } from 'lucide-react'
import { RpcError } from '../../utils/staffSession'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../../data/wallet'
import { PreviousTicketsBindDialog } from '../../components/PreviousTicketsBind'
import { bookingAssistantApi, type AssistantOptions, type CustomerReservation } from './bookingAssistantApi'
import { matchMenu, type MenuOption } from './menuMatcher'
import { planOffer, type Offer, type Slot, jstMinutes } from './slotPlanner'
import { isEmptyRequest, parseVisitRequest, parseYesNo, type VisitRequest } from './visitParser'
import { formatVisit, rememberReservation } from './nextReservation'
import { useVoice } from './useVoice'
import { VoiceOrb, type OrbState } from './VoiceOrb'

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
  | { k: 'askWhen'; again?: 'unclear' | 'retry' | 'none' }
  | { k: 'askMenu'; req: VisitRequest }
  | { k: 'searching' }
  | { k: 'pick'; req: VisitRequest; menu: MenuOption; offer: Offer }
  | { k: 'confirm'; req: VisitRequest; menu: MenuOption; slot: Slot }
  | { k: 'booking'; menu: MenuOption; slot: Slot }
  | { k: 'done'; reservation: CustomerReservation }
  | { k: 'unknown'; menu: MenuOption; slot: Slot }
  | { k: 'unavailable'; reason: 'booking_disabled' | 'auth' | 'network' }

interface Props {
  onClose: () => void
  onShowQr?: () => void
}

const JST = 9 * 60 * 60 * 1000
function jstDate(offsetDays = 0): string {
  const t = new Date(Date.now() + JST + offsetDays * 86400000)
  return t.toISOString().slice(0, 10)
}

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

const BUSINESS_ERRORS = new Set(['slot_taken', 'too_late', 'date_not_open', 'invalid_starts_at', 'menu_not_available', 'hold_expired', 'hold_not_found'])

export function JohnnyBookingAssistant({ onClose, onShowQr }: Props) {
  const api = useMemo(() => bookingAssistantApi(), [])
  const [step, setStep] = useState<Step>({ k: 'loading' })
  const [options, setOptions] = useState<AssistantOptions | null>(null)
  const [lastMenuCode, setLastMenuCode] = useState<string | null>(null)
  const [heard, setHeard] = useState('')
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const stepRef = useRef(step)
  useEffect(() => { stepRef.current = step }, [step])

  // 聞き取った言葉 → 今の段階で処理（下で定義する handleText を ref 経由で呼ぶ）
  const handleTextRef = useRef<(text: string) => void>(() => {})
  const voice = useVoice(useCallback((text: string) => handleTextRef.current(text), []))
  const { speak, startListening, stopListening } = voice

  /** 質問を読み上げて、終わったら聞き取りを始める */
  const ask = useCallback((text: string, listenAfter = true) => {
    speak(text, () => { if (listenAfter && voice.listen !== 'unsupported' && voice.listen !== 'denied') startListening() })
  }, [speak, startListening, voice.listen])

  // ── 読み込み（引き継ぎのあと・再試行で読み直す） ──
  const [loadKey, setLoadKey] = useState(0)
  const [binding, setBinding] = useState(false)
  const reload = useCallback(() => { setStep({ k: 'loading' }); setLoadKey(k => k + 1) }, [])
  useEffect(() => {
    let alive = true
    Promise.all([api.options(), api.reservations().catch(() => [] as CustomerReservation[])])
      .then(([opts, list]) => {
        if (!alive) return
        setOptions(opts)
        // 前回のメニュー（キャンセル以外で一番新しい予約）を選択肢の先頭に出す
        const last = [...list].filter(r => r.status !== 'cancelled').sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0]
        setLastMenuCode(last?.items[0]?.menu_code ?? null)
        setStep({ k: 'askWhen' })
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

  // ── 空き枠を探して提案 ──
  const search = useCallback(async (reqIn: VisitRequest, menu: MenuOption) => {
    setStep({ k: 'searching' })
    stopListening()
    const windowDays = options?.settings.booking_window_days ?? 60
    const today = jstDate(0)
    const last = jstDate(windowDays)
    // 日付の指定が無ければ今日から1週間
    const dates = (reqIn.dates.length > 0 ? reqIn.dates : Array.from({ length: 7 }, (_, i) => jstDate(i)))
      .filter(d => d >= today && d <= last)
    const req = { ...reqIn, dates }
    if (dates.length === 0) { setStep({ k: 'askWhen', again: 'none' }); return }
    try {
      const results = await Promise.all(dates.map(d => api.slots(d, menu.code).then(s => [d, s] as const)))
      const offer = planOffer(req, Object.fromEntries(results))
      if (offer.kind === 'exact') setStep({ k: 'confirm', req, menu, slot: offer.slots[0] })
      else if (offer.kind === 'none') setStep({ k: 'askWhen', again: 'none' })
      else setStep({ k: 'pick', req, menu, offer })
    } catch {
      setStep({ k: 'unavailable', reason: 'network' })
    }
  }, [api, options, stopListening])

  // ── 予約の確定（仮押さえ → 確定）。通信が切れたら予約一覧で結果を確かめる ──
  const book = useCallback(async (menu: MenuOption, slot: Slot, req: VisitRequest) => {
    setStep({ k: 'booking', menu, slot })
    stopListening()
    let holdId: string | null = null
    try {
      const hold = await api.hold(slot.starts_at, menu.code)
      holdId = hold.hold_id
      const reservation = await api.confirm(hold.hold_id)
      rememberReservation(reservation)
      setStep({ k: 'done', reservation })
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ''
      if (BUSINESS_ERRORS.has(code)) {
        if (holdId) api.release(holdId).catch(() => {})
        // 直前に埋まった：同じ希望で探し直す（取れた枠は DB が決める）
        await search({ ...req, time: req.time ?? null }, menu)
        return
      }
      if (code === 'customer_auth_required') { setStep({ k: 'unavailable', reason: 'auth' }); return }
      // 確定まで届いたか分からない（通信切れなど）：「失敗」とは言わず、予約一覧で確かめる
      setStep({ k: 'unknown', menu, slot })
    }
  }, [api, search, stopListening])

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
  const handleText = useCallback((raw: string) => {
    const text = raw.trim()
    if (!text) return
    setHeard(text)
    const s = stepRef.current
    if (s.k === 'askWhen') {
      const req = parseVisitRequest(text)
      const menu = matchMenu(text, menus)
      if (isEmptyRequest(req)) {
        // 日時は無いがメニューだけ言った → メニューは覚えておかず、日時を聞き直す
        setStep({ k: 'askWhen', again: 'unclear' })
        return
      }
      if (menu) { void search(req, menu); return }
      if (menus.length === 1) { void search(req, menus[0]); return }
      setStep({ k: 'askMenu', req })
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
      if (yes === true) { void book(s.menu, s.slot, s.req); return }
      if (yes === false) { setStep({ k: 'askWhen', again: 'retry' }); return }
      setStep({ ...s })
    }
  }, [book, menus, search])
  useEffect(() => { handleTextRef.current = handleText }, [handleText])

  // ── 段階ごとの言葉（画面と読み上げ） ──
  const prompt = useMemo((): { title: string; sub?: string; speech?: string; listen?: boolean } => {
    switch (step.k) {
      case 'loading': return { title: '' }
      case 'askWhen': {
        const title = step.again === 'unclear' ? 'すみません、日時を聞き取れませんでした。'
          : step.again === 'none' ? 'その日は空きがありませんでした。'
          : step.again === 'retry' ? '別の日時をお聞かせください。'
          : 'いつのご来店をご希望ですか？'
        const follow = step.again && step.again !== 'retry' ? 'ほかのご希望の日時をお聞かせください。' : undefined
        return { title, sub: follow ?? '例：明日の15時、今日か明日の夕方', speech: follow ? `${title}${follow}` : title, listen: true }
      }
      case 'askMenu': return { title: 'メニューはどれにしますか？', speech: 'メニューはどれにしますか？', listen: true }
      case 'searching': return { title: '空き状況を確認しています' }
      case 'pick': {
        const times = step.offer.slots.map(x => spokenTime(x.starts_at)).join('、')
        const missed = step.offer.kind === 'nearby' && step.req.time
        const day = formatVisit(step.offer.slots[0].starts_at)
        const head = missed ? `${step.req.time?.replace(/^0/, '')}は埋まっています。` : ''
        return {
          title: missed ? `${step.req.time?.replace(/^0/, '')} は埋まっています` : `${day.relative ?? day.date} の空き`,
          sub: '近い時間をご案内します。どれにしますか？',
          speech: `${head}${day.relative ?? day.date}は${times}が空いています。どれにしますか？`,
          listen: true,
        }
      }
      case 'confirm': return {
        title: 'この日時でお間違いないですか？',
        speech: `${spokenVisit(step.slot.starts_at)}、${step.menu.name}でお取りできます。この日時でお間違いないですか？`,
        listen: true,
      }
      case 'booking': return { title: 'ご予約を確定しています' }
      case 'done': return { title: 'ご予約が完了しました', sub: '当日は QR をご提示ください。', speech: 'ご予約が完了しました。当日はQRをご提示ください。' }
      case 'unknown': return { title: '予約の結果を確認できませんでした', sub: '通信が切れた可能性があります。予約が入っているか確認します。' }
      case 'unavailable': return step.reason === 'booking_disabled'
        ? { title: 'アプリからのご予約は準備中です', sub: 'お電話か HOT PEPPER Beauty でご予約ください。' }
        : step.reason === 'auth'
          ? { title: 'ご予約には会員の引き継ぎが必要です', sub: '店頭で受け取った6桁の引き継ぎコードを入力してください。お電話でもご予約いただけます。' }
          : { title: '通信できませんでした', sub: '電波の良い場所で、もう一度お試しください。' }
    }
  }, [step])

  // 段階が変わったら読み上げ（同じ段階の聞き直しでも読み上げる）
  useEffect(() => {
    if (prompt.speech) ask(prompt.speech, prompt.listen ?? false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 段階の切り替わりだけで読み上げる
  }, [step])

  const submitDraft = () => { const t = draft; setDraft(''); handleText(t) }

  const orb: OrbState = voice.listen === 'listening' ? 'listening'
    : step.k === 'searching' || step.k === 'booking' || step.k === 'loading' ? 'thinking'
    : voice.speaking ? 'speaking' : 'idle'
  const canTalk = ['askWhen', 'askMenu', 'pick', 'confirm'].includes(step.k)
  // 一覧や確認を出す段階は球を小さくして、内容を1画面に収める
  const compact = ['askMenu', 'pick', 'confirm', 'booking', 'done', 'unknown'].includes(step.k)
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

      {/* 中央：球・質問・聞き取った言葉・選択肢 */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 20px 16px' }}>
        <div style={{ marginTop: 'min(4vh, 32px)' }}>
          <VoiceOrb state={orb} size={compact ? 96 : 168} />
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={`${step.k}-${'again' in step ? step.again ?? '' : ''}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            {prompt.title && (
              <h1 style={{ margin: '20px 0 0', fontSize: 26, fontWeight: 600, lineHeight: 1.3, textAlign: 'center', letterSpacing: '-0.01em' }}>
                {prompt.title}
              </h1>
            )}
            {prompt.sub && (
              <p style={{ margin: '8px 0 0', fontSize: 15, lineHeight: 1.5, color: C.secondary, textAlign: 'center' }}>{prompt.sub}</p>
            )}

            {step.k === 'askMenu' && (
              <List>
                {menus.map(m => (
                  <Row key={m.code} onClick={() => handleText(m.name)}
                    title={m.name} detail={`${m.duration_min}分・${yen(m)}`} note={m.code === lastMenuCode ? '前回' : undefined} />
                ))}
              </List>
            )}

            {step.k === 'pick' && (
              <List>
                {step.offer.slots.map(x => (
                  <Row key={x.starts_at} onClick={() => setStep({ k: 'confirm', req: step.req, menu: step.menu, slot: x })}
                    title={formatVisit(x.starts_at).time} detail={formatVisit(x.starts_at).date} />
                ))}
                <Row onClick={() => setStep({ k: 'askWhen', again: 'retry' })} title="別の日時にする" muted />
              </List>
            )}

            {(step.k === 'confirm' || step.k === 'booking') && (
              <Summary menu={step.menu} slot={step.slot} />
            )}

            {step.k === 'done' && <ReservationSummary r={step.reservation} />}

            {step.k === 'unavailable' && (
              <List>
                <Row href={SHOP_PHONE_TEL} title="電話で予約する" detail={SHOP_PHONE_DISPLAY} />
              </List>
            )}
          </motion.div>
        </AnimatePresence>

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
            <PrimaryButton onClick={() => book(step.menu, step.slot, step.req)}>はい</PrimaryButton>
            <SecondaryButton onClick={() => setStep({ k: 'askWhen', again: 'retry' })}>いいえ</SecondaryButton>
          </>
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

        {canTalk && step.k !== 'confirm' && (typing || voiceOff) && (
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

        {canTalk && step.k !== 'confirm' && !voiceOff && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28, paddingTop: 4 }}>
            <IconButton label={typing ? '音声で答える' : '文字で入力する'} onClick={() => setTyping(t => !t)}>
              <Keyboard size={22} strokeWidth={1.8} />
            </IconButton>
            <MicButton listening={voice.listen === 'listening'} onClick={() => (voice.listen === 'listening' ? stopListening() : startListening())} />
            <div style={{ width: 44 }} />
          </div>
        )}
        {canTalk && voice.listen === 'denied' && (
          <p style={{ margin: 0, fontSize: 13, color: C.secondary, textAlign: 'center' }}>マイクが使えないため、文字で入力してください。</p>
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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, minHeight: 50, alignItems: 'center', padding: '0 16px',
      borderTop: `0.5px solid ${C.separator}`, marginTop: -0.5 }}>
      <span style={{ fontSize: 15, color: C.secondary }}>{label}</span>
      <span style={{ fontSize: 17, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function Summary({ menu, slot }: { menu: MenuOption; slot: Slot }) {
  return (
    <div style={{ width: '100%', marginTop: 24, borderRadius: 14, overflow: 'hidden', background: C.fill }}>
      <SummaryRow label="日時" value={visitLabel(slot.starts_at)} />
      <SummaryRow label="メニュー" value={menu.name} />
      <SummaryRow label="所要時間" value={`${menu.duration_min}分`} />
      <SummaryRow label="料金" value={yen(menu)} />
    </div>
  )
}

function ReservationSummary({ r }: { r: CustomerReservation }) {
  const names = r.items.map(i => i.name).join('・')
  return (
    <div style={{ width: '100%', marginTop: 24, borderRadius: 14, overflow: 'hidden', background: C.fill }}>
      <SummaryRow label="日時" value={visitLabel(r.starts_at)} />
      <SummaryRow label="メニュー" value={names} />
      <SummaryRow label="担当" value={r.nominated ? r.staff_name : '指名なし'} />
    </div>
  )
}

