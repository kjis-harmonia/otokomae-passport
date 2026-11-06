// ガチャのゲージ（11/6 慶一郎さん「ガチャ券も消費すればするだけ欲しい景品にたどり着くようにゲージを」）
// 狙う景品を選び、ガチャ券を使ったご来店でポイントをためる。3,000円から 0.5pt、5,000円から 1pt（値引き前・ご本人のご来店だけ・お子さまのメニューは除く）
// たまったら「受け取る」で持ち券と入れ替わる（1枚しか持てないので、今の券があれば2回押し）。予約に付いた券があるうちは受け取れない
// 見た目はお持ちのガチャ券と同じ白い枠に、細い線のゲージを1本だけ
import { useState } from 'react'
import { claimGauge, setGaugeTarget, type GachaState } from '../features/gacha/gachaApi'

const pt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

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
    if (busy) return
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

  const month = gauge.month
  const monthPt = Math.min(Number(month?.draw_pt) || 0, Number(month?.cap) || 1)
  const monthCap = Number(month?.cap) || 1
  const monthFull = monthPt >= monthCap
  // 見本（11/6 慶一郎さん）：「今月のポイントは上限に達しました。ガチャは引き続き毎日楽しめます。」
  const monthNote = monthFull
    ? (month?.visited ? '今月のポイントは上限に達しました。ガチャは引き続き毎日楽しめます。'
      : '今月のポイントは上限に達しました。今月ガチャ券を使ってご来店いただくと、ゲージに加わります。ガチャは引き続き毎日楽しめます。')
    : (month?.visited ? 'ガチャを引くたびに 0.1pt、ゲージに加わります。'
      : 'ガチャを引くたびに 0.1pt。今月ガチャ券を使ってご来店いただくと、ゲージに加わります。')

  return (
    <>
    {month && (
      <section className="v2-gauge v2-gauge-month" aria-label="今月のガチャ獲得ポイント">
        <div className="v2-gauge-month-head"><b>今月のガチャ獲得ポイント</b><b>{monthPt.toFixed(1)} / {monthCap.toFixed(1)}pt</b></div>
        <div className="v2-gauge-bar" role="progressbar" aria-valuemin={0} aria-valuemax={monthCap} aria-valuenow={monthPt}>
          <i style={{ width: `${(monthPt / monthCap) * 100}%` }} />
        </div>
        <small>{monthNote}</small>
      </section>
    )}
    <section className="v2-gauge" aria-label="ガチャのゲージ">
      <div className="v2-gauge-head">
        <span>{goal ? '狙っている景品' : 'ガチャのゲージ'}</span>
        {goal && !picking && <button type="button" onClick={() => setPicking(true)}>変える</button>}
      </div>
      {goal && !picking && (
        <>
          <b>{goal.title}</b>
          <div className="v2-gauge-bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal.points} aria-valuenow={Math.min(points, goal.points)}>
            <i style={{ width: `${Math.min(100, (points / goal.points) * 100)}%` }} />
          </div>
          <small>{full ? `${pt(points)}pt たまりました` : `あと ${pt(goal.points - points)}pt（${pt(points)} / ${pt(goal.points)}pt）`}</small>
          {full && (held?.reserved
            ? <small>ご予約に付いているガチャ券を使ったあとに受け取れます。</small>
            : <>
                {confirm && held && <small>現在お持ちのガチャ券（{held.title}）と入れ替わります。</small>}
                <button type="button" className="v2-gauge-claim" disabled={busy} onClick={claim}>{busy ? '受け取っています…' : confirm ? '入れ替えて受け取る' : '受け取る'}</button>
              </>)}
        </>
      )}
      {(!goal || picking) && (
        <>
          {!goal && <p>狙う景品を選ぶと、ガチャ券を使ったご来店ごとにポイントがたまります。</p>}
          <div className="v2-gauge-goals" role="radiogroup" aria-label="狙う景品">
            {gauge.goals.map(g => (
              <button key={g.code} type="button" role="radio" aria-checked={g.code === gauge.target} disabled={busy} onClick={() => pick(g.code)}>
                <span>{g.title}</span><small>{pt(g.points)}pt</small>
              </button>
            ))}
          </div>
          {goal && <button type="button" className="v2-gauge-cancel" onClick={() => setPicking(false)}>やめる</button>}
          {goal && <small>ためたポイントは、景品を変えてもそのままです。</small>}
        </>
      )}
      {failed && <small className="v2-gauge-error">保存できませんでした。電波の良いところで、もう一度お試しください。</small>}
      <small className="v2-gauge-rule">ガチャ券を使ったご来店で、メニューの合計（割引前）が 3,000円から 0.5pt、5,000円から 1pt。<br />ご本人のご来店が対象です（お子さまのメニュー・お連れ様は除きます）。</small>
    </section>
    </>
  )
}
