import { useState } from 'react'
import {
  Eye, EyeOff, Star, StarOff,
  Pencil, Trash2, ChevronUp, ChevronDown, Plus, ExternalLink,
} from 'lucide-react'
import type { StyleCard } from '../data/styleCard'
import { STYLE_CATEGORY_LABELS } from '../data/styleCard'
import { deleteStyle, moveStyle, updateStyle } from '../utils/styleStorage'

interface Props {
  styles: StyleCard[]
  onChange: () => void
  onEdit: (id: string) => void
  onAddNew: () => void
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-[9px] font-bold tracking-[0.14em] uppercase"
      style={{ background: color, color: '#F2E6C8' }}
    >
      {label}
    </span>
  )
}

interface RowProps {
  style: StyleCard
  isFirst: boolean
  isLast: boolean
  onChange: () => void
  onEdit: () => void
  onDeleteRequest: (id: string) => void
}

function StyleRow({ style, isFirst, isLast, onChange, onEdit, onDeleteRequest }: RowProps) {
  function toggle(field: 'isPublished' | 'isFeatured') {
    updateStyle(style.id, { [field]: !style[field] })
    onChange()
  }

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'linear-gradient(145deg, #110A08 0%, #080504 100%)',
        border: '1px solid rgba(201,169,97,0.16)',
      }}
    >
      <div className="flex items-start gap-3 px-3 pt-3 pb-2">
        {/* Thumbnail */}
        {style.imageUrl ? (
          <img
            src={style.imageUrl}
            alt=""
            className="rounded-lg object-cover flex-shrink-0"
            style={{ width: 52, height: 52 }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div
            className="rounded-lg flex-shrink-0 flex items-center justify-center"
            style={{
              width: 52, height: 52,
              background: '#1A0E0C',
              border: '1px solid rgba(201,169,97,0.14)',
              fontSize: 22,
            }}
          >
            ✂
          </div>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            {style.isPublished
              ? <Badge label="公開" color="rgba(40,120,60,0.72)" />
              : <Badge label="非公開" color="rgba(120,30,30,0.72)" />
            }
            {style.isFeatured && <Badge label="おすすめ" color="rgba(140,100,20,0.72)" />}
            <Badge
              label={STYLE_CATEGORY_LABELS[style.category]}
              color="rgba(60,50,80,0.72)"
            />
          </div>
          <p className="text-sm font-bold leading-tight" style={{ color: '#F2E6C8' }}>
            {style.title}
          </p>
          <p className="text-[11px] mt-0.5 truncate" style={{ color: 'rgba(201,169,97,0.52)' }}>
            ¥{style.price.toLocaleString()}
            {style.durationMinutes > 0 && ` · ${style.durationMinutes}分`}
          </p>
        </div>

        {/* Order buttons */}
        <div className="flex flex-col gap-0.5 flex-shrink-0">
          <button
            type="button"
            disabled={isFirst}
            onClick={() => { moveStyle(style.id, 'up'); onChange() }}
            className="rounded p-1 disabled:opacity-25 transition-opacity active:opacity-60"
            style={{ background: 'rgba(201,169,97,0.08)' }}
            aria-label="上へ"
          >
            <ChevronUp size={14} style={{ color: 'rgba(201,169,97,0.7)' }} />
          </button>
          <button
            type="button"
            disabled={isLast}
            onClick={() => { moveStyle(style.id, 'down'); onChange() }}
            className="rounded p-1 disabled:opacity-25 transition-opacity active:opacity-60"
            style={{ background: 'rgba(201,169,97,0.08)' }}
            aria-label="下へ"
          >
            <ChevronDown size={14} style={{ color: 'rgba(201,169,97,0.7)' }} />
          </button>
        </div>
      </div>

      {/* Edit button — full width, prominent */}
      <button
        type="button"
        onClick={onEdit}
        className="w-full flex items-center justify-center gap-2 transition-opacity active:opacity-60 border-t"
        style={{
          borderColor: 'rgba(201,169,97,0.12)',
          minHeight: 48,
          color: '#E8C77A',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.06em',
          background: 'rgba(201,169,97,0.04)',
          touchAction: 'manipulation',
        }}
      >
        <Pencil size={14} />
        このスタイルを編集する
      </button>

      {/* Quick actions */}
      <div
        className="flex items-center border-t"
        style={{ borderColor: 'rgba(201,169,97,0.1)' }}
      >
        {/* Toggle publish */}
        <button
          type="button"
          onClick={() => toggle('isPublished')}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 transition-opacity active:opacity-60"
          title={style.isPublished ? '非公開にする' : '公開する'}
        >
          {style.isPublished
            ? <EyeOff size={14} style={{ color: 'rgba(180,60,60,0.8)' }} />
            : <Eye size={14} style={{ color: 'rgba(80,160,100,0.8)' }} />
          }
          <span className="text-[11px]" style={{ color: 'rgba(242,230,200,0.52)' }}>
            {style.isPublished ? '非公開' : '公開'}
          </span>
        </button>

        <div style={{ width: 1, height: 20, background: 'rgba(201,169,97,0.1)' }} />

        {/* Toggle featured */}
        <button
          type="button"
          onClick={() => toggle('isFeatured')}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 transition-opacity active:opacity-60"
          title={style.isFeatured ? 'おすすめ解除' : 'おすすめに設定'}
        >
          {style.isFeatured
            ? <StarOff size={14} style={{ color: 'rgba(201,169,97,0.7)' }} />
            : <Star size={14} style={{ color: 'rgba(201,169,97,0.7)' }} />
          }
          <span className="text-[11px]" style={{ color: 'rgba(242,230,200,0.52)' }}>
            {style.isFeatured ? '解除' : 'おすすめ'}
          </span>
        </button>

        <div style={{ width: 1, height: 20, background: 'rgba(201,169,97,0.1)' }} />

        {/* Delete */}
        <button
          type="button"
          onClick={() => onDeleteRequest(style.id)}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 transition-opacity active:opacity-60"
        >
          <Trash2 size={14} style={{ color: 'rgba(180,50,50,0.8)' }} />
          <span className="text-[11px]" style={{ color: 'rgba(180,50,50,0.7)' }}>削除</span>
        </button>
      </div>
    </div>
  )
}

export function CMSStyleList({ styles, onChange, onEdit, onAddNew }: Props) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  function handleDeleteConfirm() {
    if (!deleteTarget) return
    deleteStyle(deleteTarget)
    setDeleteTarget(null)
    onChange()
  }

  return (
    <div className="space-y-4 pb-8">
      {/* Header */}
      <div className="px-5 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] tracking-[0.22em] uppercase" style={{ color: 'rgba(201,169,97,0.6)' }}>
              Style Management
            </p>
            <h2 className="text-xl font-bold tracking-wide" style={{ color: '#F2E6C8' }}>
              スタイル管理
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.open(window.location.pathname + '?tab=styles', '_blank')}
              className="flex items-center gap-1 rounded-lg px-2.5 py-2 text-[11px] font-medium transition-opacity active:opacity-70"
              style={{
                color: 'rgba(180,210,255,0.8)',
                background: 'rgba(60,90,140,0.15)',
                border: '1px solid rgba(100,140,200,0.28)',
              }}
              title="アプリの図鑑タブで確認"
            >
              <ExternalLink size={12} />
              確認
            </button>
            <button
              type="button"
              onClick={onAddNew}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold transition-opacity active:opacity-70"
              style={{
                color: '#F2E6C8',
                background: 'linear-gradient(135deg, #1C0A0B, #5A0D12)',
                border: '1px solid rgba(232,199,122,0.44)',
              }}
            >
              <Plus size={14} />
              追加
            </button>
          </div>
        </div>
      </div>

      {/* Count */}
      <div className="px-5">
        <p className="text-[11px]" style={{ color: 'rgba(201,169,97,0.44)' }}>
          {styles.length} 件
          {' · '}
          <span style={{ color: 'rgba(80,160,100,0.7)' }}>公開 {styles.filter(s => s.isPublished).length}</span>
          {' · '}
          <span style={{ color: 'rgba(180,60,60,0.7)' }}>非公開 {styles.filter(s => !s.isPublished).length}</span>
        </p>
      </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-8"
          style={{ background: 'rgba(0,0,0,0.72)' }}
        >
          <div
            className="w-full max-w-[420px] rounded-2xl px-5 py-5 space-y-4"
            style={{
              background: 'linear-gradient(145deg, #180C0A, #0A0504)',
              border: '1px solid rgba(180,50,50,0.5)',
              boxShadow: '0 0 40px rgba(120,20,20,0.28), 0 20px 48px rgba(0,0,0,0.56)',
            }}
          >
            <div>
              <p className="text-[10px] tracking-[0.22em] uppercase mb-1" style={{ color: 'rgba(180,60,60,0.7)' }}>
                削除の確認
              </p>
              <p className="text-sm" style={{ color: '#F2E6C8' }}>
                このスタイルを削除しますか？<br />
                <span style={{ color: 'rgba(242,230,200,0.5)' }}>この操作は取り消せません。</span>
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="flex-1 rounded-xl py-3 text-sm font-medium transition-opacity active:opacity-70"
                style={{
                  color: 'rgba(242,230,200,0.6)',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(201,169,97,0.18)',
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                className="flex-1 rounded-xl py-3 text-sm font-bold transition-opacity active:opacity-70"
                style={{
                  color: '#F2E6C8',
                  background: 'linear-gradient(135deg, #4A0D0D, #8B1A1A)',
                  border: '1px solid rgba(180,50,50,0.5)',
                }}
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {styles.length === 0 ? (
        <div className="px-4">
          <div
            className="rounded-xl px-4 py-10 text-center"
            style={{ background: '#0D0806', border: '1px solid rgba(201,169,97,0.1)' }}
          >
            <p className="text-3xl mb-3">✂</p>
            <p className="text-sm" style={{ color: 'rgba(242,230,200,0.4)' }}>
              スタイルが登録されていません
            </p>
            <button
              type="button"
              onClick={onAddNew}
              className="mt-4 rounded-xl px-5 py-2.5 text-sm font-bold transition-opacity active:opacity-70"
              style={{
                color: '#F2E6C8',
                background: 'linear-gradient(135deg, #1C0A0B, #5A0D12)',
                border: '1px solid rgba(232,199,122,0.4)',
              }}
            >
              最初のスタイルを追加
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 space-y-3">
          {styles.map((s, i) => (
            <StyleRow
              key={s.id}
              style={s}
              isFirst={i === 0}
              isLast={i === styles.length - 1}
              onChange={onChange}
              onEdit={() => onEdit(s.id)}
              onDeleteRequest={(id) => setDeleteTarget(id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
