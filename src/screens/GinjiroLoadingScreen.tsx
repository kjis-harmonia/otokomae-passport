// アプリを開いたときの画面（11/6 慶一郎さん「いつものオープニング真っ暗過ぎて草やけん、新しいこの動画に差し替えるか？」「音はなくてもいい」）
//   金の日輪と紅葉の山水に「二代目 銀二郎」の動画（public/opening、音なし・くり返し）。
//   動画を読み終える前は最初のコマの絵を出す（真っ黒にしない）。動きを減らす設定では絵だけ
import { motion, useReducedMotion } from 'framer-motion'
import { useThemeColor } from '../utils/themeColor'

export const OPENING_POSTER = '/opening/opening.jpg'
const TOP = '#fbf1df' // 動画のいちばん上の色

export function GinjiroLoadingScreen() {
  const still = useReducedMotion()
  // 上の帯（時計・電池）を動画のいちばん上の色に（11/6「上部、見切れてる」）
  useThemeColor(TOP)
  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
      role="img"
      aria-label="二代目 銀二郎"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: `${TOP} url(${OPENING_POSTER}) center / cover no-repeat`,
      }}
    >
      {!still && (
        <video src="/opening/opening.mp4" poster={OPENING_POSTER} autoPlay muted loop playsInline preload="auto" aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
    </motion.div>
  )
}
