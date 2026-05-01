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
}

export function MemberPassportCard({ member }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="relative mx-4 rounded-2xl overflow-hidden"
      style={{
        background:
          'linear-gradient(135deg, #1C1C1A 0%, #0E0E0C 58%, #160D05 100%)',
        border: '1px solid rgba(201,162,39,0.42)',
        boxShadow:
          '0 14px 44px rgba(0,0,0,0.72), inset 0 1px 0 rgba(245,240,232,0.08), inset 0 0 28px rgba(201,162,39,0.08)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(120deg, transparent 0%, rgba(201,162,39,0.08) 38%, transparent 62%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(232,197,71,0.8), transparent)',
        }}
      />
      {/* Header */}
      <div className="relative flex items-start justify-between px-5 pt-4 pb-1">
        <div>
          <p
            className="text-[9px] tracking-[0.22em] font-medium"
            style={{ color: 'rgba(201,162,39,0.72)' }}
          >
            {BRAND.nameEn}
          </p>
          <div
            className="inline-flex items-center gap-1.5 mt-2 px-2 py-1 rounded-full"
            style={{
              background: 'rgba(201,162,39,0.1)',
              border: '1px solid rgba(201,162,39,0.26)',
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
        <div
          className="rounded-xl p-2.5"
          style={{
            background: 'rgba(201,162,39,0.09)',
            border: '1px solid rgba(201,162,39,0.24)',
            boxShadow: 'inset 0 0 18px rgba(201,162,39,0.08)',
          }}
        >
          <QrCode size={44} strokeWidth={1.3} style={{ color: 'rgba(201,162,39,0.55)' }} />
        </div>
      </div>

      {/* Name */}
      <div className="relative px-5 py-3">
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
      <div className="relative flex items-end justify-between px-5 py-4">
        <div>
          <p className="text-[9px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
            Points
          </p>
          <p className="text-[28px] font-bold leading-none mt-1" style={{ color: '#C9A227' }}>
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
      <div className="relative px-5 pb-4">
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
