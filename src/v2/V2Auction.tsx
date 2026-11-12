// 銀二郎オークション【銀オク】（Staging だけ・11/12 慶一郎さん）：お店が出品したガチャ券を、銀Pay で競り落とす。
// 一覧（現在価格・即決・入札数・残り時間）→ 詳細（入札・即決・入札履歴）。入札・即決の前に必ず確かめる。
// 終了時に最高額の方の銀Pay から引き落とし、券はすぐチケットへ（サーバーが締める。画面は結果を読むだけ）
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock, Minus, Plus } from 'lucide-react'
import { buyNow, loadAuction, loadAuctions, placeBid, walletAvailable, type Auction, type AuctionAction, type AuctionList } from '../features/auction/auctionApi'
import { auctionErrorMessage, clampBid, endLabel, mineLabel, timeLeft } from '../features/auction/auctionLogic'
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
/** 残り時間は時計の形（02:14:18）。1日以上は「2日 03:10:00」 */
function clock(endsAt: number, now: number): string {
  const s = Math.max(0, Math.floor((endsAt - now) / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const hms = [h, m, sec].map(x => String(x).padStart(2, '0')).join(':')
  return d > 0 ? `${d}日 ${hms}` : hms
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
  const done = list.filter(a => ended(a, now) && a.status === 'sold')
  const featured = pickFeatured(open)
  const rose = useRose()
  const risen = new Set(list.filter(rose).map(a => a.id))
  const shown = tab === 'open' ? open.filter(a => a !== featured) : tab === 'near' ? open.filter(a => nearEnd(a, now)) : done

  return (
    <div className="v2-page">
      <header className="ginoku-head">
        <h1 className="ginoku-name">銀オク</h1>
        <p className="ginoku-lead">銀Payで入札できる公式オークション</p>
      </header>
      {data === null && <p className="v2-note">読み込んでいます…</p>}
      {data === 'error' && <p className="v2-note">表示できませんでした。通信を確かめてください。</p>}
      {data && data !== 'error' && (
        <>
          {featured
            ? <FeaturedCard a={featured} now={now} rose={risen.has(featured.id)} onOpen={onOpen} />
            : <p className="v2-note ginoku-empty">いま開催中のオークションはありません。次の出品をお待ちください。</p>}
          <div className="ginoku-tabs" role="tablist" aria-label="表示する出品">
            {TABS.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : undefined} onClick={() => setTab(t.id)}>{t.label}</button>)}
          </div>
          {shown.length === 0
            ? <p className="v2-note ginoku-empty">{tab === 'done' ? 'まだ落札された出品はありません。' : tab === 'near' ? '24時間以内に終わる出品はありません。' : 'ほかの出品はありません。'}</p>
            : <div className="ginoku-cards">{shown.map(a => <AuctionRow key={a.id} a={a} now={now} rose={risen.has(a.id)} onOpen={onOpen} />)}</div>}
          <p className="v2-note ginoku-foot">お支払いは銀Payのみです。終了時に一番高く入札した方の銀Payから引き落とし、券はチケットに入ります。</p>
        </>
      )}
    </div>
  )
}

/** 目玉の1件：左に大きな券、右に「現在の入札額」「残り」「入札する」 */
function FeaturedCard({ a, now, rose, onOpen }: { a: Auction; now: number; rose: boolean; onOpen: (id: string) => void }) {
  const mine = mineLabel(a.mine)
  return (
    <section className="ginoku-feature v2-glass" aria-label={a.title}>
      <button type="button" className="ginoku-feature-art" onClick={() => onOpen(a.id)} aria-label={`${a.title}を見る`}><AuctionTicket a={a} large /></button>
      <div className="ginoku-feature-side">
        <p className="ginoku-k">{a.current_price === null ? '開始価格' : '現在の入札額'}</p>
        <Pay n={a.current_price ?? a.start_price} className={rose ? 'is-big is-up' : 'is-big'} />
        <p className="ginoku-left"><Clock size={16} />残り<b>{clock(Date.parse(a.ends_at), now)}</b></p>
        {mine && <p className={`ginoku-mine is-${a.mine}`}>{mine}</p>}
        <button type="button" className="ginoku-go" onClick={() => onOpen(a.id)}>入札する</button>
      </div>
    </section>
  )
}

function AuctionRow({ a, now, rose = false, onOpen }: { a: Auction; now: number; rose?: boolean; onOpen: (id: string) => void }) {
  const isEnded = ended(a, now)
  const mine = mineLabel(a.mine)
  return (
    <button type="button" className="ginoku-card v2-glass" onClick={() => onOpen(a.id)}>
      <span className="ginoku-card-art"><AuctionTicket a={a} /></span>
      <span className="ginoku-card-main">
        <span className="ginoku-card-title">{a.title.replace(/券$/, '')}</span>
        <span className="ginoku-card-nums">
          <span>
            <span className="ginoku-k">{isEnded ? '落札額' : a.current_price === null ? '開始価格' : '現在の入札額'}</span>
            <Pay n={isEnded ? a.final_price : a.current_price ?? a.start_price} className={rose ? 'is-up' : undefined} />
          </span>
          <span className="ginoku-card-time">
            <span className="ginoku-k"><Clock size={13} />{isEnded ? '終了' : '残り'}</span>
            <b>{isEnded ? endLabel(Date.parse(a.ends_at)).replace(/（.）/, ' ') : clock(Date.parse(a.ends_at), now)}</b>
          </span>
        </span>
        {mine && <span className={`ginoku-mine is-${a.mine}`}>{mine}</span>}
      </span>
      <ChevronRight size={20} className="ginoku-card-go" />
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
          <p className="v2-note" style={{ margin: '4px 0 14px' }}>{payText(a.final_price)} を銀Payでお支払い済みです。券はチケットに入っています。</p>
          <button type="button" className="v2-btn v2-btn-gold" onClick={onTickets}>チケットを見る</button>
        </section>
      ) : (
        <section className="v2-panel v2-glass ginoku-panel">
          <p className="v2-label">{isEnded ? (a.status === 'sold' ? '落札価格' : '終了') : a.current_price === null ? '開始価格' : '現在の入札額'}</p>
          <p className="ginoku-price">{isEnded && a.status !== 'sold' ? (a.status === 'unsold' ? '落札なし' : '集計中') : <Pay n={isEnded ? a.final_price : a.current_price ?? a.start_price} className="is-big" />}</p>
          <dl className="ginoku-facts">
            <div><dt>残り時間</dt><dd className={!isEnded && Date.parse(a.ends_at) - now < 3600_000 ? 'ginoku-left is-hurry' : undefined}>{left ? clock(endsAt, now) : '終了'}</dd></div>
            <div><dt>入札</dt><dd>{a.bid_count}件</dd></div>
            <div><dt>即決</dt><dd>{a.buy_now_price === null ? 'なし' : payText(a.buy_now_price)}</dd></div>
          </dl>
          <p className="ginoku-end">{isEnded ? '終了' : '終了予定'} {endLabel(endsAt)}{a.extended && !isEnded ? '（延長あり）' : ''}</p>
          {mine && <p className={`ginoku-mine is-${a.mine}`}>{mine}{a.my_bid !== null && a.mine !== 'lost' ? `（あなたの入札 ${payText(a.my_bid)}）` : ''}</p>}
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
              {onlyBuyNow ? <p className="ginoku-hint">入札が即決価格まで上がったので、ここからは即決だけです。<br />使える銀Pay {(available ?? 0).toLocaleString('ja-JP')}</p> : <>
              <p className="v2-label">入札額</p>
              <div className="ginoku-stepper">
                <button type="button" className="v2-round v2-glass" aria-label={`${a.increment.toLocaleString('ja-JP')}円下げる`} disabled={busy || value <= min} onClick={() => setAmount(value - a.increment)}><Minus size={18} /></button>
                <output aria-live="polite"><Pay n={value} className="is-big" /></output>
                <button type="button" className="v2-round v2-glass" aria-label={`${a.increment.toLocaleString('ja-JP')}円上げる`} disabled={busy || value >= clampBid(Infinity, min, a.buy_now_price, a.increment)} onClick={() => setAmount(value + a.increment)}><Plus size={18} /></button>
              </div>
              <p className="ginoku-hint">最低 {payText(min)}・{a.increment.toLocaleString('ja-JP')}銀Pay単位<br />使える銀Pay {(available ?? 0).toLocaleString('ja-JP')}</p>
              {short(value) && <p className="ginoku-hint is-bad">銀Payの残高が足りません。店頭でチャージできます。</p>}
              <button type="button" className="v2-btn v2-btn-gold" disabled={busy || !canAct || short(value) || a.mine === 'leading'} onClick={() => setConfirm({ kind: 'bid', amount: value })}>
                {a.mine === 'leading' ? '最高額で入札中です' : `${payText(value)} で入札する`}
              </button>
              </>}
              {a.buy_now_price !== null && (
                <button type="button" className="v2-btn v2-glass ginoku-buy" disabled={busy || !canAct || short(a.buy_now_price)} onClick={() => setConfirm({ kind: 'buy', amount: a.buy_now_price! })}>
                  即決 {payText(a.buy_now_price)} で落札する
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
              <b>{payText(b.amount)}</b>
            </div>
          ))}
        </details>
      )}

      {confirm && (
        <>
          <div className="v2-sheet-back" onClick={() => !busy && setConfirm(null)} />
          <div className="v2-sheet ginoku-sheet" role="dialog" aria-modal="true" aria-label="確認">
            <div className="v2-grab" />
            <p className="ginoku-sheet-title">{confirm.kind === 'bid' ? `${payText(confirm.amount)} で入札しますか？` : `即決 ${payText(confirm.amount)} で落札しますか？`}</p>
            <p className="v2-note" style={{ margin: '6px 0 4px' }}>
              {confirm.kind === 'bid'
                ? `終了時に最高額でしたら、銀Payから ${payText(confirm.amount)} を引き落とし、券をチケットに入れます。入札は取り消せません。`
                : `すぐに銀Payから ${payText(confirm.amount)} を引き落とし、券をチケットに入れます。`}
            </p>
            <p className="ginoku-hint">使える銀Pay {(available ?? 0).toLocaleString('ja-JP')}{confirm.kind === 'buy' && available !== null ? ` → ${payText(available - confirm.amount)}` : ''}</p>
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
