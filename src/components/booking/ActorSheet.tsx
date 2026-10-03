import { useEffect, useState } from 'react'
import type { BookingApi, BookingStaff } from '../../utils/bookingApi'
import { OptionRow, Sheet } from './ledgerUi'
import { C } from './ledgerTheme'

/** 店舗端末の操作者の選択（予約台帳・顧客一覧で共通） */
export function ActorSheet({ api, actor, onPick, onClose }: { api: BookingApi; actor: string; onPick: (name: string) => void; onClose: () => void }) {
  const [staff, setStaff] = useState<BookingStaff[] | null>(null)
  useEffect(() => { api.options().then(o => setStaff(o.staff)).catch(() => setStaff([])) }, [api])
  return (
    <Sheet title="操作者を選択" onClose={onClose}>
      <p style={{ fontSize: 13, color: C.sub, margin: '8px 0' }}>予約・顧客の登録や変更の記録に残る名前です。この端末に保存されます。</p>
      {!staff ? <p style={{ fontSize: 14, color: C.sub }}>読み込み中…</p> : staff.map(s => (
        <OptionRow key={s.id} selected={s.name === actor} check={false} onClick={() => onPick(s.name)}><span>{s.name}</span><span /></OptionRow>
      ))}
    </Sheet>
  )
}
