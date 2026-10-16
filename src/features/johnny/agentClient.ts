// 予約の AI（Edge Function johnny-agent）を呼ぶ。お客様の言葉・直前の会話・画面に出している候補を送り、
// 「話す言葉」と「画面に出すもの（ui）」を受け取る。空き・予約の事実はサーバーが DB で確かめたものだけ。
// 予約の確定・キャンセル・変更は AI ではなく、確認画面で「はい」が押されたときにアプリが RPC で行う。
// 使えない（未設定・通信できない・遅すぎる・おかしな答え）ときは null → 呼び出し側は決まった規則の JOHNNY に切り替える。
import { supabase } from '../../lib/supabase'
import { getCustomerSession } from '../../utils/customerSession'

export type AgentUi =
  | { type: 'none' }
  | { type: 'handoff' }
  | { type: 'menus'; items: { menu_code: string; first_time: string | null }[]; date: string | null }
  | { type: 'slots'; menu_code: string; staff_id: string | null; times: string[] }
  | { type: 'confirm_booking'; menu_code: string; staff_id: string | null; starts_at: string }
  | { type: 'confirm_cancel'; reservation_id: string }
  | { type: 'confirm_change'; reservation_id: string; menu_code: string; staff_id: string | null; starts_at: string }
  | { type: 'reservations'; ids: string[] }

export interface AgentTurn { role: 'user' | 'assistant'; text: string }
export interface AgentShown {
  menu_code?: string
  times?: string[]
  staff_id?: string | null
  confirm?: { menu_code: string; starts_at: string; staff_id: string | null }
}
export interface AgentAnswer { say: string; ui: AgentUi }

/** 返事が来るまで待つ上限（これを過ぎたら決まった規則の JOHNNY に切り替える） */
const TIMEOUT_MS = 20000

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null)

function readUi(raw: unknown): AgentUi | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  switch (u.type) {
    case 'none': case 'handoff': return { type: u.type }
    case 'menus': {
      const items = Array.isArray(u.items) ? u.items.filter(i => isStr((i as { menu_code?: unknown })?.menu_code)).map(i => ({ menu_code: (i as { menu_code: string }).menu_code, first_time: strOrNull((i as { first_time?: unknown }).first_time) })) : []
      return items.length ? { type: 'menus', items, date: strOrNull(u.date) } : null
    }
    case 'slots': {
      const times = Array.isArray(u.times) ? u.times.filter(isStr) : []
      return isStr(u.menu_code) && times.length ? { type: 'slots', menu_code: u.menu_code, staff_id: strOrNull(u.staff_id), times } : null
    }
    case 'confirm_booking':
      return isStr(u.menu_code) && isStr(u.starts_at) ? { type: 'confirm_booking', menu_code: u.menu_code, staff_id: strOrNull(u.staff_id), starts_at: u.starts_at } : null
    case 'confirm_cancel':
      return isStr(u.reservation_id) ? { type: 'confirm_cancel', reservation_id: u.reservation_id } : null
    case 'confirm_change':
      return isStr(u.reservation_id) && isStr(u.menu_code) && isStr(u.starts_at)
        ? { type: 'confirm_change', reservation_id: u.reservation_id, menu_code: u.menu_code, staff_id: strOrNull(u.staff_id), starts_at: u.starts_at } : null
    case 'reservations': {
      const ids = Array.isArray(u.ids) ? u.ids.filter(isStr) : []
      return ids.length ? { type: 'reservations', ids } : null
    }
    default: return null
  }
}

export async function askAgent(message: string, history: readonly AgentTurn[], shown: AgentShown | undefined): Promise<AgentAnswer | null> {
  const session = getCustomerSession()
  if (!session) return null
  try {
    const call = supabase.functions.invoke<{ say?: unknown; ui?: unknown }>('johnny-agent', {
      body: { session, message: message.slice(0, 300), history: history.slice(-20), shown },
    })
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), TIMEOUT_MS))
    const res = await Promise.race([call, timeout])
    if (!res || res.error || !res.data || !isStr(res.data.say)) return null
    const ui = readUi(res.data.ui)
    return ui ? { say: res.data.say.trim().slice(0, 240), ui } : null
  } catch {
    return null
  }
}
