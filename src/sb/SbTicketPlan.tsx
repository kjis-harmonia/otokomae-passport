import { useEffect, useState } from 'react'
import { yen } from '../utils/bookingApi'
import { callStaffRpc } from './sbRpc'
import type { SbReservation } from './sbTypes'

// AI予約でお客様が選んだ券（使う予定）と、券を引いたお支払い予定。予約の詳細の「予約時の金額」の下に出す
// （11/6 慶一郎さん「予め構えられる」）。券もお金も動かさない（使うのは会計の確定のとき）

type Ticket = { id: string; title: string; amount: number }
type Context = { tickets?: Ticket[]; gacha?: { title: string; amount: number | null; free_menu: string | null } | null }
type Line = { label: string; amount: number | null }

export function SbTicketPlan({ reservation: r }: { reservation: SbReservation }) {
  const [lines, setLines] = useState<Line[] | null>(null)

  useEffect(() => {
    if (r.source !== 'app') return
    let alive = true
    void Promise.all([
      callStaffRpc<{ ticket_ids?: string[] } | null>('staff_reservation_ticket_plan', { p_reservation_id: r.id }).catch(() => null),
      callStaffRpc<Context>('staff_checkout_context', { p_reservation_id: r.id, p_client_id: null }).catch(() => null),
    ]).then(([plan, ctx]) => {
      if (!alive) return
      const ids = plan?.ticket_ids ?? []
      const picked = (ctx?.tickets ?? []).filter(t => ids.includes(t.id))
      // 同じ券は「漢トク券 × 3」にまとめる
      const groups = new Map<string, { n: number; amt: number }>()
      for (const t of picked) groups.set(t.title, { n: (groups.get(t.title)?.n ?? 0) + 1, amt: (groups.get(t.title)?.amt ?? 0) + (t.amount || 0) })
      const out: Line[] = [...groups].map(([title, g]) => ({ label: g.n > 1 ? `${title} × ${g.n}` : title, amount: g.amt }))
      const gacha = ctx?.gacha
      if (gacha) {
        // 無料券は対象メニューの料金を引く（予約に無ければ金額は出さない）
        const free = gacha.amount === null ? r.items.find(i => i.menu_code === gacha.free_menu)?.price ?? null : gacha.amount
        out.push({ label: gacha.title, amount: free })
      }
      setLines(out)
    })
    return () => { alive = false }
  }, [r.id, r.source, r.items])

  if (!lines?.length) return null
  const off = lines.reduce((s, l) => s + (l.amount ?? 0), 0)
  const unknown = lines.some(l => l.amount === null)
  return <>
    <dt>使う券</dt>
    <dd>{lines.map(l => <span className="sb-line" key={l.label}>{l.label}<small>{l.amount === null ? '金額は会計で' : `−${yen(l.amount)}`}</small></span>)}</dd>
    {r.total_price !== null && <><dt>お支払い予定</dt><dd><strong>{yen(Math.max(0, r.total_price - off))}</strong>{unknown && <small className="sb-plan-note">（無料券の分は会計で引きます）</small>}</dd></>}
  </>
}
