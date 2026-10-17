export function StgBadge() {
  return (
    <div style={{
      position: 'fixed', top: 10, right: 10, zIndex: 1000,
      padding: '4px 10px', borderRadius: 8,
      background: 'rgba(178,58,58,0.08)',
      border: '1px solid rgba(178,58,58,0.4)',
      color: '#b23a3a',
      fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
      userSelect: 'none', pointerEvents: 'none',
    }}>
      STG MODE
    </div>
  )
}
