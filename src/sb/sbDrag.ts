// 予約表の予約をドラッグして、ほかの時間・担当へ動かす（10/27 慶一郎さん）。動かす先の確認は SbMove.tsx。
//   マウスは押して動かす。iPad などの指は長押し（0.35秒）してから動かす（ふつうになぞると予約表がスクロールする）。
//   予約表の左右の端に近づけると、その方向へ予約表が自動で流れる（見えていない時間まで運べる。端に近いほど速い）。
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { jstMinutesOf } from '../utils/bookingApi'
import type { SbReservation } from './sbTypes'

export interface SbMoveTarget { r: SbReservation; staffId: string; minutes: number }

const HOLD_MS = 350
const START_PX = 8
/** 端からこの幅に入ると流れ始める */
const EDGE_PX = 80
/** いちばん端での速さ（1コマあたりの px。6px×60コマ＝1秒で約2時間）。入ったばかりはゆっくり */
const MAX_SPEED = 6

type DragState = {
  r: SbReservation; x0: number; y0: number; scroll0: number; x: number; y: number
  mouse: boolean; active: boolean; timer: number; raf: number
  /** 画面に出している移動先（離したらこの時刻・この量で確認を出す。出ている時刻と確認の時刻がずれないように） */
  dx: number; minutes: number
}

/** 予約表のドラッグ。drop で動かす先（担当・開始の分）を返す。担当は指を離した場所の行（data-staff-id）
 *  scrollRef は横に流れる予約表。leftInset は左に固定の担当者の列の幅（そこは端として数えない） */
export function useReservationDrag({ date, slotW, enabled, scrollRef, leftInset, onDrop }: {
  date: string; slotW: number; enabled: boolean; scrollRef: RefObject<HTMLDivElement | null>; leftInset: number
  onDrop: (target: SbMoveTarget) => void
}) {
  const st = useRef<DragState | null>(null)
  const [view, setView] = useState<{ id: string; dx: number; dy: number; minutes: number } | null>(null)
  const suppressClick = useRef(false)
  const dropRef = useRef(onDrop)
  useEffect(() => { dropRef.current = onDrop }, [onDrop])

  // 30分ごとに動かす（もとの時刻が :15 などでも、落とした先は :00 か :30）
  const snapped = useCallback((r: SbReservation, dx: number) => Math.round((jstMinutesOf(r.starts_at, date) + dx / slotW * 15) / 30) * 30, [date, slotW])

  useEffect(() => {
    const scroller = () => scrollRef.current
    /** 予約表の中での動いた量（指の動き＋自動で流れた分） */
    const offset = (s: DragState) => ({ dx: s.x - s.x0 + ((scroller()?.scrollLeft ?? 0) - s.scroll0), dy: s.y - s.y0 })
    const show = (s: DragState) => {
      const { dx, dy } = offset(s)
      s.dx = dx; s.minutes = snapped(s.r, dx)
      setView({ id: s.r.id, dx, dy, minutes: s.minutes })
    }
    const reset = () => {
      if (st.current) { window.clearTimeout(st.current.timer); cancelAnimationFrame(st.current.raf) }
      st.current = null; setView(null)
    }
    // 端に近いあいだ、毎コマ少しずつ流す
    const tick = () => {
      const s = st.current, el = scroller()
      if (!s?.active || !el) return
      const rect = el.getBoundingClientRect()
      const left = rect.left + leftInset, right = rect.right
      let speed = 0
      // 端に近いほど速い（入ったばかりはゆっくり＝2乗）
      if (s.x > right - EDGE_PX) speed = Math.min(1, (s.x - (right - EDGE_PX)) / EDGE_PX) ** 2 * MAX_SPEED
      else if (s.x < left + EDGE_PX) speed = -(Math.min(1, ((left + EDGE_PX) - s.x) / EDGE_PX) ** 2) * MAX_SPEED
      if (speed) {
        const before = el.scrollLeft
        el.scrollLeft = before + speed
        if (el.scrollLeft !== before) show(s)
      }
      s.raf = requestAnimationFrame(tick)
    }
    const activate = (s: DragState) => {
      s.active = true
      s.scroll0 = scroller()?.scrollLeft ?? 0
      s.raf = requestAnimationFrame(tick)
    }
    const move = (e: PointerEvent) => {
      const s = st.current; if (!s) return
      s.x = e.clientX; s.y = e.clientY
      if (!s.active) {
        if (Math.hypot(s.x - s.x0, s.y - s.y0) < START_PX) return
        if (!s.mouse) { reset(); return } // 長押しの前に動いた：スクロール
        activate(s)
      }
      show(s)
    }
    const up = (e: PointerEvent) => {
      const s = st.current; if (!s) return
      if (s.active) {
        cancelAnimationFrame(s.raf)
        suppressClick.current = true
        window.setTimeout(() => { suppressClick.current = false }, 0)
        const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-staff-id]')
        const staffId = row?.dataset.staffId ?? s.r.staff_id
        const minutes = s.minutes
        if (staffId !== s.r.staff_id || minutes !== jstMinutesOf(s.r.starts_at, date)) dropRef.current({ r: s.r, staffId, minutes })
      }
      reset()
    }
    // 長押しで掴んだあとは、指で予約表がスクロールしないようにする
    const touchMove = (e: TouchEvent) => { if (st.current?.active) e.preventDefault() }
    const onHold = (e: Event) => { const s = st.current; if (s && (e as CustomEvent<DragState>).detail === s) { activate(s); show(s) } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', reset)
    window.addEventListener('touchmove', touchMove, { passive: false })
    window.addEventListener(HOLD_EVENT, onHold)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', reset)
      window.removeEventListener('touchmove', touchMove)
      window.removeEventListener(HOLD_EVENT, onHold)
      reset()
    }
  }, [date, snapped, scrollRef, leftInset])

  const start = (e: React.PointerEvent, r: SbReservation) => {
    if (!enabled || r.status !== 'confirmed' || e.button !== 0) return
    const mouse = e.pointerType === 'mouse'
    const s: DragState = { r, x0: e.clientX, y0: e.clientY, scroll0: 0, x: e.clientX, y: e.clientY, mouse, active: false, timer: 0, raf: 0, dx: 0, minutes: jstMinutesOf(r.starts_at, date) }
    if (!mouse) s.timer = window.setTimeout(() => {
      if (st.current !== s) return
      navigator.vibrate?.(15)
      window.getSelection()?.removeAllRanges() // 長押しで選ばれた文字の青い反転を消す
      window.dispatchEvent(new CustomEvent(HOLD_EVENT, { detail: s }))
    }, HOLD_MS)
    st.current = s
  }
  /** ドラッグのあとに来るクリック（詳細を開く）は無視する */
  const clicked = () => !suppressClick.current
  return { start, clicked, view }
}

/** 長押しが決まった（掴んだ）ことを、上の effect の中の処理へ渡す */
const HOLD_EVENT = 'ginjiro:sb-drag-hold'
