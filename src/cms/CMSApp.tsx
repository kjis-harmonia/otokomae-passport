import { useState, useCallback } from 'react'
import { LayoutDashboard, List } from 'lucide-react'
import { CMSDashboard } from './CMSDashboard'
import { CMSStyleList } from './CMSStyleList'
import { CMSStyleForm } from './CMSStyleForm'
import { loadStyles } from '../utils/styleStorage'
import type { StyleCard } from '../data/styleCard'

type CMSTab = 'dashboard' | 'list'
type CMSView = CMSTab | 'form'

export function CMSApp() {
  const [tab, setTab] = useState<CMSTab>('dashboard')
  const [view, setView] = useState<CMSView>('dashboard')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [styles, setStyles] = useState<StyleCard[]>(loadStyles)

  const refresh = useCallback(() => {
    setStyles(loadStyles())
  }, [])

  function openForm(id: string | null) {
    setEditingId(id)
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

  return (
    <div
      className="flex flex-col"
      style={{
        minHeight: '100dvh',
        background: 'linear-gradient(160deg, #080604 0%, #0D0907 50%, #0F0708 100%)',
        color: '#F2E6C8',
        fontFamily: 'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif',
      }}
    >
      {/* Status-bar spacer (safe area) */}
      <div style={{ height: 'env(safe-area-inset-top, 0px)' }} />

      {/* Top bar */}
      <header
        className="flex items-center justify-between px-5 py-3 flex-shrink-0"
        style={{
          background: 'rgba(7,4,3,0.95)',
          borderBottom: '1px solid rgba(201,169,97,0.18)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 18 }}>✂</span>
          <div>
            <p className="text-[9px] tracking-[0.3em] uppercase" style={{ color: 'rgba(201,169,97,0.5)' }}>
              Ginjiro
            </p>
            <p className="text-sm font-bold leading-tight tracking-wider" style={{ color: '#F2E6C8' }}>
              CMS
            </p>
          </div>
        </div>
        <div
          className="rounded-full px-3 py-1 text-[10px] tracking-[0.16em] uppercase"
          style={{
            background: 'rgba(201,169,97,0.1)',
            border: '1px solid rgba(201,169,97,0.22)',
            color: 'rgba(201,169,97,0.7)',
          }}
        >
          Admin
        </div>
      </header>

      {/* Main content — scrollable */}
      <main className="flex-1 overflow-y-auto">
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
            editingId={editingId}
            onSave={handleFormSave}
            onCancel={handleFormCancel}
          />
        )}
      </main>

      {/* Bottom navigation (hidden when form is open) */}
      {view !== 'form' && (
        <nav
          className="flex-shrink-0 flex"
          style={{
            background: 'rgba(7,4,3,0.96)',
            borderTop: '1px solid rgba(201,169,97,0.18)',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            backdropFilter: 'blur(10px)',
          }}
        >
          {(
            [
              { id: 'dashboard', label: 'ダッシュボード', icon: <LayoutDashboard size={20} strokeWidth={1.8} /> },
              { id: 'list', label: 'スタイル管理', icon: <List size={20} strokeWidth={1.8} /> },
            ] as { id: CMSTab; label: string; icon: React.ReactNode }[]
          ).map((item) => {
            const isActive = tab === item.id && (view as string) !== 'form'
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => switchTab(item.id)}
                className="relative flex-1 flex flex-col items-center justify-center gap-1 py-3 text-[10px] tracking-wider transition-colors active:opacity-70"
                style={{ color: isActive ? '#E8C547' : 'rgba(245,240,232,0.34)' }}
              >
                {isActive && (
                  <span
                    className="absolute top-1 h-0.5 w-6 rounded-full"
                    style={{
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
  )
}
