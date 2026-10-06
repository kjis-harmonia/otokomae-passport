import { useState, useEffect } from 'react'
import {
  getStaffOperatorCandidates,
  verifyOperator,
  type OperatorCandidate,
  type OperatorSession,
  rpcErrorMessage,
  RpcError,
} from '../../utils/staffSession'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

interface OperatorAuthModalProps {
  onSuccess: (session: OperatorSession) => void
  onCancel?: () => void
  title?: string
  description?: string
}

export function OperatorAuthModal({
  onSuccess,
  onCancel,
  title = '操作者（Operator）認証',
  description = 'POS操作を行うスタッフを選択し、PIN（4〜8桁）を入力してください。',
}: OperatorAuthModalProps) {
  const [candidates, setCandidates] = useState<OperatorCandidate[]>([])
  const [selectedStaffId, setSelectedStaffId] = useState<string>('')
  const [pin, setPin] = useState<string>('')
  const [loadingCandidates, setLoadingCandidates] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoadingCandidates(true)
    getStaffOperatorCandidates()
      .then(list => {
        if (!alive) return
        setCandidates(list)
        if (list.length > 0) {
          setSelectedStaffId(list[0].id)
        }
      })
      .catch(err => {
        if (!alive) return
        setError(rpcErrorMessage(err, '操作者候補一覧の取得に失敗しました。'))
      })
      .finally(() => {
        if (alive) setLoadingCandidates(false)
      })
    return () => {
      alive = false
    }
  }, [])

  async function handleVerify(e?: React.FormEvent) {
    if (e) e.preventDefault()
    if (!selectedStaffId || pin.length < 4 || pin.length > 8 || busy) return

    setBusy(true)
    setError(null)
    try {
      const session = await verifyOperator(selectedStaffId, pin)
      onSuccess(session)
    } catch (err) {
      if (err instanceof RpcError) {
        const detail = err.detail as { remaining_attempts?: number; locked_until?: string } | undefined
        if (err.code === 'invalid_pin' && typeof detail?.remaining_attempts === 'number') {
          setError(`PINが正しくありません。（残り試行可能回数: ${detail.remaining_attempts}回）`)
        } else if (err.code === 'locked') {
          setError('このスタッフアカウントは一時的にロックされています。しばらく待ってからお試しください。')
        } else {
          setError(rpcErrorMessage(err, '操作者の認証に失敗しました。'))
        }
      } else {
        setError(rpcErrorMessage(err, '通信エラーが発生しました。'))
      }
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  function handleKeypad(num: string) {
    if (pin.length < 8) {
      setPin(prev => prev + num)
    }
  }

  function handleBackspace() {
    setPin(prev => prev.slice(0, -1))
  }

  function handleClear() {
    setPin('')
  }

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
              担当者一覧を読み込み中…
            </p>
          ) : candidates.length === 0 ? (
            <div style={{ padding: '16px 0', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: '#E06060', marginBottom: 12 }}>
                認証可能な操作者（スタッフ）が登録されていません。
              </p>
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 8,
                    background: 'rgba(255,255,255,0.08)',
                    color: '#e5e5e5',
                    border: '1px solid rgba(255,255,255,0.15)',
                    cursor: 'pointer',
                  }}
                >
                  閉じる
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={handleVerify}>
              {/* スタッフ選択 */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 11, color: '#C9A24A', letterSpacing: '0.1em', marginBottom: 6 }}>
                  スタッフを選択
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {candidates.map(c => {
                    const selected = selectedStaffId === c.id
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setSelectedStaffId(c.id); setError(null) }}
                        style={{
                          flex: '1 1 calc(50% - 4px)',
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
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 11, color: '#C9A24A', letterSpacing: '0.1em', marginBottom: 6 }}>
                  スタッフ PIN（4〜8桁）
                </label>
                <div
                  style={{
                    height: 48,
                    background: 'rgba(0,0,0,0.45)',
                    border: `1.5px solid ${error ? '#E06060' : pin.length >= 4 ? '#C9A24A' : 'rgba(255,255,255,0.12)'}`,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    letterSpacing: '0.4em',
                    fontSize: 24,
                    color: '#F2E6C8',
                    userSelect: 'none',
                  }}
                >
                  {pin.length === 0 ? (
                    <span style={{ fontSize: 13, color: '#665d52', letterSpacing: '0.1em' }}>PINを入力</span>
                  ) : (
                    '•'.repeat(pin.length)
                  )}
                </div>
              </div>

              {/* エラー表示 */}
              {error && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'rgba(224,96,96,0.15)',
                    border: '1px solid rgba(224,96,96,0.3)',
                    color: '#FFA0A0',
                    fontSize: 12,
                    marginBottom: 14,
                    lineHeight: 1.4,
                  }}
                >
                  {error}
                </div>
              )}

              {/* テンキー */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 18 }}>
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => handleKeypad(num)}
                    disabled={busy || pin.length >= 8}
                    style={{
                      padding: '12px 0',
                      borderRadius: 10,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#F2E6C8',
                      fontSize: 18,
                      fontWeight: 600,
                      cursor: pin.length >= 8 ? 'default' : 'pointer',
                    }}
                  >
                    {num}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={busy || pin.length === 0}
                  style={{
                    padding: '12px 0',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    color: '#a89885',
                    fontSize: 12,
                    cursor: pin.length === 0 ? 'default' : 'pointer',
                  }}
                >
                  クリア
                </button>
                <button
                  key="0"
                  type="button"
                  onClick={() => handleKeypad('0')}
                  disabled={busy || pin.length >= 8}
                  style={{
                    padding: '12px 0',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: '#F2E6C8',
                    fontSize: 18,
                    fontWeight: 600,
                    cursor: pin.length >= 8 ? 'default' : 'pointer',
                  }}
                >
                  0
                </button>
                <button
                  type="button"
                  onClick={handleBackspace}
                  disabled={busy || pin.length === 0}
                  style={{
                    padding: '12px 0',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    color: '#a89885',
                    fontSize: 14,
                    cursor: pin.length === 0 ? 'default' : 'pointer',
                  }}
                >
                  ⌫
                </button>
              </div>

              {/* 確定 & キャンセルボタン */}
              <div style={{ display: 'flex', gap: 10 }}>
                {onCancel && (
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={busy}
                    style={{
                      flex: 1,
                      padding: '14px 0',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: '#a89885',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    キャンセル
                  </button>
                )}
                <button
                  type="submit"
                  disabled={busy || !selectedStaffId || pin.length < 4 || pin.length > 8}
                  style={{
                    flex: 2,
                    padding: '14px 0',
                    borderRadius: 12,
                    background:
                      busy || !selectedStaffId || pin.length < 4
                        ? 'rgba(255,255,255,0.06)'
                        : 'linear-gradient(135deg, #A88432 0%, #C9A24A 50%, #8A6818 100%)',
                    border:
                      busy || !selectedStaffId || pin.length < 4
                        ? '1px solid rgba(255,255,255,0.1)'
                        : '1px solid rgba(243,217,138,0.8)',
                    color: busy || !selectedStaffId || pin.length < 4 ? '#776d60' : '#140c06',
                    fontFamily: SERIF,
                    fontSize: 15,
                    fontWeight: 700,
                    letterSpacing: '0.12em',
                    cursor: busy || !selectedStaffId || pin.length < 4 ? 'default' : 'pointer',
                    boxShadow:
                      busy || !selectedStaffId || pin.length < 4
                        ? 'none'
                        : '0 4px 16px rgba(201,162,74,0.3)',
                  }}
                >
                  {busy ? '認証中…' : '認証して開始'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
