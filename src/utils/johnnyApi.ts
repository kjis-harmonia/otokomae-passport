import { supabase } from '../lib/supabase'
import { getCustomerSession } from './customerSession'
import { getHqToken } from '../hq/hqSession'
import type { JohnnyHandoff } from './johnnyHandoff'

export type JohnnyMode = 'style' | 'booking' | 'hq'

export interface JohnnyStyleSuggestion {
  slug: string
  title: string
  category: string
  catch_copy: string | null
  description: string | null
  image_url: string | null
  tags: string[]
  tryon_style_id: string | null
  /** 確認済みの予約メニュー（正規サービス）。未確定なら null。価格・所要時間は予約の RPC（サービスマスター）だけが正 */
  booking_menu: { code: string; name: string } | null
}

export interface JohnnyBookingSlot {
  starts_at: string
  staff_id?: string
  staff_name?: string
}

export interface JohnnyBookingMenu {
  code: string
  name: string
  duration_min: number
  price: number | null
  staff_ids: string[]
}

export interface JohnnyAuditRef {
  session_id: string
  source_fact_at: string
  source_fact_version: string
}

export interface JohnnyResponse {
  mode: JohnnyMode
  request_id: string
  correlation_id: string
  answer: string
  provider: string
  suggestions?: JohnnyStyleSuggestion[]
  booking_disabled?: boolean
  matched_menu?: JohnnyBookingMenu | null
  /** confirmed＝確認済みの対応で予約メニューが決まった／unconfirmed＝スタイルの予約メニュー未確定／none＝引き継ぎなし */
  menu_status?: 'confirmed' | 'unconfirmed' | 'none'
  slots?: JohnnyBookingSlot[]
  snapshot?: Record<string, unknown>
  audit: JohnnyAuditRef
}

export type JohnnyResult = { ok: true; data: JohnnyResponse } | { ok: false; error: string }

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function friendlyError(code: string): string {
  const messages: Record<string, string> = {
    johnny_disabled: 'JOHNNYは現在有効化されていません。',
    customer_auth_required: 'JOHNNYの利用にはアプリ連携が必要です。',
    hq_auth_required: '本部PINの有効期限が切れています。',
    booking_disabled: '現在アプリ内予約は受付停止中です。',
    not_configured: 'JOHNNYの接続設定が未完了です。',
  }
  return messages[code] ?? 'JOHNNYに接続できませんでした。'
}

async function invokeJohnny(body: Record<string, unknown>): Promise<JohnnyResult> {
  const { data, error } = await supabase.functions.invoke('johnny-operator', { body })
  if (error) return { ok: false, error: friendlyError(error.message) }
  const payload = data as { error?: string } & JohnnyResponse
  if (payload?.error) return { ok: false, error: friendlyError(payload.error) }
  return { ok: true, data: payload }
}

export async function askCustomerJohnny(mode: 'style' | 'booking', message: string, handoff?: JohnnyHandoff | null): Promise<JohnnyResult> {
  const sessionToken = getCustomerSession()
  if (!sessionToken) return { ok: false, error: friendlyError('customer_auth_required') }
  return invokeJohnny({
    mode,
    message,
    handoff: handoff ?? null,
    sessionToken,
    requestId: newId(),
    correlationId: newId(),
  })
}

export async function askHqJohnny(message: string, range?: { from?: string; to?: string }): Promise<JohnnyResult> {
  const hqToken = getHqToken()
  if (!hqToken) return { ok: false, error: friendlyError('hq_auth_required') }
  return invokeJohnny({
    mode: 'hq',
    message,
    range: range ?? null,
    hqToken,
    requestId: newId(),
    correlationId: newId(),
  })
}
