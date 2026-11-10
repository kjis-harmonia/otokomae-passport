// 登録直後の「いつものメニュー」決めで、銀ちゃん（AI）に聞く（johnny-agent の mode: usual・11/8）
//   返事は「セリフ」と「候補の menu_code」「導線」だけ。登録はアプリが確かめてから。使えないときは null（決まった規則で続ける）
import { politeText } from '../../v2/politeText'
import { supabase } from '../../lib/supabase'
import { getCustomerSession } from '../../utils/customerSession'
import type { AgentTurn } from './agentClient'

export interface UsualAiReply {
  say: string
  /** 話の中で紹介したメニュー（ボタンにする。まだ決定ではない） */
  suggestions: string[]
  /** お客様が「それで」と決めたメニュー（料金を見せて登録を確かめる） */
  ready: string | null
  action: 'hotpepper' | 'phone' | 'list' | null
}

const TIMEOUT_MS = 15000

export async function askUsualAi(message: string, history: readonly AgentTurn[], opts: { visited: boolean; who: string | null; rejected?: string[]; visitDate?: string | null }): Promise<UsualAiReply | null> {
  const session = getCustomerSession()
  if (!session) return null
  try {
    const call = supabase.functions.invoke<Partial<UsualAiReply>>('johnny-agent', {
      body: { mode: 'usual', session, message: message.slice(0, 200), history: history.slice(-12), visited: opts.visited, who: opts.who, rejected: (opts.rejected ?? []).slice(0, 20), visit_date: opts.visitDate ?? null },
    })
    const res = await Promise.race([call, new Promise<null>(r => setTimeout(() => r(null), TIMEOUT_MS))])
    const d = res && !res.error ? res.data : null
    if (!d || typeof d.say !== 'string' || !d.say.trim()) return null
    return {
      say: politeText(d.say.trim()).slice(0, 120),
      suggestions: Array.isArray(d.suggestions) ? d.suggestions.filter((c): c is string => typeof c === 'string').slice(0, 3) : [],
      ready: typeof d.ready === 'string' ? d.ready : null,
      action: d.action === 'hotpepper' || d.action === 'phone' || d.action === 'list' ? d.action : null,
    }
  } catch { return null }
}
