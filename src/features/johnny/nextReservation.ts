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

function isUpcoming(r: CustomerReservation, now = Date.now()): boolean {
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
type Visit = { next: CustomerReservation | null; companions: CustomerReservation[]; status: VisitStatus; reload: () => void }

/** 次の来店：自分の予約と、同じ日のお連れ様の予約（10/30 慶一郎さん「お連れ様追加の情報がのってない」）。
 *  予約はおひとり1つまでなので、同じ日のほかの予約はお連れ様の分。自分の分は、お連れ様として覚えた予約を除いたいちばん早いもの */
export function useNextVisit(): Visit {
  const [visit, setVisit] = useState<Omit<Visit, 'reload'>>(() => ({ next: readCached(), companions: [], status: hasCustomerSession() ? 'loading' : 'ok' }))
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let alive = true
    let gen = 0
    const load = () => {
      // 会員の切替・遅い応答：頼んだときの会員と、いちばん新しい頼みの応答だけ使う（10/30 監査 R1）
      const my = ++gen
      const owner = currentOwner()
      const cached = readCached()
      if (!hasCustomerSession()) { setVisit({ next: cached, companions: [], status: 'ok' }); return }
      setVisit(v => ({ next: cached, companions: cached && v.next?.id === cached.id ? v.companions : [], status: v.status === 'ok' && v.next?.id === cached?.id ? 'ok' : 'loading' }))
      bookingAssistantApi().reservations()
        .then(list => {
          if (!alive || my !== gen || owner !== currentOwner()) return
          const marked = companionIds()
          const n = pickNext(list.filter(r => !marked.includes(r.id))) ?? pickNext(list)
          const companions = n ? list.filter(r => r.id !== n.id && isUpcoming(r) && sameDay(r.starts_at, n.starts_at)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)) : []
          setVisit({ next: n, companions, status: 'ok' })
          writeCached(n, owner)
        })
        .catch(() => { if (alive && my === gen) setVisit(v => ({ ...v, status: 'failed' })) }) // 覚えている予約はそのまま見せる
    }
    load()
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === 'ginjiro_customer_session' || e.key === USER_ID_KEY) load() }
    window.addEventListener(EVENT, load)
    window.addEventListener('ginjiro:customer-session-changed', load)
    window.addEventListener('storage', onStorage)
    return () => { alive = false; window.removeEventListener(EVENT, load); window.removeEventListener('ginjiro:customer-session-changed', load); window.removeEventListener('storage', onStorage) }
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
