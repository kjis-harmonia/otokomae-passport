import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronLeft, Check, AlertCircle, Image, Camera, Link2, Trash2, ExternalLink } from 'lucide-react'
import type { StyleCard, StyleCategory, StyleStats } from '../data/styleCard'
import {
  STYLE_CATEGORIES, STYLE_CATEGORY_LABELS,
  STATS_KEYS, STATS_LABELS, DEFAULT_STATS,
} from '../data/styleCard'
import { createStyle, updateStyle } from '../utils/styleStorage'

interface Props {
  initialStyle: StyleCard | null
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
    title: s.title ?? '',
    category: s.category ?? 'classic',
    catchCopy: s.catchCopy ?? '',
    description: s.description ?? '',
    price: String(s.price ?? 0),
    durationMinutes: String(s.durationMinutes ?? 0),
    imageUrl: s.imageUrl ?? '',
    tagsInput: (s.tags ?? []).join(', '),
    stats: { ...DEFAULT_STATS, ...s.stats },
    isFeatured: s.isFeatured ?? false,
    isPublished: s.isPublished ?? true,
  }
}

/* ── Shared input style — fontSize 16 prevents iOS Safari auto-zoom ── */
const inputBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  background: '#0D0806',
  border: '1px solid rgba(201,169,97,0.22)',
  borderRadius: 10,
  padding: '12px 14px',
  color: '#F2E6C8',
  caretColor: '#C9A227',
  fontSize: 16,
  outline: 'none',
  minHeight: 48,
  fontFamily: 'inherit',
}

/* ── Sub-components ──────────────────────────────────────────────── */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(201,169,97,0.62)', marginBottom: 8 }}>
      {children}
    </p>
  )
}

function FieldInput({
  label, value, onChange, placeholder, inputMode, error,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputMode?: React.InputHTMLAttributes<HTMLInputElement>['inputMode']
  error?: string
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        style={{ ...inputBase, borderColor: error ? 'rgba(180,50,50,0.7)' : 'rgba(201,169,97,0.22)' }}
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
        <p style={{ marginTop: 4, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, color: 'rgba(220,80,80,0.9)' }}>
          <AlertCircle size={11} /> {error}
        </p>
      )}
    </div>
  )
}

function FieldTextarea({
  label, value, onChange, placeholder, rows = 4,
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
        style={{ ...inputBase, resize: 'vertical', minHeight: rows * 28 + 24 }}
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
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        boxSizing: 'border-box',
        borderRadius: 14,
        padding: '14px 16px',
        minHeight: 52,
        background: '#0D0806',
        border: '1px solid rgba(201,169,97,0.18)',
        cursor: 'pointer',
        touchAction: 'manipulation',
      }}
    >
      <span style={{ fontSize: 15, color: '#F2E6C8' }}>{label}</span>
      <div
        style={{
          width: 48,
          height: 26,
          borderRadius: 13,
          flexShrink: 0,
          position: 'relative',
          background: value ? 'linear-gradient(135deg, #3A7A4A, #2A6B3A)' : 'rgba(255,255,255,0.08)',
          border: value ? '1px solid rgba(80,160,100,0.5)' : '1px solid rgba(255,255,255,0.12)',
          transition: 'background 0.2s',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 3,
            left: value ? 25 : 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: value ? '#C9F0D5' : 'rgba(255,255,255,0.3)',
            transition: 'left 0.2s',
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Label>{label}</Label>
        <span style={{ fontSize: 14, fontWeight: 700, color: value >= 4 ? '#E8C77A' : 'rgba(201,169,97,0.6)' }}>
          {value}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: '100%',
          height: 6,
          borderRadius: 3,
          appearance: 'none',
          WebkitAppearance: 'none',
          background: `linear-gradient(90deg, #C9A227 ${((value - 1) / 4) * 100}%, rgba(201,169,97,0.18) ${((value - 1) / 4) * 100}%)`,
          accentColor: '#C9A227',
          minHeight: 32,
          cursor: 'pointer',
          outline: 'none',
        }}
      />
    </div>
  )
}

/* ── Main component ─────────────────────────────────────────────── */

export function CMSStyleForm({ initialStyle, onSave, onCancel }: Props) {
  const isNew = initialStyle === null
  const [form, setForm] = useState<FormState>(() =>
    initialStyle ? fromStyleCard(initialStyle) : { ...EMPTY_FORM }
  )
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [saved, setSaved] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<'warn' | 'danger' | null>(null)
  const [showUrlInput, setShowUrlInput] = useState(() =>
    !!initialStyle?.imageUrl && !initialStyle.imageUrl.startsWith('data:')
  )
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setFileSizeWarning('danger')
    } else if (file.size > 500 * 1024) {
      setFileSizeWarning('warn')
    } else {
      setFileSizeWarning(null)
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      const result = ev.target?.result
      if (typeof result === 'string') {
        set('imageUrl', result)
        setImgError(false)
        setShowUrlInput(false)
      }
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }, [set])

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

  function handleSubmit() {
    if (!validate()) return

    const tags = form.tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    const baseDraft = {
      title: form.title.trim(),
      category: form.category,
      catchCopy: form.catchCopy.trim(),
      description: form.description.trim(),
      price: Number(form.price) || 0,
      durationMinutes: Number(form.durationMinutes) || 0,
      imageUrl: form.imageUrl.startsWith('data:') ? form.imageUrl : form.imageUrl.trim(),
      tags,
      stats: form.stats,
      isFeatured: form.isFeatured,
      isPublished: form.isPublished,
    }

    if (initialStyle === null) {
      createStyle({ ...baseDraft, sortOrder: 999 })
    } else {
      updateStyle(initialStyle.id, baseDraft)
    }

    setSaved(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(onSave, 900)
  }

  const clearImage = useCallback(() => {
    set('imageUrl', '')
    setImgError(false)
    setFileSizeWarning(null)
    setShowUrlInput(false)
  }, [set])

  return (
    <div style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 40px)' }}>

      {/* ── Sticky header with always-visible Save button ── */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'rgba(7,4,3,0.96)',
          borderBottom: '1px solid rgba(201,169,97,0.16)',
          WebkitBackdropFilter: 'blur(8px)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(201,169,97,0.18)',
            color: 'rgba(242,230,200,0.6)',
            fontSize: 13,
            minHeight: 44,
            minWidth: 68,
            touchAction: 'manipulation',
            cursor: 'pointer',
          }}
        >
          <ChevronLeft size={16} />
          戻る
        </button>

        <div style={{ flex: 1, textAlign: 'center' }}>
          <p style={{ fontSize: 9, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'rgba(201,169,97,0.5)', marginBottom: 1 }}>
            {isNew ? 'New Style' : 'Edit Style'}
          </p>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#F2E6C8', lineHeight: 1 }}>
            {isNew ? '新規追加' : '編集中'}
          </p>
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '10px 14px',
            borderRadius: 10,
            background: saved
              ? 'rgba(30,80,45,0.9)'
              : 'linear-gradient(135deg, #1C0A0B, #5A0D12)',
            border: saved
              ? '1px solid rgba(80,160,100,0.5)'
              : '1px solid rgba(232,199,122,0.52)',
            color: '#F2E6C8',
            fontSize: 13,
            fontWeight: 700,
            minHeight: 44,
            minWidth: 68,
            touchAction: 'manipulation',
            cursor: 'pointer',
            letterSpacing: '0.04em',
          }}
        >
          <Check size={14} />
          {saved ? '保存済' : '保存'}
        </button>
      </div>

      {/* ── Save success banner ── */}
      {saved && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '12px 16px',
            background: 'rgba(30,80,45,0.92)',
            borderBottom: '1px solid rgba(80,160,100,0.28)',
            color: '#C9F0D5',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <Check size={16} />
          保存しました — 一覧に戻ります
        </div>
      )}

      <div style={{ padding: '20px 16px 0', display: 'flex', flexDirection: 'column', gap: 22 }}>

        {/* ── 画像 ── */}
        <div>
          <Label>画像</Label>

          {/* Preview */}
          <div
            style={{
              width: '100%',
              height: 200,
              borderRadius: 14,
              overflow: 'hidden',
              background: '#0D0806',
              border: '1px solid rgba(201,169,97,0.16)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
              position: 'relative',
            }}
          >
            {form.imageUrl && !imgError ? (
              <img
                src={form.imageUrl}
                alt="プレビュー"
                style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top' }}
                onError={() => setImgError(true)}
                onLoad={() => setImgError(false)}
              />
            ) : form.imageUrl && imgError ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <Image size={28} style={{ color: 'rgba(180,50,50,0.5)' }} />
                <span style={{ fontSize: 12, color: 'rgba(180,50,50,0.7)' }}>読み込みエラー</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <Image size={32} style={{ color: 'rgba(201,169,97,0.2)' }} />
                <span style={{ fontSize: 12, color: 'rgba(201,169,97,0.28)' }}>画像未設定</span>
              </div>
            )}
          </div>

          {/* 3 image action buttons — label approach for iOS Safari compatibility */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
            {/* Photo picker via <label> — most reliable on iOS Safari */}
            <label
              htmlFor="cms-img-input"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '12px 6px',
                borderRadius: 12,
                background: '#0D0806',
                border: '1px solid rgba(201,169,97,0.34)',
                color: 'rgba(201,169,97,0.88)',
                fontSize: 11,
                fontWeight: 600,
                minHeight: 60,
                cursor: 'pointer',
                touchAction: 'manipulation',
                textAlign: 'center',
                userSelect: 'none',
              }}
            >
              <Camera size={20} />
              写真を選ぶ
            </label>
            <input
              id="cms-img-input"
              type="file"
              accept="image/*"
              style={{
                position: 'absolute',
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: 'hidden',
                clip: 'rect(0,0,0,0)',
                border: 0,
              }}
              onChange={handleFileSelect}
            />

            {/* URL input toggle */}
            <button
              type="button"
              onClick={() => setShowUrlInput((v) => !v)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '12px 6px',
                borderRadius: 12,
                background: showUrlInput ? 'rgba(201,169,97,0.12)' : '#0D0806',
                border: showUrlInput ? '1px solid rgba(201,169,97,0.5)' : '1px solid rgba(201,169,97,0.22)',
                color: showUrlInput ? '#E8C547' : 'rgba(201,169,97,0.6)',
                fontSize: 11,
                fontWeight: 600,
                minHeight: 60,
                cursor: 'pointer',
                touchAction: 'manipulation',
              }}
            >
              <Link2 size={20} />
              URLで指定
            </button>

            {/* Delete */}
            <button
              type="button"
              onClick={clearImage}
              disabled={!form.imageUrl}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '12px 6px',
                borderRadius: 12,
                background: '#0D0806',
                border: '1px solid rgba(180,50,50,0.3)',
                color: form.imageUrl ? 'rgba(220,80,80,0.85)' : 'rgba(180,50,50,0.3)',
                fontSize: 11,
                fontWeight: 600,
                minHeight: 60,
                cursor: form.imageUrl ? 'pointer' : 'not-allowed',
                touchAction: 'manipulation',
                opacity: form.imageUrl ? 1 : 0.4,
              }}
            >
              <Trash2 size={20} />
              画像を削除
            </button>
          </div>

          {/* URL input */}
          {showUrlInput && (
            <input
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="url"
              value={form.imageUrl.startsWith('data:') ? '' : form.imageUrl}
              onChange={(e) => { set('imageUrl', e.target.value); setImgError(false) }}
              placeholder="https://example.com/image.jpg"
              style={{ ...inputBase, marginBottom: 8 }}
              onFocus={(e) => {
                e.target.style.borderColor = 'rgba(201,169,97,0.54)'
                e.target.style.boxShadow = '0 0 0 2px rgba(201,169,97,0.08)'
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'rgba(201,169,97,0.22)'
                e.target.style.boxShadow = ''
              }}
            />
          )}

          {/* Size warning */}
          {fileSizeWarning && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                borderRadius: 10,
                padding: '10px 12px',
                background: fileSizeWarning === 'danger' ? 'rgba(80,20,20,0.7)' : 'rgba(80,60,10,0.7)',
                border: fileSizeWarning === 'danger' ? '1px solid rgba(180,50,50,0.4)' : '1px solid rgba(200,160,30,0.4)',
                color: fileSizeWarning === 'danger' ? 'rgba(240,100,100,0.9)' : 'rgba(230,190,60,0.9)',
                fontSize: 11,
              }}
            >
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {fileSizeWarning === 'danger'
                ? '2MB超え: LocalStorage容量に注意してください'
                : '500KB超え: 画像を圧縮することをお勧めします'}
            </div>
          )}
        </div>

        {/* ── タイトル ── */}
        <FieldInput
          label="タイトル *"
          value={form.title}
          onChange={(v) => set('title', v)}
          placeholder="例: 男前ショート"
          error={errors.title}
        />

        {/* ── カテゴリ ── */}
        <div>
          <Label>カテゴリ</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {STYLE_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => set('category', cat)}
                style={{
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontSize: 13,
                  fontWeight: 600,
                  minHeight: 44,
                  background: form.category === cat
                    ? 'linear-gradient(135deg, #1C0A0B, #5A0D12)'
                    : '#0D0806',
                  border: form.category === cat
                    ? '1px solid rgba(232,199,122,0.52)'
                    : '1px solid rgba(201,169,97,0.18)',
                  color: form.category === cat ? '#F2E6C8' : 'rgba(201,169,97,0.6)',
                  cursor: 'pointer',
                  touchAction: 'manipulation',
                }}
              >
                {STYLE_CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        </div>

        {/* ── キャッチコピー ── */}
        <FieldInput
          label="キャッチコピー"
          value={form.catchCopy}
          onChange={(v) => set('catchCopy', v)}
          placeholder="例: 清潔感と威圧感の完璧な融合"
        />

        {/* ── 説明文 ── */}
        <FieldTextarea
          label="説明文"
          value={form.description}
          onChange={(v) => set('description', v)}
          placeholder="スタイルの特徴や雰囲気を説明してください"
          rows={4}
        />

        {/* ── 価格・所要時間 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FieldInput
            label="価格（円）"
            value={form.price}
            onChange={(v) => set('price', v)}
            placeholder="5500"
            inputMode="numeric"
            error={errors.price}
          />
          <FieldInput
            label="所要時間（分）"
            value={form.durationMinutes}
            onChange={(v) => set('durationMinutes', v)}
            placeholder="60"
            inputMode="numeric"
            error={errors.durationMinutes}
          />
        </div>

        {/* ── タグ ── */}
        <div>
          <Label>タグ（カンマ区切り）</Label>
          <input
            type="text"
            value={form.tagsInput}
            onChange={(e) => set('tagsInput', e.target.value)}
            placeholder="例: ショート, ビジネス, 刈り上げ"
            style={inputBase}
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {form.tagsInput.split(',').map((t) => t.trim()).filter(Boolean).map((tag, i) => (
                <span
                  key={i}
                  style={{
                    display: 'inline-block',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 11,
                    background: 'rgba(201,169,97,0.12)',
                    color: 'rgba(201,169,97,0.8)',
                    border: '1px solid rgba(201,169,97,0.2)',
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── 能力値 ── */}
        <div
          style={{
            borderRadius: 14,
            padding: '16px',
            background: '#0D0806',
            border: '1px solid rgba(201,169,97,0.16)',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <p style={{ fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(201,169,97,0.52)' }}>
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

        {/* ── 公開設定 ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ToggleSwitch label="公開する" value={form.isPublished} onChange={(v) => set('isPublished', v)} />
          <ToggleSwitch label="おすすめに設定" value={form.isFeatured} onChange={(v) => set('isFeatured', v)} />
        </div>

        {/* ── ボタン群 ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
          {/* Primary save */}
          <button
            type="button"
            onClick={handleSubmit}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              width: '100%',
              borderRadius: 14,
              padding: '16px',
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: '0.1em',
              minHeight: 54,
              color: '#F2E6C8',
              background: 'linear-gradient(135deg, #050202 0%, #180708 48%, #5A0D12 100%)',
              border: '1px solid rgba(232,199,122,0.68)',
              boxShadow: 'inset 0 1px 0 rgba(242,230,200,0.1), 0 8px 20px rgba(0,0,0,0.32)',
              touchAction: 'manipulation',
              cursor: 'pointer',
            }}
          >
            <Check size={18} />
            {isNew ? '追加する' : '変更を保存する'}
          </button>

          {/* Cancel */}
          <button
            type="button"
            onClick={onCancel}
            style={{
              width: '100%',
              borderRadius: 14,
              padding: '14px',
              fontSize: 14,
              minHeight: 48,
              color: 'rgba(242,230,200,0.5)',
              border: '1px solid rgba(201,169,97,0.18)',
              background: 'transparent',
              touchAction: 'manipulation',
              cursor: 'pointer',
            }}
          >
            キャンセル
          </button>

          {/* App preview */}
          <button
            type="button"
            onClick={() => window.open(window.location.pathname + '?tab=styles', '_blank')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              width: '100%',
              borderRadius: 14,
              padding: '14px',
              fontSize: 13,
              minHeight: 48,
              color: 'rgba(180,210,255,0.8)',
              border: '1px solid rgba(100,140,200,0.28)',
              background: 'rgba(60,90,140,0.1)',
              touchAction: 'manipulation',
              cursor: 'pointer',
            }}
          >
            <ExternalLink size={14} />
            アプリで確認（図鑑タブ）
          </button>
        </div>
      </div>
    </div>
  )
}
