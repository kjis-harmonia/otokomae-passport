import { useEffect, useState } from 'react'
import { HQ_TABS } from './hqMockData'
import type { HqTab } from './hqMockData'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from './hqTheme'
import { useIsMobile } from './useIsMobile'
import { HqDashboardScreen } from './screens/HqDashboardScreen'
import { HqSalesScreen } from './screens/HqSalesScreen'
import { HqStylistScreen } from './screens/HqStylistScreen'
import { HqMembersScreen } from './screens/HqMembersScreen'
import { HqCustomerKarteScreen } from './screens/HqCustomerKarteScreen'
import { HqInventoryScreen } from './screens/HqInventoryScreen'
import { HqDailyReportScreen } from './screens/HqDailyReportScreen'
import { HqSettingsScreen } from './screens/HqSettingsScreen'

function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

export function HeadquartersApp() {
  const [tab, setTab] = useState<HqTab>('dashboard')
  const [now, setNow] = useState(() => new Date())
  const [menuOpen, setMenuOpen] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  function selectTab(t: HqTab) {
    setTab(t)
    setMenuOpen(false)
  }

  const currentLabel = HQ_TABS.find(t => t.id === tab)?.label

  const screen = (
    <>
      {tab === 'dashboard' && <HqDashboardScreen />}
      {tab === 'sales' && <HqSalesScreen />}
      {tab === 'stylist' && <HqStylistScreen />}
      {tab === 'members' && <HqMembersScreen />}
      {tab === 'customers' && <HqCustomerKarteScreen />}
      {tab === 'inventory' && <HqInventoryScreen />}
      {tab === 'reports' && <HqDailyReportScreen />}
      {tab === 'settings' && <HqSettingsScreen />}
    </>
  )

  if (isMobile) {
    return (
      <div style={{
        minHeight: '100dvh',
        background: `radial-gradient(circle at 12% 0%, rgba(139,26,26,0.10), transparent 38%), radial-gradient(circle at 90% 10%, rgba(201,162,74,0.07), transparent 30%), ${HQ_COLORS.bg}`,
        color: HQ_COLORS.textPrimary,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* ── モバイル用トップバー ── */}
        <header style={{
          position: 'sticky', top: 0, zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: '12px 14px',
          background: HQ_COLORS.bg,
          borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
        }}>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="メニュー"
            style={{
              flexShrink: 0, width: 38, height: 38, borderRadius: 8,
              background: 'rgba(201,162,74,0.10)', border: `1px solid ${HQ_COLORS.panelBorderStrong}`,
              color: HQ_COLORS.goldHi, fontSize: 16, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ☰
          </button>
          <h2 style={{
            flex: '1 1 auto', minWidth: 0, fontFamily: HQ_SERIF, fontSize: 16, fontWeight: 700,
            letterSpacing: '0.04em', color: HQ_COLORS.textPrimary, margin: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {currentLabel}
          </h2>
          <span style={{ flexShrink: 0, fontFamily: HQ_MONO, fontSize: 12, color: HQ_COLORS.goldHi, letterSpacing: '0.02em' }}>
            {fmtClock(now)}
          </span>
        </header>

        {/* ── コンテンツ ── */}
        <main style={{ flex: '1 1 auto', overflowY: 'auto', padding: '14px 12px 32px', minWidth: 0 }}>
          {screen}
        </main>

        {/* ── タブ選択メニュー（全画面オーバーレイ） ── */}
        {menuOpen && (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.92)' }}
            onClick={() => setMenuOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%', maxWidth: 360, height: '100%', overflowY: 'auto',
                background: HQ_COLORS.bg, borderRight: `1px solid ${HQ_COLORS.panelBorder}`,
                padding: '20px 0',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', marginBottom: 28 }}>
                <div>
                  <p style={{ fontFamily: HQ_SANS, fontSize: 9, letterSpacing: '0.28em', color: HQ_COLORS.goldDim, margin: 0, marginBottom: 6 }}>
                    OTOKOMAE PASSPORT
                  </p>
                  <h1 style={{ fontFamily: HQ_SERIF, fontSize: 19, fontWeight: 700, letterSpacing: '0.06em', color: HQ_COLORS.goldHi, margin: 0 }}>
                    銀二郎本部
                  </h1>
                </div>
                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  aria-label="閉じる"
                  style={{
                    width: 34, height: 34, borderRadius: 8, background: 'rgba(255,255,255,0.05)',
                    border: `1px solid ${HQ_COLORS.panelBorder}`, color: HQ_COLORS.textSecondary,
                    fontSize: 16, cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
              <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 12px' }}>
                {HQ_TABS.map((t) => {
                  const active = t.id === tab
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => selectTab(t.id)}
                      style={{
                        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                        padding: '15px 14px',
                        background: active ? 'rgba(201,162,74,0.10)' : 'transparent',
                        border: 'none',
                        borderLeft: active ? `2px solid ${HQ_COLORS.gold}` : '2px solid transparent',
                        borderRadius: 2,
                        color: active ? HQ_COLORS.goldHi : HQ_COLORS.textSecondary,
                        fontFamily: HQ_SANS, fontSize: 15, fontWeight: active ? 600 : 400,
                        letterSpacing: '0.04em',
                        cursor: 'pointer', textAlign: 'left',
                        WebkitTapHighlightColor: 'transparent',
                      }}
                    >
                      <span>{t.label}</span>
                      <span style={{ fontFamily: HQ_MONO, fontSize: 9, color: HQ_COLORS.textMute, letterSpacing: '0.08em' }}>
                        {t.code}
                      </span>
                    </button>
                  )
                })}
              </nav>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100dvh',
      background: `radial-gradient(circle at 12% 0%, rgba(139,26,26,0.10), transparent 38%), radial-gradient(circle at 90% 10%, rgba(201,162,74,0.07), transparent 30%), ${HQ_COLORS.bg}`,
      color: HQ_COLORS.textPrimary,
      display: 'flex',
    }}>
      {/* ── サイドバー（デスクトップ） ── */}
      <aside style={{
        width: 220, flexShrink: 0,
        borderRight: `1px solid ${HQ_COLORS.panelBorder}`,
        display: 'flex', flexDirection: 'column',
        padding: '24px 0',
      }}>
        <div style={{ padding: '0 22px', marginBottom: 36 }}>
          <p style={{
            fontFamily: HQ_SANS, fontSize: 9, letterSpacing: '0.28em',
            color: HQ_COLORS.goldDim, margin: 0, marginBottom: 6,
          }}>
            OTOKOMAE PASSPORT
          </p>
          <h1 style={{
            fontFamily: HQ_SERIF, fontSize: 19, fontWeight: 700, letterSpacing: '0.06em',
            color: HQ_COLORS.goldHi, margin: 0,
            textShadow: '0 0 18px rgba(201,162,74,0.25)',
          }}>
            銀二郎本部
          </h1>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 12px' }}>
          {HQ_TABS.map((t) => {
            const active = t.id === tab
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                style={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                  padding: '11px 12px',
                  background: active ? 'rgba(201,162,74,0.10)' : 'transparent',
                  border: 'none',
                  borderLeft: active ? `2px solid ${HQ_COLORS.gold}` : '2px solid transparent',
                  borderRadius: 2,
                  color: active ? HQ_COLORS.goldHi : HQ_COLORS.textSecondary,
                  fontFamily: HQ_SANS, fontSize: 13, fontWeight: active ? 600 : 400,
                  letterSpacing: '0.04em',
                  cursor: 'pointer', textAlign: 'left',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <span>{t.label}</span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 9, color: HQ_COLORS.textMute, letterSpacing: '0.08em' }}>
                  {t.code}
                </span>
              </button>
            )
          })}
        </nav>

        <div style={{ marginTop: 'auto', padding: '0 22px' }}>
          <div style={{
            borderTop: `1px solid ${HQ_COLORS.panelBorder}`, paddingTop: 16,
            fontFamily: HQ_MONO, fontSize: 10, color: HQ_COLORS.textMute, letterSpacing: '0.04em',
          }}>
            UI PROTOTYPE — DUMMY DATA
          </div>
        </div>
      </aside>

      {/* ── メインカラム ── */}
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── トップバー ── */}
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 28px',
          borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
        }}>
          <h2 style={{
            fontFamily: HQ_SERIF, fontSize: 17, fontWeight: 700, letterSpacing: '0.04em',
            color: HQ_COLORS.textPrimary, margin: 0,
          }}>
            {currentLabel}
          </h2>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, fontFamily: HQ_MONO }}>
            <span style={{ fontSize: 12, color: HQ_COLORS.textSecondary }}>{fmtDate(now)}</span>
            <span style={{ fontSize: 13, color: HQ_COLORS.goldHi, letterSpacing: '0.04em' }}>{fmtClock(now)}</span>
          </div>
        </header>

        {/* ── コンテンツ ── */}
        <main style={{ flex: '1 1 auto', overflowY: 'auto', padding: 28 }}>
          {screen}
        </main>
      </div>
    </div>
  )
}
