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
import { resolveStyleImageUrl } from '../data/styleImages'
import { getStoredValue, setStoredValue } from './storage'

export const STYLES_STORAGE_KEY = 'ginjiro_cms_styles'

// Bump STYLES_DATA_VERSION whenever SEED_DRAFTS change in a breaking way
// (imageUrl corrections, title renames, structural changes).
// Incremental additions (new styles, price tweaks) do NOT need a bump —
// the diff-based migration below handles those automatically.
export const STYLES_VERSION_KEY = 'ginjiro_cms_version'
export const STYLES_DATA_VERSION = 2

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
    title: 'トラック野郎御用達',
    category: 'classic',
    catchCopy: '仕事終わりでもピシャッと決まる。漢のための実用主義スタイル。',
    description:
      '無駄を排した硬派なショートスタイル。整髪料も最小限で済み、走り込んでも乱れない耐久性が魅力。かつて日本の道路を支配した男たちが愛した、ストレートで潔い男の美学を現代に伝える。',
    price: 3500,
    durationMinutes: 40,
    imageUrl: '/assets/truck-yaro.png',
    tags: ['硬派', '威圧', 'クラシック', '短髪', 'メンテフリー'],
    stats: { intimidation: 5, sexiness: 3, popularity: 2, difficulty: 1, durability: 5 },
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
    imageUrl: '/assets/hero-nurepan.jpg',
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
    price: 8000,
    durationMinutes: 120,
    imageUrl: '/assets/hero-punch-perm.jpg',
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
    price: 8000,
    durationMinutes: 90,
    imageUrl: '/assets/styles/showa-aipar.png',
    tags: ['クラシック', '昭和', 'アイパー', '威圧', '硬派'],
    stats: { intimidation: 5, sexiness: 4, popularity: 3, difficulty: 4, durability: 4 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 3,
  },
  {
    title: 'カールアイパー',
    category: 'classic',
    catchCopy: 'カールが語る男の矜持。時代を超える不滅の艶。',
    description:
      'アイロンパーマで生み出した均一なカールが、男の色気を最大限に引き出す。昭和の男たちが愛した伝統技法を現代に昇華した、銀二郎の職人技が光る一手。',
    price: 8000,
    durationMinutes: 75,
    imageUrl: '/assets/hero-curl-iper.jpg',
    tags: ['アイパー', 'クラシック', 'カール', '色気', '職人技'],
    stats: { intimidation: 4, sexiness: 4, popularity: 3, difficulty: 4, durability: 4 },
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
    price: 9000,
    durationMinutes: 45,
    imageUrl: '/assets/jamaican-afro.png',
    tags: ['アフロ', 'ナチュラル', '個性', 'カジュアル', 'メンテフリー'],
    stats: { intimidation: 3, sexiness: 3, popularity: 4, difficulty: 1, durability: 5 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 5,
  },
  {
    title: '夏ニグロ',
    category: 'seasonal',
    catchCopy: '夏の熱気に負けない。潔さが男を際立たせる。',
    description:
      '夏に映える短めスタイルを銀二郎流に昇華。暑さを味方につけた爽快感と刈り上げラインの美しさが生む清潔感は、真夏のどんな場所でも男を輝かせる。ナイトプールでも海でも視線を独り占めにする夏限定の男前。',
    price: 9000,
    durationMinutes: 45,
    imageUrl: '/assets/hero-natsu-niguro.jpg',
    tags: ['夏', 'シーズナル', 'さっぱり', 'モテ', '刈り上げ'],
    stats: { intimidation: 3, sexiness: 4, popularity: 4, difficulty: 2, durability: 4 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 7,
  },
  {
    title: '銀パラ',
    category: 'premium',
    catchCopy: '銀の艶が宿る。それが本物の男の顔だ。',
    description:
      '銀二郎が誇る特製パーマ。艶感と自然な動きのバランスが絶妙で、どんな角度から見ても隙のない存在感を放つ。ナイトシーンからビジネスまで一貫した品格を保つ、本物の男前のための一手。',
    price: 15000,
    durationMinutes: 90,
    imageUrl: '/assets/ginpara.png',
    tags: ['パーマ', '艶', '色気', 'プレミアム', '経営者'],
    stats: { intimidation: 3, sexiness: 5, popularity: 4, difficulty: 2, durability: 4 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 8,
  },
  {
    title: 'テイテイ刈り',
    category: 'classic',
    catchCopy: 'ギリギリまで刈り込む。その線が男の矜持だ。',
    description:
      'サイドを極限まで刈り上げ、トップとのコントラストで輪郭を際立たせる硬派な刈り込みスタイル。手間いらずでいつでも整った顔を作り、清潔感と威圧感を同時に放つ。覚悟を決めた男だけが纏える一択。',
    price: 8000,
    durationMinutes: 50,
    imageUrl: '/assets/teitei-gari.png',
    tags: ['刈り上げ', '威圧', '硬派', '夜職', '清潔感'],
    stats: { intimidation: 4, sexiness: 3, popularity: 3, difficulty: 1, durability: 5 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 9,
  },
  {
    title: '極道ボウズ',
    category: 'casual',
    catchCopy: '無駄を削ぎ落とした男の覚悟。',
    description:
      '限界まで短く刈り込んだ潔さ。\n飾らない。誤魔化さない。\n男の生き様がそのまま出るスタイル。',
    price: 3500,
    durationMinutes: 30,
    imageUrl: '/assets/gokudo-bozu.png',
    tags: ['坊主', '漢', 'シンプル', '短髪', '男前'],
    stats: { intimidation: 5, sexiness: 3, popularity: 2, difficulty: 1, durability: 5 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 10,
  },
  {
    title: 'リーゼントパンチ',
    category: 'classic',
    catchCopy: 'リーゼントの型にパンチの魂。昭和の凄みが宿る二刀流。',
    description:
      '前髪を高く立ち上げたリーゼントにパンチパーマの渦を組み合わせた、銀二郎渾身の昭和男前スタイル。どちらか一方では語れない圧倒的な存在感を放つ。やれる男にだけ許された究極の一手。',
    price: 8000,
    durationMinutes: 100,
    imageUrl: '/assets/styles/rejent-punch2.png',
    tags: ['リーゼント', 'パンチパーマ', '昭和', '威圧', '二刀流'],
    stats: { intimidation: 5, sexiness: 4, popularity: 3, difficulty: 5, durability: 4 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 11,
  },
  {
    title: 'スペインパーマ',
    category: 'modern',
    catchCopy: '艶と動きで女を落とす。舶来の波が男を変える。',
    description:
      'スペイン系のウェーブパターンを取り入れた色気系パーマ。緩やかで均一なウェーブが艶感を生み、見る者を魅了する。ナイトシーンでもデイリーでも、一段上の男を演出する現代の武器。',
    price: 8000,
    durationMinutes: 75,
    imageUrl: '/assets/spain-parm.jpeg',
    tags: ['パーマ', 'ウェーブ', '色気', 'モテ', '舶来'],
    stats: { intimidation: 2, sexiness: 5, popularity: 5, difficulty: 3, durability: 3 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 12,
  },
  {
    title: 'シンサイパンチ',
    category: 'premium',
    catchCopy: 'バチッと決めて、気分も上々。',
    description:
      '難波の夜を支配する現代版パンチパーマ。シュッと締まったカールの密度が男の存在感を倍増させる。銀二郎が誇る熟練の技で仕上げる、今夜の戦場に挑む男たちへの必勝スタイル。',
    price: 8000,
    durationMinutes: 120,
    imageUrl: '/assets/styles/shinsai-punch.png',
    tags: ['パンチパーマ', '威圧', '個性', '漢', '難波'],
    stats: { intimidation: 5, sexiness: 3, popularity: 3, difficulty: 4, durability: 4 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 13,
  },
  {
    title: '覚醒の色',
    category: 'modern',
    catchCopy: '常識を、ぶっ壊せ。',
    description:
      '常識という名の檻を、色で壊す。銀二郎が提案する大胆なカラーリングは、あなたの中に眠る野性を目覚めさせる。見た瞬間に空気が変わる——覚悟した男だけに許された一手。',
    price: 14500,
    durationMinutes: 90,
    imageUrl: '/assets/styles/kakusei.png',
    tags: ['カラー', '個性', '覚醒', 'モテ', '大胆'],
    stats: { intimidation: 4, sexiness: 5, popularity: 4, difficulty: 3, durability: 3 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 14,
  },
  {
    title: 'サラリーマン専用 ギリギリパーマ',
    category: 'modern',
    catchCopy: '会社でも怒られない。でも、男は上がる。',
    description:
      '会社のルールの隙間を突く、男のギリギリ戦略。適度なウェーブが清潔感を保ちながら、確実に女ウケを上げる。デスクでも居酒屋でも、どこでも使えるオールラウンド男前の完成形。',
    price: 8000,
    durationMinutes: 75,
    imageUrl: '/assets/styles/ri-man-parm.png',
    tags: ['パーマ', 'ビジネス', 'モテ', '清潔感', 'ギリギリ'],
    stats: { intimidation: 2, sexiness: 4, popularity: 5, difficulty: 2, durability: 3 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 15,
  },
  {
    title: 'ちょい悪オヤジ専用 昭和ヘアスタイル',
    category: 'classic',
    catchCopy: '渋く、粋に、そしてカッコよく。',
    description:
      '年を重ねたからこそ出せる、本物の色気。昭和の美学を受け継いだ渋みと大人の余裕が滲み出るスタイル。若い奴には絶対に出せない、ちょい悪の真髄がここにある。',
    price: 8000,
    durationMinutes: 60,
    imageUrl: '/assets/styles/showa-hair.png',
    tags: ['昭和', '渋い', 'ちょい悪', 'クラシック', '大人'],
    stats: { intimidation: 4, sexiness: 4, popularity: 3, difficulty: 2, durability: 4 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 16,
  },
  {
    title: 'サイドバックアイパー',
    category: 'classic',
    catchCopy: 'サイドを制する男が、時代を制する。',
    description:
      'サイドとバックをアイロンパーマで締め上げた昭和硬派の完成形。横から見ても後ろから見ても隙がない、360度男前を体現するスタイル。',
    price: 8000,
    durationMinutes: 90,
    imageUrl: '/assets/styles/sidebuck.png',
    tags: ['アイパー', '昭和', '硬派', '威圧', 'クラシック'],
    stats: { intimidation: 5, sexiness: 3, popularity: 2, difficulty: 4, durability: 4 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 17,
  },
  {
    title: 'ヤンキーパンチ',
    category: 'classic',
    catchCopy: '街を睨みつける。それがヤンキーの流儀。',
    description:
      '昭和のストリートを生きた男たちが誇るパンチパーマ。バチッと渦巻くカールが纏う男の気迫は、時代を超えて圧倒的な存在感を放ち続ける。着こなせる者だけが持つ、本物の威圧感。',
    price: 8000,
    durationMinutes: 120,
    imageUrl: '/assets/styles/yanki-punch.png',
    tags: ['パンチパーマ', 'ヤンキー', '昭和', '威圧', '硬派'],
    stats: { intimidation: 5, sexiness: 3, popularity: 2, difficulty: 4, durability: 4 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 18,
  },
  {
    title: 'ニグロパーマ',
    category: 'modern',
    catchCopy: '渦の密度が、男の格を語る。',
    description:
      '細かく均一に刻まれたカールが生み出す圧倒的な存在感。銀二郎の職人技が際立つ王道パーマの真髄。どんな場所でも一目置かれる、本物の男前を作り上げる。',
    price: 9000,
    durationMinutes: 100,
    imageUrl: '/assets/styles/nigro.png',
    tags: ['パーマ', '王道', '威圧', '密度', '職人技'],
    stats: { intimidation: 4, sexiness: 4, popularity: 3, difficulty: 4, durability: 4 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 19,
  },
  {
    title: '銀パラカーリー',
    category: 'premium',
    catchCopy: '銀二郎が誇る、究極のカール。',
    description:
      '銀二郎特製のカーリーパーマが生み出す、見る者を圧倒する存在感。艶と威圧感を両立させた至高の一手。王道でありながら、その場の空気を支配する力を持つ。',
    price: 15000,
    durationMinutes: 120,
    imageUrl: '/assets/styles/ginpara.png',
    tags: ['パーマ', 'カーリー', '威圧', '艶', 'プレミアム'],
    stats: { intimidation: 5, sexiness: 4, popularity: 3, difficulty: 4, durability: 4 },
    isFeatured: true,
    isPublished: true,
    sortOrder: 20,
  },
  {
    title: '海軍御用達',
    category: 'premium',
    catchCopy: '規律が生む、究極の男前。',
    description:
      '鍛え上げられた男が纏う、清潔感と威圧感の極致。海軍が認めた硬派なショートスタイルは、無駄を一切省いた男の美学そのもの。見るだけで姿勢が正したくなる。',
    price: 5000,
    durationMinutes: 40,
    imageUrl: '/assets/styles/kaigun.png',
    tags: ['ショート', '威圧', '清潔感', '硬派', '軍隊'],
    stats: { intimidation: 5, sexiness: 3, popularity: 2, difficulty: 1, durability: 5 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 21,
  },
  {
    title: 'シンサイ刈り',
    category: 'premium',
    catchCopy: '難波の本気を、頭で語れ。',
    description:
      '心斎橋の夜を支配する男たちが愛する刈り込みスタイル。サイドをバッチリ刈り上げたラインが放つ威圧感は、どんな繁華街でも群衆を割る力を持つ。銀二郎が磨き上げた、街の申し子のための一手。',
    price: 5000,
    durationMinutes: 50,
    imageUrl: '/assets/styles/shinsaigari.png',
    tags: ['刈り上げ', '威圧', '難波', '心斎橋', '清潔感'],
    stats: { intimidation: 5, sexiness: 3, popularity: 3, difficulty: 1, durability: 5 },
    isFeatured: false,
    isPublished: true,
    sortOrder: 22,
  },
]

/**
 * Populate or update the style store. Safe to call on every app start.
 *
 * Version gate (fast path):
 *   If the stored version ≠ STYLES_DATA_VERSION, wipe localStorage and
 *   re-seed from SEED_DRAFTS, then write the new version.
 *   → Fixes stale imageUrls / broken paths for all existing users automatically.
 *
 * Incremental path (version matches):
 *   1. Adds styles missing from existing data (by title).
 *   2. Removes deprecated styles.
 *   3. Migrates stale imageUrls and prices.
 *   Use this path (no version bump) for new style additions and minor tweaks.
 *
 * When to bump STYLES_DATA_VERSION:
 *   - imageUrl path corrections that affect existing records
 *   - Title renames
 *   - Structural field changes
 */
export function seedInitialStyles(): void {
  const storedVersion = getStoredValue<number>(STYLES_VERSION_KEY, 0)

  if (storedVersion !== STYLES_DATA_VERSION) {
    // Full re-seed: wipe stale data and rebuild from source of truth
    const ts = now()
    const seeded: StyleCard[] = SEED_DRAFTS.map((draft, i) => ({
      ...draft,
      id: `seed-${String(i + 1).padStart(2, '0')}`,
      createdAt: ts,
      updatedAt: ts,
    }))
    writeAll(seeded)
    setStoredValue(STYLES_VERSION_KEY, STYLES_DATA_VERSION)
    return
  }

  // ── Incremental migration (version is current) ──────────────────

  const existing = readAll()

  if (existing.length === 0) {
    const ts = now()
    const seeded: StyleCard[] = SEED_DRAFTS.map((draft, i) => ({
      ...draft,
      id: `seed-${String(i + 1).padStart(2, '0')}`,
      createdAt: ts,
      updatedAt: ts,
    }))
    writeAll(seeded)
    return
  }

  const existingTitles = new Set(existing.map((s) => s.title))
  const missing = SEED_DRAFTS.filter((d) => !existingTitles.has(d.title))

  let pool = existing
  if (missing.length > 0) {
    const ts = now()
    const maxOrder = Math.max(...existing.map((s) => s.sortOrder))
    const newStyles: StyleCard[] = missing.map((draft, i) => ({
      ...draft,
      id: `seed-add-${String(i + 1).padStart(2, '0')}`,
      sortOrder: draft.sortOrder > maxOrder ? draft.sortOrder : maxOrder + 1 + i,
      createdAt: ts,
      updatedAt: ts,
    }))
    pool = [...existing, ...newStyles]
  }

  // Remove deprecated styles
  const REMOVED_TITLES = new Set(['夜勤帰りのダンディ', 'ツイストスパイラル'])
  const hadRemoved = pool.some((s) => REMOVED_TITLES.has(s.title))
  if (hadRemoved) {
    pool = pool.filter((s) => !REMOVED_TITLES.has(s.title))
  }

  // Promote トラック野郎御用達 to featured/sortOrder-0 if not already
  const truckIdx = pool.findIndex((s) => s.title === 'トラック野郎御用達')
  let truckPromoted = false
  if (truckIdx !== -1 && (!pool[truckIdx].isFeatured || pool[truckIdx].sortOrder !== 0)) {
    pool = pool.map((s) =>
      s.title === 'トラック野郎御用達'
        ? { ...s, isFeatured: true, sortOrder: 0, updatedAt: now() }
        : s,
    )
    truckPromoted = true
  }

  // Migrate prices to current values
  const PRICE_UPDATES: Record<string, number> = {
    '夏ニグロ':             9000,
    'トラック野郎御用達':   3500,
    'カールアイパー':       8000,
    'ジャマイカンアフロ':   9000,
    '銀パラ':               15000,
    'テイテイ刈り':         8000,
    'バチバチパンチパーマ': 8000,
    '極道ボウズ':           3500,
    'スペインパーマ':       8000,
    '昭和のアイパー':       8000,
    '覚醒の色':             14500,
    'リーゼントパンチ':     8000,
  }

  let priceChanged = false
  pool = pool.map((style) => {
    const newPrice = PRICE_UPDATES[style.title]
    if (newPrice !== undefined && style.price !== newPrice) {
      priceChanged = true
      return { ...style, price: newPrice, updatedAt: now() }
    }
    return style
  })

  // Migrate outdated or empty imageUrls
  const STALE_PATHS: Record<string, string> = {
    '/assets/hero-teitei-gari.jpg':    '/assets/teitei-gari.png',
    '/assets/hero-ginpara.jpg':        '/assets/ginpara.png',
    // 4 images moved from /assets/ → /assets/styles/
    '/assets/shinsai-punch.png':       '/assets/styles/shinsai-punch.png',
    '/assets/kakusei.png':             '/assets/styles/kakusei.png',
    '/assets/ri-man-parm.png':         '/assets/styles/ri-man-parm.png',
    '/assets/showa-hair.png':          '/assets/styles/showa-hair.png',
    // existing styles updated to new photos in /assets/styles/
    '/assets/showa-aiper.png':         '/assets/styles/showa-aipar.png',
    '/assets/rejent-punch.png':        '/assets/styles/rejent-punch2.png',
  }

  let imageChanged = false
  const final = pool.map((style) => {
    // 1. Migrate stale paths
    const migrated = STALE_PATHS[style.imageUrl]
    if (migrated) {
      imageChanged = true
      return { ...style, imageUrl: migrated, updatedAt: now() }
    }
    // 2. Fill empty imageUrls from registry
    if (style.imageUrl) return style
    const resolved = resolveStyleImageUrl(style)
    if (!resolved) return style
    imageChanged = true
    return { ...style, imageUrl: resolved, updatedAt: now() }
  })

  if (missing.length > 0 || imageChanged || hadRemoved || truckPromoted || priceChanged) writeAll(final)
}
