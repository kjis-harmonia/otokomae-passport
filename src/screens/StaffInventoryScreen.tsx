import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  adjustProductStock, createProduct, deleteProduct, getProducts, getStockStatus,
  PRODUCT_CATEGORIES, subscribeProductsRealtime, updateProduct,
} from '../hq/hqInventoryStore'
import type { Product, ProductCategory, StockStatus } from '../hq/hqInventoryStore'

// スタッフ端末 /staff 用の在庫管理画面。
// データ層は銀二郎本部（/headquarters 在庫管理タブ）と完全に同じ hqInventoryStore /
// products テーブルを共有する（重複実装なし）。
// UIは「かっこよさ」より検索性・管理効率を優先したコンパクトな行リスト
// （100商品以上でも一覧性が落ちないこと）を優先している。

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const STATUS_LABEL: Record<StockStatus, string> = {
  ok: '正常',
  low: '少ない',
  reorder: '要発注',
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

type CategoryFilter = 'すべて' | ProductCategory

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)',
  color: '#ffffff', fontSize: 14, outline: 'none',
}

const smallBtnStyle: React.CSSProperties = {
  padding: '5px 9px', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer',
  whiteSpace: 'nowrap', flexShrink: 0,
}

export function StaffInventoryScreen() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<ProductCategory>('店販')
  const [newStock, setNewStock] = useState('')
  const [newMinStock, setNewMinStock] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('すべて')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategory, setEditCategory] = useState<ProductCategory>('店販')
  const [editMinStock, setEditMinStock] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  const [adjustingId, setAdjustingId] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState(false)

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
    const created = await createProduct({ name, category: newCategory, currentStock, minStock })
    setAdding(false)
    if (!created) { setAddError('商品の追加に失敗しました'); return }
    setNewName(''); setNewStock(''); setNewMinStock(''); setNewCategory('店販'); setShowAddForm(false)
    load()
  }

  function startEdit(p: Product) {
    setEditingId(p.id)
    setEditName(p.name)
    setEditCategory(p.category)
    setEditMinStock(String(p.min_stock))
  }

  async function handleSaveEdit() {
    if (!editingId) return
    const minStock = Number(editMinStock)
    const name = editName.trim()
    if (!name || !Number.isFinite(minStock) || minStock < 0) return
    setSavingEdit(true)
    await updateProduct(editingId, { name, category: editCategory, minStock })
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

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    await deleteProduct(deleteTarget.id)
    setDeleting(false)
    setDeleteTarget(null)
    load()
  }

  const filteredProducts = useMemo(() => {
    if (state.phase !== 'ready') return []
    const q = searchQuery.trim().toLowerCase()
    return state.products.filter((p) => {
      if (categoryFilter !== 'すべて' && p.category !== categoryFilter) return false
      if (q && !p.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [state, searchQuery, categoryFilter])

  return (
    <div style={{ padding: '12px 12px 40px' }}>
      {/* ── 商品追加 ── */}
      {!showAddForm ? (
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          style={{
            width: '100%', padding: '11px', borderRadius: 10, marginBottom: 8,
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(201,162,74,0.4)',
            color: '#C9A24A', fontFamily: SERIF, fontSize: 14, fontWeight: 700, letterSpacing: '0.06em',
            cursor: 'pointer',
          }}
        >
          ＋ 商品追加
        </button>
      ) : (
        <div style={{ borderRadius: 12, background: '#0A0A0A', border: '1px solid rgba(201,162,74,0.28)', padding: 12, marginBottom: 8 }}>
          <p style={{ fontSize: 11, letterSpacing: '0.1em', color: '#e5e5e5', marginBottom: 8 }}>新商品を追加</p>
          <input placeholder="商品名" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {PRODUCT_CATEGORIES.map((cat) => (
              <button
                key={cat} type="button" onClick={() => setNewCategory(cat)}
                style={{
                  padding: '6px 10px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
                  background: newCategory === cat ? 'rgba(201,162,74,0.18)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${newCategory === cat ? '#C9A24A' : 'rgba(255,255,255,0.1)'}`,
                  color: newCategory === cat ? '#C9A24A' : '#e5e5e5',
                }}
              >
                {cat}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="現在庫" type="number" inputMode="numeric" value={newStock} onChange={(e) => setNewStock(e.target.value)} style={inputStyle} />
            <input placeholder="最低在庫" type="number" inputMode="numeric" value={newMinStock} onChange={(e) => setNewMinStock(e.target.value)} style={inputStyle} />
          </div>
          {addError && <p style={{ fontSize: 12, color: '#E06060', marginBottom: 8 }}>{addError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button" onClick={() => void handleAdd()} disabled={adding}
              style={{ flex: 1, padding: '11px 0', borderRadius: 10, background: 'rgba(201,162,74,0.16)', border: '1px solid #C9A24A', color: '#C9A24A', fontFamily: SERIF, fontSize: 13, fontWeight: 700, cursor: adding ? 'default' : 'pointer' }}
            >
              {adding ? '追加中…' : '追加する'}
            </button>
            <button
              type="button" onClick={() => { setShowAddForm(false); setAddError(null) }}
              style={{ flex: 1, padding: '11px 0', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 13, cursor: 'pointer' }}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* ── 検索 ── */}
      <input
        type="text"
        placeholder="商品名で検索"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      {/* ── カテゴリ切替 ── */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, marginBottom: 10 }}>
        {(['すべて', ...PRODUCT_CATEGORIES] as CategoryFilter[]).map((cat) => (
          <button
            key={cat} type="button" onClick={() => setCategoryFilter(cat)}
            style={{
              flexShrink: 0, padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: categoryFilter === cat ? 'rgba(201,162,74,0.18)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${categoryFilter === cat ? '#C9A24A' : 'rgba(255,255,255,0.12)'}`,
              color: categoryFilter === cat ? '#C9A24A' : '#e5e5e5',
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      {state.phase === 'loading' && (
        <p style={{ textAlign: 'center', color: '#e5e5e5', fontSize: 13, padding: '24px 0' }}>読み込み中…</p>
      )}

      {state.phase === 'error' && (
        <div style={{ borderRadius: 14, background: 'rgba(224,96,80,0.08)', border: '1px solid rgba(224,96,80,0.28)', padding: '16px' }}>
          <p style={{ fontSize: 13, color: '#E06060', textAlign: 'center' }}>{state.message}</p>
        </div>
      )}

      {/* ── 商品一覧（コンパクトな行リスト） ── */}
      {state.phase === 'ready' && (
        state.products.length === 0 ? (
          <p style={{ textAlign: 'center', color: '#999999', fontSize: 13, padding: '24px 0' }}>
            商品が登録されていません
          </p>
        ) : filteredProducts.length === 0 ? (
          <p style={{ textAlign: 'center', color: '#999999', fontSize: 13, padding: '24px 0' }}>
            該当する商品がありません
          </p>
        ) : (
          <div style={{ borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
              background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.1)',
            }}>
              <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 10, letterSpacing: '0.06em', color: '#999999' }}>商品名</span>
              <span style={{ flexShrink: 0, width: 36, fontSize: 10, color: '#999999', textAlign: 'right' }}>現在庫</span>
              <span style={{ flexShrink: 0, width: 32, fontSize: 10, color: '#999999', textAlign: 'right' }}>最低</span>
              <span style={{ flexShrink: 0, width: 44, fontSize: 10, color: '#999999', textAlign: 'right' }}>状態</span>
              <span style={{ flexShrink: 0, width: 4 }} />
            </div>

            {filteredProducts.map((p, idx) => {
              const status = getStockStatus(p.current_stock, p.min_stock)
              const isEditing = editingId === p.id
              return (
                <div
                  key={p.id}
                  style={{
                    padding: '6px 8px',
                    background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  {isEditing ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          value={editName} onChange={(e) => setEditName(e.target.value)}
                          style={{ ...inputStyle, flex: 1, padding: '7px 10px', fontSize: 13 }}
                        />
                        <select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value as ProductCategory)}
                          style={{ ...inputStyle, width: 92, padding: '7px 8px', fontSize: 12 }}
                        >
                          {PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input
                          type="number" inputMode="numeric" placeholder="最低在庫"
                          value={editMinStock} onChange={(e) => setEditMinStock(e.target.value)}
                          style={{ ...inputStyle, width: 64, padding: '7px 8px', fontSize: 13, textAlign: 'right' }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit}
                          style={{ ...smallBtnStyle, flex: 1, padding: '7px 0', background: 'rgba(100,200,100,0.14)', border: '1px solid rgba(100,200,100,0.4)', color: '#80E060' }}
                        >
                          {savingEdit ? '保存中…' : '保存'}
                        </button>
                        <button
                          type="button" onClick={() => setEditingId(null)}
                          style={{ ...smallBtnStyle, flex: 1, padding: '7px 0', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5' }}
                        >
                          キャンセル
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                        <p style={{ fontSize: 13, color: '#ffffff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                          {p.name}
                        </p>
                        <p style={{ fontSize: 10, color: '#777777', margin: 0 }}>{p.category}</p>
                      </div>
                      <span style={{ flexShrink: 0, width: 36, fontSize: 13, fontWeight: 700, color: '#ffffff', textAlign: 'right' }}>
                        {p.current_stock}
                      </span>
                      <span style={{ flexShrink: 0, width: 32, fontSize: 12, color: '#999999', textAlign: 'right' }}>
                        {p.min_stock}
                      </span>
                      <span style={{ flexShrink: 0, width: 44, fontSize: 11, fontWeight: 700, color: STATUS_COLOR[status], textAlign: 'right' }}>
                        {STATUS_LABEL[status]}
                      </span>
                    </div>
                  )}

                  {!isEditing && (
                    <div style={{ display: 'flex', gap: 5, marginTop: 6, overflowX: 'auto' }}>
                      <button
                        type="button" onClick={() => void handleAdjust(p.id, 1)} disabled={adjustingId === p.id}
                        style={{ ...smallBtnStyle, background: 'rgba(201,162,74,0.16)', border: '1px solid #C9A24A', color: '#C9A24A' }}
                      >
                        ＋入庫
                      </button>
                      <button
                        type="button" onClick={() => void handleAdjust(p.id, -1)} disabled={adjustingId === p.id}
                        style={{ ...smallBtnStyle, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5' }}
                      >
                        −出庫
                      </button>
                      <button
                        type="button" onClick={() => startEdit(p)}
                        style={{ ...smallBtnStyle, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5' }}
                      >
                        編集
                      </button>
                      <button
                        type="button" onClick={() => setDeleteTarget(p)}
                        style={{ ...smallBtnStyle, background: 'transparent', border: '1px solid rgba(224,96,80,0.35)', color: '#E06060' }}
                      >
                        削除
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}

      {deleteTarget && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ width: '100%', maxWidth: 340, borderRadius: 16, background: '#0A0A0A', border: '1px solid rgba(201,162,74,0.3)', padding: 20 }}>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#ffffff', marginBottom: 6 }}>
              商品を削除しますか？
            </p>
            <p style={{ fontSize: 13, color: '#e5e5e5', marginBottom: 20 }}>
              「{deleteTarget.name}」を削除します。この操作は元に戻せません。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button" onClick={() => setDeleteTarget(null)} disabled={deleting}
                style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 14, cursor: 'pointer' }}
              >
                いいえ
              </button>
              <button
                type="button" onClick={() => void handleConfirmDelete()} disabled={deleting}
                style={{ flex: 1, padding: '13px 0', borderRadius: 12, background: 'rgba(224,96,80,0.16)', border: '1px solid #E06060', color: '#E06060', fontFamily: SERIF, fontSize: 14, fontWeight: 700, cursor: deleting ? 'default' : 'pointer' }}
              >
                {deleting ? '削除中…' : 'はい'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
