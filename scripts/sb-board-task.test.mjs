import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardDoneStatus, boardTask, boardWarnBefore, lastBefore } from '../src/sb/sbBoardTask.ts'

// サロンボードでやること（11/12）：「未転記」の1語にせず、入れる／変更する／キャンセルする を出し分ける
const res = (o = {}) => ({ source: 'staff', status: 'confirmed', transfer_status: 'pending', ...o })

test('済んでいれば、やることは無い', () => {
  assert.equal(boardTask(res({ transfer_status: 'done' })), null)
  assert.equal(boardTask(res({ source: 'hotpepper', transfer_status: 'not_required' })), null)
})

test('HOT PEPPER を動かした → サロンボードも変更する（済みは not_required に戻す）', () => {
  const r = res({ source: 'hotpepper' })
  assert.equal(boardTask(r), 'change')
  assert.equal(boardDoneStatus(r, 'change'), 'not_required')
  assert.equal(boardWarnBefore(res({ source: 'hotpepper', transfer_status: 'not_required' })), true)
})

test('アプリ・電話の新しい予約 → 入れる。入れた後に動かした → 変更する', () => {
  assert.equal(boardTask(res({ source: 'app' }), []), 'enter')
  const edited = [{ event_type: 'transfer_updated', after: { transfer_status: 'done' } }, { event_type: 'edited', before: { transfer_status: 'done', starts_at: '2026-11-20T05:00:00Z', staff_name: 'テイテイ' } }]
  assert.equal(boardTask(res({ source: 'app' }), edited), 'change')
  assert.equal(boardDoneStatus(res({ source: 'app' }), 'change'), 'done')
  assert.deepEqual(lastBefore(edited), { starts_at: '2026-11-20T05:00:00Z', staff_name: 'テイテイ' })
  assert.equal(boardWarnBefore(res({ source: 'app', transfer_status: 'done' })), true)
  assert.equal(boardWarnBefore(res({ source: 'app' })), false)
})

test('キャンセル：サロンボードにあればキャンセル、入れる前ならやることは無い', () => {
  assert.equal(boardTask(res({ source: 'hotpepper', status: 'cancelled' })), 'cancel')
  assert.equal(boardTask(res({ status: 'cancelled' }), [{ event_type: 'transfer_updated', after: { transfer_status: 'done' } }]), 'cancel')
  assert.equal(boardTask(res({ status: 'cancelled' }), []), 'nothing')
  assert.equal(boardDoneStatus(res({ status: 'cancelled' }), 'nothing'), 'not_required')
  // 履歴をまだ読んでいない一覧では、安全な方（キャンセル）に寄せる
  assert.equal(boardTask(res({ status: 'cancelled' })), 'cancel')
})
