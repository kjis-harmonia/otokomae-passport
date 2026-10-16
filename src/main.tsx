import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/tokens.css'
import './styles/luxury-bg.css'
import App from './App.tsx'
import { CMSApp } from './cms/CMSApp.tsx'
import { StaffPinGate } from './screens/StaffPinGate.tsx'
import { seedInitialStyles } from './utils/styleStorage'
import { setDataAuthMode } from './utils/dataAuthMode'

seedInitialStyles()

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

function detectStaff(): boolean {
  if (window.location.pathname === '/staff') {
    return true
  }
  const params = new URLSearchParams(window.location.search)
  if (params.get('staff') === '1') {
    return true
  }
  const hash = window.location.hash
  if (hash === '#staff') {
    return true
  }
  // The URL selects the screen. Staff authentication remains in StaffPinGate.
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
// 店舗端末は staff_* RPC、お客様アプリは公開読み取り／顧客セッションでデータを扱う
setDataAuthMode(isStaff ? 'staff' : 'customer')

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
