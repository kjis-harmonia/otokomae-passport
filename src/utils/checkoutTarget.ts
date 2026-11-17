// 店舗端末の会員QRの会計：どの予約の会計を開くか（11/18 Codex 監査 SR-01）。
//   お連れ様だけ受付したのに、ご本人の予約・メニュー・金額の会計が開いていた。
//   ・2名様以上・お連れ様の予約がある日は、まだ受付していない予約（confirmed）の会計を開かない
//   ・今回受付した予約（prefer）があれば、それを開く（ご本人が受付済み・未会計でも）
//   ・受付した方がまだいなければ開かず、受付してもらう
// このファイルはほかを読み込まない（試験からそのまま使う）

export interface TargetEntry { id: string; status: string; is_owner: boolean; starts_at: string }

/** 受付済みで、まだ会計していない状態 */
export const UNPAID_STATUSES = ['checked_in', 'in_service', 'awaiting_payment']

export function pickCheckoutReservation(input: {
  /** サーバーが返した今日の予約（来店登録に付いた予約など。会計済みなら null にしてから渡す） */
  fromServer: string | null
  /** 同じお客様の2件目の会計 */
  again: boolean
  /** 今回受付した予約 */
  prefer: string | null
  /** 今日のご予約（ご本人・お連れ様） */
  today: readonly TargetEntry[]
}): { reservationId: string | null; needCheckIn: boolean } {
  const { again, prefer, today } = input
  let id = again ? null : input.fromServer
  const multi = today.length >= 2 || today.some(p => !p.is_owner)
  if (id && multi && today.find(p => p.id === id)?.status === 'confirmed') id = null
  const waiting = today.filter(p => UNPAID_STATUSES.includes(p.status))
    .sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.starts_at.localeCompare(b.starts_at))
  if (prefer && waiting.some(p => p.id === prefer)) id = prefer
  if (!id) id = waiting[0]?.id ?? null
  const needCheckIn = !id && !again && multi && today.some(p => p.status === 'confirmed')
  return { reservationId: id, needCheckIn }
}
