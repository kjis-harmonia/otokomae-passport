import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/tokens.css'
import App from './App.tsx'
import { CMSApp } from './cms/CMSApp.tsx'
import { seedInitialStyles } from './utils/styleStorage'

// Populate default styles on first launch (no-ops when data already exists)
seedInitialStyles()

const isCMS =
  new URLSearchParams(window.location.search).get('cms') === '1' ||
  new URLSearchParams(window.location.search).get('admin') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isCMS ? <CMSApp /> : <App />}
  </StrictMode>,
)
