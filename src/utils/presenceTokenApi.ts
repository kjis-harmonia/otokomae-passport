// お客様提示 QR（GJC1 トークン）の店舗端末側クライアント。POS 画面から使う。
// QR に載るのはランダムなトークンだけ（会員・顧客・残高などは含まない）。検証と顧客の特定はサーバー（staff_resolve_presence_token）が行う。
// GJC1 形式でない読み取り（他社 QR・会員証 QR・誤読）はここで止め、RPC を呼ばない。
import { callStaffRpc } from './staffSession'

export const PRESENCE_TOKEN_PATTERN = /^GJC1\.[A-Za-z0-9_-]{43}$/

/** 読み取った文字列が GJC1 トークンの形式か（前後の空白は除いて判定） */
export function isPresenceToken(text: string): boolean {
  return PRESENCE_TOKEN_PATTERN.test(text.trim())
}

export interface PresenceScanSession {
  scan_session_id: string
  expires_at: string
  identity_method: 'token'
  client: { id: string; name: string }
  idempotent: boolean
}

export type PresenceResolveResult =
  | { ok: true; session: PresenceScanSession }
  | { ok: false; error: 'not_presence_token' | string }

/** 店舗端末：GJC1 トークンを読み取って scan session を開く。形式が違えばサーバーに送らない */
export async function resolvePresenceToken(scanned: string): Promise<PresenceResolveResult> {
  const token = scanned.trim()
  if (!isPresenceToken(token)) return { ok: false, error: 'not_presence_token' }
  const r = await callStaffRpc<PresenceScanSession | { error: string }>('staff_resolve_presence_token', { p_token: token })
  return 'error' in r ? { ok: false, error: r.error } : { ok: true, session: r }
}

export const PRESENCE_ERROR_MESSAGES: Record<string, string> = {
  not_presence_token: '銀二郎Appのお客様QRではありません。',
  invalid_token: 'このQRは使えません。お客様のAppで表示し直してください。',
  expired: 'QRの有効期限が切れています。お客様のAppで表示し直してください。',
  revoked: '新しいQRが表示されています。最新のQRを読み取ってください。',
  already_used: 'このQRは別の端末で読み取り済みです。',
  scan_session_expired: '受付の有効時間が過ぎました。QRを表示し直してください。',
  customer_session_revoked: 'お客様のAppのログインが無効です。',
  customer_not_found: 'お客様の情報が見つかりません。',
  rate_limited: '読み取りの失敗が続いたため、しばらく受け付けません。',
}
