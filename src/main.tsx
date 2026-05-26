import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/tokens.css'
import App from './App.tsx'
import { CMSApp } from './cms/CMSApp.tsx'
import { seedInitialStyles } from './utils/styleStorage'

seedInitialStyles()

const CMS_KEY = 'ginjiro_admin_mode'

function detectCMS(): boolean {
  const params = new URLSearchParams(window.location.search)
  // Query param: ?cms=1 or ?admin=1
  if (params.get('cms') === '1' || params.get('admin') === '1') {
    localStorage.setItem(CMS_KEY, '1')
    sessionStorage.setItem(CMS_KEY, '1')
    return true
  }
  // Hash fallback for PWA home screen: #admin or #cms
  const hash = window.location.hash
  if (hash === '#admin' || hash === '#cms') {
    localStorage.setItem(CMS_KEY, '1')
    sessionStorage.setItem(CMS_KEY, '1')
    return true
  }
  // Persist within same session (survives refresh, internal navigation)
  if (sessionStorage.getItem(CMS_KEY) === '1') return true
  // Persist across sessions (for PWA standalone, home screen shortcuts)
  if (localStorage.getItem(CMS_KEY) === '1') return true
  return false
}

const isCMS = detectCMS()

function exitCMS() {
  localStorage.removeItem(CMS_KEY)
  sessionStorage.removeItem(CMS_KEY)
  window.location.replace(window.location.pathname)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isCMS ? <CMSApp onExit={exitCMS} /> : <App />}
  </StrictMode>,
)
