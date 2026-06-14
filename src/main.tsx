import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/tokens.css'
import App from './App.tsx'
import { CMSApp } from './cms/CMSApp.tsx'
import { StaffPinGate } from './screens/StaffPinGate.tsx'
import { seedInitialStyles } from './utils/styleStorage'

seedInitialStyles()

// ── PWA manifest: /staff ページでは staff 用 manifest に差し替える ─────────────
// React マウント前に同期実行することでブラウザが正しい manifest を読む
;(function swapManifestIfStaff() {
  if (!window.location.pathname.startsWith('/staff')) return
  const link = document.getElementById('pwa-manifest') as HTMLLinkElement | null
  if (link) link.href = '/manifest-staff.webmanifest'
})()

// ── CMS detection ─────────────────────────────────────────────────────────────

const CMS_KEY = 'ginjiro_admin_mode'

function detectCMS(): boolean {
  const params = new URLSearchParams(window.location.search)
  if (params.get('cms') === '1' || params.get('admin') === '1') {
    localStorage.setItem(CMS_KEY, '1')
    sessionStorage.setItem(CMS_KEY, '1')
    return true
  }
  const hash = window.location.hash
  if (hash === '#admin' || hash === '#cms') {
    localStorage.setItem(CMS_KEY, '1')
    sessionStorage.setItem(CMS_KEY, '1')
    return true
  }
  if (sessionStorage.getItem(CMS_KEY) === '1') return true
  if (localStorage.getItem(CMS_KEY) === '1') return true
  return false
}

function exitCMS() {
  localStorage.removeItem(CMS_KEY)
  sessionStorage.removeItem(CMS_KEY)
  window.location.replace(window.location.pathname)
}

// ── Staff scanner detection ───────────────────────────────────────────────────

const STAFF_KEY = 'ginjiro_staff_mode'

function detectStaff(): boolean {
  if (window.location.pathname === '/staff') {
    sessionStorage.setItem(STAFF_KEY, '1')
    return true
  }
  const params = new URLSearchParams(window.location.search)
  if (params.get('staff') === '1') {
    sessionStorage.setItem(STAFF_KEY, '1')
    return true
  }
  const hash = window.location.hash
  if (hash === '#staff') {
    sessionStorage.setItem(STAFF_KEY, '1')
    return true
  }
  // Session-only persistence (closes on tab close — intentional for staff security)
  if (sessionStorage.getItem(STAFF_KEY) === '1') return true
  return false
}

// ── Service Worker ────────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW 登録失敗は非致命的 — 通知機能がグレースフルデグラデーション
    })
  })
}

// ── Render ────────────────────────────────────────────────────────────────────

const isStaff = detectStaff()
const isCMS   = !isStaff && detectCMS()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isStaff ? (
      <StaffPinGate />
    ) : isCMS ? (
      <CMSApp onExit={exitCMS} />
    ) : (
      <App />
    )}
  </StrictMode>,
)
