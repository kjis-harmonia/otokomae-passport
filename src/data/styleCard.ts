export type StyleCategory = 'classic' | 'modern' | 'casual' | 'premium' | 'seasonal'

export const STYLE_CATEGORY_LABELS: Record<StyleCategory, string> = {
  classic: 'クラシック',
  modern: 'モダン',
  casual: 'カジュアル',
  premium: 'プレミアム',
  seasonal: 'シーズナル',
}

export const STYLE_CATEGORIES: StyleCategory[] = [
  'classic',
  'modern',
  'casual',
  'premium',
  'seasonal',
]

export interface StyleStats {
  intimidation: number  // 威圧感   1–5
  sexiness: number      // 色気      1–5
  popularity: number    // 女ウケ    1–5
  difficulty: number    // セット難易度 1–5
  durability: number    // 持続力    1–5
}

export const STATS_KEYS = [
  'intimidation',
  'sexiness',
  'popularity',
  'difficulty',
  'durability',
] as const satisfies (keyof StyleStats)[]

export const STATS_LABELS: Record<keyof StyleStats, string> = {
  intimidation: '威圧感',
  sexiness: '色気',
  popularity: '女ウケ',
  difficulty: 'セット難易度',
  durability: '持続力',
}

export interface StyleCard {
  id: string
  title: string
  category: StyleCategory
  catchCopy: string
  description: string
  price: number
  durationMinutes: number
  imageUrl: string
  tags: string[]
  stats: StyleStats
  isFeatured: boolean
  isPublished: boolean
  sortOrder: number
  createdAt: string  // ISO 8601
  updatedAt: string  // ISO 8601
}

export const DEFAULT_STATS: StyleStats = {
  intimidation: 3,
  sexiness: 3,
  popularity: 3,
  difficulty: 2,
  durability: 3,
}

export type StyleCardDraft = Omit<StyleCard, 'id' | 'createdAt' | 'updatedAt'>
