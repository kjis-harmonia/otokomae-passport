import { useRef, useState } from 'react'
import { AdminScreen } from './AdminScreen'
import { StaffInventoryScreen } from './StaffInventoryScreen'
import type { PendingChangeSummary, StaffInventoryHandle } from './StaffInventoryScreen'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

type StaffMode = 'menu' | 'shop' | 'inventory'

/**
 * /staff を開いた直後の分岐画面 + 戻るナビゲーション。
 * 「店舗端末」= 既存のAdminScreen（営業開始/終了・会計アシスト・チケット・LIVE STATUS・
 * 会員復旧 等、これまでの /staff そのまま）。「在庫管理」= 銀二郎本部と同じ products
 * テーブル・hqInventoryStore を共有する新しい在庫管理画面。
 */
export function StaffHome() {
  const [mode, setMode] = useState<StaffMode>('menu')
  const inventoryRef = useRef<StaffInventoryHandle>(null)
  const [pendingSummary, setPendingSummary] = useState<PendingChangeSummary[] | null>(null)
  const [confirmingBack, setConfirmingBack] = useState(false)

  function handleBackClick() {
    if (mode === 'inventory' && inventoryRef.current?.hasPendingChanges()) {
      setPendingSummary(inventoryRef.current.getPendingSummary())
      return
    }
    setMode('menu')
  }

  async function handleConfirmAndBack() {
    setConfirmingBack(true)
    const ok = await inventoryRef.current?.confirmChanges()
    setConfirmingBack(false)
    setPendingSummary(null)
    if (ok) setMode('menu')
  }

  function handleDiscardAndBack() {
    setPendingSummary(null)
    setMode('menu')
  }

  if (mode === 'menu') {
    return (
      <div style={{
        minHeight: '100dvh',
        background: 'linear-gradient(180deg, #080302 0%, #0A0403 60%, #090304 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '0 24px',
      }}>
        <p style={{ fontSize: 10, letterSpacing: '0.32em', color: '#e5e5e5', marginBottom: 6 }}>
          STAFF TERMINAL
        </p>
        <h1 style={{
          fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#F2E6C8',
          letterSpacing: '0.1em', marginBottom: 48,
        }}>
          銀二郎端末
        </h1>

        <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <button
            type="button"
            onClick={() => setMode('shop')}
            style={{
              width: '100%', padding: '26px 20px', borderRadius: 18, textAlign: 'left',
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.5)', cursor: 'pointer',
            }}
          >
            <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 800, color: '#ffffff', letterSpacing: '0.06em', marginBottom: 6 }}>
              店舗端末
            </p>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
              会計・QR・LIVE STATUS
            </p>
          </button>

          <button
            type="button"
            onClick={() => setMode('inventory')}
            style={{
              width: '100%', padding: '26px 20px', borderRadius: 18, textAlign: 'left',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(201,162,74,0.4)', cursor: 'pointer',
            }}
          >
            <p style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 800, color: '#C9A24A', letterSpacing: '0.06em', marginBottom: 6 }}>
              在庫管理
            </p>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
              店販・在庫・発注確認
            </p>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: '#080302' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 650,
        background: '#000000', borderBottom: '1px solid rgba(201,162,74,0.2)',
        padding: '10px 16px', flexShrink: 0,
      }}>
        <button
          type="button"
          onClick={handleBackClick}
          style={{
            padding: '8px 16px', borderRadius: 10,
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.16)',
            color: '#e5e5e5', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em',
            cursor: 'pointer',
          }}
        >
          ← 戻る
        </button>
      </div>

      <div style={{ flex: '1 1 auto' }}>
        {mode === 'shop' ? <AdminScreen /> : <StaffInventoryScreen ref={inventoryRef} />}
      </div>

      {pendingSummary && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ width: '100%', maxWidth: 360, borderRadius: 16, background: '#0A0A0A', border: '1px solid rgba(201,162,74,0.3)', padding: 20 }}>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#ffffff', marginBottom: 6 }}>
              未確定の在庫変更があります。
            </p>
            <p style={{ fontSize: 13, color: '#e5e5e5', marginBottom: 14 }}>
              変更内容を確定して戻りますか？
            </p>
            <div style={{
              borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
              padding: '10px 12px', marginBottom: 18,
            }}>
              {pendingSummary.map((c) => (
                <p key={c.productId} style={{ fontSize: 13, color: '#C9A24A', margin: '2px 0' }}>
                  ・{c.name} {c.delta > 0 ? '+' : ''}{c.delta}
                </p>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button" onClick={handleDiscardAndBack} disabled={confirmingBack}
                style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 14, cursor: 'pointer' }}
              >
                いいえ
              </button>
              <button
                type="button" onClick={() => void handleConfirmAndBack()} disabled={confirmingBack}
                style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'rgba(201,162,74,0.18)', border: '1px solid #C9A24A', color: '#C9A24A', fontFamily: SERIF, fontSize: 14, fontWeight: 700, cursor: confirmingBack ? 'default' : 'pointer' }}
              >
                {confirmingBack ? '保存中…' : 'はい'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
