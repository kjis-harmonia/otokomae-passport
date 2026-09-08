import type { StyleCard } from './styleCard'
import { resolveStyleImageUrl } from './styleImages'

// Style tab poster artwork. Keep this separate from Home hero assets.
const STYLE_LIBRARY_IMAGES: ReadonlyArray<{ key: string; src: string }> = [
  { key: '俺は濡れパン', src: '/assets/styles/library-nurepan.jpg' },
  { key: 'テイテイ刈り', src: '/assets/styles/library-teitei.jpg' },
  { key: '昭和のアイパー', src: '/assets/styles/library-showa-aipar.jpg' },
  { key: '昭和ヘアスタイル', src: '/assets/styles/library-showa-hair.jpg' },
  { key: 'ジャマイカンアフロ', src: '/assets/styles/library-jamaican-afro.jpg' },
  { key: 'トラック野郎御用達', src: '/assets/styles/library-truck-yaro.jpg' },
  { key: '海の男専用', src: '/assets/styles/library-uminotoko.jpg' },
  { key: 'シンサイ刈り', src: '/assets/styles/library-shinsaigari.jpg' },
  { key: 'シンサイパンチ', src: '/assets/styles/library-shinsai-punch.jpg' },
  { key: 'サラリーマン専用 ギリギリパーマ', src: '/assets/styles/library-ri-man-parm.jpg' },
  { key: 'スペインパーマ', src: '/assets/styles/library-spain-perm.jpg' },
  { key: 'ニグロパーマ', src: '/assets/styles/library-nigro.jpg' },
  { key: 'サイドバックアイパー', src: '/assets/styles/library-sideback-aipar.jpg' },
  { key: 'リーゼントパンチ', src: '/assets/styles/library-rejent-punch.jpg' },
  { key: 'ヤンキーパンチ', src: '/assets/styles/library-yanki-punch.jpg' },
  { key: 'バチバチパンチパーマ', src: '/assets/styles/library-punch-perm.jpg' },
  { key: 'カールアイパー', src: '/assets/styles/library-curl-iper.jpg' },
]

export function resolveStyleLibraryImageUrl(style: Pick<StyleCard, 'title' | 'imageUrl'>): string {
  return STYLE_LIBRARY_IMAGES.find((entry) => style.title.includes(entry.key))?.src
    ?? resolveStyleImageUrl(style)
}
