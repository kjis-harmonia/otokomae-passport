import { LayoutDashboard, Eye, EyeOff, Star, ChevronRight, ExternalLink, Pencil } from 'lucide-react'
import type { StyleCard } from '../data/styleCard'

interface Props {
  styles: StyleCard[]
  onGoToList: () => void
  onAddNew: () => void
}

interface StatCardProps {
  label: string
  value: number
  icon: React.ReactNode
  accent: string
}

function StatCard({ label, value, icon, accent }: StatCardProps) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl px-4 py-4"
      style={{
        background: 'linear-gradient(145deg, #110A08 0%, #080504 100%)',
        border: `1px solid ${accent}`,
        boxShadow: `0 8px 24px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.04)`,
      }}
    >
      <div className="flex items-center justify-between">
        <span style={{ color: accent, opacity: 0.72 }}>{icon}</span>
        <span
          className="text-3xl font-bold leading-none"
          style={{ color: '#F2E6C8', fontVariantNumeric: 'tabular-nums' }}
        >
          {value}
        </span>
      </div>
      <p className="text-[11px] tracking-[0.18em] uppercase" style={{ color: 'rgba(201,169,97,0.54)' }}>
        {label}
      </p>
    </div>
  )
}

export function CMSDashboard({ styles, onGoToList, onAddNew }: Props) {
  const published = styles.filter((s) => s.isPublished).length
  const unpublished = styles.filter((s) => !s.isPublished).length
  const featured = styles.filter((s) => s.isFeatured).length
  const recent = [...styles]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 3)

  return (
    <div className="space-y-6 pb-8">
      {/* Hero */}
      <div className="px-5 pt-2">
        <div className="flex items-center gap-2 mb-1">
          <LayoutDashboard size={14} style={{ color: 'rgba(201,169,97,0.6)' }} />
          <p className="text-[10px] tracking-[0.22em] uppercase" style={{ color: 'rgba(201,169,97,0.6)' }}>
            Dashboard
          </p>
        </div>
        <h1 className="text-2xl font-bold tracking-wide" style={{ color: '#F2E6C8' }}>
          銀二郎 CMS
        </h1>
        <p className="text-[12px] mt-1" style={{ color: 'rgba(242,230,200,0.42)' }}>
          スタイル図鑑コンテンツを管理する
        </p>
      </div>

      {/* Stats grid */}
      <div className="px-4 grid grid-cols-2 gap-3">
        <StatCard
          label="登録スタイル"
          value={styles.length}
          icon={<LayoutDashboard size={16} />}
          accent="rgba(201,169,97,0.38)"
        />
        <StatCard
          label="公開中"
          value={published}
          icon={<Eye size={16} />}
          accent="rgba(80,160,100,0.44)"
        />
        <StatCard
          label="非公開"
          value={unpublished}
          icon={<EyeOff size={16} />}
          accent="rgba(180,60,60,0.38)"
        />
        <StatCard
          label="おすすめ"
          value={featured}
          icon={<Star size={16} />}
          accent="rgba(201,169,97,0.48)"
        />
      </div>

      {/* Quick actions */}
      <div className="px-4 space-y-3">
        <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,169,97,0.44)' }}>
          クイックアクション
        </p>
        <button
          type="button"
          onClick={onAddNew}
          className="w-full rounded-xl px-4 py-4 text-sm font-bold tracking-widest transition-opacity active:opacity-70"
          style={{
            color: '#F2E6C8',
            background: 'linear-gradient(135deg, #0A0504 0%, #1C0A0B 50%, #5A0D12 100%)',
            border: '1px solid rgba(232,199,122,0.52)',
            boxShadow: '0 0 20px rgba(121,13,18,0.22), inset 0 1px 0 rgba(242,230,200,0.08)',
          }}
        >
          ＋ 新規スタイルを追加
        </button>
        <button
          type="button"
          onClick={onGoToList}
          className="w-full rounded-xl px-5 flex items-center justify-between transition-opacity active:opacity-70"
          style={{
            background: 'linear-gradient(135deg, #0A0504 0%, #1C0A0B 50%, #3A0A10 100%)',
            border: '1px solid rgba(232,199,122,0.42)',
            minHeight: 56,
          }}
        >
          <div className="flex items-center gap-3">
            <Pencil size={18} style={{ color: 'rgba(232,199,122,0.8)', flexShrink: 0 }} />
            <div className="text-left">
              <p className="text-sm font-bold" style={{ color: '#F2E6C8' }}>スタイルを編集する</p>
              <p className="text-[11px]" style={{ color: 'rgba(201,169,97,0.54)' }}>登録済みスタイルの編集・管理</p>
            </div>
          </div>
          <ChevronRight size={18} style={{ color: 'rgba(201,169,97,0.6)' }} />
        </button>
        <button
          type="button"
          onClick={() => window.open(window.location.pathname + '?tab=styles', '_blank')}
          className="w-full rounded-xl px-4 py-4 flex items-center justify-between transition-opacity active:opacity-70"
          style={{
            background: 'linear-gradient(145deg, #0A0C10, #060810)',
            border: '1px solid rgba(100,140,200,0.28)',
          }}
        >
          <span className="text-sm font-medium" style={{ color: 'rgba(180,210,255,0.85)' }}>
            アプリで確認（図鑑）
          </span>
          <ExternalLink size={15} style={{ color: 'rgba(100,160,220,0.7)' }} />
        </button>
      </div>

      {/* Recent updates */}
      {recent.length > 0 && (
        <div className="px-4 space-y-3">
          <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,169,97,0.44)' }}>
            最近の更新
          </p>
          <div className="space-y-2">
            {recent.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-xl px-4 py-3"
                style={{
                  background: '#0D0806',
                  border: '1px solid rgba(201,169,97,0.12)',
                }}
              >
                {s.imageUrl ? (
                  <img
                    src={s.imageUrl}
                    alt=""
                    className="rounded-lg object-cover flex-shrink-0"
                    style={{ width: 40, height: 40 }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div
                    className="rounded-lg flex-shrink-0 flex items-center justify-center"
                    style={{ width: 40, height: 40, background: '#1A0E0C', border: '1px solid rgba(201,169,97,0.16)' }}
                  >
                    <span style={{ fontSize: 18 }}>✂</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: '#F2E6C8' }}>
                    {s.title}
                  </p>
                  <p className="text-[11px]" style={{ color: 'rgba(201,169,97,0.5)' }}>
                    {new Date(s.updatedAt).toLocaleDateString('ja-JP')}
                    {' · '}
                    <span style={{ color: s.isPublished ? 'rgba(80,160,100,0.8)' : 'rgba(180,60,60,0.7)' }}>
                      {s.isPublished ? '公開中' : '非公開'}
                    </span>
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {styles.length === 0 && (
        <div className="px-4">
          <div
            className="rounded-xl px-4 py-8 text-center"
            style={{ background: '#0D0806', border: '1px solid rgba(201,169,97,0.1)' }}
          >
            <p className="text-2xl mb-2">✂</p>
            <p className="text-sm" style={{ color: 'rgba(242,230,200,0.4)' }}>
              スタイルがまだ登録されていません
            </p>
            <p className="text-[11px] mt-1" style={{ color: 'rgba(201,169,97,0.4)' }}>
              「新規スタイルを追加」からはじめてください
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
