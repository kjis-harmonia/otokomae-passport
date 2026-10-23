// SB のお知らせ：AI 予約が入ったら「予約が入りました」を、この端末で受け取る（Web Push）。
// 受け取り先はサーバー（staff_save_push）に保存し、送るのは johnny-notify（毎分の見回り）。
// iPad・iPhone はホーム画面に追加した SB でだけ受け取れる。お知らせの音は端末の通知音（ここでは変えられない）。
// SB を開いているときは、画面で「ピコーン」を鳴らす（sbChime）。
import { callStaffRpc } from './sbRpc'

const VAPID_PUBLIC_KEY = 'BBQJYd10vYeZsU922Mm38NB_yhLK3Cq13BdD63kDJCAB3uDhe50HgWEa7qv0DBo-KWz3hnUnxP1k3cc2Kqs75eU'

export type SbPushState = 'on' | 'off' | 'denied' | 'needs-install' | 'unsupported'

// この端末で SB の受け取りを止めたか。端末の受け取り口（PushSubscription）はお客様アプリの JOHNNY と共有のことがあるので、
// 止めるときは消さずに、サーバーの登録だけ外してここに覚える
const OFF_KEY = 'ginjiro_sb_push_off'
const offHere = () => { try { return localStorage.getItem(OFF_KEY) === '1' } catch { return false } }
const setOffHere = (off: boolean) => { try { if (off) localStorage.setItem(OFF_KEY, '1'); else localStorage.removeItem(OFF_KEY) } catch { /* 保存できない端末 */ } }

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

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

async function save(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON()
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error('invalid_subscription')
  await callStaffRpc('staff_save_push', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_label: isIOS() ? 'iPad/iPhone' : 'PC/Android' })
}

export async function sbPushState(): Promise<SbPushState> {
  if (!supported()) return isIOS() && !standalone() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted' || offHere()) return 'off'
  try { return (await (await registration())?.pushManager.getSubscription()) ? 'on' : 'off' } catch { return 'off' }
}

/** 受け取りを始める（必ずボタンを押したときに呼ぶ。許可を聞く） */
export async function sbPushOn(): Promise<SbPushState> {
  if (!supported()) return sbPushState()
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off'
  const reg = await registration()
  if (!reg) return 'unsupported'
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }))
  await save(sub)
  setOffHere(false)
  return 'on'
}

export async function sbPushOff(): Promise<SbPushState> {
  const sub = supported() ? await (await registration())?.pushManager.getSubscription() : null
  if (sub) await callStaffRpc('staff_delete_push', { p_endpoint: sub.endpoint })
  setOffHere(true)
  return sbPushState()
}

/** 許可済みなら、受け取り先をサーバーに入れ直す（SB を開いたとき。受け取り先は変わることがある） */
export async function sbPushRefresh(): Promise<void> {
  try {
    if (!supported() || Notification.permission !== 'granted' || offHere()) return
    const sub = await (await registration())?.pushManager.getSubscription()
    if (sub) await save(sub)
  } catch { /* 次に開いたときにもう一度 */ }
}
