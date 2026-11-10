// 銀ちゃんの接客（11/8 慶一郎さん「LINE をする感覚で、話すかボタンを押すだけで全部済む」）
//   左に銀ちゃん（丸い顔のアイコン・白い吹き出し）、右にお客様（黒い吹き出し）。下に銀ちゃんが先回りして出すボタンと、入力欄（マイク・文字）
//   ボタン・声・文字は、ぜんぶ同じ会話につながる（「はい/いいえ」は「うん」「ちがう」でも進む）
//   welcome：店頭で QR を読んだあと。「〇月〇日は〇〇でしたね！いつものに登録してもよろしいですか？」→ メンテナンス → お連れ様 → お得な案内
//   book：「いつものでAI予約する」。どなたの予約か → メニュー → 「ご来店は、いつ頃がええですか？」【最短で】【土日希望】【日付を選ぶ】→ 時間 → 確認 → 予約
//   話し方：丁寧で親しみやすい広島弁（です・ます＋〜けぇ・〜とります。タメ口・命令口調は使わない・11/8 慶一郎さん）
//   メニュー・料金・空きは、店の一覧と今の予約エンジンだけ。登録・予約は、お客様が確かめてから
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUp, ChevronLeft, ChevronRight, Mic, X } from 'lucide-react'
import { bookingAssistantApi, hasPendingBookingConfirmation, isBookingRejection, linkCompanion, recoverBookingConfirmation, type CustomerReservation } from '../features/johnny/bookingAssistantApi'
import { matchMenu } from '../features/johnny/menuMatcher'
import { ReservationMutationClient, reservationMenuCodes, type Confirmation, type MutationReply } from '../features/johnny/reservationMutation'
import { getStoredValue, setStoredValue } from '../utils/storage'
import { USER_ID_KEY } from '../utils/userId'
import { canBeUsual, getUsualStaff, setUsualMenu, setUsualStaff, usualMenuOrder } from '../features/johnny/usualMenu'
import { fetchPeople, MAX_COMPANIONS, saveCompanion, setOwnerMaintenance, type People, type Person } from '../features/johnny/usualMembers'
import { askUsualAi } from '../features/johnny/usualAi'
import { askAgentVoice, type AgentTurn } from '../features/johnny/agentClient'
import { useVoice } from '../features/johnny/useVoice'
import { spreadSlots } from '../features/johnny/dayAdvisor'
import { forgetReservation, isUpcoming, rememberReservation } from '../features/johnny/nextReservation'
import { callCustomerRpc, getCustomerSession } from '../utils/customerSession'
import { SHOP_PHONE_TEL } from '../data/wallet'
import { RpcBusinessError, RpcError } from '../utils/staffSession'
import { longestIn, namesIn } from './ginWords'
import { gachaNote, gachaOff, saveCouponPlan, usableTickets } from '../utils/bookingCoupons'
import { attachGacha, loadGacha, type GachaHeld } from '../features/gacha/gachaApi'
import type { TicketRow } from '../data/ticket'
import type { PendingVisits as Pending, PendingVisit as Visit } from './visitConfirm'

type Menu = { code: string; name: string; duration_min: number; price: number | null; maintenance?: boolean }
type Who = { kind: 'me' } | { kind: 'mate'; id: string | null; name: string }
type Chip = { label: string; sub?: string; strong?: boolean }
type Msg = { id: number; from: 'gin' | 'you'; text: string } | { id: number; from: 'cal'; open: string[]; first: string; last: string }
/** book.menuCode：ホームの髪型の写真から来たときのメニュー（label は髪型の名前） */
export type GinMode = { kind: 'welcome'; pending: Pending } | { kind: 'book'; menuCode?: string | null; label?: string } | { kind: 'change'; reservationId?: string } | { kind: 'offer'; holdId: string }

const HOTPEPPER_MENU_URL = 'https://beauty.hotpepper.jp/slnH000583749/coupon/'
// お客様向けの言葉（システムの言葉を出さない・11/9 点検）
const CHECK_DONE = '済んだか確かめる'
const SEND_AGAIN = 'もう一度送る'
const CHECK_BOOKED = '取れたか確かめる'
const CHANGED_AFTER_REVIEW = 'ご案内したあとに、空きや料金が変わってしまいました。お手続きは済んでいません。お手数ですが、もう一度「変更・キャンセル」から選び直してくださいね。'
const CHANGED_RETRY = 'ご案内したあとに、空きや料金が変わってしまいました。新しい内容で、もう一度ご案内しますね。'
const WEEK = '日月火水木金土'
const yen = (n: number | null) => (n == null ? '' : `¥${n.toLocaleString('ja-JP')}`)
const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`
/** 'YYYY-MM-DD' の曜日（暦どおりに計算） */
const dow = (d: string) => WEEK[new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay()]
const mdw = (d: string) => `${md(d)}（${dow(d)}）`
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600000).toISOString()
const dayOf = (iso: string) => jst(iso).slice(0, 10)
const hm = (iso: string) => jst(iso).slice(11, 16)
const slotLabel = (iso: string) => `${mdw(dayOf(iso))} ${hm(iso)}`
const todayJst = () => jst(new Date().toISOString()).slice(0, 10)
const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10)
const honor = (name: string) => (/(さん|様|ちゃん|くん|君)$/.test(name) ? name : `${name}さん`)
/** はい／いいえ の読み取り（11/8 慶一郎さん「『ええわ』＝はい と決めるのは危ない」）
 *   yes：はっきりした賛成（はい・うん・お願いします・それでええわ）
 *   no：はっきりした断り（もうええわ・いや、ええわ・やっぱりええわ・やめとく・いらん）
 *   ambiguous：「ええわ」「いいわ」だけ。賛成にも断りにも取れるので、銀ちゃんが聞き直す
 *   null：それ以外（「土曜日がええわ」のような希望・質問。呼んだ側が変更として読む） */
const intent = (t: string): 'yes' | 'no' | 'ambiguous' | null => {
  const s = t.normalize('NFKC').replace(/\s/g, '').replace(/[。、,!！~〜]+$/g, '').replace(/ー+$/g, '').toLowerCase()
  if (t === 'はい') return 'yes'
  if (/^((いや|いいや|やっぱ(り)?|もう|ほんなら|そんなら)[、,]?)+(ええ|えー|えぇ|いい)(わ|よ|です|や)?$/.test(s) || /やめ(とく|とこ|る|ます|て)|いらん|いらない|結構|けっこう|キャンセル|せん(わ|よ)?$|しない$|^いいえ|^いえ$|^ううん/.test(s)) return 'no'
  if (/^(はい|うん|ほうよ|ほうじゃ|せや|そう(です)?|了解|りょうかい|ok|okです|オッケー|おけ|お願い(します)?|おねがい(します)?|それで(ええ|えー|いい)?(わ|よ|で|です)?|それでお願い(します)?|それにする|そのまま(で)?(ええ|いい|お願い(します)?)?(です|よ|わ)?|予約(して|する|します|お願い(します)?))$/.test(s)) return 'yes'
  if (/^(ええ|えー|えぇ|いい)(わ|よ|で|ね|じゃ)?$/.test(s)) return 'ambiguous'
  return null
}

/** 予約する人（ご本人は id が null） */
type BookPerson = { key: string; id: string | null; name: string; label: string; person: Person | null }
/** 予約メモ：決まったところは残して、変わったところだけ直す。when.kind = pick はカレンダーで選ぶ */
type Draft = {
  who: BookPerson[] | null
  menus: Record<string, Menu>
  /** weekend.dow：土曜だけ（6）・日曜だけ（0）。無ければ土日どちらも */
  when: { kind: 'soonest' } | { kind: 'weekend'; dow?: 0 | 6 } | { kind: 'pick' } | { kind: 'day'; day: string } | null
  at: string | null
  /** 2人以上：それぞれの担当（同じ時間に別々の担当） */
  plan: Record<string, string | null> | null
  /** 人・メニューを変えたとき：前に選んだ時間。空きを確かめ直して、空いとれば「このままでよろしいですか？」だけ聞く（11/8 慶一郎さん） */
  recheck: { at: string; note: string; why: string } | null
  /** 1人の予約：担当のご希望（id）。null＝どちらでも、undefined＝まだ聞いていない（11/10 慶一郎さん「ご来店を聞く前に、テイテイ・銀二郎・どちらでも」） */
  staff?: string | null
}
const sameWho = (a: BookPerson[], b: BookPerson[]) => a.length === b.length && a.every(x => b.some(y => y.key === x.key))
/** n 人に、別々の担当（m 人の中から）を割り当てる。できなければ null（人数は3人までなので総当たりで足りる） */
function assign(n: number, m: number, ok: (person: number, staff: number) => boolean): number[] | null {
  const used = new Set<number>(), pick: number[] = []
  const go = (i: number): boolean => {
    if (i === n) return true
    for (let s = 0; s < m; s++) {
      if (used.has(s) || !ok(i, s)) continue
      used.add(s); pick.push(s)
      if (go(i + 1)) return true
      used.delete(s); pick.pop()
    }
    return false
  }
  return go(0) ? pick : null
}

/** いつもの担当（この端末に覚える）。ご本人は前の AI予約と同じ場所、お連れ様は人ごと */
const MATE_STAFF_KEY = 'ginjiro_usual_staff_mates'
function usualStaffOf(personKey: string): string | null {
  if (personKey === 'me') return getUsualStaff()
  const map = getStoredValue<Record<string, string> | null>(MATE_STAFF_KEY, null)
  return map && typeof map[personKey] === 'string' ? map[personKey] : null
}
function setUsualStaffOf(personKey: string, staffId: string): void {
  if (personKey === 'me') { setUsualStaff(staffId); return }
  const map = getStoredValue<Record<string, string> | null>(MATE_STAFF_KEY, null) ?? {}
  setStoredValue(MATE_STAFF_KEY, { ...map, [personKey]: staffId })
}

/** 文の中の日付（「11月20日」「20日」）。過ぎた日なら：月まで言われたら来年、日だけなら来月。暦に無い日（11月31日など）は null */
function dateIn(t: string): string | null {
  const s = t.normalize('NFKC')
  const md2 = s.match(/(\d{1,2})月(\d{1,2})日/), dOnly = s.match(/(?:^|[^\d月])(\d{1,2})日/)
  if (!md2 && !dOnly) return null
  const today = todayJst()
  let y = +today.slice(0, 4), mo = md2 ? +md2[1] : +today.slice(5, 7)
  const da = md2 ? +md2[2] : +dOnly![1]
  const ymd = () => `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`
  if (ymd() < today) { if (md2) y++; else { mo++; if (mo > 12) { mo = 1; y++ } } }
  const day = ymd()
  const real = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).toISOString().slice(0, 10) === day
  return real && day >= today ? day : null
}

/** 空きのある日（今の予約エンジンで判定）。1週間ずつ並べて調べる（1回で長く調べると時間切れになる） */
async function openDays(menuCode: string, from: string, days: number, weekend: boolean, staffId: string | null = null): Promise<string[]> {
  const chunks = Array.from({ length: Math.ceil(days / 7) }, (_, i) => addDays(from, i * 7))
  // 通信が切れた週は1回だけ聞き直す。それでも読めず、空きが1日も見つからなければ「空きが無い」ではなく通信の不具合として返す
  //   （11/10 慶一郎さんの iPhone：DB には土日の空きがあるのに「空きが無い」と言っていた）
  const ask = (d: string) => callCustomerRpc<string[]>('customer_open_days',
    { p_menu_codes: [menuCode], p_from: d, p_to: addDays(d, 6), p_staff_id: staffId, p_weekend: weekend })
  let failed = false
  const parts = await Promise.all(chunks.map(d => ask(d).catch(() => ask(d)).then(v => (Array.isArray(v) ? v : []), () => { failed = true; return [] as string[] })))
  const out = [...new Set(parts.flat())].sort()
  if (failed && !out.length) throw new Error('open_days_unreachable')
  return out
}

export function GinChat({ mode, onClose }: { mode: GinMode; onClose: () => void }) {
  const reduce = useReducedMotion()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [chips, setChips] = useState<Chip[]>([])
  const [typing, setTyping] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [text, setText] = useState('')
  const [sheet, setSheet] = useState<Menu[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [finished, setFinished] = useState(false)
  const [bookingComplete, setBookingComplete] = useState(false)
  const nextId = useRef(1)
  const chatRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const turns = useRef<AgentTurn[]>([])
  const waitRef = useRef<((t: string) => void) | null>(null)
  const sheetRef = useRef<((m: Menu | null) => void) | null>(null)
  const calRef = useRef<((d: string | null) => void) | null>(null)
  const menusRef = useRef<Menu[]>([])
  const started = useRef(false)
  // いまの答えがボタンを押したものか（予約の確定はボタンだけ・11/8 慶一郎さん）
  const fromChip = useRef(false)
  const api = bookingAssistantApi()

  useLayoutEffect(() => { const el = logRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }) }, [msgs, chips, typing, reduce])
  useEffect(() => {
    const chat = chatRef.current
    const viewport = window.visualViewport
    if (!chat || !viewport) return
    const fit = () => {
      const keyboardInset = viewport.scale === 1 && viewport.height < window.innerHeight - 100
      if (keyboardInset) {
        chat.style.setProperty('--lc-visible-height', `${viewport.height}px`)
        chat.style.setProperty('--lc-visible-top', `${viewport.offsetTop}px`)
      } else {
        chat.style.removeProperty('--lc-visible-height')
        chat.style.removeProperty('--lc-visible-top')
      }
    }
    fit()
    viewport.addEventListener('resize', fit)
    viewport.addEventListener('scroll', fit)
    return () => {
      viewport.removeEventListener('resize', fit)
      viewport.removeEventListener('scroll', fit)
    }
  }, [])

  const push = (from: 'gin' | 'you', t: string) => {
    setMsgs(m => [...m, { id: nextId.current++, from, text: t }])
    turns.current.push({ role: from === 'gin' ? 'assistant' : 'user', text: t })
  }
  const pause = (ms: number) => new Promise(r => setTimeout(r, reduce ? 0 : ms))
  const say = async (t: string) => { setTyping(true); await pause(460); setTyping(false); push('gin', t) }
  const ask = async (t: string, options: Chip[]): Promise<string> => {
    await say(t)
    setChips(options); setWaiting(true)
    return new Promise(res => { waitRef.current = res })
  }
  /** はい／いいえ を聞く。「ええわ」だけ のような どっちとも取れる答えは「『ええわ』って、〇〇って意味？それとも〇〇？」と聞き直す。
   *  関係ない言葉はそのまま返す（呼んだ側が変更として読む） */
  const askYN = async (t: string, yesLabel: string, noLabel: string, strongYes = true): Promise<'yes' | 'no' | string> => {
    let line = t, ys = yesLabel, ns = noLabel
    for (let i = 0; i < 3; i++) {
      const a = await ask(line, [{ label: ys, strong: strongYes }, { label: ns }])
      if (a === ys) return 'yes'
      if (a === ns) return 'no'
      const k = intent(a)
      if (k === 'yes' || k === 'no') return k
      if (k === null) return a
      ys = yesLabel === '予約する' ? 'これでOK！' : yesLabel
      ns = noLabel === 'やめとく' ? '今回はやめとく' : noLabel
      line = `「${a}」は、${yesLabel === '予約する' ? 'これでOK' : `「${yesLabel}」`}ということですか？それとも${noLabel === 'やめとく' ? '今回はやめておきますか' : `「${noLabel}」ですか`}？`
    }
    return 'no'
  }
  const answer = useCallback((t: string) => {
    const w = waitRef.current
    if (!w || !t.trim()) return
    waitRef.current = null
    setChips([]); setWaiting(false)
    push('you', t.trim())
    w(t.trim())
  }, [])
  const pickFromList = (): Promise<Menu | null> => { setSheet(menusRef.current); return new Promise(res => { sheetRef.current = res }) }
  /** 会話の中にカレンダーを出して、日付を待つ（選んだらカレンダーは畳んで、選んだ日だけ残す） */
  //   カレンダーの間も文字・声で答えられる（満席の日は押せないので「11月20日」と送ってキャンセル待ちへ・11/10 Codex 再検査）
  const pickDate = async (open: string[]): Promise<{ day: string } | { text: string } | null> => {
    const id = nextId.current++
    const first = open[0] ?? todayJst(), last = open[open.length - 1] ?? first
    setMsgs(m => [...m, { id, from: 'cal', open, first, last }])
    setWaiting(true)
    const r = await new Promise<{ day: string } | { text: string } | null>(res => {
      calRef.current = d => { waitRef.current = null; setWaiting(false); res(d ? { day: d } : null) }
      waitRef.current = t => { calRef.current = null; res({ text: t }) }
    })
    setMsgs(m => m.filter(x => x.id !== id))
    if (r && 'day' in r) push('you', mdw(r.day))
    return r
  }

  // ── 声：サーバーで文字にして、同じ会話へ（AI予約と同じしくみ） ──
  const onAudio = useCallback((audio: Blob) => {
    setTyping(true)
    void askAgentVoice(audio, [], undefined, true).then(r => { setTyping(false); if (r?.heard) { fromChip.current = false; answer(r.heard) } })
  }, [answer])
  const heardText = useCallback((t: string) => { fromChip.current = false; answer(t) }, [answer])
  const voice = useVoice(heardText, { server: api.serverVoice, onAudio, aiVoice: false })
  const listening = voice.listen === 'listening'
  // マイクを断られたら、ボタンが黙って消えるだけにせず一言伝える（11/9 Codex 検査 低）
  const micToldRef = useRef(false)
  useEffect(() => {
    if (micToldRef.current || (voice.listen !== 'denied' && voice.listen !== 'unsupported') || !voice.notice && voice.listen === 'unsupported') return
    micToldRef.current = true
    push('gin', voice.listen === 'denied'
      ? 'マイクが使えない状態です。スマホの設定でマイクを許可するか、下の欄に文字で入れてくださいね。'
      : voice.notice ?? 'このスマホでは声の入力が使えませんでした。下の欄に文字で入れてくださいね。')
  }, [voice.listen, voice.notice])

  /** メニューを聞く：AI が相談に乗る。決まったら名前と料金で確かめる（「ちがう」は何が違うか聞き直す・同じものを押しつけない） */
  const hearMenu = async (who: Who, opener: string, visitDate: string | null): Promise<Menu | null> => {
    const all = menusRef.current
    const rejected = new Set<string>()
    let line = opener
    let sugg: Menu[] = []
    for (let turn = 0; turn < 14; turn++) {
      const t = await ask(line, [...sugg.map(m => ({ label: m.name, sub: yen(m.price) })), { label: '一覧から選ぶ' }])
      // ボタン・一覧から押して選んだメニューは、そのまま決める（もう一度「よろしいですか？」は聞かない・11/9 磨き）。
      //   聞き直すのは、話した・打った言葉から読み取ったときだけ（聞き間違いを防ぐ）
      let tapped = fromChip.current
      let menu: Menu | null = sugg.find(m => m.name === t) ?? null
      if (!menu && t === '一覧から選ぶ') { menu = await pickFromList(); tapped = true; if (menu) push('you', menu.name); else { line = 'では、お話ししながら決めましょう。どんなことでもお聞かせください。'; sugg = []; continue } }
      if (menu && tapped) return menu
      if (!menu) {
        const plain = t.normalize('NFKC').replace(/[\s。、！!]/g, '').replace(/(でお願い(します)?|にする|でええ|で)$/, '')
        menu = all.find(m => m.name.normalize('NFKC').replace(/\s/g, '') === plain && !rejected.has(m.code)) ?? null
      }
      if (!menu) {
        setTyping(true)
        const r = await askUsualAi(t, turns.current.slice(0, -1), { visited: true, who: who.kind === 'mate' ? who.name : null, rejected: [...rejected], visitDate })
        setTyping(false)
        if (!r) { line = 'すみません、うまく聞き取れませんでした。一覧から選んでいただいても大丈夫ですよ。'; sugg = []; continue }
        const ready = r.ready ? all.find(m => m.code === r.ready) : undefined
        if (!ready) { line = r.say; sugg = r.suggestions.map(c => all.find(m => m.code === c)).filter((m): m is Menu => !!m); continue }
        menu = ready
        await say(r.say)
      }
      const c = await askYN(`「${menu.name}」${menu.price != null ? ` ${yen(menu.price)}` : ''}でよろしいですか？`, 'はい', 'ちがう')
      if (c === 'yes') return menu
      rejected.add(menu.code)
      setTyping(true)
      const r = await askUsualAi(c === 'no' ? `「${menu.name}」はちがう` : `「${menu.name}」はちがう。${c}`, turns.current, { visited: true, who: who.kind === 'mate' ? who.name : null, rejected: [...rejected], visitDate })
      setTyping(false)
      line = r?.say ?? '失礼しました。どんな感じでしたか？'
      sugg = (r?.suggestions ?? []).map(code => all.find(m => m.code === code)).filter((m): m is Menu => !!m)
    }
    return null
  }

  /** 来店した日のメニューを確かめて記録する（分かっていれば「〇〇じゃったね？」） */
  const confirmVisit = async (who: Who, v: Visit, greet: string): Promise<Menu | null> => {
    const all = menusRef.current
    const known = v.menu_code && v.menu_code !== 'maintenance' ? all.find(m => m.code === v.menu_code) ?? null : null
    const name = who.kind === 'mate' ? `${honor(who.name)}は` : ''
    let menu: Menu | null
    if (known) {
      const a = await askYN(`${greet}${md(v.date)}は${name}${known.name}でしたね！\nこちらを、いつものメニューに登録してもよろしいですか？`, 'はい', 'いいえ')
      menu = a === 'yes' ? known : await hearMenu(who, `失礼しました。${md(v.date)}は、何のメニューでしたか？`, v.date)
    } else if (v.menu_code === 'maintenance') {
      menu = await hearMenu(who, `${greet}${md(v.date)}はメンテナンスカットでしたね！\n${name}いつもは、何のメニューにされていますか？`, null)
    } else {
      menu = await hearMenu(who, `${greet}${md(v.date)}は${who.kind === 'mate' ? honor(who.name) + 'も' : ''}ご来店ありがとうございました！\nいつものメニューを決めたいので、前回のメニューを教えてもらえますか？`, v.date)
    }
    try {
      await callCustomerRpc('customer_confirm_visit', { p_date: v.date, p_companion: who.kind === 'mate' ? who.id : null, p_menu_code: v.menu_code === 'maintenance' ? null : menu?.code ?? null })
    } catch { /* 記録できなくても会話は続ける */ }
    return menu
  }

  const askMaintenance = async (who: Who, menu: Menu) => {
    if (!menu.maintenance) return false
    const a = await askYN(`「${menu.name}」なら、14日以内のメンテナンスカットもご利用いただけます。\n${who.kind === 'mate' ? honor(who.name) + 'も' : ''}ご希望されますか？`, 'はい', 'いいえ')
    return a === 'yes'
  }

  /** お得な案内：使える割引券（期限内・条件に合うもの）と、メンテナンスの期限 */
  /** 使える割引券の一言（無い・読めんときは空） */
  const loadTickets = () => callCustomerRpc<TicketRow[]>('customer_get_tickets').then(t => t ?? [], () => null)
  //   券の期限・条件は「ご来店の日時・メニュー」で判定する（今の時刻で見ると、来店前に切れる券まで「使えますよ」と言っていた・11/10 Codex 再検査）
  const ticketText = (tickets: readonly TicketRow[] | null, at: string, menuCode?: string) => {
    const usable = usableTickets(tickets ?? [], at, menuCode).filter(t => t.type === 'discount' && (t.amount ?? 0) > 0)
    if (!usable.length) return ''
    const best = Math.max(...usable.map(t => t.amount ?? 0))
    // 「次のご予約で」と言うと、今取った予約では使えんように聞こえる（11/9 磨き）。券の条件に合えば、来店した日のお会計で使える
    return usable.length === 1 ? `${best.toLocaleString('ja-JP')}円の割引券をお持ちです。ご来店のときに、お会計で使えますよ。` : `割引券を${usable.length}枚お持ちです（いちばん大きいのは${best.toLocaleString('ja-JP')}円）。ご来店のときに、お会計で使えますよ。`
  }
  const tips = async (owner: Person | null | undefined) => {
    // 予約前（登録のあと）：今使える券。期限が近いものは券の画面で日付が見える
    const t = ticketText(await loadTickets(), new Date().toISOString())
    if (t) await say(t)
    if (owner?.maintenance_ok && owner.days_left != null) await say(owner.days_left === 0 ? 'メンテナンスカットは今日までですので、よかったらどうぞ。' : `メンテナンスカットは、あと${owner.days_left}日ご利用いただけますよ。`)
  }

  // ── welcome：店頭の QR のあと ──
  const runWelcome = async (pending: Pending) => {
    let people: People | null = await fetchPeople().catch(() => null)
    let greet = 'いらっしゃいませ。\n'
    if (pending.owner) {
      const menu = await confirmVisit({ kind: 'me' }, pending.owner, greet)
      greet = ''
      if (menu) {
        const before = people?.owner?.menu_code
        setUsualMenu({ code: menu.code, name: menu.name })
        await callCustomerRpc('customer_set_usual_menu', { p_code: menu.code }).catch(() => {})
        await say(before && before !== menu.code ? `いつものを「${menu.name}」に変えておきました。` : `ありがとうございます！いつものは「${menu.name}」で登録しました。`)
        const m = await askMaintenance({ kind: 'me' }, menu)
        people = await setOwnerMaintenance(m).catch(() => people)
        if (m) await say('かしこまりました！メンテナンスカットもご案内しますね。')
      }
    }
    for (const c of pending.companions) {
      const who: Who = { kind: 'mate', id: c.id, name: c.name }
      const menu = await confirmVisit(who, c, greet)
      greet = ''
      if (menu) {
        const m = await askMaintenance(who, menu)
        people = await saveCompanion(c.id, c.name, menu.code, m).catch(() => people)
        await say(`${honor(c.name)}のいつものは「${menu.name}」にしておきました。`)
      }
    }
    let count = people?.companions.length ?? 0
    // お連れ様の登録のおすすめは1回だけ。「今はしない」と答えた方に、来店のたびに聞かない（11/9 点検）。登録は ☰ からいつでもできる
    const askedKey = 'ginjiro_companion_offer_declined:' + (getStoredValue<string | null>(USER_ID_KEY, null) ?? '')
    let declined = false
    try { declined = localStorage.getItem(askedKey) === '1' } catch { /* 読めん端末は今までどおり聞く */ }
    if (count === 0 && !declined) {
      let a = await askYN('お連れ様も登録できますよ。どうされますか？', '登録する', '今はしない')
      if (a !== 'yes') { try { localStorage.setItem(askedKey, '1') } catch { /* 保存できん端末は次も聞く */ } await say('かしこまりました。ご一緒の方が来られるときは、☰ の「いつもの・お連れ様」からも登録できます。') }
      while (a === 'yes' && count < MAX_COMPANIONS) {
        const n = await ask('お名前を教えてください。お店でお呼びするお名前で大丈夫ですよ。', [])
        const name = n.slice(0, 20)
        const menu = await hearMenu({ kind: 'mate', id: null, name }, `${honor(name)}は、いつも何のメニューにされていますか？`, null)
        if (menu) {
          const m = await askMaintenance({ kind: 'mate', id: null, name }, menu)
          try { people = await saveCompanion(null, name, menu.code, m); count++; await say(`${honor(name)}も登録しました！`) }
          catch { await say('すみません、うまく登録できませんでした。あとで ☰ からも登録できます。'); break }
        }
        if (count >= MAX_COMPANIONS) break
        a = await askYN('ほかにも、ご一緒に来られる方はいらっしゃいますか？', '登録する', '以上です')
      }
    }
    await tips(people?.owner)
    const next = await askYN('準備ができました！このまま次のご予約もできますよ。', '予約する', 'ホームへ')
    if (next === 'yes' || (next !== 'no' && /予約/.test(next))) await runBook(people)
    else onClose()
  }

  const checkBookingAccess = async (session: string | null) => {
    let retried = false
    for (;;) {
      if (session && getCustomerSession() === session) {
        setTyping(true)
        const status = await callCustomerRpc<{ verified?: boolean }>('customer_store_access_status').catch(() => null)
        setTyping(false)
        if (getCustomerSession() === session) {
          if (status?.verified === true) return retried ? 'retried' : 'ready'
          if (status?.verified === false) {
            const answer = await askYN('AI予約は、お店で会員QRを読ませていただいてから使えるようになります。\n次のご来店のときに、スタッフに会員QRをお見せくださいね。', '会員QRを表示', 'ホームへ')
            onClose()
            if (answer === 'yes') window.dispatchEvent(new Event('ginjiro:show-qr'))
            return 'closed'
          }
          for (;;) {
            const answer = await ask('店頭での本人確認を確かめられませんでした。通信が戻ったら、もう一度確認してください。', [
              { label: 'もう一度確認', strong: true }, { label: '予約を閉じる' },
            ])
            if (fromChip.current && answer === '予約を閉じる') { onClose(); return 'closed' }
            if (fromChip.current && answer === 'もう一度確認') break
          }
          retried = true
          continue
        }
      }
      await say('ログイン状態が変わりました。会員情報を確認してから、予約を開き直してください。')
      await endChange()
      return 'closed'
    }
  }

  // ── book：予約。「誰が・何を・いつ」を1枚の予約メモにして、足りんところだけ聞く（11/8 慶一郎さん「変えたところだけ直す」）
  //   どの質問の途中でも「やっぱり朔耶だけ」「土曜がええ」「アイパーにする」で、そこだけ直す（ボタン・声・文字どれでも）
  //   人・メニューが変わったら施術時間も変わるので、時間は必ず選び直し（前の時間で取れると決めつけない）
  const runBook = async (known?: People | null, preset?: { menuCode?: string | null; label?: string }, askExisting = false) => {
    const session = getCustomerSession()
    if (await checkBookingAccess(session) === 'closed') return
    if (hasPendingBookingConfirmation()) return checkPreviousBooking()
    // もうご予約があるのに、何も言わずに新しい予約を始めていた（11/10 慶一郎さん「予約確定してもう一度AI予約したら、いつもの文章」）
    //   → 先に今のご予約を伝えて、もう1件か・変更かを選んでもらう
    // 予約は「1人につき1件まで」（11/10 慶一郎さん「原則、1名につき一回の予約まで」）。
    //   もう予約がある方は、新しい予約の人に入れない。変更は「今の予約を変更する」から
    const people = known ?? await fetchPeople().catch(() => null)
    const owner: BookPerson = { key: 'me', id: null, name: people?.owner?.name ?? 'ご本人', label: 'ご本人', person: people?.owner ?? null }
    const allMates: BookPerson[] = (people?.companions ?? []).filter(c => c.id).map(c => ({ key: c.id!, id: c.id!, name: c.name, label: honor(c.name), person: c }))
    const mineNow = await api.reservations().catch(() => null)
    const upcoming = Array.isArray(mineNow) ? mineNow.filter(r => r.status === 'confirmed' && isUpcoming(r)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)) : []
    /** もう予約がある人（ご本人は 'me'、お連れ様はその id） */
    const booked = new Set(upcoming.flatMap(r => (r.companion_id ? [r.companion_id] : !r.companion_of && !r.companion_name ? ['me'] : [])))
    const ownerFree = !booked.has('me')
    const mates = allMates.filter(p => !booked.has(p.key))
    const whatOf = (r: CustomerReservation) => `${r.companion_name ? honor(r.companion_name) + 'の' : ''}${slotLabel(r.starts_at)} ${r.items.map(i => i.name).join('・')}`
    /** お連れ様が登録されていない：会話を閉じて「お連れ様を登録」のガイドを出す */
    const guidePeople = async () => {
      await say('お連れ様のご予約は、先にお連れ様を登録すると取れます。\n登録の場所をご案内しますね。')
      await pause(900)
      onClose()
      window.dispatchEvent(new CustomEvent('ginjiro-guide:run', { detail: { ns: 'customer', task: 'c-people' } }))
    }
    if (askExisting && upcoming.length) {
      const r = upcoming[0]
      const CHANGE = '今の予約を変更する', MATE = 'お連れ様の予約をする'
      const a = await ask(`今、${whatOf(r)}のご予約が入っていますよ${upcoming.length > 1 ? `（ほかに${upcoming.length - 1}件）` : ''}。\n${ownerFree ? '' : 'ご予約は、お一人さま1件までです。'}どうされますか？`,
        [...(ownerFree ? [{ label: 'もう1件予約する', strong: true }] : []), { label: CHANGE, strong: !ownerFree }, { label: MATE }, { label: '閉じる' }])
      if (a === CHANGE || (!fromChip.current && /変更|変え|キャンセル|取り消/.test(a))) return runChange()
      if (fromChip.current && a === '閉じる') return onClose()
      if (a === MATE || (!fromChip.current && /連れ|家族|子/.test(a))) {
        if (!allMates.length) return guidePeople()
        if (!mates.length) { await say('ご登録のお連れ様は、みなさんもうご予約があります。変更は「今の予約を変更する」からどうぞ。'); return endChange() }
      } else if (!ownerFree) {
        await say('ご予約は、お一人さま1件までです。日時やメニューを変えるときは「今の予約を変更する」からどうぞ。'); return endChange()
      }
    }
    if (!ownerFree && !mates.length) {
      if (!allMates.length) return guidePeople()
      await say('みなさん、もうご予約があります。日時やメニューを変えるときは「次回予約」の「変更・キャンセル」からどうぞ。'); return endChange()
    }
    const everyone = [...(ownerFree ? [owner] : []), ...mates]
    const opts = await api.options().catch(() => null)
    const all = opts ? usualMenuOrder(opts.menus.filter(m => canBeUsual(m.code))) as Menu[] : menusRef.current
    const maintMenu = opts?.menus.find(m => m.code === 'maintenance') as Menu | undefined
    const staffList = opts?.staff ?? []
    const d: Draft = { who: everyone.length > 1 ? null : everyone, menus: {}, when: null, at: null, plan: null, recheck: null }
    /** 空きを探す担当：1人の予約で担当を選んだときだけ（2人以上は同じ時間に別々の担当が要るので、今までどおり自動） */
    const staffOf = () => (d.who?.length === 1 ? d.staff ?? null : null)
    let usualStaffTried = false
    const staffName = (id: string | null | undefined) => staffList.find(s => s.id === id)?.name ?? ''
    /** 文の中の担当（「銀二郎で」）。どちらでも・おまかせ は null、無ければ undefined */
    const staffIn = (t: string): string | null | undefined => {
      const s = t.normalize('NFKC')
      if (/どちらでも|どっちでも|誰でも|だれでも|おまかせ|お任せ|指名なし/.test(s)) return null
      return longestIn(s, staffList, x => x.name)?.id
    }
    // 髪型の写真から来た：最初の方のメニューはそれで聞く（1回だけ）
    let presetMenu: Menu | null = preset?.menuCode ? all.find(m => m.code === preset.menuCode) ?? null : null
    let presetLabel = preset?.label && !presetMenu ? preset.label : ''
    let styleLabel = preset?.label ?? ''

    /** 言葉の中の人（「朔耶だけ」「本人と朔耶」「2人とも」） */
    const whoIn = (t: string): BookPerson[] | null => {
      const s = t.normalize('NFKC')
      if (/全員|みんな|皆|[2２二]人とも|[3３三]人とも|一緒/.test(s)) return everyone.slice(0, 3)
      // 長い名前に含まれる短い名前は数えない（「太郎丸だけ」で太郎まで選ばれていた・11/9 Codex 検査 高）
      const hit = namesIn(s, mates, p => p.name.replace(/(さん|様|ちゃん|くん|君)$/, ''))
      const me = ownerFree && /本人|わし|自分|私|僕|俺|お母さん本人/.test(s)
      const list = [...(me ? [owner] : []), ...hit]
      return list.length ? list.slice(0, 3) : null
    }
    const whenIn = (t: string): Draft['when'] | undefined => {
      const s = t.normalize('NFKC')
      const day = dateIn(s)
      if (day) return { kind: 'day', day }
      if (/土|日曜|週末/.test(s) && !/日付|日にち/.test(s)) {
        const sat = /土曜/.test(s), sun = /日曜/.test(s)
        return sat && !sun ? { kind: 'weekend', dow: 6 } : sun && !sat ? { kind: 'weekend', dow: 0 } : { kind: 'weekend' }
      }
      if (/最短|早|はよ|いちばん近/.test(s)) return { kind: 'soonest' }
      if (/日付|日にち|カレンダー|別の日|ほかの日|他の日/.test(s)) return { kind: 'pick' }
      return undefined
    }
    const menuIn = (t: string): Menu | null => {
      // 「パンチじゃなくてアイパー」は後ろのほう（言い直したメニュー）
      const s = t.normalize('NFKC').split(/じゃなく(?:て)?|ではなく(?:て)?|やなくて|より/).pop() ?? ''
      if (/メンテ/.test(s) && maintMenu) return maintMenu
      return longestIn(s, all, m => m.name.normalize('NFKC')) ?? matchMenu(t, all)
    }
    /** 途中の変更を読み取って、予約メモのそこだけ直す。直したら true */
    const change = async (t: string): Promise<boolean> => {
      const s = t.normalize('NFKC')
      const changing = /やっぱ|変え|変更|じゃなく|ではなく|だけ|にする|がええ|がいい|にして/.test(s)
      const w = whoIn(s)
      // 「朔耶はアイパーにする」はメニューの変更。人の変更は「だけ」「2人とも」「全員」などのときだけ
      const aboutWho = /だけ|のみ|全員|みんな|皆|とも|一緒|人で|も一緒|も予約|も追加|抜き|なし|やめ/.test(s) || !menuIn(s)
      if (w && aboutWho && (changing || d.who !== null) && !(d.who && sameWho(d.who, w))) {
        const note = `${w.map(p => p.label).join('と')}のご予約に変更しました。`
        if (d.at) d.recheck = { at: d.at, note, why: '人数が変わって' }
        else await say(`かしこまりました！${note}`)
        d.who = w; d.at = null; d.plan = null
        return true
      }
      const m = menuIn(s)
      if (m && changing && d.who) {
        let target = d.who.length === 1 ? d.who[0] : (whoIn(s)?.[0] ?? null)
        if (!target) {
          const a = await ask(`「${m.name}」は、どなたのメニューですか？`, d.who.map(p => ({ label: p.label })))
          target = d.who.find(p => p.label === a) ?? longestIn(a, d.who, p => p.name) ?? d.who[0]
        }
        if (m.code === 'maintenance' && !target.person?.maintenance_ok) { await say(`${target.label}は、今はメンテナンスカットの期限が過ぎているんです。`); return true }
        const note = `${d.who.length > 1 ? target.label + 'は' : ''}「${m.name}」に変更しました。`
        if (d.at) d.recheck = { at: d.at, note, why: 'メニューが変わって施術の時間も変わるので' }
        else await say(`かしこまりました！${note}`)
        d.menus[target.key] = m; d.at = null; d.plan = null
        return true
      }
      // 担当の言い直し（「やっぱり銀二郎で」）：1人の予約のときだけ
      const st = staffIn(s)
      if (st !== undefined && d.who?.length === 1 && staffList.length > 1 && st !== (d.staff ?? null)
        && (changing || /担当|指名|さんで|で$|でお願い/.test(s) || st === null)) {
        d.staff = st; d.at = null; d.plan = null
        await say(st ? `かしこまりました！${staffName(st)}の空きで探しますね。` : 'かしこまりました！どちらの担当でも、で探しますね。')
        return true
      }
      const wh = whenIn(s)
      if (wh && (changing || d.when !== null)) {
        d.when = wh; d.at = null; d.plan = null
        await say(wh.kind === 'weekend' ? `かしこまりました！${wh.dow === 6 ? '土曜' : wh.dow === 0 ? '日曜' : '土日'}で探しますね。` : wh.kind === 'day' ? `かしこまりました！${mdw(wh.day)}で探しますね。` : wh.kind === 'soonest' ? 'かしこまりました！いちばん早いところで探しますね。' : 'かしこまりました。日にちを選び直しましょう。')
        return true
      }
      return false
    }

    /** その人のメニュー（いつもの・メンテナンス・ほか） */
    const askMenuFor = async (p: BookPerson): Promise<Menu | null | 'changed'> => {
      const usual = p.person?.menu_code ? all.find(m => m.code === p.person!.menu_code) ?? null : null
      const maint = p.person?.maintenance_ok ? maintMenu : undefined
      const whoText = d.who && (d.who.length > 1 || p.key !== 'me') ? `${p.label}は` : ''
      if (!usual) {
        const m = await hearMenu(p.id ? { kind: 'mate', id: p.id, name: p.name } : { kind: 'me' }, `${whoText ? `${p.label}の` : ''}メニューは、何にされますか？`, null)
        return m
      }
      // 「アイパーですね」【はい】【ほかのメニュー】。14日以内なら【メンテナンスカット】も（11/10 慶一郎さん）
      const a = await ask(`${whoText}いつもの「${usual.name}」${usual.price != null ? ` ${yen(usual.price)}` : ''}ですね。${maint ? `\nメンテナンスカットも${p.person?.days_left ? `、あと${p.person.days_left}日` : 'は今日まで'}ご利用いただけます。` : ''}`,
        [{ label: 'はい', strong: true }, ...(maint ? [{ label: 'メンテナンスカット', sub: p.person?.days_left ? `あと${p.person.days_left}日` : '今日まで' }] : []), { label: 'ほかのメニュー' }])
      if (maint && /メンテ/.test(a)) return maint
      if (a === usual.name || (fromChip.current && a === 'はい')) return usual
      if (a !== 'ほかのメニュー' && await change(a)) return 'changed'
      const k = intent(a)
      if (k === 'yes') return usual
      if (k === 'ambiguous') { await say(`「${a}」は、いつもの「${usual.name}」でよろしいということですか？ボタンで教えてくださいね。`); return await askMenuFor(p) }
      const direct = menuIn(a)
      if (direct && a !== 'ほかのメニュー') return direct
      return await hearMenu(p.id ? { kind: 'mate', id: p.id, name: p.name } : { kind: 'me' }, '何のメニューにされますか？', null)
    }

    /** 予約メモの人・メニュー・いつ から、空いている時間を探す（人数・施術時間ごとに今の予約エンジンで確かめる）。
     *  2人以上は、同じ時間に全員が別々の担当で入れる時間だけ */
    const findTimes = async (): Promise<{ at: string; staff: Record<string, string | null> }[]> => {
      const who = d.who!, menus = who.map(p => d.menus[p.key])
      const codes = [...new Set(menus.map(m => m.code))]
      let days: string[]
      if (d.when?.kind === 'day') days = [d.when.day]
      else {
        const lists = await Promise.all(codes.map(c => openDays(c, todayJst(), d.when?.kind === 'weekend' ? 42 : 21, d.when?.kind === 'weekend', staffOf())))
        days = lists.reduce((a, b) => a.filter(x => b.includes(x)))
        const w = d.when
        if (w?.kind === 'weekend' && w.dow != null) days = days.filter(x => new Date(Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10))).getUTCDay() === w.dow)
      }
      const out: { at: string; staff: Record<string, string | null> }[] = []
      const want = d.when?.kind === 'day' ? 6 : 3
      let groupFailed = false
      for (const day of days.slice(0, 8)) {
        if (who.length === 1) {
          const st = staffOf()
          const slots = spreadSlots(await (st ? api.staffSlots(day, menus[0].code, st) : api.slots(day, menus[0].code)), d.when?.kind === 'day' ? 6 : d.when?.kind === 'weekend' ? 2 : 3)
          out.push(...slots.map(s => ({ at: s.starts_at, staff: { [who[0].key]: st } })))
        } else {
          // 担当ごと・メニューごとの空き → 同じ時間に、全員へ別々の担当を割り当てられる時間
          const free = await Promise.all(who.map((_, i) => Promise.all(staffList.map(st => api.staffSlots(day, menus[i].code, st.id).then(l => new Set(l.map(x => Date.parse(x.starts_at))), () => { groupFailed = true; return new Set<number>() })))))
          const times = [...new Set(free.flatMap(per => per.flatMap(set => [...set])))].sort((a, b) => a - b)
          const ok: { at: string; staff: Record<string, string | null> }[] = []
          for (const t of times) {
            const pick = assign(who.length, staffList.length, (pi, si) => free[pi][si].has(t))
            if (pick) ok.push({ at: new Date(t).toISOString(), staff: Object.fromEntries(who.map((p, i) => [p.key, staffList[pick[i]].id])) })
          }
          const spread = spreadSlots(ok.map(o => ({ starts_at: o.at })), d.when?.kind === 'day' ? 6 : 2).map(s => ok.find(o => o.at === s.starts_at)!)
          out.push(...spread)
        }
        if (out.length >= want) break
      }
      // 2人以上：担当ごとの空きが通信で読めず、時間が1つも見つからんときは「空きが無い」ではなく通信の不具合（11/10 Codex 検査 ③）
      if (groupFailed && !out.length) throw new Error('slots_unreachable')
      return out.slice(0, want)
    }

    const planAt = async (at: string): Promise<Record<string, string | null> | null> => {
      const who = d.who!, menus = who.map(p => d.menus[p.key]), day = dayOf(at), t = Date.parse(at)
      if (who.length === 1) {
        const st = staffOf()
        const l = await (st ? api.staffSlots(day, menus[0].code, st) : api.slots(day, menus[0].code))
        return l.some(x => Date.parse(x.starts_at) === t) ? { [who[0].key]: st } : null
      }
      const free = await Promise.all(who.map((_, i) => Promise.all(staffList.map(st => api.staffSlots(day, menus[i].code, st.id)
        .then(l => l.some(x => Date.parse(x.starts_at) === t)).catch(() => false)))))
      const pick = assign(who.length, staffList.length, (pi, si) => free[pi][si])
      return pick ? Object.fromEntries(who.map((p, i) => [p.key, staffList[pick[i]].id])) : null
    }

    /** 空きを調べる通信が届かなかった：「空きが無い」とは言わずに、もう一度探すか聞く。探すなら true */
    const retryAfterNetwork = async () => {
      const AGAIN = 'もう一度探す'
      const a = await ask('すみません、通信の具合で空きを確かめられませんでした。\n電波の良いところで、もう一度お試しください。', [{ label: AGAIN, strong: true }, { label: 'やめておく' }])
      if (fromChip.current && a === 'やめておく') { await say('また決まりましたら、いつでも声をかけてくださいね。'); return false }
      return true
    }
    /** 選んだ担当に空きが無い：どちらでも に広げるか聞く。広げたら true（やめたら false） */
    const offerAnyStaff = async (when: string) => {
      const name = staffName(staffOf())
      const a = await ask(`すみません、${name}は${when}このメニューの空きが無いんです。\nどちらの担当でもよければ、お探ししますよ。`, [{ label: 'どちらでも', strong: true }, ...(d.when?.kind === 'pick' ? [] : [{ label: '日付を選ぶ' }]), { label: 'やめておく' }])
      if (fromChip.current && a === 'やめておく') { await say('また決まりましたら、いつでも声をかけてくださいね。'); return false }
      if (fromChip.current && a === '日付を選ぶ') { d.when = { kind: 'pick' }; return true }
      if (fromChip.current && a === 'どちらでも') { d.staff = null; d.when = d.when?.kind === 'pick' ? { kind: 'pick' } : d.when; return true }
      if (await change(a)) return true
      d.staff = null; return true
    }
    const summary = () => d.who!.map(p => `${d.who!.length > 1 ? p.label + '：' : ''}${d.menus[p.key].name}${d.menus[p.key].price != null ? ` ${yen(d.menus[p.key].price)}` : ''}`).join('\n')
      + (staffOf() ? `\n担当：${staffName(staffOf())}` : '')

    // 同じ人の施術が重なる場合だけ、新規登録の前に止める。
    let hasOther = false
    let tickets: TicketRow[] | null | undefined
    // 確認の前に、お持ちの券を選んでもらう（11/10 慶一郎さん）。ガチャ券は使えるなら自動で付ける（前の AI予約と同じ・景品のルール②）
    let gachaHeld: GachaHeld | null | undefined
    /** 選んだ券（undefined＝まだ聞いていない、null＝使わない） */
    let picked: TicketRow | null | undefined
    /** ガチャ券を付ける人（使えなければ undefined） */
    const gachaFor = (): BookPerson | undefined => {
      if (!gachaHeld || !d.at || !d.who) return undefined
      const fits = (p: BookPerson) => gachaOff(gachaHeld, d.menus[p.key].code, d.at!, d.menus[p.key].price ?? 0) != null
      // 割引のガチャ券はご本人だけ。無料券（free_menu あり・ゲージの券は除く）だけお連れ様1名にも使える（サーバーの gacha_unfit と同じ・11/10 Codex 検査 ⑤）
      const me = d.who.find(p => p.key === 'me')
      if (me && fits(me)) return me
      return gachaHeld.free_menu && !gachaHeld.self_only ? d.who.find(fits) : undefined
    }
    /** 券・ガチャ券を引いたお支払い予定の行（引くものが無ければ空） */
    const priceLines = () => {
      const g = gachaFor()
      const gOff = g ? gachaOff(gachaHeld, d.menus[g.key].code, d.at!, d.menus[g.key].price ?? 0) ?? 0 : 0
      const tOff = picked ? picked.amount : 0
      if (!gOff && !tOff) return ''
      const sum = d.who!.reduce((a, p) => a + (d.menus[p.key].price ?? 0), 0)
      return [
        ...(picked ? [`${picked.title} −${yen(tOff)}`] : []),
        ...(g ? [`ガチャ券（${gachaHeld!.title}）${d.who!.length > 1 ? `・${g.label}` : ''} −${yen(gOff)}`] : []),
        `お支払い予定 ${yen(Math.max(0, sum - tOff - gOff))}`,
      ].join('\n')
    }
    const canCreate = async (persons: BookPerson[]) => {
      const mine = await api.reservations().catch(() => null)
      if (!Array.isArray(mine)) {
        await say('今のご予約を確認できませんでした。通信を確認してから、もう一度お試しください。')
        await endChange()
        return false
      }
      // 「今あるご予約はそのままです」は、ほかに予約があるときだけ言う（11/9）
      hasOther = mine.some(r => isUpcoming(r) && r.status === 'confirmed')
      // 1人1件：日時に関係なく、もう予約がある方は新しく取らない（会話の途中に別の端末で取った場合も・11/10 慶一郎さん）
      const existing = persons.filter(p => mine.some(r => isUpcoming(r) && r.status === 'confirmed' && (
        p.id ? r.companion_id === p.id : !r.companion_id && !r.companion_of && !r.companion_name
      )))
      if (existing.length === 0) return true
      const a = await ask(`${existing.map(p => p.label).join('と')}は、もうご予約があります。ご予約はお一人さま1件までです。\n日時やメニューを変える場合は、予約変更へお進みください。`, [
        { label: '予約変更へ', strong: true }, { label: '閉じる' },
      ])
      if (fromChip.current && a === '予約変更へ') await runChange()
      else onClose()
      return false
    }
    for (let guard = 0; guard < 40; guard++) {
      // 誰の予約？
      if (!d.who) {
        // ボタンの言葉で「誰と誰か」が分かるように（11/9 慶一郎さん「複数人選べると思えない人もいる」）。
        //   ご本人だけ → ご本人と〇〇さん（2人） → 3人とも → 〇〇さんだけ の順。読み取りは whoIn（「と」「だけ」「とも」）
        // 押したボタンは、言葉から読み直さずに人を直接つなぐ（名前の部分一致で別の人まで入っていた・11/9 Codex 検査 高）
        const byChip = new Map<string, BookPerson[]>([
          // もう予約があるご本人は入れない（1人1件・11/10）
          ...(ownerFree ? [['ご本人だけ', [owner]] as [string, BookPerson[]], ...mates.map(p => [`ご本人と${p.label}`, [owner, p]] as [string, BookPerson[]])] : []),
          ...(!ownerFree && mates.length === 2 ? [[`${mates[0].label}と${mates[1].label}`, mates] as [string, BookPerson[]]] : []),
          ...(everyone.length === 3 ? [['3人とも', everyone.slice(0, 3)] as [string, BookPerson[]]] : []),
          ...mates.map(p => [`${p.label}だけ`, [p]] as [string, BookPerson[]]),
        ])
        const chips: Chip[] = [...byChip.keys()].map((label, i) => ({ label, strong: i === 0 }))
        const a = await ask('どなたのご予約ですか？\nご一緒の方の分も、まとめてお取りできますよ。', chips)
        const w = (fromChip.current ? byChip.get(a) : undefined) ?? whoIn(a) ?? (mates.find(p => p.label === a) ? [mates.find(p => p.label === a)!] : null)
        if (w) { d.who = w; continue }
        if (await change(a)) continue
        d.who = ownerFree ? [owner] : [mates[0]]; continue
      }
      // メニュー（決まっとらん人だけ）
      const need = d.who.find(p => !d.menus[p.key])
      if (need && (presetMenu || presetLabel)) {
        const pm = presetMenu, pl = presetLabel
        presetMenu = null; presetLabel = ''
        if (pm) {
          // 髪型の写真から来たら、その名前を受けてからメニューを伝える（「ちょい悪オヤジ」→ 通常カット・11/9 磨き）
          const style = styleLabel && styleLabel !== pm.name ? `「${styleLabel}」ですね！メニューは` : ''
          styleLabel = ''
          const a = await askYN(`${d.who.length > 1 ? need.label + 'は' : ''}${style}「${pm.name}」${pm.price != null ? ` ${yen(pm.price)}` : ''}${style ? 'になります。よろしいですか？' : 'でよろしいですか？'}`, 'はい', 'ほかのメニュー')
          if (a === 'yes') { d.menus[need.key] = pm; continue }
          if (a !== 'no' && await change(a)) continue
        } else {
          const m = await hearMenu(need.id ? { kind: 'mate', id: need.id, name: need.name } : { kind: 'me' }, `「${pl}」の髪型ですね。メニューは何にされますか？`, null)
          if (m) { d.menus[need.key] = m; continue }
        }
      }
      if (need) {
        const m = await askMenuFor(need)
        if (m === 'changed') continue
        if (!m) { await say('また決まりましたら、いつでも声をかけてくださいね。'); break }
        d.menus[need.key] = m
        if (d.recheck && !d.recheck.note) d.recheck.note = `${d.who.length > 1 ? need.label + 'は' : ''}「${m.name}」に変更しました。`
        continue
      }
      // 担当（1人の予約・ご来店を聞く前）：選んだ担当の空きで日時を決める（11/10 慶一郎さん）
      if (d.who.length === 1 && staffList.length > 1 && d.staff === undefined) {
        // いつもの担当を登録している方は聞かずにその担当で（最初の1回だけ。【担当を変える】のあとは聞く）
        const pk = d.who[0].key
        const usualSt = usualStaffOf(pk)
        if (!usualStaffTried && usualSt && staffList.some(s => s.id === usualSt)) {
          usualStaffTried = true
          d.staff = usualSt
          await say(`担当は、いつもの${staffName(usualSt)}で探しますね。`)
          continue
        }
        usualStaffTried = true
        const ANY = 'どちらでも'
        const a = await ask('ご担当のご希望はありますか？', [...staffList.map(s => ({ label: s.name })), { label: ANY }])
        const st = fromChip.current ? (a === ANY ? null : staffList.find(s => s.name === a)?.id) : staffIn(a)
        if (st !== undefined) {
          d.staff = st
          if (d.recheck && !d.recheck.note) d.recheck.note = st ? `担当を${staffName(st)}に変更しました。` : '担当は、どちらでも に変更しました。'
          // 次回から選ばなくていいように、登録するか聞く（11/10 慶一郎さん）
          if (st && st !== usualSt) {
            const r = await askYN(`次回からも${staffName(st)}で、いつもの担当に登録しておきましょうか？\n登録すると、次からは担当を聞かずにお探しします。`, '登録する', '毎回選ぶ')
            if (r === 'yes') { setUsualStaffOf(pk, st); await say(`かしこまりました。いつもの担当を${staffName(st)}で登録しました。`) }
          }
          continue
        }
        if (await change(a)) continue
        d.staff = null; continue
      }
      // いつ？
      if (!d.when) {
        const a = await ask('ご来店は、いつ頃がよろしいですか？', [{ label: '最短で', strong: true }, { label: '土日希望' }, { label: '日付を選ぶ' }])
        const wh = whenIn(a)
        if (wh) { d.when = wh; continue }
        if (await change(a)) continue
        d.when = { kind: 'soonest' }; continue
      }
      if (d.when.kind === 'pick') {
        setTyping(true)
        const codes = [...new Set(d.who.map(p => d.menus[p.key].code))]
        const lists = await Promise.all(codes.map(c => openDays(c, todayJst(), 63, false, staffOf()))).catch(() => null)
        setTyping(false)
        if (!lists) { if (await retryAfterNetwork()) continue; break }
        const open = lists.reduce((a, b) => a.filter(x => b.includes(x)))
        if (!open.length && staffOf()) { if (await offerAnyStaff('しばらく')) continue; break }
        if (!open.length) { await say('すみません、しばらく全員そろって入れる日が無いんです。お店にお電話いただけますか？'); d.when = null; continue }
        // 満席の日はカレンダーで押せない → ご本人1人なら、日付を送ればその日のキャンセル待ちに入れる（11/10 Codex 再検査 中）
        const soloMe = d.who.length === 1 && d.who[0].key === 'me'
        await say(d.who.length > 1 ? '全員そろって入れる日だけ、押せるようにしています。'
          : soloMe ? '空いている日だけ、押せるようにしています。\n満席の日のキャンセル待ちは、「11月20日」のように日付を送ってもらえたら入れますよ。'
          : '空いている日だけ、押せるようにしています。')
        const picked = await pickDate(open)
        if (picked && 'text' in picked) {
          const wh = whenIn(picked.text)
          if (wh) { d.when = wh; continue }
          d.when = null
          if (await change(picked.text)) continue
          continue
        }
        d.when = picked ? { kind: 'day', day: picked.day } : null
        continue
      }
      // 人・メニューを変えた：前の時間で入れるか確かめ直す。入れたら「このままでよろしいですか？」だけ。入れんかったら理由を伝えて同じ日のほかの時間
      //   【そのまま】は時間の了承だけ（予約の確定は最後の【この内容で予約する】）
      if (d.recheck && !d.at) {
        const { at, note, why } = d.recheck
        d.recheck = null
        setTyping(true)
        const plan = await planAt(at).catch(() => null)
        setTyping(false)
        if (plan) {
          const r = await askYN(`${note}${note ? '\n' : ''}${slotLabel(at)}のままでよろしいですか？`, 'そのまま', '時間を変更')
          if (r === 'yes') { d.at = at; d.plan = plan; continue }
          if (r !== 'no' && await change(r)) continue
          d.when = { kind: 'day', day: dayOf(at) }
          continue
        }
        await say(`${note}${note ? '\n' : ''}ただ、${why}、${slotLabel(at)}は${d.who.length > 1 ? '全員そろって' : ''}入れなくなってしまいました。同じ日のほかの時間をご提案しますね。`)
        d.when = { kind: 'day', day: dayOf(at) }
        continue
      }
      // 時間（人・メニュー・日が変わるたびに探し直す）
      if (!d.at) {
        setTyping(true)
        const found = await findTimes().catch(() => null)
        setTyping(false)
        if (!found) { if (await retryAfterNetwork()) continue; break }
        // 土日・最短で空きが無いとき：「いつ頃がよろしいですか？」に戻さず、広げ方をボタンで出す（11/10 慶一郎さん「よくあるAIチャット、面倒くさい」）
        if (!found.length && d.when.kind !== 'day') {
          const WEEKDAY = '平日も含めて探す', ANY = 'どちらの担当でも', PICK = 'カレンダーで選ぶ'
          const name = staffName(staffOf())
          const a = await ask(`すみません、${name ? `${name}は` : ''}${d.when.kind === 'weekend' ? '近いところの土日' : '近いところ'}に空きが無かったんです。\nどう探しましょうか？`,
            [...(d.when.kind === 'weekend' ? [{ label: WEEKDAY, strong: true }] : []), ...(staffOf() ? [{ label: ANY, strong: d.when.kind !== 'weekend' }] : []), { label: PICK }])
          if (fromChip.current && a === WEEKDAY) { d.when = { kind: 'soonest' }; continue }
          if (fromChip.current && a === ANY) { d.staff = null; continue }
          if (fromChip.current && a === PICK) { d.when = { kind: 'pick' }; continue }
          if (await change(a)) continue
          d.when = { kind: 'pick' }; continue
        }
        if (!found.length) {
          // 空きが無いとき：ご本人1人で日を決めていれば、その日のキャンセル待ちに入れる（旧画面にあった入口・11/9 Codex 検査 中）
          //   キャンセル待ちはサーバーの作りが「ご本人1人・1メニュー」なので、お連れ様と一緒のときは今までどおり
          // 担当を決めて日付を指定：その日にもう1人の担当なら空いとれば【どちらでも】も出す（11/10 Codex 検査 ④）
          const ANY = 'どちらでも'
          const anyFree = staffOf() && d.when.kind === 'day'
            ? await api.slots(d.when.day, d.menus[d.who[0].key].code).then(l => l.length > 0, () => false) : false
          const solo = d.who.length === 1 && d.who[0].key === 'me' && d.when.kind === 'day' && api.joinWaitlist
          if ((solo || anyFree) && d.when.kind === 'day') {
            const day = d.when.day, menu = d.menus[d.who[0].key]
            const WAIT = 'キャンセル待ちに入る'
            const who = staffOf() ? `${staffName(staffOf())}は` : ''
            const a = await ask(`すみません、${mdw(day)}は${who}入れる時間が無かったんです。${anyFree ? '\nもう1人の担当なら、空いていますよ。' : ''}${solo ? '\nキャンセルが出たらお知らせもできますよ。' : ''}`,
              [...(anyFree ? [{ label: ANY, strong: true }] : []), ...(solo ? [{ label: WAIT, strong: !anyFree }] : []), { label: 'ほかの日にする' }])
            if (fromChip.current && a === ANY) { d.staff = null; continue }
            if (solo && fromChip.current && a === WAIT) {
              setTyping(true)
              const r = await api.joinWaitlist(day, '00:00', '23:59', menu.code, staffOf()).catch(() => null)
              setTyping(false)
              if (!r) { await say('すみません、キャンセル待ちに入れられませんでした。通信を確かめて、もう一度お試しくださいね。'); d.when = null; continue }
              await say(`${mdw(day)}のキャンセル待ちに入れました。キャンセルが出たら、お知らせしますね。${r.has_push ? '' : '\nお知らせを受け取るには、☰ の「銀二郎のお知らせを受け取る」をオンにしてくださいね。'}`)
              return endChange()
            }
            if (!fromChip.current && await change(a)) continue
            d.when = null; continue
          }
          if (staffOf() && d.when.kind !== 'day') { if (await offerAnyStaff('近いところに')) continue; break }
          await say(d.when.kind === 'day' ? `すみません、${mdw(d.when.day)}は${d.who.length > 1 ? '全員そろって' : ''}入れる時間が無かったんです。` : d.who.length === 1 && d.who[0].key === 'me'
            ? 'すみません、近いところに空きが無かったんです。\nご希望の日を「11月20日」のように送ってもらえたら、その日のキャンセル待ちにも入れますよ。'
            : 'すみません、近いところに空きが無かったんです。ほかの日を選んでくださいね。')
          d.when = null; continue
        }
        const oneDay = found.every(f => dayOf(f.at) === dayOf(found[0].at))
        const a = await ask(oneDay ? `${mdw(dayOf(found[0].at))}は、この時間が空いていますよ。` : 'この時間が空いていますよ。', [...found.map(f => ({ label: oneDay ? hm(f.at) : slotLabel(f.at) })), { label: 'ほかの日' }])
        const hit = found.find(f => slotLabel(f.at) === a || hm(f.at) === a)
        if (hit) { d.at = hit.at; d.plan = hit.staff; continue }
        if (a === 'ほかの日') { d.when = null; continue }
        if (await change(a)) continue
        continue
      }
      if (!await canCreate(d.who)) return
      const BOOK = 'この内容で予約する'
      // 券：決める前に、お持ちの券から選んでもらう（11/10 慶一郎さん）。券はご本人のもの＝ご本人の予約があるときだけ。
      //   期限・条件は「ご来店の日時・メニュー」で判定（11/10 Codex 再検査）
      if (tickets === undefined || gachaHeld === undefined) {
        setTyping(true)
        ;[tickets, gachaHeld] = await Promise.all([loadTickets(), loadGacha().then(s => s.held ?? null, () => null)])
        setTyping(false)
      }
      const me = d.who.find(p => p.key === 'me')
      const usable = me ? usableTickets(tickets ?? [], d.at, d.menus.me.code).filter(t => (t.amount ?? 0) > 0) : []
      if (picked && !usable.some(t => t.id === picked!.id)) picked = undefined
      if (!usable.length) picked = null
      const NO_TICKET = '券を使わない'
      if (picked === undefined) {
        // 同じ券（名前・金額が同じ）は1つのボタンにまとめる
        const groups = [...new Map(usable.map(t => [`${t.title}|${t.amount}`, t])).values()]
        const label = (t: TicketRow) => groups.filter(x => x.title === t.title).length > 1 ? `${t.title}（${yen(t.amount)}）` : t.title
        const a = await ask(`お持ちの券を、このご予約で使いますか？\nご来店のときのお会計で差し引きます。`,
          [...groups.map(t => ({ label: label(t), sub: `−${yen(t.amount)}`, strong: groups.length === 1 })), { label: NO_TICKET }])
        if (fromChip.current) { picked = groups.find(t => label(t) === a) ?? null; continue }
        if (await change(a)) continue
        picked = intent(a) === 'no' ? null : groups.length === 1 && intent(a) === 'yes' ? groups[0] : longestIn(a, groups, t => t.title) ?? null
        continue
      }
      // 中身（日時・メニュー・担当・差し引き）を先に、案内を最後に
      // ガチャ券を持っているのに、このご予約では使えないときは理由を一言（期限・平日だけ・メニュー。11/10 Codex 検査 ⑤）
      //   お連れ様だけの予約：ご本人だけの券（割引・ゲージの券）なら、そのことを言う（11/10 Codex 検査 ⑤）
      const gNote = !gachaHeld || gachaFor() ? null
        : me ? gachaNote(gachaHeld, d.menus.me.code, d.at)
        : !gachaHeld.free_menu || gachaHeld.self_only ? `ガチャ券（${gachaHeld.title}）は、ご本人のご予約で使えます。`
        : gachaNote(gachaHeld, d.menus[d.who[0].key].code, d.at)
      const lines = [priceLines(), gNote ? `※${gNote}` : ''].filter(Boolean).join('\n')
      const a = await ask(`${slotLabel(d.at)}\n${summary()}${lines ? `\n\n${lines}` : ''}\n\n${hasOther ? '新しいご予約としてお取りします（今あるご予約はそのままです）。\n' : ''}こちらでよろしければ【${BOOK}】を押してください。`,
        [{ label: BOOK, strong: true }, ...(usable.length ? [{ label: '券を変える' }] : []), ...(mates.length ? [{ label: '人を変える' }] : []), { label: 'メニューを変える' }, ...(d.who.length === 1 && staffList.length > 1 ? [{ label: '担当を変える' }] : []), { label: '日にちを変える' }])
      const tapped = fromChip.current
      if (tapped && a === '券を変える') { picked = undefined; continue }
      // 担当を変える：時間はその担当の空きで選び直し（前の時間で入れるかは確かめ直す）
      if (tapped && a === '担当を変える') { d.recheck = { at: d.at, note: '', why: '担当が変わって' }; d.staff = undefined; d.at = null; d.plan = null; continue }
      if (tapped && a === '人を変える') { d.who = null; d.staff = undefined; d.at = null; d.plan = null; continue }
      if (tapped && a === 'メニューを変える') {
        const pickWho = d.who.length === 1 ? '' : await ask('どなたのメニューを変えますか？', d.who.map(x => ({ label: x.label })))
        const target = d.who.length === 1 ? d.who[0] : d.who.find(p => p.label === pickWho) ?? longestIn(pickWho, d.who, p => p.name) ?? d.who[0]
        if (d.at) d.recheck = { at: d.at, note: '', why: 'メニューが変わって施術の時間も変わるので' }
        delete d.menus[target.key]; d.at = null; d.plan = null; continue
      }
      if (tapped && a === '日にちを変える') { d.when = null; d.at = null; d.plan = null; continue }
      // 予約が入るのは【この内容で予約する】のボタンを押したときだけ。文字・声の「はい」や、「ええわ」の意味の確認では確定しない
      if (!(tapped && a === BOOK)) {
        if (await change(a)) continue
        const k = intent(a)
        const cancel = async () => {
          const again = await askYN('かしこまりました。今回はやめておきますね。', 'やっぱり予約する', 'ホームへ', false)
          return again === 'yes'
        }
        if (k === 'ambiguous') {
          // 「ええわ」だけ：その言葉のまま意味を聞く（このボタンでは予約は入らない）
          const b = await askYN(`「${a}」は、この内容でOKということですか？それとも、今回はやめておきますか？`, 'この内容でOK', '今回はやめておく')
          if (b === 'yes') { await say(`ありがとうございます！では最後に【${BOOK}】を押して、ご予約を確定してくださいね。`); continue }
          if (b !== 'no' && await change(b)) continue
          if (await cancel()) continue
          break
        }
        if (k === 'no') { if (await cancel()) continue; break }
        if (k === 'yes' || a === BOOK) { await say(`ありがとうございます！最後に【${BOOK}】を押して、ご予約を確定してくださいね。`); continue }
        continue
      }
      // 予約：1人ずつ押さえて確定（ご本人が先。お連れ様はご本人の予約につなぐ）
      if (!await canCreate(d.who)) return
      const access = await checkBookingAccess(session)
      if (access === 'closed') return
      if (access === 'retried') continue
      setTyping(true)
      const order = [...d.who].sort((x, y) => (x.key === 'me' ? -1 : y.key === 'me' ? 1 : 0))
      const done: { p: BookPerson; r: CustomerReservation | null }[] = []
      let primary: CustomerReservation | null = null
      const confirmedPeople = () => done.filter(x => x.r).map(x => x.p.label).join('と')
      for (const p of order) {
        const menu = d.menus[p.key]
        let hold: Awaited<ReturnType<typeof api.hold>>
        try {
          if (getCustomerSession() !== session) throw new Error('Booking session changed')
          hold = await api.hold(d.at, menu.code, d.plan?.[p.key] ?? null, p.id)
        } catch (error) {
          if (isBookingRejection(error, 'slot_taken')) {
            done.push({ p, r: null })
            continue
          }
          setTyping(false)
          const confirmed = confirmedPeople()
          await say(`${confirmed ? confirmed + 'のご予約は確定しました。\n' : ''}${p.label}の空き枠を押さえられませんでした。次回予約を確認してから、もう一度お試しください。`)
          return endChange()
        }
        let r: CustomerReservation
        try {
          if (getCustomerSession() !== session) throw new Error('Booking session changed')
          r = await api.confirm(hold.hold_id, p.id ? `お連れ様：${p.name}様` : null, p.id)
          if (!r?.id) throw new Error('Missing booking receipt')
        } catch (error) {
          if (isBookingRejection(error, 'slot_taken')) {
            done.push({ p, r: null })
            continue
          }
          setTyping(false)
          const confirmed = confirmedPeople()
          if (isBookingRejection(error, 'reservation_person_overlap')) {
            const prefix = confirmed ? `${confirmed}のご予約は確定しました。\n` : ''
            const person = order.length > 1 ? p.label : 'この方'
            await say(`${prefix}${person}は、その時間にすでに予約があります。変更する場合は「次回予約」からお進みください。`)
            return endChange()
          }
          if (confirmed) await say(`${confirmed}のご予約は確定しました。`)
          return checkPreviousBooking()
        }
        rememberReservation(r)
        if (!p.id) primary = r
        else if (primary) { try { await linkCompanion(primary.id, r.id) } catch { /* つながらなくても予約はそのまま */ } }
        done.push({ p, r })
      }
      // 選んだ券を予約に付ける（店のお会計・当日の会員QRに出る）。ガチャ券は使える人の予約へ（前の AI予約と同じ）
      let gachaFailed = false, ticketFailed = false
      const mine = done.find(x => x.p.key === 'me')?.r
      if (mine && picked) {
        saveCouponPlan({ date: dayOf(mine.starts_at), reservationId: mine.id, ticketIds: [picked.id] })
        ticketFailed = !(await callCustomerRpc<{ ok?: boolean; count?: number; error?: string }>('customer_set_ticket_plan', { p_reservation_id: mine.id, p_ticket_ids: [picked.id] })
          .then(r => r?.ok === true && r.count !== 0, () => false))
      }
      const gp = gachaFor()
      const gr = gp ? done.find(x => x.p.key === gp.key)?.r : undefined
      if (gr) {
        const s = await attachGacha(gr.id).catch(() => null)
        gachaFailed = s?.held?.reserved?.id !== gr.id
      }
      setTyping(false)
      const okAll = done.every(x => x.r)
      if (!done.some(x => x.r)) { await say('すみません、その時間はちょうど埋まってしまいました。時間を選び直しましょう。'); d.at = null; d.plan = null; continue }
      await say(okAll ? `ご予約を承りました！\n${slotLabel(d.at)}、お待ちしております。` : `${done.filter(x => x.r).map(x => x.p.label).join('と')}のご予約は取れました（${slotLabel(d.at)}）。\n${done.filter(x => !x.r).map(x => x.p.label).join('と')}はちょうど埋まってしまいました。お店にお電話いただけますか？`)
      // 予約が取れたことを先に、券が付かなかった案内はそのあと（11/10 確認）
      if (ticketFailed) await say(`ただ、選んだ券（${picked!.title}）を、通信の具合でご予約に付けられませんでした。ご来店のときに、お会計で券をお見せください。`)
      if (gachaFailed) await say('ガチャ券も、このご予約に付けられませんでした。券はお手元に残っていますので、ご来店のときにお会計でお見せください。'.replace(/^ガチャ券も/, ticketFailed ? 'ガチャ券も' : 'ただ、ガチャ券は'))
      setBookingComplete(okAll)
      break
    }
    setFinished(true)
    setChips([{ label: 'ホームへ', strong: true }]); setWaiting(true)
    await new Promise<string>(res => { waitRef.current = res })
    onClose()
  }

  // ── offer：キャンセル待ちのお知らせから（?hold=…）。押さえた枠を見せて、確定は【この内容で予約する】のボタンだけ（11/9）
  //   確定はほかの予約と同じ安全な入口（customer_confirm_new_reservation：同じ依頼の送り直しでも1件だけ）
  const runOffer = async (holdId: string) => {
    const session = getCustomerSession()
    if (await checkBookingAccess(session) === 'closed') return
    if (hasPendingBookingConfirmation()) return checkPreviousBooking()
    setTyping(true)
    // 期限切れと通信の不具合を分ける（503 などを「お時間が過ぎた」と言っていた・11/9 Codex 検査 中）
    const hold = await api.getHold(holdId).catch((e: unknown) => (e instanceof RpcBusinessError ? e.code : 'network'))
    setTyping(false)
    if (typeof hold === 'string') {
      await say(hold === 'already_booked' ? 'このお時間は、もうご予約済みです。「次回予約」でご確認ください。'
        : hold === 'hold_expired' || hold === 'hold_not_found' ? 'すみません、お取りしていたお時間が過ぎてしまいました。またキャンセルが出たら、お知らせしますね。'
        : 'お取りしている枠を、通信の具合で確認できませんでした。電波の良い所で、お知らせからもう一度開いてくださいね。')
      return endChange()
    }
    const BOOK = 'この内容で予約する'
    for (;;) {
      const a = await ask(`キャンセルが出ました！\n${slotLabel(hold.starts_at)} ${hold.menu_names ?? 'ご希望のメニュー'}${hold.total_price != null ? ` ${yen(hold.total_price)}` : ''}\n${hm(hold.expires_at)}までお取りしています。よろしければ、下の【${BOOK}】を押してくださいね。`,
        [{ label: BOOK, strong: true }, { label: '今回は見送る' }])
      if (!fromChip.current) { await say(`ご予約は【${BOOK}】、見送るときは【今回は見送る】を押してくださいね。`); continue }
      if (a === '今回は見送る') {
        // 外せたか確かめてから言う（503 でも「外しておきますね」と言っていた・11/9 Codex 検査 中）
        setTyping(true)
        const ok = await (hold.waitlist_id ? api.leaveWaitlist(hold.waitlist_id) : api.release(hold.hold_id)).then(() => true, () => false)
        setTyping(false)
        await say(ok ? '承知しました。キャンセル待ちを外しておきました。'
          : `すみません、通信の具合でキャンセル待ちを外せませんでした。お取りしている枠は ${hm(hold.expires_at)} に自動で外れます。`)
        return endChange()
      }
      if (a === BOOK) break
    }
    const access = await checkBookingAccess(session)
    if (access === 'closed') return
    setTyping(true)
    try {
      const r = await api.confirm(hold.hold_id)
      setTyping(false)
      rememberReservation(r)
      setBookingComplete(true)
      await say(`ご予約を承りました！\n${slotLabel(r.starts_at)} ${r.items.map(i => i.name).join('・')}\nお待ちしております。`)
    } catch (error) {
      setTyping(false)
      const code = error instanceof RpcError ? error.code : ''
      if (code === 'hold_expired' || code === 'hold_not_found') await say('すみません、お取りしていたお時間が過ぎてしまいました。')
      else if (isBookingRejection(error, 'reservation_person_overlap')) await say('その時間に、すでに別のご予約があります。今のご予約はそのままです。')
      else return checkPreviousBooking()
    }
    return endChange()
  }

  // ── change：予約の変更・キャンセル（11/8 慶一郎さん「変更先が確保できるまでは元の予約を消さない」）
  //   変更はサーバーの1つの手続き（customer_change_reservation）。確定は【この内容に変更する】、取り消しは【キャンセルする】のボタンだけ
  //   通信が切れたら同じキーで送り直し、それでも分からなければ予約の一覧を読み直して確かめる
  const endChange = async () => {
    setFinished(true)
    setChips([{ label: 'ホームへ', strong: true }])
    setWaiting(true)
    await new Promise<string>(resolve => { waitRef.current = resolve })
    onClose()
  }

  const mutationClient = () => new ReservationMutationClient(
    callCustomerRpc, localStorage, () => getStoredValue<string | null>(USER_ID_KEY, null),
  )

  const recoverMutation = async (client: ReservationMutationClient, initial: MutationReply) => {
    let reply = initial
    const session = getCustomerSession()
    while (reply.state === 'unknown' || reply.state === 'conflict') {
      const retry = reply.state === 'unknown'
      // お客様に「依頼」「確定と表示」などシステムの言葉を出さない（11/9 点検）。押す言葉と比べる所も同じ定数で
      const a = await ask('通信の具合で、さっきのお手続きが済んだか、まだ確かめられていません。\n済んだと分かるまでは、ほかの変更はせずにお待ちくださいね。', [
        { label: CHECK_DONE, strong: true }, ...(retry ? [{ label: SEND_AGAIN }] : []), { label: 'あとで確認する' },
      ])
      if (!fromChip.current) continue
      if (a === 'あとで確認する') return reply
      const resend = a === SEND_AGAIN && retry && !!client.pending()
      if (resend) {
        const access = await checkBookingAccess(session)
        if (access === 'closed') return reply
        if (access === 'retried') continue
      }
      setTyping(true)
      const checked = resend && client.pending() ? await client.send() : await client.check()
      if (retry || checked.state !== 'unknown') reply = checked
      setTyping(false)
    }
    return reply
  }

  const showMutationResult = async (reply: MutationReply) => {
    if (reply.state === 'completed') {
      const { request, result } = reply
      forgetReservation(request.reservation_id)
      if (request.kind === 'cancel') {
        const released = result.ginpay_released ?? 0
        await say(`キャンセルしました。${released > 0 ? `\n銀Payの先払い ${yen(released)} は残高に戻しました。` : ''}`)
      } else {
        rememberReservation(result)
        await say(`ご予約を変更しました！\n${slotLabel(result.starts_at)} ${result.items.map(i => i.name).join('・')}${result.ai_paused_until ? `\n※AI予約は ${md(result.ai_paused_until)} から、また使えます。` : ''}`)
      }
    } else if (reply.state === 'rejected') {
      await say(reply.code === 'call_shop' ? '開始の30分前を過ぎたので、変更・キャンセルはお電話でお願いします。'
        : reply.code === 'conditions_changed' ? CHANGED_AFTER_REVIEW
        : reply.code === 'reservation_person_overlap' ? 'この方は、その時間にすでに別の予約があります。今のご予約はそのままです。'
        : 'お手続きができませんでした。今のご予約はそのままです。「次回予約」でご確認くださいね。')
    }
  }

  const checkPreviousBooking = async () => {
    while (hasPendingBookingConfirmation()) {
      const a = await ask('通信の具合で、さっきのご予約が取れたか、まだ確かめられていません。', [
        { label: CHECK_BOOKED, strong: true }, { label: 'あとで確認する' },
      ])
      if (!fromChip.current) continue
      if (a === 'あとで確認する') return endChange()
      if (a !== CHECK_BOOKED) continue
      try {
        const result = await recoverBookingConfirmation()
        if (result) {
          rememberReservation(result)
          await say(`ご予約を承りました！\n${slotLabel(result.starts_at)} ${result.items.map(item => item.name).join('・')}`)
          return endChange()
        }
      } catch { /* Keep the saved request until the server returns its result. */ }
    }
    await say('さっきのご予約は見つかりませんでした。「次回予約」でご確認くださいね。')
    return endChange()
  }

  const runChange = async (reservationId?: string) => {
    const session = getCustomerSession()
    if (await checkBookingAccess(session) === 'closed') return
    const client = mutationClient()
    const all = menusRef.current
    const opts = await api.options().catch(() => null)
    const maintMenu = opts?.menus.find(m => m.code === 'maintenance') as Menu | undefined
    const people = await fetchPeople().catch(() => null)
    const end = endChange
    const reservations = await api.reservations().catch(() => null)
    if (!Array.isArray(reservations)) {
      await say('ご予約を確認できませんでした。通信を確認して、「変更・キャンセル」を開き直してください。')
      return end()
    }
    const list = reservations.filter(r => r.status === 'confirmed' && isUpcoming(r)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    if (!list.length) { await say('今は、変更できるご予約がありません。'); return end() }
    const who = (r: CustomerReservation) => (r.companion_name ? `${honor(r.companion_name)}の` : '')
    const label = (r: CustomerReservation) => `${r.companion_name ? honor(r.companion_name) + '：' : ''}${slotLabel(r.starts_at)} ${r.items.map(i => i.name).join('・')}`
    const requested = reservationId ? list.find(candidate => candidate.id === reservationId) : null
    if (reservationId && !requested) {
      await say('指定のご予約は変更できません。次回予約をご確認ください。')
      return end()
    }
    let r = requested ?? list[0]
    if (!requested && list.length > 1) {
      const choices = list.map((x, i) => ({ label: `${i + 1}. ${label(x)}` }))
      for (;;) {
        const a = await ask('ご予約の変更ですね！どのご予約にしますか？', choices)
        const index = choices.findIndex(x => x.label === a)
        if (fromChip.current && index >= 0) { r = list[index]; break }
      }
    }
    // 開始30分前を切ったら、お電話
    if (Date.parse(r.starts_at) < Date.now() + 30 * 60000) {
      const a = await askYN('開始の30分前を過ぎているので、変更・キャンセルはお電話でお願いします。', 'お店に電話する', 'ホームへ', false)
      if (a === 'yes') window.location.href = SHOP_PHONE_TEL
      return end()
    }
    const person = r.companion_id ? people?.companions.find(c => c.id === r.companion_id) ?? null : people?.owner ?? null
    const whoArg: Who = r.companion_id ? { kind: 'mate', id: r.companion_id, name: r.companion_name ?? '' } : { kind: 'me' }
    let menu: Menu | null = all.find(m => m.code === r.items[0]?.menu_code) ?? (r.items[0]?.menu_code === 'maintenance' ? maintMenu ?? null : null)
    const originalCodes = reservationMenuCodes(r)
    let menuCodes = originalCodes
    let at = r.starts_at
    const sameMenus = () => menuCodes.length === originalCodes.length && menuCodes.every((code, i) => code === originalCodes[i])
    const forPerson = (c?: Confirmation) => c?.old?.id === r.id && c.old.companion_id === (r.companion_id ?? null)
    const reviewedLabel = (c: Confirmation) => `${slotLabel(c.old.starts_at)} ${c.old.items.map(i => i.name).join('・')}`
    const endWithoutAvailability = async () => {
      await say('空き状況を確認できませんでした。通信を確認して、「変更・キャンセル」を開き直してください。')
      await end()
    }
    const changeSlots = async (day: string) => {
      const l = await callCustomerRpc<{ starts_at: string }[]>('customer_change_slots', { p_reservation_id: r.id, p_date: day, p_menu_codes: menuCodes }).catch(() => null)
      return Array.isArray(l) ? l.map(x => x.starts_at) : null
    }
    const changeDays = async (days: number, weekend: boolean) => {
      const from = todayJst()
      const chunks = Array.from({ length: Math.ceil(days / 7) }, (_, i) => addDays(from, i * 7))
      const results = await Promise.all(chunks.map(d => callCustomerRpc<string[]>('customer_change_open_days', {
        p_reservation_id: r.id, p_menu_codes: menuCodes, p_from: d, p_to: addDays(d, 6), p_weekend: weekend,
      }).catch(() => null)))
      if (!results.every(Array.isArray)) return null
      return results.flat().filter(d => typeof d === 'string' && d < addDays(from, days))
    }
    let action = await ask(`ご予約の変更ですね！\n${label(r)}\nどちらを変更されますか？`, [{ label: '日時を変更', strong: true }, { label: 'メニューを変更' }, { label: 'キャンセル' }])
    let dayOnly: string | null = null
    for (let guard = 0; guard < 24; guard++) {
      // キャンセル
      if (/キャンセル|取り消/.test(action)) {
        const pv = await callCustomerRpc<{ confirmation: Confirmation; cancel_late: boolean; ginpay_before: number }>(
          'customer_cancel_preview', { p_reservation_id: r.id },
        ).catch((e: unknown) => ({ error: e instanceof RpcError ? e.code : 'network' } as const))
        if ('error' in pv || !forPerson(pv.confirmation)) {
          await say('error' in pv && pv.error === 'call_shop' ? '開始の30分前を過ぎたので、キャンセルはお電話でお願いします。' : 'ご予約の内容を確認できませんでした。')
          return end()
        }
        const late = pv.cancel_late
        const gp = pv.ginpay_before
        const a = await ask(`${who(r)}${reviewedLabel(pv.confirmation)}\nのご予約をキャンセルしますか？${late ? '\n※開始2時間前を過ぎているので、キャンセルすると AI予約がしばらく使えなくなります。' : ''}${gp > 0 ? `\n銀Payの先払い ${yen(gp)} は残高に戻ります。` : ''}\nキャンセルする場合は、下の【キャンセルする】を押してください。`,
          [{ label: 'キャンセルする', strong: true }, { label: 'やめておく' }])
        if (!(a === 'キャンセルする' && fromChip.current)) {
          // 「キャンセルして」「キャンセルお願い」はキャンセルしたいという意味（確定はボタンだけ）
          const wantCancel = a === 'キャンセルする' || /^(キャンセル|取り消)(して|する|します|お願い|で)/.test(a.normalize('NFKC').replace(/\s/g, '')) || intent(a) === 'yes'
          if (!wantCancel && a !== 'やめておく' && intent(a) !== 'no') { action = a; continue }
          if (wantCancel) { await say('ありがとうございます。キャンセルする場合は、下の【キャンセルする】のボタンを押してくださいね。'); continue }
          await say('かしこまりました。ご予約はそのままです。'); return end()
        }
        const access = await checkBookingAccess(session)
        if (access === 'closed') return
        if (access === 'retried') continue
        client.begin({ kind: 'cancel', reservation_id: r.id, starts_at: null, menu_codes: [], confirmation: pv.confirmation })
        setTyping(true)
        const first = await client.send()
        setTyping(false)
        const reply = await recoverMutation(client, first)
        if (reply.state === 'rejected' && reply.code === 'conditions_changed') {
          await say(CHANGED_RETRY)
          continue
        }
        await showMutationResult(reply)
        return end()
      }
      // メニューを変更
      if (/メニュー/.test(action) && !/日時|日にち/.test(action)) {
        const maintOk = !!person?.maintenance_ok && !!maintMenu
        const usual = person?.menu_code ? all.find(m => m.code === person.menu_code) ?? null : null
        const chips: Chip[] = [...(usual && usual.code !== menu?.code ? [{ label: usual.name, sub: yen(usual.price) }] : []), ...(maintOk && menu?.code !== 'maintenance' ? [{ label: 'メンテナンスカット', sub: person?.days_left != null ? `あと${person.days_left}日` : undefined }] : []), { label: 'ほかのメニュー' }]
        const a = await ask(`${who(r)}何のメニューに変更されますか？`, chips)
        const next = a === 'メンテナンスカット' || /メンテ/.test(a) ? maintMenu ?? null : usual && a === usual.name ? usual
          : (all.find(m => m.name === a) ?? longestIn(a, all, m => m.name)) ?? await hearMenu(whoArg, '何のメニューにされますか？', null)
        if (!next) { action = '日時を変更'; continue }
        menu = next
        menuCodes = [next.code]
        setTyping(true)
        const free = await changeSlots(dayOf(at))
        setTyping(false)
        if (!free) return endWithoutAvailability()
        if (free.some(time => Date.parse(time) === Date.parse(at))) {
          const k = await askYN(`「${menu.name}」に変更しますね。\n${slotLabel(at)}のままでよろしいですか？`, 'そのまま', '時間を変更')
          if (k === 'yes') { action = 'summary'; continue }
          dayOnly = dayOf(at); action = '時間'; continue
        }
        await say(`「${menu.name}」に変更しますね。\nただ、メニューが変わって施術の時間も変わるので、${slotLabel(at)}は入れなくなってしまいました。同じ日のほかの時間をご提案しますね。`)
        dayOnly = dayOf(at); action = '時間'; continue
      }
      // 日時を変更（いつ頃 → 日 → 時間）
      if (/日時|日にち|時間|いつ|土|日曜|最短/.test(action) && action !== 'summary') {
        if (!menuCodes.length) { await say('すみません、このご予約のメニューが分からないので、お店にお電話いただけますか？'); return end() }
        let days: string[]
        if (dayOnly) { days = [dayOnly]; dayOnly = null }
        else {
          const w = /土|日曜|週末/.test(action) && !/日時|日付/.test(action) ? action : await ask('ご来店は、いつ頃がよろしいですか？', [{ label: '最短で', strong: true }, { label: '土日希望' }, { label: '日付を選ぶ' }])
          if (/日付|カレンダー|選ぶ/.test(w)) {
            setTyping(true); const open = await changeDays(63, false); setTyping(false)
            if (!open) return endWithoutAvailability()
            if (!open.length) { await say('すみません、しばらく空きが無いんです。お店にお電話いただけますか？'); return end() }
            await say('空いている日だけ、押せるようにしています。')
            const picked = await pickDate(open); if (!picked) continue
            const typed = 'text' in picked ? dateIn(picked.text) : picked.day
            if (!typed) { action = 'text' in picked ? picked.text : action; continue }
            days = [typed]
          } else {
            const weekend = /土|日曜|週末/.test(w)
            setTyping(true); const open = await changeDays(weekend ? 42 : 21, weekend); setTyping(false)
            if (!open) return endWithoutAvailability()
            days = open.slice(0, 4)
            if (/土曜/.test(w) && !/日曜/.test(w)) days = days.filter(x => dow(x) === '土')
          }
        }
        setTyping(true)
        let times: string[] = []
        for (const d of days) {
          const free = await changeSlots(d)
          if (!free) { setTyping(false); return endWithoutAvailability() }
          times = [...times, ...spreadSlots(free.map(s => ({ starts_at: s })), days.length === 1 ? 6 : 2).map(s => s.starts_at)]
          if (times.length >= 4) break
        }
        setTyping(false)
        times = times.filter(t => Date.parse(t) !== Date.parse(r.starts_at) || !sameMenus()).slice(0, 6)
        if (!times.length) { await say('すみません、その日は空きが無かったんです。ほかの日にしてみましょう。'); action = '日時を変更'; continue }
        const oneDay = times.every(t => dayOf(t) === dayOf(times[0]))
        const a = await ask(oneDay ? `${mdw(dayOf(times[0]))}は、この時間が空いていますよ。` : 'この時間が空いていますよ。', [...times.map(t => ({ label: oneDay ? hm(t) : slotLabel(t) })), { label: 'ほかの日' }])
        const hit = times.find(t => slotLabel(t) === a || hm(t) === a)
        if (!hit) { action = a === 'ほかの日' ? '日時を変更' : a; continue }
        at = hit; action = 'summary'; continue
      }
      if (action !== 'summary' && /担当|指名|スタイリスト/.test(action)) {
        // 予約の変更では担当は変えられない（指名はそのまま）。担当を変えたいときはお店へ（11/10・サーバーの変更に担当の指定が無い）
        const a = await askYN('ご予約の変更では、担当はそのままになります。\n担当を変えたいときは、お手数ですがお店にお電話ください。', 'お店に電話する', '日時・メニューを変える', false)
        if (a === 'yes') { window.location.href = SHOP_PHONE_TEL; return end() }
        action = '日時を変更'; continue
      }
      if (action !== 'summary') {
        // 分からない言葉：もう一度どれを変えるか聞く
        action = await ask('どちらを変更されますか？', [{ label: '日時を変更', strong: true }, { label: 'メニューを変更' }, { label: 'キャンセル' }])
        continue
      }
      // まとめて確認：変更前と変更後・料金・銀Pay・外れる券・直前の扱い
      if (!menuCodes.length) { await say('すみません、このご予約のメニューが分からないので、お店にお電話いただけますか？'); return end() }
      setTyping(true)
      const pv = await callCustomerRpc<{ error?: string; kind: string; confirmation: Confirmation; menu_names: string[]; duration_after: number; late_penalty: boolean; price_before: number | null; price_after: number | null; slot_ok: boolean;
        ginpay_before: number; ginpay_after: number; tickets_drop: { title: string; why: string }[]; gacha: { title: string; keep: boolean; why: string | null } | null }>('customer_change_preview',
        { p_reservation_id: r.id, p_starts_at: at, p_menu_codes: menuCodes }).catch((e: unknown) => ({ error: e instanceof RpcError ? e.code : 'network' } as never))
      setTyping(false)
      if (pv.error === 'call_shop') { await say('開始の30分前を過ぎたので、変更はお電話でお願いします。'); return end() }
      if (pv.error) { await say('すみません、確認できませんでした。もう一度やってみましょう。'); action = '日時を変更'; continue }
      if (!pv.slot_ok) { await say(`すみません、${slotLabel(at)}はちょうど埋まってしまいました。ほかの時間を選びましょう。`); dayOnly = dayOf(at); action = '時間'; continue }
      if (!forPerson(pv.confirmation) || !pv.menu_names?.length) { await say('ご予約の内容を確認できませんでした。'); return end() }
      if (sameMenus() && (pv.confirmation.old.items.length !== originalCodes.length || pv.confirmation.old.items.some((item, i) => item.menu_code !== originalCodes[i]))) {
        await say('元のご予約のメニューが変わっています。変更・キャンセルを開き直して、最新のご予約をご確認ください。')
        return end()
      }
      const why = (w: string) => (w === 'expired' ? '期限が切れるので' : w === 'weekday' ? '平日だけの券なので' : w === 'menu' ? 'このメニューでは使えないので' : w === 'owner_only' ? 'ご本人だけの券なので' : w === 'owner_changed' ? '券の持ち主が変わったので' : '使えないので')
      // 担当も出す（11/10 慶一郎さん「スタイリストの指名がねーよ！」）。指名の予約は、変更しても同じ担当のまま（サーバーがその担当の空きで探す）
      const nw = (pv.confirmation as { new?: { staff_id?: string | null; nominated?: boolean } }).new
      const staffAfter = opts?.staff?.find(s => s.id === nw?.staff_id)?.name ?? ''
      const staffLine = nw?.nominated
        ? `担当：${r.staff_name || staffAfter}（ご指名のまま）`
        : staffAfter ? `担当：${staffAfter}${r.staff_name && r.staff_name !== staffAfter ? `（${r.staff_name}から変わります）` : ''}` : ''
      const lines = [
        `変更前：${reviewedLabel(pv.confirmation)}${pv.price_before != null ? ` ${yen(pv.price_before)}` : ''}`,
        `変更後：${slotLabel(at)} ${pv.menu_names.join('・')}（${pv.duration_after}分）${pv.price_after != null ? ` ${yen(pv.price_after)}` : ''}`,
        ...(staffLine ? [staffLine] : []),
        ...(pv.ginpay_before > 0 ? [`銀Payの先払い：${yen(pv.ginpay_before)} → ${yen(pv.ginpay_after)}${pv.ginpay_after < pv.ginpay_before ? `（${yen(pv.ginpay_before - pv.ginpay_after)} は残高に戻ります）` : ''}`] : []),
        ...(pv.ginpay_before > 0 && pv.price_after != null && pv.price_after > pv.ginpay_after ? [`残りの ${yen(pv.price_after - pv.ginpay_after)} は、お店でお支払いください`] : []),
        ...pv.tickets_drop.map(t => `※「${t.title}」は${why(t.why)}、外れます`),
        ...(pv.gacha && !pv.gacha.keep ? [`※ガチャ券「${pv.gacha.title}」は${why(pv.gacha.why ?? '')}、このご予約からは外れます（券はお手元に残ります）`] : []),
        ...(pv.late_penalty ? ['※開始2時間前を過ぎての日時の変更なので、キャンセルと同じく、AI予約がしばらく使えなくなります'] : []),
      ]
      const BTN = 'この内容に変更する'
      const a = await ask(`${who(r)}ご予約をこのように変更します。よろしければ、下の【${BTN}】を押してくださいね。\n${lines.join('\n')}`,
        [{ label: BTN, strong: true }, { label: '日時を変更' }, { label: 'メニューを変更' }, { label: 'やめておく' }])
      if (!(a === BTN && fromChip.current)) {
        if (a === 'やめておく' || intent(a) === 'no') { await say('かしこまりました。ご予約はそのままです。'); return end() }
        if (a === BTN || intent(a) === 'yes') { await say(`ありがとうございます！最後に【${BTN}】を押して、変更を確定してくださいね。`); continue }
        if (intent(a) === 'ambiguous') { await say(`「${a}」は、この内容でOKということですか？よろしければ【${BTN}】を、やめるときは【やめておく】を押してくださいね。`); continue }
        action = a; continue
      }
      const access = await checkBookingAccess(session)
      if (access === 'closed') return
      if (access === 'retried') continue
      client.begin({ kind: 'change', reservation_id: r.id, starts_at: at, menu_codes: menuCodes, confirmation: pv.confirmation })
      setTyping(true)
      const first = await client.send()
      setTyping(false)
      const reply = await recoverMutation(client, first)
      if (reply.state === 'rejected' && reply.code === 'conditions_changed') {
        await say(CHANGED_RETRY)
        continue
      }
      if (reply.state === 'rejected' && reply.code === 'slot_taken') {
        await say('その時間は埋まりました。ほかの時間を選んでください。')
        dayOnly = dayOf(at); action = '時間'; continue
      }
      if (reply.state === 'rejected' && reply.code === 'reservation_person_overlap') {
        await say('この方は、その時間にすでに別の予約があります。今のご予約はそのままです。ほかの時間を選んでください。')
        dayOnly = dayOf(at); action = '時間'; continue
      }
      await showMutationResult(reply)
      return end()
    }
    await say('また変更したいときは、いつでも声をかけてくださいね。')
    return end()
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      if (getStoredValue<string | null>(USER_ID_KEY, null)) {
        const client = mutationClient()
        if (client.pending()) {
          await showMutationResult(await recoverMutation(client, await client.check()))
          return endChange()
        }
      }
      const opts = await api.options().catch(() => null)
      menusRef.current = opts ? usualMenuOrder(opts.menus.filter(m => canBeUsual(m.code))) as Menu[] : []
      if (mode.kind === 'welcome') await runWelcome(mode.pending)
      else if (mode.kind === 'change') await runChange(mode.reservationId)
      else if (mode.kind === 'offer') await runOffer(mode.holdId)
      else { await say('いらっしゃいませ。ご予約ですね。'); await runBook(null, { menuCode: mode.menuCode, label: mode.label }, true) }
    })().catch(async () => {
      setTyping(false)
      await say('すみません、うまく続けられませんでした。ご予約が取れたか・変わったかは「次回予約」でご確認くださいね。')
      await endChange()
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 開いたときに1回だけ

  // ガイド（「？」）の目印：いま銀ちゃんが何を聞いているか（who・menu・when・time・confirm・yesno・free・done）
  const askKind = finished && chips.some(c => c.label === 'ホームへ') ? (bookingComplete ? 'done' : 'ended')
    : chips.some(c => c.label === '会員QRを表示') ? 'verify'
    : chips.some(c => c.label === 'この内容で予約する') ? 'confirm'
    : chips.some(c => c.label === '最短で') ? 'when'
    : chips.some(c => c.label === 'ご本人だけ') ? 'who'
    : chips.some(c => /\d\d:\d\d$/.test(c.label)) ? 'time'
    : chips.some(c => c.label === '一覧から選ぶ' || c.label === 'ほかのメニュー') ? 'menu'
    : chips.length === 2 ? 'yesno' : chips.length ? 'choice' : waiting ? 'free' : 'wait'
  const send = () => { const t = text.trim(); if (!t || !waiting) return; setText(''); fromChip.current = false; answer(t) }
  const shown = sheet ? (showAll ? sheet : sheet.slice(0, 7)) : null
  const dockGuide = !sheet && ['who', 'menu', 'when', 'time', 'confirm'].includes(askKind)

  return (
    <div ref={chatRef} role="dialog" aria-modal="true" aria-label="銀ちゃん" className="v2 gc lc" data-guide="lc" data-ask={askKind}>
      <header className="lc-head">
        <p className="lc-head-name">銀ちゃん</p>
        <button type="button" className="gc-icon lc-close" aria-label={finished ? '閉じる' : 'あとで'} onClick={onClose}><X size={20} /></button>
      </header>
      <div className="gc-log lc-log" ref={logRef} aria-live="polite">
        {msgs.map((m, i) => {
          if (m.from === 'cal') return <LcCalendar key={m.id} open={m.open} first={m.first} last={m.last} onPick={d => { calRef.current?.(d); calRef.current = null }} />
          const head = m.from === 'gin' && msgs[i - 1]?.from !== 'gin'
          return m.from === 'gin' ? (
            <motion.div key={m.id} className={head ? 'lc-row lc-row-head' : 'lc-row'}
              initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}>
              {head ? <img className="lc-avatar" src="/guide/gin-avatar.png" alt="" /> : <span className="lc-avatar-gap" />}
              <div className="lc-col">{head && <p className="lc-name">銀ちゃん</p>}<p className="gc-msg gc-gin">{m.text}</p></div>
            </motion.div>
          ) : (
            <motion.p key={m.id} className="gc-msg gc-you" initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>{m.text}</motion.p>
          )
        })}
        {typing && <div className="lc-row"><span className="lc-avatar-gap" /><p className="gc-msg gc-gin gc-typing" aria-label="銀ちゃんが考えています"><i /><i /><i /></p></div>}
      </div>
      <div className="lc-dock">
        {/* ボタンの列の上には指さしの子を出さない：真ん中に立つと、たまたま真ん中のボタンを指して見える（11/9 慶一郎さん）。
            カレンダー・メニュー一覧の上（面全体）には出す */}
        {chips.length > 0 && (
          <motion.div className={dockGuide ? 'gc-chips lc-chips lc-guided-chips' : 'gc-chips lc-chips'} data-guide="lc-chips" data-ask={askKind} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduce ? 0 : 0.22 }}>
            {chips.map(c => (
              <button key={c.label} type="button" className={c.strong ? 'gc-chip gc-chip-strong' : 'gc-chip'} data-guide={c.label === 'この内容で予約する' ? 'lc-book' : undefined} onClick={() => { fromChip.current = true; answer(c.label) }}>
                {c.label}{c.sub && <small>{c.sub}</small>}
              </button>
            ))}
            {chips.some(c => c.label === '一覧から選ぶ') && <a className="gc-chip lc-link" href={HOTPEPPER_MENU_URL} target="_blank" rel="noopener noreferrer">HOT PEPPER</a>}
          </motion.div>
        )}
        <form data-guide="lc-input" className={waiting ? 'gc-lens gc-composer' : 'gc-lens gc-composer gc-composer-off'} onSubmit={e => { e.preventDefault(); send() }}>
          {voice.listen !== 'unsupported' && voice.listen !== 'denied' && (
            <button type="button" data-guide="lc-mic" className={listening ? 'lc-mic lc-mic-on' : 'lc-mic'} disabled={!waiting} aria-label={listening ? '話し終わった' : '声で話す'}
              onClick={() => (listening ? voice.finishListening() : voice.startListening())}><Mic size={19} /></button>
          )}
          <input value={listening ? voice.interim || '聞いています…' : text} onChange={e => setText(e.target.value)} readOnly={listening}
            placeholder={waiting ? 'メッセージを入力' : '銀ちゃんが入力中…'} disabled={!waiting} maxLength={60} enterKeyHint="send" autoComplete="off" aria-label="銀ちゃんへの返事" />
          <button type="submit" className="gc-send" disabled={!text.trim() || !waiting || listening} aria-label="送る"><ArrowUp size={18} strokeWidth={2.4} /></button>
        </form>
      </div>

      <AnimatePresence>
        {sheet && (
          <>
            <motion.div key="back" className="gc-sheet-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => { setSheet(null); setShowAll(false); sheetRef.current?.(null); sheetRef.current = null }} />
            <motion.div key="sheet" className="gc-sheet" role="dialog" aria-label="メニューを選ぶ"
              initial={reduce ? false : { y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: reduce ? 0 : 40, opacity: 0 }} transition={{ duration: reduce ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}>
              <div className="gc-grab" />
              <GinNavigationMark step="menu-list" />
              <p className="gc-sheet-title">メニューを選ぶ</p>
              <div className="gc-menu">
                {shown?.map(m => (
                  <button key={m.code} type="button" onClick={() => { setSheet(null); setShowAll(false); sheetRef.current?.(m); sheetRef.current = null }}>
                    <span>{m.name}</span><small>{yen(m.price)}</small><ChevronRight size={16} aria-hidden="true" />
                  </button>
                ))}
                {sheet.length > 7 && !showAll && <button type="button" className="gc-more" onClick={() => setShowAll(true)}>ほかのメニューを見る（{sheet.length - 7}）</button>}
              </div>
              <a className="gc-quiet gc-sheet-link" href={HOTPEPPER_MENU_URL} target="_blank" rel="noopener noreferrer">HOT PEPPER Beauty で写真を見る</a>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

function GinNavigationMark({ step }: { step: string }) {
  return <span className="lc-guide-mark" data-gin-nav={step} aria-hidden="true">
    <img src="/guide/chibi-squat.png" alt="" />
  </span>
}

/** 会話の中のカレンダー：年月・曜日は暦どおり計算。空きのある日だけ押せる */
function LcCalendar({ open, first, last, onPick }: { open: string[]; first: string; last: string; onPick: (d: string | null) => void }) {
  const reduce = useReducedMotion()
  const [month, setMonth] = useState(first.slice(0, 7))
  const set = new Set(open)
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)]
  const shift = (n: number) => setMonth(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7))
  const canPrev = month > first.slice(0, 7), canNext = month < last.slice(0, 7)
  return (
    <motion.div className="gc-lens lc-cal" data-guide="lc-cal" initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduce ? 0 : 0.24 }}>
      <GinNavigationMark step="calendar" />
      <div className="lc-cal-head">
        <button type="button" aria-label="前の月" disabled={!canPrev} onClick={() => shift(-1)}><ChevronLeft size={20} /></button>
        <b>{y}年{m}月</b>
        <button type="button" aria-label="次の月" disabled={!canNext} onClick={() => shift(1)}><ChevronRight size={20} /></button>
      </div>
      <div className="lc-cal-grid">
        {WEEK.split('').map((w, i) => <span key={w} className={i === 0 ? 'lc-sun' : i === 6 ? 'lc-sat' : undefined}>{w}</span>)}
        {cells.map((d, i) => d
          ? <button key={d} type="button" disabled={!set.has(d)} onClick={() => onPick(d)} aria-label={`${md(d)}（${dow(d)}）`}>{Number(d.slice(8, 10))}</button>
          : <span key={`e${i}`} />)}
      </div>
    </motion.div>
  )
}
