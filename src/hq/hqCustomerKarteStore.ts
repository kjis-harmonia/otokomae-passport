import { supabase } from '../lib/supabase'
import { getJapanDateString } from '../utils/dateUtils'

// 銀二郎本部 — 顧客カルテ（Phase6-A MVP）
// 新規テーブルは作らず、customers / accounting_sessions / accounting_session_items の
// 既存データから集計するのみ。accounting_sessions.status='completed' のみ集計対象。

export interface CustomerKarteSummary {
  userId: string
  name: string
  phoneLast4: string | null
  visitCount: number
  totalSpend: number
  avgSpend: number
  lastVisitDate: string | null // YYYY-MM-DD (JST)。来店履歴なしなら null
  lastStylistName: string | null
}

export interface CustomerKarteVisitItem {
  itemName: string
  category: string
  quantity: number
}

export interface CustomerKarteVisit {
  sessionId: string
  date: string // YYYY-MM-DD (JST)
  total: number
  stylistName: string | null
  staffName: string | null
  items: CustomerKarteVisitItem[]
}

export interface ItemUsageEntry {
  itemName: string
  category: string
  count: number
}

export interface CustomerKarteDetail {
  userId: string
  name: string
  phoneLast4: string | null
  registeredAt: string | null // 登録日（customers.created_at）。ISO文字列のまま返す（表示側で整形）
  visitCount: number
  totalSpend: number
  avgSpend: number
  lastVisitDate: string | null
  avgIntervalDays: number | null // 来店履歴が2日分未満の場合は null（「算出不可」）
  visits: CustomerKarteVisit[] // 新しい順、最大20件
  itemUsage: ItemUsageEntry[]
}

interface RawSessionRow {
  id: string
  user_id: string | null
  total: number | null
  stylist_name: string | null
  staff_name: string | null
  created_at: string
}

function buildItemUsage(items: { item_name: string; category: string; quantity: number | null }[]): ItemUsageEntry[] {
  const tally = new Map<string, { category: string; count: number }>()
  for (const it of items) {
    const existing = tally.get(it.item_name)
    const qty = it.quantity ?? 1
    if (existing) existing.count += qty
    else tally.set(it.item_name, { category: it.category, count: qty })
  }
  return [...tally.entries()]
    .map(([itemName, v]) => ({ itemName, category: v.category, count: v.count }))
    .sort((a, b) => a.itemName.localeCompare(b.itemName, 'ja'))
}

/**
 * 顧客一覧（顧客カルテタブ）。最終来店日が新しい順、来店履歴がない顧客は末尾。
 * customers / accounting_sessions(completed) のみ使用。検索フィルタはUI側で行う想定。
 */
export async function getCustomerKarteList(): Promise<CustomerKarteSummary[]> {
  const [customersRes, sessionsRes] = await Promise.all([
    supabase.from('customers').select('user_id, name, phone_last4, created_at'),
    supabase
      .from('accounting_sessions')
      .select('id, user_id, total, stylist_name, staff_name, created_at')
      .eq('status', 'completed')
      .not('user_id', 'is', null),
  ])

  if (customersRes.error) throw customersRes.error
  if (sessionsRes.error) throw sessionsRes.error

  const customers = customersRes.data ?? []
  const sessions = (sessionsRes.data ?? []) as RawSessionRow[]

  const byUser = new Map<string, RawSessionRow[]>()
  for (const s of sessions) {
    if (!s.user_id) continue
    const list = byUser.get(s.user_id) ?? []
    list.push(s)
    byUser.set(s.user_id, list)
  }

  const summaries: CustomerKarteSummary[] = customers.map((c) => {
    const userSessions = byUser.get(c.user_id) ?? []
    const visitCount = userSessions.length
    const totalSpend = userSessions.reduce((sum, s) => sum + (s.total ?? 0), 0)
    const avgSpend = visitCount > 0 ? Math.round(totalSpend / visitCount) : 0

    let lastVisitDate: string | null = null
    let lastStylistName: string | null = null
    if (visitCount > 0) {
      const latest = userSessions.reduce((a, b) => (a.created_at > b.created_at ? a : b))
      lastVisitDate = getJapanDateString(new Date(latest.created_at))
      lastStylistName = latest.stylist_name || null
    }

    return {
      userId: c.user_id,
      name: c.name,
      phoneLast4: c.phone_last4,
      visitCount,
      totalSpend,
      avgSpend,
      lastVisitDate,
      lastStylistName,
    }
  })

  const withVisits = summaries.filter((s) => s.lastVisitDate !== null)
    .sort((a, b) => (a.lastVisitDate! < b.lastVisitDate! ? 1 : a.lastVisitDate! > b.lastVisitDate! ? -1 : 0))
  const withoutVisits = summaries.filter((s) => s.lastVisitDate === null)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))

  return [...withVisits, ...withoutVisits]
}

/** 顧客詳細（顧客カルテ詳細画面）。該当顧客が見つからない場合は null。 */
export async function getCustomerKarteDetail(userId: string): Promise<CustomerKarteDetail | null> {
  const [customerRes, sessionsRes] = await Promise.all([
    supabase.from('customers').select('user_id, name, phone_last4, created_at').eq('user_id', userId).maybeSingle(),
    supabase
      .from('accounting_sessions')
      .select('id, user_id, total, stylist_name, staff_name, created_at')
      .eq('status', 'completed')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
  ])

  if (customerRes.error) throw customerRes.error
  if (sessionsRes.error) throw sessionsRes.error

  const customer = customerRes.data
  if (!customer) return null

  const sessions = (sessionsRes.data ?? []) as RawSessionRow[]
  const visitCount = sessions.length
  const totalSpend = sessions.reduce((sum, s) => sum + (s.total ?? 0), 0)
  const avgSpend = visitCount > 0 ? Math.round(totalSpend / visitCount) : 0
  const lastVisitDate = visitCount > 0 ? getJapanDateString(new Date(sessions[0].created_at)) : null

  // 来店周期：日付（JST）の重複を除いた上で、連続する来店の間隔（日数）の平均
  const distinctDays = [...new Set(sessions.map((s) => getJapanDateString(new Date(s.created_at))))]
    .sort() // 昇順文字列ソート = 日付昇順（YYYY-MM-DD）
  let avgIntervalDays: number | null = null
  if (distinctDays.length >= 2) {
    let totalDiff = 0
    for (let i = 1; i < distinctDays.length; i++) {
      const [y1, m1, d1] = distinctDays[i - 1].split('-').map(Number)
      const [y2, m2, d2] = distinctDays[i].split('-').map(Number)
      const diffMs = new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()
      totalDiff += diffMs / (24 * 60 * 60 * 1000)
    }
    avgIntervalDays = Math.round(totalDiff / (distinctDays.length - 1))
  }

  const recentSessions = sessions.slice(0, 20)
  const sessionIds = sessions.map((s) => s.id)

  let itemsBySession = new Map<string, CustomerKarteVisitItem[]>()
  let allItems: { session_id: string; item_name: string; category: string; quantity: number | null }[] = []
  if (sessionIds.length > 0) {
    const itemsRes = await supabase
      .from('accounting_session_items')
      .select('session_id, item_name, category, quantity')
      .in('session_id', sessionIds)
    if (itemsRes.error) throw itemsRes.error
    allItems = itemsRes.data ?? []
    itemsBySession = new Map()
    for (const it of allItems) {
      const list = itemsBySession.get(it.session_id) ?? []
      list.push({ itemName: it.item_name, category: it.category, quantity: it.quantity ?? 1 })
      itemsBySession.set(it.session_id, list)
    }
  }

  const visits: CustomerKarteVisit[] = recentSessions.map((s) => ({
    sessionId: s.id,
    date: getJapanDateString(new Date(s.created_at)),
    total: s.total ?? 0,
    stylistName: s.stylist_name || null,
    staffName: s.staff_name || null,
    items: itemsBySession.get(s.id) ?? [],
  }))

  return {
    userId: customer.user_id,
    name: customer.name,
    phoneLast4: customer.phone_last4,
    registeredAt: customer.created_at ?? null,
    visitCount,
    totalSpend,
    avgSpend,
    lastVisitDate,
    avgIntervalDays,
    visits,
    itemUsage: buildItemUsage(allItems),
  }
}
