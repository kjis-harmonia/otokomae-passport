import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Heart,
  Minus,
  Music2,
  Package,
  Plus,
  Search,
  Shirt,
  ShoppingCart,
  SlidersHorizontal,
} from 'lucide-react'
import { getProducts, subscribeProductsRealtime } from '../hq/hqInventoryStore'
import type { Product } from '../hq/hqInventoryStore'

type LoadingPhase = 'loading' | 'ready'
type ShopCategory = 'retail' | 'tee' | 'hoodie' | 'jumper' | 'music' | 'recommend' | 'sale' | 'cap' | 'gift'
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
const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'
const SHOP_DISPLAY_PRICE = 2700

const SHOP_IMAGES = {
  header: '/images/shop/ginjiro-shop-header.jpg',
  thisWeekBanner: '/images/shop/shop-banner-this-week.jpg',
  newArrivalBanner: '/images/shop/shop-banner-new-arrival.jpg',
  retail: '/images/shop/retail-styling.jpg',
  broshHardPomade: '/images/shop/retail-brosh-hard-pomade.jpg',
  broshBaseSpray: '/images/shop/retail-brosh-base-spray.jpg',
  broshWackoMaria: '/images/shop/retail-brosh-wacko-maria.jpg',
  doorsStrongGel: '/images/shop/retail-doors-strong-gel.jpg',
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
  { id: 'cap', label: 'キャップ', icon: 'CAP' },
  { id: 'gift', label: 'ギフト', icon: '箱', imageUrl: SHOP_IMAGES.music },
]

const STATIC_PRODUCTS: ShopProduct[] = [
  {
    id: 'ginjiro-tee',
    kind: 'wear',
    category: 'tee',
    name: '銀二郎Tシャツ',
    price: SHOP_DISPLAY_PRICE,
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
    price: SHOP_DISPLAY_PRICE,
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
    price: SHOP_DISPLAY_PRICE,
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
    price: SHOP_DISPLAY_PRICE,
    label: 'Coming soon',
    imageUrl: SHOP_IMAGES.music,
    description: '銀二郎サウンドを後々ショップでも販売予定。詳細は準備中です。',
    group: 'CATS & STAR',
    color: '#eef4fb',
    accent: '#18466a',
    available: false,
  },
]

const FALLBACK_RETAIL_PRODUCTS: ShopProduct[] = [
  {
    id: 'fallback-brosh-base-spray',
    kind: 'retail',
    category: 'retail',
    name: 'BROSH ベーススプレー',
    price: SHOP_DISPLAY_PRICE,
    label: '人気',
    imageUrl: SHOP_IMAGES.broshBaseSpray,
    description: '髪型の土台を整えるベーススプレー。店販アイテムとして表示しています。',
    group: '店販アイテム',
    color: '#fbfaf8',
    accent: '#8f1116',
    available: true,
  },
  {
    id: 'fallback-brosh-hard-pomade',
    kind: 'retail',
    category: 'retail',
    name: 'BROSH HARD POMADE 115g',
    price: SHOP_DISPLAY_PRICE,
    label: '定番',
    imageUrl: SHOP_IMAGES.broshHardPomade,
    description: '硬派なセット力を求める方向けのハードポマード。',
    group: '店販アイテム',
    color: '#fbfaf8',
    accent: '#8f1116',
    available: true,
  },
  {
    id: 'fallback-brosh-wacko-maria',
    kind: 'retail',
    category: 'retail',
    name: 'BROSH ワコマリア',
    price: SHOP_DISPLAY_PRICE,
    imageUrl: SHOP_IMAGES.broshWackoMaria,
    description: 'クラシックな質感を楽しめるセレクトポマード。',
    group: '店販アイテム',
    color: '#fbfaf8',
    accent: '#111111',
    available: true,
  },
  {
    id: 'fallback-doors-strong-gel',
    kind: 'retail',
    category: 'retail',
    name: 'DOORS ドアーズ ストロングジェル',
    price: SHOP_DISPLAY_PRICE,
    label: 'おすすめ',
    imageUrl: SHOP_IMAGES.doorsStrongGel,
    description: '扱いやすさとキープ力を両立したストロングジェル。',
    group: '店販アイテム',
    color: '#fbfaf8',
    accent: '#106d8b',
    available: true,
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
    return { color: '#f8f3eb', accent: '#9b1f23', label: index === 0 ? '人気' : undefined }
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

function normalizeRetailName(product: Product): string {
  const name = product.name.trim()
  const upper = name.toUpperCase()

  if (
    upper.includes('BROSH HARD') ||
    name.includes('黒フクロウ') ||
    (name.includes('ブロッシュ') && (name.includes('黒') || name.includes('フクロウ') || name.includes('ハード')))
  ) {
    return 'BROSH HARD POMADE 115g'
  }

  if (upper.includes('DOORS') || name.includes('ドアーズ') || name.includes('ストロングジェル')) {
    return 'DOORS ドアーズ ストロングジェル'
  }

  return name
}

function getMappedRetailImage(product: Product, displayName: string): string | null {
  const text = `${product.name} ${displayName} ${product.accounting_group ?? ''}`.toUpperCase()
  const originalText = `${product.name} ${displayName} ${product.accounting_group ?? ''}`

  if (text.includes('DOORS') || originalText.includes('ドアーズ') || originalText.includes('ストロングジェル')) {
    return SHOP_IMAGES.doorsStrongGel
  }
  if (text.includes('BASE SPRAY') || originalText.includes('ベーススプレー') || originalText.includes('スプレー')) {
    return SHOP_IMAGES.broshBaseSpray
  }
  if (text.includes('WACKO') || text.includes('GUILTY') || originalText.includes('ワコマリア')) {
    return SHOP_IMAGES.broshWackoMaria
  }
  if (text.includes('BROSH') || originalText.includes('ブロッシュ')) {
    return SHOP_IMAGES.broshHardPomade
  }

  return getProductImage(product)
}

function toShopProduct(product: Product, index: number): ShopProduct {
  const accent = getRetailAccent(product, index)
  const displayName = normalizeRetailName(product)
  return {
    id: product.id,
    kind: 'retail',
    category: 'retail',
    name: displayName,
    price: SHOP_DISPLAY_PRICE,
    originalPrice: null,
    label: accent.label,
    discount: undefined,
    imageUrl: getMappedRetailImage(product, displayName) || SHOP_IMAGES.retail,
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
        <span className="shop-favorite" aria-hidden="true">
          <Heart size={15} strokeWidth={2.2} />
        </span>
        <ProductImage product={product} />
      </div>
      <div className="shop-card-copy">
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
    display: grid;
    grid-template-rows: auto 1fr;
  }

  .shop-card--compact {
    box-shadow: 0 4px 14px rgba(0,0,0,0.06);
  }

  .shop-card-image-wrap {
    position: relative;
    background: #fff;
    border-bottom: 1px solid #f0ebe2;
  }

  .shop-image {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    display: grid;
    place-items: center;
    overflow: hidden;
    box-sizing: border-box;
    padding: 18px;
    background: #fff !important;
  }

  .shop-image--large {
    border-radius: 0 0 26px 26px;
    aspect-ratio: 1.08 / 1;
    padding: 22px;
  }

  .shop-image img {
    width: auto;
    height: auto;
    max-width: 74%;
    max-height: 74%;
    display: block;
    object-fit: contain !important;
    object-position: center center;
    padding: 0;
    box-sizing: border-box;
  }

  .shop-image--large img {
    max-width: 88%;
    max-height: 88%;
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
    grid-template-rows: 20px minmax(38px, auto) auto;
    gap: 6px;
    min-height: 112px;
  }

  .shop-label {
    width: fit-content;
    min-height: 20px;
    color: #8f1116;
    background: #fff4ea;
    border-radius: 999px;
    padding: 3px 7px;
    font-size: 10px;
    font-weight: 900;
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    line-height: 1;
  }

  .shop-label--placeholder {
    visibility: hidden;
  }

  .shop-card-copy h3 {
    margin: 0;
    color: #202020;
    font-size: 13px;
    font-weight: 800;
    line-height: 1.35;
    min-height: 38px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .shop-price-row {
    display: flex;
    align-items: baseline;
    gap: 7px;
    flex-wrap: wrap;
    min-height: 24px;
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

  .shop-card--compact .shop-image {
    padding: 16px;
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
    padding: 8px;
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

  .shop-page {
    background:
      linear-gradient(180deg, #ffffff 0%, #ffffff 62%, #fbfaf7 100%);
    color: #161616;
  }

  .shop-top {
    padding: 18px 16px 13px;
    background: rgba(255,255,255,0.985);
    border-bottom: 1px solid rgba(17,17,17,0.065);
    box-shadow: 0 10px 30px rgba(0,0,0,0.045);
  }

  .shop-title-row {
    position: relative;
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr) 48px;
    min-height: 96px;
    align-items: center;
  }

  .shop-brand-logo {
    grid-column: 2;
    justify-self: center;
    width: min(286px, calc(100vw - 128px));
    height: 96px;
  }

  .shop-brand-logo img {
    object-fit: contain;
  }

  .shop-title-row button {
    grid-column: 3;
    justify-self: end;
    width: 48px;
    height: 48px;
    border-color: #ded8cf;
    box-shadow: 0 8px 22px rgba(0,0,0,0.055);
  }

  .shop-search {
    margin-top: 10px;
    height: 50px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 11px;
    border: 1.5px solid #d9d5ce;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 18px rgba(0,0,0,0.035);
  }

  .shop-search span {
    font-size: 15px;
    font-weight: 650;
    color: #77736e;
  }

  .shop-filter-icon {
    color: #55514c;
    padding-left: 13px;
    border-left: 1px solid #ded8cf;
    box-sizing: content-box;
  }

  .shop-content {
    gap: 25px;
    padding-top: 13px;
  }

  .shop-feature-stack {
    display: grid;
    gap: 10px;
    padding: 0 16px;
  }

  .shop-feature-card {
    min-height: 144px;
    border: 0;
    border-radius: 12px;
    overflow: hidden;
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1.16fr) minmax(0, 0.84fr);
    text-align: left;
    color: #121212;
    box-shadow: 0 10px 24px rgba(0,0,0,0.085);
    isolation: isolate;
  }

  .shop-feature-card::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background:
      radial-gradient(circle at 76% 26%, rgba(176,140,72,0.14), transparent 32%),
      linear-gradient(135deg, rgba(255,255,255,0.82), rgba(236,231,221,0.42));
  }

  .shop-feature-card--light {
    background: #f4f1eb;
  }

  .shop-feature-card--dark {
    color: #f8f4ea;
    background:
      radial-gradient(circle at 76% 24%, rgba(156,17,26,0.38), transparent 31%),
      linear-gradient(135deg, #15110f 0%, #050505 100%);
  }

  .shop-feature-card--dark::before {
    background:
      linear-gradient(90deg, rgba(0,0,0,0.28), rgba(0,0,0,0)),
      radial-gradient(circle at 95% 6%, rgba(180,135,57,0.24), transparent 38%);
  }

  .shop-feature-copy {
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 8px;
    padding: 18px 6px 18px 18px;
    min-width: 0;
  }

  .shop-feature-copy small {
    font-family: ${MONO};
    font-size: 10px;
    letter-spacing: 0.34em;
    font-weight: 900;
    color: rgba(20,20,20,0.56);
  }

  .shop-feature-card--dark .shop-feature-copy small {
    color: rgba(232,211,171,0.70);
  }

  .shop-feature-copy strong {
    font-family: ${SERIF};
    font-size: 23px;
    line-height: 1.04;
    font-weight: 900;
    letter-spacing: 0;
    white-space: nowrap;
  }

  .shop-feature-copy em {
    margin: 0;
    font-style: normal;
    color: rgba(20,20,20,0.72);
    font-size: 13px;
    font-weight: 650;
    line-height: 1.55;
  }

  .shop-feature-card--dark .shop-feature-copy em {
    color: rgba(255,255,255,0.72);
  }

  .shop-feature-copy span {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: #493616;
    font-size: 12px;
    font-weight: 900;
  }

  .shop-feature-card--dark .shop-feature-copy span {
    color: #e7c97c;
  }

  .shop-feature-visual {
    position: relative;
    display: flex;
    align-items: end;
    justify-content: center;
    gap: 2px;
    overflow: hidden;
    padding: 12px 11px 0 0;
  }

  .shop-feature-visual::after {
    content: '';
    position: absolute;
    right: 2px;
    bottom: 0;
    width: 122px;
    height: 34px;
    border-radius: 999px;
    background: rgba(0,0,0,0.10);
    filter: blur(10px);
    z-index: -1;
  }

  .shop-feature-visual--retail img:first-child {
    width: 68px;
    max-height: 92px;
    object-fit: contain;
    transform: translateY(2px);
  }

  .shop-feature-visual--retail img:last-child {
    width: 50px;
    max-height: 112px;
    object-fit: contain;
  }

  .shop-feature-visual--wear {
    justify-content: end;
    padding-right: 0;
  }

  .shop-feature-visual--wear img {
    width: 156px;
    max-width: 118%;
    height: 128px;
    object-fit: contain;
    object-position: right bottom;
    transform: translate(16px, 10px) scale(1.12);
  }

  .shop-section {
    gap: 11px;
  }

  .shop-section-head {
    padding: 0 16px;
  }

  .shop-section-head h2 {
    font-size: 22px;
    letter-spacing: -0.01em;
  }

  .shop-section-head button {
    font-size: 12px;
    color: #25221d;
  }

  .shop-category-rail {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    overflow: visible;
    scroll-snap-type: none;
    padding: 0 16px;
  }

  .shop-category-card {
    width: auto;
    min-width: 0;
    gap: 7px;
  }

  .shop-category-icon {
    width: 100%;
    max-width: 58px;
    height: auto;
    aspect-ratio: 1;
    border-radius: 14px;
    background: #fbfaf8;
    color: #8e171c;
    font-size: 11px;
    box-shadow: 0 8px 18px rgba(0,0,0,0.045);
  }

  .shop-category-icon img {
    object-fit: contain;
    padding: 7px;
    box-sizing: border-box;
  }

  .shop-category-card span {
    font-size: 10.5px;
    line-height: 1.18;
    white-space: nowrap;
  }

  .shop-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    padding: 0 16px;
  }

  .shop-card {
    border-radius: 12px;
    border-color: #ede8df;
    box-shadow: 0 8px 20px rgba(0,0,0,0.052);
    min-width: 0;
  }

  .shop-card-image-wrap {
    background: #fbfbfa;
    border-bottom-color: #eee9e1;
  }

  .shop-image {
    padding: 8px;
    background: #fbfbfa !important;
  }

  .shop-image img {
    max-width: 86%;
    max-height: 86%;
  }

  .shop-favorite {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 2;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: rgba(255,255,255,0.88);
    border: 1px solid rgba(0,0,0,0.06);
    color: rgba(35,35,35,0.58);
    display: grid;
    place-items: center;
    box-shadow: 0 4px 10px rgba(0,0,0,0.06);
  }

  .shop-rank-badge,
  .shop-discount-badge {
    top: 6px;
    left: 6px;
    border-radius: 8px;
    font-size: 9px;
    padding: 4px 5px;
  }

  .shop-card-copy {
    min-height: 60px;
    padding: 6px 6px 8px;
    grid-template-rows: auto auto;
    gap: 3px;
  }

  .shop-card-copy h3 {
    min-height: 27px;
    font-size: 10.5px;
    line-height: 1.25;
    font-weight: 750;
  }

  .shop-price-row {
    min-height: 17px;
    gap: 3px;
  }

  .shop-price-row strong {
    color: #2a2724;
    font-size: 12px;
    line-height: 1;
    font-weight: 800;
  }

  .shop-price-row del {
    display: none;
  }

  .shop-sale-rail {
    gap: 8px;
  }

  .shop-sale-rail .shop-card {
    flex: 0 0 calc((100vw - 56px) / 4);
    min-width: 78px;
  }

  .shop-card--compact .shop-image {
    padding: 8px;
  }

  .shop-staff-card {
    flex-basis: 76%;
    border-radius: 14px;
    box-shadow: 0 8px 22px rgba(0,0,0,0.055);
  }

  .shop-bottom-actions {
    padding-inline: 16px;
  }

  @media (max-width: 360px) {
    .shop-feature-copy strong {
      font-size: 21px;
    }

    .shop-feature-copy em {
      font-size: 12px;
    }

    .shop-grid {
      gap: 6px;
      padding-inline: 12px;
    }

    .shop-card-copy h3 {
      font-size: 10px;
    }
  }

  .shop-page:not(.shop-page--detail) {
    background: #fff;
  }

  .shop-page:not(.shop-page--detail) .shop-top {
    padding: 10px 14px 9px;
    background: #fff;
    border-bottom: 1px solid #eeece7;
    box-shadow: none;
  }

  .shop-page:not(.shop-page--detail) .shop-title-row {
    grid-template-columns: 46px minmax(0, 1fr) 46px;
    min-height: 86px;
    align-items: start;
    padding-top: 2px;
  }

  .shop-store-logo {
    grid-column: 2;
    justify-self: center;
    align-self: start;
    height: 82px;
    display: grid;
    grid-template-columns: 30px auto;
    column-gap: 8px;
    align-items: start;
    justify-content: center;
    color: #1f1a14;
    transform: translateX(7px);
  }

  .shop-logo-badge {
    width: 28px;
    height: 55px;
    border-radius: 2px;
    display: grid;
    place-items: center;
    writing-mode: vertical-rl;
    text-orientation: upright;
    color: #f4dfaa;
    font-family: ${SERIF};
    font-size: 12px;
    font-weight: 900;
    letter-spacing: 0.03em;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.18), transparent 30%),
      linear-gradient(135deg, #7d1516 0%, #3d0707 100%);
    border: 1px solid rgba(132,92,42,0.72);
    box-shadow: inset 0 0 9px rgba(0,0,0,0.34), 0 4px 8px rgba(0,0,0,0.12);
  }

  .shop-logo-main {
    display: grid;
    justify-items: center;
    margin-top: -6px;
    min-width: 148px;
  }

  .shop-logo-kanji {
    font-family: ${SERIF};
    font-size: 38px;
    line-height: 0.96;
    font-weight: 950;
    color: #9b793d;
    text-shadow:
      0 1px 0 #fff4c8,
      0 2px 0 #553613,
      0 4px 7px rgba(0,0,0,0.20);
    letter-spacing: 0;
    background: linear-gradient(180deg, #fff3bd 0%, #c9a052 38%, #704915 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .shop-logo-roman {
    margin-top: -2px;
    font-family: ${MONO};
    font-size: 9px;
    letter-spacing: 0.45em;
    color: #5d5143;
    font-weight: 800;
  }

  .shop-logo-store {
    margin-top: 6px;
    position: relative;
    font-family: ${SERIF};
    font-size: 11px;
    letter-spacing: 0.31em;
    color: #35302a;
    font-weight: 700;
    padding: 0 28px;
    white-space: nowrap;
  }

  .shop-logo-store::before,
  .shop-logo-store::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 22px;
    height: 1px;
    background: #b8a77f;
  }

  .shop-logo-store::before {
    left: 0;
  }

  .shop-logo-store::after {
    right: 0;
  }

  .shop-page:not(.shop-page--detail) .shop-title-row button {
    align-self: start;
    margin-top: 28px;
    width: 44px;
    height: 44px;
    border-color: #e0dbd2;
    box-shadow: none;
  }

  .shop-page:not(.shop-page--detail) .shop-search {
    height: 36px;
    margin-top: 8px;
    padding: 0 12px;
    gap: 9px;
    border: 1.2px solid #d9d5ce;
    box-shadow: 0 3px 10px rgba(0,0,0,0.025);
  }

  .shop-page:not(.shop-page--detail) .shop-search svg:first-child {
    width: 18px;
    height: 18px;
  }

  .shop-page:not(.shop-page--detail) .shop-search span {
    font-size: 13px;
    font-weight: 650;
  }

  .shop-page:not(.shop-page--detail) .shop-filter-icon {
    width: 18px;
    height: 18px;
    padding-left: 12px;
  }

  .shop-page:not(.shop-page--detail) .shop-content {
    gap: 13px;
    padding-top: 10px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-stack {
    gap: 6px;
    padding: 0 8px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card {
    width: 100%;
    min-height: 0;
    height: 143px;
    border-radius: 6px;
    box-shadow: none;
    grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--light {
    background:
      linear-gradient(90deg, rgba(247,245,240,0.96) 0%, rgba(247,245,240,0.76) 45%, rgba(238,232,219,0.30) 100%),
      radial-gradient(circle at 90% 20%, rgba(68,63,55,0.25), transparent 38%);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--light::before {
    background:
      linear-gradient(90deg, rgba(255,255,255,0.50), rgba(255,255,255,0)),
      radial-gradient(circle at 88% 28%, rgba(92,88,78,0.26), transparent 36%),
      linear-gradient(135deg, #f7f5f0 0%, #e6e0d2 100%);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--dark {
    height: 103px;
    grid-template-columns: minmax(0, 0.94fr) minmax(0, 1.06fr);
    background:
      radial-gradient(circle at 86% 20%, rgba(125,18,22,0.36), transparent 31%),
      linear-gradient(112deg, #14100f 0%, #050505 100%);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy {
    gap: 5px;
    padding: 15px 4px 14px 16px;
    align-content: center;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy small {
    font-size: 8.5px;
    letter-spacing: 0.38em;
    color: rgba(48,42,35,0.58);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--dark .shop-feature-copy small {
    color: rgba(213,189,139,0.72);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy strong {
    font-size: 24px;
    line-height: 1;
    letter-spacing: 0.01em;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy em {
    font-size: 12px;
    line-height: 1.55;
    font-weight: 600;
    color: rgba(30,30,30,0.70);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy span {
    margin-top: 5px;
    font-size: 11.5px;
    color: #3f311c;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--dark .shop-feature-copy span {
    color: #d8bc75;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual {
    justify-content: end;
    align-items: end;
    padding: 8px 10px 0 0;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual::before {
    content: '';
    position: absolute;
    right: 0;
    bottom: 0;
    width: 180px;
    height: 34px;
    background: linear-gradient(180deg, rgba(92,86,75,0.20), rgba(44,39,33,0.45));
    transform: skewX(-10deg);
    z-index: -1;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--retail img:first-child {
    width: 93px;
    max-height: 64px;
    transform: translate(7px, -2px);
    filter: drop-shadow(0 9px 8px rgba(0,0,0,0.18));
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--retail img:last-child {
    width: 64px;
    max-height: 112px;
    transform: translateX(0);
    filter: drop-shadow(0 9px 8px rgba(0,0,0,0.20));
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--dark .shop-feature-copy {
    padding-top: 13px;
    padding-bottom: 12px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--dark .shop-feature-copy strong {
    font-size: 24px;
    color: #fffaf0;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--dark .shop-feature-copy em {
    font-size: 11.5px;
    color: rgba(255,255,255,0.75);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--wear img {
    width: 178px;
    height: 116px;
    max-width: 128%;
    transform: translate(12px, 13px) scale(1.20);
    filter: contrast(1.03) saturate(0.96);
  }

  .shop-page:not(.shop-page--detail) .shop-section {
    gap: 8px;
  }

  .shop-page:not(.shop-page--detail) .shop-section-head {
    padding: 0 12px;
  }

  .shop-page:not(.shop-page--detail) .shop-section-head h2 {
    font-size: 21px;
    line-height: 1.05;
  }

  .shop-page:not(.shop-page--detail) .shop-section-head button {
    font-size: 11.5px;
  }

  .shop-page:not(.shop-page--detail) .shop-category-rail {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 7px;
    padding: 0 12px;
  }

  .shop-page:not(.shop-page--detail) .shop-category-icon {
    max-width: 54px;
    border-radius: 10px;
    background: #fbfaf8;
    border-color: #efeae1;
    box-shadow: none;
  }

  .shop-page:not(.shop-page--detail) .shop-category-icon img {
    padding: 6px;
  }

  .shop-page:not(.shop-page--detail) .shop-category-card {
    gap: 5px;
  }

  .shop-page:not(.shop-page--detail) .shop-category-card span {
    font-size: 9.5px;
    font-weight: 750;
  }

  .shop-page:not(.shop-page--detail) .shop-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 7px;
    padding: 0 12px;
  }

  .shop-page:not(.shop-page--detail) .shop-card {
    border-radius: 9px;
    border-color: #ebe7df;
    box-shadow: none;
  }

  .shop-page:not(.shop-page--detail) .shop-image {
    padding: 7px;
  }

  .shop-page:not(.shop-page--detail) .shop-favorite {
    top: 5px;
    right: 5px;
    width: 22px;
    height: 22px;
    color: rgba(60,60,60,0.58);
    box-shadow: none;
  }

  .shop-page:not(.shop-page--detail) .shop-card-copy {
    min-height: 47px;
    padding: 5px 6px 7px;
    gap: 3px;
  }

  .shop-page:not(.shop-page--detail) .shop-card-copy h3 {
    min-height: 24px;
    font-size: 9.7px;
    line-height: 1.25;
    font-weight: 650;
  }

  .shop-page:not(.shop-page--detail) .shop-price-row {
    min-height: 13px;
  }

  .shop-page:not(.shop-page--detail) .shop-price-row strong {
    font-size: 10.8px;
    font-weight: 750;
  }

  .shop-page:not(.shop-page--detail) .shop-title-row {
    min-height: 84px;
  }

  .shop-page:not(.shop-page--detail) .shop-store-logo {
    height: 79px;
    grid-template-columns: 28px auto;
    column-gap: 7px;
    transform: translateX(3px);
  }

  .shop-page:not(.shop-page--detail) .shop-logo-badge {
    width: 26px;
    height: 54px;
    font-size: 11px;
  }

  .shop-page:not(.shop-page--detail) .shop-logo-main {
    margin-top: -4px;
    min-width: 142px;
  }

  .shop-page:not(.shop-page--detail) .shop-logo-kanji {
    font-size: 35px;
    line-height: 0.98;
    text-shadow:
      0 1px 0 #fff6cc,
      0 2px 0 #5c3b14,
      0 3px 5px rgba(0,0,0,0.16);
  }

  .shop-page:not(.shop-page--detail) .shop-logo-roman {
    margin-top: -1px;
    font-size: 8px;
    letter-spacing: 0.38em;
    transform: translateX(0.18em);
  }

  .shop-page:not(.shop-page--detail) .shop-logo-store {
    margin-top: 5px;
    font-size: 10px;
    letter-spacing: 0.30em;
    padding: 0 26px;
  }

  .shop-page:not(.shop-page--detail) .shop-title-row button {
    margin-top: 25px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-stack {
    gap: 7px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card {
    border-radius: 7px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--light {
    background:
      linear-gradient(90deg, rgba(248,247,244,0.98) 0%, rgba(248,247,244,0.88) 48%, rgba(230,225,215,0.60) 100%),
      radial-gradient(circle at 91% 22%, rgba(74,70,63,0.22), transparent 40%);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--light::before {
    background:
      linear-gradient(90deg, rgba(255,255,255,0.64), rgba(255,255,255,0.02)),
      linear-gradient(145deg, rgba(246,244,239,0.94) 0%, rgba(213,207,195,0.64) 100%);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-card--dark {
    background:
      linear-gradient(90deg, rgba(0,0,0,0.24), rgba(0,0,0,0)),
      radial-gradient(circle at 76% 0%, rgba(129,18,21,0.38), transparent 38%),
      linear-gradient(115deg, #15110f 0%, #070707 78%);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy {
    padding-left: 17px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy strong {
    font-size: 23px;
    line-height: 1.12;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-copy span svg {
    width: 12px;
    height: 12px;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--retail img {
    mix-blend-mode: multiply;
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--retail img:first-child {
    width: 90px;
    max-height: 70px;
    transform: translate(10px, -3px);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--retail img:last-child {
    width: 58px;
    max-height: 114px;
    transform: translate(-2px, -2px);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--wear {
    background:
      linear-gradient(90deg, rgba(0,0,0,0), rgba(22,20,19,0.50)),
      radial-gradient(circle at 72% 38%, rgba(255,255,255,0.10), transparent 38%);
  }

  .shop-page:not(.shop-page--detail) .shop-feature-visual--wear img {
    mix-blend-mode: multiply;
    width: 186px;
    height: 124px;
    transform: translate(13px, 14px) scale(1.22);
  }

  .shop-page:not(.shop-page--detail) .shop-grid {
    gap: 8px;
  }

  .shop-page:not(.shop-page--detail) .shop-card {
    border-radius: 10px;
  }

  .shop-page:not(.shop-page--detail) .shop-image {
    padding: 8px;
  }

  .shop-page:not(.shop-page--detail) .shop-image img {
    max-width: 82%;
    max-height: 82%;
  }

  .shop-page:not(.shop-page--detail) .shop-card-copy {
    min-height: 68px;
    padding: 6px 7px 8px;
  }

  .shop-page:not(.shop-page--detail) .shop-card-copy h3 {
    min-height: 38px;
    font-size: 9.2px;
    line-height: 1.28;
    font-weight: 700;
    -webkit-line-clamp: 3;
  }

  .shop-page:not(.shop-page--detail) .shop-price-row strong {
    color: #2b2723;
    font-size: 11px;
    font-weight: 800;
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

  const displayRetailProducts = retailProducts.length > 0 ? retailProducts : FALLBACK_RETAIL_PRODUCTS

  const shopProducts = useMemo(
    () => [...displayRetailProducts, ...STATIC_PRODUCTS],
    [displayRetailProducts],
  )

  const recommendedProducts = useMemo(() => shopProducts.slice(0, 6), [shopProducts])
  const saleProducts = useMemo(
    () => shopProducts.filter((product) => product.discount || product.category === 'sale').slice(0, 6),
    [shopProducts],
  )
  const rankingProducts = useMemo(() => shopProducts.slice(0, 3), [shopProducts])
  const newProducts = useMemo(() => [...STATIC_PRODUCTS, ...displayRetailProducts].slice(0, 6), [displayRetailProducts])
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
          <div className="shop-store-logo" aria-label="銀二郎 ONLINE STORE">
            <span className="shop-logo-badge">二代目</span>
            <span className="shop-logo-main">
              <span className="shop-logo-kanji">銀二郎</span>
              <span className="shop-logo-roman">GINJIRO</span>
              <span className="shop-logo-store">ONLINE STORE</span>
            </span>
          </div>
          <button type="button" aria-label="カート">
            <ShoppingCart size={22} strokeWidth={2} />
          </button>
        </div>
        <div className="shop-search" role="search">
          <Search size={20} strokeWidth={2.3} />
          <span>商品を検索</span>
          <SlidersHorizontal className="shop-filter-icon" size={20} strokeWidth={2.1} />
        </div>
      </header>

      <div className="shop-content">
        <section className="shop-feature-stack" aria-label="注目エリア">
          <button type="button" className="shop-feature-card shop-feature-card--light" aria-label="今週のおすすめ">
            <span className="shop-feature-copy">
              <small>THIS WEEK</small>
              <strong>今週のおすすめ</strong>
              <em>銀二郎が選ぶ、<br />こだわりのアイテム。</em>
              <span>アイテムを見る <ChevronRight size={14} /></span>
            </span>
            <span className="shop-feature-visual shop-feature-visual--retail">
              <img src={SHOP_IMAGES.broshHardPomade} alt="" />
              <img src={SHOP_IMAGES.broshBaseSpray} alt="" />
            </span>
          </button>
          <button type="button" className="shop-feature-card shop-feature-card--dark" aria-label="新作入荷予定">
            <span className="shop-feature-copy">
              <small>NEW ARRIVAL</small>
              <strong>新作入荷予定</strong>
              <em>日常に、銀二郎のこだわりを。</em>
              <span>ラインナップを見る <ChevronRight size={14} /></span>
            </span>
            <span className="shop-feature-visual shop-feature-visual--wear">
              <img src={SHOP_IMAGES.hoodie} alt="" />
            </span>
          </button>
        </section>

        <section className="shop-section">
          <SectionHeader title="カテゴリー" action="すべて見る" />
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
          <SectionHeader title="期間限定" action="おすすめ" />
          <div className="shop-sale-rail">
            {(saleProducts.length > 0 ? saleProducts : recommendedProducts.slice(0, 4)).map((product) => (
              <ProductCard
                key={`${product.id}-sale`}
                product={product}
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
