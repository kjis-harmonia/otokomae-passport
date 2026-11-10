// 店頭の QR のあと、銀ちゃんがまだ確かめていない来店（ご本人・お連れ様）。customer_visits_to_confirm（11/8）
import { callCustomerRpc } from '../utils/customerSession'

export type PendingVisit = { date: string; menu_code: string | null; menu_name: string | null; menu_source: string | null; maintenance: boolean }
export type PendingVisits = { owner: PendingVisit | null; companions: (PendingVisit & { id: string; name: string })[] }

export async function fetchVisitsToConfirm(): Promise<PendingVisits | null> {
  try {
    const r = await callCustomerRpc<PendingVisits>('customer_visits_to_confirm')
    return r && (r.owner || r.companions?.length) ? { owner: r.owner ?? null, companions: r.companions ?? [] } : null
  } catch { return null }
}

