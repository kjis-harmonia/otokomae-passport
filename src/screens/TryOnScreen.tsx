import { useState } from 'react'
import { motion } from 'framer-motion'
import { Camera, User, Check, Scissors } from 'lucide-react'
import { getStoredValue, setStoredValue, TRYON_STYLE_KEY } from '../utils/storage'

interface HairStyle {
  id: string
  name: string
  sublabel: string
  tag: string
}

const STYLES: HairStyle[] = [
  { id: 'short', name: '男前ショート', sublabel: '清潔感のある定番スタイル', tag: 'SHORT' },
  { id: 'fade', name: 'フェードスタイル', sublabel: 'きりっと締まる刈り上げ', tag: 'FADE' },
  { id: 'shichisan', name: '七三クラシック', sublabel: '大人の正統派スタイル', tag: '7:3' },
  { id: 'perm', name: 'パーマ風スタイル', sublabel: '自然な動きを出す髪型', tag: 'PERM' },
]

export function TryOnScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(
    getStoredValue<string>(TRYON_STYLE_KEY, '') || null
  )
  const [consulted, setConsulted] = useState(false)

  function handleSelect(id: string) {
    setSelectedId(id)
    setStoredValue(TRYON_STYLE_KEY, id)
    setConsulted(false)
  }

  function handleConsult() {
    if (!selectedId) return
    setConsulted(true)
  }

  const selectedStyle = STYLES.find((s) => s.id === selectedId) ?? null

  return (
    <div className="py-5 space-y-6">
      {/* Section header */}
      <div className="px-5">
        <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
          Virtual Try-On
        </p>
        <p className="text-xl font-bold tracking-wide mt-0.5" style={{ color: '#F5F0E8' }}>
          髪型バーチャル試着
        </p>
        <p className="text-sm mt-0.5" style={{ color: '#8A8A7A' }}>
          気になる髪型を、来店前にイメージ。
        </p>
      </div>

      {/* Photo upload card */}
      <div className="mx-4">
        <div
          className="rounded-xl px-4 py-5 flex flex-col items-center gap-3"
          style={{
            border: '1px solid rgba(201,162,39,0.26)',
            background:
              'radial-gradient(circle at 50% 0%, rgba(139,26,42,0.16), transparent 46%), linear-gradient(145deg, rgba(30,28,24,0.94), rgba(13,13,12,0.98) 62%, rgba(28,9,13,0.52))',
            boxShadow:
              '0 12px 32px rgba(0,0,0,0.42), inset 0 1px 0 rgba(245,240,232,0.05), inset 0 0 22px rgba(201,162,39,0.045)',
          }}
        >
          <div
            className="p-3.5 rounded-full"
            style={{
              background: 'linear-gradient(145deg, rgba(201,162,39,0.13), rgba(139,26,42,0.08))',
              border: '1px solid rgba(201,162,39,0.24)',
              boxShadow: 'inset 0 0 14px rgba(201,162,39,0.06)',
            }}
          >
            <Camera size={26} strokeWidth={1.5} style={{ color: 'rgba(201,162,39,0.72)' }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium" style={{ color: 'rgba(245,240,232,0.74)' }}>
              顔写真をアップロード
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>
              正面からの写真がおすすめです
            </p>
          </div>
          <button
            type="button"
            className="px-5 py-2 rounded-lg text-xs font-semibold tracking-wider transition-opacity active:opacity-60"
            style={{
              background: 'linear-gradient(145deg, rgba(201,162,39,0.14), rgba(139,26,42,0.08))',
              border: '1px solid rgba(201,162,39,0.34)',
              color: 'rgba(232,197,71,0.86)',
              boxShadow: 'inset 0 0 12px rgba(201,162,39,0.035)',
            }}
          >
            写真を選ぶ
          </button>
          <p className="text-[10px]" style={{ color: 'rgba(138,138,122,0.45)' }}>
            ※ この機能は近日公開予定です
          </p>
        </div>
      </div>

      {/* Style selection grid */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          髪型を選ぶ
        </p>
        <div className="grid grid-cols-2 gap-3">
          {STYLES.map((style) => {
            const isSelected = selectedId === style.id
            return (
              <motion.button
                key={style.id}
                type="button"
                onClick={() => handleSelect(style.id)}
                whileTap={{ scale: 0.97 }}
                className="rounded-xl overflow-hidden text-left"
                style={{
                  background: isSelected
                    ? 'radial-gradient(circle at 50% 0%, rgba(201,162,39,0.11), transparent 42%), linear-gradient(145deg, rgba(34,30,24,0.98), rgba(17,17,16,0.98) 58%, rgba(45,14,20,0.5))'
                    : 'linear-gradient(145deg, rgba(30,28,24,0.96), rgba(17,17,16,0.98) 58%, rgba(41,14,19,0.42))',
                  border: isSelected
                    ? '1.5px solid rgba(232,197,71,0.62)'
                    : '1px solid rgba(201,162,39,0.18)',
                  boxShadow: isSelected
                    ? '0 0 22px rgba(201,162,39,0.14), inset 0 1px 0 rgba(245,240,232,0.05)'
                    : 'inset 0 1px 0 rgba(245,240,232,0.035)',
                }}
              >
                {/* Preview area */}
                <div
                  className="w-full flex items-center justify-center relative"
                  style={{
                    height: 84,
                    background: isSelected
                      ? 'linear-gradient(180deg, rgba(201,162,39,0.1), rgba(139,26,42,0.045))'
                      : 'linear-gradient(180deg, rgba(201,162,39,0.035), rgba(255,255,255,0.012))',
                    borderBottom: isSelected
                      ? '1px solid rgba(201,162,39,0.18)'
                      : '1px solid rgba(201,162,39,0.08)',
                  }}
                >
                  <div className="flex flex-col items-center gap-1.5">
                    <User
                      size={28}
                      strokeWidth={1.3}
                      style={{
                        color: isSelected
                          ? 'rgba(232,197,71,0.78)'
                          : 'rgba(245,240,232,0.22)',
                      }}
                    />
                    <span
                      className="text-[10px] font-bold tracking-widest"
                      style={{
                        color: isSelected
                          ? 'rgba(232,197,71,0.78)'
                          : 'rgba(245,240,232,0.22)',
                      }}
                    >
                      {style.tag}
                    </span>
                  </div>
                  {isSelected && (
                    <div
                      className="absolute top-2 right-2 flex items-center justify-center rounded-full"
                      style={{
                        width: 18,
                        height: 18,
                        background: 'linear-gradient(135deg, #E8C547, #C9A227)',
                        boxShadow: '0 0 12px rgba(201,162,39,0.35)',
                      }}
                    >
                      <Check size={11} strokeWidth={2.5} style={{ color: '#0D0D0D' }} />
                    </div>
                  )}
                </div>
                {/* Label */}
                <div className="px-3 py-2.5">
                  <p
                    className="text-xs font-semibold leading-snug"
                    style={{ color: isSelected ? '#F5F0E8' : 'rgba(245,240,232,0.68)' }}
                  >
                    {style.name}
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: '#8A8A7A' }}>
                    {style.sublabel}
                  </p>
                </div>
              </motion.button>
            )
          })}
        </div>
      </div>

      {/* CTA */}
      <div className="px-4">
        {consulted && selectedStyle ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="rounded-xl px-4 py-3 flex items-center gap-3"
            style={{
              background: 'rgba(139,26,42,0.12)',
              border: '1px solid rgba(139,26,42,0.3)',
            }}
          >
            <Scissors
              size={15}
              strokeWidth={2}
              style={{ color: '#B02035', flexShrink: 0, transform: 'rotate(270deg)' }}
            />
            <div>
              <p className="text-sm font-semibold" style={{ color: '#F5F0E8' }}>
                {selectedStyle.name} を選択中
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: 'rgba(176,32,53,0.8)' }}>
                予約時にスタッフへ自動で伝わります
              </p>
            </div>
          </motion.div>
        ) : (
          <button
            type="button"
            onClick={handleConsult}
            disabled={!selectedId}
            className="w-full py-3.5 rounded-xl font-semibold tracking-widest text-sm transition-opacity active:opacity-70 disabled:cursor-not-allowed"
            style={{
              background: selectedId
                ? 'linear-gradient(135deg, #8B1A2A 0%, #B02035 100%)'
                : 'linear-gradient(135deg, rgba(74,74,74,0.24), rgba(139,26,42,0.08))',
              color: selectedId ? '#F5F0E8' : 'rgba(245,240,232,0.42)',
              border: selectedId
                ? '1px solid rgba(176,32,53,0.45)'
                : '1px solid rgba(201,162,39,0.14)',
            }}
          >
            この髪型で相談する
          </button>
        )}
      </div>

      {/* Disclaimer */}
      <div className="px-5">
        <div
          className="rounded-lg px-4 py-3 space-y-1"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <p className="text-[10px]" style={{ color: 'rgba(138,138,122,0.65)' }}>
            ※ 実際の仕上がりは髪質・骨格により異なります
          </p>
          <p className="text-[10px]" style={{ color: 'rgba(138,138,122,0.65)' }}>
            ※ 詳細はスタッフにご相談ください
          </p>
        </div>
      </div>

      <div className="h-2" />
    </div>
  )
}
