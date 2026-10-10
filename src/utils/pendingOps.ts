// 未解決の金銭操作の記録（B-2A）。送信の前に端末へ書き、サーバーの確定結果を確かめるまで消さない。
//
//   - 正本はサーバー。ここにあるのは「この端末から送ったかもしれない操作」だけで、金銭処理の根拠にはしない。
//   - 記録がある対象（顧客・予約・取引・会計）への新しい操作は止める。匿名会計が未解決なら、この端末の会計はすべて止める。
//   - 会計の対象は画面が選んだ顧客ではなく、サーバーが決める顧客（saleIdentity）。予約もスキャンも無い会計は
//     client_id を送っても匿名になるので、必ず sale:anonymous を持つ。
//   - 旧形式の会計の記録（context が無く、送った client_id を client: として持つもの）は、予約が無ければ匿名の会計として止める。
//     書き換え・削除はしない。
//   - GINPay（チャージ・返金・本部返金）は顧客ではなく口座（gpaccount:<account_id>）でも止める。顧客の統合で
//     client_id が変わっても口座 ID は変わらない。口座の分からない GINPay の記録（旧形式）が1件でもあれば、
//     どの口座の操作か照合できないので、この端末の GINPay の操作はすべて止める。口座の分からない新しい操作は記録も送信もしない。
//   - 端末内（同じ origin の複数タブ）の排他だけを保証する。別の端末との排他は B-2C（サーバー側）で行う。
//   - 保存できない・読めない・壊れている・複数タブの排他が使えないときは、送信しない（fail closed）。
//   - 保存する内容は種類ごとの許可リストで組み立てる。承認トークン・操作者トークン・PIN・見積もりハッシュは保存しない。
//   - 自動で完了・取消・削除しない。消すのは、サーバーの成功応答を確かめたときと、
//     最初の送信がサーバーで実行されなかったと分かったとき（業務エラー・rollback 済みの拒否）だけ。
//     一度「結果不明」になった記録は、業務エラーが返っても消さない（先に送った要求が後で確定し得るため）。
//   - 再読み込み・PWA 再起動では、送った内容のうち保存しない部分（見積もりハッシュなど）はメモリと一緒に失われる。

import { ANONYMOUS_SALE_TARGET, resolveSaleIdentity, type SaleContext, type SaleIdentityInput } from './saleIdentity'

export const PENDING_OPS_KEY = 'ginjiro_pos_pending_ops_v1'
export const PENDING_OPS_EVENT = 'ginjiro:pending-ops'
const LOCK_NAME = 'ginjiro-pos-pending-ops'
const ANONYMOUS_SALE = ANONYMOUS_SALE_TARGET

export type PendingKind = 'checkout' | 'ginpay_charge' | 'ginpay_refund' | 'ticket_issue' | 'hq_ginpay_refund' | 'hq_void'

export interface CheckoutSnapshot {
  /** サーバーが決める会計の顧客の種類。旧形式の記録には無い */
  context?: SaleContext
  /** サーバーが記録する予約・顧客（client_root）。旧形式の記録では送った値そのもの */
  reservationId: string | null
  clientId: string | null
  stylistId: string
  paymentMethod: string
  expectedTotal: number
  ginpayAccountId: string | null
  ticketIds: string[]
  items: { source: string; refId: string | null; category: string; unitPrice: number; quantity: number; discount: number }[]
  manualDiscount: number
}
/** accountId はチャージ先の口座。旧形式の記録では null のことがある（口座不明として扱う） */
export interface ChargeSnapshot { clientId: string; accountId: string | null; amount: number; paymentMethod: string }
/** accountId は元取引の口座。旧形式の記録には無い（口座不明として扱う） */
export interface RefundSnapshot { clientId: string; transactionId: string; accountId?: string; amount: number }
export interface TicketSnapshot { userId: string; ticketType: string; amount: number; quantity: number }
export interface VoidSnapshot { saleId: string }

interface SnapshotOf {
  checkout: CheckoutSnapshot
  ginpay_charge: ChargeSnapshot
  ginpay_refund: RefundSnapshot
  ticket_issue: TicketSnapshot
  hq_ginpay_refund: RefundSnapshot
  hq_void: VoidSnapshot
}

interface PendingBase<K extends PendingKind> {
  id: string
  kind: K
  /** サーバーへ送った冪等キー（本部の会計取消は会計 ID） */
  key: string
  targets: string[]
  amount: number
  snapshot: SnapshotOf[K]
  /** 送信した操作者（照合で同じ操作者が必要な操作がある）。トークンは保存しない */
  operatorId: string | null
  operatorName: string | null
  /** sending: 送信前に記録した／unknown: 結果不明と分かった。どちらも未解決として扱う */
  state: 'sending' | 'unknown'
  createdAt: string
}
export type PendingOp = { [K in PendingKind]: PendingBase<K> }[PendingKind]
export type PendingOpOf<K extends PendingKind> = PendingBase<K>

export type PendingStoreFailure = 'unavailable' | 'corrupt' | 'verify_failed' | 'lock_unavailable' | 'secret_detected'
  /** GINPay の操作で口座を特定できない／送る直前の口座が記録と違う（送信しない） */
  | 'account_unknown' | 'account_mismatch'

export class PendingStoreError extends Error {
  readonly reason: PendingStoreFailure
  constructor(reason: PendingStoreFailure) {
    super(`pending_store_${reason}`)
    this.name = 'PendingStoreError'
    this.reason = reason
  }
}

export class PendingBlockedError extends Error {
  readonly op: PendingOp
  constructor(op: PendingOp) {
    super('pending_operation_blocks_target')
    this.name = 'PendingBlockedError'
    this.op = op
  }
}

// ── 種類ごとの許可リスト（ここに無い項目は保存しない） ─────────────────────────

type Check = (v: unknown) => boolean
const isStr: Check = v => typeof v === 'string' && v !== ''
const isStrOrNull: Check = v => v === null || isStr(v)
const isInt: Check = v => typeof v === 'number' && Number.isSafeInteger(v)
const isStrArray: Check = v => Array.isArray(v) && v.every(isStr)
const isContext: Check = v => v === 'reservation' || v === 'scan' || v === 'anonymous'
const isItemArray: Check = v => Array.isArray(v) && v.every(i => hasExactly(i, {
  source: isStr, refId: isStrOrNull, category: isStr, unitPrice: isInt, quantity: isInt, discount: isInt,
}))

const SNAPSHOT_SCHEMA: { [K in PendingKind]: Record<keyof SnapshotOf[K], Check> } = {
  checkout: {
    context: isContext, reservationId: isStrOrNull, clientId: isStrOrNull, stylistId: isStr, paymentMethod: isStr, expectedTotal: isInt,
    ginpayAccountId: isStrOrNull, ticketIds: isStrArray, items: isItemArray, manualDiscount: isInt,
  },
  ginpay_charge: { clientId: isStr, accountId: isStrOrNull, amount: isInt, paymentMethod: isStr },
  ginpay_refund: { clientId: isStr, transactionId: isStr, accountId: isStr, amount: isInt },
  ticket_issue: { userId: isStr, ticketType: isStr, amount: isInt, quantity: isInt },
  hq_ginpay_refund: { clientId: isStr, transactionId: isStr, accountId: isStr, amount: isInt },
  hq_void: { saleId: isStr },
}

const RECORD_SCHEMA: Record<keyof PendingBase<PendingKind>, Check> = {
  id: isStr,
  kind: v => typeof v === 'string' && v in SNAPSHOT_SCHEMA,
  key: isStr,
  targets: v => isStrArray(v) && (v as string[]).length > 0,
  amount: isInt,
  snapshot: () => true, // 種類ごとに下で確かめる
  operatorId: isStrOrNull,
  operatorName: isStrOrNull,
  state: v => v === 'sending' || v === 'unknown',
  createdAt: v => isStr(v) && !Number.isNaN(Date.parse(v as string)),
}

function hasExactly(value: unknown, schema: Record<string, Check>): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  const want = Object.keys(schema)
  return keys.length === want.length && want.every(k => keys.includes(k) && schema[k]((value as Record<string, unknown>)[k]))
}

const without = (schema: Record<string, Check>, key: string): Record<string, Check> =>
  Object.fromEntries(Object.entries(schema).filter(([k]) => k !== key))
const LEGACY_CHECKOUT_SCHEMA = without(SNAPSHOT_SCHEMA.checkout, 'context')
const LEGACY_REFUND_SCHEMA = without(SNAPSHOT_SCHEMA.ginpay_refund, 'accountId')

const GINPAY_KINDS: readonly PendingKind[] = ['ginpay_charge', 'ginpay_refund', 'hq_ginpay_refund']
const ACCOUNT_PREFIX = 'gpaccount:'

function isPendingOp(value: unknown): value is PendingOp {
  if (!hasExactly(value, RECORD_SCHEMA)) return false
  const op = value as PendingOp
  if (op.id !== pendingId(op.kind, op.key)) return false
  switch (op.kind) {
    case 'checkout':
      if (hasExactly(op.snapshot, LEGACY_CHECKOUT_SCHEMA)) return true
      return hasExactly(op.snapshot, SNAPSHOT_SCHEMA.checkout) && checkoutTargetsConsistent(op.targets, op.snapshot)
    case 'ginpay_refund':
    case 'hq_ginpay_refund':
      // 旧形式（口座なし）は読めるが口座不明として扱う。口座があるなら対象にも同じ口座が必要
      if (hasExactly(op.snapshot, LEGACY_REFUND_SCHEMA)) return !hasAccountTarget(op.targets)
      return hasExactly(op.snapshot, SNAPSHOT_SCHEMA[op.kind]) && accountTargetsConsistent(op.targets, op.snapshot.accountId ?? null)
    case 'ginpay_charge':
      return hasExactly(op.snapshot, SNAPSHOT_SCHEMA.ginpay_charge) && accountTargetsConsistent(op.targets, op.snapshot.accountId)
    default:
      return hasExactly(op.snapshot, SNAPSHOT_SCHEMA[op.kind])
  }
}

function hasAccountTarget(targets: readonly string[]): boolean {
  return targets.some(t => t.startsWith(ACCOUNT_PREFIX))
}

/** 口座の対象は記録した口座1つだけ（口座が無い記録は口座の対象を持たない） */
function accountTargetsConsistent(targets: readonly string[], accountId: string | null): boolean {
  const accounts = targets.filter(t => t.startsWith(ACCOUNT_PREFIX))
  return accountId === null ? accounts.length === 0 : accounts.length === 1 && accounts[0] === target.account(accountId)
}

/** 口座の分からない GINPay の記録（旧形式）。どの口座の操作か照合できない */
export function isAccountlessGinpay(op: PendingOp): boolean {
  return GINPAY_KINDS.includes(op.kind) && !hasAccountTarget(op.targets)
}

/** 新しい形式の会計の記録は、種類と対象が食い違っていない（食い違えば壊れた記録として止める） */
function checkoutTargetsConsistent(targets: readonly string[], s: CheckoutSnapshot): boolean {
  switch (s.context) {
    case 'anonymous': return s.reservationId === null && s.clientId === null && targets.includes(ANONYMOUS_SALE)
    case 'reservation': return s.reservationId !== null && targets.includes(target.reservation(s.reservationId))
      && (s.clientId === null || targets.includes(target.client(s.clientId)))
    case 'scan': return s.reservationId === null && s.clientId !== null && targets.includes(target.client(s.clientId))
    default: return false
  }
}

/** 会計の記録の顧客の種類。旧形式は予約が無ければ匿名（予約もスキャンも無い会計はサーバーで匿名になる） */
export function checkoutContextOf(s: CheckoutSnapshot): SaleContext {
  return s.context ?? (s.reservationId ? 'reservation' : 'anonymous')
}

/** 匿名の会計の記録（旧形式で client: だけを持つものを含む） */
export function isAnonymousCheckout(op: PendingOp): boolean {
  return op.kind === 'checkout' && (op.targets.includes(ANONYMOUS_SALE) || checkoutContextOf(op.snapshot) === 'anonymous')
}

export function pendingId(kind: PendingKind, key: string): string {
  return `${kind}:${key}`
}

// ── 対象（同じ対象への新しい操作を止める単位） ────────────────────────────────

export const target = {
  client: (id: string) => `client:${id}`,
  reservation: (id: string) => `reservation:${id}`,
  user: (id: string) => `user:${id}`,
  transaction: (id: string) => `gtx:${id}`,
  sale: (id: string) => `sale:${id}`,
  /** GINPay 口座（顧客を統合しても変わらない） */
  account: (id: string) => `${ACCOUNT_PREFIX}${id}`,
  anonymousSale: ANONYMOUS_SALE,
}

/** 会計の対象。サーバーが決める顧客で止める（画面で選んだ client_id ではない） */
export function checkoutTargets(input: SaleIdentityInput, reservationClientId?: string | null): string[] {
  return resolveSaleIdentity(input, reservationClientId).targets
}

/** 新しい操作を止める未解決の記録（無ければ null） */
export function findBlockingOp(ops: readonly PendingOp[], kind: PendingKind, targets: readonly string[]): PendingOp | null {
  return ops.find(op =>
    op.targets.some(t => targets.includes(t)) ||
    // 匿名会計（旧形式を含む）が未解決なら、同じ端末の会計はすべて止める（どの客の会計か照合できないため）
    (kind === 'checkout' && isAnonymousCheckout(op)) ||
    // 口座の分からない GINPay の記録が未解決なら、同じ端末の GINPay の操作はすべて止める（統合後の同じ口座を照合できないため）
    (GINPAY_KINDS.includes(kind) && isAccountlessGinpay(op)),
  ) ?? null
}

// ── 読み書き ───────────────────────────────────────────────────────────────

interface Envelope { v: 1; ops: PendingOp[] }

function parse(raw: string | null): PendingOp[] {
  if (raw === null) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new PendingStoreError('corrupt')
  }
  if (!hasExactly(data, { v: v => v === 1, ops: v => Array.isArray(v) })) throw new PendingStoreError('corrupt')
  const ops = (data as Envelope).ops
  if (!ops.every(isPendingOp)) throw new PendingStoreError('corrupt')
  if (new Set(ops.map(o => o.id)).size !== ops.length) throw new PendingStoreError('corrupt')
  return ops
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(PENDING_OPS_KEY)
  } catch {
    throw new PendingStoreError('unavailable')
  }
}

/** 端末の記録を読む。読めない・壊れているときは PendingStoreError */
export function readPendingOps(): PendingOp[] {
  return parse(readRaw())
}

function writeVerified(ops: PendingOp[]): void {
  const serialized = JSON.stringify({ v: 1, ops } satisfies Envelope)
  try {
    localStorage.setItem(PENDING_OPS_KEY, serialized)
  } catch {
    throw new PendingStoreError('unavailable')
  }
  // 書いたものを読み戻して一致を確かめる（容量不足・別タブの上書き・ブラウザの拒否を見逃さない）
  if (readRaw() !== serialized) throw new PendingStoreError('verify_failed')
  parse(serialized)
  notify()
}

interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>
}

function lockManager(): LockManagerLike | null {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: LockManagerLike }) : undefined
  return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null
}

/** 端末内（複数タブを含む）で記録の読み書きを1つずつにする。排他が使えない端末では送信しない */
async function withLock<T>(fn: () => T): Promise<T> {
  const locks = lockManager()
  if (!locks) throw new PendingStoreError('lock_unavailable')
  return locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => fn())
}

// ── メモリ（この画面のプロセスだけ。保存しない送信内容と、送信中かどうか） ───────────

const memory = new Map<string, { input: unknown; inFlight: boolean; unknown: boolean }>()

/** 送った内容そのもの（見積もりハッシュ等を含む）を、同じ内容で確認するためにメモリにだけ置く */
export function getPendingInput<T>(id: string): T | null {
  return (memory.get(id)?.input as T | undefined) ?? null
}

/** この画面から送信中か（別タブ・再読み込み前の送信は含まない） */
export function isPendingInFlight(id: string): boolean {
  return memory.get(id)?.inFlight ?? false
}

export function setPendingInFlight(id: string, inFlight: boolean): void {
  const m = memory.get(id)
  if (m) {
    m.inFlight = inFlight
    notify()
  }
}

// ── 公開操作 ─────────────────────────────────────────────────────────────

export type PendingDraft = Omit<PendingOp, 'id' | 'state' | 'createdAt'>

/**
 * 送信の前に記録する。同じ対象に未解決の記録があれば PendingBlockedError、
 * 保存・読み戻し・排他に失敗すれば PendingStoreError。どちらの場合も送信してはいけない。
 * secrets（承認・操作者トークン、見積もりハッシュ）が保存内容に紛れていないことも確かめる。
 */
export async function beginPendingOp(draft: PendingDraft, input: unknown, secrets: readonly (string | null | undefined)[]): Promise<PendingOp> {
  const op = {
    id: pendingId(draft.kind, draft.key),
    kind: draft.kind,
    key: draft.key,
    targets: [...draft.targets],
    amount: draft.amount,
    snapshot: draft.snapshot,
    operatorId: draft.operatorId,
    operatorName: draft.operatorName,
    state: 'sending',
    createdAt: new Date().toISOString(),
  } as PendingOp
  if (!isPendingOp(op)) throw new PendingStoreError(GINPAY_KINDS.includes(draft.kind) ? 'account_unknown' : 'corrupt')
  if (isAccountlessGinpay(op)) throw new PendingStoreError('account_unknown')
  const serialized = JSON.stringify(op)
  if (/(APR1|AUTH1|QTE1)\./.test(serialized) || secrets.some(s => !!s && serialized.includes(s))) {
    throw new PendingStoreError('secret_detected')
  }
  await withLock(() => {
    const ops = readPendingOps()
    const blocking = findBlockingOp(ops, op.kind, op.targets)
    if (blocking) throw new PendingBlockedError(blocking)
    writeVerified([...ops, op])
    memory.set(op.id, { input, inFlight: true, unknown: false })
  })
  return op
}

/**
 * 送る直前に、もう一度だけ端末の記録を確かめる（記録から送信までの間に、別タブ・旧版の画面・保存領域の書き換えで
 * 状況が変わっていないか）。Web Locks の中で読むので、確認の途中で別タブが書くことはない。
 *   - この画面が記録した送信中の記録が、記録したときのまま残っている
 *   - GINPay は、送る口座 accountId が記録した口座と同じ
 *   - ほかの未解決の記録が、同じ対象（顧客・取引・口座、口座不明の GINPay を含む）を止めていない
 * どれかが崩れていれば送信しない（PendingStoreError / PendingBlockedError）。記録は呼び出し元が not_executed で消す。
 */
export async function assertPendingSendable(id: string, accountId?: string | null): Promise<void> {
  await withLock(() => {
    const ops = readPendingOps()
    const op = ops.find(o => o.id === id)
    if (!op || op.state !== 'sending' || !memory.get(id)?.inFlight) throw new PendingStoreError('verify_failed')
    if (GINPAY_KINDS.includes(op.kind)) {
      const recorded = (op.snapshot as ChargeSnapshot | RefundSnapshot).accountId ?? null
      if (recorded === null || isAccountlessGinpay(op)) throw new PendingStoreError('account_unknown')
      if (accountId !== recorded) throw new PendingStoreError('account_mismatch')
    }
    const blocking = findBlockingOp(ops.filter(o => o.id !== id), op.kind, op.targets)
    if (blocking) throw new PendingBlockedError(blocking)
  })
}

/** 結果不明になった。記録は残したまま状態だけ変える（保存に失敗しても sending のまま未解決として残る） */
export async function markPendingUnknown(id: string): Promise<void> {
  const m = memory.get(id)
  if (m) {
    m.unknown = true
    m.inFlight = false
  }
  try {
    await withLock(() => {
      const ops = readPendingOps()
      if (!ops.some(o => o.id === id)) return
      writeVerified(ops.map(o => (o.id === id ? { ...o, state: 'unknown' as const } : o)))
    })
  } catch {
    notify()
  }
}

/**
 * 記録を消す。
 *   server_confirmed: サーバーの成功応答（必要な項目を確かめたもの）を受け取った
 *   not_executed: まだ一度も結果不明になっていない送信が、業務エラー・rollback 済みの拒否で返った
 * 結果不明になった記録を not_executed で消すことはできない（先の要求が後で確定し得る）。
 */
export async function settlePendingOp(id: string, proof: 'server_confirmed' | 'not_executed'): Promise<void> {
  await withLock(() => {
    const ops = readPendingOps()
    const op = ops.find(o => o.id === id)
    if (proof === 'not_executed' && (memory.get(id)?.unknown || op?.state === 'unknown' || !memory.has(id))) {
      throw new Error('pending_unknown_cannot_be_dropped')
    }
    if (op) writeVerified(ops.filter(o => o.id !== id))
    memory.delete(id)
  })
  notify()
}

// ── 画面への通知 ──────────────────────────────────────────────────────────

export interface PendingView {
  ops: PendingOp[]
  /** 読めない・壊れている・排他が使えない（すべての金銭操作を止める） */
  failure: PendingStoreFailure | null
}

let cachedRaw: string | null | undefined
let cachedView: PendingView = { ops: [], failure: null }
let cachedFailure: PendingStoreFailure | null = null
let version = 0
let cachedVersion = -1

function notify(): void {
  version += 1
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof Event === 'function') {
    window.dispatchEvent(new Event(PENDING_OPS_EVENT))
  }
}

/** useSyncExternalStore 用。内容が変わらない限り同じオブジェクトを返す */
export function getPendingView(): PendingView {
  let raw: string | null
  let failure: PendingStoreFailure | null = lockManager() ? null : 'lock_unavailable'
  try {
    raw = readRaw()
  } catch {
    raw = null
    failure = 'unavailable'
  }
  if (raw === cachedRaw && failure === cachedFailure && version === cachedVersion) return cachedView
  let ops: PendingOp[] = []
  if (failure !== 'unavailable') {
    try {
      ops = parse(raw)
    } catch (err) {
      failure = err instanceof PendingStoreError ? err.reason : 'corrupt'
    }
  }
  cachedRaw = raw
  cachedFailure = failure
  cachedVersion = version
  cachedView = { ops, failure }
  return cachedView
}

export function subscribePendingOps(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === PENDING_OPS_KEY) { version += 1; callback() } }
  window.addEventListener(PENDING_OPS_EVENT, callback)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PENDING_OPS_EVENT, callback)
    window.removeEventListener('storage', onStorage)
  }
}

// ── 文言 ───────────────────────────────────────────────────────────────

const KIND_LABEL: Record<PendingKind, string> = {
  checkout: '会計',
  ginpay_charge: 'GINPayチャージ',
  ginpay_refund: 'GINPay返金',
  ticket_issue: 'チケット発行',
  hq_ginpay_refund: 'GINPay返金（本部）',
  hq_void: '会計の取消',
}

export function pendingLabel(op: PendingOp): string {
  return `${KIND_LABEL[op.kind]} ¥${op.amount.toLocaleString()}`
}

/** 記録が理由で操作できないときの案内（「再度お試しください」とは言わない） */
export function pendingBlockMessage(op: PendingOp): string {
  return `${pendingLabel(op)}の処理結果を確認できていません。二重処理を防ぐため、確認が済むまでこの対象の新しい操作はできません。`
}

export function pendingStoreMessage(failure: PendingStoreFailure): string {
  switch (failure) {
    case 'lock_unavailable': return 'この端末のブラウザでは二重処理を防ぐ仕組みが使えないため、金銭の操作を止めています。本部に連絡してください。'
    case 'account_unknown': return 'GINPay口座を特定できないため、送信していません。口座を確認してください。'
    case 'account_mismatch': return 'GINPay口座が記録した内容と一致しないため、送信していません。画面を開き直してください。'
    default: return '端末に保存した処理記録を読み書きできないため、金銭の操作を止めています。本部に連絡してください。'
  }
}

/** 口座の分からない GINPay の記録が理由で止めているときの案内 */
export function accountlessBlockMessage(op: PendingOp): string {
  return `${pendingLabel(op)}（口座の記録が無い以前の処理）の結果を確認できていないため、この端末のGINPayの操作を止めています。本部に連絡してください。`
}

/** begin の失敗を画面の文言にする */
export function pendingErrorMessage(err: unknown): string {
  if (err instanceof PendingBlockedError) return isAccountlessGinpay(err.op) ? accountlessBlockMessage(err.op) : pendingBlockMessage(err.op)
  if (err instanceof PendingStoreError) return pendingStoreMessage(err.reason)
  return '処理記録を保存できなかったため、送信していません。'
}
