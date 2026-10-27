import { callStaffRpc, expectRpcResult, RpcError } from './sbRpc'
import { bookingErrorMessage, jstDateLabel, jstTime, yen } from '../utils/bookingApi'
import type { SbCommand, SbInput, SbLedger, SbOptions, SbPending, SbPreview, SbReservation } from './sbTypes'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const validDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
const RECEIPTED_ERRORS = new Set([
  'staff_name_required', 'not_found', 'reservation_changed', 'invalid_status', 'invalid_customer_name',
  'invalid_phone', 'invalid_note', 'invalid_source', 'invalid_external_ref', 'client_mismatch', 'invalid_request',
  'invalid_menu', 'invalid_starts_at', 'date_not_open', 'too_late', 'slot_taken', 'preview_changed',
  'client_not_found', 'duplicate_external_ref', 'not_started',
])
export type SbOutcome = { ok: true; reservation: SbReservation } | { ok: false; error: string; terminal: boolean }

function matchesCommand(v: Record<string, unknown>, c: SbCommand): boolean {
  if (typeof v.id !== 'string' || !UUID.test(v.id) || !validDate(v.starts_at) || !validDate(v.updated_at)
    || typeof v.staff_id !== 'string' || !UUID.test(v.staff_id) || !Array.isArray(v.items)
    || typeof v.customer_name !== 'string' || !Number.isInteger(v.booking_lane)
    || !['pending', 'done', 'not_required'].includes(String(v.transfer_status))) return false
  if (c.kind !== 'create' && v.id !== c.reservation_id) return false
  if (c.kind === 'create' || c.kind === 'edit') {
    // 変更では予約の経路（AI予約の app など）はサーバーがそのまま残す。経路を比べると、変わっていても「失敗」になっていた（10/27）
    return v.customer_name === c.input.customer_name.trim() && (c.kind === 'edit' || v.source === c.input.source)
      && Date.parse(String(v.starts_at)) === Date.parse(c.input.starts_at)
      && (c.input.staff_id === null || v.staff_id === c.input.staff_id)
      && (!c.input.client_id || v.client_id === c.input.client_id)
      && JSON.stringify(v.items.map(i => (i as { menu_code: string }).menu_code)) === JSON.stringify(c.input.menu_codes)
  }
  if (c.kind === 'cancel') return v.status === 'cancelled'
  if (c.kind === 'status') return v.status === c.status
  return v.transfer_status === c.transfer_status
}

export const sbApi = {
  options: () => callStaffRpc<SbOptions>('staff_sb_options'),
  ledger: (date: string) => callStaffRpc<SbLedger>('staff_sb_ledger', { p_date: date }),
  preview: async (input: SbInput, id?: string): Promise<SbPreview> => {
    const value = await callStaffRpc<SbPreview>('staff_sb_preview', { p_input: input, p_reservation_id: id ?? null })
    return expectRpcResult(value, 'staff_sb_preview', v => typeof v.plan_hash === 'string' && /^[a-f0-9]{64}$/.test(v.plan_hash)
      && typeof v.staff_id === 'string' && UUID.test(v.staff_id) && Number.isInteger(v.duration_min)
      && Number(v.duration_min) > 0 && Array.isArray(v.items)
      && (v.total_price === null || (Number.isInteger(v.total_price) && Number(v.total_price) >= 0)))
  },
  slots: (date: string, codes: string[], staff: string | null, id?: string) => callStaffRpc<{ starts_at: string; staff_id: string }[]>(
    'staff_sb_slots', { p_date: date, p_menu_codes: codes, p_staff_id: staff, p_reservation_id: id ?? null }),
  mutate: async (pending: SbPending): Promise<SbOutcome> => {
    try {
      const value = await callStaffRpc<SbReservation>('staff_sb_mutate', {
        p_request_id: pending.id, p_command: pending.command, p_staff_name: pending.actor,
      })
      expectRpcResult(value, 'staff_sb_mutate', v => matchesCommand(v, pending.command))
      return { ok: true, reservation: value }
    } catch (err) {
      if (err instanceof RpcError && err.source === 'rpc_result') {
        return { ok: false, error: err.code, terminal: RECEIPTED_ERRORS.has(err.code) }
      }
      throw err
    }
  },
}

export function sbError(err: unknown): string {
  const code = err instanceof RpcError ? err.code : typeof err === 'string' ? err : ''
  const messages: Record<string, string> = {
    preview_changed: 'メニュー・担当の条件が変わりました。内容を確認し直してください。',
    reservation_changed: '別の操作で予約が更新されています。最新の予約を開き直してください。',
    idempotency_conflict: '送信内容の不一致を検出しました。再登録せず管理者へ確認してください。',
    invalid_external_ref: 'HOT PEPPERの予約番号を入力してください。',
    staff_name_required: '操作者を選択してください。',
    storage_error: 'このブラウザでは安全に送信できません。保存領域・ブラウザの設定を確認してください。',
    request_busy: '別の画面で送信中です。結果を待ってください。',
    pending_exists: '先に送信済み予約の結果を確認してください。',
    result_unknown: '通信結果を確認できません。同じ内容で結果を確認してください。',
    staff_auth_required: '端末認証の期限が切れました。PINを入力し直してください。',
  }
  return messages[code] ?? bookingErrorMessage(code)
}

export function salonBoardCopy(r: SbReservation): string {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(r.starts_at))
  return [r.status === 'cancelled' ? 'Salon Board転記用【キャンセル】' : 'Salon Board転記用',
    `氏名：${r.customer_name}`, `電話：${r.customer_phone || '未登録'}`, `日時：${jstDateLabel(date)} ${jstTime(r.starts_at)}`,
    `担当：${r.staff_name}${r.nominated ? '（指名）' : '（指名なし）'}`, `メニュー：${r.items.map(i => i.name).join(' / ')}`,
    `予約時の金額：${yen(r.total_price)}`, `施術時間：${Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60000)}分`,
    r.external_ref ? `予約番号：${r.external_ref}` : null, r.note ? `メモ：${r.note}` : null].filter(Boolean).join('\n')
}
