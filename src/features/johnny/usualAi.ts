// 登録直後の「いつものメニュー」決めで、銀ちゃん（AI）に聞く（johnny-agent の mode: usual・11/8）
//   返事は「セリフ」と「候補の menu_code」「導線」だけ。登録はアプリが確かめてから。使えないときは null（決まった規則で続ける）
import { supabase } from '../../lib/supabase'
import { getCustomerSession } from '../../utils/customerSession'
import type { AgentTurn } from './agentClient'

export interface UsualAiReply {
  say: string
  menu_code: string | null
  options: string[]
  action: 'hotpepper' | 'phone' | 'list' | null
}

const TIMEOUT_MS = 15000

export async function askUsualAi(message: string, history: readonly AgentTurn[], opts: { visited: boolean; who: string | null }): Promise<UsualAiReply | null> {
  const session = getCustomerSession()
  if (!session) return null
  try {
    const call = supabase.functions.invoke<Partial<UsualAiReply>>('johnny-agent', {
      body: { mode: 'usual', session, message: message.slice(0, 200), history: history.slice(-12), visited: opts.visited, who: opts.who },
    })
    const res = await Promise.race([call, new Promise<null>(r => setTimeout(() => r(null), TIMEOUT_MS))])
    const d = res && !res.error ? res.data : null
    if (!d || typeof d.say !== 'string' || !d.say.trim()) return null
    return {
      say: d.say.trim().slice(0, 120),
      menu_code: typeof d.menu_code === 'string' ? d.menu_code : null,
      options: Array.isArray(d.options) ? d.options.filter((c): c is string => typeof c === 'string').slice(0, 4) : [],
      action: d.action === 'hotpepper' || d.action === 'phone' || d.action === 'list' ? d.action : null,
    }
  } catch { return null }
}
