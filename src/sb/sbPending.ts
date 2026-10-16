import type { SbCommand, SbPending } from './sbTypes'
import type { SbOutcome } from './sbApi'

export const SB_PENDING_KEY = 'ginjiro_sb_pending_v1'
const LOCK = 'ginjiro_sb_send_v1'
const EVENT = 'ginjiro:sb-pending'
export interface PendingState { pending: SbPending | null; error: 'storage_error' | null }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const fail = (code: string): never => { throw new Error(code) }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

function validCommand(c: unknown): c is SbCommand {
  if (!object(c) || typeof c.kind !== 'string') return false
  if (c.kind !== 'create' && (typeof c.reservation_id !== 'string' || !UUID.test(c.reservation_id)
    || typeof c.expected_updated_at !== 'string' || !Number.isFinite(Date.parse(c.expected_updated_at)))) return false
  if (c.kind === 'create' || c.kind === 'edit') {
    const p = c.input
    return object(p) && typeof p.customer_name === 'string' && p.customer_name.trim().length > 0
      && typeof p.starts_at === 'string' && Number.isFinite(Date.parse(p.starts_at))
      && (p.staff_id === null || typeof p.staff_id === 'string' && UUID.test(p.staff_id))
      && Array.isArray(p.menu_codes) && p.menu_codes.length > 0 && p.menu_codes.length <= 5 && p.menu_codes.every(x => typeof x === 'string')
      && ['phone', 'hotpepper', 'staff'].includes(String(p.source))
      && typeof c.plan_hash === 'string' && /^[a-f0-9]{64}$/.test(c.plan_hash)
  }
  if (c.kind === 'cancel') return typeof c.reason === 'string'
  if (c.kind === 'transfer') return ['pending', 'done', 'not_required'].includes(String(c.transfer_status))
  if (c.kind === 'status') return ['checked_in', 'completed', 'no_show'].includes(String(c.status))
  return false
}
function validPending(p: unknown): p is SbPending {
  return object(p) && p.version === 1 && typeof p.id === 'string' && UUID.test(p.id)
    && typeof p.actor === 'string' && p.actor.trim().length > 0 && typeof p.saved_at === 'string'
    && Number.isFinite(Date.parse(p.saved_at)) && validCommand(p.command)
}
function freeze<T>(x: T): T {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }
  return x
}

/** Dependency injection lets tests exercise the real storage/locking behavior. */
export function createSbPendingStore(storage: () => Storage, locks: () => LockManager | undefined, notify: () => void, uuid = () => crypto.randomUUID()) {
  let cacheRaw: string | null | undefined
  let cache: PendingState = { pending: null, error: null }
  function read(): PendingState {
    let raw: string | null
    try { raw = storage().getItem(SB_PENDING_KEY) } catch { raw = '!storage_error' }
    if (!locks()) raw = '!storage_error'
    if (raw === cacheRaw) return cache
    cacheRaw = raw
    try {
      if (raw === '!storage_error') throw new Error()
      const pending: unknown = raw ? JSON.parse(raw) : null
      if (pending !== null && !validPending(pending)) throw new Error()
      cache = { pending: pending === null ? null : freeze(pending), error: null }
    } catch { cache = { pending: null, error: 'storage_error' } }
    return cache
  }
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const manager = locks()
    if (!manager) return fail('storage_error')
    return manager.request(LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) return fail('request_busy')
      if (read().error) return fail('storage_error')
      return fn()
    })
  }
  async function send(pending: SbPending, rpc: (p: SbPending) => Promise<SbOutcome>) {
    // Read again under the browser lock immediately before sending.
    const current = read()
    if (current.error || JSON.stringify(current.pending) !== JSON.stringify(pending)) return fail('storage_error')
    const result = await rpc(freeze(JSON.parse(JSON.stringify(pending)) as SbPending))
    if (result.ok || result.terminal) {
      if (read().error || read().pending?.id !== pending.id) return fail('storage_error')
      try {
        storage().removeItem(SB_PENDING_KEY)
        if (storage().getItem(SB_PENDING_KEY) !== null) return fail('storage_error')
      } catch { return fail('storage_error') }
      notify()
    }
    return result
  }
  return {
    read,
    start: (command: SbCommand, actor: string, rpc: (p: SbPending) => Promise<SbOutcome>) => locked(async () => {
      if (read().pending) return fail('pending_exists')
      const pending: SbPending = JSON.parse(JSON.stringify({ version: 1, id: uuid(), actor, command, saved_at: new Date().toISOString() }))
      if (!validPending(pending)) return fail('storage_error')
      try {
        const raw = JSON.stringify(pending)
        storage().setItem(SB_PENDING_KEY, raw)
        if (storage().getItem(SB_PENDING_KEY) !== raw) return fail('storage_error')
      } catch { return fail('storage_error') }
      notify()
      return send(pending, rpc)
    }),
    retry: (id: string, rpc: (p: SbPending) => Promise<SbOutcome>) => locked(async () => {
      const pending = read().pending
      if (!pending || pending.id !== id) return fail('pending_exists')
      return send(pending, rpc)
    }),
  }
}

const notify = () => window.dispatchEvent(new Event(EVENT))
export const sbPending = createSbPendingStore(() => localStorage, () => navigator.locks, notify)
export function subscribeSbPending(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === SB_PENDING_KEY || e.key === null) listener() }
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', onStorage) }
}
