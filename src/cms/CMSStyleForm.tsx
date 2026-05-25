import { useState, useEffect, useCallback } from 'react'
import { X, Check, AlertCircle, Image } from 'lucide-react'
import type { StyleCard, StyleCategory, StyleStats } from '../data/styleCard'
import {
  STYLE_CATEGORIES, STYLE_CATEGORY_LABELS,
  STATS_KEYS, STATS_LABELS, DEFAULT_STATS,
} from '../data/styleCard'
import { createStyle, updateStyle, loadStyles } from '../utils/styleStorage'

interface Props {
  editingId: string | null  // null = new
  onSave: () => void
  onCancel: () => void
}

interface FormState {
  title: string
  category: StyleCategory
  catchCopy: string
  description: string
  price: string
  durationMinutes: string
  imageUrl: string
  tagsInput: string
  stats: StyleStats
  isFeatured: boolean
  isPublished: boolean
}

const EMPTY_FORM: FormState = {
  title: '',
  category: 'classic',
  catchCopy: '',
  description: '',
  price: '',
  durationMinutes: '',
  imageUrl: '',
  tagsInput: '',
  stats: { ...DEFAULT_STATS },
  isFeatured: false,
  isPublished: true,
}

function fromStyleCard(s: StyleCard): FormState {
  return {
    title: s.title,
    category: s.category,
    catchCopy: s.catchCopy,
    description: s.description,
    price: String(s.price),
    durationMinutes: String(s.durationMinutes),
    imageUrl: s.imageUrl,
    tagsInput: s.tags.join(', '),
    stats: { ...s.stats },
    isFeatured: s.isFeatured,
    isPublished: s.isPublished,
  }
}

/* ── Sub-components ────────────────────────────────────────────── */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: 'rgba(201,169,97,0.62)' }}>
      {children}
    </p>
  )
}

function FieldInput({
  label, value, onChange, placeholder, type = 'text', error,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  error?: string
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-all"
        style={{
          background: '#0D0806',
          border: error ? '1px solid rgba(180,50,50,0.7)' : '1px solid rgba(201,169,97,0.22)',
          color: '#F2E6C8',
          caretColor: '#C9A227',
        }}
        onFocus={(e) => {
          e.target.style.borderColor = 'rgba(201,169,97,0.54)'
          e.target.style.boxShadow = '0 0 0 2px rgba(201,169,97,0.08)'
        }}
        onBlur={(e) => {
          e.target.style.borderColor = error ? 'rgba(180,50,50,0.7)' : 'rgba(201,169,97,0.22)'
          e.target.style.boxShadow = ''
        }}
      />
      {error && (
        <p className="mt-1 text-[11px] flex items-center gap-1" style={{ color: 'rgba(220,80,80,0.9)' }}>
          <AlertCircle size={11} /> {error}
        </p>
      )}
    </div>
  )
}

function FieldTextarea({
  label, value, onChange, placeholder, rows = 3,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  return (
    <div>
      <Label>{label}</Label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded-lg px-4 py-3 text-sm outline-none resize-none transition-all"
        style={{
          background: '#0D0806',
          border: '1px solid rgba(201,169,97,0.22)',
          color: '#F2E6C8',
          caretColor: '#C9A227',
        }}
        onFocus={(e) => {
          e.target.style.borderColor = 'rgba(201,169,97,0.54)'
          e.target.style.boxShadow = '0 0 0 2px rgba(201,169,97,0.08)'
        }}
        onBlur={(e) => {
          e.target.style.borderColor = 'rgba(201,169,97,0.22)'
          e.target.style.boxShadow = ''
        }}
      />
    </div>
  )
}

function ToggleSwitch({
  label, value, onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center justify-between w-full rounded-xl px-4 py-3.5 transition-opacity active:opacity-70"
      style={{
        background: '#0D0806',
        border: '1px solid rgba(201,169,97,0.18)',
      }}
    >
      <span className="text-sm" style={{ color: '#F2E6C8' }}>{label}</span>
      <div
        className="relative rounded-full transition-all"
        style={{
          width: 44,
          height: 24,
          background: value
            ? 'linear-gradient(135deg, #3A7A4A, #2A6B3A)'
            : 'rgba(255,255,255,0.08)',
          border: value ? '1px solid rgba(80,160,100,0.5)' : '1px solid rgba(255,255,255,0.12)',
        }}
      >
        <div
          className="absolute top-0.5 rounded-full transition-all"
          style={{
            width: 20,
            height: 20,
            background: value ? '#C9F0D5' : 'rgba(255,255,255,0.3)',
            left: value ? 22 : 2,
            boxShadow: value ? '0 1px 4px rgba(0,0,0,0.3)' : '0 1px 3px rgba(0,0,0,0.2)',
          }}
        />
      </div>
    </button>
  )
}

function StatSlider({
  label, value, onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <Label>{label}</Label>
        <span
          className="text-sm font-bold"
          style={{ color: value >= 4 ? '#E8C77A' : 'rgba(201,169,97,0.6)' }}
        >
          {value}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(90deg, #C9A227 ${((value - 1) / 4) * 100}%, rgba(201,169,97,0.18) ${((value - 1) / 4) * 100}%)`,
            accentColor: '#C9A227',
          }}
        />
        <div className="flex gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <div
              key={n}
              className="rounded-full"
              style={{
                width: 6,
                height: 6,
                background: n <= value ? '#C9A227' : 'rgba(201,169,97,0.18)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── Main component ─────────────────────────────────────────────── */

export function CMSStyleForm({ editingId, onSave, onCancel }: Props) {
  const isNew = editingId === null
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    if (!isNew) {
      const existing = loadStyles().find((s) => s.id === editingId)
      if (existing) setForm(fromStyleCard(existing))
    } else {
      setForm(EMPTY_FORM)
    }
    setErrors({})
    setToast(null)
  }, [editingId, isNew])

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }))
  }, [errors])

  function setStat(key: keyof StyleStats, value: number) {
    setForm((prev) => ({ ...prev, stats: { ...prev.stats, [key]: value } }))
  }

  function validate(): boolean {
    const next: typeof errors = {}
    if (!form.title.trim()) next.title = 'タイトルは必須です'
    const priceNum = Number(form.price)
    if (form.price === '' || isNaN(priceNum) || priceNum < 0) next.price = '0以上の数値を入力してください'
    const durNum = Number(form.durationMinutes)
    if (form.durationMinutes !== '' && (isNaN(durNum) || durNum < 0)) {
      next.durationMinutes = '0以上の数値を入力してください'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  function showToast(type: 'success' | 'error', message: string) {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2400)
  }

  function handleSubmit() {
    if (!validate()) return

    const tags = form.tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    const draft = {
      title: form.title.trim(),
      category: form.category,
      catchCopy: form.catchCopy.trim(),
      description: form.description.trim(),
      price: Number(form.price) || 0,
      durationMinutes: Number(form.durationMinutes) || 0,
      imageUrl: form.imageUrl.trim(),
      tags,
      stats: form.stats,
      isFeatured: form.isFeatured,
      isPublished: form.isPublished,
      sortOrder: 999,
    }

    if (isNew) {
      createStyle(draft)
      showToast('success', '新しいスタイルを追加しました')
    } else {
      updateStyle(editingId!, draft)
      showToast('success', '変更を保存しました')
    }

    setTimeout(onSave, 600)
  }

  return (
    <div className="pb-12">
      {/* Header */}
      <div
        className="sticky top-0 z-10 flex items-center justify-between px-5 py-3"
        style={{
          background: 'rgba(7,4,3,0.96)',
          borderBottom: '1px solid rgba(201,169,97,0.16)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div>
          <p className="text-[10px] tracking-[0.22em] uppercase" style={{ color: 'rgba(201,169,97,0.6)' }}>
            {isNew ? 'New Style' : 'Edit Style'}
          </p>
          <h2 className="text-lg font-bold" style={{ color: '#F2E6C8' }}>
            {isNew ? '新規スタイル追加' : 'スタイルを編集'}
          </h2>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="p-2 rounded-lg transition-opacity active:opacity-60"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(201,169,97,0.18)' }}
          aria-label="閉じる"
        >
          <X size={18} style={{ color: 'rgba(242,230,200,0.7)' }} />
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className="fixed top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg"
          style={{
            background: toast.type === 'success' ? 'rgba(30,80,45,0.96)' : 'rgba(80,20,20,0.96)',
            border: toast.type === 'success' ? '1px solid rgba(80,160,100,0.5)' : '1px solid rgba(180,50,50,0.5)',
            color: '#F2E6C8',
            minWidth: 220,
            backdropFilter: 'blur(8px)',
          }}
        >
          {toast.type === 'success'
            ? <Check size={15} style={{ color: 'rgba(80,200,120,0.9)', flexShrink: 0 }} />
            : <AlertCircle size={15} style={{ color: 'rgba(220,80,80,0.9)', flexShrink: 0 }} />
          }
          {toast.message}
        </div>
      )}

      <div className="space-y-5 px-4 pt-5">
        {/* Image preview */}
        <div>
          <Label>画像 URL</Label>
          <div className="flex flex-col gap-2">
            {form.imageUrl && !imgError && (
              <div
                className="w-full rounded-xl overflow-hidden"
                style={{ height: 160, background: '#0D0806', border: '1px solid rgba(201,169,97,0.16)' }}
              >
                <img
                  src={form.imageUrl}
                  alt="プレビュー"
                  className="w-full h-full object-cover"
                  onError={() => setImgError(true)}
                  onLoad={() => setImgError(false)}
                />
              </div>
            )}
            {form.imageUrl && imgError && (
              <div
                className="w-full rounded-xl flex items-center justify-center gap-2"
                style={{ height: 80, background: '#0D0806', border: '1px solid rgba(180,50,50,0.3)' }}
              >
                <Image size={16} style={{ color: 'rgba(180,50,50,0.6)' }} />
                <span className="text-[11px]" style={{ color: 'rgba(180,50,50,0.7)' }}>
                  画像を読み込めませんでした
                </span>
              </div>
            )}
            {!form.imageUrl && (
              <div
                className="w-full rounded-xl flex items-center justify-center gap-2"
                style={{ height: 80, background: '#0D0806', border: '1px dashed rgba(201,169,97,0.2)' }}
              >
                <Image size={16} style={{ color: 'rgba(201,169,97,0.3)' }} />
                <span className="text-[11px]" style={{ color: 'rgba(201,169,97,0.3)' }}>
                  URLを入力するとプレビューが表示されます
                </span>
              </div>
            )}
            <input
              type="url"
              value={form.imageUrl}
              onChange={(e) => { set('imageUrl', e.target.value); setImgError(false) }}
              placeholder="https://example.com/image.jpg"
              className="w-full rounded-lg px-4 py-3 text-sm outline-none"
              style={{
                background: '#0D0806',
                border: '1px solid rgba(201,169,97,0.22)',
                color: '#F2E6C8',
                caretColor: '#C9A227',
              }}
              onFocus={(e) => {
                e.target.style.borderColor = 'rgba(201,169,97,0.54)'
                e.target.style.boxShadow = '0 0 0 2px rgba(201,169,97,0.08)'
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'rgba(201,169,97,0.22)'
                e.target.style.boxShadow = ''
              }}
            />
          </div>
        </div>

        {/* Title */}
        <FieldInput
          label="タイトル *"
          value={form.title}
          onChange={(v) => set('title', v)}
          placeholder="例: 男前ショート"
          error={errors.title}
        />

        {/* Category */}
        <div>
          <Label>カテゴリ</Label>
          <div className="flex flex-wrap gap-2">
            {STYLE_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => set('category', cat)}
                className="rounded-lg px-3 py-2 text-xs font-medium transition-all active:opacity-70"
                style={{
                  background: form.category === cat
                    ? 'linear-gradient(135deg, #1C0A0B, #5A0D12)'
                    : '#0D0806',
                  border: form.category === cat
                    ? '1px solid rgba(232,199,122,0.52)'
                    : '1px solid rgba(201,169,97,0.18)',
                  color: form.category === cat ? '#F2E6C8' : 'rgba(201,169,97,0.6)',
                }}
              >
                {STYLE_CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        </div>

        {/* CatchCopy */}
        <FieldInput
          label="キャッチコピー"
          value={form.catchCopy}
          onChange={(v) => set('catchCopy', v)}
          placeholder="例: 清潔感と威圧感の完璧な融合"
        />

        {/* Description */}
        <FieldTextarea
          label="説明文"
          value={form.description}
          onChange={(v) => set('description', v)}
          placeholder="スタイルの特徴や雰囲気を説明してください"
          rows={4}
        />

        {/* Price & Duration */}
        <div className="grid grid-cols-2 gap-3">
          <FieldInput
            label="価格（円）"
            value={form.price}
            onChange={(v) => set('price', v)}
            placeholder="5500"
            type="number"
            error={errors.price}
          />
          <FieldInput
            label="所要時間（分）"
            value={form.durationMinutes}
            onChange={(v) => set('durationMinutes', v)}
            placeholder="60"
            type="number"
            error={errors.durationMinutes}
          />
        </div>

        {/* Tags */}
        <div>
          <Label>タグ（カンマ区切り）</Label>
          <input
            type="text"
            value={form.tagsInput}
            onChange={(e) => set('tagsInput', e.target.value)}
            placeholder="例: ショート, ビジネス, 刈り上げ"
            className="w-full rounded-lg px-4 py-3 text-sm outline-none"
            style={{
              background: '#0D0806',
              border: '1px solid rgba(201,169,97,0.22)',
              color: '#F2E6C8',
              caretColor: '#C9A227',
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'rgba(201,169,97,0.54)'
              e.target.style.boxShadow = '0 0 0 2px rgba(201,169,97,0.08)'
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'rgba(201,169,97,0.22)'
              e.target.style.boxShadow = ''
            }}
          />
          {form.tagsInput && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {form.tagsInput.split(',').map((t) => t.trim()).filter(Boolean).map((tag, i) => (
                <span
                  key={i}
                  className="inline-block rounded-full px-2.5 py-1 text-[10px]"
                  style={{ background: 'rgba(201,169,97,0.12)', color: 'rgba(201,169,97,0.8)', border: '1px solid rgba(201,169,97,0.2)' }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Stats */}
        <div
          className="rounded-xl px-4 py-4 space-y-4"
          style={{ background: '#0D0806', border: '1px solid rgba(201,169,97,0.16)' }}
        >
          <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,169,97,0.52)' }}>
            能力値
          </p>
          {STATS_KEYS.map((key) => (
            <StatSlider
              key={key}
              label={STATS_LABELS[key]}
              value={form.stats[key]}
              onChange={(v) => setStat(key, v)}
            />
          ))}
        </div>

        {/* Toggles */}
        <div className="space-y-2.5">
          <ToggleSwitch
            label="公開する"
            value={form.isPublished}
            onChange={(v) => set('isPublished', v)}
          />
          <ToggleSwitch
            label="おすすめに設定"
            value={form.isFeatured}
            onChange={(v) => set('isFeatured', v)}
          />
        </div>

        {/* Submit */}
        <div className="space-y-2.5 pt-2">
          <button
            type="button"
            onClick={handleSubmit}
            className="w-full rounded-xl py-4 text-sm font-bold tracking-widest transition-opacity active:opacity-75"
            style={{
              color: '#F2E6C8',
              background: 'linear-gradient(135deg, #050202 0%, #180708 48%, #5A0D12 100%)',
              border: '1px solid rgba(232,199,122,0.68)',
              boxShadow: 'inset 0 1px 0 rgba(242,230,200,0.1), 0 8px 20px rgba(0,0,0,0.32)',
            }}
          >
            {isNew ? '追加する' : '変更を保存'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="w-full rounded-xl py-3.5 text-sm transition-opacity active:opacity-70"
            style={{
              color: 'rgba(242,230,200,0.5)',
              border: '1px solid rgba(201,169,97,0.18)',
              background: 'transparent',
            }}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}
