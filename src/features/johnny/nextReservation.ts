// 次の来店予約（QR 画面に表示する）。正は customer_list_reservations。
// 予約した直後は一覧の取得を待たずに表示できるよう、確定した予約を端末にも覚えておく（表示だけに使う）。
import { useEffect, useState } from 'react'
import { bookingAssistantApi, type CustomerReservation } from './bookingAssistantApi'
import { hasCustomerSession } from '../../utils/customerSession'
import { getStoredValue } from '../../utils/storage'
import { USER_ID_KEY } from '../../utils/userId'

const KEY = 'ginjiro_next_reservation'
const EVENT = 'ginjiro:reservation-changed'
const ACTIVE: CustomerReservation['status'][] = ['confirmed', 'checked_in', 'in_service', 'awaiting_payment']

export function isUpcoming(r: CustomerReservation, now = Date.now()): boolean {
  return ACTIVE.includes(r.status) && new Date(r.ends_at).getTime() > now
}

// 端末の覚えは「誰の予約か」を一緒に保存し、今の会員と同じで、ログイン中のときだけ表示する（別の人の予約を出さない）
function currentOwner(): string | null {
  return hasCustomerSession() ? getStoredValue<string | null>(USER_ID_KEY, null) : null
}

function readCached(): CustomerReservation | null {
  try {
    const owner = currentOwner()
    const v = localStorage.getItem(KEY)
    const saved = v ? (JSON.parse(v) as { owner?: string; r?: CustomerReservation }) : null
    const r = saved?.r
    if (!owner || !r || saved.owner !== owner) return null
    return typeof r.starts_at === 'string' && isUpcoming(r) ? r : null
  } catch { return null }
}

function writeCached(r: CustomerReservation | null, owner = currentOwner()): void {
  try {
    if (r && owner) localStorage.setItem(KEY, JSON.stringify({ owner, r }))
    else localStorage.removeItem(KEY)
  } catch { /* 表示用なので保存できなくても続ける */ }
}

export function rememberReservation(r: CustomerReservation): void {
  writeCached(r)
  window.dispatchEvent(new Event(EVENT))
}

/** お連れ様の予約（端末に覚えて、一覧・確認で「お連れ様」と出す） */
const COMPANION_KEY = 'ginjiro_companion_reservations'
export function companionIds(): string[] {
  try { const v = JSON.parse(localStorage.getItem(COMPANION_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
export function rememberCompanion(id: string, name?: string): void {
  try {
    localStorage.setItem(COMPANION_KEY, JSON.stringify([...companionIds(), id].slice(-30)))
    if (name) localStorage.setItem(COMPANION_NAMES_KEY, JSON.stringify({ ...companionNames(), [id]: name }))
  } catch { /* 表示用なので保存できなくても続ける */ }
}

/** お連れ様の予約か。DB のつながり（companion_of）を正とし、古い予約は端末の記録でも見る（11/4） */
export function isCompanion(r: CustomerReservation): boolean {
  return !!r.companion_of || !!r.companion_id || !!r.companion_name || companionIds().includes(r.id)
}
/** お連れ様のお名前（端末に覚えた名前、無ければ予約メモの名前） */
export function companionName(r: CustomerReservation): string | null {
  return companionNames()[r.id] ?? r.companion_name ?? null
}

/** お連れ様のお名前（予約 id → 名前）。お店には予約のメモで届く。お客様の画面では端末に覚えた名前を出す */
const COMPANION_NAMES_KEY = 'ginjiro_companion_names'
export function companionNames(): Record<string, string> {
  try { const v = JSON.parse(localStorage.getItem(COMPANION_NAMES_KEY) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {} } catch { return {} }
}

export function pickNext(list: readonly CustomerReservation[]): CustomerReservation | null {
  return [...list].filter(r => isUpcoming(r)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null
}

/** 次の予約。サーバーの一覧が取れたらそれを正とし、取れなければ端末に覚えた予約 */
export function useNextReservation(): CustomerReservation | null {
  return useNextVisit().next
}

/** 予約一覧の読み込み状態。'failed' のときは「予約はありません」と言い切らない（10/30 監査 R3） */
export type VisitStatus = 'loading' | 'ok' | 'failed'
/** later：別の日のこれからのご予約（お連れ様だけ別の日に取った など・11/11 点検：次回予約に出ていなかった） */
type Visit = { next: CustomerReservation | null; companions: CustomerReservation[]; later: CustomerReservation[]; status: VisitStatus; reload: () => void }

/** 画面に戻った時の読み直し（SR-10）：1回の復帰で visibilitychange・pageshow が続けて来ても照会は1回。
 *  「1回の復帰」＝画面を離れてから（hidden・pagehide）次に離れるまで。時間では区切らない（3秒以内の別の復帰も読み直す・再検査）
 *  照会には通し番号を付け、その画面がもっと新しい照会をもう頼んでいたら、古い照会の結果は使わない（取消の反映を古い応答で戻さない・再検査） */
let fetchSeq = 0
let awayCount = 0
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') awayCount++ })
  window.addEventListener('pagehide', () => { awayCount++ })
}
let resumeFetch: { owner: string | null; away: number; seq: number; list: Promise<CustomerReservation[]> } | null = null
function sharedResume(owner: string | null): { seq: number; list: Promise<CustomerReservation[]> } {
  if (resumeFetch && resumeFetch.owner === owner && resumeFetch.away === awayCount) return resumeFetch
  resumeFetch = { owner, away: awayCount, seq: ++fetchSeq, list: bookingAssistantApi().reservations() }
  return resumeFetch
}

/** 次の来店：自分の予約と、同じ日のお連れ様の予約（10/30 慶一郎さん「お連れ様追加の情報がのってない」）。
 *  予約はおひとり1つまでなので、同じ日のほかの予約はお連れ様の分。自分の分は、お連れ様として覚えた予約を除いたいちばん早いもの */
export function useNextVisit(): Visit {
  const [visit, setVisit] = useState<Omit<Visit, 'reload'>>(() => ({ next: readCached(), companions: [], later: [], status: hasCustomerSession() ? 'loading' : 'ok' }))
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let alive = true
    let gen = 0
    let lastSeq = 0 // この画面がいちばん新しく頼んだ照会の通し番号
    const load = (resume = false) => {
      // 同じ復帰の2つ目の合図：この画面がその照会か、もっと新しい照会をもう頼んでいたら何もしない
      const shared = resume && hasCustomerSession() ? sharedResume(currentOwner()) : null
      if (shared && shared.seq <= lastSeq) return
      const seq = shared ? shared.seq : ++fetchSeq
      lastSeq = seq
      // 会員の切替・遅い応答：頼んだときの会員と、いちばん新しい頼みの応答だけ使う（10/30 監査 R1）
      const my = ++gen
      const owner = currentOwner()
      const cached = readCached()
      if (!hasCustomerSession()) { setVisit({ next: cached, companions: [], later: [], status: 'ok' }); return }
      setVisit(v => ({ next: cached, companions: cached && v.next?.id === cached.id ? v.companions : [], later: cached && v.next?.id === cached.id ? v.later : [], status: v.status === 'ok' && v.next?.id === cached?.id ? 'ok' : 'loading' }))
      ;(shared ? shared.list : bookingAssistantApi().reservations())
        .then(list => {
          if (!alive || my !== gen || owner !== currentOwner()) return
          const n = pickNext(list.filter(r => !isCompanion(r))) ?? pickNext(list)
          const companions = n ? list.filter(r => r.id !== n.id && isUpcoming(r) && sameDay(r.starts_at, n.starts_at)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)) : []
          const later = n ? list.filter(r => r.id !== n.id && isUpcoming(r) && !sameDay(r.starts_at, n.starts_at)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)) : []
          setVisit({ next: n, companions, later, status: 'ok' })
          writeCached(n, owner)
        })
        .catch(() => { if (alive && my === gen) setVisit(v => ({ ...v, status: 'failed' })) }) // 覚えている予約はそのまま見せる
    }
    const fresh = () => load()
    fresh()
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === 'ginjiro_customer_session' || e.key === USER_ID_KEY) load() }
    // 画面に戻った時（ほかの端末で変更・取消されたかもしれない）は読み直す。失敗したら「前に確認した内容」の表示になる（SR-10）
    const onResume = () => { if (document.visibilityState === 'visible') load(true) }
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) load(true) }
    window.addEventListener(EVENT, fresh)
    window.addEventListener('ginjiro:customer-session-changed', fresh)
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      alive = false
      window.removeEventListener(EVENT, fresh)
      window.removeEventListener('ginjiro:customer-session-changed', fresh)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [reloadKey])
  return { ...visit, reload: () => setReloadKey(k => k + 1) }
}

/** 日本時間で同じ日か */
function sameDay(a: string, b: string): boolean {
  const d = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10)
  return d(a) === d(b)
}

const WD = ['日', '月', '火', '水', '木', '金', '土']

/** 「10月16日（金）15:00」 */
export function formatVisit(iso: string): { date: string; time: string; relative: string | null } {
  const t = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000)
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
  const diff = Math.round((day(t) - day(now)) / 86400000)
  return {
    date: `${t.getUTCMonth() + 1}月${t.getUTCDate()}日（${WD[t.getUTCDay()]}）`,
    time: `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`,
    relative: diff === 0 ? '今日' : diff === 1 ? '明日' : diff === 2 ? '明後日' : null,
  }
}

/** キャンセルした予約を端末の覚えから外す（一覧を取り直して次の予約を出し直す） */
export function forgetReservation(id: string): void {
  try {
    const v = localStorage.getItem(KEY)
    if (v && (JSON.parse(v) as { r?: CustomerReservation }).r?.id === id) localStorage.removeItem(KEY)
  } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVENT))
}
