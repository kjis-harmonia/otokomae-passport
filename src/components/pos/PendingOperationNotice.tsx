import type { PendingNotice } from '../../utils/pendingNotice'
import { C, SANS } from '../booking/ledgerTheme'
import { PrimaryButton } from '../booking/ledgerUi'

/**
 * 未解決の金銭操作の通知（会計・GINPay・チケット発行・本部の返金・会計取消で共通）。表示専用。
 * 処理内容・現在の状態・次に必要な行動を出す。「結果を確認」は既存の確認処理（onConfirm）を呼ぶだけで、
 * 新しいキーでの再送はしない。処理中・保存できないときはボタンを出さない。
 * 暗い画面の中でも同じ見た目になるよう、白地で描く。
 */
export function PendingOperationNotice({ notice, onConfirm, confirming = false, confirmLabel = '結果を確認' }: {
  notice: PendingNotice
  /** 無ければボタンを出さない（画面の別の場所に確認ボタンがあるとき） */
  onConfirm?: () => void
  confirming?: boolean
  confirmLabel?: string
}) {
  const warn = notice.status === 'result_unknown' || notice.status === 'unverifiable' || notice.status === 'storage_error'
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={notice.status === 'processing'}
      data-pending-notice={notice.status}
      style={{
        padding: '14px 16px', borderRadius: 8, border: `1px solid ${warn ? C.danger : C.lineStrong}`,
        background: C.bg, color: C.text, fontFamily: SANS, textAlign: 'left',
      }}
    >
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.6, color: warn ? C.danger : C.text }}>{notice.title}</p>
      {notice.details.length > 0 && (
        <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 12, rowGap: 2, fontSize: 14, lineHeight: 1.6 }}>
          {notice.details.map(d => (
            <div key={d.label} style={{ display: 'contents' }}>
              <dt style={{ color: C.sub, whiteSpace: 'nowrap' }}>{d.label}</dt>
              <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {notice.reason && <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.7, color: C.text }}>{notice.reason}</p>}
      <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.7, fontWeight: 600 }}>{notice.next}</p>
      {notice.status === 'processing' && <p style={{ margin: '8px 0 0', fontSize: 14, color: C.sub }}>処理中…</p>}
      {onConfirm && notice.canConfirm && (
        <div style={{ marginTop: 12 }}>
          <PrimaryButton onClick={onConfirm} disabled={confirming} style={{ minHeight: 48 }}>{confirming ? '確認中…' : confirmLabel}</PrimaryButton>
        </div>
      )}
    </div>
  )
}
