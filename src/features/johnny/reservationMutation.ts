import type { CustomerReservation } from './bookingAssistantApi'

export type Confirmation = {
  version: 'RESERVATION_REVIEW_V1'
  old: { id: string; companion_id: string | null; starts_at: string; items: { menu_code: string; name: string }[] }
  [key: string]: unknown
}
export type MutationRequest = {
  kind: 'change' | 'cancel'
  reservation_id: string
  starts_at: string | null
  menu_codes: string[]
  confirmation: Confirmation
}
export type PendingMutation = { version: 1; key: string; request: MutationRequest }
export type MutationResult = CustomerReservation & { changed_from?: string; ginpay_released?: number; ai_paused_until?: string }
export type MutationReply =
  | { state: 'completed'; request: MutationRequest; result: MutationResult }
  | { state: 'rejected'; request: MutationRequest; code: string }
  | { state: 'unknown' | 'conflict'; code?: string }
type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (record(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
export function validRequest(v: unknown): v is MutationRequest {
  if (!record(v) || !['change', 'cancel'].includes(String(v.kind)) || !uuid(v.reservation_id) || !record(v.confirmation)) return false
  const c = v.confirmation
  if (c.version !== 'RESERVATION_REVIEW_V1' || !record(c.old) || c.old.id !== v.reservation_id || !(c.old.companion_id === null || uuid(c.old.companion_id))
    || typeof c.old.starts_at !== 'string' || !Number.isFinite(Date.parse(c.old.starts_at))
    || !Array.isArray(c.old.items) || c.old.items.some(i => !record(i) || typeof i.menu_code !== 'string' || typeof i.name !== 'string')) return false
  if (!Array.isArray(v.menu_codes) || v.menu_codes.some(c => typeof c !== 'string' || !c) || new Set(v.menu_codes).size !== v.menu_codes.length) return false
  return v.kind === 'cancel' ? v.starts_at === null && v.menu_codes.length === 0
    : typeof v.starts_at === 'string' && Number.isFinite(Date.parse(v.starts_at)) && v.menu_codes.length > 0 && v.menu_codes.length <= 5
}
export function sameRequest(a: MutationRequest, b: MutationRequest): boolean {
  const normalized = (r: MutationRequest) => ({ ...r, starts_at: r.starts_at === null ? null : new Date(r.starts_at).toISOString() })
  return validRequest(a) && validRequest(b) && canonical(normalized(a)) === canonical(normalized(b))
}
export function matchesResult(p: PendingMutation, r: unknown): r is MutationResult {
  if (!record(r) || !uuid(r.id) || r.companion_id !== p.request.confirmation.old.companion_id || !Array.isArray(r.items)) return false
  if (p.request.kind === 'cancel') return r.id === p.request.reservation_id && r.status === 'cancelled'
    && typeof r.ginpay_released === 'number' && Number.isSafeInteger(r.ginpay_released) && r.ginpay_released >= 0
  return r.status === 'confirmed' && r.changed_from === p.request.reservation_id && r.id !== p.request.reservation_id
    && typeof r.starts_at === 'string' && Date.parse(r.starts_at) === Date.parse(p.request.starts_at!)
    && r.items.every(i => record(i) && typeof i.name === 'string')
    && canonical(r.items.map(i => record(i) ? i.menu_code : null)) === canonical(p.request.menu_codes)
}

/** Persist business facts only. Customer bearer tokens never enter this record. */
export class ReservationMutationClient {
  private readonly rpc: Rpc
  private readonly store: Store
  private readonly owner: () => string | null
  private readonly account: string
  private readonly slot: string
  private busy = false
  private last: PendingMutation | null = null
  constructor(rpc: Rpc, store: Store, owner: () => string | null) {
    this.rpc = rpc; this.store = store; this.owner = owner
    const account = owner()
    if (!account) throw new Error('customer_required')
    this.account = account
    this.slot = 'ginjiro_reservation_mutation_v1:' + account
  }
  private assertOwner() { if (this.owner() !== this.account) throw new Error('account_changed') }
  pending(): PendingMutation | null {
    this.assertOwner()
    const raw = this.store.getItem(this.slot)
    if (raw === null) return null
    let p: unknown
    try { p = JSON.parse(raw) } catch { throw new Error('pending_corrupt') }
    if (!record(p) || p.version !== 1 || typeof p.key !== 'string' || p.key.length < 8 || !validRequest(p.request)) throw new Error('pending_corrupt')
    this.last = p as PendingMutation
    return this.last
  }
  begin(request: MutationRequest): PendingMutation {
    if (!validRequest(request)) throw new Error('invalid_request')
    const had = this.pending()
    if (had) {
      if (!sameRequest(had.request, request)) throw new Error('pending_other_request')
      return had
    }
    const copy: MutationRequest = JSON.parse(JSON.stringify(request))
    if (copy.starts_at !== null) copy.starts_at = new Date(copy.starts_at).toISOString()
    const p: PendingMutation = { version: 1, key: crypto.randomUUID(), request: copy }
    const raw = JSON.stringify(p)
    this.store.setItem(this.slot, raw)
    if (this.store.getItem(this.slot) !== raw) throw new Error('storage_unavailable')
    this.last = p
    return p
  }
  private accept(p: PendingMutation, raw: unknown): MutationReply {
    this.assertOwner()
    if (!record(raw)) return { state: 'unknown' }
    if (raw.state === 'conflict') return { state: 'conflict', code: typeof raw.code === 'string' ? raw.code : undefined }
    if (!validRequest(raw.request) || !sameRequest(p.request, raw.request)) return { state: 'unknown' }
    if (raw.state === 'completed' && !matchesResult(p, raw.result)) return { state: 'unknown' }
    if (raw.state !== 'completed' && !(raw.state === 'rejected' && typeof raw.code === 'string')) return { state: 'unknown' }
    // A terminal server receipt also fences delayed copies of this request.
    const current = this.pending()
    if (!current) return raw as MutationReply // Another mounted view may already have consumed this exact receipt.
    if (current.key !== p.key || !sameRequest(current.request, p.request)) return { state: 'unknown' }
    this.store.removeItem(this.slot)
    if (this.store.getItem(this.slot) !== null) throw new Error('storage_unavailable')
    return raw as MutationReply
  }
  async check(): Promise<MutationReply> {
    const p = this.pending() ?? this.last
    if (!p) return { state: 'unknown' }
    try { return this.accept(p, await this.rpc('customer_reservation_mutation_result', { p_idem_key: p.key, p_request: p.request })) }
    catch { return { state: 'unknown' } }
  }
  async send(): Promise<MutationReply> {
    if (this.busy) return { state: 'unknown' }
    const p = this.pending()
    if (!p) throw new Error('pending_required')
    this.busy = true
    try {
      const r = p.request
      const raw = await this.rpc(r.kind === 'change' ? 'customer_change_reservation' : 'customer_cancel_reservation_checked', {
        p_reservation_id: r.reservation_id, p_idem_key: p.key, p_confirmation: r.confirmation,
        ...(r.kind === 'change' ? { p_starts_at: r.starts_at, p_menu_codes: r.menu_codes } : {}),
      })
      return this.accept(p, raw)
    } catch { return this.check() }
    finally { this.busy = false }
  }
}

/** A time-only change keeps every ordered menu, including menus absent from today's options. */
export const reservationMenuCodes = (r: Pick<CustomerReservation, 'items'>): string[] => r.items.map(i => i.menu_code)
