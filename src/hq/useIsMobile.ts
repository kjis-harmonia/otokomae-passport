import { useEffect, useState } from 'react'

export const HQ_MOBILE_BREAKPOINT = 880

/** 銀二郎本部のレイアウト切り替え用（サイドバー⇔ボトムナビ等）。880px未満をモバイルとして扱う。 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < HQ_MOBILE_BREAKPOINT : false,
  )

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${HQ_MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
