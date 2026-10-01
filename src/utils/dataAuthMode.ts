/**
 * どの画面（お客様アプリ / 店舗端末 / 本部画面）として動いているか。
 * 店舗端末と本部画面で共通に使うデータ処理（在庫・日報作成）が、
 * どちらのセッション（スタッフ / 本部）で RPC を呼ぶかをここで決める。
 * 各エントリ（main.tsx / hq-main.tsx）の起動時に1回だけ設定する。
 */

import { callStaffRpc, RpcError } from './staffSession'
import { callHqRpc } from '../hq/hqSession'

export type DataAuthMode = 'customer' | 'staff' | 'hq'

let mode: DataAuthMode = 'customer'

export function setDataAuthMode(next: DataAuthMode): void {
  mode = next
}

export function getDataAuthMode(): DataAuthMode {
  return mode
}

/**
 * 店舗端末なら staff_*、本部画面なら hq_* の RPC を呼ぶ（引数は共通）。
 * お客様アプリからは呼べない（店舗・本部の業務データのため）。
 */
export async function callStoreOrHqRpc<T>(staffFn: string, hqFn: string, params: Record<string, unknown> = {}): Promise<T> {
  if (mode === 'hq') return callHqRpc<T>(hqFn, params)
  if (mode === 'staff') return callStaffRpc<T>(staffFn, params)
  throw new RpcError('forbidden', 'この操作は店舗端末・本部画面でのみ使えます。')
}
