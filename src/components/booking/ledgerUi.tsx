import type { CSSProperties, ReactNode } from 'react'
import { C, SANS, linkStyle } from './ledgerTheme'

// 予約台帳まわりの共通部品（シート・選択肢・ボタン・時間グリッド）。

export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 800, background: 'rgba(20,20,18,0.28)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 560, maxHeight: '90dvh', display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
          background: C.bg, color: C.text, fontFamily: SANS, borderTop: `1px solid ${C.line}`, borderRadius: '14px 14px 0 0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px 0' }}>
          <p style={{ fontSize: 15, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>{title}</p>
          <button type="button" onClick={onClose} style={linkStyle}>閉じる</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '4px 16px 16px', flex: 1 }}>{children}</div>
        {footer && (
          <div style={{ padding: '12px 16px calc(16px + env(safe-area-inset-bottom, 0px))', borderTop: `1px solid ${C.line}` }}>{footer}</div>
        )}
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginBottom: 8 }}>{title}</h3>
      {children}
    </section>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginTop: 12 }}>
      <span style={{ display: 'block', fontSize: 13, color: C.sub, marginBottom: 6 }}>{label}</span>
      {children}
    </label>
  )
}

export function OptionRow({ selected, onClick, children, check = true }: { selected: boolean; onClick: () => void; children: ReactNode; check?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', textAlign: 'left',
        minHeight: 48, padding: '10px 12px', marginBottom: 6, borderRadius: 8, fontSize: 15, fontFamily: SANS, cursor: 'pointer',
        background: selected ? C.surface : 'transparent', color: C.text, border: `1px solid ${selected ? C.text : C.line}`,
      }}
    >
      {check && (
        <span aria-hidden="true" style={{
          flexShrink: 0, width: 18, height: 18, borderRadius: 4, boxSizing: 'border-box',
          border: `1.5px solid ${selected ? C.text : C.mute}`, background: selected ? C.text : 'transparent',
          color: C.bg, fontSize: 13, lineHeight: '15px', textAlign: 'center', fontWeight: 700,
        }}>{selected ? '✓' : ''}</span>
      )}
      <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>{children}</span>
    </button>
  )
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{children}</div>
}

export function Chip({ selected, onClick, disabled, children }: { selected: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        minHeight: 44, padding: '0 16px', borderRadius: 22, fontSize: 15, fontFamily: SANS, cursor: disabled ? 'default' : 'pointer',
        background: selected ? C.text : 'transparent', color: selected ? C.bg : disabled ? C.mute : C.text,
        border: `1px solid ${selected ? C.text : C.line}`, opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

export function PrimaryButton({ onClick, disabled, danger, style, children }: {
  onClick: () => void; disabled?: boolean; danger?: boolean; style?: CSSProperties; children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', minHeight: 50, borderRadius: 10, fontSize: 16, fontWeight: 600, fontFamily: SANS,
        background: disabled ? C.line : danger ? C.danger : C.text, color: disabled ? C.mute : C.bg,
        border: 'none', cursor: disabled ? 'default' : 'pointer', ...style,
      }}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ onClick, disabled, danger, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, width: '100%', minHeight: 46, borderRadius: 10, fontSize: 15, fontFamily: SANS, padding: '0 12px',
        background: 'transparent', color: danger ? C.danger : C.text, border: `1px solid ${C.line}`,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

/** 空き時間のボタン一覧（予約エンジンが返した時刻だけ） */
export function TimeGrid({ loading, times, selected, onSelect, label }: {
  loading: boolean; times: { iso: string; text: string }[]; selected: string | null; onSelect: (iso: string) => void; label?: string
}) {
  if (loading) return <p style={{ color: C.sub, fontSize: 14, marginTop: 12 }}>空き時間を確認中…</p>
  if (times.length === 0) return <p style={{ color: C.sub, fontSize: 14, marginTop: 12 }}>{label ?? 'この日は空き時間がありません。'}</p>
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 8, marginTop: 12 }}>
      {times.map(t => (
        <button
          key={t.iso}
          type="button"
          onClick={() => onSelect(t.iso)}
          aria-pressed={selected === t.iso}
          style={{
            minHeight: 44, borderRadius: 8, fontSize: 15, fontFamily: SANS, fontVariantNumeric: 'tabular-nums', cursor: 'pointer',
            background: selected === t.iso ? C.text : 'transparent', color: selected === t.iso ? C.bg : C.text,
            border: `1px solid ${selected === t.iso ? C.text : C.line}`,
          }}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
