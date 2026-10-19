import type { CatalogItem, PriceQuote, PriceQuoteItem, SaleLine } from './checkoutApi'

const priceError = () => new Error('メニューの料金を確認できませんでした。再度開き直してください。')

function quotedItem(quote: PriceQuote, code: string): PriceQuoteItem {
  const item = quote?.items?.find(item => item?.code === code)
  if (!item || !Number.isSafeInteger(item.charge) || item.charge < 0
    || (item.normal_price !== null && (!Number.isSafeInteger(item.normal_price) || item.normal_price < item.charge))) throw priceError()
  return item
}

/** 予約時の会員価格スナップショットではなく、予約開始時刻のサーバー見積を使う。 */
export function reservationSaleLines(items: { menu_code: string | null; name: string; price: number | null }[], quote: PriceQuote | null): SaleLine[] {
  return items.map(item => {
    const priced = item.menu_code ? quotedItem(quote!, item.menu_code) : null
    const charge = priced?.charge ?? item.price
    if (charge === null || !Number.isSafeInteger(charge) || charge < 0) throw priceError()
    // 支払単価を採用する。数量変更時に会員割引を1件分しか引かない計算にしない。
    return { source: 'reservation', ref_id: item.menu_code ?? undefined, name: item.name, category: 'menu', unit_price: charge, quantity: 1, discount: 0 }
  })
}

/** 予約なしの追加メニューも同じ料金に揃える。RPC上限20件ごと、日時は最初のサーバー見積に固定。 */
export async function priceServiceCatalog(
  items: CatalogItem[], quote: (codes: string[], startsAt: string | null) => Promise<PriceQuote>, startsAt: string | null,
): Promise<CatalogItem[]> {
  const result: CatalogItem[] = []
  let at = startsAt
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20)
    const priced = await quote(batch.map(item => item.id), at)
    if (!priced?.starts_at || !Number.isFinite(Date.parse(priced.starts_at))) throw priceError()
    at = priced.starts_at
    result.push(...batch.map(item => {
      const p = quotedItem(priced, item.id)
      return { ...item, price: p.charge, normal_price: p.normal_price }
    }))
  }
  return result
}
