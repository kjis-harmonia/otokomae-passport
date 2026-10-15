import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function SbModal({ title, busy = false, onClose, children, footer }: {
  title: string; busy?: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose)
  const busyRef = useRef(busy)
  useEffect(() => { closeRef.current = onClose; busyRef.current = busy }, [onClose, busy])
  useEffect(() => {
    const dialog = ref.current!
    const opener = document.activeElement as HTMLElement | null
    dialog.showModal()
    const cancel = (e: Event) => { e.preventDefault(); if (!busyRef.current) closeRef.current() }
    dialog.addEventListener('cancel', cancel)
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={ref} className="sb-modal" aria-label={title}>
    <header className="sb-modal-head"><h2>{title}</h2><button type="button" className="sb-icon" aria-label="閉じる" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    <div className="sb-modal-body">{children}</div>
    {footer && <footer className="sb-modal-foot">{footer}</footer>}
  </dialog>
}
