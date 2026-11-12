// 銀二郎オークション【銀オク】（Staging だけ・11/12 慶一郎さん）：お店が出品したガチャ券を、銀Pay で競り落とす。
// 一覧（現在価格・即決・入札数・残り時間）→ 詳細（入札・即決・入札履歴）。入札・即決の前に必ず確かめる。
// 最高額のあいだ入札額の銀Payを押さえ、抜かれたらすぐ戻す。終了時にその押さえを引き落とし、券はすぐチケットへ（サーバーが締める。画面は結果を読むだけ）
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Clock, Minus, Plus } from 'lucide-react'
import { buyNow, loadAuction, loadAuctions, placeBid, walletAvailable, type Auction, type AuctionAction, type AuctionList } from '../features/auction/auctionApi'
import { auctionErrorMessage, clampBid, endLabel, holdNote, mineLabel, ticketRule, ticketTerms } from '../features/auction/auctionLogic'
import { RpcError } from '../utils/staffSession'
import { useServerSecond } from './launchTime'
import './ginoku.css'

const when = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
const ended = (a: Auction, now: number) => a.status !== 'open' || Date.parse(a.ends_at) <= now
const errorCode = (err: unknown) => (err instanceof RpcError ? err.code : err instanceof Error ? err.message : 'failed')

/** 金額は「6,000 銀Pay」（お支払いは銀Payだけ・11/12 慶一郎さんの見本） */
function Pay({ n, className }: { n: number | null | undefined; className?: string }) {
  return <span className={className ? `ginoku-pay-n ${className}` : 'ginoku-pay-n'}>{(n ?? 0).toLocaleString('ja-JP')}<small>銀Pay</small></span>
}
/** 文の中の金額（「6,000 銀Pay」） */
const payText = (n: number | null | undefined) => `${(n ?? 0).toLocaleString('ja-JP')} 銀Pay`
/** 残り時間は時計の形（02:14:18）。1日以上は秒を出さず「2日 03:10」（文字が隠れないように・11/13） */
function clock(endsAt: number, now: number): string {
  const s = Math.max(0, Math.floor((endsAt - now) / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const hms = [h, m, sec].map(x => String(x).padStart(2, '0')).join(':')
  return d > 0 ? `${d}日 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : hms
}

/** 月桂樹（券の左右の金の飾り） */
function Laurel({ flip = false }: { flip?: boolean }) {
  const leaves = [0, 1, 2, 3, 4, 5]
  return (
    <svg className="ginoku-laurel" viewBox="0 0 24 60" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M18 58 C 8 46, 6 26, 14 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {leaves.map(i => {
        const y = 52 - i * 9, x = 15 - Math.sin((i / 5) * 1.4) * 6
        return <g key={i}>
          <ellipse cx={x - 4} cy={y - 2} rx="4.2" ry="1.8" transform={`rotate(-38 ${x - 4} ${y - 2})`} fill="currentColor" />
          <ellipse cx={x + 3.5} cy={y - 4} rx="4" ry="1.7" transform={`rotate(-70 ${x + 3.5} ${y - 4})`} fill="currentColor" opacity=".85" />
        </g>
      })}
    </svg>
  )
}

/** 券の文字：「銀パラ無料券」→「銀パラ／無料」、「500円引き券」→「500円引き」 */
function ticketWords(title: string): string[] {
  const t = title.replace(/券$/, '').trim()
  const m = t.match(/^(.+?)\s*無料$/)
  return m ? [m[1], '無料'] : [t]
}

/** 金の券（見本の絵の形：ふちに切り欠き・左右に月桂樹・少し傾ける） */
function AuctionTicket({ a, large = false }: { a: Auction; large?: boolean }) {
  const words = ticketWords(a.title)
  return (
    <span className={`ginoku-gold${large ? ' is-lg' : ''}`} aria-hidden="true">
      <span className="ginoku-gold-face">
        <Laurel />
        <b className={words.length > 1 ? 'is-two' : undefined}>{words.map(w => <span key={w} className={w.length > 5 ? 'is-long' : undefined}>{w}</span>)}</b>
        <Laurel flip />
      </span>
    </span>
  )
}

/** 前に見た値段より上がったか（入札が入ったら、その値段を一度だけ金色に光らせる・11/12） */
function useRose() {
  const seen = useRef(new Map<string, number>())
  return (a: Auction) => {
    const p = a.current_price ?? a.start_price
    const before = seen.current.get(a.id)
    seen.current.set(a.id, p)
    return before !== undefined && p > before
  }
}
/** 詳細以外の残り時間（秒は出さない・11/13）：「2日 19時間」「5時間 28分」「38分」 */
function leftShort(endsAt: number, now: number): string {
  const m = Math.max(0, Math.floor((endsAt - now) / 60_000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d > 0) return `${d}日 ${h}時間`
  if (h > 0) return `${h}時間 ${mm}分`
  return m > 0 ? `${mm}分` : 'まもなく終了'
}
/** 残り1時間を切った */
const soonEnd = (a: Auction, now: number) => Date.parse(a.ends_at) - now < 3600_000
/** 終了間近：24時間を切った */
const nearEnd = (a: Auction, now: number) => Date.parse(a.ends_at) - now < 24 * 3600_000
/** 目玉：いま一番高く競られているもの（同じなら早く終わる方） */
const pickFeatured = (open: Auction[]) => [...open].sort((x, y) => (y.current_price ?? y.start_price) - (x.current_price ?? x.start_price) || Date.parse(x.ends_at) - Date.parse(y.ends_at))[0] ?? null

function useReloadOnVisible(load: () => void) {
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('ginjiro:customer-session-changed', load)
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('ginjiro:customer-session-changed', load) }
  }, [load])
}

export function V2Auction({ onTickets }: { onTickets: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => { top.current?.closest('.v2-main')?.scrollTo({ top: 0 }) }, [openId])
  return (
    <div ref={top}>
      {openId
        ? <AuctionDetailView id={openId} onBack={() => setOpenId(null)} onTickets={onTickets} />
        : <AuctionListView onOpen={setOpenId} />}
    </div>
  )
}

type ListTab = 'open' | 'near' | 'done'
const TABS: { id: ListTab; label: string }[] = [{ id: 'open', label: '開催中' }, { id: 'near', label: '終了間近' }, { id: 'done', label: '落札済み' }]

function AuctionListView({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<AuctionList | 'error' | null>(null)
  const [tab, setTab] = useState<ListTab>('open')
  const now = useServerSecond()
  const gen = useRef(0)
  const load = useCallback(() => {
    const my = ++gen.current
    loadAuctions().then(d => { if (my === gen.current) setData(d) }).catch(() => { if (my === gen.current) setData(prev => (prev && prev !== 'error' ? prev : 'error')) })
  }, [])
  useEffect(() => { load(); const t = window.setInterval(load, 30_000); return () => window.clearInterval(t) }, [load])
  useReloadOnVisible(load)

  // 開催中のものが終わったら、締まった結果を読み直す
  const list = data && data !== 'error' ? data.auctions : []
  const nextEnd = Math.min(...list.filter(a => a.status === 'open').map(a => Date.parse(a.ends_at)))
  const passed = Number.isFinite(nextEnd) && now >= nextEnd + 1500
  useEffect(() => { if (passed) load() }, [passed, load])

  const open = list.filter(a => !ended(a, now)).sort((x, y) => Date.parse(x.ends_at) - Date.parse(y.ends_at))
  const near = open.filter(a => nearEnd(a, now))
  const done = list.filter(a => ended(a, now) && a.status === 'sold')
  const rose = useRose()
  const risen = new Set(list.filter(rose).map(a => a.id))
  // 選んだタブの出品だけを出す（11/13 慶一郎さん「終了間近を押しても2日以上のものが上に残る」）。
  //   開催中だけ、いま一番競られている1件を大きく出す。ほかのタブは、そのタブの出品を並べるだけ
  const featured = tab === 'open' ? pickFeatured(open) : null
  const shown = tab === 'open' ? open.filter(a => a !== featured) : tab === 'near' ? near : done
  const count: Record<ListTab, number> = { open: open.length, near: near.length, done: done.length }
  // 抜かれた出品：一番上で知らせて、ひと押しで入札し直せるように
  const outbid = open.filter(a => a.mine === 'outbid')

  return (
    <div className="v2-page ginoku-page">
      <header className="ginoku-head">
        <h1 className="ginoku-name">銀オク</h1>
        <p className="ginoku-lead">銀Payで入札できる公式オークション</p>
      </header>
      {data === null && <p className="v2-note">読み込んでいます…</p>}
      {data === 'error' && <p className="v2-note">表示できませんでした。通信を確かめてください。</p>}
      {data && data !== 'error' && (
        <>
          {outbid.length > 0 && (
            <button type="button" className="ginoku-alert" onClick={() => onOpen(outbid[0].id)}>
              <span><b>入札されました</b>{outbid.length === 1 ? `${outbid[0].title.replace(/券$/, '')}で、より高い入札がありました` : `${outbid.length}件の出品で、より高い入札がありました`}</span>
              <span className="ginoku-alert-go">入札し直す<ChevronRight size={16} /></span>
            </button>
          )}
          <div className="ginoku-tabs" role="tablist" aria-label="表示する出品">
            {TABS.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : undefined} onClick={() => setTab(t.id)}>{t.label}{count[t.id] > 0 && <small>{count[t.id]}</small>}</button>)}
          </div>
          {featured && <FeaturedCard a={featured} now={now} rose={risen.has(featured.id)} onOpen={onOpen} />}
          {shown.length > 0
            ? <div className="ginoku-cards">{shown.map(a => <AuctionRow key={a.id} a={a} now={now} rose={risen.has(a.id)} onOpen={onOpen} />)}</div>
            : !featured && <p className="v2-note ginoku-empty">{tab === 'done' ? 'まだ落札された出品はありません。' : tab === 'near' ? '24時間以内に終わる出品はありません。' : 'いま開催中のオークションはありません。次の出品をお待ちください。'}</p>}
          <p className="v2-note ginoku-foot">お支払いは銀Payのみです。</p>
        </>
      )}
    </div>
  )
}

/** 値段の見出し：入札があれば「現在の入札額」、まだ無ければ「開始価格」、終わったら「落札額」 */
const priceLabel = (a: Auction, isEnded: boolean) => (isEnded ? '落札額' : a.current_price === null ? '開始価格' : '現在の入札額')

/** 目玉の1件：券は小さく左上、情報は券と分けて下に（11/13「券がデカすぎて金額や時間に被っとる」） */
function FeaturedCard({ a, now, rose, onOpen }: { a: Auction; now: number; rose: boolean; onOpen: (id: string) => void }) {
  const mine = mineLabel(a.mine)
  const hurry = soonEnd(a, now)
  return (
    <section className="ginoku-feature" aria-label={a.title}>
      <button type="button" className="ginoku-feature-head" onClick={() => onOpen(a.id)}>
        <AuctionTicket a={a} />
        <span className="ginoku-feature-name">
          <b>{a.title}</b>
          <small>{ticketRule(a)}</small>
        </span>
      </button>
      <div className="ginoku-feature-nums">
        <div>
          <p className="ginoku-k">{priceLabel(a, false)}</p>
          <Pay n={a.current_price ?? a.start_price} className={rose ? 'is-big is-up' : 'is-big'} />
        </div>
        <div className="ginoku-feature-time">
          <p className="ginoku-k">残り</p>
          <p className={hurry ? 'ginoku-time is-hurry' : 'ginoku-time'}>{leftShort(Date.parse(a.ends_at), now)}</p>
        </div>
      </div>
      {mine && <p className={`ginoku-mine is-${a.mine}`}>{mine}</p>}
      <button type="button" className="ginoku-go" onClick={() => onOpen(a.id)}>入札する</button>
    </section>
  )
}

function AuctionRow({ a, now, rose = false, onOpen }: { a: Auction; now: number; rose?: boolean; onOpen: (id: string) => void }) {
  const isEnded = ended(a, now)
  const mine = mineLabel(a.mine)
  const hurry = !isEnded && soonEnd(a, now)
  return (
    <button type="button" className="ginoku-card" onClick={() => onOpen(a.id)}>
      <AuctionTicket a={a} />
      <span className="ginoku-card-main">
        <span className="ginoku-card-title">{a.title}</span>
        <span className="ginoku-card-rule">{ticketRule(a)}</span>
        <span className="ginoku-card-nums">
          <span className="ginoku-card-price"><span className="ginoku-k">{isEnded ? '落札' : a.current_price === null ? '開始' : '現在'}</span><Pay n={isEnded ? a.final_price : a.current_price ?? a.start_price} className={rose ? 'is-up' : undefined} /></span>
          <span className={hurry ? 'ginoku-card-time is-hurry' : 'ginoku-card-time'}>{isEnded ? `${endLabel(Date.parse(a.ends_at)).replace(/（.）/, ' ')} 終了` : `残り ${leftShort(Date.parse(a.ends_at), now)}`}</span>
        </span>
        {mine && <span className={`ginoku-mine is-${a.mine}`}>{mine}</span>}
      </span>
      <ChevronRight size={18} className="ginoku-card-go" />
    </button>
  )
}

type Confirm = { kind: 'bid'; amount: number } | { kind: 'buy'; amount: number }

function AuctionDetailView({ id, onBack, onTickets }: { id: string; onBack: () => void; onTickets: () => void }) {
  const [data, setData] = useState<AuctionAction | 'error' | 'gone' | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null)
  const [allBids, setAllBids] = useState(false)
  const now = useServerSecond()
  const gen = useRef(0)
  const lastMine = useRef<string | null>(null)
  const load = useCallback(() => {
    const my = ++gen.current
    loadAuction(id).then(d => { if (my === gen.current) setData(d) }).catch((err: unknown) => { if (my === gen.current) setData(prev => (errorCode(err) === 'not_found' ? 'gone' : prev && prev !== 'error' && prev !== 'gone' ? prev : 'error')) })
  }, [id])
  useEffect(() => { load(); const t = window.setInterval(load, 10_000); return () => window.clearInterval(t) }, [load])
  useReloadOnVisible(load)

  const a = data && data !== 'error' && data !== 'gone' ? data.auction : null
  const endsAt = a ? Date.parse(a.ends_at) : 0
  const isEnded = a ? ended(a, now) : false
  const passed = a !== null && a.status === 'open' && now >= endsAt + 1500
  useEffect(() => { if (passed) load() }, [passed, load])
  // 見ている間に抜かれたら、すぐ知らせる（最高額 → 抜かれた）
  useEffect(() => {
    const m = a?.mine ?? null
    if (lastMine.current === 'leading' && m === 'outbid') setNotice({ text: 'より高い入札がありました。もう一度入札できます。', bad: true })
    lastMine.current = m
  }, [a?.mine])

  // 入力の額はいつも最低額〜即決の手前に収めて出す（ほかの方の入札で最低額が上がっても、そのまま正しい額になる）
  const min = a?.min_bid ?? 0
  const value = a ? clampBid(amount ?? min, min, a.buy_now_price, a.increment) : 0

  if (data === null) return <div className="v2-page"><Back onBack={onBack} /><p className="v2-note">読み込んでいます…</p></div>
  if (data === 'gone') return <div className="v2-page"><Back onBack={onBack} /><p className="v2-note">この出品は終わったか、取り下げられました。</p></div>
  if (data === 'error' || !a) return <div className="v2-page"><Back onBack={onBack} /><p className="v2-note">表示できませんでした。通信を確かめてください。</p></div>

  const available = walletAvailable(data.wallet)
  const walletBalance = data.wallet && 'balance' in data.wallet && typeof data.wallet.balance === 'number' ? data.wallet.balance : null
  const walletProblem = data.wallet && 'error' in data.wallet ? data.wallet.error : null
  const canAct = data.signed_in && !walletProblem && !isEnded
  const short = (n: number) => available !== null && available < n
  // 最低入札額が即決価格に届いたら、入札はできない（サーバーも断る）。ここからは即決だけ（11/12 Claude の確認）
  const onlyBuyNow = a.buy_now_price !== null && min >= a.buy_now_price
  const maxValue = clampBid(Infinity, min, a.buy_now_price, a.increment)
  // ひと押しで選べる額：最低額・＋5刻み・＋10刻み（即決の手前まで・同じ額は出さない）
  const quick = [...new Set([min, min + a.increment * 5, min + a.increment * 10].map(n => clampBid(n, min, a.buy_now_price, a.increment)))]
  const hurry = !isEnded && endsAt - now < 3600_000
  const leading = a.mine === 'leading'
  const bids = allBids ? data.bids : data.bids.slice(0, 3)
  // 即決は、自分の押さえ（最高額のあいだの入札額）も使える（DB も同じ数え方・11/12 粗探し）
  const buyBase = available === null ? null : available + (leading && a.my_bid ? a.my_bid : 0)
  const shortBuy = a.buy_now_price !== null && buyBase !== null && buyBase < a.buy_now_price

  const run = async (c: Confirm) => {
    setBusy(true)
    setNotice(null)
    try {
      const res = c.kind === 'bid' ? await placeBid(a.id, c.amount) : await buyNow(a.id)
      setData(res)
      if (res.error) setNotice({ text: auctionErrorMessage(res.error), bad: true })
      else if (c.kind === 'bid') {
        setAmount(null)
        lastMine.current = 'leading'
        setNotice({ text: res.extended ? `${payText(c.amount)}で入札しました。終了間際のため、終了を5分延ばしました。` : `${payText(c.amount)}で入札しました。いまの最高額です。` })
      }
      window.dispatchEvent(new Event('ginjiro:ginpay-holds-changed'))
    } catch (err) {
      setNotice({ text: auctionErrorMessage(errorCode(err)), bad: true })
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  return (
    <div className="v2-page ginoku-detail">
      <Back onBack={onBack} />
      <div className="ginoku-hero"><AuctionTicket a={a} large /></div>
      <h1 className="ginoku-title">{a.title}</h1>
      <dl className="ginoku-terms" aria-label="券の条件">
        {ticketTerms(a).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>

      {a.mine === 'won' ? (
        <section className="v2-panel ginoku-panel ginoku-won-panel">
          <p className="ginoku-won"><Check size={22} />落札しました</p>
          <p className="v2-note" style={{ margin: '4px 0 14px' }}>{payText(a.final_price)}を銀Payでお支払い済みです。券はチケットに入っています。</p>
          <button type="button" className="ginoku-go" onClick={onTickets}>チケットを見る</button>
        </section>
      ) : (
        <section className="v2-panel ginoku-panel ginoku-one">
          {/* 自分の状況はいちばん上に、色で（最高額＝金、抜かれた＝赤み） */}
          {a.mine && <p className={`ginoku-state is-${a.mine}`}>{a.mine === 'leading' ? '最高額で入札中' : a.mine === 'outbid' ? '入札されました' : '落札できませんでした'}{a.my_bid !== null && a.mine !== 'lost' ? <small>あなたの入札 {payText(a.my_bid)}</small> : null}</p>}
          <div className="ginoku-one-top">
            <div>
              <p className="ginoku-k">{isEnded ? (a.status === 'sold' ? '落札額' : '終了') : a.current_price === null ? '開始価格' : '現在の入札額'}</p>
              <p className="ginoku-price">{isEnded && a.status !== 'sold' ? (a.status === 'unsold' ? '落札なし' : '集計中') : <Pay n={isEnded ? a.final_price : a.current_price ?? a.start_price} className="is-big" />}</p>
            </div>
            <div className="ginoku-one-time">
              <p className="ginoku-k"><Clock size={12} />残り</p>
              <p className={hurry ? 'ginoku-one-clock is-hurry' : 'ginoku-one-clock'}>{isEnded ? '終了' : clock(endsAt, now)}</p>
            </div>
          </div>
          <p className="ginoku-end">入札 {a.bid_count}件・即決 {a.buy_now_price === null ? 'なし' : payText(a.buy_now_price)}・{isEnded ? '終了' : '終了予定'} {endLabel(endsAt)}{a.extended && !isEnded ? '（延長あり）' : ''}</p>

          {!isEnded && (
            <div className="ginoku-one-bid" aria-label="入札">
              {!data.signed_in ? (
                <p className="ginoku-hint">店頭で本人確認が済むと、銀Payで入札できます。</p>
              ) : walletProblem ? (
                <p className="ginoku-hint">{auctionErrorMessage(walletProblem)}</p>
              ) : onlyBuyNow ? (
                <p className="ginoku-hint">入札が即決価格まで上がったので、ここからは即決だけです。</p>
              ) : leading ? (
                <p className="ginoku-hint">{holdNote(a.held ?? a.my_bid ?? 0)}</p>
              ) : (
                <>
                  <div className="ginoku-quick" role="group" aria-label="入札額">
                    {quick.map(n => <button key={n} type="button" aria-pressed={value === n} disabled={busy || short(n)} onClick={() => setAmount(n)}>{n === min ? <small>最低額</small> : <small>＋{(n - min).toLocaleString('ja-JP')}</small>}{n.toLocaleString('ja-JP')}</button>)}
                  </div>
                  <div className="ginoku-stepper is-small">
                    <button type="button" className="v2-round v2-glass" aria-label={`${a.increment.toLocaleString('ja-JP')}銀Pay下げる`} disabled={busy || value <= min} onClick={() => setAmount(value - a.increment)}><Minus size={16} /></button>
                    <output aria-live="polite"><Pay n={value} /></output>
                    <button type="button" className="v2-round v2-glass" aria-label={`${a.increment.toLocaleString('ja-JP')}銀Pay上げる`} disabled={busy || value >= maxValue} onClick={() => setAmount(value + a.increment)}><Plus size={16} /></button>
                  </div>
                  <p className={short(value) ? 'ginoku-hint is-bad' : 'ginoku-hint'}>{short(value) ? '銀Payの残高が足りません。店頭でチャージできます。' : `使える銀Pay ${(available ?? 0).toLocaleString('ja-JP')}・終了5分前からの入札で5分延長`}</p>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {notice && <p className={notice.bad ? 'ginoku-toast is-bad' : 'ginoku-toast'} role="status">{notice.bad ? null : <Check size={16} />}{notice.text}</p>}

      {data.bids.length > 0 && (
        <section className="ginoku-bids" aria-label="入札履歴">
          <p className="ginoku-k">最新の入札</p>
          {bids.map((b, i) => (
            <div key={`${b.at}-${i}`} className={b.mine ? 'ginoku-bid is-mine' : 'ginoku-bid'}>
              <span>{b.mine ? 'あなた' : b.bidder}{i === 0 && !allBids ? <em>最高額</em> : null}<small>{when(b.at)}</small></span>
              <b>{payText(b.amount)}</b>
            </div>
          ))}
          {!allBids && (data.bids.length > 3 || a.bid_count > 3) && <button type="button" className="ginoku-more" onClick={() => setAllBids(true)}>入札履歴をすべて見る（{a.bid_count}件）</button>}
        </section>
      )}

      {/* 下に固定の入札ボタン（どこまで読んでも、すぐ押せる） */}
      {!isEnded && canAct && (!leading || a.buy_now_price !== null) && (
        <div className="ginoku-bar">
          {!onlyBuyNow && !leading && <button type="button" className="ginoku-go" disabled={busy || short(value)} onClick={() => setConfirm({ kind: 'bid', amount: value })}>{payText(value)}で入札</button>}
          {a.buy_now_price !== null && <button type="button" className={onlyBuyNow || leading ? 'ginoku-go' : 'ginoku-buy-now'} disabled={busy || shortBuy} onClick={() => setConfirm({ kind: 'buy', amount: a.buy_now_price! })}>即決 {payText(a.buy_now_price)}</button>}
        </div>
      )}

      {confirm && (
        <>
          <div className="v2-sheet-back" onClick={() => !busy && setConfirm(null)} />
          <div className="v2-sheet ginoku-sheet" role="dialog" aria-modal="true" aria-label="確認">
            <div className="v2-grab" />
            <p className="ginoku-sheet-title">{confirm.kind === 'bid' ? `${payText(confirm.amount)}で入札しますか？` : `即決 ${payText(confirm.amount)}で落札しますか？`}</p>
            <dl className="ginoku-sheet-facts">
              <div><dt>券</dt><dd>{a.title}</dd></div>
              <div><dt>条件</dt><dd>{ticketRule(a)}</dd></div>
              {confirm.kind === 'bid' ? (
                // 入札では銀Payは減らない（11/13 慶一郎さん「入札中はまだ銀Pay減らしたらあかん」）。減るのは落札したときだけ
                <>
                  <div><dt>入札額</dt><dd>{payText(confirm.amount)}</dd></div>
                  <div><dt>銀Payの残高</dt><dd>{walletBalance === null ? '—' : `${walletBalance.toLocaleString('ja-JP')}`}</dd></div>
                </>
              ) : (
                <>
                  <div><dt>お支払い</dt><dd>{payText(confirm.amount)}</dd></div>
                  <div><dt>銀Payの残高</dt><dd>{walletBalance === null ? '—' : `${walletBalance.toLocaleString('ja-JP')} → ${(walletBalance - confirm.amount).toLocaleString('ja-JP')}`}</dd></div>
                </>
              )}
            </dl>
            <p className="v2-note" style={{ margin: '4px 0 14px' }}>
              {confirm.kind === 'bid'
                ? '入札は取り消せません。'
                : '券はチケットに入ります。'}
            </p>
            <div className="ginoku-sheet-actions">
              <button type="button" className="ginoku-go" disabled={busy} onClick={() => void run(confirm)}>{busy ? '送信しています…' : confirm.kind === 'bid' ? '入札する' : '落札する'}</button>
              <button type="button" className="v2-btn v2-btn-quiet" disabled={busy} onClick={() => setConfirm(null)}>やめる</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Back({ onBack }: { onBack: () => void }) {
  return <button type="button" className="v2-back" onClick={onBack}><ChevronLeft size={18} />一覧へ</button>
}
