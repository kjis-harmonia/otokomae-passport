import type { StyleCard } from './styleCard'
import { resolveStyleImageUrl } from './styleImages'

// Style tab poster artwork. Keep this separate from Home hero assets.
const STYLE_LIBRARY_IMAGES: ReadonlyArray<{ key: string; src: string }> = [
  { key: '俺は濡れパン', src: '/assets/styles/library-nurepan.jpg' },
  { key: 'テイテイ刈り', src: '/assets/styles/library-teitei.jpg' },
  { key: '昭和のアイパー', src: '/assets/styles/library-showa-aipar.jpg' },
  { key: '昭和ヘアスタイル', src: '/assets/styles/library-showa-hair.jpg' },
  { key: 'ジャマイカンアフロ', src: '/assets/styles/library-jamaican-afro.jpg' },
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
