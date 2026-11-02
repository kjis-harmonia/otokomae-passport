import { callStaffRpc } from './sbRpc'

// SALON BOARD（HOT PEPPER）の予約メールの取込結果。Gmail からは自動で届き、ここでは貼り付けでも取り込める
export interface HpbMail {
  id: string; kind: 'booking' | 'cancel' | 'change' | 'unknown'; status: 'applied' | 'duplicate' | 'needs_review' | 'checked' | 'ignored'
  reason: string | null; warnings: string[]; external_ref: string | null; customer_name: string | null
  starts_at: string | null; stylist: string | null; menu: string | null; reservation_id: string | null
  created_at: string; checked_by: string | null; repeat?: boolean
}
export interface HpbList { open: number; mails: HpbMail[] }

export const hpbApi = {
  list: () => callStaffRpc<HpbList>('staff_sb_hpb_list'),
  importText: (text: string, actor: string) => callStaffRpc<HpbMail>('staff_sb_hpb_import', { p_text: text, p_staff_name: actor }),
  check: (id: string, actor: string) => callStaffRpc<HpbMail>('staff_sb_hpb_check', { p_id: id, p_staff_name: actor }),
}

export const KIND: Record<HpbMail['kind'], string> = { booking: '予約', cancel: 'キャンセル', change: '変更', unknown: '読めないメール' }
const REASON: Record<string, string> = {
  slot_taken: 'その時間の枠が埋まっていて入れられません。予約表を空けてから入れ直してください。',
  not_found: '取り消す予約が予約表にありません（取込を始める前の予約かもしれません）。',
  invalid_status: '来店済みなどで変更できない状態です。',
  unreadable: 'メールの内容を読み取れませんでした。',
  already_cancelled: '先にキャンセルのメールが届いていたので入れていません。',
  retried: '枠が埋まっていた予約です。枠の外（赤い枠オーバー）に入れ直しました。',
}
export const WARNING: Record<string, string> = { over_capacity: '同時枠がいっぱいだったので、枠の外（赤い枠オーバー）に入れました', out_of_hours: '勤務時間外', unknown_stylist: '担当名が見つからず空いている人に入れました', created_from_change: '変更前の予約が無かったので新しく入れました' }

export function hpbResult(m: HpbMail): string {
  if (m.repeat) return 'このメールは取込済みです。'
  if (m.status === 'ignored') return m.reason === 'notice' ? 'SALON BOARD からのお知らせです（予約ではありません）。' : '取込を始める前の予約のキャンセルです。SB ではすることはありません。'
  if (m.status === 'needs_review' || m.status === 'checked') return REASON[m.reason ?? ''] ?? '確認が必要です。'
  if (m.status === 'duplicate') return m.reason === 'already_cancelled' ? REASON.already_cancelled : 'すでに予約表にあります。'
  return m.kind === 'cancel' ? '予約を取り消しました。' : m.kind === 'change' ? '予約を変更しました。' : '予約表に入れました。'
}
