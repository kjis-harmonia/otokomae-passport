import { useState, useEffect, type FormEvent } from 'react'
import {
  getStaffManagerCandidates,
  approvePosOperation,
  type ManagerCandidate,
} from '../../utils/posManagerApproval'
import { getCurrentOperator, isCurrentOperatorValid } from '../../utils/posOperatorSession'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

interface ManagerApprovalModalProps {
  action: string
  requestHash: string
  onApproved: (approvalToken: string) => void
  onCancel: () => void
  onOperatorAuthRequired?: () => void
  title?: string
  description?: string
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

export function ManagerApprovalModal({
  action,
  requestHash,
  onApproved,
  onCancel,
  onOperatorAuthRequired,
  title = '管理者承認 (L2)',
  description = 'この操作を実行するには店長または管理者の承認が必要です。',
}: ManagerApprovalModalProps) {
  const [candidates, setCandidates] = useState<ManagerCandidate[]>([])
  const [selectedStaffId, setSelectedStaffId] = useState<string>('')
  const [pin, setPin] = useState<string>('')
  const [loadingCandidates, setLoadingCandidates] = useState(true)
  const [busy, setBusy] = useState(false)
  const [candidateLoadError, setCandidateLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const op = getCurrentOperator()
    if (!op || !isCurrentOperatorValid()) {
      onOperatorAuthRequired?.()
      setLoadingCandidates(false)
      return
    }

    setLoadingCandidates(true)
    setCandidateLoadError(null)
    getStaffManagerCandidates(op.operatorToken)
      .then(res => {
        if (!alive) return
        if (!res.ok) {
          if (isOperatorAuthError(res.error)) {
            onOperatorAuthRequired?.()
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
  }, [onOperatorAuthRequired])

  async function handleSubmit(e?: FormEvent) {
    if (e) e.preventDefault()
    if (busy || !selectedStaffId || pin.length < 4 || pin.length > 8) return

    const op = getCurrentOperator()
    if (!op || !isCurrentOperatorValid()) {
      onOperatorAuthRequired?.()
      return
    }

    setBusy(true)
    setSubmitError(null)

    try {
      const res = await approvePosOperation({
        managerStaffId: selectedStaffId,
        managerPin: pin,
        action,
        requestHash,
      }, op.operatorToken)

      if (!res.ok) {
        if (isOperatorAuthError(res.error)) {
          onOperatorAuthRequired?.()
          return
        }
        setSubmitError(getErrorMessage(res.error, res.remaining_attempts, res.locked_until))
        setPin('')
        return
      }

      setPin('')
      onApproved(res.approvalToken)
    } catch {
      // 承認 API の通信結果不明。発行されていても使われずに期限切れになるため、金銭処理は行われていない
      setSubmitError('通信を確認できませんでした。この承認は使われません。通信状態を確認してからPINを入力してください。')
      setPin('')
    } finally {
      setBusy(false)
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

  function handleBackspace() {
    setPin(prev => prev.slice(0, -1))
  }

  function handleClear() {
    setPin('')
  }

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'linear-gradient(160deg, #180d08 0%, #0c0604 100%)',
          border: '1px solid rgba(201,162,74,0.4)',
          borderRadius: 20,
          boxShadow: '0 20px 50px rgba(0,0,0,0.8), 0 0 30px rgba(201,162,74,0.15)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #C9A24A, transparent)' }} />

        <div style={{ padding: '24px 24px 20px' }}>
          <h2
            style={{
              fontFamily: SERIF,
              fontSize: 20,
              fontWeight: 700,
              color: '#F2E6C8',
              letterSpacing: '0.08em',
              marginBottom: 6,
            }}
          >
            {title}
          </h2>
          <p style={{ fontSize: 12, color: '#b3a088', lineHeight: 1.5, marginBottom: 18 }}>
            {description}
          </p>

          {loadingCandidates ? (
            <p style={{ fontSize: 13, color: '#C9A24A', textAlign: 'center', padding: '20px 0' }}>
              管理者一覧を読み込み中…
            </p>
          ) : candidateLoadError ? (
            <div style={{ padding: '16px 0', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: '#E06060', marginBottom: 16 }}>
                {candidateLoadError}
              </p>
              <button
                type="button"
                onClick={onCancel}
                style={{
                  minHeight: 44,
                  padding: '10px 24px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.08)',
                  color: '#e5e5e5',
                  border: '1px solid rgba(255,255,255,0.15)',
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                戻る
              </button>
            </div>
          ) : candidates.length === 0 ? (
            <div style={{ padding: '16px 0', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: '#E06060', marginBottom: 16 }}>
                承認可能な管理者が設定されていません。
              </p>
              <button
                type="button"
                onClick={onCancel}
                style={{
                  minHeight: 44,
                  padding: '10px 24px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.08)',
                  color: '#e5e5e5',
                  border: '1px solid rgba(255,255,255,0.15)',
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                戻る
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {/* マネージャー選択 */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 11, color: '#C9A24A', letterSpacing: '0.1em', marginBottom: 6 }}>
                  承認する管理者を選択
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {candidates.map(c => {
                    const selected = selectedStaffId === c.id
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setSelectedStaffId(c.id); setSubmitError(null) }}
                        style={{
                          flex: '1 1 calc(50% - 4px)',
                          minHeight: 44,
                          padding: '10px 8px',
                          borderRadius: 10,
                          background: selected ? 'rgba(201,162,74,0.22)' : 'rgba(255,255,255,0.04)',
                          border: `1.5px solid ${selected ? '#C9A24A' : 'rgba(255,255,255,0.08)'}`,
                          color: selected ? '#F2E6C8' : '#a89885',
                          fontFamily: SERIF,
                          fontSize: 14,
                          fontWeight: selected ? 700 : 500,
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                        }}
                      >
                        {c.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* PIN 入力表示 */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 11, color: '#C9A24A', letterSpacing: '0.1em', marginBottom: 6 }}>
                  管理者 PIN（4〜8桁）
                </label>
                <div
                  style={{
                    height: 48,
                    background: '#0B0403',
                    border: '1px solid rgba(201,162,74,0.3)',
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    letterSpacing: '0.4em',
                    fontSize: 24,
                    color: '#F2E6C8',
                  }}
                >
                  {pin.length === 0 ? (
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)', letterSpacing: 'normal' }}>
                      数字キーで入力
                    </span>
                  ) : (
                    '●'.repeat(pin.length)
                  )}
                </div>
              </div>

              {/* テンキー */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
                {digits.map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      if (d === 'C') handleClear()
                      else if (d === '⌫') handleBackspace()
                      else handleDigit(d)
                    }}
                    disabled={busy}
                    style={{
                      minHeight: 46,
                      borderRadius: 10,
                      background: d === 'C' || d === '⌫' ? 'rgba(255,255,255,0.06)' : 'rgba(201,162,74,0.08)',
                      border: '1px solid rgba(201,162,74,0.2)',
                      color: '#F2E6C8',
                      fontSize: 18,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>

              {submitError && (
                <p style={{ fontSize: 12, color: '#E06060', marginBottom: 14, textAlign: 'center', lineHeight: 1.4 }}>
                  {submitError}
                </p>
              )}

              {/* アクションボタン */}
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={busy}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    color: '#a89885',
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={busy || pin.length < 4 || pin.length > 8 || !selectedStaffId}
                  style={{
                    flex: 2,
                    minHeight: 44,
                    borderRadius: 10,
                    background: pin.length >= 4 && selectedStaffId && !busy
                      ? 'linear-gradient(135deg, #C9A24A 0%, #9E7D2B 100%)'
                      : 'rgba(255,255,255,0.1)',
                    border: 'none',
                    color: pin.length >= 4 && selectedStaffId && !busy ? '#0B0403' : 'rgba(255,255,255,0.3)',
                    fontFamily: SERIF,
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: pin.length >= 4 && selectedStaffId && !busy ? 'pointer' : 'not-allowed',
                    boxShadow: pin.length >= 4 && selectedStaffId && !busy ? '0 4px 12px rgba(201,162,74,0.3)' : 'none',
                  }}
                >
                  {busy ? '照合中…' : '承認を確定'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
