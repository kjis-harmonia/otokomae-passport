import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, Share2 } from 'lucide-react'
import diagnosisHero from '../assets/diagnosis/otokomae-diagnosis-hero.png'
import { loadStyles } from '../utils/styleStorage'
import { getReserveUrl } from '../data/reserveLinks'
import type { StyleCard } from '../data/styleCard'
import { STYLE_CATEGORY_LABELS } from '../data/styleCard'
import type { StyleCategory, StyleStats } from '../data/styleCard'
import type { NavTab } from '../data/brand'
import { StyleDetailModal } from '../components/StyleDetailModal'

interface Props {
  onTabChange: (tab: NavTab) => void
  onModalChange?: (open: boolean) => void
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

// ── Question definitions ──────────────────────────────────────────────────

interface ChoiceWeights {
  categories?: StyleCategory[]
  statBoosts?: Partial<Record<keyof StyleStats, number>>
}

interface Choice {
  id: string
  label: string
  sublabel: string
  weights: ChoiceWeights
}

interface Question {
  id: string
  text: string
  choices: Choice[]
}

const QUESTIONS: Question[] = [
  {
    id: 'lifestyle',
    text: 'あなたの日常はどちらに近いですか',
    choices: [
      {
        id: 'business',
        label: 'ビジネスの最前線',
        sublabel: 'スーツ・フォーマルが多い',
        weights: { categories: ['classic', 'premium'] },
      },
      {
        id: 'casual',
        label: '街の男前',
        sublabel: '飾らない自由な男のスタイル',
        weights: { categories: ['casual', 'modern'] },
      },
      {
        id: 'trend',
        label: 'トレンド重視',
        sublabel: '常に最新を取り入れたい',
        weights: { categories: ['modern', 'seasonal'] },
      },
      {
        id: 'unique',
        label: 'こだわりの一匹狼',
        sublabel: '自分だけのスタイルを貫く',
        weights: { categories: ['premium'] },
      },
    ],
  },
  {
    id: 'weapon',
    text: '男として、何を武器にしたいですか',
    choices: [
      {
        id: 'sexy',
        label: '色気と艶',
        sublabel: '近づきがたい色香を放つ男',
        weights: { statBoosts: { sexiness: 4 } },
      },
      {
        id: 'clean',
        label: '清潔感と誠実さ',
        sublabel: '女性が安心できる爽やかな男',
        weights: { statBoosts: { popularity: 4 } },
      },
      {
        id: 'aura',
        label: '威圧感とオーラ',
        sublabel: '周囲を支配する存在感',
        weights: { statBoosts: { intimidation: 4 } },
      },
      {
        id: 'balance',
        label: 'バランスと品格',
        sublabel: 'どこでも通じる紳士',
        weights: { statBoosts: { sexiness: 2, popularity: 2, intimidation: 2 } },
      },
    ],
  },
  {
    id: 'time',
    text: '朝のスタイリングに使える時間は',
    choices: [
      {
        id: 'quick',
        label: '5分以内',
        sublabel: '忙しい朝でも即決まるスタイル',
        weights: { statBoosts: { difficulty: -3, durability: 3 } },
      },
      {
        id: 'medium',
        label: '10〜15分',
        sublabel: '毎朝の儀式として楽しみたい',
        weights: { statBoosts: { difficulty: -1, durability: 2 } },
      },
      {
        id: 'long',
        label: '20〜30分',
        sublabel: 'こだわり抜いて出かけたい',
        weights: { statBoosts: { difficulty: 2, sexiness: 1 } },
      },
      {
        id: 'lasting',
        label: '時間より持続力',
        sublabel: '崩れないスタイルを優先したい',
        weights: { statBoosts: { durability: 4, difficulty: -2 } },
      },
    ],
  },
  {
    id: 'vibe',
    text: '理想とする男の雰囲気は',
    choices: [
      {
        id: 'classic',
        label: '昭和の漢',
        sublabel: '時代を超えた威圧感と風格',
        weights: { categories: ['classic'] },
      },
      {
        id: 'modern',
        label: 'モテ系アウトロー',
        sublabel: 'クールに計算された色気とオーラ',
        weights: { categories: ['modern'] },
      },
      {
        id: 'natural',
        label: 'ナチュラルな魅力',
        sublabel: '飾らない本物の男らしさ',
        weights: { categories: ['casual'] },
      },
      {
        id: 'original',
        label: '唯一無二の個性',
        sublabel: '誰とも違う存在感',
        weights: { categories: ['premium', 'seasonal'] },
      },
    ],
  },
  {
    id: 'goal',
    text: 'スタイルを変えて最も得たいものは',
    choices: [
      {
        id: 'durability',
        label: '持続力と安定感',
        sublabel: '崩れないスタイルで一日を制す',
        weights: { statBoosts: { durability: 5 } },
      },
      {
        id: 'mote',
        label: '異性を惹きつける磁力',
        sublabel: '女性に選ばれる男になりたい',
        weights: { statBoosts: { popularity: 4, sexiness: 2 } },
      },
      {
        id: 'trust',
        label: 'プロとしての信頼感',
        sublabel: '仕事でも輝くオーラ',
        weights: { categories: ['classic', 'premium'], statBoosts: { difficulty: -1 } },
      },
      {
        id: 'self',
        label: '自己表現と自由',
        sublabel: '自分らしさを極めたい',
        weights: { categories: ['premium', 'seasonal'], statBoosts: { sexiness: 2 } },
      },
    ],
  },
]

// ── Scoring ───────────────────────────────────────────────────────────────

interface MatchResult {
  style: StyleCard
  score: number
  matchPct: number
}

function computeMatches(styles: StyleCard[], chosen: Choice[]): MatchResult[] {
  const scored = styles.map((style) => {
    let score = 0
    for (const choice of chosen) {
      for (const cat of choice.weights.categories ?? []) {
        if (style.category === cat) score += 20
      }
      for (const [stat, mult] of Object.entries(choice.weights.statBoosts ?? {})) {
        score += style.stats[stat as keyof StyleStats] * (mult as number)
      }
    }
    return { style, score }
  })

  scored.sort((a, b) => b.score - a.score)

  const top3 = scored.slice(0, 3)
  const maxScore = Math.max(1, top3[0]?.score ?? 1)

  return top3.map(({ style, score }) => ({
    style,
    score,
    matchPct: Math.max(52, Math.round((Math.max(0, score) / maxScore) * 100)),
  }))
}

// ── Result card ───────────────────────────────────────────────────────────

const RANK_LABELS = ['1位', '2位', '3位'] as const
const RANK_COLORS = ['#C9A24A', 'rgba(201,162,74,0.6)', 'rgba(201,162,74,0.42)'] as const

function ResultCard({
  result,
  rank,
  onReserve,
  onCardTap,
}: {
  result: MatchResult
  rank: number
  onReserve: () => void
  onCardTap: () => void
}) {
  const isTop = rank === 0
  const reserveUrl = getReserveUrl(result.style.title)

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: rank * 0.16, duration: 0.46, ease: 'easeOut' }}
      className="rounded-2xl overflow-hidden cursor-pointer active:opacity-90"
      onClick={onCardTap}
      style={{
        background: 'linear-gradient(145deg, #110A08, #080504)',
        border: `1px solid ${isTop ? 'rgba(201,162,74,0.36)' : 'rgba(201,162,74,0.14)'}`,
        boxShadow: isTop ? '0 0 28px rgba(201,162,74,0.08)' : 'none',
      }}
    >
      {/* Image */}
      <div className="relative w-full overflow-hidden" style={{ height: isTop ? 200 : 128 }}>
        {result.style.imageUrl ? (
          <img
            src={result.style.imageUrl}
            alt={result.style.title}
            className="w-full h-full"
            style={{ objectFit: 'cover', objectPosition: 'center bottom' }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center" style={{ background: '#1A0E0C' }}>
            <span style={{ fontSize: 38, opacity: 0.12 }}>✂</span>
          </div>
        )}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(180deg, rgba(5,3,2,0.08) 0%, transparent 35%, rgba(5,3,2,0.88) 100%)',
          }}
        />
        {/* Rank badge */}
        <div className="absolute top-3 left-3">
          <span
            className="rounded px-2 py-1 text-[11px] font-bold tracking-[0.12em]"
            style={{
              background: isTop ? 'rgba(201,162,74,0.2)' : 'rgba(12,6,4,0.72)',
              border: `1px solid ${RANK_COLORS[rank]}`,
              color: RANK_COLORS[rank],
            }}
          >
            {RANK_LABELS[rank]}
          </span>
        </div>
        {/* Match % */}
        <div className="absolute top-3 right-3">
          <span
            className="rounded px-2 py-1 text-[11px] font-bold"
            style={{ background: 'rgba(5,3,2,0.72)', color: RANK_COLORS[rank] }}
          >
            {result.matchPct}%
          </span>
        </div>
      </div>

      {/* Info */}
      <div className="px-4 py-3">
        <span
          className="inline-block rounded px-1.5 py-0.5 text-[9px] font-bold tracking-[0.14em] uppercase mb-1.5"
          style={{
            background: 'rgba(107,15,18,0.58)',
            color: '#F2E6C8',
            border: '1px solid rgba(180,50,50,0.28)',
          }}
        >
          {STYLE_CATEGORY_LABELS[result.style.category]}
        </span>
        <p
          className="font-bold leading-snug mb-1"
          style={{ fontSize: isTop ? 17 : 14, color: '#F2E6C8', fontFamily: SERIF }}
        >
          {result.style.title}
        </p>
        {result.style.catchCopy && (
          <p className="text-[11px] mb-3 line-clamp-2" style={{ color: 'rgba(201,162,74,0.6)' }}>
            {result.style.catchCopy}
          </p>
        )}
        {/* Price */}
        <p className="text-[11px] mb-3" style={{ color: 'rgba(242,230,200,0.44)' }}>
          ¥{result.style.price.toLocaleString()}
          {result.style.durationMinutes > 0 && ` · ${result.style.durationMinutes}分`}
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (reserveUrl) {
              window.open(reserveUrl, '_blank', 'noopener,noreferrer')
            } else {
              onReserve()
            }
          }}
          className="w-full rounded-xl py-2.5 text-sm font-bold tracking-[0.18em] transition-opacity active:opacity-70"
          style={{
            background: isTop
              ? 'linear-gradient(135deg, #3d0608, #6B0F12 60%, #8B1A1A)'
              : 'rgba(107,15,18,0.38)',
            border: '1px solid rgba(201,162,74,0.36)',
            color: '#F2E6C8',
            boxShadow: isTop ? '0 4px 16px rgba(107,15,18,0.38)' : 'none',
          }}
        >
          詳しく見る
        </button>
      </div>
    </motion.div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────

type Phase = 'intro' | 'question' | 'loading' | 'result'

export function DiagnosisScreen({ onTabChange, onModalChange }: Props) {
  const [styles] = useState(() => loadStyles().filter((s) => s.isPublished))
  const [phase, setPhase] = useState<Phase>('intro')
  const [currentQ, setCurrentQ] = useState(0)
  const [chosen, setChosen] = useState<Choice[]>([])
  const [results, setResults] = useState<MatchResult[]>([])
  const [slideDir, setSlideDir] = useState<1 | -1>(1)
  const [selectedStyle, setSelectedStyle] = useState<StyleCard | null>(null)

  useEffect(() => {
    onModalChange?.(selectedStyle !== null)
  }, [selectedStyle, onModalChange])

  // Switch from loading → result after short delay
  useEffect(() => {
    if (phase !== 'loading') return
    const t = setTimeout(() => setPhase('result'), 1100)
    return () => clearTimeout(t)
  }, [phase])

  function handleStart() {
    setChosen([])
    setCurrentQ(0)
    setSlideDir(1)
    setPhase('question')
  }

  function handleChoice(choice: Choice) {
    const next = [...chosen, choice]
    setChosen(next)
    if (currentQ < QUESTIONS.length - 1) {
      setSlideDir(1)
      setCurrentQ((q) => q + 1)
    } else {
      setResults(computeMatches(styles, next))
      setPhase('loading')
    }
  }

  function handleBack() {
    setSlideDir(-1)
    setChosen((c) => c.slice(0, -1))
    setCurrentQ((q) => q - 1)
  }

  function handleRetry() {
    setResults([])
    setChosen([])
    setCurrentQ(0)
    setSlideDir(1)
    setPhase('intro')
  }

  async function handleShare() {
    const top = results[0]
    if (!top) return
    const text = `俺の男前スタイルは「${top.style.title}」だった！\n${top.style.catchCopy}\n#男前パスポート #銀二郎`
    if (navigator.share) {
      try { await navigator.share({ title: '男前診断結果', text }) } catch {}
      return
    }
    const encoded = encodeURIComponent(text)
    window.open(`https://twitter.com/intent/tweet?text=${encoded}`, '_blank', 'noopener,noreferrer')
  }

  function handleShareLine() {
    const top = results[0]
    if (!top) return
    const text = `俺の男前スタイルは「${top.style.title}」だった！\n${top.style.catchCopy}\n#男前パスポート #銀二郎`
    window.open(`https://line.me/R/msg/text/?${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
  }

  function handleShareX() {
    const top = results[0]
    if (!top) return
    const text = `俺の男前スタイルは「${top.style.title}」だった！\n${top.style.catchCopy}\n#男前パスポート #銀二郎`
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
  }

  const topReserveUrl = results.length > 0 ? getReserveUrl(results[0].style.title) : ''

  const progressPct =
    phase === 'question'
      ? (currentQ / QUESTIONS.length) * 100
      : phase === 'loading' || phase === 'result'
        ? 100
        : 0

  return (
    <div
      className="flex flex-col"
      style={{ minHeight: '100%', color: '#F2E6C8' }}
    >
      {/* Progress bar */}
      {phase !== 'intro' && (
        <div className="flex-shrink-0 h-0.5 w-full" style={{ background: 'rgba(201,162,74,0.1)' }}>
          <motion.div
            className="h-full"
            style={{ background: 'linear-gradient(90deg, #6B0F12, #C9A24A)' }}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
        </div>
      )}

      <AnimatePresence mode="wait">

        {/* ── Intro ─────────────────────────────────────────────────────── */}
        {phase === 'intro' && (
          <motion.div
            key="intro"
            className="flex-1 flex flex-col px-4"
            style={{ paddingTop: 'max(24px, env(safe-area-inset-top, 24px))', paddingBottom: 32 }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.38 }}
          >
            {/* Hero image — tap to start diagnosis */}
            <motion.div
              onClick={styles.length > 0 ? handleStart : undefined}
              whileTap={styles.length > 0 ? { scale: 0.976, opacity: 0.88 } : {}}
              transition={{ duration: 0.12 }}
              style={{
                borderRadius: 24,
                overflow: 'hidden',
                border: '1px solid rgba(201,162,74,0.44)',
                boxShadow: [
                  '0 0 0 1px rgba(201,162,74,0.07)',
                  '0 12px 52px rgba(0,0,0,0.75)',
                  '0 0 72px rgba(110,5,28,0.32)',
                  'inset 0 1px 0 rgba(201,162,74,0.18)',
                ].join(', '),
                cursor: styles.length > 0 ? 'pointer' : 'default',
                WebkitTapHighlightColor: 'transparent',
                userSelect: 'none',
                opacity: styles.length === 0 ? 0.44 : 1,
              } as React.CSSProperties}
            >
              <img
                src={diagnosisHero}
                alt="男前診断をはじめる"
                style={{ display: 'block', width: '100%', height: 'auto' }}
                draggable={false}
              />
            </motion.div>

            {/* Subtext */}
            <p style={{
              textAlign: 'center',
              fontSize: 11,
              letterSpacing: '0.18em',
              color: 'rgba(201,162,74,0.44)',
              marginTop: 16,
              fontFamily: SERIF,
            }}>
              所要時間：約1分
            </p>

            {styles.length === 0 && (
              <p style={{
                textAlign: 'center',
                fontSize: 12,
                color: 'rgba(242,230,200,0.34)',
                marginTop: 10,
                letterSpacing: '0.08em',
              }}>
                スタイルが登録されていません
              </p>
            )}
          </motion.div>
        )}

        {/* ── Question ──────────────────────────────────────────────────── */}
        {phase === 'question' && (
          <motion.div
            key={`q-${currentQ}`}
            className="flex-1 flex flex-col px-5 pt-5 pb-6"
            initial={{ opacity: 0, x: slideDir * 48 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: slideDir * -48 }}
            transition={{ duration: 0.26, ease: 'easeOut' }}
          >
            {/* Question header */}
            <div className="mb-6">
              <p
                className="text-[10px] tracking-[0.24em] uppercase mb-1.5"
                style={{ color: 'rgba(201,162,74,0.48)' }}
              >
                Question {currentQ + 1} / {QUESTIONS.length}
              </p>
              <h2
                className="text-xl font-bold leading-snug"
                style={{ color: '#F2E6C8', fontFamily: SERIF }}
              >
                {QUESTIONS[currentQ].text}
              </h2>
            </div>

            {/* Choices */}
            <div className="space-y-3">
              {QUESTIONS[currentQ].choices.map((choice, i) => (
                <motion.button
                  key={choice.id}
                  type="button"
                  onClick={() => handleChoice(choice)}
                  className="w-full text-left rounded-xl px-4 py-3.5 transition-opacity active:opacity-60"
                  style={{
                    background: 'linear-gradient(145deg, #110A08, #080504)',
                    border: '1px solid rgba(201,162,74,0.17)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.22)',
                  }}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.07, duration: 0.28 }}
                  whileTap={{ scale: 0.985 }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="flex-shrink-0 rounded-full self-stretch"
                      style={{ width: 3, background: 'linear-gradient(180deg, #6B0F12, rgba(201,162,74,0.48))' }}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-bold" style={{ color: '#F2E6C8' }}>
                        {choice.label}
                      </p>
                      <p className="text-[11px] mt-0.5" style={{ color: 'rgba(201,162,74,0.54)' }}>
                        {choice.sublabel}
                      </p>
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>

            {/* Back */}
            {currentQ > 0 && (
              <button
                type="button"
                onClick={handleBack}
                className="mt-5 flex items-center gap-1 text-[11px] transition-opacity active:opacity-60"
                style={{ color: 'rgba(201,162,74,0.42)' }}
              >
                <ChevronLeft size={13} />
                前の質問に戻る
              </button>
            )}
          </motion.div>
        )}

        {/* ── Loading ───────────────────────────────────────────────────── */}
        {phase === 'loading' && (
          <motion.div
            key="loading"
            className="flex-1 flex flex-col items-center justify-center gap-5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div style={{ fontSize: 34, opacity: 0.36 }}>✂</div>
            <p
              className="text-sm tracking-[0.18em]"
              style={{ color: 'rgba(201,162,74,0.58)', fontFamily: SERIF }}
            >
              マッチングしています
            </p>
            <div className="flex gap-2 mt-1">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: '#C9A24A' }}
                  animate={{ opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.22 }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {/* ── Result ────────────────────────────────────────────────────── */}
        {phase === 'result' && (
          <motion.div
            key="result"
            className="flex-1 px-4 pt-5 pb-36 space-y-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.36 }}
          >
            {/* Header */}
            <div className="px-1 mb-2">
              <p
                className="text-[10px] tracking-[0.24em] uppercase"
                style={{ color: 'rgba(201,162,74,0.5)' }}
              >
                Diagnosis Result
              </p>
              <div className="flex items-end justify-between">
                <div>
                  <h2 className="text-2xl font-bold" style={{ color: '#F2E6C8', fontFamily: SERIF }}>
                    診断結果
                  </h2>
                  <p className="text-[11px] mt-0.5" style={{ color: 'rgba(201,162,74,0.44)' }}>
                    あなたにおすすめのスタイルです
                  </p>
                </div>
                {/* Share buttons */}
                <div className="flex items-center gap-2 pb-0.5">
                  <button
                    type="button"
                    onClick={handleShareX}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold tracking-wide transition-opacity active:opacity-60"
                    style={{
                      background: 'rgba(0,0,0,0.72)',
                      border: '1px solid rgba(255,255,255,0.14)',
                      color: '#F2E6C8',
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 800, lineHeight: 1 }}>𝕏</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleShareLine}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold tracking-wide transition-opacity active:opacity-60"
                    style={{
                      background: 'rgba(0,195,0,0.12)',
                      border: '1px solid rgba(0,195,0,0.32)',
                      color: '#00c300',
                    }}
                  >
                    LINE
                  </button>
                  <button
                    type="button"
                    onClick={handleShare}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 transition-opacity active:opacity-60"
                    style={{
                      background: 'rgba(201,162,74,0.08)',
                      border: '1px solid rgba(201,162,74,0.24)',
                      color: 'rgba(201,162,74,0.72)',
                    }}
                  >
                    <Share2 size={14} />
                  </button>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div
              style={{
                height: 1,
                background: 'linear-gradient(90deg, transparent, rgba(201,162,74,0.22), transparent)',
              }}
            />

            {results.length === 0 ? (
              <div
                className="rounded-xl px-4 py-10 text-center"
                style={{ background: '#0D0806', border: '1px solid rgba(201,162,74,0.1)' }}
              >
                <p className="text-sm" style={{ color: 'rgba(242,230,200,0.4)' }}>
                  マッチするスタイルが見つかりませんでした
                </p>
              </div>
            ) : (
              results.map((result, i) => (
                <ResultCard
                  key={result.style.id}
                  result={result}
                  rank={i}
                  onReserve={() => onTabChange('reserve')}
                  onCardTap={() => setSelectedStyle(result.style)}
                />
              ))
            )}

            {/* Retry */}
            <button
              type="button"
              onClick={handleRetry}
              className="w-full rounded-xl py-3 text-sm transition-opacity active:opacity-70"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(201,162,74,0.18)',
                color: 'rgba(242,230,200,0.46)',
              }}
            >
              もう一度診断する
            </button>
          </motion.div>
        )}

      </AnimatePresence>

      {/* ── Style detail modal ── */}
      <AnimatePresence>
        {selectedStyle && (
          <StyleDetailModal
            key={selectedStyle.id}
            style={selectedStyle}
            onClose={() => setSelectedStyle(null)}
            onReserve={() => {
              setSelectedStyle(null)
              onTabChange('reserve')
            }}
          />
        )}
      </AnimatePresence>

      {/* ── Fixed reservation CTA — shown only on result phase ── */}
      <AnimatePresence>
        {phase === 'result' && results.length > 0 && (
          <motion.div
            key="fixed-cta"
            className="fixed left-0 right-0 z-40 px-4"
            style={{ bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))' }}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.32, ease: 'easeOut' }}
          >
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                background: 'linear-gradient(180deg, rgba(8,4,3,0.82) 0%, rgba(8,4,3,0.96) 100%)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(201,162,74,0.28)',
                boxShadow: '0 -4px 32px rgba(0,0,0,0.48), 0 0 0 1px rgba(201,162,74,0.06)',
              }}
            >
              <div className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,162,74,0.5)' }}>
                    Best Match
                  </p>
                  <p
                    className="text-sm font-bold truncate"
                    style={{ color: '#F2E6C8', fontFamily: SERIF }}
                  >
                    {results[0].style.title}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (topReserveUrl) {
                      window.open(topReserveUrl, '_blank', 'noopener,noreferrer')
                    } else {
                      onTabChange('reserve')
                    }
                  }}
                  className="flex-shrink-0 rounded-xl px-5 py-2.5 text-sm font-bold tracking-[0.16em] transition-opacity active:opacity-70"
                  style={{
                    background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 60%, #8B1A1A 100%)',
                    border: '1px solid rgba(201,162,74,0.44)',
                    color: '#F2E6C8',
                    boxShadow: '0 4px 16px rgba(107,15,18,0.48)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  今すぐ予約
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
