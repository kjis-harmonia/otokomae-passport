// 銀二郎SB（予約表）の入口。店舗端末と同じスタッフPIN（サーバー発行のスタッフセッション）で入る。
// お客様アプリ・店舗端末（/staff）・本部とは別の画面で、既存の画面の動きは変えない。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { StaffPinGate } from './screens/StaffPinGate.tsx'
import { SbScreen } from './sb/SbScreen.tsx'

// SB は白地（アプリ共通の黒い背景が端のスクロールで見えないように）
document.documentElement.style.background = '#fff'
document.body.style.background = '#fff'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StaffPinGate app="sb">
      <SbScreen />
    </StaffPinGate>
  </StrictMode>,
)
