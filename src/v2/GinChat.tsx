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
import { bookingAssistantApi, linkCompanion, type CustomerReservation } from '../features/johnny/bookingAssistantApi'
import { matchMenu } from '../features/johnny/menuMatcher'
import { canBeUsual, setUsualMenu, usualMenuOrder } from '../features/johnny/usualMenu'
import { fetchPeople, MAX_COMPANIONS, saveCompanion, setOwnerMaintenance, type People, type Person } from '../features/johnny/usualMembers'
import { askUsualAi } from '../features/johnny/usualAi'
import { askAgentVoice, type AgentTurn } from '../features/johnny/agentClient'
import { useVoice } from '../features/johnny/useVoice'
import { JohnnyRider } from '../features/johnny/JohnnyRider'
import { spreadSlots } from '../features/johnny/dayAdvisor'
import { forgetReservation, isUpcoming, rememberReservation } from '../features/johnny/nextReservation'
import { callCustomerRpc } from '../utils/customerSession'
import { usableTickets } from '../utils/bookingCoupons'
import type { TicketRow } from '../data/ticket'
import type { PendingVisits as Pending, PendingVisit as Visit } from './visitConfirm'

type Menu = { code: string; name: string; duration_min: number; price: number | null; maintenance?: boolean }
type Who = { kind: 'me' } | { kind: 'mate'; id: string | null; name: string }
type Chip = { label: string; sub?: string; strong?: boolean }
type Msg = { id: number; from: 'gin' | 'you'; text: string } | { id: number; from: 'cal'; open: string[]; first: string; last: string }
export type GinMode = { kind: 'welcome'; pending: Pending } | { kind: 'book' }

const HOTPEPPER_MENU_URL = 'https://beauty.hotpepper.jp/slnH000583749/coupon/'
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
  if (/^(はい|うん|ほうよ|ほうじゃ|せや|そう(です)?|了解|りょうかい|ok|okです|オッケー|おけ|お願い(します)?|おねがい(します)?|それで(ええ|えー|いい)?(わ|よ|で|です)?|それでお願い(します)?|それにする|予約(して|する|します|お願い(します)?))$/.test(s)) return 'yes'
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

/** 空きのある日（今の予約エンジンで判定）。1週間ずつ並べて調べる（1回で長く調べると時間切れになる） */
async function openDays(menuCode: string, from: string, days: number, weekend: boolean): Promise<string[]> {
  const chunks = Array.from({ length: Math.ceil(days / 7) }, (_, i) => addDays(from, i * 7))
  const parts = await Promise.all(chunks.map(d => callCustomerRpc<string[]>('customer_open_days',
    { p_menu_codes: [menuCode], p_from: d, p_to: addDays(d, 6), p_staff_id: null, p_weekend: weekend }).catch(() => [] as string[])))
  return [...new Set(parts.flat())].sort()
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
  const nextId = useRef(1)
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
  const pickDate = async (open: string[]): Promise<string | null> => {
    const id = nextId.current++
    const first = open[0] ?? todayJst(), last = open[open.length - 1] ?? first
    setMsgs(m => [...m, { id, from: 'cal', open, first, last }])
    const d = await new Promise<string | null>(res => { calRef.current = res })
    setMsgs(m => m.filter(x => x.id !== id))
    if (d) push('you', mdw(d))
    return d
  }

  // ── 声：サーバーで文字にして、同じ会話へ（AI予約と同じしくみ） ──
  const onAudio = useCallback((audio: Blob) => {
    setTyping(true)
    void askAgentVoice(audio, [], undefined, true).then(r => { setTyping(false); if (r?.heard) { fromChip.current = false; answer(r.heard) } })
  }, [answer])
  const heardText = useCallback((t: string) => { fromChip.current = false; answer(t) }, [answer])
  const voice = useVoice(heardText, { server: api.serverVoice, onAudio, aiVoice: false })
  const listening = voice.listen === 'listening'

  /** メニューを聞く：AI が相談に乗る。決まったら名前と料金で確かめる（「ちがう」は何が違うか聞き直す・同じものを押しつけない） */
  const hearMenu = async (who: Who, opener: string, visitDate: string | null): Promise<Menu | null> => {
    const all = menusRef.current
    const rejected = new Set<string>()
    let line = opener
    let sugg: Menu[] = []
    for (let turn = 0; turn < 14; turn++) {
      const t = await ask(line, [...sugg.map(m => ({ label: m.name, sub: yen(m.price) })), { label: '一覧から選ぶ' }])
      let menu: Menu | null = sugg.find(m => m.name === t) ?? null
      if (!menu && t === '一覧から選ぶ') { menu = await pickFromList(); if (menu) push('you', menu.name); else { line = 'では、お話しして決めましょうか。どんなことでも、ええですよ。'; sugg = []; continue } }
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
      menu = await hearMenu(who, `${greet}${md(v.date)}はメンテナンスカットでしたね！\n${name}いつもは、何のメニューにされとりますか？`, null)
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
  const tips = async (owner: Person | null | undefined) => {
    try {
      const tickets = await callCustomerRpc<TicketRow[]>('customer_get_tickets')
      const usable = usableTickets(tickets ?? [], new Date().toISOString()).filter(t => t.type === 'discount' && (t.amount ?? 0) > 0)
      if (usable.length) {
        const best = Math.max(...usable.map(t => t.amount ?? 0))
        await say(usable.length === 1 ? `今、${best.toLocaleString('ja-JP')}円の割引券をお持ちですよ。次のご予約で使えますけぇね。` : `割引券を${usable.length}枚お持ちですよ（いちばん大きいのは${best.toLocaleString('ja-JP')}円）。次のご予約で使えますけぇね。`)
      }
    } catch { /* 券が読めんときは案内しない */ }
    if (owner?.maintenance_ok && owner.days_left != null) await say(owner.days_left === 0 ? 'メンテナンスカットは今日までですけぇ、よかったらどうぞ。' : `メンテナンスカットは、あと${owner.days_left}日ご利用いただけますよ。`)
  }

  // ── welcome：店頭の QR のあと ──
  const runWelcome = async (pending: Pending) => {
    let people: People | null = await fetchPeople().catch(() => null)
    let greet = 'よう来んさったのぉ！\n'
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
    if (count === 0) {
      let a = await askYN('お連れ様も登録できますよ。どうされますか？', '登録する', '今はしない')
      while (a === 'yes' && count < MAX_COMPANIONS) {
        const n = await ask('お名前を教えてください。お店でお呼びするお名前で大丈夫ですよ。', [])
        const name = n.slice(0, 20)
        const menu = await hearMenu({ kind: 'mate', id: null, name }, `${honor(name)}は、いつも何のメニューにされとりますか？`, null)
        if (menu) {
          const m = await askMaintenance({ kind: 'mate', id: null, name }, menu)
          try { people = await saveCompanion(null, name, menu.code, m); count++; await say(`${honor(name)}も登録しました！`) }
          catch { await say('すみません、うまく登録できませんでした。あとで ☰ からも登録できますけぇね。'); break }
        }
        if (count >= MAX_COMPANIONS) break
        a = await askYN('ほかにも、ご一緒に来られる方はいらっしゃいますか？', '登録する', 'もうおらん')
      }
    }
    await tips(people?.owner)
    const next = await askYN('準備ができました！このまま次のご予約もできますよ。', '予約する', 'ホームへ')
    if (next === 'yes' || (next !== 'no' && /予約/.test(next))) await runBook(people)
    else onClose()
  }

  // ── book：予約。「誰が・何を・いつ」を1枚の予約メモにして、足りんところだけ聞く（11/8 慶一郎さん「変えたところだけ直す」）
  //   どの質問の途中でも「やっぱり朔耶だけ」「土曜がええ」「アイパーにする」で、そこだけ直す（ボタン・声・文字どれでも）
  //   人・メニューが変わったら施術時間も変わるので、時間は必ず選び直し（前の時間で取れると決めつけない）
  const runBook = async (known?: People | null) => {
    const people = known ?? await fetchPeople().catch(() => null)
    const owner: BookPerson = { key: 'me', id: null, name: people?.owner?.name ?? 'ご本人', label: 'ご本人', person: people?.owner ?? null }
    const mates: BookPerson[] = (people?.companions ?? []).filter(c => c.id).map(c => ({ key: c.id!, id: c.id!, name: c.name, label: honor(c.name), person: c }))
    const everyone = [owner, ...mates]
    const all = menusRef.current
    const opts = await api.options().catch(() => null)
    const maintMenu = opts?.menus.find(m => m.code === 'maintenance') as Menu | undefined
    const staffList = opts?.staff ?? []
    const d: Draft = { who: mates.length ? null : [owner], menus: {}, when: null, at: null, plan: null }

    /** 言葉の中の人（「朔耶だけ」「本人と朔耶」「2人とも」） */
    const whoIn = (t: string): BookPerson[] | null => {
      const s = t.normalize('NFKC')
      if (/全員|みんな|皆|[2２二]人とも|[3３三]人とも|一緒/.test(s)) return everyone.slice(0, 3)
      const hit = mates.filter(p => s.includes(p.name.replace(/(さん|様|ちゃん|くん|君)$/, '')))
      const me = /本人|わし|自分|私|僕|俺|お母さん本人/.test(s)
      const list = [...(me ? [owner] : []), ...hit]
      return list.length ? list.slice(0, 3) : null
    }
    const whenIn = (t: string): Draft['when'] | undefined => {
      const s = t.normalize('NFKC')
      const md2 = s.match(/(\d{1,2})月(\d{1,2})日/), dOnly = s.match(/(?:^|[^\d月])(\d{1,2})日/)
      if (md2 || dOnly) {
        const today = todayJst()
        let y = +today.slice(0, 4), mo = md2 ? +md2[1] : +today.slice(5, 7)
        const da = md2 ? +md2[2] : +dOnly![1]
        const ymd = () => `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`
        // 過ぎた日なら：月まで言われたら来年、日だけなら来月
        if (ymd() < today) { if (md2) y++; else { mo++; if (mo > 12) { mo = 1; y++ } } }
        const day = ymd()
        // 暦に無い日（11月31日など）は日付として受け取らない
        const real = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).toISOString().slice(0, 10) === day
        if (real && day >= today) return { kind: 'day', day }
      }
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
      return all.find(m => s.includes(m.name.normalize('NFKC'))) ?? matchMenu(t, all)
    }
    /** 途中の変更を読み取って、予約メモのそこだけ直す。直したら true */
    const change = async (t: string): Promise<boolean> => {
      const s = t.normalize('NFKC')
      const changing = /やっぱ|変え|変更|じゃなく|ではなく|だけ|にする|がええ|がいい|にして/.test(s)
      const w = whoIn(s)
      if (w && (changing || d.who !== null) && !(d.who && sameWho(d.who, w))) {
        d.who = w; d.at = null; d.plan = null
        await say(`かしこまりました！${w.map(p => p.label).join('と')}のご予約にしますね。`)
        return true
      }
      const m = menuIn(s)
      if (m && changing && d.who) {
        let target = d.who.length === 1 ? d.who[0] : (whoIn(s)?.[0] ?? null)
        if (!target) {
          const a = await ask(`「${m.name}」は、どなたのメニューですか？`, d.who.map(p => ({ label: p.label })))
          target = d.who.find(p => p.label === a || a.includes(p.name)) ?? d.who[0]
        }
        if (m.code === 'maintenance' && !target.person?.maintenance_ok) { await say(`${target.label}は、今はメンテナンスカットの期限が過ぎとるんです。`); return true }
        d.menus[target.key] = m; d.at = null; d.plan = null
        await say(`かしこまりました！${target.label}は「${m.name}」にしますね。`)
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
      const whoText = d.who && d.who.length > 1 ? `${p.label}は` : ''
      if (!usual) {
        const m = await hearMenu(p.id ? { kind: 'mate', id: p.id, name: p.name } : { kind: 'me' }, `${whoText}メニューは、何にされますか？`, null)
        return m
      }
      const a = await ask(maint ? `${whoText}いつもの「${usual.name}」にされますか？それとも、メンテナンスカットにされますか？` : `${whoText}いつもの「${usual.name}」${usual.price != null ? ` ${yen(usual.price)}` : ''}でよろしいですか？`,
        maint ? [{ label: usual.name, sub: yen(usual.price), strong: true }, { label: 'メンテナンスカット', sub: p.person?.days_left != null ? `あと${p.person.days_left}日` : undefined }, { label: 'ほかのメニュー' }]
          : [{ label: 'はい', strong: true }, { label: 'ほかのメニュー' }])
      if (maint && /メンテ/.test(a)) return maint
      if (a === usual.name) return usual
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
        const lists = await Promise.all(codes.map(c => openDays(c, todayJst(), d.when?.kind === 'weekend' ? 42 : 21, d.when?.kind === 'weekend')))
        days = lists.reduce((a, b) => a.filter(x => b.includes(x)))
        const w = d.when
        if (w?.kind === 'weekend' && w.dow != null) days = days.filter(x => new Date(Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10))).getUTCDay() === w.dow)
      }
      const out: { at: string; staff: Record<string, string | null> }[] = []
      const want = d.when?.kind === 'day' ? 6 : 3
      for (const day of days.slice(0, 8)) {
        if (who.length === 1) {
          const slots = spreadSlots(await api.slots(day, menus[0].code), d.when?.kind === 'day' ? 6 : d.when?.kind === 'weekend' ? 2 : 3)
          out.push(...slots.map(s => ({ at: s.starts_at, staff: { [who[0].key]: null } })))
        } else {
          // 担当ごと・メニューごとの空き → 同じ時間に、全員へ別々の担当を割り当てられる時間
          const free = await Promise.all(who.map((_, i) => Promise.all(staffList.map(st => api.staffSlots(day, menus[i].code, st.id).then(l => new Set(l.map(x => Date.parse(x.starts_at)))).catch(() => new Set<number>())))))
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
      return out.slice(0, want)
    }

    const summary = () => d.who!.map(p => `${d.who!.length > 1 ? p.label + '：' : ''}${d.menus[p.key].name}${d.menus[p.key].price != null ? ` ${yen(d.menus[p.key].price)}` : ''}`).join('\n')

    for (let guard = 0; guard < 40; guard++) {
      // 誰の予約？
      if (!d.who) {
        const chips: Chip[] = [{ label: 'ご本人', strong: true }, ...mates.map(p => ({ label: p.label })), ...(everyone.length > 1 && everyone.length <= 3 ? [{ label: everyone.length === 2 ? '2人とも' : '全員' }] : [])]
        const a = await ask('どなたのご予約にしますか？', chips)
        const w = a === 'ご本人' ? [owner] : whoIn(a) ?? (mates.find(p => p.label === a) ? [mates.find(p => p.label === a)!] : null)
        if (w) { d.who = w; continue }
        if (await change(a)) continue
        d.who = [owner]; continue
      }
      // メニュー（決まっとらん人だけ）
      const need = d.who.find(p => !d.menus[p.key])
      if (need) {
        const m = await askMenuFor(need)
        if (m === 'changed') continue
        if (!m) { await say('また決まりましたら、いつでも声をかけてくださいね。'); break }
        d.menus[need.key] = m
        continue
      }
      // いつ？
      if (!d.when) {
        const a = await ask('ご来店は、いつ頃がええですか？', [{ label: '最短で', strong: true }, { label: '土日希望' }, { label: '日付を選ぶ' }])
        const wh = whenIn(a)
        if (wh) { d.when = wh; continue }
        if (await change(a)) continue
        d.when = { kind: 'soonest' }; continue
      }
      if (d.when.kind === 'pick') {
        setTyping(true)
        const codes = [...new Set(d.who.map(p => d.menus[p.key].code))]
        const lists = await Promise.all(codes.map(c => openDays(c, todayJst(), 63, false)))
        const open = lists.reduce((a, b) => a.filter(x => b.includes(x)))
        setTyping(false)
        if (!open.length) { await say('すみません、しばらく全員そろって入れる日が無いんです。お店にお電話いただけますか？'); d.when = null; continue }
        await say(d.who.length > 1 ? '全員そろって入れる日だけ、押せるようにしとりますけぇね。' : '空いとる日だけ、押せるようにしとりますけぇね。')
        const day = await pickDate(open)
        d.when = day ? { kind: 'day', day } : null
        continue
      }
      // 時間（人・メニュー・日が変わるたびに探し直す）
      if (!d.at) {
        setTyping(true)
        const found = await findTimes().catch(() => [])
        setTyping(false)
        if (!found.length) {
          await say(d.when.kind === 'day' ? `すみません、${mdw(d.when.day)}は${d.who.length > 1 ? '全員そろって' : ''}入れる時間が無かったんです。` : 'すみません、近いところに空きが無かったんです。')
          d.when = null; continue
        }
        const oneDay = found.every(f => dayOf(f.at) === dayOf(found[0].at))
        const a = await ask(oneDay ? `${mdw(dayOf(found[0].at))}は、この時間が空いとりますよ。` : 'この時間が空いとりますよ。', [...found.map(f => ({ label: oneDay ? hm(f.at) : slotLabel(f.at) })), { label: 'ほかの日' }])
        const hit = found.find(f => slotLabel(f.at) === a || hm(f.at) === a)
        if (hit) { d.at = hit.at; d.plan = hit.staff; continue }
        if (a === 'ほかの日') { d.when = null; continue }
        if (await change(a)) continue
        continue
      }
      // まとめて確認：誰が・何を・いつ（今の予約があれば入れ替える）
      const mine = await api.reservations().catch(() => [] as CustomerReservation[])
      const actives = d.who.map(p => mine.filter(r => isUpcoming(r) && (p.id ? r.companion_id === p.id : !r.companion_id && !r.companion_of && !r.companion_name)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null)
      const swaps = d.who.map((p, i) => actives[i] ? `※${d.who!.length > 1 ? p.label + 'の' : ''}${slotLabel(actives[i]!.starts_at)}のご予約は、こちらに入れ替えますね` : '').filter(Boolean)
      const BOOK = 'この内容で予約する'
      const a = await ask(`この内容でよろしければ、下の【${BOOK}】を押してくださいね。\n${slotLabel(d.at)}\n${summary()}${swaps.length ? '\n' + swaps.join('\n') : ''}`,
        [{ label: BOOK, strong: true }, ...(mates.length ? [{ label: '人を変える' }] : []), { label: 'メニューを変える' }, { label: '日にちを変える' }])
      const tapped = fromChip.current
      if (tapped && a === '人を変える') { d.who = null; d.at = null; d.plan = null; continue }
      if (tapped && a === 'メニューを変える') {
        const pickWho = d.who.length === 1 ? '' : await ask('どなたのメニューを変えますか？', d.who.map(x => ({ label: x.label })))
        const target = d.who.length === 1 ? d.who[0] : d.who.find(p => p.label === pickWho || pickWho.includes(p.name)) ?? d.who[0]
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
      setTyping(true)
      const order = [...d.who].sort((x, y) => (x.key === 'me' ? -1 : y.key === 'me' ? 1 : 0))
      const done: { p: BookPerson; r: CustomerReservation | null }[] = []
      let primary: CustomerReservation | null = null
      for (const p of order) {
        const menu = d.menus[p.key]
        let r: CustomerReservation | null
        try {
          const hold = await api.hold(d.at, menu.code, d.plan?.[p.key] ?? null, p.id)
          r = await api.confirm(hold.hold_id, p.id ? `お連れ様：${p.name}様` : null, p.id)
          rememberReservation(r)
          if (!p.id) primary = r
          else if (primary) { try { await linkCompanion(primary.id, r.id) } catch { /* つながらなくても予約はそのまま */ } }
          const old = actives[d.who.indexOf(p)]
          if (old) { try { await api.cancel(old.id); forgetReservation(old.id) } catch { /* 下で伝える */ } }
        } catch { r = null }
        done.push({ p, r })
      }
      setTyping(false)
      const okAll = done.every(x => x.r)
      if (!done.some(x => x.r)) { await say('すみません、その時間はちょうど埋まってしまいました。時間を選び直しましょう。'); d.at = null; d.plan = null; continue }
      await say(okAll ? `ご予約を承りました！\n${slotLabel(d.at)}、お待ちしとりますけぇね。` : `${done.filter(x => x.r).map(x => x.p.label).join('と')}のご予約は取れました（${slotLabel(d.at)}）。\n${done.filter(x => !x.r).map(x => x.p.label).join('と')}はちょうど埋まってしまいました。お店にお電話いただけますか？`)
      await tips(null)
      break
    }
    setFinished(true)
    setChips([{ label: 'ホームへ', strong: true }]); setWaiting(true)
    await new Promise<string>(res => { waitRef.current = res })
    onClose()
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const opts = await api.options().catch(() => null)
      menusRef.current = opts ? usualMenuOrder(opts.menus.filter(m => canBeUsual(m.code))) as Menu[] : []
      if (mode.kind === 'welcome') await runWelcome(mode.pending)
      else { await say('よう来んさったのぉ！ご予約ですね。'); await runBook() }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 開いたときに1回だけ

  const send = () => { const t = text.trim(); if (!t || !waiting) return; setText(''); fromChip.current = false; answer(t) }
  const shown = sheet ? (showAll ? sheet : sheet.slice(0, 7)) : null

  return (
    <div role="dialog" aria-modal="true" aria-label="銀ちゃん" className="v2 gc lc">
      <header className="lc-head">
        <p className="lc-head-name">銀ちゃん</p>
        <button type="button" className="gc-icon lc-close" aria-label={finished ? '閉じる' : 'あとで'} onClick={onClose}><X size={20} /></button>
      </header>
      <div className="gc-log lc-log" ref={logRef} aria-live="polite">
        <div className="lc-hero" aria-hidden="true"><JohnnyRider state="idle" width={210} /></div>
        {msgs.map((m, i) => {
          if (m.from === 'cal') return <LcCalendar key={m.id} open={m.open} first={m.first} last={m.last} onPick={d => { calRef.current?.(d); calRef.current = null }} />
          const head = m.from === 'gin' && msgs[i - 1]?.from !== 'gin'
          return m.from === 'gin' ? (
            <motion.div key={m.id} className={head ? 'lc-row lc-row-head' : 'lc-row'}
              initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}>
              {head ? <img className="lc-avatar" src="/johnny/gin-avatar.webp" alt="" /> : <span className="lc-avatar-gap" />}
              <div className="lc-col">{head && <p className="lc-name">銀ちゃん</p>}<p className="gc-msg gc-gin">{m.text}</p></div>
            </motion.div>
          ) : (
            <motion.p key={m.id} className="gc-msg gc-you" initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>{m.text}</motion.p>
          )
        })}
        {typing && <div className="lc-row"><span className="lc-avatar-gap" /><p className="gc-msg gc-gin gc-typing" aria-label="銀ちゃんが考えています"><i /><i /><i /></p></div>}
      </div>
      <div className="lc-dock">
        {chips.length > 0 && (
          <motion.div className="gc-chips lc-chips" initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
            {chips.map(c => (
              <button key={c.label} type="button" className={c.strong ? 'gc-chip gc-chip-strong' : 'gc-chip'} onClick={() => { fromChip.current = true; answer(c.label) }}>
                {c.label}{c.sub && <small>{c.sub}</small>}
              </button>
            ))}
            {chips.some(c => c.label === '一覧から選ぶ') && <a className="gc-chip lc-link" href={HOTPEPPER_MENU_URL} target="_blank" rel="noopener noreferrer">HOT PEPPER</a>}
          </motion.div>
        )}
        <form className={waiting ? 'gc-lens gc-composer' : 'gc-lens gc-composer gc-composer-off'} onSubmit={e => { e.preventDefault(); send() }}>
          {voice.listen !== 'unsupported' && voice.listen !== 'denied' && (
            <button type="button" className={listening ? 'lc-mic lc-mic-on' : 'lc-mic'} disabled={!waiting} aria-label={listening ? '話し終わった' : '声で話す'}
              onClick={() => (listening ? voice.finishListening() : voice.startListening())}><Mic size={19} /></button>
          )}
          <input value={listening ? voice.interim || '聞いとります…' : text} onChange={e => setText(e.target.value)} readOnly={listening}
            placeholder={waiting ? 'メッセージを入力' : '銀ちゃんが話しとります…'} disabled={!waiting} maxLength={60} enterKeyHint="send" autoComplete="off" aria-label="銀ちゃんへの返事" />
          <button type="submit" className="gc-send" disabled={!text.trim() || !waiting || listening} aria-label="送る"><ArrowUp size={18} strokeWidth={2.4} /></button>
        </form>
      </div>

      <AnimatePresence>
        {sheet && (
          <>
            <motion.div key="back" className="gc-sheet-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => { setSheet(null); setShowAll(false); sheetRef.current?.(null); sheetRef.current = null }} />
            <motion.div key="sheet" className="gc-sheet" role="dialog" aria-label="メニューを選ぶ"
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}>
              <div className="gc-grab" />
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

/** 会話の中のカレンダー：年月・曜日は暦どおり計算。空きのある日だけ押せる */
function LcCalendar({ open, first, last, onPick }: { open: string[]; first: string; last: string; onPick: (d: string | null) => void }) {
  const [month, setMonth] = useState(first.slice(0, 7))
  const set = new Set(open)
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)]
  const shift = (n: number) => setMonth(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7))
  const canPrev = month > first.slice(0, 7), canNext = month < last.slice(0, 7)
  return (
    <motion.div className="gc-lens lc-cal" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
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
