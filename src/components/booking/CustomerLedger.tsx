import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { getJapanDateString } from '../../utils/dateUtils'
import { rpcErrorMessage } from '../../utils/staffSession'
import { jstDateLabel, jstTime, yen, SOURCE_LABEL, STATUS_LABEL, type Reservation } from '../../utils/bookingApi'
import {
  customerErrorMessage, matchText, type ClientCandidate, type ClientLedger, type CustomerApi, type CustomerResult,
} from '../../utils/customerApi'
import type { GinpayClientApi } from '../../utils/ginpayApi'
import { GinpayPanel } from '../ginpay/GinpayPanel'
import { Field, PrimaryButton, SecondaryButton } from './ledgerUi'
import { C, SANS, inputStyle, linkStyle } from './ledgerTheme'

// 顧客台帳。予約台帳・顧客一覧のどちらから開いても同じ画面・同じデータ。顧客＝銀二郎を利用する一人の人物で、App 会員でなくても同じ台帳を表示する。
// App 会員の顧客だけ App 連携・クーポンを追加表示する。同じ人物の顧客が2つある場合は、人が候補を見て統合する（解除できる）。

/** 情報の区切り（全角スペース） */
const GAP = '　'
const TICKET_LABEL: Record<string, string> = { coupon: 'クーポン', discount: '割引券', otoku: '漢トク券', 'cut-ticket': 'カット券' }
const VIA_LABEL: Record<string, string> = { app: 'App', hotpepper: 'HOT PEPPER', phone: '電話', staff: '店舗入力' }

export type LedgerTarget = { reservationId: string } | { clientId: string }

export function CustomerLedger({ api, ginpayApi, target, backLabel = '予約台帳に戻る', ensureActor, onClose, onChanged }: {
  api: CustomerApi
  ginpayApi?: GinpayClientApi
  /** 予約から開く（その予約の顧客）／顧客一覧から開く */
  target: LedgerTarget
  backLabel?: string
  ensureActor: () => boolean
  onClose: () => void
  /** 統合・編集などで呼び出し元の表示が変わったとき */
  onChanged: () => void
}) {
  const [data, setData] = useState<ClientLedger | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reservationId = 'reservationId' in target ? target.reservationId : null
  const [clientId, setClientId] = useState('clientId' in target ? target.clientId : null)

  const load = useCallback(async () => {
    try {
      const d = reservationId ? await api.open(reservationId) : await api.ledger(clientId!)
      setData(d); setError(null)
      // 統合で別の顧客にまとまったときは、まとまった先の顧客を開き続ける
      if (!reservationId && d.client.id !== clientId) setClientId(d.client.id)
    } catch (err) { setError(rpcErrorMessage(err, '顧客台帳を読み込めませんでした。')) }
  }, [api, reservationId, clientId])
  useEffect(() => { void load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect

  return (
    <div role="dialog" aria-modal="true" aria-label="顧客台帳" style={{ position: 'fixed', inset: 0, zIndex: 900, background: C.bg, color: C.text, fontFamily: SANS, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 16px', borderBottom: `1px solid ${C.line}` }}>
        <button type="button" onClick={onClose} style={{ ...linkStyle, textDecoration: 'none', color: C.text, fontSize: 15 }}>‹ {backLabel}</button>
        <span style={{ fontSize: 13, color: C.mute }}>顧客台帳</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 20px 48px' }}>
          {error && <p style={{ color: C.danger, fontSize: 14 }}>{error}</p>}
          {!data ? (!error && <p style={{ color: C.sub, fontSize: 14 }}>読み込み中…</p>)
            : <ClientView key={data.client.id} api={api} ginpayApi={ginpayApi} data={data} ensureActor={ensureActor} reload={load} onChanged={onChanged} />}
        </div>
      </div>
    </div>
  )
}

function ClientView({ api, ginpayApi, data, ensureActor, reload, onChanged }: {
  api: CustomerApi; ginpayApi?: GinpayClientApi; data: ClientLedger; ensureActor: () => boolean; reload: () => Promise<void>; onChanged: () => void
}) {
  const { client: c, stats, app } = data
  const today = getJapanDateString()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [edit, setEdit] = useState({ name: c.name, kana: c.kana ?? '', phone: c.phones[c.phones.length - 1] ?? '' })
  const r = data.reservation
  const avg = stats.sales_count ? Math.round(stats.total_sales / stats.sales_count) : null

  async function act(fn: () => Promise<CustomerResult>, after?: () => void) {
    if (!ensureActor()) return false
    setBusy(true); setMsg(null)
    try {
      const res = await fn()
      if ('error' in res) { setMsg(customerErrorMessage(res.error)); return false }
      after?.()
      await reload()
      return true
    } catch (err) { setMsg(rpcErrorMessage(err)); return false } finally { setBusy(false) }
  }

  const meta = [
    app ? 'App連携済み' : 'App未連携',
    c.phones.length ? c.phones.join('・') : c.phone_last4 ? `電話下4桁 ${c.phone_last4}` : null,
    `${VIA_LABEL[c.created_via]}から登録 ${fmtDate(c.created_at)}`,
  ].filter(Boolean)

  return (
    <>
      {/* 基本情報（氏名・フリガナ・電話番号は App 会員かどうかに関係なく編集できる。App 会員の情報は編集しない） */}
      {editing ? (
        <div style={{ maxWidth: 520 }}>
          <Field label="氏名"><input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} maxLength={60} style={inputStyle} autoComplete="off" /></Field>
          <Field label="フリガナ（任意）"><input value={edit.kana} onChange={e => setEdit({ ...edit, kana: e.target.value })} maxLength={60} style={inputStyle} autoComplete="off" /></Field>
          <Field label="電話番号（任意）"><input value={edit.phone} onChange={e => setEdit({ ...edit, phone: e.target.value })} inputMode="tel" maxLength={20} style={inputStyle} autoComplete="off" /></Field>
          <p style={{ marginTop: 8, fontSize: 13, color: C.mute, lineHeight: 1.6 }}>
            電話番号を変えても、同じ番号の顧客と自動ではまとめません。{app ? 'App 会員の登録情報は変わりません。' : ''}
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <SecondaryButton onClick={() => { setEditing(false); setEdit({ name: c.name, kana: c.kana ?? '', phone: c.phones[c.phones.length - 1] ?? '' }) }} disabled={busy}>やめる</SecondaryButton>
            <PrimaryButton onClick={() => void act(() => api.update(c.id, edit), () => { setEditing(false); onChanged() })} disabled={busy || !edit.name.trim()} style={{ flex: 2 }}>
              {busy ? '保存中…' : '保存'}
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.3 }}>{c.name}</h1>
            {c.kana && <span style={{ fontSize: 14, color: C.sub }}>{c.kana}</span>}
            <button type="button" onClick={() => setEditing(true)} style={{ ...linkStyle, minHeight: 32, marginLeft: 'auto' }}>編集</button>
          </div>
          <p style={{ marginTop: 6, fontSize: 14, color: C.sub, lineHeight: 1.7 }}>
            {meta.map((m, i) => <span key={i} style={{ whiteSpace: 'nowrap' }}>{i > 0 ? GAP : ''}{m}</span>)}
          </p>
        </>
      )}

      {/* 来店の数字 */}
      <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}` }}>
        <Stat label="来店回数" value={`${stats.visit_count}回`} />
        <Stat label="前回来店" value={stats.last_visit ? jstDateLabel(stats.last_visit) : '—'} sub={stats.last_visit ? daysAgo(stats.last_visit, today) : undefined} />
        <Stat label="平均来店周期" value={stats.avg_interval_days !== null ? `${stats.avg_interval_days}日` : '—'} sub={stats.avg_interval_days === null ? '来店2回目から' : undefined} />
        <Stat label="累計売上" value={yen(stats.total_sales)} sub={avg !== null ? `会計 ${stats.sales_count}回・平均 ${yen(avg)}` : '会計の記録なし'} />
      </div>

      <dl style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '84px 1fr', rowGap: 8, fontSize: 14 }}>
        <dt style={{ color: C.sub }}>担当</dt>
        <dd>{data.stylists.length === 0 ? <span style={{ color: C.mute }}>記録なし</span>
          : data.stylists.map((s, i) => <span key={s.name}>{i > 0 ? GAP : ''}{s.name} {s.count}回</span>)}</dd>
        {data.item_usage.length > 0 && (<>
          <dt style={{ color: C.sub }}>よく利用</dt>
          <dd>{data.item_usage.slice(0, 5).map((u, i) => <span key={u.name} style={{ whiteSpace: 'nowrap' }}>{i > 0 ? GAP : ''}{u.name} {u.count}{u.category === 'retail' ? '個' : '回'}</span>)}</dd>
        </>)}
        <dt style={{ color: C.sub }}>次回予約</dt>
        <dd>{data.next_reservation ? resLine(data.next_reservation) : <span style={{ color: C.mute }}>なし</span>}</dd>
      </dl>

      <div style={{ marginTop: 28, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', columnGap: 40, rowGap: 8, alignItems: 'start' }}>
        <div>
          {ginpayApi && <GinpayPanel clientId={c.id} api={ginpayApi} ensureActor={ensureActor} />}
          <Block title="予約履歴" count={data.reservations.length}>
            {data.reservations.length === 0 ? <Empty>予約はありません</Empty> : data.reservations.map(x => (
              <Row key={x.id} highlight={x.id === r?.id}
                left={<>{jstDateLabel(getJapanDateString(new Date(x.starts_at)))} {jstTime(x.starts_at)}</>}
                main={x.items.map(i => i.name).join('・')}
                right={<>{x.staff_name}{x.nominated ? '' : '（フリー）'}</>}
                sub={`${STATUS_LABEL[x.status]}・${SOURCE_LABEL[x.source]}${x.external_ref ? ` ${x.external_ref}` : ''}`} />
            ))}
          </Block>
          <Block title="施術履歴" count={data.treatments.length}>
            {data.treatments.length === 0 ? <Empty>会計の記録はありません</Empty> : data.treatments.map(t => (
              <Row key={t.id}
                left={jstDateLabel(t.date)}
                main={t.items.map(i => `${i.name}${i.quantity > 1 ? `×${i.quantity}` : ''}`).join('・') || '—'}
                right={yen(t.total)}
                sub={t.stylist_name ? `担当 ${t.stylist_name}` : undefined} />
            ))}
          </Block>
        </div>
        <div>
          {app && (
            <Block title="App">
              {app.members.map((m, i) => (
                <Row key={i} left="App会員" main={m.name} right={m.phone_last4 ? `下4桁 ${m.phone_last4}` : ''} sub={`登録 ${fmtDate(m.created_at)}`} />
              ))}
              <p style={{ fontSize: 13, fontWeight: 600, color: C.sub, margin: '16px 0 0' }}>保有クーポン{app.coupons.length ? <span style={{ fontWeight: 400, color: C.mute }}>{GAP}{app.coupons.length}</span> : null}</p>
              {app.coupons.length === 0 ? <Empty>ありません</Empty> : app.coupons.map(k => (
                <Row key={k.id} left={TICKET_LABEL[k.type] ?? 'クーポン'} main={k.title} right={k.amount ? yen(k.amount) : ''}
                  sub={k.expires_at ? `${fmtDate(k.expires_at)}まで` : '期限なし'} />
              ))}
            </Block>
          )}
          <Block title="メモ" count={data.notes.length}>
            <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={2000} rows={2} placeholder="接客で覚えておくこと"
              aria-label="メモ" style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', marginTop: 4 }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <SmallButton disabled={busy || !note.trim()} onClick={() => void act(() => api.addNote(c.id, note.trim()), () => setNote(''))}>メモを追加</SmallButton>
            </div>
            {data.notes.map(n => (
              <div key={n.id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.line}` }}>
                <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{n.note}</p>
                <p style={{ marginTop: 2, fontSize: 12, color: C.mute }}>{fmtDate(n.created_at)}{GAP}{n.created_by}</p>
              </div>
            ))}
          </Block>
        </div>
      </div>

      {msg && <p style={{ color: C.danger, fontSize: 14, marginTop: 8 }}>{msg}</p>}

      <MergeSection api={api} data={data} busy={busy}
        onMerge={(sourceId) => act(() => api.merge(c.id, sourceId), onChanged)}
        onUnmerge={(eventId) => act(() => api.unmerge(eventId), onChanged)} />
    </>
  )
}

// ── 同じ人物の顧客の統合（人が確認してから。解除できる） ─────────────────────────

function MergeSection({ api, data, busy, onMerge, onUnmerge }: {
  api: CustomerApi; data: ClientLedger; busy: boolean
  onMerge: (sourceId: string) => Promise<boolean>; onUnmerge: (eventId: number) => Promise<boolean>
}) {
  const c = data.client
  const [query, setQuery] = useState('')
  const [cands, setCands] = useState<ClientCandidate[] | null>(null)
  const [picked, setPicked] = useState<ClientCandidate | null>(null)
  const [undoing, setUndoing] = useState<number | null>(null)
  // 氏名・電話番号を編集したら候補も選び直す
  const identityKey = `${c.name}|${c.phones.join(',')}`

  useEffect(() => {
    let alive = true
    const t = window.setTimeout(() => {
      api.candidates(c.id, query.trim()).then(x => { if (alive) setCands(x) }).catch(() => { if (alive) setCands([]) })
    }, query ? 250 : 0)
    return () => { alive = false; window.clearTimeout(t) }
  }, [api, c.id, query, identityKey])

  return (
    <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', columnGap: 40, rowGap: 8, alignItems: 'start' }}>
      <Block title="同じ人かもしれない顧客">
        {picked ? (
          <div style={{ paddingTop: 8 }}>
            <p style={{ fontSize: 15, lineHeight: 1.7 }}>
              {picked.name}（{[picked.phone ?? (picked.phone_last4 ? `下4桁 ${picked.phone_last4}` : null), `来店${picked.visit_count}回`, picked.app_linked ? 'App連携済み' : null].filter(Boolean).join('・')}）を、この顧客（{c.name}）に統合します。予約・施術・売上・メモ{picked.app_linked ? '・App連携' : ''}がこの顧客に移ります。
            </p>
            <p style={{ fontSize: 13, color: C.sub, marginTop: 4 }}>{matchText(picked)}。同じ人物であることを確認してください。誤りは後から解除できます。</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <SecondaryButton onClick={() => setPicked(null)} disabled={busy}>やめる</SecondaryButton>
              <PrimaryButton onClick={() => void onMerge(picked.id).then(done => { if (done) setPicked(null) })} disabled={busy} style={{ flex: 2 }}>
                {busy ? '統合中…' : '統合する'}
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="名前・電話番号で探す" aria-label="顧客を探す"
              style={{ ...inputStyle, marginTop: 8 }} autoComplete="off" />
            <p style={{ fontSize: 13, color: C.mute, margin: '8px 0 0' }}>{query ? '検索結果' : '電話番号・名前が一致する顧客（自動では統合しません）'}</p>
            {!cands ? <Empty>確認中…</Empty> : cands.length === 0 ? <Empty>{query ? '見つかりません' : 'ありません'}</Empty> : cands.map(k => (
              <button key={k.id} type="button" onClick={() => setPicked(k)} style={candStyle}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{k.name}</span>
                  <span style={{ fontSize: 13, color: C.sub, whiteSpace: 'nowrap' }}>{k.app_linked ? 'App連携済み' : VIA_LABEL[k.created_via]}</span>
                </span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 12, color: C.mute }}>
                  {matchText(k)}{GAP}{k.phone ?? (k.phone_last4 ? `下4桁 ${k.phone_last4}` : '電話なし')}{GAP}来店{k.visit_count}回{k.last_visit ? `${GAP}前回 ${jstDateLabel(k.last_visit)}` : ''}
                </span>
              </button>
            ))}
          </>
        )}
      </Block>
      <Block title="統合した顧客" count={data.merges.length}>
        {data.merges.length === 0 ? <Empty>ありません</Empty> : data.merges.map(m => (
          <div key={m.event_id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.line}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 14 }}>{m.name}<span style={{ color: C.mute, fontSize: 12 }}>{GAP}予約 {m.reservations}件</span></span>
              {undoing === m.event_id ? (
                <span style={{ display: 'flex', gap: 8 }}>
                  <SmallButton quiet disabled={busy} onClick={() => setUndoing(null)}>やめる</SmallButton>
                  <SmallButton danger disabled={busy} onClick={() => void onUnmerge(m.event_id).then(() => setUndoing(null))}>解除する</SmallButton>
                </span>
              ) : (
                <button type="button" onClick={() => setUndoing(m.event_id)} style={linkStyle}>統合を解除</button>
              )}
            </div>
            <p style={{ marginTop: 2, fontSize: 12, color: C.mute }}>{fmtDate(m.created_at)}{GAP}{m.actor_name ?? ''}</p>
          </div>
        ))}
      </Block>
    </div>
  )
}

// ── 部品 ──────────────────────────────────────────────────────────────────────

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: '12px 4px' }}>
      <p style={{ fontSize: 12, color: C.sub }}>{label}</p>
      <p style={{ marginTop: 4, fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</p>
      {sub && <p style={{ marginTop: 2, fontSize: 12, color: C.mute }}>{sub}</p>}
    </div>
  )
}

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: C.sub, paddingBottom: 8, borderBottom: `1px solid ${C.text}` }}>
        {title}{count !== undefined && count > 0 ? <span style={{ fontWeight: 400, color: C.mute }}>{GAP}{count}</span> : null}
      </h2>
      {children}
    </section>
  )
}

function SmallButton({ onClick, disabled, danger, quiet, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; quiet?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{
      minHeight: 40, padding: '0 16px', borderRadius: 8, fontSize: 14, fontWeight: 600, fontFamily: SANS, cursor: disabled ? 'default' : 'pointer',
      border: quiet ? `1px solid ${C.lineStrong}` : 'none',
      background: disabled ? C.line : quiet ? 'transparent' : danger ? C.danger : C.text, color: disabled ? C.mute : quiet ? C.text : C.bg,
    }}>{children}</button>
  )
}

// スマートフォン幅では履歴の行を2段にする（1段目：日付と担当・金額、2段目：内容）
const NARROW = '(max-width: 559px)'
const subscribeNarrow = (cb: () => void) => { const m = window.matchMedia(NARROW); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) }
const isNarrow = () => window.matchMedia(NARROW).matches

function Row({ left, main, right, sub, highlight }: { left: ReactNode; main: ReactNode; right?: ReactNode; sub?: string; highlight?: boolean }) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false)
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: narrow ? '1fr auto' : '128px 1fr auto',
      gridTemplateAreas: narrow ? '"left right" "main main"' : '"left main right"',
      columnGap: 12, rowGap: 4, padding: '10px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14, background: highlight ? C.surface : undefined,
    }}>
      <span style={{ gridArea: 'left', color: C.sub, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{left}</span>
      <span style={{ gridArea: 'main', minWidth: 0 }}>
        <span style={{ display: 'block', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{main}</span>
        {sub && <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: C.mute }}>{sub}</span>}
      </span>
      <span style={{ gridArea: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{right}</span>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p style={{ padding: '10px 0', fontSize: 14, color: C.mute }}>{children}</p>
}

const candStyle: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '12px 0', minHeight: 56, background: 'none', border: 'none',
  borderBottom: `1px solid ${C.line}`, color: C.text, fontFamily: SANS, cursor: 'pointer',
}

function resLine(x: Reservation): string {
  return `${jstDateLabel(getJapanDateString(new Date(x.starts_at)))} ${jstTime(x.starts_at)}${GAP}${x.staff_name}${x.nominated ? '' : '（フリー）'}`
}

function fmtDate(iso: string): string {
  const d = getJapanDateString(new Date(iso))
  const [y, m, dd] = d.split('-').map(Number)
  return `${y}年${m}月${dd}日`
}

function daysAgo(ymd: string, today: string): string {
  const n = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(ymd + 'T00:00:00Z')) / 86400000)
  return n <= 0 ? '今日' : `${n}日前`
}
