import { useState } from 'react'

const SERIF = '"Shippori Mincho","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif'

const SIZE_MAP = {
  sm: { title: 16, sub: 6 },
  md: { title: 20, sub: 7 },
  lg: { title: 26, sub: 9 },
} as const

type PlaceholderSize = keyof typeof SIZE_MAP

interface PlaceholderProps {
  className?: string
  size?: PlaceholderSize
}

export function StyleCardPlaceholder({ className = 'w-full h-full', size = 'md' }: PlaceholderProps) {
  const sz = SIZE_MAP[size]
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: 'linear-gradient(160deg, #0D0808 0%, #160C0A 38%, #0F0606 100%)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at 50% 115%, rgba(107,15,18,0.26) 0%, transparent 62%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          pointerEvents: 'none',
        }}
      >
        <p
          style={{
            fontFamily: SERIF,
            fontSize: sz.title,
            fontWeight: 700,
            color: 'rgba(242,230,200,0.26)',
            letterSpacing: '0.14em',
            lineHeight: 1,
          }}
        >
          銀二郎
        </p>
        <p
          style={{
            fontSize: sz.sub,
            fontWeight: 600,
            letterSpacing: '0.3em',
            color: 'rgba(201,162,74,0.26)',
            textTransform: 'uppercase',
          }}
        >
          GINJIRO STYLE
        </p>
      </div>
    </div>
  )
}

interface StyleCardImageProps {
  src: string | undefined | null
  alt: string
  className?: string
  imgStyle?: React.CSSProperties
  size?: PlaceholderSize
}

export function StyleCardImage({
  src,
  alt,
  className = 'w-full h-full',
  imgStyle,
  size = 'md',
}: StyleCardImageProps) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return <StyleCardPlaceholder className={className} size={size} />
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={imgStyle}
      onError={() => setFailed(true)}
    />
  )
}
