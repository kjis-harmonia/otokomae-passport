// Central registry: hero image paths shared by HeroSlider and style cards.
// To add a new style image: add one entry here — slider and cards update automatically.

export interface StyleImageDef {
  src: string
  position: string          // CSS objectPosition — tuned per image to keep face visible
  detailTopOpacity?: number // top gradient opacity in StyleDetailModal (default 0.52)
}

const REGISTRY: Array<{ key: string } & StyleImageDef> = [
  { key: '濡れパン',         src: '/assets/hero-nurepan.jpg',      position: '50% 35%' },
  { key: 'カールアイパー',   src: '/assets/hero-curl-iper.jpg',    position: '50% 30%' },
  { key: '夏ニグロ',         src: '/assets/hero-natsu-niguro.jpg', position: '50% 32%' },
  { key: 'パンチパーマ',     src: '/assets/hero-punch-perm.jpg',   position: '50% 35%' },
  { key: '銀パラ',           src: '/assets/ginpara.png',           position: '50% 34%' },
  { key: 'テイテイ刈り',     src: '/assets/teitei-gari.png',       position: '50% 24%', detailTopOpacity: 0.30 },
  { key: '極道ボウズ',       src: '/assets/gokudo-bozu.png',       position: '50% 30%' },
  { key: '昭和のアイパー',   src: '/assets/showa-aiper.png',       position: '50% 30%' },
  { key: 'リーゼントパンチ', src: '/assets/rejent-punch.png',      position: '50% 30%' },
  { key: 'ジャマイカンアフロ', src: '/assets/jamaican-afro.png',   position: '50% 30%' },
  { key: 'スペインパーマ',     src: '/assets/spain-parm.jpeg',    position: '50% 30%' },
  { key: 'トラック野郎御用達', src: '/assets/truck-yaro.png',     position: '50% 50%' },
  { key: 'シンサイパンチ',     src: '/assets/shinsai-punch.png', position: '50% 30%' },
  { key: '覚醒の色',           src: '/assets/kakusei.png',        position: '50% 30%' },
  { key: 'ギリギリパーマ',     src: '/assets/ri-man-parm.png',    position: '50% 28%' },
  { key: '昭和ヘアスタイル',   src: '/assets/showa-hair.png',     position: '50% 28%' },
]

const DEFAULT_POSITION = '50% 30%'
const DEFAULT_DETAIL_TOP_OPACITY = 0.52

// HeroSlider slides — same sources and order as REGISTRY.
export const HERO_SLIDE_IMAGES: ReadonlyArray<{
  src: string
  alt: string
  position: string
}> = REGISTRY.map((e) => ({ src: e.src, alt: '男前スタイル', position: e.position }))

// Resolve the display image URL for a style card.
// Priority: stored imageUrl → title-based lookup → ''
export function resolveStyleImageUrl(style: { title: string; imageUrl: string }): string {
  if (style.imageUrl) return style.imageUrl
  return REGISTRY.find((e) => style.title.includes(e.key))?.src ?? ''
}

// Resolve the CSS objectPosition for a style card.
export function resolveStyleImagePosition(style: { title: string }): string {
  return REGISTRY.find((e) => style.title.includes(e.key))?.position ?? DEFAULT_POSITION
}

// Resolve the top gradient opacity for StyleDetailModal hero image.
// Allows per-style brightening without affecting the bottom text overlay.
export function resolveDetailTopOpacity(style: { title: string }): number {
  return REGISTRY.find((e) => style.title.includes(e.key))?.detailTopOpacity ?? DEFAULT_DETAIL_TOP_OPACITY
}
