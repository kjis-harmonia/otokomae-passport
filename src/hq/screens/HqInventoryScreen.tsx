import { useCallback, useEffect, useRef, useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HqStockAlertPanel } from '../components/HqStockAlertPanel'
import {
  adjustProductStock, createProduct, deleteProduct, getProducts, getStockStatus,
  PRODUCT_CATEGORIES, subscribeProductsRealtime, updateProduct,
} from '../hqInventoryStore'
import type { Product, ProductCategory, StockStatus } from '../hqInventoryStore'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; products: Product[] }

const STATUS_LABEL: Record<StockStatus, string> = {
  ok: '🟢正常',
  low: '🟡少ない',
  reorder: '🔴要発注',
}

const STATUS_COLOR: Record<StockStatus, string> = {
  ok: HQ_COLORS.positive,
  low: '#E0B84A',
  reorder: HQ_COLORS.negative,
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.35)',
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  borderRadius: 3,
  color: HQ_COLORS.textPrimary,
  fontFamily: HQ_SANS,
  fontSize: 12.5,
  padding: '6px 8px',
}

const buttonStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 3,
  border: `1px solid ${HQ_COLORS.panelBorderStrong}`,
  background: 'rgba(201,162,74,0.12)',
  color: HQ_COLORS.goldHi,
  fontFamily: HQ_SANS,
  fontSize: 11.5,
  cursor: 'pointer',
}

const ghostButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 3,
  border: `1px solid ${HQ_COLORS.panelBorder}`,
  background: 'transparent',
  color: HQ_COLORS.textSecondary,
  fontFamily: HQ_SANS,
  fontSize: 11.5,
  cursor: 'pointer',
}

export function HqInventoryScreen() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<ProductCategory>('店販')
  const [newStock, setNewStock] = useState('')
  const [newMinStock, setNewMinStock] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newAccountingGroup, setNewAccountingGroup] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategory, setEditCategory] = useState<ProductCategory>('店販')
  const [editMinStock, setEditMinStock] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editAccountingGroup, setEditAccountingGroup] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  const [qtyInputs, setQtyInputs] = useState<Record<string, string>>({})
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState(false)

  // silent=true: リアルタイム購読による再読み込み時は「読み込み中…」表示で
  // 編集中のフォームを潰さない。失敗しても直前の表示データを維持する。
  const load = useCallback((opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setState({ phase: 'loading' })
    getProducts()
      .then((products) => setState({ phase: 'ready', products }))
      .catch((e) => {
        console.error('[HqInventoryScreen] getProducts error:', e)
        setState((prev) => (opts.silent && prev.phase === 'ready' ? prev : { phase: 'error', message: '在庫データの取得に失敗しました。' }))
      })
  }, [])

  useEffect(() => { load() }, [load])

  // 会計アシストの店販販売による自動減算や、本部からのCRUDをリアルタイム反映する
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
    const price = parseInt(newPrice.replace(/[^\d]/g, ''), 10) || 0
    const created = await createProduct({
      name, category: newCategory, currentStock, minStock, price,
      accountingGroup: newCategory === '店販' ? newAccountingGroup : null,
    })
    setAdding(false)
    if (!created) { setAddError('商品の追加に失敗しました'); return }
    setNewName(''); setNewStock(''); setNewMinStock(''); setNewCategory('店販'); setNewPrice(''); setNewAccountingGroup('')
    load()
  }

  function startEdit(p: Product) {
    setEditingId(p.id)
    setEditName(p.name)
    setEditCategory(p.category)
    setEditMinStock(String(p.min_stock))
    setEditPrice(String(p.price ?? 0))
    setEditAccountingGroup(p.accounting_group ?? '')
  }

  async function handleSaveEdit() {
    if (!editingId) return
    const minStock = Number(editMinStock)
    const name = editName.trim()
    if (!name || !Number.isFinite(minStock) || minStock < 0) return
    const price = parseInt(editPrice.replace(/[^\d]/g, ''), 10) || 0
    setSavingEdit(true)
    await updateProduct(editingId, {
      name, category: editCategory, minStock, price,
      accountingGroup: editCategory === '店販' ? editAccountingGroup : null,
    })
    setSavingEdit(false)
    setEditingId(null)
    load()
  }

  async function handleAdjust(id: string, sign: 1 | -1) {
    const raw = qtyInputs[id]
    const qty = raw && raw.trim() !== '' ? Number(raw) : 1
    if (!Number.isFinite(qty) || qty <= 0) return
    setAdjustingId(id)
    await adjustProductStock(id, qty * sign)
    setAdjustingId(null)
    load()
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    await deleteProduct(deleteTarget.id)
    setDeleting(false)
    setDeleteTarget(null)
    load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {state.phase === 'ready' && <HqStockAlertPanel products={state.products} />}

      <HqPanel title="商品追加" code="NEW">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            placeholder="商品名"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ ...inputStyle, flex: '2 1 160px' }}
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as ProductCategory)}
            style={{ ...inputStyle, flex: '1 1 110px' }}
          >
            {PRODUCT_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
          </select>
          <input
            placeholder="現在庫"
            type="number"
            inputMode="numeric"
            value={newStock}
            onChange={(e) => setNewStock(e.target.value)}
            style={{ ...inputStyle, flex: '1 1 90px' }}
          />
          <input
            placeholder="最低在庫"
            type="number"
            inputMode="numeric"
            value={newMinStock}
            onChange={(e) => setNewMinStock(e.target.value)}
            style={{ ...inputStyle, flex: '1 1 90px' }}
          />
          <input
            placeholder="価格（円）"
            type="number"
            inputMode="numeric"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            style={{ ...inputStyle, flex: '1 1 100px' }}
          />
          {newCategory === '店販' && (
            <input
              placeholder="会計サブカテゴリー（例：スタイリング剤）"
              value={newAccountingGroup}
              onChange={(e) => setNewAccountingGroup(e.target.value)}
              list="hq-accounting-group-options"
              style={{ ...inputStyle, flex: '1 1 160px' }}
            />
          )}
          <datalist id="hq-accounting-group-options">
            <option value="スタイリング剤" />
            <option value="シャンプー・ケア" />
            <option value="その他" />
          </datalist>
          <button type="button" onClick={handleAdd} disabled={adding} style={{ ...buttonStyle, opacity: adding ? 0.6 : 1 }}>
            {adding ? '追加中…' : '追加'}
          </button>
        </div>
        {addError && (
          <p style={{ fontFamily: HQ_SANS, fontSize: 11.5, color: HQ_COLORS.negative, margin: 0, marginTop: 8 }}>
            {addError}
          </p>
        )}
      </HqPanel>

      {state.phase === 'loading' && (
        <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textSecondary }}>
          読み込み中…
        </p>
      )}

      {state.phase === 'error' && (
        <div style={{
          background: 'rgba(140,31,26,0.10)', border: `1px solid ${HQ_COLORS.red}`,
          borderRadius: 4, padding: '16px 18px',
        }}>
          <p style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.negative, margin: 0 }}>
            {state.message}
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <HqPanel title="商品一覧" code={`${state.products.length}件`}>
          {state.products.length === 0 ? (
            <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
              商品が登録されていません
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              {PRODUCT_CATEGORIES.map((cat) => {
                const products = state.products.filter((p) => p.category === cat)
                if (products.length === 0) return null
                return (
                  <div key={cat}>
                    <p style={{
                      fontFamily: HQ_SANS, fontSize: 12, letterSpacing: '0.1em', fontWeight: 700,
                      color: HQ_COLORS.goldHi, margin: '0 0 8px',
                    }}>
                      {cat}
                    </p>
                    {/* 列数が多いため横スクロールでラップ（狭い画面でも列が潰れない） */}
                    <div style={{ width: '100%', overflowX: 'auto' }}>
                    <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontFamily: HQ_SANS }}>
                      <thead>
                        <tr>
                          {['商品名', 'カテゴリー', '現在庫', '最低在庫', '価格', 'サブカテゴリー', '状態', '在庫操作', ''].map((label) => (
                            <th key={label} style={{
                              textAlign: 'left', fontSize: 10, letterSpacing: '0.08em',
                              color: HQ_COLORS.textMute, fontWeight: 500, padding: '0 8px 10px 0',
                              borderBottom: `1px solid ${HQ_COLORS.panelBorder}`,
                              whiteSpace: 'nowrap',
                            }}>
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {products.map((p) => {
                          const status = getStockStatus(p.current_stock, p.min_stock)
                          const isEditing = editingId === p.id
                          return (
                            <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                              <td style={{ padding: '10px 8px 10px 0', fontSize: 12.5 }}>
                                {isEditing ? (
                                  <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ ...inputStyle, width: 140 }} />
                                ) : (
                                  <span style={{ color: HQ_COLORS.textPrimary }}>{p.name}</span>
                                )}
                              </td>
                              <td style={{ padding: '10px 8px 10px 0', fontSize: 12.5 }}>
                                {isEditing ? (
                                  <select
                                    value={editCategory}
                                    onChange={(e) => setEditCategory(e.target.value as ProductCategory)}
                                    style={{ ...inputStyle, width: 100 }}
                                  >
                                    {PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                                  </select>
                                ) : (
                                  <span style={{ color: HQ_COLORS.textSecondary }}>{p.category}</span>
                                )}
                              </td>
                              <td style={{ padding: '10px 8px 10px 0', fontSize: 13, fontFamily: HQ_MONO, color: HQ_COLORS.textPrimary }}>
                                {p.current_stock}
                              </td>
                              <td style={{ padding: '10px 8px 10px 0', fontSize: 12.5 }}>
                                {isEditing ? (
                                  <input
                                    type="number" inputMode="numeric"
                                    value={editMinStock} onChange={(e) => setEditMinStock(e.target.value)}
                                    style={{ ...inputStyle, width: 70 }}
                                  />
                                ) : (
                                  <span style={{ fontFamily: HQ_MONO, color: HQ_COLORS.textSecondary }}>{p.min_stock}</span>
                                )}
                              </td>
                              <td style={{ padding: '10px 8px 10px 0', fontSize: 12.5 }}>
                                {isEditing ? (
                                  <input
                                    type="number" inputMode="numeric"
                                    value={editPrice} onChange={(e) => setEditPrice(e.target.value)}
                                    style={{ ...inputStyle, width: 80 }}
                                  />
                                ) : (
                                  <span style={{ fontFamily: HQ_MONO, color: HQ_COLORS.textSecondary }}>¥{(p.price ?? 0).toLocaleString()}</span>
                                )}
                              </td>
                              <td style={{ padding: '10px 8px 10px 0', fontSize: 12.5 }}>
                                {isEditing ? (
                                  editCategory === '店販' ? (
                                    <input
                                      value={editAccountingGroup} onChange={(e) => setEditAccountingGroup(e.target.value)}
                                      list="hq-accounting-group-options"
                                      placeholder="その他"
                                      style={{ ...inputStyle, width: 130 }}
                                    />
                                  ) : (
                                    <span style={{ color: HQ_COLORS.textMute }}>—</span>
                                  )
                                ) : (
                                  <span style={{ color: HQ_COLORS.textSecondary }}>
                                    {p.category === '店販' ? (p.accounting_group?.trim() || 'その他') : '—'}
                                  </span>
                                )}
                              </td>
                              <td style={{ padding: '10px 8px 10px 0', fontSize: 12.5, whiteSpace: 'nowrap', color: STATUS_COLOR[status] }}>
                                {STATUS_LABEL[status]}
                              </td>
                              <td style={{ padding: '10px 8px 10px 0', whiteSpace: 'nowrap' }}>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <input
                                    placeholder="1"
                                    type="number" inputMode="numeric"
                                    value={qtyInputs[p.id] ?? ''}
                                    onChange={(e) => setQtyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                    style={{ ...inputStyle, width: 56 }}
                                  />
                                  <button
                                    type="button" onClick={() => handleAdjust(p.id, -1)}
                                    disabled={adjustingId === p.id}
                                    style={{ ...ghostButtonStyle, padding: '4px 10px' }}
                                  >
                                    − 出庫
                                  </button>
                                  <button
                                    type="button" onClick={() => handleAdjust(p.id, 1)}
                                    disabled={adjustingId === p.id}
                                    style={{ ...buttonStyle, padding: '4px 10px' }}
                                  >
                                    ＋ 入庫
                                  </button>
                                </div>
                              </td>
                              <td style={{ padding: '10px 0 10px 0', whiteSpace: 'nowrap' }}>
                                {isEditing ? (
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <button type="button" onClick={handleSaveEdit} disabled={savingEdit} style={{ ...buttonStyle, padding: '4px 10px' }}>
                                      保存
                                    </button>
                                    <button type="button" onClick={() => setEditingId(null)} style={{ ...ghostButtonStyle, padding: '4px 10px' }}>
                                      キャンセル
                                    </button>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <button type="button" onClick={() => startEdit(p)} style={{ ...ghostButtonStyle, padding: '4px 10px' }}>
                                      編集
                                    </button>
                                    <button
                                      type="button" onClick={() => setDeleteTarget(p)}
                                      style={{ ...ghostButtonStyle, padding: '4px 10px', color: HQ_COLORS.negative, borderColor: 'rgba(216,107,92,0.4)' }}
                                    >
                                      削除
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </HqPanel>
      )}

      {deleteTarget && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{
            width: '100%', maxWidth: 360, borderRadius: 6, background: HQ_COLORS.panel,
            border: `1px solid ${HQ_COLORS.panelBorderStrong}`, padding: 22,
          }}>
            <p style={{ fontFamily: HQ_SANS, fontSize: 14, fontWeight: 700, color: HQ_COLORS.textPrimary, margin: 0, marginBottom: 6 }}>
              商品を削除しますか？
            </p>
            <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 18 }}>
              「{deleteTarget.name}」を削除します。この操作は元に戻せません。
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleting} style={ghostButtonStyle}>
                いいえ
              </button>
              <button
                type="button" onClick={() => void handleConfirmDelete()} disabled={deleting}
                style={{ ...buttonStyle, background: 'rgba(216,107,92,0.16)', borderColor: HQ_COLORS.negative, color: HQ_COLORS.negative }}
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
