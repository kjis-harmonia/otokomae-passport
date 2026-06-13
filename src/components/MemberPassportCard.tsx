import { motion } from 'framer-motion'
import { QrCode, Crown, Star } from 'lucide-react'
import type { Member, MemberRank } from '../data/brand'
import { BRAND } from '../data/brand'
import { formatDate, formatPoints } from '../utils/date'

function RankIcon({ rank }: { rank: MemberRank }) {
  if (rank === 'ゴールド' || rank === 'プラチナ') {
    return <Crown size={12} strokeWidth={2} style={{ color: '#C9A227' }} />
  }
  return <Star size={12} strokeWidth={2} style={{ color: '#C9A227' }} />
}

interface Props {
  member: Member
  onQrTap?: () => void
}

export function MemberPassportCard({ member, onQrTap }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="relative mx-4 rounded-2xl overflow-hidden"
      style={{
        background:
          'radial-gradient(circle at 18% 18%, rgba(139,26,42,0.34), transparent 34%), linear-gradient(135deg, #201713 0%, #0A0A09 48%, #17080C 100%)',
        border: '1px solid rgba(232,197,71,0.48)',
        boxShadow:
          '0 18px 54px rgba(0,0,0,0.76), 0 0 32px rgba(139,26,42,0.16), inset 0 1px 0 rgba(245,240,232,0.12), inset 0 0 34px rgba(201,162,39,0.12)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(120deg, transparent 0%, rgba(245,240,232,0.08) 35%, rgba(232,197,71,0.08) 44%, transparent 58%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-3 rounded-xl"
        style={{ border: '1px solid rgba(201,162,39,0.18)' }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(232,197,71,0.8), transparent)',
        }}
      />
      {['top-3 left-3', 'top-3 right-3', 'bottom-3 left-3', 'bottom-3 right-3'].map((pos) => (
        <div
          key={pos}
          className={`pointer-events-none absolute ${pos} h-3 w-3`}
          style={{
            borderStyle: 'solid',
            borderColor: 'rgba(232,197,71,0.42)',
            borderTopWidth: pos.includes('top') ? 1 : 0,
            borderBottomWidth: pos.includes('bottom') ? 1 : 0,
            borderLeftWidth: pos.includes('left') ? 1 : 0,
            borderRightWidth: pos.includes('right') ? 1 : 0,
          }}
        />
      ))}
      {/* Header */}
      <div className="relative flex items-start justify-between px-5 pt-3.5 pb-0.5">
        <div>
          <p
            className="text-[10px] tracking-[0.26em] font-semibold"
            style={{ color: '#E8C547', textShadow: '0 0 14px rgba(201,162,39,0.26)' }}
          >
            {BRAND.nameEn}
          </p>
          <p className="mt-0.5 text-[8px] tracking-[0.24em]" style={{ color: 'rgba(245,240,232,0.34)' }}>
            GINJIRO MEMBERSHIP
          </p>
          <div
            className="inline-flex items-center gap-1.5 mt-1.5 px-2.5 py-1 rounded-full"
            style={{
              background:
                'linear-gradient(135deg, rgba(201,162,39,0.2), rgba(139,26,42,0.18))',
              border: '1px solid rgba(232,197,71,0.38)',
              boxShadow: '0 0 18px rgba(201,162,39,0.1), inset 0 0 12px rgba(201,162,39,0.08)',
            }}
          >
            <RankIcon rank={member.rank} />
            <span
              className="text-[11px] font-semibold tracking-wider"
              style={{ color: '#C9A227' }}
            >
              {member.rank}会員
            </span>
          </div>
        </div>
        {onQrTap ? (
          <button
            type="button"
            onClick={onQrTap}
            aria-label="男前証QRを表示"
            className="rounded-xl p-2.5 transition-opacity active:opacity-60"
            style={{
              background: 'linear-gradient(145deg, rgba(12,12,10,0.86), rgba(201,162,39,0.09))',
              border: '1px solid rgba(201,162,39,0.3)',
              boxShadow: 'inset 0 0 18px rgba(201,162,39,0.1), 0 8px 18px rgba(0,0,0,0.28)',
              cursor: 'pointer',
            }}
          >
            <QrCode size={44} strokeWidth={1.3} style={{ color: 'rgba(201,162,39,0.72)' }} />
          </button>
        ) : (
          <div
            className="rounded-xl p-2.5"
            style={{
              background: 'linear-gradient(145deg, rgba(12,12,10,0.86), rgba(201,162,39,0.09))',
              border: '1px solid rgba(201,162,39,0.3)',
              boxShadow: 'inset 0 0 18px rgba(201,162,39,0.1), 0 8px 18px rgba(0,0,0,0.28)',
            }}
          >
            <QrCode size={44} strokeWidth={1.3} style={{ color: 'rgba(201,162,39,0.55)' }} />
          </div>
        )}
      </div>

      {/* Name */}
      <div className="relative px-5 py-2.5">
        <p className="text-2xl font-bold tracking-wide" style={{ color: '#F5F0E8' }}>
          {member.name}
        </p>
        <p className="text-[11px] tracking-[0.22em] mt-1" style={{ color: 'rgba(245,240,232,0.35)' }}>
          {member.nameKana}
        </p>
      </div>

      {/* Divider */}
      <div
        className="relative mx-5"
        style={{
          height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(201,162,39,0.46), transparent)',
        }}
      />

      {/* Points + ID */}
      <div className="relative flex items-end justify-between px-5 py-3.5">
        <div>
          <p className="text-[9px] tracking-[0.22em] uppercase" style={{ color: 'rgba(201,162,39,0.58)' }}>
            Points
          </p>
          <p className="text-[28px] font-bold leading-none mt-1" style={{ color: '#E8C547', textShadow: '0 0 20px rgba(201,162,39,0.22)' }}>
            {formatPoints(member.points)}
            <span
              className="text-[13px] font-normal ml-1"
              style={{ color: 'rgba(201,162,39,0.6)' }}
            >
              pt
            </span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[9px] tracking-[0.2em] uppercase" style={{ color: 'rgba(245,240,232,0.25)' }}>
            Member ID
          </p>
          <p className="text-[11px] font-mono mt-1" style={{ color: 'rgba(245,240,232,0.55)' }}>
            {member.id}
          </p>
          {member.memberSince && (
            <p className="text-[9px] mt-1" style={{ color: 'rgba(201,162,39,0.42)' }}>
              入会 {formatDate(member.memberSince)}
            </p>
          )}
        </div>
      </div>

      {/* Visit progress */}
      <div className="relative px-5 pb-3.5">
        <div
          className="flex items-center justify-between text-[10px] mb-1.5"
          style={{ color: 'rgba(245,240,232,0.42)' }}
        >
          <span>来店回数</span>
          <span>{member.visitCount}回</span>
        </div>
        <div
          className="rounded-full overflow-hidden"
          style={{ height: '2px', background: 'rgba(255,255,255,0.06)' }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, (member.visitCount / 24) * 100)}%`,
              background: 'linear-gradient(90deg, rgba(201,162,39,0.55), rgba(232,197,71,0.85))',
            }}
          />
        </div>
      </div>
    </motion.div>
  )
}
