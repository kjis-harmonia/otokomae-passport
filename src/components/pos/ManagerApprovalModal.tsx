import { useEffect, useRef, useState } from 'react'
import {
  getStaffManagerCandidates,
  approvePosOperation,
  type ManagerCandidate,
} from '../../utils/posManagerApproval'
import { getCurrentOperator, isCurrentOperatorValid } from '../../utils/posOperatorSession'
import type { ApprovalSummary } from '../../utils/approvalSummary'
import { C, SANS } from '../booking/ledgerTheme'
import { PrimaryButton, SecondaryButton } from '../booking/ledgerUi'

interface ManagerApprovalModalProps {
  action: string
  requestHash: string
  /** 何を承認するか（承認のあとに送る入力から作る。表示専用） */
  summary: ApprovalSummary
  onApproved: (approvalToken: string) => void
  onCancel: () => void
  onOperatorAuthRequired?: () => void
  title?: string
}

function isOperatorAuthError(code: string): boolean {
  return (
    code === 'operator_session_invalid' ||
    code === 'invalid_operator_session' ||
    code === 'operator_session_expired' ||
    code === 'staff_auth_required'
  )
}

function getErrorMessage(code: string, remaining?: number, lockedUntil?: string): string {
  switch (code) {
    case 'self_approval_prohibited':
      return '操作者本人は承認できません。別の管理者を選択してください。'
    case 'manager_not_found':
      return '選択された管理者が見つかりません。'
    case 'not_a_manager':
      return '選択されたスタッフは管理者（Manager）ではありません。'
    case 'locked':
      if (lockedUntil) {
        try {
          const d = new Date(lockedUntil)
          const timeStr = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
          return `連続入力ミスのためロック中です（${timeStr}まで解除不可）。`
        } catch {
          return '連続入力ミスのためロック中です。しばらくお待ちください。'
        }
      }
      return '連続入力ミスのためロック中です。しばらくお待ちください。'
    case 'invalid_pin':
      if (typeof remaining === 'number') {
        return `PINが正しくありません（残り試行回数: ${remaining}回）。`
      }
      return 'PINが正しくありません。'
    case 'invalid_request_hash':
      return '要求内容の検証に失敗しました。操作をやり直してください。'
    case 'operator_session_invalid':
    case 'invalid_operator_session':
      return '操作者セッションが無効です。もう一度PINを入力してください。'
    case 'operator_session_expired':
      return '操作者セッションの有効期限が切れました。'
    case 'staff_auth_required':
      return '端末セッションの有効期限が切れました。'
    default:
      return `承認に失敗しました（${code}）。`
  }
}

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** モーダルの外（祖先の兄弟要素）を inert にする。元から inert だった要素は触らない。戻す関数を返す */
function inertOutside(el: HTMLElement): () => void {
  const changed: HTMLElement[] = []
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement
    if (!parent) break
    for (const sib of Array.from(parent.children)) {
      if (sib === node || !(sib instanceof HTMLElement) || sib.inert) continue
      sib.inert = true
      changed.push(sib)
    }
  }
  return () => { for (const sib of changed) sib.inert = false }
}

/**
 * 店長の承認。何を承認するか（summary）を見せてから、管理者を選んで PIN を入力する。
 *
 *   - 管理者一覧はモーダルを開いたときに1回だけ読む。親の再描画（コールバックの参照が変わる）では読み直さず、
 *     選択中の管理者と入力中の PIN を保つ。閉じて開き直せば最初からになる（呼び出し元は閉じるとアンマウントする）。
 *   - 承認対象（action / requestHash）が変わったら、選択と PIN を消す。送信中に変わった・画面が閉じた場合は、
 *     返ってきた承認を使わない（古い対象の承認を新しい対象に流用しない）。
 *   - 管理者は自動で選ばない。PIN・承認トークンは表示しない。
 *   - フォーカス：開いたらパネルへ移し、Tab / Shift+Tab はモーダルの中だけを回る。背景は inert にして操作させない。
 *     閉じたら、開く前にフォーカスがあった要素へ戻す（その要素が残っていれば）。
 */
export function ManagerApprovalModal({
  action,
  requestHash,
  summary,
  onApproved,
  onCancel,
  onOperatorAuthRequired,
  title = '店長の承認',
}: ManagerApprovalModalProps) {
  const [candidates, setCandidates] = useState<ManagerCandidate[]>([])
  const [selectedStaffId, setSelectedStaffId] = useState<string>('')
  const [pin, setPin] = useState<string>('')
  const [loadingCandidates, setLoadingCandidates] = useState(true)
  const [busy, setBusy] = useState(false)
  const [candidateLoadError, setCandidateLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // 親の再描画で参照が変わるコールバックは ref に置き、読み込みのやり直しの原因にしない
  const onOperatorAuthRequiredRef = useRef(onOperatorAuthRequired)
  const onApprovedRef = useRef(onApproved)
  useEffect(() => {
    onOperatorAuthRequiredRef.current = onOperatorAuthRequired
    onApprovedRef.current = onApproved
  })
  // 今の承認対象と、画面が開いているか（送信中に変わった・閉じた承認を使わないため）
  const targetKey = `${action}\n${requestHash}`
  const targetRef = useRef(targetKey)
  const mountedRef = useRef(true)
  const overlayRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // フォーカス：開いたときに1回だけ設定し、閉じたら戻す（親の再描画では何もしない）
  useEffect(() => {
    const overlay = overlayRef.current
    const panel = panelRef.current
    if (!overlay || !panel) return
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const restoreInert = inertOutside(overlay)
    panel.focus({ preventScroll: true })

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && panel.contains(active) && active !== panel
      if (e.shiftKey ? (!inside || active === first) : (!inside || active === last)) {
        e.preventDefault()
        if (e.shiftKey) last.focus()
        else first.focus()
      }
    }
    // inert の付いていない要素（後から追加された要素など）へ移ったときもパネルへ戻す
    function onFocusIn(e: FocusEvent) {
      if (panel && overlay && e.target instanceof Node && !overlay.contains(e.target)) panel.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
      restoreInert()
      if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [])

  // 管理者一覧：開いたときに1回だけ
  useEffect(() => {
    let alive = true
    const op = getCurrentOperator()
    if (!op || !isCurrentOperatorValid()) {
      // 呼び出し元は操作者の認証へ切り替える。切り替わるまで「管理者がいない」とは表示しない
      setCandidateLoadError('操作者の認証が必要です。')
      setLoadingCandidates(false)
      onOperatorAuthRequiredRef.current?.()
      return
    }

    setCandidateLoadError(null)
    getStaffManagerCandidates(op.operatorToken)
      .then(res => {
        if (!alive) return
        if (!res.ok) {
          if (isOperatorAuthError(res.error)) {
            onOperatorAuthRequiredRef.current?.()
            return
          }
          setCandidateLoadError(getErrorMessage(res.error))
          return
        }
        setCandidates(res.candidates)
        setSelectedStaffId('') // 自動選択禁止。ユーザーが明示的に選択するまで未選択
      })
      .catch(() => {
        if (!alive) return
        setCandidateLoadError('通信を確認できず、管理者一覧を読み込めませんでした。')
      })
      .finally(() => {
        if (alive) setLoadingCandidates(false)
      })

    return () => { alive = false }
  }, [])

  // 承認対象が変わったら、前の対象のための選択・PIN を残さない
  useEffect(() => {
    if (targetRef.current === targetKey) return
    targetRef.current = targetKey
    setSelectedStaffId('')
    setPin('')
    setSubmitError('承認する内容が変わりました。内容を確認して、もう一度入力してください。')
  }, [targetKey])

  // 照合中は押したボタンが無効になりフォーカスが外れる。終わったらパネルへ戻す
  useEffect(() => {
    if (busy) return
    const panel = panelRef.current
    const active = document.activeElement
    if (panel && (!active || active === document.body)) panel.focus({ preventScroll: true })
  }, [busy])

  async function handleSubmit() {
    if (busy || !selectedStaffId || pin.length < 4 || pin.length > 8) return

    const op = getCurrentOperator()
    if (!op || !isCurrentOperatorValid()) {
      setPin('')
      onOperatorAuthRequiredRef.current?.()
      return
    }

    const submittedFor = targetKey
    setBusy(true)
    setSubmitError(null)

    try {
      const res = await approvePosOperation({
        managerStaffId: selectedStaffId,
        managerPin: pin,
        action,
        requestHash,
      }, op.operatorToken)

      // 送信中に閉じた・承認対象が変わった：この承認は使わない（期限切れで無効になる）
      if (!mountedRef.current) return
      if (targetRef.current !== submittedFor) {
        setPin('')
        setSubmitError('承認する内容が変わったため、この承認は使いません。もう一度入力してください。')
        return
      }

      if (!res.ok) {
        setPin('')
        if (isOperatorAuthError(res.error)) {
          onOperatorAuthRequiredRef.current?.()
          return
        }
        setSubmitError(getErrorMessage(res.error, res.remaining_attempts, res.locked_until))
        return
      }

      setPin('')
      onApprovedRef.current(res.approvalToken)
    } catch {
      if (!mountedRef.current) return
      // 承認 API の通信結果不明。発行されていても使われずに期限切れになるため、金銭処理は行われていない
      setSubmitError('通信を確認できませんでした。この承認は使われません。通信状態を確認してからPINを入力してください。')
      setPin('')
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  function handleDigit(d: string) {
    if (!selectedStaffId) {
      setSubmitError('承認する管理者を選択してください。')
      return
    }
    if (pin.length < 8) {
      setPin(prev => prev + d)
      setSubmitError(null)
    }
  }

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']
  const operatorName = getCurrentOperator()?.memberName ?? null
  const canSubmit = !busy && !!selectedStaffId && pin.length >= 4 && pin.length <= 8

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="manager-approval-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 12, boxSizing: 'border-box',
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        data-approval-panel=""
        style={{
          width: '100%', maxWidth: 420, maxHeight: '100%', overflowY: 'auto', overscrollBehavior: 'contain', outline: 'none',
          boxSizing: 'border-box', padding: '20px 20px 16px',
          background: C.bg, color: C.text, fontFamily: SANS,
          border: `1px solid ${C.line}`, borderRadius: 12,
        }}
      >
        <h2 id="manager-approval-title" style={{ fontSize: 17, fontWeight: 600 }}>{title}</h2>

        {/* 承認する内容 */}
        <div data-approval-summary="" style={{ marginTop: 12, padding: '12px 0', borderTop: `1px solid ${C.text}`, borderBottom: `1px solid ${C.line}` }}>
          <p style={{ fontSize: 15, fontWeight: 600 }}>{summary.operation}</p>
          {summary.amountLabel && <p style={{ marginTop: 6, fontSize: 13, color: C.sub }}>{summary.amountLabel}</p>}
          <p style={{ marginTop: 2, fontSize: 24, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{yen(summary.amount)}</p>
          <dl style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 12, rowGap: 2, fontSize: 14, lineHeight: 1.6 }}>
            {summary.details.map((d, k) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt style={{ color: C.sub, whiteSpace: 'nowrap' }}>{d.label}</dt>
                <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{d.value}</dd>
              </div>
            ))}
            {operatorName && (
              <>
                <dt style={{ color: C.sub, whiteSpace: 'nowrap' }}>操作担当</dt>
                <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{operatorName}</dd>
              </>
            )}
          </dl>
          {summary.changes && (
            <div data-approval-changes="" style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
              <p style={{ fontSize: 13, color: C.sub }}>{summary.changes.title}</p>
              <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', fontSize: 14, lineHeight: 1.6 }}>
                {summary.changes.lines.map((l, k) => (
                  <li key={k} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 12, alignItems: 'baseline' }}>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{l.label}</span>
                    <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{l.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {loadingCandidates ? (
          <p style={{ fontSize: 14, color: C.sub, padding: '20px 0' }}>管理者一覧を読み込み中…</p>
        ) : candidateLoadError || candidates.length === 0 ? (
          <div style={{ paddingTop: 16 }}>
            <p style={{ fontSize: 14, color: C.danger, lineHeight: 1.6, marginBottom: 12 }}>
              {candidateLoadError ?? '承認できる管理者が設定されていません。'}
            </p>
            <SecondaryButton onClick={onCancel}>戻る</SecondaryButton>
          </div>
        ) : (
          <form onSubmit={e => { e.preventDefault(); void handleSubmit() }}>
            <p id="manager-approval-staff" style={{ marginTop: 14, fontSize: 14, color: C.sub }}>承認する管理者</p>
            <div role="group" aria-labelledby="manager-approval-staff" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {candidates.map(c => {
                const selected = selectedStaffId === c.id
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={busy}
                    onClick={() => { setSelectedStaffId(c.id); setSubmitError(null) }}
                    style={{
                      flex: '1 1 calc(50% - 4px)', minWidth: 0, minHeight: 44, padding: '4px 10px', borderRadius: 8, overflowWrap: 'anywhere',
                      fontFamily: SANS, fontSize: 15, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
                      background: selected ? C.text : C.bg, color: selected ? C.bg : C.text,
                      border: `1px solid ${selected ? C.text : C.lineStrong}`,
                    }}
                  >
                    {c.name}
                  </button>
                )
              })}
            </div>

            <p style={{ marginTop: 14, fontSize: 14, color: C.sub }}>管理者 PIN（4〜8桁）</p>
            <div
              aria-live="polite"
              aria-label={`入力済み ${pin.length} 桁`}
              style={{
                marginTop: 6, height: 44, borderRadius: 8, border: `1px solid ${C.lineStrong}`, background: C.surface,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 20, letterSpacing: '0.4em', color: C.text,
              }}
            >
              {pin.length === 0 ? <span style={{ fontSize: 13, letterSpacing: 'normal', color: C.mute }}>数字キーで入力</span> : '●'.repeat(pin.length)}
            </div>

            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {digits.map(d => (
                <button
                  key={d}
                  type="button"
                  aria-label={d === 'C' ? 'PINを消去' : d === '⌫' ? '1文字消す' : d}
                  onClick={() => {
                    if (d === 'C') setPin('')
                    else if (d === '⌫') setPin(prev => prev.slice(0, -1))
                    else handleDigit(d)
                  }}
                  disabled={busy}
                  style={{
                    minHeight: 48, borderRadius: 8, fontFamily: SANS, fontSize: 19, fontWeight: 500,
                    background: d === 'C' || d === '⌫' ? C.surface : C.bg, color: C.text,
                    border: `1px solid ${C.line}`, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
                  }}
                >
                  {d}
                </button>
              ))}
            </div>

            {submitError && (
              <p role="alert" style={{ marginTop: 10, fontSize: 14, color: C.danger, lineHeight: 1.6 }}>{submitError}</p>
            )}

            <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
              <SecondaryButton onClick={onCancel} disabled={busy}>キャンセル</SecondaryButton>
              <PrimaryButton onClick={() => void handleSubmit()} disabled={!canSubmit} style={{ flex: 2, minHeight: 46 }}>
                {busy ? '照合中…' : '承認する'}
              </PrimaryButton>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
