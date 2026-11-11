import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sbCloseErrorText } from '../src/sb/sbCloseError.ts'

// SB のクローズ：サーバーが理由を返したときは理由を出す。「通信を確かめて」は通信が切れたときだけ
const rpc = code => ({ code, message: code, source: 'rpc_result', resultUnknown: false })
const NET = '通信を確かめて'

test('クローズのサーバーの理由ごとに文が変わる', () => {
  assert.match(sbCloseErrorText('close', rpc('past')), /過ぎた時間/)
  assert.match(sbCloseErrorText('close', rpc('invalid_staff')), /担当を選び直して/)
  assert.match(sbCloseErrorText('close', rpc('invalid_range')), /時間を確かめて/)
  for (const c of ['past', 'invalid_staff', 'invalid_range']) assert.doesNotMatch(sbCloseErrorText('close', rpc(c)), new RegExp(NET), c)
})

test('外す：not_found は本部のクローズか、もう外れている', () => {
  const t = sbCloseErrorText('reopen', rpc('not_found'))
  assert.match(t, /本部で閉めた時間か、ほかの端末ですでに外して/)
  assert.doesNotMatch(t, new RegExp(NET))
})

test('認証切れ・ロック中は、それぞれの文', () => {
  assert.match(sbCloseErrorText('close', { code: 'staff_auth_required', message: 'x', source: 'local_precondition' }), /PINを入れ直して/)
  assert.match(sbCloseErrorText('reopen', { code: 'staff_auth_required', message: 'x', source: 'supabase_error', resultUnknown: false }), /PINを入れ直して/)
  assert.match(sbCloseErrorText('close', { code: '28000', message: 'staff_locked', source: 'supabase_error', resultUnknown: false }), /本部の操作で SB が止まって/)
})

test('通信が切れた・結果が分からない・RpcError 以外は「通信を確かめて」', () => {
  assert.match(sbCloseErrorText('close', { code: 'result_unknown', message: '通信結果を確認できませんでした。', source: 'supabase_error', resultUnknown: true }), new RegExp(`閉められませんでした。${NET}`))
  assert.match(sbCloseErrorText('reopen', new TypeError('Failed to fetch')), new RegExp(`外せませんでした。${NET}`))
  assert.match(sbCloseErrorText('close', undefined), new RegExp(NET))
})

test('知らない理由・確定した失敗は、通信のせいにしない', () => {
  assert.match(sbCloseErrorText('close', rpc('something_new')), /本部に知らせて/)
  assert.match(sbCloseErrorText('close', { code: '42883', message: 'function does not exist', source: 'supabase_error', resultUnknown: false }), /本部に知らせて/)
})
