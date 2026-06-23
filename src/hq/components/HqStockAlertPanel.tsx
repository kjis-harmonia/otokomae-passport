import { splitStockAlerts } from '../hqInventoryStore'
import type { Product } from '../hqInventoryStore'
import { HQ_COLORS, HQ_MONO, HQ_SANS, HQ_SERIF } from '../hqTheme'
import { HqPanel } from './HqPanel'

/** 在庫管理タブ用：要発注／少ない商品の詳細リスト。両方0件なら「在庫アラートなし」。 */
export function HqStockAlertPanel({ products }: { products: Product[] }) {
  const { reorder, low } = splitStockAlerts(products)
  const total = reorder.length + low.length

  return (
    <HqPanel title="要発注アラート" code={total > 0 ? `${total}件` : undefined}>
      {total === 0 ? (
        <p style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textMute, margin: 0 }}>
          在庫アラートなし
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[...reorder, ...low].map((p) => {
            const isReorder = reorder.includes(p)
            return (
              <div key={p.id} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: '2px 10px' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 13, color: HQ_COLORS.textPrimary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {isReorder ? '🔴' : '🟡'} {p.name}
                </span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: isReorder ? HQ_COLORS.negative : '#E0B84A', whiteSpace: 'nowrap' }}>
                  現在庫 {p.current_stock} / 最低在庫 {p.min_stock}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </HqPanel>
  )
}

/** ダッシュボード用：要発注／少ないの件数だけを小さく表示するタイル。 */
export function HqStockAlertSummaryTile({ products }: { products: Product[] }) {
  const { reorder, low } = splitStockAlerts(products)
  const hasAlert = reorder.length > 0 || low.length > 0

  return (
    <div style={{
      flex: '1 1 150px', minWidth: 0,
      background: HQ_COLORS.panel,
      border: `1px solid ${hasAlert ? 'rgba(216,107,92,0.35)' : HQ_COLORS.panelBorder}`,
      borderRadius: 4, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    }}>
      <p style={{ fontFamily: HQ_SANS, fontSize: 10, letterSpacing: '0.12em', color: HQ_COLORS.textSecondary, margin: 0, marginBottom: 8 }}>
        在庫アラート
      </p>
      {hasAlert ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {reorder.length > 0 && (
            <p style={{ fontFamily: HQ_SERIF, fontSize: 14, fontWeight: 700, color: HQ_COLORS.negative, margin: 0 }}>
              要発注 {reorder.length}件
            </p>
          )}
          {low.length > 0 && (
            <p style={{ fontFamily: HQ_SERIF, fontSize: 14, fontWeight: 700, color: '#E0B84A', margin: 0 }}>
              少ない {low.length}件
            </p>
          )}
        </div>
      ) : (
        <p style={{ fontFamily: HQ_SERIF, fontSize: 14, fontWeight: 700, color: HQ_COLORS.textMute, margin: 0 }}>
          アラートなし
        </p>
      )}
    </div>
  )
}
