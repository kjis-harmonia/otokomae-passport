// 画面のいちばん上（時計・電池の帯）の色を、出している画面に合わせる（11/6 慶一郎さん「上部、見切れてるところ」）
//   iPhone は theme-color（と上に固定した物の背景色）で帯を塗る。開いている間だけ色を変え、閉じたら元に戻す
import { useEffect } from 'react'

export function useThemeColor(color: string | null) {
  useEffect(() => {
    if (!color) return
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (!meta) return
    const before = meta.content
    meta.content = color
    return () => { meta.content = before }
  }, [color])
}
