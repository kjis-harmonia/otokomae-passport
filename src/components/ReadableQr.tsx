import { QRCodeSVG } from 'qrcode.react'

/** A stationary, high-contrast QR with the full four-module quiet zone. */
export function ReadableQr({ value, size = 300, label = '店舗端末に提示するQRコード' }: {
  value: string
  size?: number
  label?: string
}) {
  return (
    <div data-readable-qr style={{ width: size, maxWidth: '100%', marginInline: 'auto', background: '#fff', lineHeight: 0, flexShrink: 0 }}>
      <QRCodeSVG
        value={value}
        size={size}
        level="M"
        boostLevel={false}
        marginSize={4}
        fgColor="#000000"
        bgColor="#FFFFFF"
        title={label}
        role="img"
        aria-label={label}
        style={{ display: 'block', width: '100%', height: 'auto', maxWidth: '100%', aspectRatio: '1' }}
      />
    </div>
  )
}
