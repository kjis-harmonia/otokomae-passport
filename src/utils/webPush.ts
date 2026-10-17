// JOHNNY のお知らせ（Web Push）を受け取るための登録。受け取り先はサーバー（customer_save_push）に保存し、
// 送るのは johnny-notify（毎日11時、メンテナンスカットの期限が近い人へ）。
// iPhone はホーム画面に追加したアプリでだけ受け取れる（Safari のままでは PushManager が無い）。
import { callCustomerRpc, getCustomerSession } from './customerSession'
import { isStandalone } from './installGuide'

/** VAPID の公開鍵（秘密鍵はサーバーの Secrets だけ） */
const VAPID_PUBLIC_KEY = 'BBQJYd10vYeZsU922Mm38NB_yhLK3Cq13BdD63kDJCAB3uDhe50HgWEa7qv0DBo-KWz3hnUnxP1k3cc2Kqs75eU'

export type PushState = 'on' | 'off' | 'denied' | 'needs-install' | 'unsupported'

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  try { return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js')) } catch { return null }
}

/** 今の状態（受け取り中・止めている・許可されていない・ホーム画面に追加が必要・使えない） */
export async function pushState(): Promise<PushState> {
  if (!isPushSupported()) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  try {
    const reg = await registration()
    const sub = await reg?.pushManager.getSubscription()
    return sub ? 'on' : 'off'
  } catch { return 'off' }
}

async function save(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON()
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error('invalid_subscription')
  await callCustomerRpc('customer_save_push', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth })
}

/** 受け取りを始める（必ずボタンを押したときに呼ぶ。許可を聞く） */
export async function turnOnPush(): Promise<PushState> {
  if (!isPushSupported()) return pushState()
  if (!getCustomerSession()) return 'off'
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off'
  const reg = await registration()
  if (!reg) return 'unsupported'
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }))
  await save(sub)
  return 'on'
}

/** 受け取りをやめる（このスマホ） */
export async function turnOffPush(): Promise<PushState> {
  const reg = isPushSupported() ? await registration() : null
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await callCustomerRpc('customer_delete_push', { p_endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe().catch(() => false)
  }
  return pushState()
}

/** 許可済みなら、受け取り先をサーバーに入れ直す（アプリを開いたとき。受け取り先は変わることがある） */
export async function refreshPushIfGranted(): Promise<void> {
  try {
    if (!isPushSupported() || Notification.permission !== 'granted' || !getCustomerSession()) return
    const reg = await registration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) await save(sub)
  } catch { /* 次に開いたときにもう一度 */ }
}
