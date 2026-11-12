// 銀二郎オークション【銀オク】（Staging だけ・11/12 慶一郎さん）：お店が出品したガチャ券を、銀Pay で競り落とす。
// 一覧（現在価格・即決・入札数・残り時間）→ 詳細（入札・即決・入札履歴）。入札・即決の前に必ず確かめる。
// 終了時に最高額の方の銀Pay から引き落とし、券はすぐチケットへ（サーバーが締める。画面は結果を読むだけ）
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
import { buyNow, loadAuction, loadAuctions, placeBid, walletAvailable, type Auction, type AuctionAction, type AuctionList } from '../features/auction/auctionApi'
import { auctionErrorMessage, clampBid, endLabel, mineLabel, timeLeft } from '../features/auction/auctionLogic'
import { yen } from '../utils/ginpayApi'
import { RpcError } from '../utils/staffSession'
import { useServerSecond } from './launchTime'
import './ginoku.css'

const when = (iso: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
const ended = (a: Auction, now: number) => a.status !== 'open' || Date.parse(a.ends_at) <= now
const errorCode = (err: unknown) => (err instanceof RpcError ? err.code : err instanceof Error ? err.message : 'failed')

/** 券の絵（白い大理石。大当たりは黒い大理石に金の文字） */
function AuctionTicket({ a, large = false }: { a: Auction; large?: boolean }) {
  return (
    <span className={`ginoku-tk is-${a.rank}${large ? ' is-lg' : ''}`} aria-hidden="true">
      <span className="ginoku-tk-brand">GINJIRO</span>
      <b>{a.ticket_amount.toLocaleString('ja-JP')}<small>円引き</small></b>
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
/** 残り1時間を切った */
const soon = (a: Auction, now: number) => Date.parse(a.ends_at) - now < 3600_000
/** 目玉：いちばん早く終わる開催中のもの（同じなら額の大きい券） */
const pickFeatured = (open: Auction[]) => [...open].sort((x, y) => Date.parse(x.ends_at) - Date.parse(y.ends_at) || y.ticket_amount - x.ticket_amount)[0] ?? null

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

function AuctionListView({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<AuctionList | 'error' | null>(null)
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

  const open = list.filter(a => !ended(a, now))
  const done = list.filter(a => ended(a, now))
  const available = data && data !== 'error' ? walletAvailable(data.wallet) : null
  const featured = pickFeatured(open)
  const rest = open.filter(a => a !== featured)
  const rose = useRose()
  const risen = new Set(list.filter(rose).map(a => a.id))

  return (
    <div className="v2-page">
      {/* 入口の看板（黒い大理石に金の文字）：ガチャの「解禁」と同じ、銀二郎の夜の世界 */}
      <header className="ginoku-banner">
        <p className="ginoku-banner-kicker">GINJIRO AUCTION</p>
        <h1 className="ginoku-banner-title">銀オク</h1>
        <p className="ginoku-banner-sub">{open.length ? `開催中 ${open.length}件` : '次の出品をお待ちください'}</p>
        {available !== null && <p className="ginoku-banner-pay">使える銀Pay <b>{yen(available)}</b></p>}
      </header>
      {data === null && <p className="v2-note">読み込んでいます…</p>}
      {data === 'error' && <p className="v2-note">表示できませんでした。通信を確かめてください。</p>}
      {data && data !== 'error' && (
        <>
          {open.length === 0
            ? <p className="v2-note ginoku-empty">いま開催中のオークションはありません。</p>
            : (
              <>
                {featured && <FeaturedCard a={featured} now={now} rose={risen.has(featured.id)} onOpen={onOpen} />}
                {rest.length > 0 && (
                  <section className="v2-panel v2-glass ginoku-list" aria-label="開催中">
                    {rest.map(a => <AuctionRow key={a.id} a={a} now={now} rose={risen.has(a.id)} onOpen={onOpen} />)}
                  </section>
                )}
              </>
            )}
          {done.length > 0 && (
            <>
              <p className="v2-label ginoku-section">終了</p>
              <section className="v2-panel v2-glass ginoku-list is-done" aria-label="終了">
                {done.map(a => <AuctionRow key={a.id} a={a} now={now} onOpen={onOpen} />)}
              </section>
            </>
          )}
          <p className="v2-note ginoku-foot">お支払いは銀Payのみです。終了時に最高額の方の銀Payから引き落とし、券はチケットに入ります。</p>
        </>
      )}
    </div>
  )
}

/** 目玉の1件：券を大きく、今の値段と残り時間を主役に */
function FeaturedCard({ a, now, rose, onOpen }: { a: Auction; now: number; rose: boolean; onOpen: (id: string) => void }) {
  const left = timeLeft(Date.parse(a.ends_at), now)
  const hurry = soon(a, now)
  const mine = mineLabel(a.mine)
  return (
    <button type="button" className="ginoku-feature v2-glass" onClick={() => onOpen(a.id)} aria-label={`${a.title}の入札を見る`}>
      {hurry && <span className="ginoku-tag">まもなく終了</span>}
      <AuctionTicket a={a} large />
      <span className="ginoku-feature-title">{a.title}</span>
      <span className="ginoku-feature-label">{a.current_price === null ? '開始価格' : '現在価格'}</span>
      <b className={rose ? 'ginoku-feature-price is-up' : 'ginoku-feature-price'}>{yen(a.current_price ?? a.start_price)}</b>
      <span className="ginoku-feature-meta">
        <span className={hurry ? 'ginoku-left is-hurry' : 'ginoku-left'}>残り {left}</span>
        <span>入札 {a.bid_count}件</span>
        {a.buy_now_price !== null && <span>即決 {yen(a.buy_now_price)}</span>}
      </span>
      {mine && <span className={`ginoku-mine is-${a.mine}`}>{mine}</span>}
      <span className="ginoku-feature-go">入札する<ChevronRight size={16} /></span>
    </button>
  )
}

function AuctionRow({ a, now, rose = false, onOpen }: { a: Auction; now: number; rose?: boolean; onOpen: (id: string) => void }) {
  const left = timeLeft(Date.parse(a.ends_at), now)
  const isEnded = ended(a, now)
  const mine = mineLabel(a.mine)
  const hurry = !isEnded && soon(a, now)
  return (
    <button type="button" className="ginoku-row" onClick={() => onOpen(a.id)}>
      <AuctionTicket a={a} />
      <span className="ginoku-row-main">
        <span className="ginoku-row-title">{a.title}</span>
        {isEnded ? (
          <span className="ginoku-row-meta">{a.status === 'sold' ? `落札 ${yen(a.final_price)}` : a.status === 'unsold' ? '落札なし' : '集計中'}</span>
        ) : (
          <>
            <span className="ginoku-row-price">
              <b className={rose ? 'is-up' : undefined}>{yen(a.current_price ?? a.start_price)}</b>
              {a.buy_now_price !== null && <small>即決 {yen(a.buy_now_price)}</small>}
            </span>
            <span className="ginoku-row-meta"><span className={hurry ? 'ginoku-left is-hurry' : 'ginoku-left'}>残り {left}</span><span>入札 {a.bid_count}件</span>{hurry && <span className="ginoku-tag is-small">まもなく終了</span>}</span>
          </>
        )}
        {mine && <span className={`ginoku-mine is-${a.mine}`}>{mine}</span>}
      </span>
      <ChevronRight size={18} className="ginoku-row-go" />
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
  const now = useServerSecond()
  const gen = useRef(0)
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

  // 入力の額はいつも最低額〜即決の手前に収めて出す（ほかの方の入札で最低額が上がっても、そのまま正しい額になる）
  const min = a?.min_bid ?? 0
  const value = a ? clampBid(amount ?? min, min, a.buy_now_price, a.increment) : 0

  if (data === null) return <div className="v2-page"><Back onBack={onBack} /><p className="v2-note">読み込んでいます…</p></div>
  if (data === 'gone') return <div className="v2-page"><Back onBack={onBack} /><p className="v2-note">この出品は終わったか、取り下げられました。</p></div>
  if (data === 'error' || !a) return <div className="v2-page"><Back onBack={onBack} /><p className="v2-note">表示できませんでした。通信を確かめてください。</p></div>

  const available = walletAvailable(data.wallet)
  const walletProblem = data.wallet && 'error' in data.wallet ? data.wallet.error : null
  const left = timeLeft(endsAt, now)
  const mine = mineLabel(a.mine)
  const canAct = data.signed_in && !walletProblem && !isEnded
  const short = (n: number) => available !== null && available < n
  // 最低入札額が即決価格に届いたら、入札はできない（サーバーも断る）。ここからは即決だけ（11/12 Claude の確認）
  const onlyBuyNow = a.buy_now_price !== null && min >= a.buy_now_price

  const run = async (c: Confirm) => {
    setBusy(true)
    setNotice(null)
    try {
      const res = c.kind === 'bid' ? await placeBid(a.id, c.amount) : await buyNow(a.id)
      setData(res)
      if (res.error) setNotice({ text: auctionErrorMessage(res.error), bad: true })
      else if (c.kind === 'bid') { setAmount(null); setNotice({ text: res.extended ? '入札しました。終了間際のため、終了を5分延ばしました。' : '入札しました。' }) }
      window.dispatchEvent(new Event('ginjiro:ginpay-holds-changed'))
    } catch (err) {
      setNotice({ text: auctionErrorMessage(errorCode(err)), bad: true })
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  return (
    <div className="v2-page">
      <Back onBack={onBack} />
      <div className="ginoku-hero"><AuctionTicket a={a} large /></div>
      <h1 className="ginoku-title">{a.title}</h1>
      <p className="ginoku-rule">お会計から{a.ticket_amount.toLocaleString('ja-JP')}円引き・{a.weekday_only ? '平日のみ' : '曜日を問わず'}・{a.ticket_days}日間有効</p>

      {a.mine === 'won' ? (
        <section className="v2-panel v2-glass ginoku-panel">
          <p className="ginoku-won">落札しました</p>
          <p className="v2-note" style={{ margin: '4px 0 14px' }}>{yen(a.final_price)} を銀Payでお支払い済みです。券はチケットに入っています。</p>
          <button type="button" className="v2-btn v2-btn-gold" onClick={onTickets}>チケットを見る</button>
        </section>
      ) : (
        <section className="v2-panel v2-glass ginoku-panel">
          <p className="v2-label">{isEnded ? (a.status === 'sold' ? '落札価格' : '終了') : a.current_price === null ? '開始価格' : '現在価格'}</p>
          <p className="ginoku-price">{isEnded ? (a.status === 'sold' ? yen(a.final_price) : a.status === 'unsold' ? '落札なし' : '集計中') : yen(a.current_price ?? a.start_price)}</p>
          <dl className="ginoku-facts">
            <div><dt>残り時間</dt><dd className={!isEnded && Date.parse(a.ends_at) - now < 3600_000 ? 'ginoku-left is-hurry' : undefined}>{left ?? '終了'}</dd></div>
            <div><dt>入札</dt><dd>{a.bid_count}件</dd></div>
            <div><dt>即決</dt><dd>{a.buy_now_price === null ? 'なし' : yen(a.buy_now_price)}</dd></div>
          </dl>
          <p className="ginoku-end">{isEnded ? '終了' : '終了予定'} {endLabel(endsAt)}{a.extended && !isEnded ? '（延長あり）' : ''}</p>
          {mine && <p className={`ginoku-mine is-${a.mine}`}>{mine}{a.my_bid !== null && a.mine !== 'lost' ? `（あなたの入札 ${yen(a.my_bid)}）` : ''}</p>}
        </section>
      )}

      {notice && <p className={notice.bad ? 'ginoku-notice is-bad' : 'ginoku-notice'} role="status">{notice.text}</p>}

      {!isEnded && (
        <section className="v2-panel v2-glass ginoku-panel" aria-label="入札">
          {!data.signed_in ? (
            <p className="v2-note" style={{ margin: 0 }}>店頭で本人確認が済むと、銀Payで入札できます。</p>
          ) : walletProblem ? (
            <p className="v2-note" style={{ margin: 0 }}>{auctionErrorMessage(walletProblem)}</p>
          ) : (
            <>
              {onlyBuyNow ? <p className="ginoku-hint">入札が即決価格まで上がったので、ここからは即決だけです。<br />使える銀Pay {yen(available)}</p> : <>
              <p className="v2-label">入札額</p>
              <div className="ginoku-stepper">
                <button type="button" className="v2-round v2-glass" aria-label={`${a.increment.toLocaleString('ja-JP')}円下げる`} disabled={busy || value <= min} onClick={() => setAmount(value - a.increment)}><Minus size={18} /></button>
                <output aria-live="polite">{yen(value)}</output>
                <button type="button" className="v2-round v2-glass" aria-label={`${a.increment.toLocaleString('ja-JP')}円上げる`} disabled={busy || value >= clampBid(Infinity, min, a.buy_now_price, a.increment)} onClick={() => setAmount(value + a.increment)}><Plus size={18} /></button>
              </div>
              <p className="ginoku-hint">最低 {yen(min)}・{a.increment.toLocaleString('ja-JP')}円単位<br />使える銀Pay {yen(available)}</p>
              {short(value) && <p className="ginoku-hint is-bad">銀Payの残高が足りません。店頭でチャージできます。</p>}
              <button type="button" className="v2-btn v2-btn-gold" disabled={busy || !canAct || short(value) || a.mine === 'leading'} onClick={() => setConfirm({ kind: 'bid', amount: value })}>
                {a.mine === 'leading' ? '最高額で入札中です' : `${yen(value)} で入札する`}
              </button>
              </>}
              {a.buy_now_price !== null && (
                <button type="button" className="v2-btn v2-glass ginoku-buy" disabled={busy || !canAct || short(a.buy_now_price)} onClick={() => setConfirm({ kind: 'buy', amount: a.buy_now_price! })}>
                  即決 {yen(a.buy_now_price)} で落札する
                </button>
              )}
            </>
          )}
        </section>
      )}

      {data.bids.length > 0 && (
        <details className="ginoku-bids">
          <summary>入札履歴（{a.bid_count}件）</summary>
          {data.bids.map((b, i) => (
            <div key={`${b.at}-${i}`} className="ginoku-bid">
              <span>{b.bidder}{b.mine ? '（あなた）' : ''}<small>{when(b.at)}</small></span>
              <b>{yen(b.amount)}</b>
            </div>
          ))}
        </details>
      )}

      {confirm && (
        <>
          <div className="v2-sheet-back" onClick={() => !busy && setConfirm(null)} />
          <div className="v2-sheet ginoku-sheet" role="dialog" aria-modal="true" aria-label="確認">
            <div className="v2-grab" />
            <p className="ginoku-sheet-title">{confirm.kind === 'bid' ? `${yen(confirm.amount)} で入札しますか？` : `即決 ${yen(confirm.amount)} で落札しますか？`}</p>
            <p className="v2-note" style={{ margin: '6px 0 4px' }}>
              {confirm.kind === 'bid'
                ? `終了時に最高額でしたら、銀Payから ${yen(confirm.amount)} を引き落とし、券をチケットに入れます。入札は取り消せません。`
                : `すぐに銀Payから ${yen(confirm.amount)} を引き落とし、券をチケットに入れます。`}
            </p>
            <p className="ginoku-hint">使える銀Pay {yen(available)}{confirm.kind === 'buy' && available !== null ? ` → ${yen(available - confirm.amount)}` : ''}</p>
            <div className="ginoku-sheet-actions">
              <button type="button" className="v2-btn v2-btn-gold" disabled={busy} onClick={() => void run(confirm)}>{busy ? '送信しています…' : confirm.kind === 'bid' ? '入札する' : '落札する'}</button>
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
