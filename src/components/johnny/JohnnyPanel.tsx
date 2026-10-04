import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Loader2, Send } from 'lucide-react'
import { askCustomerJohnny, askHqJohnny } from '../../utils/johnnyApi'
import type { JohnnyMode, JohnnyResponse, JohnnyStyleSuggestion } from '../../utils/johnnyApi'
import type { JohnnyHandoff } from '../../utils/johnnyHandoff'

const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'

interface JohnnyPanelProps {
  mode: JohnnyMode
  title: string
  placeholder: string
  initialMessage?: string
  handoff?: JohnnyHandoff | null
  onTryOn?: (style: JohnnyStyleSuggestion) => void
  onBooking?: (style: JohnnyStyleSuggestion) => void
}

function slotLabel(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

export function JohnnyPanel({
  mode,
  title,
  placeholder,
  initialMessage = '',
  handoff = null,
  onTryOn,
  onBooking,
}: JohnnyPanelProps) {
  const [message, setMessage] = useState(initialMessage)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<JohnnyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(nextMessage = message) {
    const text = nextMessage.trim()
    if (!text || loading) return
    setLoading(true)
    setError(null)
    const r = mode === 'hq'
      ? await askHqJohnny(text)
      : await askCustomerJohnny(mode, text, handoff)
    setLoading(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setResult(r.data)
  }

  return (
    <section
      style={{
        fontFamily: SANS,
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'rgba(255,255,255,0.035)',
        borderRadius: 8,
        padding: 14,
        color: '#F2F2F2',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 650, letterSpacing: 0 }}>{title}</h2>
        {result?.audit && (
          <span style={{ fontSize: 11, color: '#7C7C7C', whiteSpace: 'nowrap' }}>
            {new Date(result.audit.source_fact_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {handoff?.styleTitle && (
        <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', color: '#C8C8C8', fontSize: 13 }}>
          {handoff.styleTitle}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            height: 42,
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(0,0,0,0.22)',
            color: '#F2F2F2',
            padding: '0 11px',
            fontSize: 14,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={loading || !message.trim()}
          aria-label="送信"
          title="送信"
          style={{
            width: 42,
            height: 42,
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.14)',
            background: loading || !message.trim() ? 'rgba(255,255,255,0.06)' : '#E7E0D2',
            color: loading || !message.trim() ? '#777' : '#111',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: loading || !message.trim() ? 'default' : 'pointer',
          }}
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>

      {error && <p style={{ margin: '10px 0 0', color: '#D8B4A0', fontSize: 13, lineHeight: 1.6 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: 0, color: '#D9D9D9', fontSize: 14, lineHeight: 1.7 }}>{result.answer}</p>

          {result.suggestions && result.suggestions.length > 0 && (
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              {result.suggestions.map((style) => (
                <div
                  key={style.slug}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '52px 1fr',
                    gap: 10,
                    padding: 8,
                    border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 6,
                    background: 'rgba(0,0,0,0.18)',
                  }}
                >
                  <div style={{ width: 52, height: 68, borderRadius: 4, overflow: 'hidden', background: '#111' }}>
                    {style.image_url && <img src={style.image_url} alt={style.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 14, fontWeight: 650, color: '#F2F2F2' }}>{style.title}</strong>
                      <span style={{ fontSize: 12, color: '#A6A6A6', whiteSpace: 'nowrap' }}>{style.booking_menu ? style.booking_menu.name : '予約メニュー未確定'}</span>
                    </div>
                    <p style={{ margin: '4px 0 0', color: '#9F9F9F', fontSize: 12, lineHeight: 1.45 }}>
                      {style.catch_copy ?? style.tags.slice(0, 3).join(' / ')}
                    </p>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      {style.tryon_style_id && onTryOn && (
                        <button type="button" onClick={() => onTryOn(style)} style={smallButtonStyle}>
                          試着
                        </button>
                      )}
                      {onBooking && (
                        <button type="button" onClick={() => onBooking(style)} style={smallButtonStyle}>
                          予約相談
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {result.menu_status === 'unconfirmed' && (
            <p style={{ margin: '10px 0 0', color: '#A6A6A6', fontSize: 13, lineHeight: 1.6 }}>このスタイルの予約メニューは未確定です。メニューは店舗で確認します。</p>
          )}
          {result.matched_menu && (
            <p style={{ margin: '10px 0 0', color: '#C8C8C8', fontSize: 13, lineHeight: 1.6 }}>
              {result.matched_menu.name} {result.matched_menu.duration_min}分{result.matched_menu.price != null ? ` ¥${result.matched_menu.price.toLocaleString()}` : ''}
            </p>
          )}

          {result.slots && result.slots.length > 0 && (
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              {result.slots.map((slot) => (
                <div key={`${slot.starts_at}:${slot.staff_id ?? ''}`} style={{ padding: '9px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.09)', color: '#EAEAEA', fontSize: 14 }}>
                  {slotLabel(slot.starts_at)}{slot.staff_name ? ` / ${slot.staff_name}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

const smallButtonStyle: CSSProperties = {
  minHeight: 32,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)',
  color: '#F2F2F2',
  fontSize: 12,
  cursor: 'pointer',
}
