// ガチャのゲージ（11/6 慶一郎さん「ガチャ券も消費すればするだけ欲しい景品にたどり着くようにゲージを」）
// 狙う景品を選び、ガチャ券を使ったご来店でポイントをためる。3,000円から 0.5pt、5,000円から 1pt（値引き前・ご本人のご来店だけ・お子さまのメニューは除く）
// 毎日のガチャは 1回 0.1pt・月 1pt まで（その月にご来店があればゲージに入る）
// たまったら「受け取る」で持ち券と入れ替わる（1枚しか持てないので、今の券があれば2回押し）。予約に付いた券があるうちは受け取れない
// 見た目は 11/6 慶一郎さんの見本どおり：お持ちのガチャ券の下に「今月の仮ポイント」、その下に狙っている景品。説明は一言だけ
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { claimGauge, setGaugeTarget, type GachaState } from '../features/gacha/gachaApi'

const pt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** 今月の仮ポイント（お持ちのガチャ券の枠の中に置く） */
export function GaugeMonth({ state }: { state: GachaState }) {
  const g = state.gauge
  if (!g?.open || !g.month) return null
  const cap = Number(g.month.cap) || 1
  const now = Math.min(Number(g.month.draw_pt) || 0, cap)
  return (
    <div className="v2-gauge-month">
      {/* 正式の決まり（11/6）：ガチャ1回 0.1pt・月 1pt まで。その月にご来店があると景品のポイントに入る。
          「仮ポイント」「付与上限に到達」はお客様に分かりにくい（11/9 慶一郎さん）→ 中身をそのまま言う */}
      <div className="v2-gauge-row"><b>今月のガチャでたまった分</b><b>{now.toFixed(1)} / {cap.toFixed(1)}pt</b></div>
      <div className="v2-gauge-bar" role="progressbar" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={now}><i style={{ width: `${(now / cap) * 100}%` }} /></div>
      <small>{now >= cap ? '今月の分は、ここまでです。' : 'ガチャ1回で 0.1pt（月 1pt まで）。'}今月ご来店があると、狙っている景品のポイントに入ります。</small>
    </div>
  )
}

/** 狙っている景品 */
export function GachaGauge({ state, onChange }: { state: GachaState; onChange: (s: GachaState) => void }) {
  const gauge = state.gauge
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!gauge?.open) return null

  const goal = gauge.goals.find(g => g.code === gauge.target) ?? null
  const points = Math.max(0, Number(gauge.points) || 0)
  const run = async (job: () => Promise<GachaState>) => {
    if (busy) return false
    setBusy(true); setFailed(false)
    try { onChange(await job()); return true } catch { setFailed(true); return false } finally { setBusy(false) }
  }
  const pick = async (code: string) => { if (await run(() => setGaugeTarget(code))) { setPicking(false); setConfirm(false) } }
  const held = state.held
  const full = !!goal && points >= goal.points
  const claim = () => {
    if (held && !confirm) { setConfirm(true); return }
    void run(claimGauge).then(ok => { if (ok) setConfirm(false) })
  }
  const choosing = !goal || picking
  // ポイントのため方を一言（11/10 夜の点検：初めての方は「50pt」だけ見ても、どうためるか分からなかった）
  const howTo = 'ガチャ券を使ってご来店すると、メニュー 5,000円以上で 1pt・3,000円以上で 0.5pt たまります。'

  return (
    <section className="v2-gauge" aria-label="狙っている景品">
      <div className="v2-gauge-head">
        <span>{choosing ? '狙う景品を選ぶ' : '狙っている景品'}</span>
        {goal && !picking && <button type="button" onClick={() => setPicking(true)}>変える<ChevronRight size={16} strokeWidth={2} aria-hidden /></button>}
        {goal && picking && <button type="button" onClick={() => setPicking(false)}>やめる</button>}
      </div>
      {!choosing && goal && (
        <>
          <b className="v2-gauge-title">{goal.title}</b>
          <div className="v2-gauge-bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal.points} aria-valuenow={Math.min(points, goal.points)}>
            <i style={{ width: `${Math.min(100, (points / goal.points) * 100)}%` }} />
          </div>
          <div className="v2-gauge-row"><b>{pt(points)} / {pt(goal.points)}pt</b><small>{full ? '受け取れます' : `あと${pt(goal.points - points)}pt`}</small></div>
          {full && !held?.reserved && (
            <>
              {confirm && held && <small>お持ちのガチャ券（{held.title}）と入れ替わります。</small>}
              <button type="button" className="v2-gauge-claim" disabled={busy} onClick={claim}>{busy ? '受け取っています…' : confirm ? '入れ替えて受け取る' : '受け取る'}</button>
            </>
          )}
          {full && held?.reserved && <small>ご予約のガチャ券を使ったあとに受け取れます。</small>}
          {!full && <small>{howTo}</small>}
        </>
      )}
      {choosing && <small>{howTo}</small>}
      {choosing && (
        <div className="v2-gauge-goals" role="radiogroup" aria-label="狙う景品">
          {gauge.goals.map(g => (
            <button key={g.code} type="button" role="radio" aria-checked={g.code === gauge.target} disabled={busy} onClick={() => pick(g.code)}>
              <span>{g.title}</span><small>{pt(g.points)}pt</small>
            </button>
          ))}
        </div>
      )}
      {failed && <small className="v2-gauge-error">保存できませんでした。もう一度お試しください。</small>}
    </section>
  )
}
