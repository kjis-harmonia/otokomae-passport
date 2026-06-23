import { useEffect, useState } from 'react'
import { HQ_TABS } from './hqMockData'
import type { HqTab } from './hqMockData'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from './hqTheme'
import { HqDashboardScreen } from './screens/HqDashboardScreen'
import { HqSalesScreen } from './screens/HqSalesScreen'
import { HqStylistScreen } from './screens/HqStylistScreen'
import { HqMembersScreen } from './screens/HqMembersScreen'
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

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div style={{
      minHeight: '100dvh',
      background: `radial-gradient(circle at 12% 0%, rgba(139,26,26,0.10), transparent 38%), radial-gradient(circle at 90% 10%, rgba(201,162,74,0.07), transparent 30%), ${HQ_COLORS.bg}`,
      color: HQ_COLORS.textPrimary,
      display: 'flex',
    }}>
      {/* ── サイドバー ── */}
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
            {HQ_TABS.find(t => t.id === tab)?.label}
          </h2>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, fontFamily: HQ_MONO }}>
            <span style={{ fontSize: 12, color: HQ_COLORS.textSecondary }}>{fmtDate(now)}</span>
            <span style={{ fontSize: 13, color: HQ_COLORS.goldHi, letterSpacing: '0.04em' }}>{fmtClock(now)}</span>
          </div>
        </header>

        {/* ── コンテンツ ── */}
        <main style={{ flex: '1 1 auto', overflowY: 'auto', padding: 28 }}>
          {tab === 'dashboard' && <HqDashboardScreen />}
          {tab === 'sales' && <HqSalesScreen />}
          {tab === 'stylist' && <HqStylistScreen />}
          {tab === 'members' && <HqMembersScreen />}
          {tab === 'inventory' && <HqInventoryScreen />}
          {tab === 'reports' && <HqDailyReportScreen />}
          {tab === 'settings' && <HqSettingsScreen />}
        </main>
      </div>
    </div>
  )
}
