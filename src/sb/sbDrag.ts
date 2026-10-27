// 予約表の予約をドラッグして、ほかの時間・担当へ動かす（10/27 慶一郎さん）。動かす先の確認は SbMove.tsx。
//   マウスは押して動かす。iPad などの指は長押し（0.35秒）してから動かす（ふつうになぞると予約表がスクロールする）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { jstMinutesOf } from '../utils/bookingApi'
import type { SbReservation } from './sbTypes'

export interface SbMoveTarget { r: SbReservation; staffId: string; minutes: number }

const HOLD_MS = 350
const START_PX = 8

/** 予約表のドラッグ。drop で動かす先（担当・開始の分）を返す。担当は指を離した場所の行（data-staff-id） */
export function useReservationDrag({ date, slotW, enabled, onDrop }: {
  date: string; slotW: number; enabled: boolean; onDrop: (target: SbMoveTarget) => void
}) {
  const st = useRef<{ r: SbReservation; x0: number; y0: number; mouse: boolean; active: boolean; timer: number } | null>(null)
  const [view, setView] = useState<{ id: string; dx: number; dy: number; minutes: number } | null>(null)
  const suppressClick = useRef(false)
  const dropRef = useRef(onDrop)
  useEffect(() => { dropRef.current = onDrop }, [onDrop])

  const snapped = useCallback((r: SbReservation, dx: number) => jstMinutesOf(r.starts_at, date) + Math.round(dx / slotW) * 15, [date, slotW])

  useEffect(() => {
    const reset = () => { if (st.current) window.clearTimeout(st.current.timer); st.current = null; setView(null) }
    const move = (e: PointerEvent) => {
      const s = st.current; if (!s) return
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0
      if (!s.active) {
        if (Math.hypot(dx, dy) < START_PX) return
        if (!s.mouse) { reset(); return } // 長押しの前に動いた：スクロール
        s.active = true
      }
      setView({ id: s.r.id, dx, dy, minutes: snapped(s.r, dx) })
    }
    const up = (e: PointerEvent) => {
      const s = st.current; if (!s) return
      if (s.active) {
        suppressClick.current = true
        window.setTimeout(() => { suppressClick.current = false }, 0)
        const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-staff-id]')
        const staffId = row?.dataset.staffId ?? s.r.staff_id
        const minutes = snapped(s.r, e.clientX - s.x0)
        if (staffId !== s.r.staff_id || minutes !== jstMinutesOf(s.r.starts_at, date)) dropRef.current({ r: s.r, staffId, minutes })
      }
      reset()
    }
    // 長押しで掴んだあとは、指で予約表がスクロールしないようにする
    const touchMove = (e: TouchEvent) => { if (st.current?.active) e.preventDefault() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', reset)
    window.addEventListener('touchmove', touchMove, { passive: false })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', reset)
      window.removeEventListener('touchmove', touchMove)
      reset()
    }
  }, [date, snapped])

  const start = (e: React.PointerEvent, r: SbReservation) => {
    if (!enabled || r.status !== 'confirmed' || e.button !== 0) return
    const mouse = e.pointerType === 'mouse'
    const s = { r, x0: e.clientX, y0: e.clientY, mouse, active: false, timer: 0 }
    if (!mouse) s.timer = window.setTimeout(() => {
      if (st.current !== s) return
      s.active = true; navigator.vibrate?.(15)
      setView({ id: r.id, dx: 0, dy: 0, minutes: jstMinutesOf(r.starts_at, date) })
    }, HOLD_MS)
    st.current = s
  }
  /** ドラッグのあとに来るクリック（詳細を開く）は無視する */
  const clicked = () => !suppressClick.current
  return { start, clicked, view }
}
