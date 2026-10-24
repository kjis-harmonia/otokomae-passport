// 店舗端末の効果音（声つき）。ファイルは public/sounds（慶一郎さんが ElevenLabs で作成）。
// スタッフが画面を押した流れ（QR を読む・会計を確定する）の中で鳴るので、iPad でも再生できる。鳴らせない端末では黙って何もしない。
export const CUES = {
  /** お客様の QR を読み取った（来店チェックインなど）：「QRコードを読み込みました！」 */
  qr: '/sounds/qr-read.mp3',
  /** 銀Pay チャージ画面で QR を読み取った：「銀Payをチャージします！しばらくお待ちください」 */
  ginpayCharge: '/sounds/ginpay-charge.mp3',
  /** 銀Pay 払いの会計が確定した：「銀ペイ」 */
  ginpayPaid: '/sounds/ginpay-paid.mp3',
} as const

const players = new Map<keyof typeof CUES, HTMLAudioElement>()

export function playCue(kind: keyof typeof CUES): void {
  try {
    let a = players.get(kind)
    if (!a) { a = new Audio(CUES[kind]); a.preload = 'auto'; players.set(kind, a) }
    a.currentTime = 0
    void a.play().catch(() => { /* 音を出せない端末・設定 */ })
  } catch { /* Audio が使えない */ }
}
