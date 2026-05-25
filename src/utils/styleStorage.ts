/**
 * StyleCard repository — localStorage implementation.
 *
 * Migration guide (Firebase / Supabase):
 *   1. Replace `loadStyles`   → collection.get() / .select()
 *   2. Replace `createStyle`  → collection.add() / .insert()
 *   3. Replace `updateStyle`  → doc.update() / .update()
 *   4. Replace `deleteStyle`  → doc.delete() / .delete()
 *   5. Replace `moveStyle`    → batch update of sortOrder field
 *   All function signatures remain identical — callers need no changes.
 */

import type { StyleCard, StyleCardDraft } from '../data/styleCard'
import { getStoredValue, setStoredValue } from './storage'

export const STYLES_STORAGE_KEY = 'ginjiro_cms_styles'

/* ── Internal helpers ──────────────────────────────────────────── */

function generateId(): string {
  return `style-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function now(): string {
  return new Date().toISOString()
}

function readAll(): StyleCard[] {
  return getStoredValue<StyleCard[]>(STYLES_STORAGE_KEY, [])
}

function writeAll(styles: StyleCard[]): void {
  setStoredValue(STYLES_STORAGE_KEY, styles)
}

/* ── Public API ────────────────────────────────────────────────── */

/** Load all styles sorted by sortOrder ascending. */
export function loadStyles(): StyleCard[] {
  return [...readAll()].sort((a, b) => a.sortOrder - b.sortOrder)
}

/** Create a new style and persist it. Returns the created record. */
export function createStyle(draft: StyleCardDraft): StyleCard {
  const existing = readAll()
  const maxOrder =
    existing.length > 0 ? Math.max(...existing.map((s) => s.sortOrder)) : -1
  const style: StyleCard = {
    ...draft,
    id: generateId(),
    sortOrder: draft.sortOrder > maxOrder ? draft.sortOrder : maxOrder + 1,
    createdAt: now(),
    updatedAt: now(),
  }
  writeAll([...existing, style])
  return style
}

/** Overwrite specific fields of an existing style. Returns updated record or null. */
export function updateStyle(
  id: string,
  patch: Partial<Omit<StyleCard, 'id' | 'createdAt'>>,
): StyleCard | null {
  const all = readAll()
  const idx = all.findIndex((s) => s.id === id)
  if (idx === -1) return null
  const updated: StyleCard = { ...all[idx], ...patch, updatedAt: now() }
  all[idx] = updated
  writeAll(all)
  return updated
}

/** Delete a style by id. */
export function deleteStyle(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id))
}

/** Move a style one step up or down in sortOrder. */
export function moveStyle(id: string, direction: 'up' | 'down'): void {
  const sorted = loadStyles()
  const idx = sorted.findIndex((s) => s.id === id)
  if (idx === -1) return
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= sorted.length) return
  const tempOrder = sorted[idx].sortOrder
  sorted[idx] = { ...sorted[idx], sortOrder: sorted[swapIdx].sortOrder }
  sorted[swapIdx] = { ...sorted[swapIdx], sortOrder: tempOrder }
  writeAll(sorted)
}

/** Computed stats for the dashboard. */
export function loadStyleStats() {
  const all = loadStyles()
  return {
    total: all.length,
    published: all.filter((s) => s.isPublished).length,
    unpublished: all.filter((s) => !s.isPublished).length,
    featured: all.filter((s) => s.isFeatured).length,
  }
}

/* ── Seed data ─────────────────────────────────────────────────── */

const SEED_DRAFTS: StyleCardDraft[] = [
  {
    title: '夜勤帰りのダンディ',
    category: 'premium',
    catchCopy: '朝まで崩れない。すれ違う女が振り返る究極の持続力。',
    description:
      '夜通し働いた後でも乱れることなく品格を保ち続けるプレミアムスタイル。高持続力の整髪料と精密なカットが生む、疲れすら色気に変える大人の余裕。仕事でも遊びでも、常に最高の自分でいたい男のために。',
    price: 13200,
    durationMinutes: 90,
    imageUrl: '',
    tags: ['ダンディ', '色気', 'モテ', 'プレミアム', '持続力'],
    stats: { intimidation: 3, sexiness: 5, popularity: 5, difficulty: 2, durability: 5 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 0,
  },
  {
    title: '俺は濡れパン',
    category: 'modern',
    catchCopy: '滴る色気。水面が揺れるような艶が男を語る。',
    description:
      '濡れたような光沢感がクセになるモダンウェットスタイル。強い整髪料で毛流れを作り、光を操ることで圧倒的な色気を演出する。デートにも夜の席にも対応する万能の艶男スタイル。',
    price: 8800,
    durationMinutes: 60,
    imageUrl: '',
    tags: ['ウェット', '艶', 'モテ', '色気', 'モダン'],
    stats: { intimidation: 4, sexiness: 5, popularity: 4, difficulty: 3, durability: 3 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 1,
  },
  {
    title: 'バチバチパンチパーマ',
    category: 'premium',
    catchCopy: '頂点を極めた渦。これをまとえる男に、世界が道を空ける。',
    description:
      '銀二郎最高峰の技が生み出す究極のパンチパーマ。バチバチに締まったカールの密度と均一性は職人の魂が宿る芸術品。着こなせる男を選ぶが故に、持つ者の格を何倍にも押し上げる。覚悟ある男だけに許された一手。',
    price: 16500,
    durationMinutes: 120,
    imageUrl: '',
    tags: ['パンチパーマ', '個性', '威圧', 'プレミアム', '覚悟'],
    stats: { intimidation: 5, sexiness: 4, popularity: 3, difficulty: 5, durability: 4 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 2,
  },
  {
    title: '昭和のアイパー',
    category: 'classic',
    catchCopy: '昭和の猛者が選んだ不滅のカール。威圧感は時代を超える。',
    description:
      'アイロンパーマで作り上げた昭和男の美学。硬派なカールが醸し出す威圧感は現代でも健在。シャツを一枚はだけて着こなせば、その男臭さは誰にも敵わない。',
    price: 9900,
    durationMinutes: 90,
    imageUrl: '',
    tags: ['クラシック', '昭和', 'アイパー', '威圧', '硬派'],
    stats: { intimidation: 5, sexiness: 4, popularity: 3, difficulty: 4, durability: 4 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 3,
  },
  {
    title: 'ツイストスパイラル',
    category: 'modern',
    catchCopy: '繊細な螺旋が生む都会の洗練。女性の視線が集まる現代の武器。',
    description:
      '細かいツイストパーマで作り上げた現代男の武器。都会的な洗練と遊び心が共存し、ビジネスシーンでも使える上品さを持ちながら女性ウケ抜群の親しみやすさも兼ね備える。トレンドを押さえながら個性を出したい男に。',
    price: 9350,
    durationMinutes: 75,
    imageUrl: '',
    tags: ['ツイスト', 'モダン', 'トレンド', '女ウケ', '螺旋'],
    stats: { intimidation: 2, sexiness: 4, popularity: 5, difficulty: 3, durability: 3 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 4,
  },
  {
    title: 'ジャマイカンアフロ',
    category: 'casual',
    catchCopy: '自然の膨らみを愛せ。飾らない男の自由がここにある。',
    description:
      '天然のうねりを最大限に活かし、自由奔放な存在感を発揮するアフロスタイル。セット不要で毎朝ノーストレス。個性的でありながら親しみやすく、どんな場所でも「あいつ、いいな」と思わせる不思議な魅力を持つ。',
    price: 7700,
    durationMinutes: 45,
    imageUrl: '',
    tags: ['アフロ', 'ナチュラル', '個性', 'カジュアル', 'メンテフリー'],
    stats: { intimidation: 3, sexiness: 3, popularity: 4, difficulty: 1, durability: 5 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 5,
  },
  {
    title: 'トラック野郎御用達',
    category: 'classic',
    catchCopy: '道を切り拓く男の証。余計なものは全部削ぎ落とした。',
    description:
      '無駄を排した硬派なショートスタイル。整髪料も最小限で済み、走り込んでも乱れない耐久性が魅力。かつて日本の道路を支配した男たちが愛した、ストレートで潔い男の美学を現代に伝える。',
    price: 5500,
    durationMinutes: 40,
    imageUrl: '',
    tags: ['硬派', '威圧', 'クラシック', '短髪', 'メンテフリー'],
    stats: { intimidation: 5, sexiness: 3, popularity: 2, difficulty: 1, durability: 5 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 6,
  },
  {
    title: '夏ニグロ',
    category: 'seasonal',
    catchCopy: '夏の熱気に負けない。潔さが男を際立たせる。',
    description:
      '夏に映える短めスタイルを銀二郎流に昇華。暑さを味方につけた爽快感と刈り上げラインの美しさが生む清潔感は、真夏のどんな場所でも男を輝かせる。ナイトプールでも海でも視線を独り占めにする夏限定の男前。',
    price: 6600,
    durationMinutes: 45,
    imageUrl: '',
    tags: ['夏', 'シーズナル', 'さっぱり', 'モテ', '刈り上げ'],
    stats: { intimidation: 3, sexiness: 4, popularity: 4, difficulty: 2, durability: 4 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 7,
  },
]

/**
 * Populate the store with initial styles when it is empty.
 * Safe to call on every app start — no-ops if data already exists.
 */
export function seedInitialStyles(): void {
  if (readAll().length > 0) return
  const ts = now()
  const seeded: StyleCard[] = SEED_DRAFTS.map((draft, i) => ({
    ...draft,
    id: `seed-${String(i + 1).padStart(2, '0')}`,
    createdAt: ts,
    updatedAt: ts,
  }))
  writeAll(seeded)
}
