import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Minus,
  Music2,
  Package,
  Plus,
  Search,
  Shirt,
  ShoppingCart,
} from 'lucide-react'
import { getProducts, subscribeProductsRealtime } from '../hq/hqInventoryStore'
import type { Product } from '../hq/hqInventoryStore'

type LoadingPhase = 'loading' | 'ready'
type ShopCategory = 'retail' | 'tee' | 'hoodie' | 'jumper' | 'music' | 'recommend' | 'sale'
type ProductKind = 'retail' | 'wear' | 'music'

type ShopProduct = {
  id: string
  kind: ProductKind
  category: ShopCategory
  name: string
  price: number | null
  originalPrice?: number | null
  label?: string
  discount?: string
  imageUrl?: string | null
  description: string
  group: string
  color: string
  accent: string
  available: boolean
  variants?: {
    size?: string[]
    color?: string[]
  }
}

const MONO = 'ui-monospace, "SF Mono", "Fira Code", monospace'

const SHOP_IMAGES = {
  header: '/images/shop/ginjiro-shop-header.jpg',
  thisWeekBanner: '/images/shop/shop-banner-this-week.jpg',
  newArrivalBanner: '/images/shop/shop-banner-new-arrival.jpg',
  retail: '/images/shop/retail-styling.jpg',
  tee: '/images/shop/ginjiro-tshirt.jpg',
  hoodie: '/images/shop/ginjiro-hoodie.jpg',
  jumper: '/images/shop/ginjiro-jumper.jpg',
  music: '/images/shop/cats-star-cd.jpg',
} as const

const CATEGORY_ITEMS: Array<{ id: ShopCategory; label: string; icon: string; imageUrl?: string }> = [
  { id: 'retail', label: '店販アイテム', icon: '粧', imageUrl: SHOP_IMAGES.retail },
  { id: 'tee', label: 'Tシャツ', icon: 'T', imageUrl: SHOP_IMAGES.tee },
  { id: 'hoodie', label: 'パーカー', icon: 'H', imageUrl: SHOP_IMAGES.hoodie },
  { id: 'jumper', label: 'ジャンパー', icon: 'J', imageUrl: SHOP_IMAGES.jumper },
  { id: 'music', label: 'CATS&STAR CD', icon: '♪', imageUrl: SHOP_IMAGES.music },
  { id: 'recommend', label: 'おすすめ', icon: '推' },
  { id: 'sale', label: 'セール', icon: '%' },
]

const STATIC_PRODUCTS: ShopProduct[] = [
  {
    id: 'ginjiro-tee',
    kind: 'wear',
    category: 'tee',
    name: '銀二郎Tシャツ',
    price: null,
    label: '新作予定',
    imageUrl: SHOP_IMAGES.tee,
    description: '日常使いしやすい銀二郎オリジナルTシャツ。サイズ展開を準備中です。',
    group: 'GINJIRO WEAR',
    color: '#f4f4f2',
    accent: '#8f1116',
    available: false,
    variants: { size: ['M', 'L', 'XL'], color: ['Black', 'White'] },
  },
  {
    id: 'ginjiro-hoodie',
    kind: 'wear',
    category: 'hoodie',
    name: '銀二郎パーカー',
    price: null,
    label: '限定予定',
    imageUrl: SHOP_IMAGES.hoodie,
    description: '黒金の銀二郎らしさを普段着に落とし込む予定のパーカーです。',
    group: 'GINJIRO WEAR',
    color: '#f2f0ec',
    accent: '#111111',
    available: false,
    variants: { size: ['M', 'L', 'XL'], color: ['Black'] },
  },
  {
    id: 'ginjiro-jumper',
    kind: 'wear',
    category: 'jumper',
    name: '銀二郎ジャンパー',
    price: null,
    label: '準備中',
    imageUrl: SHOP_IMAGES.jumper,
    description: '店舗でも街でも映える、銀二郎オリジナルのアウター企画です。',
    group: 'GINJIRO WEAR',
    color: '#f5f3ef',
    accent: '#c39a4b',
    available: false,
    variants: { size: ['M', 'L', 'XL'], color: ['Black'] },
  },
  {
    id: 'cats-star-album',
    kind: 'music',
    category: 'music',
    name: 'CATS&STAR アルバム',
    price: null,
    label: 'Coming soon',
    imageUrl: SHOP_IMAGES.music,
    description: '銀二郎サウンドを後々ショップでも販売予定。詳細は準備中です。',
    group: 'CATS & STAR',
    color: '#eef4fb',
    accent: '#18466a',
    available: false,
  },
]

function formatYen(price: number | null | undefined): string {
  if (typeof price !== 'number' || price <= 0) return '店頭確認'
  return `¥${price.toLocaleString('ja-JP')}`
}

function getProductImage(product: Product): string | null {
  const withImage = product as Product & {
    image_url?: string | null
    imageUrl?: string | null
    photo_url?: string | null
    thumbnail_url?: string | null
  }
  return withImage.image_url || withImage.imageUrl || withImage.photo_url || withImage.thumbnail_url || null
}

function getRetailAccent(product: Product, index: number): Pick<ShopProduct, 'color' | 'accent' | 'label' | 'discount'> {
  const text = `${product.name} ${product.accounting_group ?? ''}`
  if (text.includes('BROSH') || text.includes('ブロッシュ')) {
    return { color: '#f8f3eb', accent: '#9b1f23', label: index === 0 ? '人気' : undefined, discount: index === 1 ? '10%OFF' : undefined }
  }
  if (text.includes('シャンプ') || text.includes('ケア')) return { color: '#eef5f5', accent: '#246b66', label: 'おすすめ' }
  if (text.includes('コーム')) return { color: '#f4f4f4', accent: '#1f2933', label: '定番' }
  if (text.includes('グリース') || text.includes('ポマード')) return { color: '#fbf0e4', accent: '#a34822', label: index % 2 === 0 ? '人気' : undefined }
  return [
    { color: '#f8f3eb', accent: '#8f1116', label: 'おすすめ' },
    { color: '#f4f4f4', accent: '#111111', label: undefined },
    { color: '#fbf0e4', accent: '#b08134', label: '新作' },
  ][index % 3]
}

function toShopProduct(product: Product, index: number): ShopProduct {
  const accent = getRetailAccent(product, index)
  return {
    id: product.id,
    kind: 'retail',
    category: 'retail',
    name: product.name,
    price: product.price,
    originalPrice: accent.discount && product.price > 0 ? Math.round(product.price * 1.12) : null,
    label: accent.label,
    discount: accent.discount,
    imageUrl: getProductImage(product) || SHOP_IMAGES.retail,
    description: `${product.accounting_group?.trim() || '銀二郎セレクト'}の商品です。店舗端末の店販情報と連動して表示しています。`,
    group: product.accounting_group?.trim() || '店販アイテム',
    color: accent.color,
    accent: accent.accent,
    available: product.current_stock > 0,
  }
}

function ProductImage({ product, large = false }: { product: ShopProduct; large?: boolean }) {
  if (product.imageUrl) {
    return (
      <div className={large ? 'shop-image shop-image--large' : 'shop-image'} style={{ background: product.color }}>
        <img src={product.imageUrl} alt={product.name} />
      </div>
    )
  }

  const isWear = product.kind === 'wear'
  const isMusic = product.kind === 'music'

  return (
    <div className={large ? 'shop-image shop-image--large' : 'shop-image'} style={{ background: product.color }}>
      <div className="shop-product-art" style={{ color: product.accent }}>
        {isWear ? (
          <Shirt size={large ? 86 : 54} strokeWidth={1.5} />
        ) : isMusic ? (
          <Music2 size={large ? 82 : 52} strokeWidth={1.6} />
        ) : (
          <Package size={large ? 90 : 56} strokeWidth={1.4} />
        )}
      </div>
      <div className="shop-art-brand" style={{ color: product.accent }}>
        GINJIRO
      </div>
    </div>
  )
}

function ProductCard({
  product,
  onSelect,
  rank,
  compact = false,
}: {
  product: ShopProduct
  onSelect: (product: ShopProduct) => void
  rank?: number
  compact?: boolean
}) {
  return (
    <button type="button" className={compact ? 'shop-card shop-card--compact' : 'shop-card'} onClick={() => onSelect(product)}>
      <div className="shop-card-image-wrap">
        {rank && <span className="shop-rank-badge">{rank}</span>}
        {product.discount && <span className="shop-discount-badge">{product.discount}</span>}
        <ProductImage product={product} />
      </div>
      <div className="shop-card-copy">
        {product.label && <span className="shop-label">{product.label}</span>}
        <h3>{product.name}</h3>
        <div className="shop-price-row">
          <strong>{formatYen(product.price)}</strong>
          {product.originalPrice && <del>{formatYen(product.originalPrice)}</del>}
        </div>
      </div>
    </button>
  )
}

function SectionHeader({ title, action }: { title: string; action?: string }) {
  return (
    <div className="shop-section-head">
      <h2>{title}</h2>
      {action && (
        <button type="button">
          {action}
          <ChevronRight size={18} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

function ProductDetail({
  product,
  related,
  onBack,
  onSelect,
}: {
  product: ShopProduct
  related: ShopProduct[]
  onBack: () => void
  onSelect: (product: ShopProduct) => void
}) {
  const [quantity, setQuantity] = useState(1)
  const sizes = product.variants?.size ?? ['標準']
  const colors = product.variants?.color ?? ['通常']

  return (
    <section className="shop-page shop-page--detail">
      <style>{shopCss}</style>

      <header className="shop-detail-top">
        <button type="button" onClick={onBack} aria-label="SHOPへ戻る">
          <ArrowLeft size={22} />
        </button>
        <h1>商品詳細</h1>
        <button type="button" aria-label="カート">
          <ShoppingCart size={21} />
        </button>
      </header>

      <div className="shop-detail-body">
        <ProductImage product={product} large />

        <div className="shop-detail-info">
          <p className="shop-detail-group">{product.group}</p>
          <h2>{product.name}</h2>
          <div className="shop-detail-price">
            <strong>{formatYen(product.price)}</strong>
            {product.originalPrice && <del>{formatYen(product.originalPrice)}</del>}
            {product.discount && <span>{product.discount}</span>}
          </div>
          <p>{product.description}</p>
        </div>

        <div className="shop-option-block">
          <h3>サイズ</h3>
          <div className="shop-option-row">
            {sizes.map((size) => <button key={size} type="button">{size}</button>)}
          </div>
        </div>

        <div className="shop-option-block">
          <h3>カラー</h3>
          <div className="shop-option-row">
            {colors.map((color) => <button key={color} type="button">{color}</button>)}
          </div>
        </div>

        <div className="shop-quantity-row">
          <span>数量</span>
          <div>
            <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))}><Minus size={16} /></button>
            <strong>{quantity}</strong>
            <button type="button" onClick={() => setQuantity((q) => q + 1)}><Plus size={16} /></button>
          </div>
        </div>

        <div className="shop-action-stack">
          <button type="button" className="shop-cart-button">カートに追加</button>
          <button type="button" className="shop-buy-button">今すぐ購入</button>
          {!product.available && <small>この商品は現在準備中です。購入導線は将来対応予定です。</small>}
        </div>

        <section className="shop-section">
          <SectionHeader title="関連商品" />
          <div className="shop-grid">
            {related.slice(0, 4).map((item) => (
              <ProductCard key={item.id} product={item} onSelect={onSelect} compact />
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}

const shopCss = `
  .shop-page {
    min-height: 100%;
    background: #ffffff;
    color: #171717;
    padding: 0 0 calc(104px + env(safe-area-inset-bottom, 0px));
  }

  .shop-top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.96) 100%);
    border-bottom: 1px solid #ebe7df;
    padding: 14px 16px 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.035);
  }

  .shop-title-row,
  .shop-detail-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .shop-title-row h1,
  .shop-detail-top h1 {
    margin: 0;
    color: #101010;
    font-size: 28px;
    font-weight: 900;
    letter-spacing: 0;
  }

  .shop-brand-logo {
    width: min(314px, calc(100vw - 92px));
    height: 76px;
    border-radius: 0;
    overflow: hidden;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .shop-brand-logo img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    object-position: center center;
  }

  .shop-title-row button,
  .shop-detail-top button {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    border: 1px solid #ded6c8;
    background: #fff;
    display: grid;
    place-items: center;
    color: #111;
  }

  .shop-search {
    margin-top: 12px;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 9px;
    border-radius: 999px;
    border: 1.5px solid #d7d3cc;
    background: #fff;
    padding: 0 14px;
    color: #777;
  }

  .shop-search span {
    font-size: 14px;
    color: #6e6e6e;
  }

  .shop-content {
    display: grid;
    gap: 26px;
    padding: 14px 0 0;
  }

  .shop-banner-rail,
  .shop-category-rail,
  .shop-sale-rail,
  .shop-staff-rail {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding: 0 16px;
    scrollbar-width: none;
  }

  .shop-banner-rail::-webkit-scrollbar,
  .shop-category-rail::-webkit-scrollbar,
  .shop-sale-rail::-webkit-scrollbar,
  .shop-staff-rail::-webkit-scrollbar {
    display: none;
  }

  .shop-banner {
    flex: 0 0 82%;
    aspect-ratio: 1280 / 448;
    min-height: 0;
    border: 0;
    border-radius: 16px;
    padding: 0;
    color: #fff;
    text-align: left;
    scroll-snap-align: start;
    overflow: hidden;
    position: relative;
    box-shadow: 0 12px 26px rgba(0,0,0,0.10);
  }

  .shop-banner img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    object-position: center center;
  }

  .shop-banner--red {
    background:
      radial-gradient(circle at 92% 12%, rgba(212,175,55,0.32), transparent 35%),
      linear-gradient(135deg, #111 0%, #7d1118 100%);
  }

  .shop-banner--black {
    background:
      radial-gradient(circle at 92% 12%, rgba(212,175,55,0.28), transparent 35%),
      linear-gradient(135deg, #141414 0%, #2b2115 100%);
  }

  .shop-banner small,
  .shop-staff-card small {
    color: rgba(255,255,255,0.72);
    font-family: ${MONO};
    font-size: 10px;
    letter-spacing: 0.18em;
    font-weight: 800;
  }

  .shop-staff-card small {
    color: #a37a2b;
  }

  .shop-banner h2 {
    margin: 9px 0 8px;
    font-size: 23px;
    line-height: 1.05;
    letter-spacing: 0;
  }

  .shop-banner p {
    margin: 0;
    font-size: 12px;
    color: rgba(255,255,255,0.80);
    line-height: 1.6;
  }

  .shop-section {
    display: grid;
    gap: 12px;
  }

  .shop-section-head {
    padding: 0 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .shop-section-head h2 {
    margin: 0;
    color: #111;
    font-size: 22px;
    font-weight: 900;
    letter-spacing: 0;
  }

  .shop-section-head button {
    border: 0;
    background: transparent;
    color: #262626;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 13px;
    font-weight: 800;
    padding: 4px 0;
  }

  .shop-category-card {
    flex: 0 0 auto;
    width: 78px;
    border: 0;
    background: transparent;
    display: grid;
    justify-items: center;
    gap: 7px;
    color: #222;
  }

  .shop-category-icon {
    width: 56px;
    height: 56px;
    border-radius: 18px;
    display: grid;
    place-items: center;
    background: #fff;
    border: 1px solid #ece6dc;
    color: #8f1116;
    font-weight: 900;
    box-shadow: 0 5px 14px rgba(0,0,0,0.05);
    overflow: hidden;
  }

  .shop-category-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .shop-category-card span {
    font-size: 11px;
    font-weight: 800;
    line-height: 1.25;
  }

  .shop-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 13px;
    padding: 0 16px;
  }

  .shop-card {
    border: 0;
    padding: 0;
    background: #fff;
    text-align: left;
    border-radius: 15px;
    overflow: hidden;
    box-shadow: 0 4px 16px rgba(0,0,0,0.055);
    border: 1px solid #ece8df;
    -webkit-tap-highlight-color: transparent;
  }

  .shop-card--compact {
    box-shadow: 0 4px 14px rgba(0,0,0,0.06);
  }

  .shop-card-image-wrap {
    position: relative;
  }

  .shop-image {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    display: grid;
    place-items: center;
    overflow: hidden;
  }

  .shop-image--large {
    border-radius: 0 0 26px 26px;
    aspect-ratio: 1.08 / 1;
  }

  .shop-image img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
    padding: 7px;
  }

  .shop-product-art {
    display: grid;
    place-items: center;
    width: 78px;
    height: 78px;
    border-radius: 50%;
    background: rgba(255,255,255,0.72);
    box-shadow: 0 8px 26px rgba(0,0,0,0.06);
  }

  .shop-image--large .shop-product-art {
    width: 148px;
    height: 148px;
  }

  .shop-art-brand {
    position: absolute;
    bottom: 13px;
    left: 14px;
    font-family: ${MONO};
    font-size: 9px;
    letter-spacing: 0.20em;
    font-weight: 900;
    opacity: 0.54;
  }

  .shop-discount-badge,
  .shop-rank-badge {
    position: absolute;
    z-index: 1;
    top: 9px;
    left: 9px;
    border-radius: 9px;
    background: #d10f35;
    color: #fff;
    font-size: 11px;
    font-weight: 900;
    padding: 5px 7px;
  }

  .shop-rank-badge {
    background: #111;
    min-width: 28px;
    text-align: center;
  }

  .shop-card-copy {
    padding: 10px 11px 13px;
    display: grid;
    gap: 6px;
  }

  .shop-label {
    width: fit-content;
    color: #8f1116;
    background: #fff4ea;
    border-radius: 999px;
    padding: 3px 7px;
    font-size: 10px;
    font-weight: 900;
  }

  .shop-card-copy h3 {
    margin: 0;
    color: #202020;
    font-size: 13px;
    font-weight: 800;
    line-height: 1.35;
    min-height: 35px;
  }

  .shop-price-row {
    display: flex;
    align-items: baseline;
    gap: 7px;
    flex-wrap: wrap;
  }

  .shop-price-row strong {
    color: #b00718;
    font-size: 16px;
    font-weight: 900;
  }

  .shop-price-row del {
    color: #888;
    font-size: 11px;
  }

  .shop-sale-rail .shop-card {
    flex: 0 0 44%;
    scroll-snap-align: start;
  }

  .shop-staff-card {
    flex: 0 0 82%;
    border: 1px solid #ece8df;
    border-radius: 16px;
    padding: 16px;
    color: #161616;
    text-align: left;
    background:
      linear-gradient(90deg, #8f1116 0 4px, transparent 4px),
      linear-gradient(135deg, #ffffff 0%, #fff8f0 100%);
    box-shadow: 0 4px 16px rgba(0,0,0,0.05);
    scroll-snap-align: start;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .shop-staff-copy {
    min-width: 0;
  }

  .shop-staff-card h3 {
    margin: 7px 0 7px;
    font-size: 20px;
  }

  .shop-staff-card p {
    margin: 0;
    color: #5e5e5e;
    font-size: 12px;
    line-height: 1.55;
  }

  .shop-staff-thumb {
    flex: 0 0 82px;
    border-radius: 14px;
    overflow: hidden;
    background: #fff;
    border: 1px solid #eee6dc;
  }

  .shop-staff-thumb .shop-image {
    aspect-ratio: 1 / 1;
  }

  .shop-staff-thumb .shop-image img {
    padding: 4px;
  }

  .shop-bottom-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding: 4px 16px 0;
  }

  .shop-bottom-actions button {
    height: 46px;
    border-radius: 999px;
    border: 1px solid #cfc7ba;
    background: #fff;
    color: #141414;
    font-size: 13px;
    font-weight: 900;
  }

  .shop-bottom-actions button:first-child {
    background: #111;
    color: #fff;
    border-color: #111;
  }

  .shop-detail-top {
    position: sticky;
    top: 0;
    z-index: 20;
    padding: 12px 16px;
    background: rgba(255,255,255,0.96);
    border-bottom: 1px solid #e7e2d8;
  }

  .shop-detail-top h1 {
    font-size: 17px;
  }

  .shop-detail-body {
    display: grid;
    gap: 18px;
  }

  .shop-detail-info {
    padding: 0 16px;
    display: grid;
    gap: 8px;
  }

  .shop-detail-group {
    margin: 0;
    color: #8f1116;
    font-size: 11px;
    font-family: ${MONO};
    letter-spacing: 0.16em;
    font-weight: 900;
  }

  .shop-detail-info h2 {
    margin: 0;
    color: #111;
    font-size: 25px;
    font-weight: 900;
    line-height: 1.18;
  }

  .shop-detail-price {
    display: flex;
    align-items: baseline;
    gap: 9px;
    flex-wrap: wrap;
  }

  .shop-detail-price strong {
    color: #b00718;
    font-size: 26px;
    font-weight: 950;
  }

  .shop-detail-price del {
    color: #8b8b8b;
    font-size: 13px;
  }

  .shop-detail-price span {
    color: #fff;
    background: #d10f35;
    border-radius: 8px;
    padding: 4px 7px;
    font-size: 11px;
    font-weight: 900;
  }

  .shop-detail-info p:last-child {
    margin: 0;
    color: #4a4a4a;
    font-size: 14px;
    line-height: 1.75;
  }

  .shop-option-block {
    padding: 0 16px;
    display: grid;
    gap: 9px;
  }

  .shop-option-block h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 900;
  }

  .shop-option-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .shop-option-row button {
    min-width: 54px;
    height: 36px;
    border-radius: 999px;
    border: 1px solid #d9d2c6;
    background: #fff;
    font-weight: 800;
    color: #202020;
  }

  .shop-quantity-row {
    margin: 0 16px;
    padding: 13px 0;
    border-top: 1px solid #e5ded2;
    border-bottom: 1px solid #e5ded2;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .shop-quantity-row span {
    font-weight: 900;
  }

  .shop-quantity-row div {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .shop-quantity-row button {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1px solid #d9d2c6;
    background: #fff;
    display: grid;
    place-items: center;
  }

  .shop-action-stack {
    display: grid;
    gap: 10px;
    padding: 0 16px;
  }

  .shop-action-stack button {
    height: 50px;
    border-radius: 999px;
    font-size: 15px;
    font-weight: 900;
  }

  .shop-cart-button {
    border: 0;
    background: #ffd814;
    color: #111;
  }

  .shop-buy-button {
    border: 0;
    background: #b00718;
    color: #fff;
  }

  .shop-action-stack small {
    color: #777;
    font-size: 12px;
    line-height: 1.55;
  }
`

export function ShopScreen() {
  const [, setPhase] = useState<LoadingPhase>('loading')
  const [products, setProducts] = useState<Product[]>([])
  const [selectedProduct, setSelectedProduct] = useState<ShopProduct | null>(null)

  useEffect(() => {
    let mounted = true
    let settled = false

    const load = async () => {
      const nextProducts = await getProducts()
      settled = true
      if (!mounted) return
      setProducts(nextProducts)
      setPhase('ready')
    }

    void load()
    const fallbackTimer = window.setTimeout(() => {
      if (mounted && !settled) setPhase('ready')
    }, 900)

    const unsubscribe = subscribeProductsRealtime(() => {
      void load()
    })

    return () => {
      mounted = false
      window.clearTimeout(fallbackTimer)
      unsubscribe()
    }
  }, [])

  const retailProducts = useMemo(
    () => products.filter((product) => product.category === '店販').map(toShopProduct),
    [products],
  )

  const shopProducts = useMemo(
    () => [...retailProducts, ...STATIC_PRODUCTS],
    [retailProducts],
  )

  const recommendedProducts = useMemo(() => shopProducts.slice(0, 6), [shopProducts])
  const saleProducts = useMemo(
    () => shopProducts.filter((product) => product.discount || product.category === 'sale').slice(0, 6),
    [shopProducts],
  )
  const rankingProducts = useMemo(() => shopProducts.slice(0, 3), [shopProducts])
  const newProducts = useMemo(() => [...STATIC_PRODUCTS, ...retailProducts].slice(0, 6), [retailProducts])
  const teiteiPick = shopProducts.find((product) => product.category === 'retail') ?? shopProducts[0]
  const ginjiroPick = shopProducts.find((product) => product.kind === 'wear') ?? shopProducts[1]

  const scrollShopToTop = () => {
    window.requestAnimationFrame(() => {
      const main = document.querySelector<HTMLElement>('.app-main')
      if (main) {
        main.scrollTo({ top: 0, behavior: 'auto' })
        return
      }
      window.scrollTo({ top: 0, behavior: 'auto' })
    })
  }

  const handleSelectProduct = (product: ShopProduct) => {
    setSelectedProduct(product)
    scrollShopToTop()
  }

  const handleBackToShop = () => {
    setSelectedProduct(null)
    scrollShopToTop()
  }

  if (selectedProduct) {
    return (
      <ProductDetail
        product={selectedProduct}
        related={shopProducts.filter((product) => product.id !== selectedProduct.id)}
        onBack={handleBackToShop}
        onSelect={handleSelectProduct}
      />
    )
  }

  return (
    <section className="shop-page">
      <style>{shopCss}</style>

      <header className="shop-top">
        <div className="shop-title-row">
          <div className="shop-brand-logo" aria-label="銀二郎 SHOP">
            <img src={SHOP_IMAGES.header} alt="銀二郎 SHOP" />
          </div>
          <button type="button" aria-label="カート">
            <ShoppingCart size={22} strokeWidth={2} />
          </button>
        </div>
        <div className="shop-search" role="search">
          <Search size={20} strokeWidth={2.3} />
          <span>商品を検索</span>
        </div>
      </header>

      <div className="shop-content">
        <section className="shop-banner-rail" aria-label="注目エリア">
          <button type="button" className="shop-banner shop-banner--red" aria-label="今週のおすすめ">
            <img
              src={SHOP_IMAGES.thisWeekBanner}
              alt="今週のおすすめ 店販アイテムと銀二郎グッズを見やすくチェック。"
            />
          </button>
          <button type="button" className="shop-banner shop-banner--black" aria-label="新作入荷予定">
            <img
              src={SHOP_IMAGES.newArrivalBanner}
              alt="新作入荷予定 Tシャツ、パーカー、ジャンパーを準備中。"
            />
          </button>
        </section>

        <section className="shop-section">
          <SectionHeader title="カテゴリー" />
          <div className="shop-category-rail">
            {CATEGORY_ITEMS.map((category) => (
              <button key={category.id} type="button" className="shop-category-card">
                <div className="shop-category-icon">
                  {category.imageUrl ? <img src={category.imageUrl} alt="" /> : category.icon}
                </div>
                <span>{category.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="shop-section">
          <SectionHeader title="あなたにおすすめ" action="もっと見る" />
          <div className="shop-grid">
            {recommendedProducts.map((product) => (
              <ProductCard key={product.id} product={product} onSelect={handleSelectProduct} />
            ))}
          </div>
        </section>

        <section className="shop-section">
          <SectionHeader title="期間限定セール" action="本日まで" />
          <div className="shop-sale-rail">
            {(saleProducts.length > 0 ? saleProducts : recommendedProducts.slice(0, 4)).map((product, index) => (
              <ProductCard
                key={`${product.id}-sale`}
                product={{ ...product, discount: product.discount ?? `${10 + index * 5}%OFF` }}
                onSelect={handleSelectProduct}
                compact
              />
            ))}
          </div>
        </section>

        <section className="shop-section">
          <SectionHeader title="人気ランキング" action="売れ筋" />
          <div className="shop-grid">
            {rankingProducts.map((product, index) => (
              <ProductCard key={`${product.id}-rank`} product={product} rank={index + 1} onSelect={handleSelectProduct} />
            ))}
          </div>
        </section>

        <section className="shop-section">
          <SectionHeader title="スタッフおすすめ" />
          <div className="shop-staff-rail">
            <button type="button" className="shop-staff-card" onClick={() => handleSelectProduct(teiteiPick)}>
              <span className="shop-staff-copy">
                <small>TEITEI SELECT</small>
                <h3>テイテイおすすめ</h3>
                <p>{teiteiPick?.name ?? '店販アイテム'}を中心に、仕上がり重視でセレクト。</p>
              </span>
              <span className="shop-staff-thumb">
                <ProductImage product={teiteiPick} />
              </span>
            </button>
            <button type="button" className="shop-staff-card" onClick={() => handleSelectProduct(ginjiroPick)}>
              <span className="shop-staff-copy">
                <small>GINJIRO SELECT</small>
                <h3>銀二郎おすすめ</h3>
                <p>{ginjiroPick?.name ?? '銀二郎ウェア'}を中心に、男前感のある商品を提案。</p>
              </span>
              <span className="shop-staff-thumb">
                <ProductImage product={ginjiroPick} />
              </span>
            </button>
          </div>
        </section>

        <section className="shop-section">
          <SectionHeader title="新着商品" action="新しい順" />
          <div className="shop-grid">
            {newProducts.map((product) => (
              <ProductCard key={`${product.id}-new`} product={{ ...product, label: product.label ?? '新着' }} onSelect={handleSelectProduct} />
            ))}
          </div>
        </section>

        <div className="shop-bottom-actions">
          <button type="button">すべての商品を見る</button>
          <button type="button">カテゴリ一覧へ</button>
        </div>
      </div>
    </section>
  )
}
