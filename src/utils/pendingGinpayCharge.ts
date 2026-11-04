// 店頭の銀Pay チャージで、送ったけれど結果が分からないもの（通信切れ）を端末に覚える（11/4 Sランク点検）。
//   返事が消えたあとに「やめる」や金額の選び直しでやり直すと、新しいキーになって二重にチャージされていた（Staging で再現）。
//   送る前に覚え、結果が分かったら消す。覚えている間は、同じキー・同じ内容で「結果を確かめる」だけにする。
const KEY = 'ginjiro_pending_ginpay_charge'

export interface PendingGinpayCharge {
  clientId: string
  cash: number
  memo: string
  accountId: string | null
  key: string
  at: string
}

export function readPendingCharge(): PendingGinpayCharge | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PendingGinpayCharge | null
    return v && typeof v.clientId === 'string' && typeof v.key === 'string' && typeof v.cash === 'number' ? v : null
  } catch { return null }
}

/** 送る前に覚える。覚えられなければ送らない（結果が分からなくなったときに二重チャージを防げないため） */
export function savePendingCharge(p: Omit<PendingGinpayCharge, 'at'>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, at: new Date().toISOString() }))
    return readPendingCharge()?.key === p.key
  } catch { return false }
}

export function clearPendingCharge(key: string): void {
  try { if (readPendingCharge()?.key === key) localStorage.removeItem(KEY) } catch { /* ignore */ }
}
