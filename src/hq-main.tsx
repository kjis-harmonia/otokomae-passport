import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import { HeadquartersApp } from './hq/HeadquartersApp'
import { HqPinGate } from './hq/HqPinGate'
import { setDataAuthMode } from './utils/dataAuthMode'

// 本部画面のデータは本部セッション（hq_* RPC）で扱う
setDataAuthMode('hq')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 本部専用 PIN（店舗スタッフ PIN とは別）で本部セッションを取得してから表示 */}
    <HqPinGate>
      <HeadquartersApp />
    </HqPinGate>
  </StrictMode>,
)
