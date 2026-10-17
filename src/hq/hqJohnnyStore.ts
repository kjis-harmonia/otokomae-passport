// 本部 JOHNNY：話す（Edge Function hq-johnny）と、慶一郎さんとの伝言の箱（hq_messages_*）。
import { supabase } from '../lib/supabase'
import { callHqRpc, getHqToken } from './hqSession'

export interface HqMessage {
  id: string
  /** to_shop＝慶一郎さんから本部へ、to_owner＝本部から慶一郎さんへ */
  direction: 'to_owner' | 'to_shop'
  /** request＝OK / NG / 返事がほしい */
  kind: 'note' | 'request'
  title: string
  body: string
  urgent: boolean
  status: 'open' | 'seen' | 'approved' | 'rejected' | 'answered'
  reply: string | null
  created_at: string
  seen_at: string | null
  answered_at: string | null
}
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export const listMessages = () => callHqRpc<HqMessage[]>('hq_messages_list', { p_limit: 50 })
export const answerMessage = (id: string, status: 'seen' | 'approved' | 'rejected' | 'answered', reply: string | null = null) =>
  callHqRpc<HqMessage | { error: string }>('hq_message_answer', { p_id: id, p_status: status, p_reply: reply })

export async function askJohnny(message: string, history: ChatTurn[]): Promise<{ reply: string; changed: boolean }> {
  const hq = getHqToken()
  if (!hq) throw new Error('hq_auth_required')
  const { data, error } = await supabase.functions.invoke<{ reply?: string; changed?: boolean; error?: string }>('hq-johnny', {
    body: { hq, message, history: history.slice(-40) },
  })
  if (error || !data?.reply) throw new Error(data?.error ?? 'johnny_failed')
  return { reply: data.reply, changed: !!data.changed }
}

export const STATUS_LABEL: Record<HqMessage['status'], string> = { open: '未読', seen: '見た', approved: 'OK', rejected: 'NG', answered: '返事あり' }
