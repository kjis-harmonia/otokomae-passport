import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/tokens.css'
import App from './App.tsx'
import { CMSApp } from './cms/CMSApp.tsx'

const isCMS = new URLSearchParams(window.location.search).get('admin') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isCMS ? <CMSApp /> : <App />}
  </StrictMode>,
)
