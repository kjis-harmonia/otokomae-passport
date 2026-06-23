import { useCallback, useEffect, useMemo, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { getCustomerKarteDetail, getCustomerKarteList } from '../hqCustomerKarteStore'
import type { CustomerKarteDetail, CustomerKarteSummary } from '../hqCustomerKarteStore'
import { createCustomerNote, getCustomerNotes } from '../hqCustomerNotesStore'
import type { CustomerNote } from '../hqCustomerNotesStore'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from '../hqTheme'

const NOTE_STAFF_OPTIONS = ['テイテイ', '銀二郎', 'フリー'] as const

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; customers: CustomerKarteSummary[] }

type DetailState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; detail: CustomerKarteDetail }

function yen(v: number): string {
  return `¥${v.toLocaleString()}`
}

function fmtDate(dateStr: string | null): string {
  return dateStr ? dateStr.replaceAll('-', '/') : '未来店'
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.35)',
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  borderRadius: 3,
  color: HQ_COLORS.textPrimary,
  fontFamily: HQ_SANS,
  fontSize: 13,
  padding: '8px 10px',
  width: '100%',
  boxSizing: 'border-box',
}

export function HqCustomerKarteScreen() {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<DetailState>({ phase: 'idle' })

  useEffect(() => {
    getCustomerKarteList()
      .then((customers) => setListState({ phase: 'ready', customers }))
      .catch((e) => {
        console.error('[HqCustomerKarteScreen] getCustomerKarteList error:', e)
        setListState({ phase: 'error', message: '顧客カルテデータの取得に失敗しました。' })
      })
  }, [])

  useEffect(() => {
    if (!selectedUserId) { setDetailState({ phase: 'idle' }); return }
    let cancelled = false
    setDetailState({ phase: 'loading' })
    getCustomerKarteDetail(selectedUserId)
      .then((detail) => {
        if (cancelled) return
        if (!detail) { setDetailState({ phase: 'error', message: '顧客カルテデータの取得に失敗しました。' }); return }
        setDetailState({ phase: 'ready', detail })
      })
      .catch((e) => {
        console.error('[HqCustomerKarteScreen] getCustomerKarteDetail error:', e)
        if (!cancelled) setDetailState({ phase: 'error', message: '顧客カルテデータの取得に失敗しました。' })
      })
    return () => { cancelled = true }
  }, [selectedUserId])

  const filtered = useMemo(() => {
    if (listState.phase !== 'ready') return []
    const q = query.trim().toLowerCase()
    if (!q) return listState.customers
    return listState.customers.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.userId.toLowerCase().includes(q) ||
      (c.phoneLast4 ?? '').toLowerCase().includes(q),
    )
  }, [listState, query])

  if (selectedUserId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <button
          type="button"
          onClick={() => setSelectedUserId(null)}
          style={{
            alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 3,
            border: `1px solid ${HQ_COLORS.panelBorder}`, background: 'transparent',
            color: HQ_COLORS.textSecondary, fontFamily: HQ_SANS, fontSize: 12, cursor: 'pointer',
          }}
        >
          ← 一覧へ戻る
        </button>

        {detailState.phase === 'loading' && (
          <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textSecondary }}>読み込み中…</p>
        )}
        {detailState.phase === 'error' && (
          <div style={{ background: 'rgba(140,31,26,0.10)', border: `1px solid ${HQ_COLORS.red}`, borderRadius: 4, padding: '16px 18px' }}>
            <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.negative, margin: 0 }}>{detailState.message}</p>
          </div>
        )}
        {detailState.phase === 'ready' && <CustomerKarteDetailView detail={detailState.detail} />}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <input
        placeholder="会員名 / user_id / 電話番号で検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={inputStyle}
      />

      {listState.phase === 'loading' && (
        <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textSecondary }}>読み込み中…</p>
      )}

      {listState.phase === 'error' && (
        <div style={{ background: 'rgba(140,31,26,0.10)', border: `1px solid ${HQ_COLORS.red}`, borderRadius: 4, padding: '16px 18px' }}>
          <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.negative, margin: 0 }}>{listState.message}</p>
        </div>
      )}

      {listState.phase === 'ready' && (
        listState.customers.length === 0 ? (
          <HqPanel title="顧客一覧" code="0件">
            <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
              顧客データがまだありません
            </p>
          </HqPanel>
        ) : (
          <HqPanel title="顧客一覧" code={`${filtered.length}/${listState.customers.length}件`}>
            {filtered.length === 0 ? (
              <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
                該当する顧客が見つかりません
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filtered.map((c) => (
                  <button
                    key={c.userId}
                    type="button"
                    onClick={() => setSelectedUserId(c.userId)}
                    style={{
                      display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between',
                      gap: 8, width: '100%', textAlign: 'left', cursor: 'pointer',
                      padding: '12px 14px', borderRadius: 4,
                      border: `1px solid ${HQ_COLORS.panelBorder}`, background: 'rgba(0,0,0,0.25)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontFamily: HQ_SERIF, fontSize: 15, fontWeight: 700, color: HQ_COLORS.textPrimary, margin: 0, marginBottom: 2 }}>
                        {c.name}
                      </p>
                      <p style={{ fontFamily: HQ_MONO, fontSize: 10.5, color: HQ_COLORS.textMute, margin: 0 }}>
                        {c.userId}
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 16, fontFamily: HQ_MONO, fontSize: 12, color: HQ_COLORS.textSecondary, flexShrink: 0 }}>
                      <span>来店 {c.visitCount}回</span>
                      <span style={{ color: HQ_COLORS.goldHi }}>{yen(c.totalSpend)}</span>
                      <span>{fmtDate(c.lastVisitDate)}</span>
                      <span>{c.lastStylistName ?? '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </HqPanel>
        )
      )}
    </div>
  )
}

function CustomerKarteDetailView({ detail }: { detail: CustomerKarteDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <HqPanel title="基本情報" code="PROFILE">
        <p style={{ fontFamily: HQ_SERIF, fontSize: 20, fontWeight: 700, color: '#fff', margin: 0, marginBottom: 6 }}>
          {detail.name}
        </p>
        <p style={{ fontFamily: HQ_MONO, fontSize: 11.5, color: HQ_COLORS.textMute, margin: 0, marginBottom: 4 }}>
          {detail.userId}
        </p>
        {detail.registeredAt && (
          <p style={{ fontFamily: HQ_SANS, fontSize: 11.5, color: HQ_COLORS.textSecondary, margin: 0 }}>
            登録日 {fmtDate(detail.registeredAt.slice(0, 10))}
          </p>
        )}
      </HqPanel>

      <HqPanel title="利用実績" code="SUMMARY">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Stat label="累計来店回数" value={`${detail.visitCount}回`} />
          <Stat label="累計利用額" value={yen(detail.totalSpend)} />
          <Stat label="平均単価" value={yen(detail.avgSpend)} />
          <Stat label="最終来店日" value={fmtDate(detail.lastVisitDate)} />
          <Stat label="来店周期" value={detail.avgIntervalDays !== null ? `${detail.avgIntervalDays}日` : '算出不可'} />
        </div>
      </HqPanel>

      <HqPanel title="来店履歴" code={`${detail.visits.length}件`}>
        {detail.visits.length === 0 ? (
          <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
            来店履歴がありません
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {detail.visits.map((v) => (
              <div key={v.sessionId} style={{ border: `1px solid ${HQ_COLORS.panelBorder}`, borderRadius: 4, padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.textPrimary }}>{fmtDate(v.date)}</span>
                  <span style={{ fontFamily: HQ_MONO, fontSize: 13, color: HQ_COLORS.goldHi }}>{yen(v.total)}</span>
                </div>
                <p style={{ fontFamily: HQ_SANS, fontSize: 11, color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 6 }}>
                  施術 {v.stylistName ?? '—'} / 操作 {v.staffName ?? '—'}
                </p>
                {v.items.length > 0 && (
                  <p style={{ fontFamily: HQ_SANS, fontSize: 11.5, color: HQ_COLORS.textMute, margin: 0 }}>
                    {v.items.map((it) => `${it.itemName}${it.quantity > 1 ? `×${it.quantity}` : ''}`).join(' / ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </HqPanel>

      <HqPanel title="メニュー利用傾向" code="USAGE">
        {detail.itemUsage.length === 0 ? (
          <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
            利用データがありません
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {detail.itemUsage.map((u) => (
              <div key={u.itemName} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textPrimary }}>{u.itemName}</span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12.5, color: HQ_COLORS.textSecondary }}>
                  {u.count}{u.category === 'retail' ? '個' : '回'}
                </span>
              </div>
            ))}
          </div>
        )}
      </HqPanel>

      <CustomerNotesSection customerId={detail.customerId} />
    </div>
  )
}

function CustomerNotesSection({ customerId }: { customerId: string }) {
  const [notes, setNotes] = useState<CustomerNote[] | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [createdBy, setCreatedBy] = useState<typeof NOTE_STAFF_OPTIONS[number]>(NOTE_STAFF_OPTIONS[0])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    getCustomerNotes(customerId, 50).then(setNotes)
  }, [customerId])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    const trimmed = noteText.trim()
    if (!trimmed) { setError('メモ内容を入力してください'); return }
    setSaving(true)
    setError(null)
    const created = await createCustomerNote({ customerId, note: trimmed, createdBy })
    setSaving(false)
    if (!created) { setError('メモの保存に失敗しました'); return }
    setNoteText('')
    setShowForm(false)
    load()
  }

  return (
    <HqPanel title="接客メモ" code={notes ? `${notes.length}件` : undefined}>
      <div style={{ marginBottom: 14 }}>
        {!showForm ? (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            style={{
              padding: '8px 16px', borderRadius: 3,
              border: `1px solid ${HQ_COLORS.panelBorderStrong}`,
              background: 'rgba(201,162,74,0.12)', color: HQ_COLORS.goldHi,
              fontFamily: HQ_SANS, fontSize: 12, cursor: 'pointer',
            }}
          >
            メモ追加
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <textarea
              placeholder="例：息子が野球部入部 / 次回は濡れパン弱め希望"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: HQ_SANS }}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {NOTE_STAFF_OPTIONS.map((name) => {
                const active = createdBy === name
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setCreatedBy(name)}
                    style={{
                      padding: '6px 12px', borderRadius: 3,
                      border: `1px solid ${active ? HQ_COLORS.panelBorderStrong : HQ_COLORS.panelBorder}`,
                      background: active ? 'rgba(201,162,74,0.16)' : 'transparent',
                      color: active ? HQ_COLORS.goldHi : HQ_COLORS.textSecondary,
                      fontFamily: HQ_SANS, fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    {name}
                  </button>
                )
              })}
            </div>
            {error && (
              <p style={{ fontFamily: HQ_SANS, fontSize: 11.5, color: HQ_COLORS.negative, margin: 0 }}>{error}</p>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                style={{
                  padding: '8px 16px', borderRadius: 3,
                  border: `1px solid ${HQ_COLORS.panelBorderStrong}`,
                  background: 'rgba(201,162,74,0.12)', color: HQ_COLORS.goldHi,
                  fontFamily: HQ_SANS, fontSize: 12, cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setNoteText(''); setError(null) }}
                style={{
                  padding: '8px 16px', borderRadius: 3,
                  border: `1px solid ${HQ_COLORS.panelBorder}`,
                  background: 'transparent', color: HQ_COLORS.textSecondary,
                  fontFamily: HQ_SANS, fontSize: 12, cursor: 'pointer',
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>

      {notes === null ? (
        <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textSecondary, margin: 0 }}>読み込み中…</p>
      ) : notes.length === 0 ? (
        <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
          接客メモはまだありません
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {notes.map((n) => (
            <div key={n.id} style={{ borderTop: `1px solid ${HQ_COLORS.panelBorder}`, paddingTop: 10 }}>
              <p style={{ fontFamily: HQ_MONO, fontSize: 11, color: HQ_COLORS.textMute, margin: 0, marginBottom: 4 }}>
                {fmtDate(n.created_at.slice(0, 10))}
              </p>
              <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textPrimary, margin: 0, marginBottom: 4, whiteSpace: 'pre-wrap' }}>
                {n.note}
              </p>
              <p style={{ fontFamily: HQ_SANS, fontSize: 11, color: HQ_COLORS.textSecondary, margin: 0 }}>
                担当：{n.created_by}
              </p>
            </div>
          ))}
        </div>
      )}
    </HqPanel>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 100 }}>
      <p style={{ fontFamily: HQ_SANS, fontSize: 9, letterSpacing: '0.1em', color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 4 }}>
        {label}
      </p>
      <p style={{ fontFamily: HQ_MONO, fontSize: 16, fontWeight: 700, color: HQ_COLORS.goldHi, margin: 0 }}>
        {value}
      </p>
    </div>
  )
}
