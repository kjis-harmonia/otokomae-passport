import { JohnnyPanel } from '../../components/johnny/JohnnyPanel'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'

export function HqJohnnyScreen() {
  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 920 }}>
      <section>
        <p style={{ margin: 0, marginBottom: 6, fontFamily: HQ_SANS, fontSize: 10, letterSpacing: '0.22em', color: HQ_COLORS.goldDim }}>
          OPERATOR
        </p>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: HQ_COLORS.textPrimary }}>
          JOHNNY
        </h1>
      </section>

      <JohnnyPanel
        mode="hq"
        title="経営相談"
        placeholder="今月の売上とGINPayから気になる点を見て"
      />
    </div>
  )
}
