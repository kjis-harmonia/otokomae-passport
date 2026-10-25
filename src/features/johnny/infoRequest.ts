// V2.0：Johnny が「答えるだけ」の頼みごと。会員QR を開く・使える券・銀Pay の残高・次のメンテナンスの目安。
// お金と券を動かす操作（使う・チャージ・支払い）はここで受けない（店頭のスタッフ端末だけ）。
export type InfoRequest = 'qr' | 'tickets' | 'ginpay' | 'maintenance' | 'maintenanceChoice'

export function infoRequest(raw: string, maintenanceChoice = false): InfoRequest | null {
  const t = raw.normalize('NFKC')
  // 予約・取り消し・変更の頼みは、予約の流れに任せる
  if (/予約|キャンセル|取り消|取消|変更|ずら/.test(t)) return null
  if (/QR|会員証|男前証/i.test(t)) return 'qr'
  if (/銀Pay|銀ペイ|ぎんぺい|ギンペイ|ginpay|残高/i.test(t)) return 'ginpay'
  if (maintenanceChoice && /目安|いつ|次|時期/.test(t)) return 'maintenance'
  if (/メンテ|めんて/.test(t) && /いつ|何日|なんにち|まで|次|目安|そろそろ/.test(t)) return 'maintenance'
  // 一言だけでは、次回の目安かカットの予約か決めつけない（音声認識の句読点も許容）。
  if (/^(?:メンテ(?:ナンス)?|めんて(?:なんす)?)[\s。.!！?？、,…]*$/.test(t.trim())) return 'maintenanceChoice'
  if (/割引券|クーポン|チケット|券/.test(t) && /ある|使え|何|なに|見せ|教え|持って|残って|どれ/.test(t)) return 'tickets'
  return null
}

/** メンテナンスカットの予約先案内。取消・変更は既存予約の確認へ進める。 */
export function isMaintenanceBookingRequest(raw: string, maintenanceChoice = false): boolean {
  const t = raw.normalize('NFKC')
  return (maintenanceChoice || /メンテ|めんて/.test(t)) && /カット|かっと|予約/.test(t)
    && !/キャンセル|取り消|取消|変更|ずら/.test(t)
}
