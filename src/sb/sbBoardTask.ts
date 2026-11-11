// Salon Board でやること（11/12 慶一郎さん「従業員が迷わないように」）。
//   DB の transfer_status は「pending＝まだ／done・not_required＝済み」だけ。SB で動かす・キャンセルすると必ず pending に戻る。
//   「未転記」の1語だと、もうサロンボードにある予約（HOT PEPPER・入れた後に動かした予約）でも「入れる」に見えて迷うので、
//   やることを言葉にする：入れる／変更する／キャンセルする／（入っていなかったので）作業なし
export type BoardTask = 'enter' | 'change' | 'cancel' | 'nothing'
type Snap = { transfer_status?: string | null; starts_at?: string | null; staff_name?: string | null } | null | undefined
export type BoardEvent = { event_type: string; before?: Snap; after?: Snap; created_at?: string }
type R = { source: string; status: string; transfer_status: string }

/** もうサロンボードに入っている予約か。HOT PEPPER は最初からある。ほかは履歴で「済み」にしたことがあるか */
export function onBoard(r: R, events?: BoardEvent[] | null): boolean | null {
  if (r.source === 'hotpepper') return true
  if (!events) return null
  return events.some(e => (e.event_type === 'transfer_updated' && e.after?.transfer_status === 'done')
    || (e.event_type === 'edited' && e.before?.transfer_status === 'done'))
}

/** やること。済みなら null。履歴がまだ無いとき（一覧）は分かる範囲で */
export function boardTask(r: R, events?: BoardEvent[] | null): BoardTask | null {
  if (r.transfer_status !== 'pending') return null
  const on = onBoard(r, events)
  if (r.status === 'cancelled' || r.status === 'no_show') return on === false ? 'nothing' : 'cancel'
  return on ? 'change' : 'enter'
}

export const BOARD_TASK_TITLE: Record<BoardTask, string> = {
  enter: 'サロンボードに入れる',
  change: 'サロンボードも変更する',
  cancel: 'サロンボードもキャンセルする',
  nothing: 'サロンボードの作業はありません',
}
export const BOARD_TASK_HINT: Record<BoardTask, string> = {
  enter: '下の内容を、サロンボードに入れてください。',
  change: 'サロンボードの予約を、下の内容に変更してください。',
  cancel: 'サロンボードの予約も、キャンセルにしてください。',
  nothing: 'サロンボードに入れる前の予約でした。確かめたら【確認した】を押してください。',
}
/** 一覧の札 */
export const BOARD_TASK_TAG: Record<BoardTask, string> = { enter: '入れる', change: '変更する', cancel: 'キャンセル', nothing: '確認' }
/** 済みにするボタン */
export const BOARD_TASK_DONE: Record<BoardTask, string> = {
  enter: 'サロンボードに入れた',
  change: 'サロンボードで変更した',
  cancel: 'サロンボードでキャンセルした',
  nothing: '確認した',
}
/** 済みにしたときの DB の値。HOT PEPPER は今まで通り not_required（詳細にサロンボードの欄を出さない） */
export function boardDoneStatus(r: R, task: BoardTask): 'done' | 'not_required' {
  return r.source === 'hotpepper' || task === 'nothing' ? 'not_required' : 'done'
}
/** 動かす・キャンセルする前に「サロンボードでも同じ操作を」と伝えるか（サロンボードにある予約だけ） */
export function boardWarnBefore(r: R): boolean {
  return r.source === 'hotpepper' || r.transfer_status === 'done'
}
/** 一番新しい「内容変更」の変更前（変更前：日時・担当を出す） */
export function lastBefore(events?: BoardEvent[] | null): { starts_at: string; staff_name: string | null } | null {
  const e = [...(events ?? [])].reverse().find(x => x.event_type === 'edited' && x.before?.starts_at)
  return e?.before?.starts_at ? { starts_at: e.before.starts_at, staff_name: e.before.staff_name ?? null } : null
}
