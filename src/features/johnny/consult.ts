// 髪型の相談（「どんなパーマが似合う？」など）だけ AI に聞く。サーバーの Edge Function（johnny-style-advice）経由で、
// API キーはサーバーだけが持つ。送るのは相談の文とメニュー表（名前・時間・料金）だけで、名前・電話番号などは送らない。
// AI が決めるのは「返事の文」と「おすすめのメニュー（メニュー表の中から最大3つ）」だけ。空き・料金・予約は決めない。
import { supabase } from '../../lib/supabase'
import { getCustomerSession } from '../../utils/customerSession'
import type { MenuOption } from './menuMatcher'

export interface ConsultReply { reply: string; menuCodes: string[] }

const MAX_MESSAGE = 300

/** 使えない（未設定・通信できない・キー未登録・回数制限）ときは null */
export async function consultStylist(message: string, menus: readonly MenuOption[]): Promise<ConsultReply | null> {
  const session = getCustomerSession()
  if (!session) return null
  try {
    const { data, error } = await supabase.functions.invoke<{ reply?: unknown; menu_codes?: unknown }>('johnny-style-advice', {
      body: {
        session,
        message: message.slice(0, MAX_MESSAGE),
        menus: menus.slice(0, 80).map(m => ({ code: m.code, name: m.name, duration_min: m.duration_min, price: m.price })),
      },
    })
    if (error || !data || typeof data.reply !== 'string' || !data.reply.trim()) return null
    const known = new Set(menus.map(m => m.code))
    const codes = Array.isArray(data.menu_codes) ? data.menu_codes.filter((c): c is string => typeof c === 'string' && known.has(c)).slice(0, 3) : []
    return { reply: data.reply.trim().slice(0, 200), menuCodes: codes }
  } catch {
    return null
  }
}
