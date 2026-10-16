// 顧客台帳のクライアント。顧客（clients）＝銀二郎を利用する一人の人物。App 会員はその顧客に紐付く ID の一つ。
// 店舗端末（スタッフセッション）と本部（本部セッション）で同じ画面を使い、呼ぶ RPC だけを差し替える。
// テーブルへは直接アクセスしない。統合は人が候補を見て選んだときだけ（名前・電話番号だけでの自動統合はしない）。
import { callStaffRpc, RpcError } from './staffSession'
import { callHqRpc } from '../hq/hqSession'
import type { Reservation } from './bookingApi'

export interface ClientInfo {
  id: string
  name: string
  kana: string | null
  phone_last4: string | null
  created_via: 'app' | 'hotpepper' | 'phone' | 'staff'
  created_at: string
  phones: string[]
}
export interface CustomerStats {
  visit_count: number
  last_visit: string | null // YYYY-MM-DD (JST)
  avg_interval_days: number | null
  total_sales: number
  sales_count: number
}
export interface StylistHistory { name: string; count: number; last: string }
export interface ItemUsage { name: string; category: string; count: number }
export interface Treatment {
  id: string
  date: string
  total: number | null
  stylist_name: string | null
  items: { name: string; category: string; quantity: number }[]
}
export interface Coupon { id: string; type: string; title: string; amount: number; expires_at: string | null }
export interface CustomerNote { id: string; note: string; created_by: string; created_at: string }
/** App 会員の顧客だけにある情報 */
export interface AppInfo {
  members: { name: string; phone_last4: string | null; created_at: string }[]
  coupons: Coupon[]
}
export interface MergeRecord { event_id: number; client_id: string; name: string; created_at: string; actor_name: string | null; reservations: number }

export interface ClientLedger {
  client: ClientInfo
  app: AppInfo | null
  stats: CustomerStats
  stylists: StylistHistory[]
  /** よく利用するメニュー・商品（会計の明細から） */
  item_usage: ItemUsage[]
  next_reservation: Reservation | null
  reservations: Reservation[]
  treatments: Treatment[]
  notes: CustomerNote[]
  /** この顧客へ統合した顧客（解除できる） */
  merges: MergeRecord[]
  /** 予約から開いたときの予約（顧客一覧から開いたときはない） */
  reservation?: Reservation
}

/** 顧客一覧の1行 */
export interface ClientListRow {
  id: string
  name: string
  kana: string | null
  phone: string | null
  phone_last4: string | null
  app_linked: boolean
  visit_count: number
  last_visit: string | null
  main_stylist: string | null
  next_reservation: { starts_at: string; staff_name: string; nominated: boolean } | null
  total_sales: number
  created_via: ClientInfo['created_via']
  created_at: string
}
export interface ClientList { total: number; offset: number; rows: ClientListRow[] }
export type AppFilter = 'all' | 'app' | 'non_app'
/** 編集できる顧客情報（App 会員の情報は含まない） */
export interface ClientEdit { name: string; kana: string; phone: string }

export interface ClientCandidate {
  id: string
  name: string
  phone: string | null
  phone_last4: string | null
  created_via: ClientInfo['created_via']
  created_at: string
  app_linked: boolean
  phone_match: boolean
  last4_match: boolean
  name_match: boolean
  visit_count: number
  last_visit: string | null
}

export type CustomerResult = { ok: true } | { error: string }

export interface CustomerApi {
  open(reservationId: string): Promise<ClientLedger>
  /** 顧客一覧から開く（予約から開くときと同じ台帳） */
  ledger(clientId: string): Promise<ClientLedger>
  /** 顧客一覧（氏名・フリガナ・電話番号・電話下4桁・HOT PEPPER 予約番号で検索） */
  list(query: string, app: AppFilter, offset: number): Promise<ClientList>
  update(clientId: string, edit: ClientEdit): Promise<CustomerResult>
  /** clientId あり・検索語なし＝統合の候補。検索語あり＝名前・電話番号で探す */
  candidates(clientId: string | null, query: string): Promise<ClientCandidate[]>
  /** source を target に統合する */
  merge(targetId: string, sourceId: string): Promise<CustomerResult>
  unmerge(eventId: number): Promise<CustomerResult>
  addNote(clientId: string, note: string): Promise<CustomerResult>
}

export const CUSTOMER_ERROR_MESSAGE: Record<string, string> = {
  client_not_found: '顧客が見つかりません。',
  same_client: 'すでに同じ顧客です。',
  try_again: 'ほかの操作と重なりました。画面を開き直してください。',
  merged_again: '統合先がさらに別の顧客へ統合されています。後から行った統合を先に解除してください。',
  already_unmerged: 'この統合はすでに解除されています。',
  invalid_note: 'メモを入力してください（2000文字まで）。',
  created_by_required: '操作者を選んでください。',
  invalid_name: '氏名を入力してください（60文字まで）。',
  invalid_kana: 'フリガナは60文字までです。',
  invalid_phone: '電話番号は数字8〜15桁で入力してください。',
  not_found: '見つかりません。',
}

export function customerErrorMessage(code: string): string {
  return CUSTOMER_ERROR_MESSAGE[code] ?? '処理に失敗しました。通信環境を確認して再度お試しください。'
}

async function asResult(fn: () => Promise<unknown>): Promise<CustomerResult> {
  try {
    await fn()
    return { ok: true }
  } catch (err) {
    if (err instanceof RpcError && CUSTOMER_ERROR_MESSAGE[err.code]) return { error: err.code }
    throw err
  }
}

/** 店舗端末用。メモ・統合の記録に残る操作者名を都度渡す */
export function createStaffCustomerApi(actor: () => string): CustomerApi {
  return {
    open: id => callStaffRpc<ClientLedger>('staff_reservation_client', { p_reservation_id: id }),
    ledger: id => callStaffRpc<ClientLedger>('staff_client_ledger', { p_client_id: id }),
    list: (query, app, offset) => callStaffRpc<ClientList>('staff_list_clients', { p_query: query || null, p_app: app, p_offset: offset }),
    update: (id, e) => asResult(() => callStaffRpc('staff_update_client', { p_client_id: id, p: e, p_staff_name: actor() })),
    candidates: async (clientId, query) => (await callStaffRpc<ClientCandidate[] | null>('staff_client_candidates', { p_client_id: clientId, p_query: query || null })) ?? [],
    merge: (target, source) => asResult(() => callStaffRpc('staff_merge_clients', { p_target: target, p_source: source, p_staff_name: actor() })),
    unmerge: eventId => asResult(() => callStaffRpc('staff_unmerge_client', { p_event_id: eventId, p_staff_name: actor() })),
    addNote: (clientId, note) => asResult(() => callStaffRpc('staff_create_client_note', { p_client_id: clientId, p_note: note, p_staff_name: actor() })),
  }
}

/** 本部用。記録上の操作者は「本部」 */
export const hqCustomerApi: CustomerApi = {
  open: id => callHqRpc<ClientLedger>('hq_reservation_client', { p_reservation_id: id }),
  ledger: id => callHqRpc<ClientLedger>('hq_client_ledger', { p_client_id: id }),
  list: (query, app, offset) => callHqRpc<ClientList>('hq_list_clients', { p_query: query || null, p_app: app, p_offset: offset }),
  update: (id, e) => asResult(() => callHqRpc('hq_update_client', { p_client_id: id, p: e })),
  candidates: async (clientId, query) => (await callHqRpc<ClientCandidate[] | null>('hq_client_candidates', { p_client_id: clientId, p_query: query || null })) ?? [],
  merge: (target, source) => asResult(() => callHqRpc('hq_merge_clients', { p_target: target, p_source: source })),
  unmerge: eventId => asResult(() => callHqRpc('hq_unmerge_client', { p_event_id: eventId })),
  addNote: (clientId, note) => asResult(() => callHqRpc('hq_create_client_note', { p_client_id: clientId, p_note: note })),
}

/** 候補の一致の内容（人が判断するための表示） */
export function matchText(k: Pick<ClientCandidate, 'phone_match' | 'last4_match' | 'name_match'>): string {
  const parts = [k.phone_match ? '電話番号が一致' : k.last4_match ? '電話下4桁が一致' : null, k.name_match ? '名前が一致' : null].filter(Boolean)
  if (parts.length === 0) return '検索で一致'
  if (!k.phone_match && !k.last4_match) return '名前のみ一致（電話は未確認）'
  return parts.join('・')
}
