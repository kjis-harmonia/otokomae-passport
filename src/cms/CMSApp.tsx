import { useState, useCallback } from 'react'
import { LayoutDashboard, List, ExternalLink, LogOut } from 'lucide-react'
import { CMSDashboard } from './CMSDashboard'
import { CMSStyleList } from './CMSStyleList'
import { CMSStyleForm } from './CMSStyleForm'
import { loadStyles } from '../utils/styleStorage'
import type { StyleCard } from '../data/styleCard'

type CMSTab = 'dashboard' | 'list'
type CMSView = CMSTab | 'form'

interface Props {
  onExit: () => void
}

export function CMSApp({ onExit }: Props) {
  const [tab, setTab] = useState<CMSTab>('dashboard')
  const [view, setView] = useState<CMSView>('dashboard')
  const [editingStyle, setEditingStyle] = useState<StyleCard | null>(null)
  const [styles, setStyles] = useState<StyleCard[]>(loadStyles)

  const refresh = useCallback(() => {
    setStyles(loadStyles())
  }, [])

  function openForm(id: string | null) {
    setEditingStyle(id ? styles.find((s) => s.id === id) ?? null : null)
    setView('form')
  }

  function handleFormSave() {
    refresh()
    setView(tab)
  }

  function handleFormCancel() {
    setView(tab)
  }

  function switchTab(next: CMSTab) {
    setTab(next)
    setView(next)
  }

  const NAV_ITEMS: { id: CMSTab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'ダッシュボード', icon: <LayoutDashboard size={22} strokeWidth={1.8} /> },
    { id: 'list', label: 'スタイル管理', icon: <List size={22} strokeWidth={1.8} /> },
  ]

  return (
    /* Outer: fills viewport, dark background visible on wide screens */
    <div
      style={{
        height: '100dvh',
        overflow: 'hidden',
        background: 'linear-gradient(160deg, #080604 0%, #0D0907 50%, #0F0708 100%)',
        color: '#F2E6C8',
        fontFamily: 'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif',
      }}
    >
      {/* Inner: phone-width column, scroll-contained */}
      <div
        style={{
          maxWidth: 430,
          width: '100%',
          margin: '0 auto',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* iOS status-bar spacer */}
        <div style={{ height: 'env(safe-area-inset-top, 0px)', flexShrink: 0 }} />

        {/* ── Header ── */}
        <header
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            background: 'rgba(7,4,3,0.98)',
            borderBottom: '1px solid rgba(201,169,97,0.2)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          {/* Logo + ADMIN badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>✂</span>
            <div>
              <div
                style={{
                  display: 'inline-block',
                  background: 'rgba(160,20,20,0.9)',
                  border: '1px solid rgba(220,60,60,0.6)',
                  borderRadius: 4,
                  padding: '2px 7px',
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: '0.24em',
                  color: '#FFD0D0',
                  marginBottom: 3,
                  textTransform: 'uppercase',
                }}
              >
                ADMIN MODE
              </div>
              <p
                style={{
                  fontSize: 15,
                  fontWeight: 800,
                  color: '#F2E6C8',
                  lineHeight: 1,
                  letterSpacing: '0.05em',
                }}
              >
                銀二郎 CMS
              </p>
            </div>
          </div>

          {/* Right actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={() => window.open(window.location.pathname + '?tab=styles', '_blank')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '8px 11px',
                borderRadius: 9,
                background: 'rgba(201,169,97,0.08)',
                border: '1px solid rgba(201,169,97,0.3)',
                color: 'rgba(201,169,97,0.85)',
                fontSize: 11,
                fontWeight: 600,
                minHeight: 38,
                cursor: 'pointer',
                touchAction: 'manipulation',
              }}
            >
              <ExternalLink size={12} />
              確認
            </button>
            <button
              type="button"
              onClick={onExit}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '8px 11px',
                borderRadius: 9,
                background: 'rgba(110,15,15,0.6)',
                border: '1px solid rgba(180,45,45,0.55)',
                color: 'rgba(255,150,150,0.95)',
                fontSize: 11,
                fontWeight: 700,
                minHeight: 38,
                cursor: 'pointer',
                touchAction: 'manipulation',
              }}
            >
              <LogOut size={12} />
              終了
            </button>
          </div>
        </header>

        {/* ── Scrollable main ── */}
        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
          }}
        >
          {view === 'dashboard' && (
            <CMSDashboard
              styles={styles}
              onGoToList={() => switchTab('list')}
              onAddNew={() => openForm(null)}
            />
          )}
          {view === 'list' && (
            <CMSStyleList
              styles={styles}
              onChange={refresh}
              onEdit={(id) => openForm(id)}
              onAddNew={() => openForm(null)}
            />
          )}
          {view === 'form' && (
            <CMSStyleForm
              key={editingStyle?.id ?? 'new'}
              initialStyle={editingStyle}
              onSave={handleFormSave}
              onCancel={handleFormCancel}
            />
          )}
        </main>

        {/* ── Bottom navigation (hidden in form) ── */}
        {view !== 'form' && (
          <nav
            style={{
              flexShrink: 0,
              display: 'flex',
              background: 'rgba(7,4,3,0.98)',
              borderTop: '1px solid rgba(201,169,97,0.18)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            {NAV_ITEMS.map((item) => {
              const isActive = tab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => switchTab(item.id)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    padding: '10px 0 12px',
                    fontSize: 10,
                    fontWeight: isActive ? 700 : 400,
                    letterSpacing: '0.06em',
                    color: isActive ? '#E8C547' : 'rgba(245,240,232,0.32)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    touchAction: 'manipulation',
                    minHeight: 58,
                    position: 'relative',
                  }}
                >
                  {isActive && (
                    <span
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        height: 2,
                        width: 28,
                        borderRadius: 999,
                        background: 'linear-gradient(90deg, transparent, #E8C547, transparent)',
                        boxShadow: '0 0 10px rgba(232,197,71,0.5)',
                      }}
                    />
                  )}
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>
        )}
      </div>
    </div>
  )
}
