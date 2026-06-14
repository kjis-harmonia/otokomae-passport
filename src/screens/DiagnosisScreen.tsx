import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft } from 'lucide-react'
import { loadStyles } from '../utils/styleStorage'
import { getReserveUrl } from '../data/reserveLinks'
import type { StyleCard } from '../data/styleCard'
import { STYLE_CATEGORY_LABELS } from '../data/styleCard'
import type { StyleCategory, StyleStats } from '../data/styleCard'
import type { NavTab } from '../data/brand'
import { StyleDetailModal } from '../components/StyleDetailModal'
import diagnosisHero from '../assets/diagnosis/otokomae-diagnosis-hero.png'

interface Props {
  onTabChange: (tab: NavTab) => void
  onModalChange?: (open: boolean) => void
}

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const DIAG_CSS = `
@keyframes gjDiagShine {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to   { transform: translate(-50%, -50%) rotate(360deg); }
}
.gj-conic-shine {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 260%;
  height: 260%;
  background: conic-gradient(
    from 0deg at 50% 50%,
    transparent 0deg,
    transparent 154deg,
    rgba(255,248,210,0.014) 168deg,
    rgba(255,250,220,0.065) 180deg,
    rgba(201,162,74,0.020) 192deg,
    transparent 206deg,
    transparent 360deg
  );
  animation: gjDiagShine 6s linear infinite;
  pointer-events: none;
}
`

// ── Question definitions ──────────────────────────────────────────────────────

interface ChoiceWeights {
  categories?: StyleCategory[]
  statBoosts?: Partial<Record<keyof StyleStats, number>>
}

interface Choice {
  id: string
  label: string
  weights: ChoiceWeights
}

interface Question {
  id: string
  text: string
  choices: Choice[]
}

const QUESTIONS: Question[] = [
  {
    id: 'job',
    text: '仕事ではどんな環境が多い？',
    choices: [
      { id: 'suit',   label: 'スーツ・営業',  weights: { categories: ['classic', 'premium'] } },
      { id: 'site',   label: '現場仕事',       weights: { categories: ['casual'] } },
      { id: 'driver', label: 'ドライバー',     weights: { categories: ['casual', 'classic'] } },
      { id: 'free',   label: '自由業・経営者', weights: { categories: ['premium', 'modern'] } },
    ],
  },
  {
    id: 'time',
    text: '朝のセット時間は？',
    choices: [
      { id: 'onemin',   label: '1分以内',   weights: { statBoosts: { durability: 5, difficulty: -3 } } },
      { id: 'fivemin',  label: '5分程度',   weights: { statBoosts: { durability: 3, difficulty: -1 } } },
      { id: 'tenmin',   label: '10分程度',  weights: { statBoosts: { difficulty: 2, sexiness: 1 } } },
      { id: 'dontcare', label: '気にしない', weights: { statBoosts: { sexiness: 2, difficulty: 3 } } },
    ],
  },
  {
    id: 'impression',
    text: '周囲に与えたい印象は？',
    choices: [
      { id: 'clean',  label: '清潔感', weights: { statBoosts: { popularity: 4 } } },
      { id: 'gruff',  label: '渋さ',   weights: { statBoosts: { intimidation: 3, sexiness: 2 } } },
      { id: 'strong', label: '強さ',   weights: { statBoosts: { intimidation: 5 } } },
      { id: 'mote',   label: 'モテ感', weights: { statBoosts: { sexiness: 4, popularity: 2 } } },
    ],
  },
  {
    id: 'freedom',
    text: '髪型の自由度は？',
    choices: [
      { id: 'strict',  label: 'かなり厳しい', weights: { categories: ['classic'], statBoosts: { durability: 3, difficulty: -3 } } },
      { id: 'limited', label: '少し制限あり', weights: { categories: ['classic', 'casual'], statBoosts: { difficulty: -1 } } },
      { id: 'mostly',  label: 'ほぼ自由',     weights: { categories: ['modern', 'seasonal'] } },
      { id: 'full',    label: '完全自由',      weights: { categories: ['premium', 'seasonal'], statBoosts: { sexiness: 2 } } },
    ],
  },
  {
    id: 'challenge',
    text: 'どこまで攻められる？',
    choices: [
      { id: 'safe',   label: '無難にしたい',   weights: { categories: ['classic'], statBoosts: { durability: 4 } } },
      { id: 'slight', label: '少し変えたい',   weights: { categories: ['modern', 'casual'] } },
      { id: 'unique', label: '個性を出したい', weights: { categories: ['premium', 'seasonal'], statBoosts: { sexiness: 3 } } },
      { id: 'trust',  label: '銀二郎に任せる', weights: { categories: ['premium', 'modern', 'classic', 'casual', 'seasonal'] } },
    ],
  },
]

// ── Characteristics ───────────────────────────────────────────────────────────

function getCharacteristics(style: StyleCard, chosen: Choice[]): string[] {
  const chars: string[] = []

  const jobId     = chosen[0]?.id
  const timeId    = chosen[1]?.id
  const freedomId = chosen[3]?.id

  if (jobId === 'site')        chars.push('現場職との相性◎')
  else if (jobId === 'driver') chars.push('帽子との相性◎')
  else if (jobId === 'suit')   chars.push('スーツスタイルに映える')
  else if (jobId === 'free')   chars.push('個性的な仕事に合う')

  if (timeId === 'onemin' || timeId === 'fivemin') chars.push('朝のセットが簡単')
  else chars.push('こだわりの仕上がり')

  if (freedomId === 'strict') chars.push('職場規定にも対応')

  if      (style.stats.durability   >= 7) chars.push('一日中崩れない')
  else if (style.stats.popularity   >= 7) chars.push('モテ系スタイル')
  else if (style.stats.sexiness     >= 7) chars.push('色気のある仕上がり')
  else if (style.stats.intimidation >= 7) chars.push('存在感・威圧感◎')

  chars.push('銀二郎人気スタイル')

  return chars.slice(0, 4)
}

// ── Scoring ───────────────────────────────────────────────────────────────────

interface MatchResult {
  style: StyleCard
  score: number
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
  return scored.slice(0, 3)
}

// ── Main screen ───────────────────────────────────────────────────────────────

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

  useEffect(() => {
    if (phase !== 'loading') return
    const t = setTimeout(() => setPhase('result'), 820)
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

  function handleShareLine() {
    const top = results[0]
    if (!top) return
    const text = `俺に似合う髪型は「${top.style.title}」だった！\nあなたに似合う髪型はこれだ。\n#男前パスポート #銀二郎`
    window.open(`https://line.me/R/msg/text/?${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
  }

  function handleShareX() {
    const top = results[0]
    if (!top) return
    const text = `俺に似合う髪型は「${top.style.title}」だった！\nあなたに似合う髪型はこれだ。\n#男前パスポート #銀二郎`
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
  }

  const topResult      = results[0]
  const topReserveUrl  = topResult ? getReserveUrl(topResult.style.title) : ''
  const characteristics = topResult ? getCharacteristics(topResult.style, chosen) : []

  const progressPct =
    phase === 'question'
      ? (currentQ / QUESTIONS.length) * 100
      : phase === 'loading' || phase === 'result'
        ? 100
        : 0

  return (
    <div className="ginjiro-luxury-bg ginjiro-luxury-bg--diagnosis flex flex-col" style={{ minHeight: '100%', color: '#F2E6C8' }}>
      <style>{DIAG_CSS}</style>
      <div className="relative z-10 flex flex-col flex-1">

      {/* Progress bar */}
      {phase !== 'intro' && (
        <div className="flex-shrink-0 h-0.5 w-full" style={{ background: 'rgba(201,162,74,0.10)' }}>
          <motion.div
            className="h-full"
            style={{ background: 'linear-gradient(90deg, #6B0F12, #C9A24A)' }}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
        </div>
      )}

      <AnimatePresence mode="wait">

        {/* ── Intro ──────────────────────────────────────────────────────────── */}
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
            <motion.div
              onClick={styles.length > 0 ? handleStart : undefined}
              whileTap={styles.length > 0 ? { scale: 0.976, opacity: 0.88 } : {}}
              transition={{ duration: 0.12 }}
              style={{
                position: 'relative',
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
              {/* Conic shine overlay */}
              <div aria-hidden className="gj-conic-shine" />
            </motion.div>

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

        {/* ── Question ───────────────────────────────────────────────────────── */}
        {phase === 'question' && (
          <motion.div
            key={`q-${currentQ}`}
            className="flex-1 flex flex-col px-5 pt-5 pb-6"
            initial={{ opacity: 0, x: slideDir * 48 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: slideDir * -48 }}
            transition={{ duration: 0.26, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="mb-6">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <p style={{
                  fontFamily: SERIF,
                  fontSize: 13,
                  fontWeight: 700,
                  color: '#C9A24A',
                  letterSpacing: '0.12em',
                }}>
                  漢前診断
                </p>
                <p style={{
                  fontSize: 11,
                  color: 'rgba(201,162,74,0.50)',
                  letterSpacing: '0.10em',
                }}>
                  {QUESTIONS.length - currentQ - 1 > 0
                    ? `残り${QUESTIONS.length - currentQ - 1}問`
                    : '最後の質問'}
                </p>
              </div>
              <h2 style={{
                fontFamily: SERIF,
                fontSize: 21,
                fontWeight: 700,
                color: '#F2E6C8',
                lineHeight: 1.45,
              }}>
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
                  className="w-full text-left rounded-xl px-4 py-4"
                  style={{
                    position: 'relative',
                    overflow: 'hidden',
                    background: 'linear-gradient(145deg, #110A08, #080504)',
                    border: '1px solid rgba(201,162,74,0.17)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.22)',
                    WebkitTapHighlightColor: 'transparent',
                    cursor: 'pointer',
                  }}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.07, duration: 0.28 }}
                  whileTap={{
                    scale: 1.018,
                    boxShadow: '0 0 0 1.5px rgba(201,162,74,0.80), 0 0 22px rgba(201,162,74,0.42), 0 0 44px rgba(107,15,18,0.52)',
                  }}
                >
                  {/* Conic shine on tap */}
                  <div aria-hidden className="gj-conic-shine" />
                  <div className="flex items-center gap-3" style={{ position: 'relative', zIndex: 1 }}>
                    <div
                      style={{
                        width: 3,
                        alignSelf: 'stretch',
                        background: 'linear-gradient(180deg, #6B0F12, rgba(201,162,74,0.48))',
                        borderRadius: 2,
                        flexShrink: 0,
                      }}
                    />
                    <p style={{
                      fontFamily: SERIF,
                      fontSize: 16,
                      fontWeight: 700,
                      color: '#F2E6C8',
                    }}>
                      {choice.label}
                    </p>
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

        {/* ── Loading ────────────────────────────────────────────────────────── */}
        {phase === 'loading' && (
          <motion.div
            key="loading"
            className="flex-1 flex flex-col items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.38 }}
          >
            {/* Rotating gold ring */}
            <div style={{ position: 'relative', width: 82, height: 82, marginBottom: 34 }}>
              {/* Crimson ambient glow behind ring */}
              <div style={{
                position: 'absolute',
                top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 130, height: 130,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(107,15,18,0.42) 0%, transparent 68%)',
                pointerEvents: 'none',
              }} />

              {/* Rotating conic-gradient ring */}
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 5.5, repeat: Infinity, ease: 'linear' }}
                style={{
                  position: 'absolute', inset: 0,
                  borderRadius: '50%',
                  background: [
                    'conic-gradient(',
                    '  from 0deg,',
                    '  rgba(201,162,74,0.06) 0%,',
                    '  rgba(201,162,74,0.55) 35%,',
                    '  rgba(255,248,210,0.88) 50%,',
                    '  rgba(201,162,74,0.55) 65%,',
                    '  rgba(201,162,74,0.06) 100%',
                    ')',
                  ].join(''),
                }}
              />

              {/* Inner mask — creates the ring shape */}
              <div style={{
                position: 'absolute',
                top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 64, height: 64,
                borderRadius: '50%',
                background: '#0A0504',
                boxShadow: 'inset 0 0 18px rgba(107,15,18,0.38)',
              }} />
            </div>

            {/* Main text */}
            <p style={{
              fontFamily: SERIF,
              fontSize: 20,
              fontWeight: 700,
              color: '#C9A24A',
              letterSpacing: '0.26em',
              marginBottom: 12,
            }}>
              髪型、選定中。
            </p>

            {/* Sub text */}
            <p style={{
              fontSize: 12,
              color: 'rgba(242,230,200,0.36)',
              letterSpacing: '0.10em',
              lineHeight: 1.75,
              textAlign: 'center',
            }}>
              あなたに似合うスタイルを<br />絞り込んでいます。
            </p>
          </motion.div>
        )}

        {/* ── Result ─────────────────────────────────────────────────────────── */}
        {phase === 'result' && topResult && (
          <motion.div
            key="result"
            className="flex-1 px-4 pt-5 pb-10"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42 }}
          >
            {/* Header */}
            <div style={{ textAlign: 'center', marginBottom: 22 }}>
              <p style={{
                fontSize: 9,
                letterSpacing: '0.30em',
                color: 'rgba(201,162,74,0.48)',
                marginBottom: 6,
                fontFamily: 'monospace',
              }}>
                DIAGNOSIS COMPLETE
              </p>
              <h2 style={{
                fontFamily: SERIF,
                fontSize: 22,
                fontWeight: 700,
                color: '#F2E6C8',
              }}>
                あなたに似合う漢は
              </h2>
            </div>

            {/* Style poster card */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.10, duration: 0.46 }}
              onClick={() => setSelectedStyle(topResult.style)}
              style={{
                position: 'relative',
                borderRadius: 24,
                overflow: 'hidden',
                border: '1px solid rgba(201,162,74,0.44)',
                boxShadow: [
                  '0 0 0 1px rgba(201,162,74,0.07)',
                  '0 16px 56px rgba(0,0,0,0.82)',
                  '0 0 72px rgba(110,5,28,0.28)',
                  'inset 0 1px 0 rgba(201,162,74,0.18)',
                ].join(', '),
                marginBottom: 18,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {/* Image area */}
              <div style={{ aspectRatio: '3/4', position: 'relative', background: '#1A0E0C' }}>
                {topResult.style.imageUrl ? (
                  <img
                    src={topResult.style.imageUrl}
                    alt={topResult.style.title}
                    style={{
                      width: '100%', height: '100%',
                      objectFit: 'cover', objectPosition: 'center top',
                      display: 'block',
                    }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 48, opacity: 0.12 }}>✂</span>
                  </div>
                )}

                {/* Gradient overlay */}
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(180deg, rgba(5,3,2,0.04) 0%, transparent 28%, transparent 44%, rgba(5,3,2,0.70) 70%, rgba(5,3,2,0.97) 100%)',
                  zIndex: 1,
                }} />

                {/* Conic shine */}
                <div aria-hidden className="gj-conic-shine" style={{ zIndex: 2 }} />

                {/* Bottom text overlay */}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  padding: '20px 20px 20px',
                  zIndex: 3,
                }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '3px 10px',
                    borderRadius: 4,
                    background: 'rgba(107,15,18,0.72)',
                    border: '1px solid rgba(180,50,50,0.36)',
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: '0.16em',
                    color: '#F2E6C8',
                    marginBottom: 8,
                  }}>
                    {STYLE_CATEGORY_LABELS[topResult.style.category]}
                  </span>
                  <p style={{
                    fontFamily: SERIF,
                    fontSize: 24,
                    fontWeight: 700,
                    color: '#F2E6C8',
                    lineHeight: 1.25,
                    textShadow: '0 2px 18px rgba(0,0,0,0.88)',
                  }}>
                    {topResult.style.title}
                  </p>
                  {topResult.style.catchCopy && (
                    <p style={{
                      fontSize: 12,
                      color: 'rgba(201,162,74,0.72)',
                      marginTop: 5,
                      lineHeight: 1.6,
                    }}>
                      {topResult.style.catchCopy}
                    </p>
                  )}
                </div>
              </div>
            </motion.div>

            {/* Characteristics */}
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.22, duration: 0.40 }}
              style={{
                borderRadius: 18,
                background: 'linear-gradient(145deg, #110A08, #080504)',
                border: '1px solid rgba(201,162,74,0.18)',
                padding: '18px 20px',
                marginBottom: 20,
              }}
            >
              <p style={{
                fontSize: 10,
                letterSpacing: '0.26em',
                color: 'rgba(201,162,74,0.52)',
                marginBottom: 14,
                fontFamily: 'monospace',
              }}>
                この漢の特徴
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {characteristics.map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ color: '#C9A24A', fontSize: 15, flexShrink: 0, lineHeight: 1 }}>✓</span>
                    <span style={{ fontFamily: SERIF, fontSize: 15, color: '#F2E6C8', lineHeight: 1.3 }}>{c}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* CTA — この髪型で予約する */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.32, duration: 0.36 }}
              style={{ marginBottom: 14 }}
            >
              <motion.button
                type="button"
                onClick={() => {
                  if (topReserveUrl) {
                    window.open(topReserveUrl, '_blank', 'noopener,noreferrer')
                  } else {
                    onTabChange('reserve')
                  }
                }}
                whileTap={{ scale: 0.97 }}
                style={{
                  position: 'relative',
                  overflow: 'hidden',
                  width: '100%',
                  padding: '17px 0',
                  borderRadius: 16,
                  background: 'linear-gradient(135deg, #3d0608 0%, #6B0F12 55%, #8B1A1A 100%)',
                  border: '1px solid rgba(201,162,74,0.52)',
                  boxShadow: '0 6px 28px rgba(107,15,18,0.54), inset 0 1px 0 rgba(242,230,200,0.08)',
                  color: '#F2E6C8',
                  fontFamily: SERIF,
                  fontSize: 17,
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {/* Conic shine on button */}
                <div aria-hidden className="gj-conic-shine" />
                <span style={{ position: 'relative', zIndex: 1 }}>この髪型で予約する</span>
              </motion.button>
            </motion.div>

            {/* Share */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.42, duration: 0.30 }}
              style={{ display: 'flex', gap: 10, marginBottom: 20 }}
            >
              <button
                type="button"
                onClick={handleShareLine}
                style={{
                  flex: 1, padding: '11px 0', borderRadius: 12,
                  background: 'rgba(0,195,0,0.10)',
                  border: '1px solid rgba(0,195,0,0.28)',
                  color: '#00c300',
                  fontSize: 13, fontWeight: 700, letterSpacing: '0.10em',
                  cursor: 'pointer',
                }}
              >
                LINE で共有
              </button>
              <button
                type="button"
                onClick={handleShareX}
                style={{
                  flex: 1, padding: '11px 0', borderRadius: 12,
                  background: 'rgba(0,0,0,0.60)',
                  border: '1px solid rgba(255,255,255,0.13)',
                  color: '#F2E6C8',
                  fontSize: 13, fontWeight: 700, letterSpacing: '0.10em',
                  cursor: 'pointer',
                }}
              >
                𝕏 で共有
              </button>
            </motion.div>

            {/* Retry */}
            <button
              type="button"
              onClick={handleRetry}
              style={{
                width: '100%', padding: '12px 0', borderRadius: 12,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(201,162,74,0.14)',
                color: 'rgba(242,230,200,0.38)',
                fontSize: 13, letterSpacing: '0.14em',
                fontFamily: SERIF,
                cursor: 'pointer',
              }}
            >
              もう一度診断する
            </button>
          </motion.div>
        )}

        {/* ── Result (no styles registered) ──────────────────────────────────── */}
        {phase === 'result' && !topResult && (
          <motion.div
            key="result-empty"
            className="flex-1 flex flex-col items-center justify-center px-6 gap-5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <p style={{ fontSize: 14, color: 'rgba(242,230,200,0.40)', textAlign: 'center' }}>
              マッチするスタイルが見つかりませんでした
            </p>
            <button
              type="button"
              onClick={handleRetry}
              style={{ color: 'rgba(201,162,74,0.52)', fontSize: 13, cursor: 'pointer' }}
            >
              もう一度診断する
            </button>
          </motion.div>
        )}

      </AnimatePresence>

      {/* Style detail modal */}
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
      </div>
    </div>
  )
}
