import type { BookingApi } from '../../utils/bookingApi'
import { TERMINAL_OPERATORS } from '../../screens/staffOperators'
import { OptionRow, Sheet } from './ledgerUi'
import { C } from './ledgerTheme'

/** 店舗端末の担当者の選択（予約台帳・顧客一覧・銀Pay で共通）。端末を触る3人から選ぶ */
export function ActorSheet({ actor, onPick, onClose }: { api?: BookingApi; actor: string; onPick: (name: string) => void; onClose: () => void }) {
  return (
    <Sheet title="担当者を選択" onClose={onClose}>
      <p style={{ fontSize: 13, color: C.sub, margin: '8px 0' }}>会計・予約などの記録に残る名前です。この端末に保存され、ほかの画面でも同じ人になります。</p>
      {TERMINAL_OPERATORS.map(name => (
        <OptionRow key={name} selected={name === actor} check={false} onClick={() => onPick(name)}><span>{name}</span><span /></OptionRow>
      ))}
    </Sheet>
  )
}
