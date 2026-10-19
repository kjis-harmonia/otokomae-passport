import type { CheckoutApi, CheckoutResult, Sale, SaleInput } from './checkoutApi'

// 未確定の会計は期限で捨てない。認証トークンは保存せず、同じ内容と取引キーだけを保持する。
export const CHECKOUT_ATTEMPT_KEY = 'ginjiro:checkout-attempt:v1'
export const CHECKOUT_LOCK = 'ginjiro:checkout-finalize:v1'
export const CHECKOUT_ATTEMPT_CHANGED = 'ginjiro:checkout-attempt-changed'
export interface CheckoutAttempt {
  version: 1
  backend: string
  input: SaleInput
  customerLabel: string
  operator: string
  createdAt: string
  result?: Sale
}
type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readCheckoutAttempt(storage: Pick<Storage, 'getItem'> = localStorage): CheckoutAttempt | null {
  const raw = storage.getItem(CHECKOUT_ATTEMPT_KEY)
  if (!raw) return null
  let value: CheckoutAttempt
  try { value = JSON.parse(raw) as CheckoutAttempt } catch { throw new Error('前の会計記録を読めません。端末のデータを消さずに管理者へ確認してください。') }
  if (value.version !== 1 || typeof value.backend !== 'string' || !value.input || typeof value.input.idempotency_key !== 'string'
    || !value.input.idempotency_key || !Array.isArray(value.input.items) || typeof value.operator !== 'string') {
    throw new Error('前の会計記録を読めません。端末のデータを消さずに管理者へ確認してください。')
  }
  return value
}

function saveAttempt(storage: AttemptStorage, value: CheckoutAttempt) {
  const text = JSON.stringify(value)
  storage.setItem(CHECKOUT_ATTEMPT_KEY, text)
  if (storage.getItem(CHECKOUT_ATTEMPT_KEY) !== text) throw new Error('会計記録を端末に保存できません。保存を許可してからお試しください。')
  notifyChange()
}

function notifyChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHECKOUT_ATTEMPT_CHANGED))
}

export function subscribeCheckoutAttempt(changed: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (!event.key || event.key === CHECKOUT_ATTEMPT_KEY) changed() }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHECKOUT_ATTEMPT_CHANGED, changed)
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHECKOUT_ATTEMPT_CHANGED, changed) }
}

export function checkoutAttemptSnapshot(): string {
  try { return localStorage.getItem(CHECKOUT_ATTEMPT_KEY) ?? '' } catch { return 'storage-unavailable' }
}

export function sameCheckout(a: CheckoutAttempt, reservationId: string | null, clientId: string | null): boolean {
  if (reservationId) return a.input.reservation_id === reservationId
  if (clientId) return !a.input.reservation_id && a.input.client_id === clientId
  // 店頭会計の入口では、前回の会計を先に解決する（別のお客様へ勝手に付け替えない）。
  return true
}

export async function withCheckoutLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('このブラウザでは安全に会計できません。SafariまたはChromeを更新してください。')
  return navigator.locks.request(CHECKOUT_LOCK, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('ほかの画面で会計を確認中です。完了してからお試しください。')
    return action()
  })
}

/** 呼び出し元がロックを保持する。例外時は保存した内容を残し、次回も同じキーで照合する。 */
export async function settleCheckout(
  api: Pick<CheckoutApi, 'backend' | 'lookup' | 'finalize'>,
  proposed: CheckoutAttempt,
  storage: AttemptStorage = localStorage,
): Promise<CheckoutResult<Sale>> {
  const old = readCheckoutAttempt(storage)
  if (!api.backend || proposed.backend !== api.backend || (old && old.backend !== api.backend)) {
    throw new Error('保存された会計と接続先が異なります。元の環境で結果を確認してください。')
  }
  let attempt = proposed
  if (old && sameCheckout(old, proposed.input.reservation_id ?? null, proposed.input.client_id ?? null)) attempt = old
  else if (old && !old.result) throw new Error('別のお客様の会計が未確認です。そのお客様の会計を先に確認してください。')
  else saveAttempt(storage, attempt)

  // 初回も入口の存在・スタッフ認証を検査する。未配置のサーバーへ決済を送らない。
  const recorded = await api.lookup(attempt.input.idempotency_key)
  if (recorded) {
    saveAttempt(storage, { ...attempt, result: recorded })
    return recorded
  }
  if (attempt.result) throw new Error('前回の会計結果を確認できません。新しく会計せず管理者へ確認してください。')

  const result = await api.finalize(attempt.input, attempt.operator)
  if ('error' in result) {
    // サーバーが同じキーの処理を直列化した上で返す、確定しなかった業務エラーのみ。
    storage.removeItem(CHECKOUT_ATTEMPT_KEY)
    notifyChange()
  } else {
    saveAttempt(storage, { ...attempt, result })
  }
  return result
}

/** 完了済み会計だけを明示的に区切る。結果不明の会計は破棄させない。 */
export async function startNextCheckout(key: string, storage: AttemptStorage = localStorage): Promise<void> {
  await withCheckoutLock(async () => {
    const old = readCheckoutAttempt(storage)
    if (!old || old.input.idempotency_key !== key) return
    if (!old.result) throw new Error('前の会計が未確認です。先に結果を確認してください。')
    storage.removeItem(CHECKOUT_ATTEMPT_KEY)
    notifyChange()
  })
}
