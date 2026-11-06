import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { GUIDE_TASKS, type GuideStep, type GuideTask } from './guideSteps'
import { GUIDE_OPEN_EVENT } from './guideEvents'
import './staffGuide.css'

// 店舗端末の使い方ガイド。「これから何を行いますか？」で作業を選ぶと、
// 押す場所を ◯ で囲んで 👇 で指し、押したら次の場所へ進む。
// 店舗端末（/staff）と SB（/sb）の両方に置き、ページが変わっても続きから案内する（タブを閉じると消える）。

const RUN_KEY = 'ginjiro_guide_run'
const SEEN_KEY = 'ginjiro_guide_seen'
const OPTIONAL_WAIT_MS = 1800

type Run = { task: string; step: number }
type Rect = { top: number; left: number; width: number; height: number }

function readRun(): Run | null {
  try { const v = sessionStorage.getItem(RUN_KEY); return v ? JSON.parse(v) as Run : null } catch { return null }
}
function writeRun(run: Run | null) {
  try { if (run) sessionStorage.setItem(RUN_KEY, JSON.stringify(run)); else sessionStorage.removeItem(RUN_KEY) } catch { /* 保存できなくてもこのページでは続けられる */ }
}

// 手順はページ全体で1つ。画面が切り替わってガイドが作り直されても、同じ手順から続ける
const SYNC_EVENT = 'ginjiro-guide:sync'
let shared: Run | null = readRun()
function setShared(next: Run | null) {
  shared = next
  writeRun(next)
  window.dispatchEvent(new Event(SYNC_EVENT))
}
/** from＝進める前の手順。押した直後と「済んだので飛ばす」が重なっても2つ進まない */
function advanceShared(from: number) {
  if (shared && shared.step === from) setShared({ ...shared, step: from + 1 })
}

/** 画面に出ている（大きさのある）最初の要素 */
function findVisible(selector: string | undefined): HTMLElement | null {
  if (!selector) return null
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el
  }
  return null
}

/** 開いている <dialog>（SB の入力画面など）はページの一番上の層に出るので、ガイドもその中に出す */
function topLayer(): HTMLElement {
  const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]')
  return open.length ? open[open.length - 1] : document.body
}

const isField = (el: EventTarget | null) => el instanceof HTMLSelectElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement

export function StaffGuide({ autoOpen = false }: { autoOpen?: boolean }) {
  const [run, setRunState] = useState<Run | null>(() => shared)
  const [choosing, setChoosing] = useState(false)
  const [rect, setRect] = useState<Rect | null>(null)
  const stepStarted = useRef(0)
  const scrolledFor = useRef<string | null>(null)

  const task: GuideTask | undefined = run ? GUIDE_TASKS.find(t => t.id === run.task) : undefined
  const step: GuideStep | undefined = task && run ? task.steps[run.step] : undefined
  const steps = task?.steps
  const runTask = run?.task
  const runStep = run?.step
  const finished = !!task && !!run && run.step >= task.steps.length

  const setRun = useCallback((next: Run | null) => setShared(next), [])
  const advance = useCallback((from: number) => advanceShared(from), [])
  useEffect(() => {
    const sync = () => { setRunState(shared); setRect(null) }
    window.addEventListener(SYNC_EVENT, sync)
    sync()
    return () => window.removeEventListener(SYNC_EVENT, sync)
  }, [])

  // 開くボタン・初めての端末
  useEffect(() => {
    const open = () => setChoosing(true)
    window.addEventListener(GUIDE_OPEN_EVENT, open)
    return () => window.removeEventListener(GUIDE_OPEN_EVENT, open)
  }, [])
  useEffect(() => {
    if (!autoOpen || shared) return
    try {
      if (localStorage.getItem(SEEN_KEY)) return
      localStorage.setItem(SEEN_KEY, '1')
    } catch { return }
    setChoosing(true) // eslint-disable-line react-hooks/set-state-in-effect
  }, [autoOpen])

  // 場所を探して ◯ を合わせる・済んだ手順は飛ばす
  useEffect(() => {
    if (!step || !steps || runStep === undefined) return
    stepStarted.current = Date.now()
    const at = runStep
    const tick = () => {
      if ((step.skipIf && findVisible(step.skipIf)) || (step.until && findVisible(step.until))) { advance(at); return }
      const el = findVisible(step.target)
      if (!el) {
        // 案内より先に押して進んだとき：今の画面にある、先の手順へ追いつく
        const ahead = steps.findIndex((s, i) => i > at && !s.noJump && !!findVisible(s.target))
        if (ahead > 0 && runTask) { setShared({ task: runTask, step: ahead }); return }
        if (step.optional && Date.now() - stepStarted.current > OPTIONAL_WAIT_MS) advance(at)
        else setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      const key = `${runTask}:${at}`
      // 見えていなければ真ん中までスクロール（手順ごとに1回）
      if (scrolledFor.current !== key && (r.top < 64 || r.bottom > window.innerHeight - 150)) {
        scrolledFor.current = key
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      setRect(prev => prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
        ? prev : { top: r.top, left: r.left, width: r.width, height: r.height })
    }
    tick()
    const id = window.setInterval(tick, 120)
    return () => window.clearInterval(id)
  }, [step, steps, runTask, runStep, advance])

  // 囲んだ場所を押したら次へ（入力欄は選び終わったら）
  useEffect(() => {
    if (!step || !run || step.until || step.next) return
    const at = run.step
    const inside = (t: EventTarget | null) => {
      const el = findVisible(step.target)
      return !!el && t instanceof Node && el.contains(t)
    }
    const onClick = (e: MouseEvent) => {
      if (isField(e.target) || e.target instanceof HTMLLabelElement) return
      if (inside(e.target)) window.setTimeout(() => advance(at), 60)
    }
    const onChange = (e: Event) => { if (inside(e.target)) window.setTimeout(() => advance(at), 60) }
    document.addEventListener('click', onClick, true)
    document.addEventListener('change', onChange, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('change', onChange, true)
    }
  }, [step, run, advance])

  // 今の画面にある最初の手順から始める（SB や途中の画面から選んだとき）
  const start = (t: GuideTask) => {
    setChoosing(false)
    const first = t.steps.findIndex(st => !!findVisible(st.target))
    setRun({ task: t.id, step: Math.max(0, first) })
  }
  const stop = () => setRun(null)

  if (choosing) return createPortal(<Chooser onPick={start} onClose={() => setChoosing(false)} />, document.body)
  if (!task || !run) return null

  if (finished) {
    return createPortal(
      <div className="gd-bubble gd-bottom" role="status">
        <p className="gd-count">{task.title}</p>
        <p className="gd-text">これで終わりです</p>
        <div className="gd-actions">
          <button type="button" className="gd-ghost" onClick={() => { stop(); setChoosing(true) }}>ほかの作業を見る</button>
          <button type="button" className="gd-main" onClick={stop}>閉じる</button>
        </div>
      </div>,
      topLayer(),
    )
  }
  if (!step) return null
  // 場所が出ない手順（予約で入っている・券が無い など）は、飛ばすまで何も出さない
  if (step.optional && !rect) return null

  // ◯：小さい所は丸、横に長いボタンは角の丸い枠
  const pad = 8
  let ring: Rect | null = null
  let round = false
  if (rect) {
    round = rect.width / rect.height < 1.6 && Math.max(rect.width, rect.height) < 140
    if (round) {
      const d = Math.max(rect.width, rect.height) + pad * 2
      ring = { top: rect.top + rect.height / 2 - d / 2, left: rect.left + rect.width / 2 - d / 2, width: d, height: d }
    } else {
      ring = { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    }
  }
  const vh = window.innerHeight
  const fingerAbove = !ring || ring.top > 76
  const bubbleTop = !!ring && ring.top + ring.height / 2 > vh * 0.55

  return createPortal(
    <>
      {ring && (
        <>
          <div className={`gd-ring${round ? ' is-round' : ''}${step.noDim ? ' is-clear' : ''}`} aria-hidden="true"
            style={{ top: ring.top, left: ring.left, width: ring.width, height: ring.height }} />
          <div className={`gd-finger${fingerAbove ? '' : ' is-below'}`} aria-hidden="true"
            style={{ left: ring.left + ring.width / 2, top: fingerAbove ? ring.top - 6 : ring.top + ring.height + 6 }}>
            {fingerAbove ? '👇' : '👆'}
          </div>
        </>
      )}
      <div className={`gd-bubble ${bubbleTop ? 'gd-top' : 'gd-bottom'}`} role="status" aria-live="polite">
        <p className="gd-count">{task.title}</p>
        <p className="gd-text">{step.text}</p>
        {step.sub && <p className="gd-sub">{step.sub}</p>}
        <div className="gd-actions">
          <button type="button" className="gd-ghost" onClick={stop}>ガイドを終わる</button>
          {step.next && <button type="button" className="gd-main" onClick={() => advance(run.step)}>次へ</button>}
        </div>
      </div>
    </>,
    topLayer(),
  )
}

function Chooser({ onPick, onClose }: { onPick: (t: GuideTask) => void; onClose: () => void }) {
  return (
    <div className="gd-sheet-back" onClick={onClose}>
      <div className="gd-sheet" role="dialog" aria-modal="true" aria-labelledby="gd-sheet-title" onClick={e => e.stopPropagation()}>
        <p className="gd-sheet-kicker">使い方ガイド</p>
        <h2 id="gd-sheet-title">これから何を行いますか？</h2>
        <p className="gd-sheet-lead">選ぶと、押す場所を順番に案内します。</p>
        <div className="gd-list">
          {GUIDE_TASKS.map(t => (
            <button type="button" key={t.id} className="gd-item" onClick={() => onPick(t)}>
              <span><strong>{t.title}</strong><small>{t.sub}</small></span>
              <ChevronRight size={22} />
            </button>
          ))}
        </div>
        <button type="button" className="gd-close" onClick={onClose}>閉じる</button>
      </div>
    </div>
  )
}
