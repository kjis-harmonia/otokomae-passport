import { useCallback, useEffect, useRef, useState } from 'react'
import {
  adjustProductStock, createProduct, getProducts, getStockStatus, subscribeProductsRealtime, updateProduct,
} from '../hq/hqInventoryStore'
import type { Product, StockStatus } from '../hq/hqInventoryStore'

// スタッフ端末 /staff 用の在庫管理画面。
// データ層は銀二郎本部（/headquarters 在庫管理タブ）と完全に同じ hqInventoryStore /
// products テーブルを共有する（重複実装なし）。UIだけスタッフ端末向け（大きいボタン・
// カード型レイアウト）に調整している。

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const STATUS_LABEL: Record<StockStatus, string> = {
  ok: '🟢 正常',
  low: '🟡 少ない',
  reorder: '🔴 要発注',
}

const STATUS_COLOR: Record<StockStatus, string> = {
  ok: '#80E060',
  low: '#E0B84A',
  reorder: '#E06060',
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; products: Product[] }

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 12,
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)',
  color: '#ffffff', fontSize: 15, outline: 'none',
}

export function StaffInventoryScreen() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newStock, setNewStock] = useState('')
  const [newMinStock, setNewMinStock] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editMinStock, setEditMinStock] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  const [adjustingId, setAdjustingId] = useState<string | null>(null)

  const load = useCallback((opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setState({ phase: 'loading' })
    getProducts()
      .then((products) => setState({ phase: 'ready', products }))
      .catch((e) => {
        console.error('[StaffInventoryScreen] getProducts error:', e)
        setState((prev) => (opts.silent && prev.phase === 'ready' ? prev : { phase: 'error', message: '在庫データの取得に失敗しました。' }))
      })
  }, [])

  useEffect(() => { load() }, [load])

  // 銀二郎本部の在庫管理タブと同じproductsを購読しているため、本部側で行った
  // 変更（または別の店舗端末での変更）もこの画面にリアルタイムで反映される
  useEffect(() => {
    const unsubscribe = subscribeProductsRealtime(() => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => load({ silent: true }), 400)
    })
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      unsubscribe()
    }
  }, [load])

  async function handleAdd() {
    const name = newName.trim()
    const currentStock = Number(newStock)
    const minStock = Number(newMinStock)
    if (!name) { setAddError('商品名を入力してください'); return }
    if (!Number.isFinite(currentStock) || currentStock < 0) { setAddError('現在庫は0以上の数値で入力してください'); return }
    if (!Number.isFinite(minStock) || minStock < 0) { setAddError('最低在庫は0以上の数値で入力してください'); return }

    setAdding(true)
    setAddError(null)
    const created = await createProduct({ name, currentStock, minStock })
    setAdding(false)
    if (!created) { setAddError('商品の追加に失敗しました'); return }
    setNewName(''); setNewStock(''); setNewMinStock(''); setShowAddForm(false)
    load()
  }

  function startEdit(p: Product) {
    setEditingId(p.id)
    setEditName(p.name)
    setEditMinStock(String(p.min_stock))
  }

  async function handleSaveEdit() {
    if (!editingId) return
    const minStock = Number(editMinStock)
    const name = editName.trim()
    if (!name || !Number.isFinite(minStock) || minStock < 0) return
    setSavingEdit(true)
    await updateProduct(editingId, { name, minStock })
    setSavingEdit(false)
    setEditingId(null)
    load()
  }

  async function handleAdjust(id: string, delta: number) {
    setAdjustingId(id)
    await adjustProductStock(id, delta)
    setAdjustingId(null)
    load({ silent: true })
  }

  return (
    <div style={{ padding: '16px 16px 40px' }}>
      <p style={{ fontSize: 12, letterSpacing: '0.16em', color: '#ffffff', fontWeight: 700, marginBottom: 14 }}>
        商品一覧
      </p>

      {!showAddForm ? (
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          style={{
            width: '100%', padding: '16px', borderRadius: 14, marginBottom: 18,
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(201,162,74,0.4)',
            color: '#C9A24A', fontFamily: SERIF, fontSize: 16, fontWeight: 700, letterSpacing: '0.08em',
            cursor: 'pointer',
          }}
        >
          ＋ 商品を追加
        </button>
      ) : (
        <div style={{ borderRadius: 16, background: '#0A0A0A', border: '1px solid rgba(201,162,74,0.28)', padding: 16, marginBottom: 18 }}>
          <p style={{ fontSize: 11, letterSpacing: '0.1em', color: '#e5e5e5', marginBottom: 10 }}>新商品を追加</p>
          <input placeholder="商品名" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="現在庫" type="number" inputMode="numeric" value={newStock} onChange={(e) => setNewStock(e.target.value)} style={inputStyle} />
            <input placeholder="最低在庫" type="number" inputMode="numeric" value={newMinStock} onChange={(e) => setNewMinStock(e.target.value)} style={inputStyle} />
          </div>
          {addError && <p style={{ fontSize: 12, color: '#E06060', marginBottom: 8 }}>{addError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button" onClick={() => void handleAdd()} disabled={adding}
              style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'rgba(201,162,74,0.16)', border: '1px solid #C9A24A', color: '#C9A24A', fontFamily: SERIF, fontSize: 14, fontWeight: 700, cursor: adding ? 'default' : 'pointer' }}
            >
              {adding ? '追加中…' : '追加する'}
            </button>
            <button
              type="button" onClick={() => { setShowAddForm(false); setAddError(null) }}
              style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 14, cursor: 'pointer' }}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {state.phase === 'loading' && (
        <p style={{ textAlign: 'center', color: '#e5e5e5', fontSize: 13, padding: '24px 0' }}>読み込み中…</p>
      )}

      {state.phase === 'error' && (
        <div style={{ borderRadius: 14, background: 'rgba(224,96,80,0.08)', border: '1px solid rgba(224,96,80,0.28)', padding: '16px' }}>
          <p style={{ fontSize: 13, color: '#E06060', textAlign: 'center' }}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ready' && (
        state.products.length === 0 ? (
          <p style={{ textAlign: 'center', color: '#999999', fontSize: 13, padding: '24px 0' }}>
            商品が登録されていません
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {state.products.map((p) => {
              const status = getStockStatus(p.current_stock, p.min_stock)
              const isEditing = editingId === p.id
              return (
                <div key={p.id} style={{ borderRadius: 16, background: '#0A0A0A', border: '1px solid rgba(255,255,255,0.12)', padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
                    {isEditing ? (
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                    ) : (
                      <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#ffffff', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </p>
                    )}
                    <span style={{ fontSize: 13, fontWeight: 700, color: STATUS_COLOR[status], flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {STATUS_LABEL[status]}
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
                    <div>
                      <p style={{ fontSize: 10, letterSpacing: '0.08em', color: '#999999', marginBottom: 2 }}>現在庫</p>
                      <p style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 800, color: '#ffffff' }}>{p.current_stock}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: 10, letterSpacing: '0.08em', color: '#999999', marginBottom: 2 }}>最低在庫</p>
                      {isEditing ? (
                        <input
                          type="number" inputMode="numeric" value={editMinStock} onChange={(e) => setEditMinStock(e.target.value)}
                          style={{ ...inputStyle, width: 80, textAlign: 'right' }}
                        />
                      ) : (
                        <p style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: '#e5e5e5' }}>{p.min_stock}</p>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button" onClick={() => void handleAdjust(p.id, -1)} disabled={adjustingId === p.id}
                      style={{ flex: 1, padding: '14px 0', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontSize: 18, fontWeight: 700, cursor: 'pointer' }}
                    >
                      − 出庫
                    </button>
                    <button
                      type="button" onClick={() => void handleAdjust(p.id, 1)} disabled={adjustingId === p.id}
                      style={{ flex: 1, padding: '14px 0', borderRadius: 12, background: 'rgba(201,162,74,0.16)', border: '1px solid #C9A24A', color: '#C9A24A', fontSize: 18, fontWeight: 700, cursor: 'pointer' }}
                    >
                      ＋ 入庫
                    </button>
                    {isEditing ? (
                      <button
                        type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit}
                        style={{ flex: 1, padding: '14px 0', borderRadius: 12, background: 'rgba(100,200,100,0.12)', border: '1px solid rgba(100,200,100,0.4)', color: '#80E060', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                      >
                        {savingEdit ? '保存中…' : '保存'}
                      </button>
                    ) : (
                      <button
                        type="button" onClick={() => startEdit(p)}
                        style={{ flex: 1, padding: '14px 0', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                      >
                        編集
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
