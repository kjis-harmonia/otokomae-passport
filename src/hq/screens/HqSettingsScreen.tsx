import { useState } from 'react'
import { HqPanel } from '../components/HqPanel'
import { HQ_COLORS, HQ_MONO, HQ_SANS } from '../hqTheme'

const STORE_INFO = [
  { label: '店舗名', value: '銀二郎 本店' },
  { label: '所在地', value: '東京都〇〇区〇〇 1-2-3' },
  { label: '電話番号', value: '090-2800-5425' },
  { label: '営業時間', value: '10:00 - 20:00' },
]

const NOTIFICATIONS = [
  { label: '予約通知', key: 'reserve' },
  { label: '会計完了通知', key: 'accounting' },
  { label: '在庫アラート', key: 'stock' },
  { label: '会員ランクアップ通知', key: 'rankup' },
]

const PERMISSIONS = [
  { name: '銀二郎', role: 'オーナー' },
  { name: 'テイテイ', role: 'スタイリスト' },
  { name: 'フリー', role: 'スタイリスト' },
]

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      style={{
        width: 38, height: 20, borderRadius: 10,
        background: on ? 'rgba(201,162,74,0.30)' : 'rgba(255,255,255,0.08)',
        border: `1px solid ${on ? HQ_COLORS.panelBorderStrong : HQ_COLORS.panelBorder}`,
        position: 'relative', cursor: 'pointer', padding: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 1, left: on ? 19 : 1,
        width: 16, height: 16, borderRadius: '50%',
        background: on ? HQ_COLORS.goldHi : HQ_COLORS.textMute,
        transition: 'left 0.15s ease',
      }} />
    </button>
  )
}

export function HqSettingsScreen() {
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    reserve: true, accounting: true, stock: false, rankup: true,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'stretch' }}>
        <HqPanel title="店舗情報" code="STORE" style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {STORE_INFO.map((f) => (
              <div key={f.label} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '2px 12px' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 11.5, color: HQ_COLORS.textSecondary, whiteSpace: 'nowrap' }}>{f.label}</span>
                <span style={{ fontFamily: HQ_MONO, fontSize: 12, color: HQ_COLORS.textPrimary, textAlign: 'right' }}>{f.value}</span>
              </div>
            ))}
          </div>
        </HqPanel>

        <HqPanel title="通知設定" code="NOTIFY" style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {NOTIFICATIONS.map((n) => (
              <div key={n.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: HQ_SANS, fontSize: 11.5, color: HQ_COLORS.textPrimary }}>{n.label}</span>
                <Toggle on={!!toggles[n.key]} onChange={() => setToggles(t => ({ ...t, [n.key]: !t[n.key] }))} />
              </div>
            ))}
          </div>
        </HqPanel>
      </div>

      <HqPanel title="ユーザー権限" code="ACCESS">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {PERMISSIONS.map((p) => (
            <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
              <span style={{ fontFamily: HQ_SANS, fontSize: 12.5, color: HQ_COLORS.textPrimary }}>{p.name}</span>
              <span style={{ fontFamily: HQ_MONO, fontSize: 11, color: HQ_COLORS.goldDim, letterSpacing: '0.06em' }}>{p.role}</span>
            </div>
          ))}
        </div>
      </HqPanel>

      <p style={{ fontFamily: HQ_MONO, fontSize: 10, color: HQ_COLORS.textMute, letterSpacing: '0.06em', margin: 0 }}>
        OTOKOMAE PASSPORT HQ — v0.1.0 (UI PROTOTYPE)
      </p>
    </div>
  )
}
