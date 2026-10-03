import { MAINTENANCE_CUT_URL, getReserveUrl } from '../data/reserveLinks'
import { SHOP_PHONE_DISPLAY, SHOP_PHONE_TEL } from '../data/wallet'

// 予約の案内。
// アプリ内での予約はまだ受け付けていない（予約システムは Feature Flag OFF）。
// 以前の画面は予約を保存しないのに「予約完了」に見えたため、確定操作をなくし、
// 実際に予約が取れる電話・HOT PEPPER Beauty へだけ案内する。

const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'

/** 既存のクーポン予約リンクがあるメニューだけ（reserveLinks のURLをそのまま使う） */
const HOTPEPPER_MENUS: { label: string; url: string }[] = [
  { label: 'メンテナンスカット（前回来店から14日以内）', url: MAINTENANCE_CUT_URL },
  ...['濡れパン', 'パンチパーマ', 'カールアイパー', 'ニグロパーマ', '銀パラ', 'テイテイ刈り']
    .map(label => ({ label, url: getReserveUrl(label) }))
    .filter(m => m.url),
]

export function ReserveScreen() {
  return (
    <div style={{ padding: '24px 16px 120px', color: '#F2F2F2', fontFamily: SANS }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>予約</h1>
      <p style={{ fontSize: 15, color: '#A3A3A3', lineHeight: 1.7, marginTop: 8 }}>
        ご予約はお電話か HOT PEPPER Beauty で承っています。
      </p>

      <a
        href={SHOP_PHONE_TEL}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', height: 52, marginTop: 20, borderRadius: 10,
          background: '#F2F2F2', color: '#0B0B0B', fontSize: 16, fontWeight: 600, textDecoration: 'none',
        }}
      >
        電話で予約する（{SHOP_PHONE_DISPLAY}）
      </a>

      <h2 style={{ fontSize: 13, fontWeight: 600, color: '#A3A3A3', marginTop: 32, marginBottom: 4 }}>HOT PEPPER Beauty で予約</h2>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.09)' }}>
        {HOTPEPPER_MENUS.map(m => (
          <a
            key={m.label}
            href={m.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 52, padding: '0 2px',
              borderBottom: '1px solid rgba(255,255,255,0.09)', color: '#F2F2F2', fontSize: 15, textDecoration: 'none',
            }}
          >
            <span>{m.label}</span>
            <span aria-hidden="true" style={{ color: '#6E6E6E' }}>›</span>
          </a>
        ))}
      </div>
      <p style={{ fontSize: 13, color: '#6E6E6E', marginTop: 12 }}>HOT PEPPER Beauty のページが開きます。</p>
    </div>
  )
}
