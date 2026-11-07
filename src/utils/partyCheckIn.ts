// 店舗端末：会員の今日のご予約（ご本人・お連れ様）。受付の画面は components/PartyCheckIn（11/8）
import { callStaffRpc } from './staffSession'

export interface PartyEntry {
  id: string
  starts_at: string
  status: string
  is_owner: boolean
  name: string
  menu: string | null
  staff_name: string | null
}

/** 今日のご予約。読めなければ空（受付はいつもどおり予約表からできる） */
export async function fetchTodayParty(userId: string): Promise<PartyEntry[]> {
  try {
    const r = await callStaffRpc<PartyEntry[]>('staff_today_party', { p_user_id: userId })
    return Array.isArray(r) ? r : []
  } catch { return [] }
}

/** 聞く必要があるか：まだ受付していない予約があり、2名以上か、お連れ様のご予約があるとき（ご本人だけ1件はいつもどおり） */
export function partyNeedsAsk(party: readonly PartyEntry[]): boolean {
  return party.some(p => p.status === 'confirmed') && (party.length >= 2 || party.some(p => !p.is_owner))
}

