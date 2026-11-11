// 店舗端末：会員QR → 来店チェックイン → そのままお会計（銀Pay・現金・カードほか）。
//   今日の予約があれば予約から会計（メニュー・担当・料金を引き継ぎ、確定で予約は完了）、無ければ顧客を選んだ店頭会計。
//   会員QRでお客様が選んだ券は、会計の中で最初から選んでおく（確定のときに使用済みになる）。
import { useEffect, useRef, useState } from 'react'
import { Checkout } from './booking/Checkout'
import { createStaffCheckoutApi, PAYMENT_LABEL, type Sale } from '../utils/checkoutApi'
import { createStaffCustomerApi } from '../utils/customerApi'
import { yen } from '../utils/bookingApi'
import { callRpc, callStaffRpc, getStaffToken, rpcErrorMessage } from '../utils/staffSession'
import { getStoredValue } from '../utils/storage'
import { readCheckoutAttempt, startNextCheckout } from '../utils/checkoutAttempt'
import { fetchTodayPartyOrNull, type PartyEntry } from '../utils/partyCheckIn'

const UI = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif'

/** walkIn：予約のない方の会計（「もう1件お会計する」）。会員ご本人の来店・いつものメニューに入れない（11/11 店舗端末点検） */
type Target = { reservationId: string | null; clientId: string; who: PartyEntry | null; walkIn: boolean }
/** 受付済みでまだ会計していない予約 */
const UNPAID = ['checked_in', 'in_service', 'awaiting_payment']
// 店舗端末の「担当者」（AdminScreen が端末に保存する）。会計の記録には確定した時点の名前を残す
const readActor = () => getStoredValue<string>('ginjiro_staff_name', '')

export function MemberCheckout({ userId, staffName, ticketIds, onPaid }: {
  userId: string
  /** 店舗端末の「担当者」。会計の記録に残る操作者 */
  staffName: string
  /** お客様が会員QRで選んだ券 */
  ticketIds: readonly string[]
  onPaid: (sale: Sale) => void
}) {
  const [target, setTarget] = useState<Target | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState<Sale | null>(null)
  const [party, setParty] = useState<PartyEntry[]>([])
  /** 今日のご予約を読み直せなかった（次の方がいるか分からない） */
  const [partyError, setPartyError] = useState(false)
  /** 会計したのはどなたの予約か（お連れ様なら、ご本人のいつものメニュー・来店の記録には入れない） */
  const [paidWho, setPaidWho] = useState<PartyEntry | null>(null)
  /** 会計したのが予約のない方か */
  const [paidWalkIn, setPaidWalkIn] = useState(false)
  // お会計で選んだメニュー（いつものメニューに登録する候補・11/6）
  const [pickedMenu, setPickedMenu] = useState<string | null>(null)
  const opening = useRef(false)
  const [api] = useState(() => createStaffCheckoutApi(readActor))
  const [customers] = useState(() => createStaffCustomerApi(readActor))

  /** again：同じお客様の2件目（お子様・お連れ様など）。予約は1件目で会計済みなので、予約なしの会計にする */
  async function open(again = false) {
    if (opening.current) return
    if (!staffName.trim()) { setError('上の「担当者」を選んでからお会計に進んでください。'); return }
    opening.current = true
    setLoading(true); setError(null)
    try {
      const r = await callStaffRpc<{ client_id?: string; reservation_id?: string | null; error?: string }>('staff_client_for_member', { p_user_id: userId })
      if (!r.client_id) { setError('このお客様の顧客台帳が見つかりません。予約台帳の「店頭会計」から顧客を選んで会計してください。'); return }
      // 前の会計が確定していれば区切る（同じお客様の2件目が「前回の会計結果を確認」になって払えなかった・10/27）
      const prev = readCheckoutAttempt()
      if (prev?.result) await startNextCheckout(prev.input.idempotency_key)
      // 今日の予約がもう会計済みなら（QR を読み直した・2件目）、予約なしの会計にする
      let reservationId = again ? null : r.reservation_id ?? null
      if (reservationId && (await api.context(reservationId, null)).paid_sale_id) reservationId = null
      // 2名様以上：受付済みでまだ会計していない今日のご予約（ご本人が先）。2件目もメニュー・担当が入った会計にする（11/10 慶一郎さん「選び直すのは面倒」）
      // 今日のご予約が読めないとき：前に読めた一覧を使う。2件目なのに一つも分からなければ、予約のない会計を開かずに止める
      const fresh = await fetchTodayPartyOrNull(userId)
      setPartyError(!fresh)
      if (!fresh && again && !party.length) { setError('今日のご予約を確かめられませんでした。通信を確かめて、もう一度押してください。'); return }
      const today = fresh ?? party
      const waiting = today.filter(p => UNPAID.includes(p.status)).sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.starts_at.localeCompare(b.starts_at))
      if (!reservationId) reservationId = waiting[0]?.id ?? null
      setParty(today)
      setTarget({ reservationId, clientId: r.client_id, who: today.find(p => p.id === reservationId) ?? null, walkIn: again && !reservationId })
    } catch (err) {
      setError(rpcErrorMessage(err))
    } finally {
      opening.current = false
      setLoading(false)
    }
  }

  // 会員QRを読んだら、そのまま金額を入れる会計を出す（10/26 慶一郎さん：担当で料金が変わるので、店で金額を入れて確定）
  // 開いたときに1回だけ顧客台帳を読む（担当者を選び直したら、下の「お会計に進む」から）
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { if (staffName.trim()) void open() }, [])

  /** まだ受付していないお連れ様の予約を受付して、その方の会計へ（11/11 店舗端末点検：予約のない会計にされていた） */
  async function checkInAndPay(p: PartyEntry) {
    if (loading) return
    setLoading(true); setError(null)
    try {
      await callStaffRpc('staff_check_in_party', { p_user_id: userId, p_reservation_ids: [p.id], p_staff_name: staffName || '店舗端末' })
    } catch (err) { setError(rpcErrorMessage(err)); setLoading(false); return }
    setLoading(false)
    setPaid(null); setPickedMenu(null); setPaidWho(null); setPaidWalkIn(false)
    void open(true)
  }

  if (paid) {
    // 2名様以上：受付済みでまだ会計していない方がいれば、その方の会計へ（メニュー・担当は予約から）
    const next = party.filter(p => UNPAID.includes(p.status) && p.id !== paidWho?.id).sort((a, b) => Number(b.is_owner) - Number(a.is_owner))[0]
    /** ご来店のグループ（受付した方。来ていない方・取消は入れない） */
    const group = party.filter(p => [...UNPAID, 'completed'].includes(p.status))
    /** まだ受付していない今日のお連れ様の予約 */
    const notIn = party.filter(p => !p.is_owner && p.status === 'confirmed')
    return (
      <div data-guide="paid" style={{ textAlign: 'left', fontFamily: UI }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: '#2F7D5B', margin: '0 0 4px' }}>✓ お会計が終わりました</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 15, color: '#6B6B66' }}>お会計済み（{PAYMENT_LABEL[paid.payment_method ?? ''] ?? paid.payment_method}）</span>
          <span style={{ fontFamily: '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN",serif', fontSize: 30, fontWeight: 700, color: '#1B1B1A', fontVariantNumeric: 'tabular-nums' }}>{yen(paid.total)}</span>
        </div>
        {error && <p style={{ marginTop: 8, fontSize: 13, color: '#b23a3a' }}>{error}</p>}
        {!(paidWho && !paidWho.is_owner) && !paidWalkIn && <UsualMenuRow userId={userId} staffName={staffName} picked={pickedMenu} pickedName={paidWho?.menu ?? null} loadMenus={async () => (await api.catalog()).service_menus.filter(m => m.kind !== 'option')} />}
        {/* グループ（2名様以上）：全員のお会計が済んだら、グループ全体の完了を出す（11/10 慶一郎さん） */}
        {!next && group.length > 1 && group.every(p => p.status === 'completed') && (
          <p style={{ margin: '14px 0 0', padding: '12px 14px', borderRadius: 12, background: 'rgba(47,125,91,0.07)', color: '#2F7D5B', fontSize: 15, fontWeight: 600 }}>
            ✓ {group.length}名様のお会計がすべて終わりました
          </p>
        )}
        {/* 今日のご予約を読み直せず、次の方がいるか分からない：予約のない会計へ進ませず、確かめ直してもらう（11/10 Codex 検査 高） */}
        {partyError && !next ? (
          <div style={{ marginTop: 14 }}>
            <p style={{ margin: '0 0 8px', fontSize: 14, color: '#6B6B66', lineHeight: 1.6 }}>通信の具合で、ほかの方のご予約を確かめられませんでした。</p>
            <button type="button" onClick={() => { void fetchTodayPartyOrNull(userId).then(p => { setPartyError(!p); if (p) setParty(p) }) }}
              style={{ width: '100%', minHeight: 50, borderRadius: 12, background: '#161513', border: 'none', color: '#F2E6CC', fontFamily: UI, fontSize: 16, fontWeight: 600, cursor: 'pointer' }}>
              もう一度確かめる
            </button>
          </div>
        ) : <>{!next && notIn.map(p => (
          <button key={p.id} type="button" disabled={loading} onClick={() => void checkInAndPay(p)}
            style={{ width: '100%', marginTop: 14, minHeight: 54, borderRadius: 14, background: '#161513', border: 'none', color: '#F2E6CC', fontFamily: UI, fontSize: 17, fontWeight: 600, cursor: 'pointer' }}>
            {p.name}様（お連れ様）を受付して会計{p.menu ? `（${p.menu}）` : ''}
          </button>
        ))}<button type="button" disabled={loading} onClick={() => { setPaid(null); setPickedMenu(null); setPaidWho(null); setPaidWalkIn(false); void open(true) }}
          style={next
            ? { width: '100%', marginTop: 14, minHeight: 54, borderRadius: 14, background: '#161513', border: 'none', color: '#F2E6CC', fontFamily: UI, fontSize: 17, fontWeight: 600, cursor: 'pointer' }
            : { width: '100%', marginTop: 12, minHeight: 46, borderRadius: 10, background: '#ffffff', border: '1px solid #D9D9D4', color: '#1B1B1A', fontFamily: UI, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
          {next ? `次：${next.name}様のお会計${next.menu ? `（${next.menu}）` : ''}` : 'もう1件お会計する（予約のない方）'}
        </button></>}
      </div>
    )
  }

  if (target) {
    // 誰の分かの見出し（お連れ様・予約のない方）は Checkout の一番上に出す（予約台帳から開いた会計にも出るように）
    return (
      <Checkout
        quick
        api={api}
        customers={customers}
        reservationId={target.reservationId}
        clientId={target.clientId}
        initialTicketIds={ticketIds}
        ensureActor={() => !!readActor().trim()}
        onClose={() => setTarget(null)}
        notOwner={target.walkIn}
        onDone={sale => { setPaidWho(target.who); setPaidWalkIn(target.walkIn); setTarget(null); setPaid(sale); onPaid(sale); void fetchTodayPartyOrNull(userId).then(p => { setPartyError(!p); if (p) setParty(p) }) }}
        // お会計で選んだメニューを今日のメニューとして記録する（いつものメニュー・来店の記録に使う。失敗しても会計は続ける）
        onMenuPicked={code => { setPickedMenu(code); if (target.walkIn || (target.who && !target.who.is_owner)) return; void callStaffRpc('staff_set_visit_menu', { p_user_id: userId, p_menu_code: code, p_staff_name: staffName || null }).catch(() => {}) }}
      />
    )
  }

  return (
    <>
      <button
        type="button"
        data-guide="go-checkout"
        onClick={() => void open()}
        disabled={loading}
        style={{
          width: '100%', minHeight: 52, borderRadius: 12,
          background: '#1B1B1A', border: 'none',
          color: '#ffffff', fontFamily: UI, fontSize: 17, fontWeight: 600,
          cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? '準備しています…' : 'お会計に進む'}
        <span style={{ display: 'block', fontSize: 12, fontWeight: 400, color: 'rgba(255,255,255,0.72)', marginTop: 2 }}>
          銀Pay・現金・カード・QR
        </span>
      </button>
      {error && <p role="alert" style={{ marginTop: 8, fontSize: 13, color: '#b23a3a', textAlign: 'left' }}>{error}</p>}
    </>
  )
}

/** 会計のあと：お客様の「いつものメニュー」を登録する（11/6 慶一郎さん「次から楽じゃない？」）。
 *  会計でメニューを選んでいればそれを出す（押すだけ）。任意金額のときは一覧から選ぶ。登録は会員の記録に残り、お客様のアプリの「いつもの」に出る */
function UsualMenuRow({ userId, staffName, picked, pickedName, loadMenus }: { userId: string; staffName: string; picked: string | null; pickedName?: string | null; loadMenus: () => Promise<{ id: string; name: string }[]> }) {
  const [menus, setMenus] = useState<{ id: string; name: string }[] | null>(null)
  const [code, setCode] = useState<string | null>(picked)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // 予約のメニューで会計したとき（メニューを選び直していない）は、そのメニューを最初から選んでおく（11/10 慶一郎さんの確認）
  useEffect(() => { let live = true; void loadMenus().then(m => { if (!live) return; setMenus(m); if (!picked && pickedName) setCode(c => c ?? m.find(x => x.name === pickedName)?.id ?? null) }).catch(() => { if (live) setMenus([]) }); return () => { live = false } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const name = menus?.find(m => m.id === code)?.name
  const save = async () => {
    if (!code || state === 'saving') return
    setState('saving')
    try {
      // サーバーの引数は p_token（11/11 店舗端末点検：p_staff で送っていて毎回失敗していた）
      const r = await callRpc<{ ok?: boolean; error?: string }>('staff_set_usual_menu', { p_token: getStaffToken(), p_user_id: userId, p_code: code, p_staff_name: staffName || null })
      setState(r.ok ? 'saved' : 'error')
    } catch { setState('error') }
  }
  if (state === 'saved') return <p data-guide="usual-saved" style={{ marginTop: 12, fontSize: 13, color: '#246b52' }}>いつものメニューを「{name ?? code}」に登録しました。</p>
  return (
    <div data-guide="usual-menu" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(36,107,82,0.2)' }}>
      <p style={{ fontSize: 12, color: '#5b625e', marginBottom: 6 }}>お客様のいつものメニュー（次からアプリの「いつもの」で予約できます）</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={code ?? ''} onChange={e => { setCode(e.target.value || null); setState('idle') }} aria-label="いつものメニュー"
          style={{ flex: 1, minWidth: 0, minHeight: 44, borderRadius: 10, border: '1px solid rgba(0,0,0,0.15)', background: '#fff', padding: '0 10px', fontSize: 15, color: '#1c1f1d' }}>
          <option value="">{menus ? 'メニューを選ぶ' : '読み込んでいます…'}</option>
          {(menus ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button type="button" disabled={!code || state === 'saving'} onClick={() => void save()}
          style={{ flex: 'none', minHeight: 44, padding: '0 16px', borderRadius: 10, border: 'none', background: code ? '#246b52' : 'rgba(0,0,0,0.12)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: code ? 'pointer' : 'default' }}>
          {state === 'saving' ? '登録中…' : '登録する'}
        </button>
      </div>
      {state === 'error' && <p style={{ marginTop: 6, fontSize: 12, color: '#b23a3a' }}>登録できませんでした。もう一度お試しください。</p>}
    </div>
  )
}
