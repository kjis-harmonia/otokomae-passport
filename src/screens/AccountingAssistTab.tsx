import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getJapanDateString } from '../utils/dateUtils'
import { getUserTickets, markTicketUsed } from '../utils/ticketStore'
import {
  getCustomerByUserId, findCustomersByNormalizedName, createGuestCustomer, getLastVisitDateForUser,
} from '../utils/customerStore'
import type { CustomerRow } from '../utils/customerStore'
import { TICKET_TYPE_LABELS } from '../data/ticket'
import {
  getAccountingItems, createAccountingItem, updateAccountingItem, createAccountingSession, setAccountingSessionStatus,
} from '../utils/accountingStore'
import type { AccountingItem, AccountingCategory, PaymentMethod } from '../utils/accountingStore'
import {
  QrCameraScanner, parseQR, saveUsageLog, fetchTodayUsedType, canUseDiscountType, upsertLastVisitDate, playSuccessSound,
} from './AdminScreen'
import type { TicketUseQRData, MaintenanceCouponQRData, PassportQRData } from './AdminScreen'
import { deductStockForRetailSale, getProducts } from '../hq/hqInventoryStore'
import type { Product } from '../hq/hqInventoryStore'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const QR_EL_ID_ACCOUNTING = 'gj-qr-reader-accounting'
const MAINTENANCE_COUPON_ITEM_ID = '__maintenance_coupon__'

const DISCOUNT_TYPE_LABEL: Record<string, string> = {
  otoku: '漢トク券',
  discount: '割引券',
  coupon: 'メンテナンスクーポン',
}

const CATEGORY_LABELS: Record<AccountingCategory, string> = {
  menu: 'メニュー',
  option: 'オプション',
  retail: '店販',
}

// 施術担当（売上集計の担当別フィルタ用。LIVE STATUSの座席名と揃える）
const STYLISTS = ['テイテイ', '銀二郎', 'フリー'] as const

const PAYMENT_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: 'cash',   label: '現金' },
  { id: 'credit', label: 'クレジット' },
  { id: 'qr',     label: 'QR' },
]

const RETAIL_GROUP_FALLBACK = 'その他'

/** 会計の選択カート用に共通化した行アイテム形（menu/option は accounting_items、retail は products由来）。 */
interface SelectableLineItem {
  id: string
  name: string
  price: number
  category: AccountingCategory
}

/** 店販商品を accounting_group（未設定は「その他」）でグルーピングし、出現順を保つ。 */
function getAccountingGroups(retailLineItems: { accountingGroup: string }[]): string[] {
  const seen = new Set<string>()
  const groups: string[] = []
  for (const item of retailLineItems) {
    if (!seen.has(item.accountingGroup)) { seen.add(item.accountingGroup); groups.push(item.accountingGroup) }
  }
  return groups
}

interface AppliedDiscount {
  ticketId: string | null   // null = メンテナンスクーポン（ticket行を持たない）
  ticketType: string        // 'otoku' | 'discount' | 'coupon'
  label: string
  amount: number
}

interface AccountingCustomer {
  userId: string
  name: string
}

// ── 初期商品マスタ（accounting_items テーブルが空のときのフォールバック表示） ─────
// Supabase 側に schema.sql の seed が入っていれば、これは使われない（DB優先）。

export function AccountingAssistTab({ staffId }: { staffId: string }) {
  const [items, setItems] = useState<AccountingItem[]>([])
  const [retailProducts, setRetailProducts] = useState<Product[]>([])
  const [itemsLoading, setItemsLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [customer, setCustomer] = useState<AccountingCustomer | null>(null)
  const [discount, setDiscount] = useState<AppliedDiscount | null>(null)
  const [stylistName, setStylistName] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null)

  const [showScanner, setShowScanner] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanLoading, setScanLoading] = useState(false)

  const [showManager, setShowManager] = useState(false)
  const [retailGroupView, setRetailGroupView] = useState<string | null>(null)

  // ── QRなし会計：名前入力 / 既存顧客候補 / 新規ゲスト登録 ──
  const [guestNameInput, setGuestNameInput] = useState('')
  const [guestCandidates, setGuestCandidates] = useState<CustomerRow[] | null>(null)
  const [guestSearchLoading, setGuestSearchLoading] = useState(false)
  const [guestLastVisit, setGuestLastVisit] = useState<Record<string, string | null>>({})
  const [guestCreating, setGuestCreating] = useState(false)
  const [guestError, setGuestError] = useState<string | null>(null)

  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [showCompleteSuccess, setShowCompleteSuccess] = useState(false)
  const [stockWarning, setStockWarning] = useState<string | null>(null)

  const loadItems = useCallback(async () => {
    setItemsLoading(true)
    const [accItems, products] = await Promise.all([
      getAccountingItems({ activeOnly: true }),
      getProducts(),
    ])
    // 店販(retail)は products(category='店販') を正として使うため、accounting_items 側の
    // retail行（既存データ）はここでは menu/option 用の一覧から除外する。
    setItems(accItems.filter(i => i.category !== 'retail'))
    setRetailProducts(products.filter(p => p.category === '店販'))
    setItemsLoading(false)
  }, [])

  useEffect(() => { void loadItems() }, [loadItems])

  // ── 名前入力時、既存顧客候補を検索（正規化名一致） ──
  useEffect(() => {
    if (customer) return
    const trimmed = guestNameInput.trim()
    if (!trimmed) {
      setGuestCandidates(null)
      setGuestLastVisit({})
      setGuestSearchLoading(false)
      return
    }
    let cancelled = false
    setGuestSearchLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        const results = await findCustomersByNormalizedName(trimmed)
        if (cancelled) return
        setGuestCandidates(results)
        const visits = await Promise.all(results.map(c => getLastVisitDateForUser(c.user_id)))
        if (cancelled) return
        const map: Record<string, string | null> = {}
        results.forEach((c, i) => { map[c.user_id] = visits[i] })
        setGuestLastVisit(map)
        setGuestSearchLoading(false)
      })()
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [guestNameInput, customer])

  function handleSelectCandidate(c: CustomerRow) {
    setCustomer({ userId: c.user_id, name: c.name })
    setGuestNameInput('')
    setGuestCandidates(null)
    setGuestLastVisit({})
    setGuestError(null)
  }

  async function handleCreateGuest() {
    const trimmed = guestNameInput.trim()
    if (!trimmed || guestCreating) return
    setGuestCreating(true)
    setGuestError(null)
    const created = await createGuestCustomer(trimmed)
    setGuestCreating(false)
    if (!created) {
      setGuestError('ゲスト登録に失敗しました。通信環境を確認してから再度お試しください。')
      return
    }
    setCustomer({ userId: created.user_id, name: created.name })
    setGuestNameInput('')
    setGuestCandidates(null)
    setGuestLastVisit({})
  }

  function toggleItem(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const allLineItems: SelectableLineItem[] = [
    ...items.map(i => ({ id: i.id, name: i.name, price: i.price ?? 0, category: i.category })),
    ...retailProducts.map(p => ({ id: p.id, name: p.name, price: p.price ?? 0, category: 'retail' as const })),
  ]
  // メンテナンスクーポンは「3,000円割引」ではなく「メンテナンスカットを3,000円で受けられる券」
  // ──割引ではなく、¥3,000のメニュー1点として会計に入れる（会計履歴・日報・本部売上にも
  // 通常の売上として正しく記録されるようにするため）。
  const isMaintenanceCoupon = discount?.ticketType === 'coupon'
  const maintenanceCouponItem: SelectableLineItem | null = isMaintenanceCoupon
    ? { id: MAINTENANCE_COUPON_ITEM_ID, name: 'メンテナンスカット', price: discount!.amount, category: 'menu' }
    : null
  const selectedItems = [
    ...allLineItems.filter(i => selectedIds.has(i.id)),
    ...(maintenanceCouponItem ? [maintenanceCouponItem] : []),
  ]
  const subtotal = selectedItems.reduce((sum, i) => sum + i.price, 0)
  const discountTotal = isMaintenanceCoupon ? 0 : (discount?.amount ?? 0)
  const total = Math.max(0, subtotal - discountTotal)
  const canComplete = staffId.trim() !== '' && stylistName !== null && paymentMethod !== null && selectedItems.length > 0 && !completing

  async function handleScan(text: string) {
    setScanLoading(true)
    setScanError(null)
    const parsed = parseQR(text)
    if (!parsed) {
      setScanError('認識できないQRコードです。')
      setScanLoading(false)
      return
    }

    const today = getJapanDateString()

    // ── 漢トク券・割引券（チケット使用QR） ──
    if (parsed.type === 'ginjiro-ticket-use') {
      const tu = parsed as TicketUseQRData
      if (new Date() > new Date(tu.expiresAt)) {
        setScanError('このチケットQRは期限切れです。')
        setScanLoading(false)
        return
      }
      try {
        const tickets = await getUserTickets(tu.userId)
        const ticket = tickets.find(t => t.id === tu.selectedTicketId)
        if (!ticket) {
          setScanError('チケットが見つかりません。')
          setScanLoading(false)
          return
        }
        if (ticket.used) {
          setScanError('このチケットはすでに使用済みです。')
          setScanLoading(false)
          return
        }
        const usedType = await fetchTodayUsedType(tu.userId, today)
        if (!canUseDiscountType(usedType, ticket.type)) {
          setScanError(
            `本日は${usedType ? DISCOUNT_TYPE_LABEL[usedType] ?? usedType : '他の割引'}をご利用済みのため使用できません。`
            + '割引の併用は1日1種類までです。',
          )
          setScanLoading(false)
          return
        }
        const cust = await getCustomerByUserId(tu.userId)
        setCustomer({ userId: tu.userId, name: cust?.name ?? 'お客様' })
        setDiscount({
          ticketId: ticket.id,
          ticketType: ticket.type,
          label: TICKET_TYPE_LABELS[ticket.type] ?? ticket.title,
          amount: ticket.amount,
        })
        setShowScanner(false)
      } catch {
        setScanError('チケット情報の取得に失敗しました。')
      } finally {
        setScanLoading(false)
      }
      return
    }

    // ── メンテナンスクーポン ──
    if (parsed.type === 'ginjiro-maintenance-coupon') {
      const mc = parsed as MaintenanceCouponQRData
      const usedType = await fetchTodayUsedType(mc.userId, today)
      if (!canUseDiscountType(usedType, 'coupon')) {
        setScanError(
          `本日は${usedType ? DISCOUNT_TYPE_LABEL[usedType] ?? usedType : '他の割引'}をご利用済みのため使用できません。`
          + 'メンテナンスクーポンは1日1回、他の割引との併用も不可です。',
        )
        setScanLoading(false)
        return
      }
      setCustomer({ userId: mc.userId, name: mc.name })
      setDiscount({ ticketId: null, ticketType: 'coupon', label: 'メンテナンスクーポン', amount: 3000 })
      setShowScanner(false)
      setScanLoading(false)
      return
    }

    // ── 会員QR（お客様の特定のみ。割引なし） ──
    const passport = parsed as PassportQRData
    setCustomer({ userId: passport.userId, name: passport.name })
    setShowScanner(false)
    setScanLoading(false)
  }

  function handleRemoveDiscount() {
    setDiscount(null)
  }

  async function handleComplete() {
    if (!canComplete) return
    if (!paymentMethod) {
      setCompleteError('支払い方法を選択してください')
      return
    }
    setCompleting(true)
    setCompleteError(null)
    const today = getJapanDateString()

    try {
      // ── 1. 直前再検証（QR読み込み時から状態が変わっていないか） ──
      if (discount?.ticketId) {
        const tickets = await getUserTickets(customer?.userId ?? '')
        const ticket = tickets.find(t => t.id === discount.ticketId)
        if (!ticket) {
          setCompleteError('チケットが見つかりません。会計を中止しました。')
          setCompleting(false)
          return
        }
        if (ticket.used) {
          setCompleteError('このチケットはすでに使用済みです。')
          setCompleting(false)
          return
        }
      } else if (discount && customer) {
        const usedType = await fetchTodayUsedType(customer.userId, today)
        if (!canUseDiscountType(usedType, discount.ticketType)) {
          setCompleteError('本日のメンテナンスクーポンはすでに使用済みか、他の割引と併用しています。')
          setCompleting(false)
          return
        }
      }

      // ── 2. 会計履歴を先に保存（status='pending'） ──
      // チケットused化より必ず先に行う。これにより「チケットだけ使用済みになり
      // 会計履歴が残らない」事故を防ぐ（会計履歴が無ければチケットには一切触れない）。
      const { sessionId, ok: sessionOk } = await createAccountingSession({
        user_id: customer?.userId ?? null,
        customer_name: customer?.name ?? null,
        staff_name: staffId,
        stylist_name: stylistName ?? '',
        payment_method: paymentMethod,
        subtotal,
        discount_total: discountTotal,
        total,
        used_ticket_ids: discount?.ticketId ? [discount.ticketId] : [],
        items: selectedItems.map(i => ({
          item_id: i.id, item_name: i.name, category: i.category, price: i.price, quantity: 1,
        })),
      })
      if (!sessionOk || !sessionId) {
        setCompleteError('会計履歴の保存に失敗しました。通信環境を確認してから再度お試しください。')
        setCompleting(false)
        return
      }

      // ── 3. チケットused化 / メンテナンス使用ログ保存・来店日更新 ──
      // 会計履歴は既に保存済みなので、ここで失敗してもチケットは未使用のまま残り、
      // 「チケットused化だけ成功して会計履歴が残らない」状態には絶対にならない。
      try {
        if (discount?.ticketId) {
          await markTicketUsed(discount.ticketId, staffId)
          await saveUsageLog({
            usage_date: today,
            staff_name: staffId,
            customer_name: customer?.name ?? '',
            user_id: customer?.userId ?? '',
            ticket_id: discount.ticketId,
            ticket_type: discount.ticketType,
            amount: discount.amount,
            terminal: 'staff-terminal',
            status: 'used',
          })
        } else if (discount && customer) {
          // メンテナンスクーポン（ticket行を持たない）も使用ログに残す
          await saveUsageLog({
            usage_date: today,
            staff_name: staffId,
            customer_name: customer.name,
            user_id: customer.userId,
            ticket_id: null,
            ticket_type: 'coupon',
            amount: 0,
            terminal: 'staff-terminal',
            status: 'used',
          })
        }

        // ── 4. 来店日更新 ──
        if (customer) {
          await upsertLastVisitDate(customer.userId, today)
        }
      } catch (innerErr) {
        await setAccountingSessionStatus(sessionId, 'failed')
        setCompleteError(
          `会計履歴は保存されましたが、チケット処理に失敗しました（会計ID: ${sessionId.slice(0, 8)}）。` +
          `スタッフへご連絡のうえ、手動でチケットを使用済みにしてください。` +
          `（${innerErr instanceof Error ? innerErr.message : 'ネットワークエラー'}）`,
        )
        setCompleting(false)
        return
      }

      // ── 5. 完了 ──
      await setAccountingSessionStatus(sessionId, 'completed')

      // ── 6. 店販在庫の自動減算（銀二郎本部 products 連携） ──
      // 会計履歴は既にcompletedで確定済みなので、ここで何が起きても会計完了自体は
      // 成功扱いのまま変えない。失敗時はスタッフに控えめな注意だけ表示する。
      const retailItems = selectedItems
        .filter(i => i.category === 'retail')
        .map(i => ({ itemName: i.name, quantity: 1 }))
      if (retailItems.length > 0) {
        try {
          const { anyFailure } = await deductStockForRetailSale(retailItems)
          if (anyFailure) setStockWarning('会計は完了しましたが、在庫更新に失敗しました。')
        } catch (stockErr) {
          console.error('[AccountingAssistTab] 在庫連携エラー:', stockErr)
          setStockWarning('会計は完了しましたが、在庫更新に失敗しました。')
        }
      }

      playSuccessSound()
      setShowCompleteSuccess(true)
      setTimeout(() => {
        setShowCompleteSuccess(false)
        setStockWarning(null)
        setSelectedIds(new Set())
        setCustomer(null)
        setDiscount(null)
        setStylistName(null)
        setPaymentMethod(null)
        setGuestNameInput('')
        setGuestCandidates(null)
        setGuestLastVisit({})
        setGuestError(null)
        setRetailGroupView(null)
      }, 2200)
    } catch (err) {
      setCompleteError(`会計完了に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      setCompleting(false)
    }
  }

  const byCategory = (cat: AccountingCategory) => items.filter(i => i.category === cat)

  return (
    <div style={{ paddingBottom: 400 }}>
      {/* ── 顧客 / QR読み込み ── */}
      <div style={{
        borderRadius: 16, border: '1px solid rgba(201,162,74,0.22)',
        background: '#0A0A0A', padding: '14px 16px', marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: discount ? 10 : 0 }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 10, letterSpacing: '0.12em', color: '#e5e5e5', marginBottom: 4 }}>お客様</p>
            <p style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {customer ? `${customer.name} 様` : '未読み込み（任意）'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setShowScanner(true); setScanError(null) }}
            style={{
              flexShrink: 0, padding: '11px 18px', borderRadius: 12,
              background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
              border: '1px solid rgba(201,162,74,0.5)', color: '#ffffff',
              fontFamily: SERIF, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer',
            }}
          >
            QRを読み込む
          </button>
        </div>

        {/* ── QR未読み込み時：名前入力で既存顧客に紐付け／新規ゲスト登録 ── */}
        {!customer && (
          <div style={{ marginTop: 12 }}>
            <input
              type="text"
              value={guestNameInput}
              onChange={e => setGuestNameInput(e.target.value)}
              placeholder="お名前を入力"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 12,
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.16)',
                color: '#ffffff', fontSize: 15, fontFamily: SERIF, outline: 'none',
              }}
            />

            {guestSearchLoading && (
              <p style={{ fontSize: 11, color: '#999999', marginTop: 6 }}>候補を検索中…</p>
            )}

            {!guestSearchLoading && guestCandidates && guestCandidates.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <p style={{ fontSize: 11, letterSpacing: '0.08em', color: '#C9A24A', marginBottom: 6 }}>既存のお客様候補</p>
                {guestCandidates.map(c => (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    borderRadius: 10, background: 'rgba(201,162,74,0.08)', border: '1px solid rgba(201,162,74,0.3)',
                    padding: '10px 12px', marginBottom: 6,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: '#ffffff' }}>{c.name}</p>
                      <p style={{ fontSize: 11, color: '#999999', marginTop: 2 }}>
                        前回来店：{guestLastVisit[c.user_id] ? guestLastVisit[c.user_id]!.replace(/-/g, '/') : 'なし'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectCandidate(c)}
                      style={{
                        flexShrink: 0, padding: '8px 12px', borderRadius: 8, background: 'rgba(201,162,74,0.18)',
                        border: '1px solid #C9A24A', color: '#C9A24A', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      このお客様に紐付け
                    </button>
                  </div>
                ))}
              </div>
            )}

            {guestNameInput.trim() !== '' && (
              <button
                type="button"
                onClick={() => void handleCreateGuest()}
                disabled={guestCreating}
                style={{
                  width: '100%', marginTop: 8, padding: '11px 0', borderRadius: 10,
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.16)',
                  color: '#e5e5e5', fontSize: 13, fontFamily: SERIF, letterSpacing: '0.06em',
                  cursor: guestCreating ? 'default' : 'pointer',
                }}
              >
                {guestCreating ? '登録中…' : '新規ゲストとして登録'}
              </button>
            )}

            {guestError && (
              <p style={{ fontSize: 12, color: '#E06060', marginTop: 8 }}>{guestError}</p>
            )}
          </div>
        )}

        {discount && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            borderRadius: 10, background: 'rgba(201,162,74,0.10)', border: '1px solid rgba(201,162,74,0.4)',
            padding: '8px 12px',
          }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#C9A24A', fontFamily: SERIF }}>
              {isMaintenanceCoupon
                ? `メンテナンスカット ¥${discount.amount.toLocaleString()} 適用中`
                : `${discount.label} 適用中 -¥${discount.amount.toLocaleString()}`}
            </p>
            <button
              type="button"
              onClick={handleRemoveDiscount}
              style={{ flexShrink: 0, padding: '5px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontSize: 11, cursor: 'pointer' }}
            >
              解除
            </button>
          </div>
        )}
      </div>

      {/* ── 施術スタイリスト選択 ── */}
      <div style={{ marginBottom: 18 }}>
        <p style={{ fontSize: 12, letterSpacing: '0.16em', color: '#ffffff', fontWeight: 700, marginBottom: 10 }}>
          スタイリスト
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          {STYLISTS.map(name => {
            const selected = stylistName === name
            return (
              <button
                key={name}
                type="button"
                onClick={() => setStylistName(name)}
                style={{
                  flex: 1, borderRadius: 12, padding: '14px 6px', textAlign: 'center',
                  background: selected ? 'rgba(201,162,74,0.16)' : '#0A0A0A',
                  border: `1.5px solid ${selected ? '#C9A24A' : 'rgba(255,255,255,0.12)'}`,
                  boxShadow: selected ? '0 0 18px rgba(201,162,74,0.30)' : 'none',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: selected ? '#C9A24A' : '#ffffff' }}>
                  {name}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── 商品選択：メニュー・オプション（フラット表示） ── */}
      {itemsLoading ? (
        <p style={{ textAlign: 'center', color: '#e5e5e5', fontSize: 13, padding: '24px 0' }}>読み込み中…</p>
      ) : (
        (['menu', 'option'] as AccountingCategory[]).map(cat => (
          <div key={cat} style={{ marginBottom: 22 }}>
            <p style={{ fontSize: 12, letterSpacing: '0.16em', color: '#ffffff', fontWeight: 700, marginBottom: 10 }}>
              {CATEGORY_LABELS[cat]}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {byCategory(cat).map(item => {
                const selected = selectedIds.has(item.id)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleItem(item.id)}
                    style={{
                      borderRadius: 14, padding: '14px 10px', textAlign: 'left',
                      background: selected ? 'rgba(201,162,74,0.16)' : '#0A0A0A',
                      border: `1.5px solid ${selected ? '#C9A24A' : 'rgba(255,255,255,0.12)'}`,
                      boxShadow: selected ? '0 0 18px rgba(201,162,74,0.30)' : 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <p style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: selected ? '#C9A24A' : '#ffffff', lineHeight: 1.3, marginBottom: 4 }}>
                      {item.name}
                    </p>
                    <p style={{ fontSize: 13, fontWeight: 700, color: selected ? '#C9A24A' : '#e5e5e5' }}>
                      ¥{(item.price ?? 0).toLocaleString()}
                    </p>
                  </button>
                )
              })}
              {byCategory(cat).length === 0 && (
                <p style={{ fontSize: 12, color: '#999999', gridColumn: '1 / -1' }}>登録されている商品がありません</p>
              )}
            </div>
          </div>
        ))
      )}

      {/* ── 商品選択：店販（products由来。カテゴリータップ→該当商品のみ表示） ── */}
      {!itemsLoading && (() => {
        const retailLineItems = retailProducts.map(p => ({
          id: p.id, name: p.name, price: p.price ?? 0,
          accountingGroup: p.accounting_group?.trim() || RETAIL_GROUP_FALLBACK,
        }))
        const retailGroups = getAccountingGroups(retailLineItems)
        return (
          <div style={{ marginBottom: 22 }}>
            <p style={{ fontSize: 12, letterSpacing: '0.16em', color: '#ffffff', fontWeight: 700, marginBottom: 10 }}>
              {CATEGORY_LABELS.retail}
            </p>

            {retailGroupView === null ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {retailGroups.map(group => {
                  const count = retailLineItems.filter(i => i.accountingGroup === group).length
                  return (
                    <button
                      key={group}
                      type="button"
                      onClick={() => setRetailGroupView(group)}
                      style={{
                        borderRadius: 14, padding: '16px 12px', textAlign: 'left',
                        background: '#0A0A0A', border: '1.5px solid rgba(201,162,74,0.4)', cursor: 'pointer',
                      }}
                    >
                      <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#C9A24A', marginBottom: 4 }}>
                        {group}
                      </p>
                      <p style={{ fontSize: 11, color: '#999999' }}>{count}点</p>
                    </button>
                  )
                })}
                {retailGroups.length === 0 && (
                  <p style={{ fontSize: 12, color: '#999999', gridColumn: '1 / -1' }}>登録されている商品がありません</p>
                )}
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  onClick={() => setRetailGroupView(null)}
                  style={{
                    padding: '8px 14px', borderRadius: 10, marginBottom: 10,
                    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.16)',
                    color: '#e5e5e5', fontSize: 12, fontFamily: SERIF, letterSpacing: '0.04em', cursor: 'pointer',
                  }}
                >
                  ← カテゴリーへ戻る
                </button>
                <p style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, color: '#C9A24A', marginBottom: 10 }}>
                  {retailGroupView}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {retailLineItems
                    .filter(i => i.accountingGroup === retailGroupView)
                    .map(item => {
                      const selected = selectedIds.has(item.id)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleItem(item.id)}
                          style={{
                            borderRadius: 14, padding: '14px 10px', textAlign: 'left',
                            background: selected ? 'rgba(201,162,74,0.16)' : '#0A0A0A',
                            border: `1.5px solid ${selected ? '#C9A24A' : 'rgba(255,255,255,0.12)'}`,
                            boxShadow: selected ? '0 0 18px rgba(201,162,74,0.30)' : 'none',
                            cursor: 'pointer',
                          }}
                        >
                          <p style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 700, color: selected ? '#C9A24A' : '#ffffff', lineHeight: 1.3, marginBottom: 4 }}>
                            {item.name}
                          </p>
                          <p style={{ fontSize: 13, fontWeight: 700, color: selected ? '#C9A24A' : '#e5e5e5' }}>
                            ¥{item.price.toLocaleString()}
                          </p>
                        </button>
                      )
                    })}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── 選択中の商品（注文内容サマリー） ── */}
      {selectedItems.length > 0 && (
        <div style={{
          borderRadius: 14, border: '1px solid rgba(201,162,74,0.2)',
          background: '#0A0A0A', padding: '12px 14px', marginBottom: 14,
        }}>
          <p style={{ fontSize: 11, letterSpacing: '0.1em', color: '#e5e5e5', marginBottom: 8 }}>選択中の商品</p>
          <div style={{ maxHeight: 160, overflowY: 'auto' }}>
            {selectedItems.map(i => (
              <div
                key={i.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', fontSize: 13,
                  color: i.id === MAINTENANCE_COUPON_ITEM_ID ? '#C9A24A' : '#ffffff', marginBottom: 4,
                }}
              >
                <span>{i.name}</span>
                <span>¥{(i.price ?? 0).toLocaleString()}</span>
              </div>
            ))}
            {discount && !isMaintenanceCoupon && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#C9A24A', marginBottom: 4 }}>
                <span>{discount.label}</span>
                <span>-¥{discount.amount.toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowManager(true)}
        style={{
          width: '100%', padding: '12px', borderRadius: 12, background: 'transparent',
          border: '1px solid rgba(201,162,74,0.24)', color: '#e5e5e5', fontSize: 13,
          letterSpacing: '0.1em', cursor: 'pointer', fontFamily: SERIF,
        }}
      >
        商品マスタを編集
      </button>

      {/* ── 固定フッター: 支払い方法・合計・会計完了（1つの会計エリアにまとめる） ── */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
        display: 'flex', flexDirection: 'column', gap: 10,
        background: '#070707', borderTop: '1px solid rgba(201,162,74,0.28)',
        boxShadow: '0 -10px 28px rgba(0,0,0,0.7)',
        padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
      }}>
        {/* 支払い方法 */}
        <div style={{ display: 'flex', gap: 8 }}>
          {PAYMENT_METHODS.map(m => {
            const selected = paymentMethod === m.id
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setPaymentMethod(m.id)}
                style={{
                  flex: 1, padding: '10px 4px', borderRadius: 10, textAlign: 'center',
                  background: selected ? 'rgba(201,162,74,0.18)' : 'rgba(255,255,255,0.04)',
                  border: `1.5px solid ${selected ? '#C9A24A' : 'rgba(255,255,255,0.12)'}`,
                  boxShadow: selected ? '0 0 14px rgba(201,162,74,0.30)' : 'none',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontFamily: SERIF, fontSize: 13, fontWeight: 700, color: selected ? '#C9A24A' : '#e5e5e5' }}>
                  {m.label}
                </span>
              </button>
            )
          })}
        </div>

        {/* 合計 */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: '#ffffff', letterSpacing: '0.1em' }}>合計</span>
          <span style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 700, color: '#ffffff' }}>
            ¥{total.toLocaleString()}
          </span>
        </div>

        {/* エラーメッセージ */}
        {(completeError || !staffId.trim() || stylistName === null || paymentMethod === null) && (
          <div>
            {completeError && (
              <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center' }}>{completeError}</p>
            )}
            {!staffId.trim() && (
              <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center' }}>先に担当者を選択してください</p>
            )}
            {staffId.trim() && stylistName === null && (
              <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center' }}>スタイリストを選択してください</p>
            )}
            {staffId.trim() && stylistName !== null && paymentMethod === null && (
              <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center' }}>支払い方法を選択してください</p>
            )}
          </div>
        )}

        {/* 会計完了ボタン */}
        <button
          onClick={() => void handleComplete()}
          disabled={!canComplete}
          style={{
            width: '100%', height: 60, borderRadius: 16,
            background: canComplete ? 'linear-gradient(90deg, #800c14 0%, #3a0307 100%)' : 'rgba(255,255,255,0.04)',
            border: `2px solid ${canComplete ? '#e6ca65' : 'rgba(255,255,255,0.1)'}`,
            color: canComplete ? '#ffffff' : '#999999',
            fontFamily: SERIF, fontSize: 18, fontWeight: 700, letterSpacing: '0.2em',
            cursor: canComplete ? 'pointer' : 'default',
          }}
        >
          {completing ? '処理中…' : '会計完了'}
        </button>
      </div>

      {/* ── QRスキャナーモーダル ── */}
      <AnimatePresence>
        {showScanner && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.94)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
              style={{ width: '100%', maxWidth: 380, borderRadius: 20, background: '#0A0A0A', border: '1px solid rgba(201,162,74,0.3)', padding: 20 }}
            >
              <p style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 700, color: '#ffffff', textAlign: 'center', marginBottom: 12 }}>
                会員QR / チケットQR / クーポンQR
              </p>
              <QrCameraScanner
                elId={QR_EL_ID_ACCOUNTING}
                onScan={text => { void handleScan(text) }}
                onCameraError={msg => setScanError(msg)}
              />
              {scanLoading && <p style={{ fontSize: 12, color: '#e5e5e5', textAlign: 'center', marginTop: 10 }}>確認中…</p>}
              {scanError && <p style={{ fontSize: 12, color: '#E06060', textAlign: 'center', marginTop: 10 }}>{scanError}</p>}
              <button
                type="button"
                onClick={() => setShowScanner(false)}
                style={{ width: '100%', marginTop: 14, padding: '12px 0', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 13, letterSpacing: '0.1em', cursor: 'pointer' }}
              >
                閉じる
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── 商品マスタ管理モーダル ── */}
      <AnimatePresence>
        {showManager && (
          <ItemManagerModal
            items={items}
            onClose={() => setShowManager(false)}
            onChanged={loadItems}
          />
        )}
      </AnimatePresence>

      {/* ── 会計完了 成功オーバーレイ ── */}
      <AnimatePresence>
        {showCompleteSuccess && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              style={{ textAlign: 'center' }}
            >
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(100,200,100,0.12)', border: '1px solid rgba(100,200,100,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <span style={{ fontSize: 30, color: '#80E060' }}>✓</span>
              </div>
              <p style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: '#ffffff' }}>会計完了しました</p>
              <p style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: '#C9A24A', marginTop: 8 }}>¥{total.toLocaleString()}</p>
              {stockWarning && (
                <p style={{ fontSize: 12, color: '#E0B84A', marginTop: 12, maxWidth: 280 }}>{stockWarning}</p>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── 商品マスタ管理モーダル ────────────────────────────────────────────────────

function ItemManagerModal({
  items, onClose, onChanged,
}: {
  items: AccountingItem[]
  onClose: () => void
  onChanged: () => void
}) {
  const [allItems, setAllItems] = useState<AccountingItem[] | null>(null)
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<AccountingCategory>('menu')
  const [newPrice, setNewPrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setAllItems(await getAccountingItems())
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  async function handleAdd() {
    const price = parseInt(newPrice.replace(/[^\d]/g, ''), 10) || 0
    if (!newName.trim() || price <= 0) { setError('商品名と価格を入力してください。'); return }
    setSaving(true)
    setError(null)
    const created = await createAccountingItem({ name: newName.trim(), category: newCategory, price })
    setSaving(false)
    if (!created) { setError('追加に失敗しました。'); return }
    setNewName(''); setNewPrice('')
    await loadAll()
    onChanged()
  }

  async function handleUpdatePrice(item: AccountingItem, priceStr: string) {
    const price = parseInt(priceStr.replace(/[^\d]/g, ''), 10) || 0
    if (price <= 0) return
    const updated = await updateAccountingItem(item.id, { price })
    if (updated) { await loadAll(); onChanged() }
  }

  async function handleToggleActive(item: AccountingItem) {
    const updated = await updateAccountingItem(item.id, { is_active: !item.is_active })
    if (updated) { await loadAll(); onChanged() }
  }

  void items // 親の有効商品一覧は再読込トリガーとしてのみ使用

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 350, background: 'rgba(0,0,0,0.95)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <motion.div
        initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
        style={{ width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto', borderRadius: '20px 20px 0 0', background: '#0A0A0A', border: '1px solid rgba(201,162,74,0.28)', padding: 20 }}
      >
        <p style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: '#ffffff', marginBottom: 4 }}>
          商品マスタ管理（メニュー・オプション）
        </p>
        <p style={{ fontSize: 11, color: '#999999', marginBottom: 16 }}>
          店販商品は銀二郎本部／スタッフ端末の「在庫管理」から追加・編集してください。
        </p>

        {/* 新規追加 */}
        <div style={{ borderRadius: 14, background: '#000000', border: '1px solid rgba(201,162,74,0.2)', padding: 14, marginBottom: 18 }}>
          <p style={{ fontSize: 11, letterSpacing: '0.1em', color: '#e5e5e5', marginBottom: 10 }}>新商品を追加</p>
          <input
            type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="商品名"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', color: '#ffffff', fontSize: 14, marginBottom: 8, outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {(['menu', 'option'] as AccountingCategory[]).map(cat => (
              <button
                key={cat} type="button" onClick={() => setNewCategory(cat)}
                style={{
                  flex: 1, padding: '9px 0', borderRadius: 9,
                  background: newCategory === cat ? 'rgba(201,162,74,0.18)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${newCategory === cat ? '#C9A24A' : 'rgba(255,255,255,0.1)'}`,
                  color: newCategory === cat ? '#C9A24A' : '#e5e5e5', fontSize: 12, cursor: 'pointer',
                }}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
          <input
            type="text" inputMode="numeric" value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="価格（円）"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', color: '#ffffff', fontSize: 14, marginBottom: 10, outline: 'none' }}
          />
          {error && <p style={{ fontSize: 12, color: '#E06060', marginBottom: 8 }}>{error}</p>}
          <button
            type="button" onClick={() => void handleAdd()} disabled={saving}
            style={{ width: '100%', padding: '12px 0', borderRadius: 10, background: 'rgba(201,162,74,0.16)', border: '1px solid #C9A24A', color: '#C9A24A', fontFamily: SERIF, fontSize: 14, fontWeight: 700, cursor: saving ? 'default' : 'pointer' }}
          >
            {saving ? '追加中…' : '追加する'}
          </button>
        </div>

        {/* 一覧 */}
        {allItems === null ? (
          <p style={{ color: '#e5e5e5', fontSize: 13, textAlign: 'center' }}>読み込み中…</p>
        ) : (
          (['menu', 'option'] as AccountingCategory[]).map(cat => (
            <div key={cat} style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 11, letterSpacing: '0.1em', color: '#ffffff', fontWeight: 700, marginBottom: 8 }}>{CATEGORY_LABELS[cat]}</p>
              {allItems.filter(i => i.category === cat).map(item => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
                  <p style={{ flex: '1 1 auto', minWidth: 0, fontSize: 13, color: item.is_active ? '#ffffff' : '#999999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </p>
                  <input
                    type="text" inputMode="numeric" defaultValue={String(item.price ?? 0)}
                    onBlur={e => void handleUpdatePrice(item, e.target.value)}
                    style={{ width: 84, boxSizing: 'border-box', padding: '6px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', color: '#ffffff', fontSize: 13, textAlign: 'right', outline: 'none' }}
                  />
                  <button
                    type="button" onClick={() => void handleToggleActive(item)}
                    style={{
                      flexShrink: 0, padding: '6px 10px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
                      background: item.is_active ? 'rgba(100,200,100,0.12)' : 'rgba(255,255,255,0.05)',
                      border: `1px solid ${item.is_active ? 'rgba(100,200,100,0.4)' : 'rgba(255,255,255,0.14)'}`,
                      color: item.is_active ? '#80E060' : '#999999',
                    }}
                  >
                    {item.is_active ? '有効' : '無効'}
                  </button>
                </div>
              ))}
              {allItems.filter(i => i.category === cat).length === 0 && (
                <p style={{ fontSize: 12, color: '#999999' }}>商品がありません</p>
              )}
            </div>
          ))
        )}

        <button
          type="button" onClick={onClose}
          style={{ width: '100%', marginTop: 8, padding: '13px 0', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', color: '#e5e5e5', fontFamily: SERIF, fontSize: 14, letterSpacing: '0.1em', cursor: 'pointer' }}
        >
          閉じる
        </button>
      </motion.div>
    </div>
  )
}
