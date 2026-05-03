export function AppHeader() {
  return (
    <header
      className="relative shrink-0 overflow-hidden px-4 py-3"
      style={{
        background:
          'linear-gradient(180deg, rgba(18,15,12,0.96), rgba(7,7,7,0.94))',
        borderBottom: '1px solid rgba(201,162,39,0.24)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.36), inset 0 -1px 0 rgba(139,26,42,0.16)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(232,197,71,0.55), transparent)',
        }}
      />
      <div
        className="relative h-[92px] w-full overflow-hidden rounded-lg"
        style={{
          background: 'rgba(5,5,5,0.78)',
          border: '1px solid rgba(201,162,39,0.42)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.34), inset 0 0 18px rgba(201,162,39,0.08)',
        }}
      >
        <img
          src="/images/hero-ginjiro-app.webp"
          alt="銀二郎"
          className="h-full w-full object-cover"
        />
      </div>
    </header>
  )
}
