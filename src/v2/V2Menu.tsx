// V2.0 の ☰：ホームに出さない機能の入口。機能は消さず、ここから開く。
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, ExternalLink, KeyRound, Phone, Smartphone, Ticket, Users } from 'lucide-react'
import { PushToggle } from '../components/PushToggle'
import { canShowInstallGuide, SHOW_INSTALL_GUIDE_EVENT } from '../utils/installGuide'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../data/wallet'
import { useState } from 'react'
import { isStaging } from '../utils/env'
import { resetStagingTester } from './stagingReset'

/** HOT PEPPER Beauty のお店のページ */
const HOTPEPPER_SHOP_URL = 'https://beauty.hotpepper.jp/slnH000583749/'

/** onPeople：「いつもの・お連れ様」（Staging から・本番は承認のあと） */
export function V2Menu({ open, onClose, onTickets, onAccount, onPeople }: { open: boolean; onClose: () => void; onTickets: () => void; onAccount: () => void; onPeople?: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="back" className="v2-sheet-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div key="sheet" className="v2-sheet" role="dialog" aria-modal="true" aria-label="メニュー"
            initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}>
            <div className="v2-grab" />
            <div className="v2-panel v2-glass" style={{ padding: '4px 14px' }}>
              {onPeople && <button type="button" className="v2-row" data-guide="menu-people" onClick={() => { onClose(); onPeople() }}><Users size={20} /><span style={{ flex: 1 }}>いつもの・お連れ様<small>いつものメニュー・お連れ様の追加と削除</small></span><ChevronRight size={18} /></button>}
              <button type="button" className="v2-row" data-guide="menu-tickets" onClick={() => { onClose(); onTickets() }}><Ticket size={20} /><span style={{ flex: 1 }}>すべてのチケット<small>割引券・特典・プレゼント・銀Pay</small></span><ChevronRight size={18} /></button>
              <button type="button" className="v2-row" onClick={() => { onClose(); onAccount() }}><KeyRound size={20} /><span style={{ flex: 1 }}>ログインと引き継ぎ<small>Face ID・機種変更・以前のチケット</small></span><ChevronRight size={18} /></button>
              {canShowInstallGuide() && <button type="button" className="v2-row" onClick={() => { onClose(); window.dispatchEvent(new Event(SHOW_INSTALL_GUIDE_EVENT)) }}><Smartphone size={20} /><span style={{ flex: 1 }}>ホーム画面に追加</span><ChevronRight size={18} /></button>}
            </div>
            <PushToggle tone="mono" menu />
            <div className="v2-panel v2-glass" style={{ marginTop: 12, padding: '4px 14px' }}>
              <a className="v2-row" href={SHOP_PHONE_TEL}><Phone size={20} /><span style={{ flex: 1 }}>電話で予約<small>{SHOP_PHONE_DISPLAY}</small></span></a>
              <a className="v2-row" href={HOTPEPPER_SHOP_URL} target="_blank" rel="noopener noreferrer"><ExternalLink size={20} /><span style={{ flex: 1 }}>HOT PEPPER Beauty で予約</span></a>
            </div>
            {isStaging() && <StagingReset />}
            <button type="button" className="v2-btn v2-btn-quiet" style={{ marginTop: 8, background: 'none' }} onClick={onClose}>閉じる</button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

/** Staging だけ：テスト会員を登録した直後に戻す。2回押しで実行（間違えて押しても消えないように） */
function StagingReset() {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'error'>('idle')
  const press = () => {
    if (step === 'idle' || step === 'error') { setStep('confirm'); return }
    if (step !== 'confirm') return
    setStep('busy')
    resetStagingTester().catch(() => setStep('error'))
  }
  const label = step === 'confirm' ? 'もう一度押すと戻します（予約・いつもの・ガチャが消えます）'
    : step === 'busy' ? '戻しています…' : step === 'error' ? '戻せませんでした。もう一度押してください' : 'テスト用：登録した直後に戻す'
  return <button type="button" className="v2-btn v2-btn-quiet" style={{ marginTop: 12, background: 'none', fontSize: 13, color: step === 'confirm' || step === 'error' ? '#a33' : 'var(--v2-faint)' }} disabled={step === 'busy'} onClick={press}>{label}</button>
}
