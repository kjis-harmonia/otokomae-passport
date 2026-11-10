import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { GuideStep, GuideTask } from './guideSteps'
import './staffGuide.css'

// 使い方ガイドの本体（店舗端末とお客様アプリで共通）。「これから何を行いますか？」で作業を選ぶと、
// 押す場所を ◯ で囲んで 👇 で指し、押したら次の場所へ進む。
// 手順は ns（staff / customer）ごとに1つ。画面が変わっても続きから案内する（タブを閉じると消える）。

const OPTIONAL_WAIT_MS = 1800

type Run = { task: string; step: number }
type Rect = { top: number; left: number; width: number; height: number }

const runKey = (ns: string) => (ns === 'staff' ? 'ginjiro_guide_run' : `ginjiro_guide_run_${ns}`)
const seenKey = (ns: string) => (ns === 'staff' ? 'ginjiro_guide_seen' : `ginjiro_guide_seen_${ns}`)

function readRun(ns: string): Run | null {
  try { const v = sessionStorage.getItem(runKey(ns)); return v ? JSON.parse(v) as Run : null } catch { return null }
}
function writeRun(ns: string, run: Run | null) {
  try { if (run) sessionStorage.setItem(runKey(ns), JSON.stringify(run)); else sessionStorage.removeItem(runKey(ns)) } catch { /* 保存できなくてもこのページでは続けられる */ }
}

// 手順はページ全体で1つ。画面が切り替わってガイドが作り直されても、同じ手順から続ける
const SYNC_EVENT = 'ginjiro-guide:sync'
const shared: Record<string, Run | null> = {}
const getShared = (ns: string): Run | null => (ns in shared ? shared[ns] : (shared[ns] = readRun(ns)))
function setShared(ns: string, next: Run | null) {
  shared[ns] = next
  writeRun(ns, next)
  window.dispatchEvent(new Event(SYNC_EVENT))
}
/** from＝進める前の手順。押した直後と「済んだので飛ばす」が重なっても2つ進まない */
function advanceShared(ns: string, from: number, to = from + 1) {
  const cur = getShared(ns)
  if (cur && cur.step === from) setShared(ns, { ...cur, step: to })
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

// ちび銀ちゃんが重なってはいけない物：文字（見出し・料金も）と入力欄。ガイド自身は除く
const GUIDE_PARTS = '.gd-bubble, .gd-ring, .gd-chibi, .gd-finger, .gd-sheet-back'
function hitsReadable(root: HTMLElement, box: Rect): boolean {
  const hit = (r: DOMRect) => r.width > 2 && r.height > 2
    && r.left < box.left + box.width && r.right > box.left && r.top < box.top + box.height && r.bottom > box.top
  for (const el of root.querySelectorAll<HTMLElement>('input, select, textarea')) {
    if (!el.closest(GUIDE_PARTS) && hit(el.getBoundingClientRect())) return true
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue?.trim()) continue
    const p = n.parentElement
    if (!p || !hit(p.getBoundingClientRect()) || p.closest(GUIDE_PARTS)) continue
    const cs = getComputedStyle(p)
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue
    range.selectNodeContents(n)
    for (const r of range.getClientRects()) if (hit(r)) return true
  }
  return false
}

const isField = (el: EventTarget | null) => el instanceof HTMLSelectElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement

export type GuideWords = { kicker: string; title: string; lead: string; others: string }
// お客様アプリは 👇 の代わりに「ちび銀ちゃん」が指さす。絵の指先は 横42%・縦82%、高さ 140px
const CHIBI = { h: 140, w: 140 * 183 / 300, tipX: 0.42, tipY: 0.82, sprite: '/guide/chibi-squat-sprite.webp', still: '/guide/chibi-squat.png' }
const STAFF_WORDS: GuideWords = { kicker: '使い方ガイド', title: 'これから何を行いますか？', lead: '選ぶと、押す場所を順番に案内します。', others: 'ほかの作業を見る' }

export function GuideRunner({ ns, tasks, openEvent, autoOpen = false, autoTask, paused = false, pauseWhen, words = STAFF_WORDS, chibi = false }: {
  ns: string
  tasks: GuideTask[]
  /** このイベントで「これから何を行いますか？」を開く */
  openEvent: string
  /** 初めての端末で1回だけ、選ぶ画面を開く */
  autoOpen?: boolean
  /** 初めての端末で1回だけ、この作業（ボタンの場所の案内など）を始める */
  autoTask?: string
  /** ほかの案内（最初の案内・クーポン・Face ID など）が出ている間は何も出さない */
  paused?: boolean
  /** これが画面にある間も何も出さない（お知らせのポップアップ・ガチャの演出など） */
  pauseWhen?: string
  words?: GuideWords
  /** 👇 の代わりにちび銀ちゃんを出す（お客様アプリ） */
  chibi?: boolean
}) {
  const [run, setRunState] = useState<Run | null>(() => getShared(ns))
  const [choosing, setChoosing] = useState(false)
  const [rect, setRect] = useState<Rect | null>(null)
  const [covered, setCovered] = useState(false)
  // 文字を入れている間（キーボードが出ている間）は吹き出し・◯ を出さない。入力欄とキーボードに重ならないように
  const [typing, setTyping] = useState(false)
  // 囲んだボタンの今の文字（「この髪型でAI予約する」など）
  const [label, setLabel] = useState('')
  const stepStarted = useRef(0)
  const scrolledFor = useRef<string | null>(null)
  // 吹き出しを置く場所：開いている dialog の中（上に重なるため）か body。
  //   描いた先の dialog が閉じる・消えると吹き出しも一緒に消えるので、描いたあとに確かめて置き直す
  const [layer, setLayer] = useState<HTMLElement | null>(null)
  const hold = paused || covered
  const holdRef = useRef(hold)
  useEffect(() => { holdRef.current = hold }, [hold])

  const task: GuideTask | undefined = run ? tasks.find(t => t.id === run.task) : undefined
  const step: GuideStep | undefined = task && run ? task.steps[run.step] : undefined
  const steps = task?.steps
  const runTask = run?.task
  const runStep = run?.step
  const finished = !!task && !!run && run.step >= task.steps.length

  const setRun = useCallback((next: Run | null) => setShared(ns, next), [ns])
  const advance = useCallback((from: number, to?: number) => advanceShared(ns, from, to), [ns])
  useEffect(() => {
    const sync = () => { setRunState(getShared(ns)); setRect(null) }
    window.addEventListener(SYNC_EVENT, sync)
    sync()
    return () => window.removeEventListener(SYNC_EVENT, sync)
  }, [ns])

  // ほかの画面から決まった案内を始める（銀ちゃん：お連れ様が未登録なら「お連れ様を登録」の案内・11/10）
  useEffect(() => {
    const runTask = (e: Event) => {
      const d = (e as CustomEvent<{ ns?: string; task?: string }>).detail
      if (d?.ns === ns && d.task && tasks.some(t => t.id === d.task)) setShared(ns, { task: d.task, step: 0 })
    }
    window.addEventListener('ginjiro-guide:run', runTask)
    return () => window.removeEventListener('ginjiro-guide:run', runTask)
  }, [ns, tasks])

  // 開くボタン・初めての端末
  useEffect(() => {
    const open = () => setChoosing(true)
    window.addEventListener(openEvent, open)
    return () => window.removeEventListener(openEvent, open)
  }, [openEvent])
  useEffect(() => {
    if ((!autoOpen && !autoTask) || paused || getShared(ns)) return
    try {
      if (localStorage.getItem(seenKey(ns))) return
      localStorage.setItem(seenKey(ns), '1')
    } catch { return }
    if (autoTask) setShared(ns, { task: autoTask, step: 0 })
    else setChoosing(true) // eslint-disable-line react-hooks/set-state-in-effect
  }, [autoOpen, autoTask, paused, ns])

  useEffect(() => {
    const isText = (el: Element | null) => el instanceof HTMLTextAreaElement
      || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type))
    const check = () => setTyping(isText(document.activeElement))
    const later = () => window.setTimeout(check, 0)
    check()
    document.addEventListener('focusin', check)
    document.addEventListener('focusout', later)
    return () => { document.removeEventListener('focusin', check); document.removeEventListener('focusout', later) }
  }, [])

  // 上に重なるもの（お知らせ・演出）があるか。作業中と一覧を出している間だけ見る
  //   作業が中を案内するもの（inside：銀ちゃんの会話 など）は、重なっていても休まない
  const inside = task?.inside
  useEffect(() => {
    if (!pauseWhen || (!runTask && !choosing)) { setCovered(false); return } // eslint-disable-line react-hooks/set-state-in-effect
    const check = () => {
      const el = findVisible(inside ? `:is(${pauseWhen}):not(${inside})` : pauseWhen)
      setCovered(!!el)
    }
    check()
    const id = window.setInterval(check, 200)
    return () => window.clearInterval(id)
  }, [pauseWhen, runTask, choosing, inside])

  useEffect(() => {
    const sync = () => { const l = topLayer(); setLayer(prev => prev === l ? prev : l) }
    sync()
    if (!runTask) return
    const id = window.setInterval(sync, 250)
    return () => window.clearInterval(id)
  })

  // ちび銀ちゃんの絵は、ガイドを始めたときに読む（ホームを開くたびには読まない。「？」の場所の案内では読まない）
  const quietRun = !!task?.quiet
  // 吹き出しが上にあるとき、銀ちゃんが吹き出しに隠れないよう、吹き出しの下の端を測っておく
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [bubbleBox, setBubbleBox] = useState({ top: 0, bottom: 0 })
  // 毎回測る（同じ値なら set しないので繰り返さない）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const r = bubbleRef.current?.getBoundingClientRect()
    const top = r ? Math.round(r.top) : 0, bottom = r ? Math.round(r.bottom) : 0
    if (top !== bubbleBox.top || bottom !== bubbleBox.bottom) setBubbleBox({ top, bottom })
  })
  useEffect(() => {
    if (!chibi || !runTask || quietRun) return
    const img = new Image()
    // 動きを減らす設定の端末は、止まった1枚だけ
    img.src = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? CHIBI.still : CHIBI.sprite
  }, [chibi, runTask, quietRun])

  // 場所を探して ◯ を合わせる・済んだ手順は飛ばす
  useEffect(() => {
    if (!step || !steps || runStep === undefined || hold) return
    stepStarted.current = Date.now()
    const at = runStep
    const tick = () => {
      // 待つ間（銀ちゃんが話している途中など）は、待ち時間を数え直す（出るかどうか分からない手順を飛ばさない）。
      //   画面に出た先の手順（話の途中に出るカレンダーなど）へ追いつくのはそのまま
      if (step.waitWhile && findVisible(step.waitWhile)) stepStarted.current = Date.now()
      if ((step.skipIf && findVisible(step.skipIf)) || (step.until && findVisible(step.until))) { advance(at); return }
      const el = findVisible(step.target)
      if (!el) {
        // 案内より先に押して進んだとき：今の画面にある、先の手順へ追いつく
        //   出るかどうか分からない手順（料金・券など、読み込みに少しかかる）は、待ってから追いつく
        const waited = Date.now() - stepStarted.current > OPTIONAL_WAIT_MS
        const ahead = !step.optional || waited ? steps.findIndex((s, i) => i > at && !s.noJump && !!findVisible(s.target)) : -1
        if (ahead > 0 && runTask) { setShared(ns, { task: runTask, step: ahead }); return }
        if (step.optional && waited) advance(at)
        else setRect(null)
        return
      }
      if (step.label) { const t = (el.querySelector(step.label) ?? el).textContent?.trim() ?? ''; setLabel(t) }
      // お客様アプリ：縦に長い一覧（狙う景品・メニューなど）を押す手順は、一番上の1つだけ光らせる（11/11：一覧の下がカードに隠れていた）
      let focus: HTMLElement = el
      if (chibi && !step.read && el.getBoundingClientRect().height > window.innerHeight * 0.4) {
        const first = el.querySelector<HTMLElement>('button:not([disabled]), [role="radio"], a[href], li')
        if (first && first.getBoundingClientRect().height > 0) focus = first
      }
      const r = focus.getBoundingClientRect()
      const key = `${runTask}:${at}`
      // 見えていなければスクロール（手順ごとに1回）。お客様アプリは、下のカード（吹き出し）と下のタブの高さぶん空けて、隠れない所まで
      const bubbleH = chibi ? (bubbleRef.current?.getBoundingClientRect().height ?? 120) : 0
      const navEl = chibi ? document.querySelector<HTMLElement>('.v2-nav') : null
      const navH = navEl && !findVisible('[data-guide="lc"]') ? window.innerHeight - navEl.getBoundingClientRect().top : 0
      const bottomRoom = chibi ? bubbleH + navH + 20 : 150
      if (scrolledFor.current !== key && (r.top < 64 || r.bottom > window.innerHeight - bottomRoom || r.left < 0 || r.right > window.innerWidth)) {
        scrolledFor.current = key
        // 見える所より高い枠は、真ん中に合わせると一番上が隠れるので上に合わせる
        const tall = r.height > window.innerHeight - 64 - bottomRoom
        //   上に合わせるときは、枠の上の線と 👇 が見えるよう少し空ける（ちび銀ちゃんは枠の右上の角に座るので、その分も空ける）
        const mt = focus.style.scrollMarginTop, mb = focus.style.scrollMarginBottom
        focus.style.scrollMarginTop = `${chibi ? 24 + CHIBI.h : 24}px`
        focus.style.scrollMarginBottom = `${bottomRoom}px`
        // 画面より横に長い枠（髪型の種類のボタンの列など）は、真ん中に合わせると先頭のボタン（昭和の漢）が左に隠れるので左に合わせる（11/7）
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
        const block = tall || r.top < 64 ? 'start' : chibi ? 'end' : 'center'
        focus.scrollIntoView({ block, inline: r.width >= window.innerWidth - 1 ? 'start' : 'center', behavior })
        focus.style.scrollMarginTop = mt; focus.style.scrollMarginBottom = mb
      }
      setRect(prev => prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
        ? prev : { top: r.top, left: r.left, width: r.width, height: r.height })
    }
    tick()
    const id = window.setInterval(tick, 120)
    return () => window.clearInterval(id)
  }, [step, steps, runTask, runStep, advance, hold, ns, chibi])

  // 囲んだ場所を押したら次へ（入力欄は選び終わったら）
  useEffect(() => {
    if (!step || !run || step.until || (step.next && !step.tap)) return
    const at = run.step
    const inside = (t: EventTarget | null) => {
      if (holdRef.current) return false
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
  const pressNext = () => {
    if (!run || !task || !step) return
    if (step.stopHere) advance(run.step, task.steps.length)
    else advance(run.step)
  }

  // 一覧も、ほかの案内（最初の案内・お知らせなど）が出ている間は休ませる。消えたらまた出す
  if (choosing) return hold ? null : createPortal(<Chooser tasks={tasks.filter(t => !t.hidden && (!t.available || t.available()))} words={words} onPick={start} onClose={() => setChoosing(false)} />, document.body)
  if (!task || !run || hold) return null
  const conversation = chibi && findVisible('[data-guide="lc"]')
  const bottomNav = chibi && !conversation ? findVisible('.v2-nav') : null
  const aboveNav = bottomNav ? { bottom: window.innerHeight - bottomNav.getBoundingClientRect().top + 8 } : undefined

  if (finished) {
    // 1つだけの案内（ボタンの場所など）は、終わったらそのまま閉じる
    if (task.quiet) { stop(); return null }
    return createPortal(
      <div className="gd-bubble gd-bottom" role="status" style={aboveNav}>
        <p className="gd-count">{task.title}</p>
        <p className="gd-text">これで終わりです</p>
        <div className="gd-actions">
          <button type="button" className="gd-ghost" onClick={() => { stop(); setChoosing(true) }}>{words.others}</button>
          <button type="button" className="gd-main" onClick={stop}>閉じる</button>
        </div>
      </div>,
      layer && layer.isConnected ? layer : document.body,
    )
  }
  if (!step || typing) return null
  // 指す場所が今の画面に無い間（別の画面へ移った・予約で入っている・券が無い など）は、吹き出しも出さない
  if (!rect) return null

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
  const alt = step.alts?.find(a => !!findVisible(a.when))
  const vh = window.innerHeight
  const fingerAbove = !ring || ring.top > 76
  // 縦に大きい枠（写真の並びなど）は、上の別のボタンを指して見えないよう 👇 を枠の中に出す
  const fingerInside = !!ring && ring.height > 220
  // 高い枠（一覧・予約できました など）は上を読むので、吹き出しは下に
  const bubbleTop = !!ring && ring.height <= vh - 214 && ring.top + ring.height / 2 > vh * 0.55
  // ちび銀ちゃん：読めることが先。文字・料金・見出し・入力欄・吹き出しに重なる所には置かない
  //   置く場所の順：指先を押す場所の真上 → 枠の右上の角 → 枠の左上の角。どこにも入らなければ出さない（吹き出しだけ）
  //   縦に大きい枠（写真の並び・一覧など）は、真上に置くと中身にかかるので角だけ
  let chibiAt: { left: number; top: number } | null = null
  if (chibi && !conversation && ring && !step.read) {
    const vw = window.innerWidth
    const right = Math.min(ring.left + ring.width, vw)
    const left = Math.max(ring.left, 0)
    const spots = [
      ...(fingerInside ? [] : [{ left: ring.left + ring.width / 2 - CHIBI.w * CHIBI.tipX, top: ring.top - 6 - CHIBI.h * CHIBI.tipY }]),
      { left: right - 6 - CHIBI.w, top: ring.top + 4 - CHIBI.h },
      { left: left + 6, top: ring.top + 4 - CHIBI.h },
    ]
    const root = layer && layer.isConnected ? layer : document.body
    chibiAt = spots.find(p => {
      const box = { left: p.left, top: p.top, width: CHIBI.w, height: CHIBI.h }
      if (p.top < 8 || p.left < 4 || p.left + CHIBI.w > vw - 4 || p.top + CHIBI.h > vh - 4) return false
      if (bubbleBox.bottom > bubbleBox.top && p.top < bubbleBox.bottom + 4 && p.top + CHIBI.h > bubbleBox.top - 4) return false
      return !hitsReadable(root, box)
    }) ?? null
  }

  return createPortal(
    <>
      {ring && (
        <>
          <div className={`gd-ring${round ? ' is-round' : ''}${step.noDim ? ' is-clear' : chibi ? ' is-light' : ''}`} aria-hidden="true"
            style={{ top: ring.top, left: ring.left, width: ring.width, height: ring.height }} />
          {/* 読むだけの手順（予約できました など）は指を出さない。日時やタイトルにかぶるので */}
          {chibiAt && <div className="gd-chibi" aria-hidden="true" style={{ left: chibiAt.left, top: chibiAt.top }} />}
          {!step.read && !chibi && <div className={`gd-finger${fingerAbove || fingerInside ? '' : ' is-below'}`} aria-hidden="true"
            style={{ left: ring.left + ring.width / 2, top: fingerInside ? ring.top + Math.min(ring.height / 2, 160) : fingerAbove ? ring.top - 6 : ring.top + ring.height + 6 }}>
            {fingerAbove || fingerInside ? '👇' : '👆'}
          </div>}
        </>
      )}
      {chibi ? (
        // お客様アプリ：小さいカード（見出しと一言だけ）。終わるは右上の ×（11/11：一覧の下が隠れていた）
        <div ref={bubbleRef} className={`gd-bubble gd-compact ${bubbleTop ? 'gd-top' : 'gd-bottom'}`} role="status" aria-live="polite" style={bubbleTop ? undefined : aboveNav}>
          <button type="button" className="gd-x" aria-label="ガイドを終わる" onClick={stop}>×</button>
          <div className="gd-compact-row">
            <div className="gd-compact-text">
              <p className="gd-text">{alt ? alt.text : step.label ? step.text.replace('{label}', label) : step.text}</p>
              {(alt ? alt.sub : step.sub) && <p className="gd-sub">{alt ? alt.sub : step.sub}</p>}
            </div>
            {step.next && <button type="button" className="gd-main" onClick={pressNext}>{step.nextLabel ?? '次へ'}</button>}
          </div>
        </div>
      ) : (
        <div ref={bubbleRef} className={`gd-bubble ${bubbleTop ? 'gd-top' : 'gd-bottom'}`} role="status" aria-live="polite" style={bubbleTop ? undefined : aboveNav}>
          <p className="gd-count">{task.title}</p>
          <p className="gd-text">{alt ? alt.text : step.label ? step.text.replace('{label}', label) : step.text}</p>
          {(alt ? alt.sub : step.sub) && <p className="gd-sub">{alt ? alt.sub : step.sub}</p>}
          <div className="gd-actions">
            <button type="button" className="gd-ghost" onClick={stop}>ガイドを終わる</button>
            {step.next && <button type="button" className="gd-main" onClick={pressNext}>{step.nextLabel ?? '次へ'}</button>}
          </div>
        </div>
      )}
    </>,
    layer && layer.isConnected ? layer : document.body,
  )
}

function Chooser({ tasks, words, onPick, onClose }: { tasks: GuideTask[]; words: GuideWords; onPick: (t: GuideTask) => void; onClose: () => void }) {
  return (
    <div className="gd-sheet-back" onClick={onClose}>
      <div className="gd-sheet" role="dialog" aria-modal="true" aria-labelledby="gd-sheet-title" onClick={e => e.stopPropagation()}>
        <p className="gd-sheet-kicker">{words.kicker}</p>
        <h2 id="gd-sheet-title">{words.title}</h2>
        <p className="gd-sheet-lead">{words.lead}</p>
        <div className="gd-list">
          {tasks.map(t => (
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
