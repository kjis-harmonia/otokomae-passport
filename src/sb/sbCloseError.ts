// 時間のクローズ（staff_close_time）・外す（staff_reopen_time）の失敗を、スタッフに分かる短い文にする。
// 「通信を確かめて」は本当に通信が切れたとき（結果が分からないとき）だけ。サーバーが理由を返したときはその理由を出す。
// callRpc は { error: '...' } を RpcError（source: 'rpc_result'）にして投げる。ここは import を持たない（テストで読めるように）

type ErrLike = { code?: unknown; message?: unknown; source?: unknown; resultUnknown?: unknown }

const CLOSE: Record<string, string> = {
  invalid_range: '時間を確かめてください（30分刻み・終わりは始まりより後）。',
  past: 'もう過ぎた時間は閉められません。',
  invalid_staff: 'この担当は今は閉められません。担当を選び直してください。',
}
const REOPEN: Record<string, string> = {
  not_found: 'このクローズは外せません。本部で閉めた時間か、ほかの端末ですでに外しています。予約表を読み直してください。',
}
const COMMON: Record<string, string> = {
  staff_auth_required: '端末の認証が切れました。PINを入れ直してから、もう一度押してください。',
  staff_locked: 'いまは本部の操作で SB が止まっています。本部に確かめてください。',
}

export function sbCloseErrorText(kind: 'close' | 'reopen', err: unknown): string {
  const e = (err && typeof err === 'object' ? err : {}) as ErrLike
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : ''
  const own = kind === 'close' ? CLOSE : REOPEN
  if (e.source === 'rpc_result' && own[code]) return own[code]
  if (COMMON[code]) return COMMON[code]
  if (message.includes('staff_locked')) return COMMON.staff_locked
  if (message.includes('staff_auth_required')) return COMMON.staff_auth_required
  const verb = kind === 'close' ? '閉められませんでした' : '外せませんでした'
  // サーバーが理由を返した・または送る前に止まった（結果は確定している）。通信の問題ではないので、繰り返さず知らせてもらう
  if (e.source === 'rpc_result' || e.source === 'local_precondition' || (e.source === 'supabase_error' && e.resultUnknown === false)) {
    return `${verb}。もう一度押しても同じときは、本部に知らせてください。`
  }
  // 通信が切れた・応答が読めない（RpcError 以外の例外も含む）
  return `${verb}。通信を確かめて、もう一度押してください。`
}
