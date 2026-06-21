export function StgBadge() {
  return (
    <div style={{
      position: 'fixed', top: 10, right: 10, zIndex: 1000,
      padding: '4px 10px', borderRadius: 8,
      background: 'rgba(224,96,70,0.18)',
      border: '1px solid rgba(224,96,70,0.6)',
      color: '#E07050',
      fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
      userSelect: 'none', pointerEvents: 'none',
    }}>
      STG MODE
    </div>
  )
}
