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

/** 文字か声（録音）で話しかける。声のときは heard（聞き取った文）も返る。聞き取れなければ reply は空 */
export async function askJohnny(input: string | { b64: string; mime: string }, history: ChatTurn[]): Promise<{ heard?: string; reply: string; changed: boolean; open?: string }> {
  const hq = getHqToken()
  if (!hq) throw new Error('hq_auth_required')
  const payload = typeof input === 'string' ? { message: input } : { audio: input.b64, mime: input.mime }
  const { data, error } = await supabase.functions.invoke<{ heard?: string; reply?: string; changed?: boolean; open?: string; error?: string }>('hq-johnny', {
    body: { hq, ...payload, history: history.slice(-40) },
  })
  if (error || !data) throw new Error(data?.error ?? 'johnny_failed')
  if (typeof input !== 'string' && data.heard === '') return { heard: '', reply: '', changed: false }
  if (!data.reply) throw new Error(data.error ?? 'johnny_failed')
  return { heard: data.heard, reply: data.reply, changed: !!data.changed, open: typeof data.open === 'string' ? data.open : undefined }
}

/** 本部の「やること」（days_left＝期限まで何日。マイナスは過ぎている） */
export interface HqTask { id: string; title: string; detail: string | null; assignee: string; due_date: string | null; status: 'open' | 'done' | 'cancelled'; days_left: number | null }
export const listTasks = () => callHqRpc<HqTask[]>('hq_tasks_list', { p_include_done: false })
/** 終わり（BOS へ【完了】が自動で届く） */
export const closeTask = (id: string, status: 'done' | 'cancelled' = 'done') => callHqRpc<HqTask | { error: string }>('hq_task_close', { p_id: id, p_status: status, p_note: null })

/** 朝のあいさつ：JOHNNY から今日の様子を話す */
export async function johnnyBriefing(): Promise<string> {
  const hq = getHqToken()
  if (!hq) throw new Error('hq_auth_required')
  const { data, error } = await supabase.functions.invoke<{ reply?: string; error?: string }>('hq-johnny', { body: { hq, briefing: true } })
  if (error || !data?.reply) throw new Error(data?.error ?? 'johnny_failed')
  return data.reply
}

export const STATUS_LABEL: Record<HqMessage['status'], string> = { open: '未読', seen: '見た', approved: 'OK', rejected: 'NG', answered: '返事あり' }
