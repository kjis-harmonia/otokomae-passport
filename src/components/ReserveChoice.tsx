// スタイルの「予約する」：Johnny（押したメニューのまま、日時と担当を聞く）か HOT PEPPER Beauty か選ぶ。
// HOT PEPPER のクーポンページが無いスタイルは Johnny だけ。
import type { CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { getReserveUrl, getStyleMenuCode } from '../data/reserveLinks'
import { requestJohnny } from '../features/johnny/bookingIntent'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const CREAM = '#F2E6C8'

/** 予約の方法のボタン（シートの中身。スタイルの予約シートからも使う） */
export function ReserveChoiceButtons({ title, onDone }: { title: string; onDone: () => void }) {
  const url = getReserveUrl(title)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <motion.button type="button" whileTap={{ scale: 0.98 }} style={primary}
        onClick={() => { requestJohnny({ menuCode: getStyleMenuCode(title), label: title }); onDone() }}>
        Johnnyで予約
        <span style={{ display: 'block', marginTop: 4, fontSize: 12, fontWeight: 400, letterSpacing: '0.04em', color: 'rgba(242,230,200,0.7)' }}>日時と担当をお聞きします</span>
      </motion.button>
      {url && (
        <button type="button" style={secondary} onClick={() => { window.open(url, '_blank', 'noopener,noreferrer'); onDone() }}>
          HOT PEPPER Beautyで予約
        </button>
      )}
    </div>
  )
}

/** 下から出る「予約の方法」 */
export function ReserveChoiceSheet({ title, open, onClose }: { title: string; open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div key="reserve-choice" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, zIndex: 10040, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <motion.div role="dialog" aria-modal="true" aria-label={`${title}を予約`}
            initial={{ y: 40 }} animate={{ y: 0 }} exit={{ y: 40 }} transition={{ duration: 0.22, ease: 'easeOut' }}
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 480, boxSizing: 'border-box',
              padding: '24px 20px calc(20px + env(safe-area-inset-bottom, 0px))',
              background: '#0E0D0B', borderTop: '1px solid rgba(201,162,74,0.35)', borderRadius: '20px 20px 0 0',
            }}>
            <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: CREAM, letterSpacing: '0.04em', margin: '0 0 18px' }}>{title}を予約</p>
            <ReserveChoiceButtons title={title} onDone={onClose} />
            <button type="button" onClick={onClose} style={{ width: '100%', marginTop: 8, padding: '12px 0', background: 'none', border: 'none', color: 'rgba(242,230,200,0.5)', fontSize: 14, cursor: 'pointer' }}>
              キャンセル
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const primary: CSSProperties = {
  width: '100%', padding: '14px 0', borderRadius: 14,
  background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
  border: '1px solid rgba(201,162,74,0.44)',
  fontFamily: SERIF, fontSize: 16, fontWeight: 700, letterSpacing: '0.16em', color: CREAM, cursor: 'pointer',
}
const secondary: CSSProperties = {
  width: '100%', padding: '14px 0', borderRadius: 14, background: 'transparent',
  border: '1px solid rgba(201,162,74,0.3)', fontFamily: SERIF, fontSize: 15, letterSpacing: '0.1em', color: 'rgba(242,230,200,0.8)', cursor: 'pointer',
}
