import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { getBookingMasters, hqBookingErrorMessage, upsertMenu, type BookingMasters, type ServiceKind, type ServiceMenu } from '../hqBookingStore'
import { rpcErrorMessage } from '../../utils/staffSession'
import { Chip, ChipRow, Field, PrimaryButton, Sheet } from '../../components/booking/ledgerUi'
import { C, SANS, inputStyle, linkStyle } from '../../components/booking/ledgerTheme'

// 本部：メニュー・価格マスター（予約と会計で共通の正規サービス）。価格は税込の表示価格。
// 予約できるのは所要時間と担当スタッフが決まったメニューだけ（DB でも強制）。オファー（HOT PEPPER クーポン・App 会員価格）は確認用に一覧だけ出す。

const WIDE = '(min-width: 760px)'
const subscribeWide = (cb: () => void) => { const m = window.matchMedia(WIDE); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) }
const isWide = () => window.matchMedia(WIDE).matches

const KIND_LABEL: Record<ServiceKind, string> = { service: 'メニュー', option: 'オプション', set: 'セット' }
/** 所要時間。未確定なら「未設定」、参考所要時間があれば併記（参考は予約には使わない） */
const durationLabel = (m: ServiceMenu) => m.duration_min ? `${m.duration_min}分` : m.reference_duration_min ? `未設定（参考 ${m.reference_duration_min}分）` : '未設定'
const yen = (m: { price: number | null; price_from?: boolean }) => m.price === null ? '—' : `¥${m.price.toLocaleString()}${m.price_from ? '〜' : ''}`

export function HqServiceMasterScreen() {
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true)
  const [masters, setMasters] = useState<BookingMasters | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'menus' | 'offers'>('menus')
  const [editing, setEditing] = useState<ServiceMenu | 'new' | null>(null)

  const load = useCallback(async () => {
    try { setMasters(await getBookingMasters()); setError(null) } catch (err) { setError(rpcErrorMessage(err, 'メニューを読み込めませんでした。')) }
  }, [])
  useEffect(() => { void load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect

  const staffName = (id: string) => masters?.staff.find(s => s.id === id)?.display_name ?? '—'
  // 有効なメニューを区分の順に、停止中は最後にまとめる
  const groups = masters ? groupMenus(masters.menus) : []

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginRight: 4 }}>メニュー・価格</h1>
          <ChipRow>
            <Chip selected={view === 'menus'} onClick={() => setView('menus')}>メニュー</Chip>
            <Chip selected={view === 'offers'} onClick={() => setView('offers')}>オファー</Chip>
          </ChipRow>
        </div>
        <p style={{ marginTop: 8, fontSize: 13, color: C.sub, lineHeight: 1.7 }}>
          {view === 'menus'
            ? '価格は税込の表示価格です。予約できるのは、所要時間と担当スタッフが決まったメニューだけです。'
            : 'HOT PEPPER のクーポンと App 会員価格です。通常価格とは別に、対象メニューへの価格として扱います。'}
        </p>
        {error && <p style={{ color: C.danger, fontSize: 14, marginTop: 12 }}>{error}</p>}
        {!masters ? (!error && <p style={{ color: C.sub, fontSize: 14, marginTop: 16 }}>読み込み中…</p>) : view === 'menus' ? (
          <>
            {groups.map(([label, menus], gi) => (
              <section key={label} style={{ marginTop: 20 }}>
                <h2 style={{ fontSize: 13, fontWeight: 600, color: C.sub, paddingBottom: 6, borderBottom: `1px solid ${C.text}` }}>{label}</h2>
                <div role="table" aria-label={`${label}のメニュー`}>
                  {wide && gi === 0 && (
                    <div role="row" style={{ ...gridRow, minHeight: 32, color: C.mute, fontSize: 12, borderBottom: `1px solid ${C.line}` }}>
                      <span>名称</span><span style={{ textAlign: 'right' }}>価格（税込）</span><span>所要時間</span><span>担当</span><span>予約</span><span>会計</span>
                    </div>
                  )}
                  {menus.map(m => (
                    <button key={m.id} type="button" role="row" onClick={() => setEditing(m)} aria-label={`${m.name}を編集`}
                      style={{ ...rowButton, ...(wide ? gridRow : {}), color: m.is_active ? C.text : C.mute }}>
                      {wide ? (
                        <>
                          <span style={cell}>{m.name}</span>
                          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{yen(m)}</span>
                          <span style={{ color: m.duration_min ? C.text : C.mute }}>{durationLabel(m)}</span>
                          <span style={{ ...cell, color: m.staff.length ? C.text : C.mute }}>{m.staff.length ? m.staff.map(s => staffName(s.staff_id)).join('・') : '未設定'}</span>
                          <span>{m.booking_enabled ? '可' : <span style={{ color: C.mute }}>不可</span>}</span>
                          <span>{m.is_active && m.checkout_enabled ? '可' : <span style={{ color: C.mute }}>不可</span>}</span>
                        </>
                      ) : (
                        <>
                          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <span style={cell}>{m.name}</span>
                            <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{yen(m)}</span>
                          </span>
                          <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: C.mute }}>
                            {[m.kind === 'service' ? null : KIND_LABEL[m.kind], m.duration_min ? `${m.duration_min}分` : `所要時間 ${durationLabel(m)}`,
                              m.booking_enabled ? '予約可' : '予約不可', m.is_active && m.checkout_enabled ? '会計可' : '会計不可'].filter(Boolean).join('・')}
                          </span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            <button type="button" onClick={() => setEditing('new')} style={{ ...linkStyle, color: C.text, marginTop: 12 }}>＋ メニューを追加</button>
          </>
        ) : (
          <div role="table" aria-label="オファー一覧" style={{ marginTop: 16, borderTop: `1px solid ${C.text}` }}>
            {masters.offers.map(o => {
              const targets = o.menu_ids.map(id => masters.menus.find(m => m.id === id)?.name).filter(Boolean)
              return (
                <div key={o.id} role="row" style={{ padding: '10px 0', borderBottom: `1px solid ${C.line}`, color: o.is_active ? C.text : C.mute }}>
                  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 14 }}>
                    <span style={{ minWidth: 0 }}>{o.name}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: o.offer_price === null ? C.mute : C.text }}>
                      {o.offer_price === null ? '価格未確認' : `¥${o.offer_price.toLocaleString()}`}
                    </span>
                  </span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: C.mute, lineHeight: 1.6 }}>
                    {[o.channel === 'hotpepper' ? 'HOT PEPPER' : 'App 会員', o.external_id, targets.length ? `対象：${targets.join('・')}` : '対象メニュー未確認',
                      o.staff_ids.length ? `担当：${o.staff_ids.map(staffName).join('・')}` : null,
                      o.first_visit_only ? '初回来店のみ' : null,
                      o.weekdays_only || o.time_from ? `${o.weekdays_only ? '平日' : ''}${o.time_from ? `${o.time_from}〜${o.time_to ?? ''}` : ''}` : null,
                      o.conditions].filter(Boolean).join('　')}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {editing && masters && (
        <MenuEditor menu={editing === 'new' ? null : editing} masters={masters}
          onClose={() => setEditing(null)} onSaved={async () => { await load(); setEditing(null) }} />
      )}
    </div>
  )
}

function groupMenus(menus: ServiceMenu[]): [string, ServiceMenu[]][] {
  const active = menus.filter(m => m.is_active)
  const order: string[] = []
  for (const m of active) { const k = m.category ?? KIND_LABEL[m.kind]; if (!order.includes(k)) order.push(k) }
  const groups: [string, ServiceMenu[]][] = order.map(k => [k, active.filter(m => (m.category ?? KIND_LABEL[m.kind]) === k)])
  const stopped = menus.filter(m => !m.is_active)
  if (stopped.length) groups.push(['停止中', stopped])
  return groups
}

function MenuEditor({ menu, masters, onClose, onSaved }: { menu: ServiceMenu | null; masters: BookingMasters; onClose: () => void; onSaved: () => Promise<void> }) {
  const bookableStaff = masters.staff.filter(s => s.is_active && s.is_bookable)
  const [name, setName] = useState(menu?.name ?? '')
  const [kind, setKind] = useState<ServiceKind>(menu?.kind ?? 'service')
  const [category, setCategory] = useState(menu?.category ?? '')
  const [price, setPrice] = useState(menu?.price?.toString() ?? '')
  const [priceFrom, setPriceFrom] = useState(menu?.price_from ?? false)
  const [duration, setDuration] = useState(menu?.duration_min?.toString() ?? '')
  const [buffer, setBuffer] = useState((menu?.buffer_after_min ?? 0).toString())
  const [active, setActive] = useState(menu?.is_active ?? true)
  const [checkout, setCheckout] = useState(menu?.checkout_enabled ?? true)
  const [booking, setBooking] = useState(menu?.booking_enabled ?? false)
  // 担当：staff_id → スタッフ別所要時間（空欄 = メニューの所要時間）。受付していないスタッフの既存設定はそのまま残す
  const [assigned, setAssigned] = useState<Record<string, string>>(
    () => Object.fromEntries((menu?.staff ?? []).map(s => [s.staff_id, s.duration_override_min?.toString() ?? ''])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const hasStaff = bookableStaff.some(s => s.id in assigned)
  // 予約を受け付けられない理由（DB でも同じ条件で拒否する）
  const bookingBlocked = !active ? 'メニューが停止中です' : !num(duration) ? '所要時間を入力してください' : !hasStaff ? '担当スタッフを選んでください' : null

  async function save() {
    setBusy(true); setError(null)
    try {
      await upsertMenu({
        ...(menu ? { id: menu.id } : { code: `menu-${Date.now().toString(36)}` }),
        name: name.trim(), kind, category: category.trim() || null, price: num(price), price_from: priceFrom,
        duration_min: num(duration), buffer_after_min: num(buffer) ?? 0,
        is_active: active, checkout_enabled: checkout, booking_enabled: booking && !bookingBlocked,
        staff: Object.entries(assigned).map(([id, d]) => ({ staff_id: id, duration_override_min: num(d) })),
      })
      await onSaved()
    } catch (err) {
      setError(hqBookingErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={menu ? menu.name : 'メニューを追加'} onClose={onClose}
      footer={<PrimaryButton onClick={() => void save()} disabled={busy || name.trim() === ''}>{busy ? '保存中…' : '保存'}</PrimaryButton>}>
      <Field label="メニュー名"><input value={name} onChange={e => setName(e.target.value)} maxLength={80} style={inputStyle} /></Field>
      <Group label="区分">
        <ChipRow>
          {(Object.keys(KIND_LABEL) as ServiceKind[]).map(k => <Chip key={k} selected={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k]}</Chip>)}
        </ChipRow>
      </Group>
      <div style={twoCols}>
        <Field label="カテゴリ"><input value={category} onChange={e => setCategory(e.target.value)} maxLength={20} placeholder="カット・カラーなど" style={inputStyle} /></Field>
        <Field label="価格（税込・円）"><input value={price} onChange={e => setPrice(e.target.value.replace(/\D/g, ''))} inputMode="numeric" style={inputStyle} /></Field>
      </div>
      <label style={checkRow}><input type="checkbox" checked={priceFrom} onChange={e => setPriceFrom(e.target.checked)} style={box} />価格に「〜」を付ける</label>
      <div style={twoCols}>
        <Field label="所要時間（分）"><input value={duration} onChange={e => setDuration(e.target.value.replace(/\D/g, ''))} inputMode="numeric" style={inputStyle} /></Field>
        <Field label="片付け（分）"><input value={buffer} onChange={e => setBuffer(e.target.value.replace(/\D/g, ''))} inputMode="numeric" style={inputStyle} /></Field>
      </div>
      {menu?.reference_duration_min && !menu.duration_min && (
        <p style={{ fontSize: 13, color: C.mute, marginTop: 4 }}>参考：{menu.reference_duration_min}分（{menu.reference_duration_note ?? '未確定'}）。確定したら所要時間に入力してください。</p>
      )}
      <Group label="担当できるスタッフ">
        <div style={{ borderTop: `1px solid ${C.line}` }}>
          {bookableStaff.map(s => {
            const on = s.id in assigned
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 50, borderBottom: `1px solid ${C.line}` }}>
                <label style={{ ...checkRow, flex: 1 }}>
                  <input type="checkbox" checked={on} style={box} onChange={e => {
                    const next = { ...assigned }
                    if (e.target.checked) next[s.id] = ''; else delete next[s.id]
                    setAssigned(next)
                  }} />
                  {s.display_name}
                </label>
                {on && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.sub }}>
                    <input value={assigned[s.id]} inputMode="numeric" placeholder={duration || '—'} aria-label={`${s.display_name}の所要時間`}
                      onChange={e => setAssigned({ ...assigned, [s.id]: e.target.value.replace(/\D/g, '') })} style={{ ...inputStyle, width: 76, height: 40 }} />
                    分
                  </label>
                )}
              </div>
            )
          })}
        </div>
      </Group>
      <div style={{ marginTop: 12 }}>
        <label style={checkRow}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} style={box} />有効（停止中は予約・会計に出ません）</label>
        <label style={checkRow}><input type="checkbox" checked={checkout} onChange={e => setCheckout(e.target.checked)} style={box} />会計で選べる</label>
        <label style={{ ...checkRow, color: bookingBlocked ? C.mute : C.text }}>
          <input type="checkbox" checked={booking && !bookingBlocked} disabled={!!bookingBlocked} onChange={e => setBooking(e.target.checked)} style={box} />
          予約を受け付ける{bookingBlocked && <span style={{ fontSize: 12 }}>（{bookingBlocked}）</span>}
        </label>
      </div>
      {error && <p style={{ color: C.danger, fontSize: 14, marginTop: 10 }}>{error}</p>}
    </Sheet>
  )
}

/** 入力欄以外（選択肢・チェックボックスの並び）の見出し。Field は label で包むので使わない */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} style={{ marginTop: 12 }}>
      <span style={{ display: 'block', fontSize: 13, color: C.sub, marginBottom: 6 }}>{label}</span>
      {children}
    </div>
  )
}

const gridRow: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) 108px 84px minmax(120px, 1.2fr) 48px 48px', columnGap: 12, alignItems: 'center',
}
const rowButton: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: 48, padding: '10px 0', background: 'none', border: 'none',
  borderBottom: `1px solid ${C.line}`, fontFamily: SANS, fontSize: 14, cursor: 'pointer',
}
const cell: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const twoCols: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', columnGap: 12 }
const checkRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 15, cursor: 'pointer' }
const box: CSSProperties = { width: 18, height: 18, flexShrink: 0 }
