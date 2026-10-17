import { useRef, useState, type ReactNode } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Database, Package, ScanLine, Users, Wallet } from 'lucide-react'
import { AdminScreen } from './AdminScreen'
import { StaffInventoryScreen } from './StaffInventoryScreen'
import { StaffReservationsScreen } from './StaffReservationsScreen'
import { StaffClientsScreen } from './StaffClientsScreen'
import { StaffGinpayScreen } from './StaffGinpayScreen'
import type { PendingChangeSummary, StaffInventoryHandle } from './StaffInventoryScreen'
import './staffTerminal.css'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

type StaffMode = 'menu' | 'shop' | 'ginpay' | 'reservations' | 'clients' | 'inventory' | 'recovery'

/**
 * /staff を開いた直後の分岐画面 + 戻るナビゲーション。
 * 店舗端末は日常業務用のQR読み取り、在庫管理は店販管理、会員復旧は必要時だけ使う導線。
 * メニューは iOS の設定アプリのような一覧（毎日の業務／管理の2つにまとめる）。
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
      <div className="st-app">
        <div className="st-menu st-home">
          <header className="st-head">
            <h1><span className="st-wordmark">銀二郎</span><span className="st-mark">端末</span></h1>
            <p className="st-latin"><i aria-hidden="true" />GINJIRO</p>
          </header>

          <h2 className="st-section"><span>毎日の業務</span><small>DAILY WORK</small></h2>
          <div className="st-tray">
            <MenuRow icon={<ScanLine size={30} />} tone="gold" title="店舗端末" sub="会員QR・来店・割引券" onClick={() => setMode('shop')} />
            <MenuRow icon={<Wallet size={30} />} tone="dark" title="銀Pay チャージ" sub="現金でチャージ・残高" onClick={() => setMode('ginpay')} />
            <MenuRow icon={<CalendarDays size={30} />} title="予約" sub="予約台帳・電話予約" onClick={() => setMode('reservations')} />
            <MenuRow icon={<Users size={30} />} title="顧客" sub="顧客一覧・顧客台帳" onClick={() => setMode('clients')} />
          </div>

          <h2 className="st-section"><span>管理</span><small>MANAGEMENT</small></h2>
          <div className="st-tray">
            <MenuRow icon={<Package size={30} />} title="在庫管理" sub="店販・在庫・発注" onClick={() => setMode('inventory')} />
            <MenuRow icon={<Database size={30} />} title="会員復旧" sub="機種変更・データ移管" onClick={() => setMode('recovery')} />
          </div>
        </div>
      </div>
    )
  }

  // 予約台帳は一日中表示する明るい画面なので、戻るバーも明るく揃える
  const light = mode === 'reservations' || mode === 'clients' || mode === 'ginpay'

  return (
    <div className={mode === 'ginpay' ? 'st-app' : undefined} style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: mode === 'ginpay' ? undefined : light ? '#FFFFFF' : '#080302' }}>
      {light ? (
        <div className="st-app st-bar"><button type="button" className="st-back" onClick={handleBackClick}><ChevronLeft size={24} />メニュー</button></div>
      ) : (
      <div style={{
        position: 'sticky', top: 0, zIndex: 650,
        background: light ? '#FFFFFF' : '#000000', borderBottom: light ? '1px solid #E7E7E3' : '1px solid rgba(201,162,74,0.2)',
        padding: '10px 16px', flexShrink: 0,
      }}>
        <button
          type="button"
          onClick={handleBackClick}
          style={light ? {
            padding: '8px 4px', minHeight: 36, background: 'none', border: 'none',
            color: '#1B1B1A', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          } : {
            padding: '8px 16px', borderRadius: 10,
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.16)',
            color: '#e5e5e5', fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em',
            cursor: 'pointer',
          }}
        >
          ← 戻る
        </button>
      </div>
      )}

      <div style={{ flex: '1 1 auto' }}>
        {mode === 'shop'
          ? <AdminScreen key="staff-issue" mode="issue" />
          : mode === 'reservations'
            ? <StaffReservationsScreen />
            : mode === 'clients'
            ? <StaffClientsScreen />
            : mode === 'ginpay'
            ? <StaffGinpayScreen />
            : mode === 'recovery'
              ? <AdminScreen key="staff-recovery" mode="recovery" />
              : <StaffInventoryScreen ref={inventoryRef} />}
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

function MenuRow({ icon, title, sub, tone = 'light', onClick }: { icon: ReactNode; title: string; sub: string; tone?: 'gold' | 'dark' | 'light'; onClick: () => void }) {
  return (
    <button type="button" className="st-row" onClick={onClick}>
      <span className={`st-tile st-tile-${tone}`}>{icon}</span>
      <span className="st-row-main"><strong>{title}</strong><small>{sub}</small></span>
      <ChevronRight size={24} />
    </button>
  )
}
