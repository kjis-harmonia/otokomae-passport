// 「今日の相棒」：今日の予約表の上に、次のお客様・空き時間・やることを出す。押すとその予約・新規予約が開く。
import { useMemo } from 'react'
import { ChevronRight, Clock, FileClock, Plus } from 'lucide-react'
import { jstTime, yen } from '../utils/bookingApi'
import { summarizeToday } from './sbTodaySummary'
import type { SbLedger } from './sbTypes'

const JST = 9 * 60 * 60 * 1000
const hm = (ms: number) => new Date(ms + JST).toISOString().slice(11, 16)
const minutesOfDay = (ms: number) => { const d = new Date(ms + JST); return d.getUTCHours() * 60 + d.getUTCMinutes() }

function until(startIso: string, now: number): string {
  const min = Math.round((Date.parse(startIso) - now) / 60000)
  if (min <= 0) return 'まもなく'
  if (min < 60) return `あと${min}分`
  return `あと${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}`
}

export function SbToday({ ledger, now, blocked, onOpen, onNew, onTransfer }: {
  ledger: SbLedger; now: number; blocked: boolean
  onOpen: (id: string) => void
  onNew: (preset: { minutes: number; staffId: string }) => void
  onTransfer: () => void
}) {
  const s = useMemo(() => summarizeToday(ledger, now), [ledger, now])
  const nextOne = s.next[0]

  return (
    <section className="sb-buddy" aria-label="今日の相棒">
      <div className="sb-buddy-col">
        <h2>次のお客様</h2>
        {s.inService.map(r => (
          <button key={r.id} type="button" className="sb-buddy-row" onClick={() => onOpen(r.id)}>
            <span className="sb-buddy-time sb-buddy-live">施術中</span>
            <span className="sb-buddy-main"><strong>{r.customer_name}</strong><small>{r.items.map(i => i.name).join('・')} / {r.staff_name}</small></span>
            <ChevronRight size={16} />
          </button>
        ))}
        {s.next.map(r => (
          <button key={r.id} type="button" className="sb-buddy-row" onClick={() => onOpen(r.id)}>
            <span className="sb-buddy-time">{jstTime(r.starts_at)}</span>
            <span className="sb-buddy-main"><strong>{r.customer_name}</strong><small>{r.items.map(i => i.name).join('・')} / {r.staff_name}</small></span>
            {r === nextOne && <span className="sb-buddy-badge">{until(r.starts_at, now)}</span>}
            <ChevronRight size={16} />
          </button>
        ))}
        {!s.inService.length && !s.next.length && <p className="sb-buddy-empty">今日のこれからの予約はありません</p>}
      </div>

      <div className="sb-buddy-col">
        <h2>空いている時間</h2>
        {s.gaps.map(g => (
          <button key={`${g.staffId}-${g.start}`} type="button" className="sb-buddy-row" disabled={blocked}
            onClick={() => onNew({ minutes: minutesOfDay(g.start), staffId: g.staffId })}>
            <span className="sb-buddy-time">{hm(g.start)}</span>
            <span className="sb-buddy-main"><strong>{g.staffName}</strong><small>{hm(g.start)}–{hm(g.end)}（{Math.round((g.end - g.start) / 60000)}分）予約なし</small></span>
            <Plus size={16} />
          </button>
        ))}
        {!s.gaps.length && <p className="sb-buddy-empty">今日はこの先、まとまった空きはありません</p>}
      </div>

      <div className="sb-buddy-col">
        <h2>やること</h2>
        {s.late.map(r => (
          <button key={r.id} type="button" className="sb-buddy-row sb-buddy-alert" onClick={() => onOpen(r.id)}>
            <Clock size={16} />
            <span className="sb-buddy-main"><strong>{r.customer_name}</strong><small>{jstTime(r.starts_at)}の予約・まだ来店になっていません</small></span>
            <ChevronRight size={16} />
          </button>
        ))}
        {s.pendingTransfer > 0 && (
          <button type="button" className="sb-buddy-row" onClick={onTransfer}>
            <FileClock size={16} />
            <span className="sb-buddy-main"><strong>Salon Board に未転記</strong><small>{s.pendingTransfer}件</small></span>
            <ChevronRight size={16} />
          </button>
        )}
        <p className="sb-buddy-total">今日 {s.count}件・見込み {yen(s.expected)}</p>
      </div>
    </section>
  )
}
