// 銀ちゃんの接客（11/8 慶一郎さん「LINE をする感覚で、話すかボタンを押すだけで全部済む」）
//   左に銀ちゃん（丸い顔のアイコン・白い吹き出し）、右にお客様（黒い吹き出し）。下に銀ちゃんが先回りして出すボタンと、入力欄（マイク・文字）
//   ボタン・声・文字は、ぜんぶ同じ会話につながる（「はい/いいえ」は「うん」「ちがう」でも進む）
//   welcome：店頭で QR を読んだあと。「〇月〇日は〇〇じゃったね！いつものに登録してええ？」→ メンテナンス → お連れ様 → お得な案内
//   book：「いつものでAI予約する」。どなたの予約か → メニュー → 「いつ来るん？」【最短で】【土日希望】【日付を選ぶ】→ 時間 → 確認 → 予約
//   メニュー・料金・空きは、店の一覧と今の予約エンジンだけ。登録・予約は、お客様が確かめてから
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUp, ChevronLeft, ChevronRight, Mic, X } from 'lucide-react'
import { bookingAssistantApi, type CustomerReservation } from '../features/johnny/bookingAssistantApi'
import { canBeUsual, setUsualMenu, usualMenuOrder } from '../features/johnny/usualMenu'
import { fetchPeople, MAX_COMPANIONS, saveCompanion, setOwnerMaintenance, type People, type Person } from '../features/johnny/usualMembers'
import { askUsualAi } from '../features/johnny/usualAi'
import { askAgentVoice, type AgentTurn } from '../features/johnny/agentClient'
import { parseYesNo } from '../features/johnny/visitParser'
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
const isYes = (t: string) => t === 'はい' || parseYesNo(t) === true
const isNo = (t: string) => t === 'いいえ' || t === 'ちがう' || parseYesNo(t) === false
const yes = (t: string) => isYes(t) && !isNo(t)

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
    void askAgentVoice(audio, [], undefined, true).then(r => { setTyping(false); if (r?.heard) answer(r.heard) })
  }, [answer])
  const voice = useVoice(answer, { server: api.serverVoice, onAudio, aiVoice: false })
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
      if (!menu && t === '一覧から選ぶ') { menu = await pickFromList(); if (menu) push('you', menu.name); else { line = 'ほいじゃ、話して決めようか。何でもええよ。'; sugg = []; continue } }
      if (!menu) {
        const plain = t.normalize('NFKC').replace(/[\s。、！!]/g, '').replace(/(でお願い(します)?|にする|でええ|で)$/, '')
        menu = all.find(m => m.name.normalize('NFKC').replace(/\s/g, '') === plain && !rejected.has(m.code)) ?? null
      }
      if (!menu) {
        setTyping(true)
        const r = await askUsualAi(t, turns.current.slice(0, -1), { visited: true, who: who.kind === 'mate' ? who.name : null, rejected: [...rejected], visitDate })
        setTyping(false)
        if (!r) { line = 'ごめん、今うまく聞き取れんかった。一覧から選んでもええよ。'; sugg = []; continue }
        const ready = r.ready ? all.find(m => m.code === r.ready) : undefined
        if (!ready) { line = r.say; sugg = r.suggestions.map(c => all.find(m => m.code === c)).filter((m): m is Menu => !!m); continue }
        menu = ready
        await say(r.say)
      }
      const c = await ask(`「${menu.name}」${menu.price != null ? ` ${yen(menu.price)}` : ''}でええ？`, [{ label: 'はい', strong: true }, { label: 'ちがう' }])
      if (yes(c)) return menu
      rejected.add(menu.code)
      setTyping(true)
      const r = await askUsualAi(`「${menu.name}」はちがう`, turns.current, { visited: true, who: who.kind === 'mate' ? who.name : null, rejected: [...rejected], visitDate })
      setTyping(false)
      line = r?.say ?? 'そうか、ちがったか。どんな感じじゃった？'
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
      const a = await ask(`${greet}${md(v.date)}は${name}${known.name}じゃったね！\nこれをいつものメニューに登録してええ？`, [{ label: 'はい', strong: true }, { label: 'いいえ' }])
      menu = yes(a) ? known : await hearMenu(who, `ほいじゃ、${md(v.date)}は何のメニューじゃった？`, v.date)
    } else if (v.menu_code === 'maintenance') {
      menu = await hearMenu(who, `${greet}${md(v.date)}はメンテナンスカットじゃったね！\n${name}いつものメニューは何にしよるん？`, null)
    } else {
      menu = await hearMenu(who, `${greet}${md(v.date)}は${who.kind === 'mate' ? honor(who.name) + 'も' : ''}よう来てくれんさったのぉ！\nまだいつものが決まっとらんけん、前回何のメニューしたか教えてくれん？`, v.date)
    }
    try {
      await callCustomerRpc('customer_confirm_visit', { p_date: v.date, p_companion: who.kind === 'mate' ? who.id : null, p_menu_code: v.menu_code === 'maintenance' ? null : menu?.code ?? null })
    } catch { /* 記録できなくても会話は続ける */ }
    return menu
  }

  const askMaintenance = async (who: Who, menu: Menu) => {
    if (!menu.maintenance) return false
    const a = await ask(`「${menu.name}」なら、14日以内のメンテナンスカットも使えるで。\n${who.kind === 'mate' ? honor(who.name) + 'も' : ''}希望する？`, [{ label: 'はい', strong: true }, { label: 'いいえ' }])
    return yes(a)
  }

  /** お得な案内：使える割引券（期限内・条件に合うもの）と、メンテナンスの期限 */
  const tips = async (owner: Person | null | undefined) => {
    try {
      const tickets = await callCustomerRpc<TicketRow[]>('customer_get_tickets')
      const usable = usableTickets(tickets ?? [], new Date().toISOString()).filter(t => t.type === 'discount' && (t.amount ?? 0) > 0)
      if (usable.length) {
        const best = Math.max(...usable.map(t => t.amount ?? 0))
        await say(usable.length === 1 ? `今${best.toLocaleString('ja-JP')}円の割引券持っとるで！次の予約で使えるけんね！` : `割引券を${usable.length}枚持っとるで（いちばん大きいのは${best.toLocaleString('ja-JP')}円）！次の予約で使えるけんね！`)
      }
    } catch { /* 券が読めんときは案内しない */ }
    if (owner?.maintenance_ok && owner.days_left != null) await say(owner.days_left === 0 ? 'メンテナンスカットは今日までじゃけぇね！' : `メンテナンスカットは、あと${owner.days_left}日使えるけぇね！`)
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
        await say(before && before !== menu.code ? `いつものを「${menu.name}」にしといたで！` : `ええね！いつものは「${menu.name}」で登録したで！`)
        const m = await askMaintenance({ kind: 'me' }, menu)
        people = await setOwnerMaintenance(m).catch(() => people)
        if (m) await say('了解！メンテナンスカットも出すようにしとくけぇね。')
      }
    }
    for (const c of pending.companions) {
      const who: Who = { kind: 'mate', id: c.id, name: c.name }
      const menu = await confirmVisit(who, c, greet)
      greet = ''
      if (menu) {
        const m = await askMaintenance(who, menu)
        people = await saveCompanion(c.id, c.name, menu.code, m).catch(() => people)
        await say(`${honor(c.name)}のいつものは「${menu.name}」にしといたで！`)
      }
    }
    let count = people?.companions.length ?? 0
    if (count === 0) {
      let a = await ask('お連れ様も登録できるで！どうする？', [{ label: '登録する', strong: true }, { label: '今はしない' }])
      while ((a === '登録する' || yes(a)) && count < MAX_COMPANIONS) {
        const n = await ask('お名前は？お店で呼ぶ名前でええよ。', [])
        const name = n.slice(0, 20)
        const menu = await hearMenu({ kind: 'mate', id: null, name }, `${honor(name)}は、いつも何にしよるん？`, null)
        if (menu) {
          const m = await askMaintenance({ kind: 'mate', id: null, name }, menu)
          try { people = await saveCompanion(null, name, menu.code, m); count++; await say(`${honor(name)}も登録したで！`) }
          catch { await say('ごめん、うまく登録できんかった。あとで ☰ からでも登録できるけぇね。'); break }
        }
        if (count >= MAX_COMPANIONS) break
        a = await ask('ほかにも一緒に来る人はおる？', [{ label: '登録する', strong: true }, { label: 'もうおらん' }])
      }
    }
    await tips(people?.owner)
    const next = await ask('準備できたけぇ！このまま次の予約もできるで。', [{ label: '予約する', strong: true }, { label: 'ホームへ' }])
    if (next === '予約する' || /予約/.test(next) || yes(next)) await runBook(people)
    else onClose()
  }

  // ── book：予約（どなたの → メニュー → いつ → 時間 → 確認） ──
  const runBook = async (known?: People | null) => {
    const people = known ?? await fetchPeople().catch(() => null)
    const owner = people?.owner ?? null
    const all = menusRef.current
    // どなたのご予約？（お連れ様がおるときだけ聞く）
    let person: Person | null = owner
    const mates = people?.companions ?? []
    if (mates.length) {
      const a = await ask('どなたのご予約にする？', [{ label: 'ご本人', strong: true }, ...mates.map(c => ({ label: honor(c.name) }))])
      person = mates.find(c => honor(c.name) === a || c.name === a || a.includes(c.name)) ?? owner
    }
    const mate = person && !person.is_owner && person.id ? { id: person.id, name: person.name } : null
    const whoText = mate ? `${honor(mate.name)}の` : ''
    // メニュー：いつもの。メンテナンスの期限内なら選べる
    let menu: Menu | null = person?.menu_code ? all.find(m => m.code === person!.menu_code) ?? null : null
    const maint = person?.maintenance_ok ? (await api.options()).menus.find(m => m.code === 'maintenance') as Menu | undefined : undefined
    if (menu) {
      const a = await ask(maint ? `${whoText}いつもの「${menu.name}」？それともメンテナンスカット？` : `${whoText}いつもの「${menu.name}」${menu.price != null ? ` ${yen(menu.price)}` : ''}でええ？`,
        maint ? [{ label: menu.name, sub: yen(menu.price), strong: true }, { label: 'メンテナンスカット', sub: person?.days_left != null ? `あと${person.days_left}日` : undefined }, { label: 'ほかのメニュー' }]
          : [{ label: 'はい', strong: true }, { label: 'ほかのメニュー' }])
      if (maint && /メンテ/.test(a)) menu = maint
      else if (a === 'ほかのメニュー' || isNo(a)) menu = await hearMenu(mate ? { kind: 'mate', id: mate.id, name: mate.name } : { kind: 'me' }, '何にする？', null)
    } else {
      menu = await hearMenu(mate ? { kind: 'mate', id: mate.id, name: mate.name } : { kind: 'me' }, `${whoText}メニューは何にする？`, null)
    }
    if (!menu) { await say('また決まったら呼んでね！'); setFinished(true); return }
    // 今の予約（その方の）：おひとり1つまで。あれば入れ替えるか聞く
    const mine = await api.reservations().catch(() => [] as CustomerReservation[])
    const active = mine.filter(r => isUpcoming(r) && (mate ? r.companion_id === mate.id : !r.companion_id && !r.companion_of && !r.companion_name)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null
    if (active) {
      const a = await ask(`${whoText}予約が ${slotLabel(active.starts_at)} に入っとるで。\n日にちを変える？`, [{ label: '変える', strong: true }, { label: 'そのまま' }])
      if (!(a === '変える' || yes(a))) { await say('了解！そのままにしとくね。'); setFinished(true); return }
    }
    // いつ来るん？ → 時間 → 確認（取れんかったら、もう一回いつにするか聞く）
    for (let round = 0; round < 6; round++) {
      const when = await ask('いつ来るん？', [{ label: '最短で', strong: true }, { label: '土日希望' }, { label: '日付を選ぶ' }])
      let times: string[] = []
      setTyping(true)
      try {
        if (/土|日曜|週末/.test(when) && !/日付/.test(when)) {
          const days = await openDays(menu.code, todayJst(), 42, true)
          for (const d of (days ?? []).slice(0, 2)) times = [...times, ...spreadSlots(await api.slots(d, menu.code), 2).map(s => s.starts_at)]
        } else if (/日付|カレンダー|選ぶ/.test(when)) {
          const days = await openDays(menu.code, todayJst(), 63, false)
          setTyping(false)
          if (!days?.length) { await say('ごめん、しばらく空きが無いんよ。お店に電話してみてくれる？'); continue }
          await say('空いとる日だけ押せるけぇね。')
          const d = await pickDate(days)
          if (!d) continue
          setTyping(true)
          times = spreadSlots(await api.slots(d, menu.code), 6).map(s => s.starts_at)
        } else {
          times = spreadSlots(await api.nextSlots(menu.code, todayJst(), 10), 3).map(s => s.starts_at)
        }
      } catch { times = [] }
      setTyping(false)
      if (!times.length) { await say('ごめん、その日は空きが無かったんよ。ほかの日にしてみよう。'); continue }
      const oneDay = times.every(s => dayOf(s) === dayOf(times[0]))
      const t = await ask(oneDay ? `${mdw(dayOf(times[0]))}は、この時間が空いとるで！` : 'この時間が空いとるで！', [...times.map(s => ({ label: oneDay ? hm(s) : slotLabel(s) })), { label: 'ほかの日' }])
      const at = times.find(s => slotLabel(s) === t || hm(s) === t)
      if (!at) continue
      // 枠を押さえて、確認（担当も分かる）
      let hold
      try { hold = await api.hold(at, menu.code, null, mate?.id ?? null) }
      catch { await say('ごめん、その時間はちょうど埋まってしもうた。ほかの時間にしよう。'); continue }
      const ok = await ask(`${whoText}予約はこれでええ？\n${slotLabel(at)}\n${menu.name}${hold.total_price != null ? ` ${yen(hold.total_price)}` : ''}\n担当 ${hold.staff_name}`, [{ label: '予約する', strong: true }, { label: '変える' }])
      if (!(ok === '予約する' || yes(ok))) { void api.release(hold.hold_id).catch(() => {}); continue }
      try {
        const r = await api.confirm(hold.hold_id, null, mate?.id ?? null)
        rememberReservation(r)
        if (active) { try { await api.cancel(active.id); forgetReservation(active.id) } catch { await say(`前の予約（${slotLabel(active.starts_at)}）は取り消せんかった。お店に電話してくれる？`) } }
        await say(`予約したで！\n${slotLabel(r.starts_at)}、待っとるけぇね！`)
        await tips(null)
      } catch {
        void api.release(hold.hold_id).catch(() => {})
        await say('ごめん、うまく予約できんかった。もう一回やってみよう。')
        continue
      }
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
      else { await say('よう来んさったのぉ！予約じゃね。'); await runBook() }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 開いたときに1回だけ

  const send = () => { const t = text.trim(); if (!t || !waiting) return; setText(''); answer(t) }
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
              <button key={c.label} type="button" className={c.strong ? 'gc-chip gc-chip-strong' : 'gc-chip'} onClick={() => answer(c.label)}>
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
          <input value={listening ? voice.interim || '聞いとるよ…' : text} onChange={e => setText(e.target.value)} readOnly={listening}
            placeholder={waiting ? 'メッセージを入力' : '銀ちゃんが話しよるよ…'} disabled={!waiting} maxLength={60} enterKeyHint="send" autoComplete="off" aria-label="銀ちゃんへの返事" />
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
