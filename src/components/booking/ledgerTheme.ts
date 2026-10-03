import type { CSSProperties } from 'react'

// 予約台帳まわりの共通の色・文字・スタイル。docs/DESIGN_PRINCIPLES.md：白〜ごく薄いグレー、黒文字、薄い罫線。
// 一日中表示する店舗端末なので、面の差は小さく、文字と罫線で整理する。
// アクセントは「対応が必要なこと（会計待ち）」だけに使う。

export const C = {
  bg: '#FFFFFF',
  surface: '#F6F6F4', // 入力欄・選択中の面
  line: '#E7E7E3',
  lineSoft: '#F1F1EE', // 30分の罫線
  lineStrong: '#CBCBC5',
  text: '#1B1B1A',
  sub: '#5F5F5B',
  mute: '#9A9A95',
  danger: '#C2362F',
  accent: '#A8721A',
  // タイムライン
  offHours: '#F3F3F0', // 勤務時間外
  booked: '#EFEFEB', // 予約（これから）
  bookedLine: '#D8D8D2',
  active: '#E3E3DE', // 来店済み・施術中・会計待ち
  held: '#F8F8F5', // フリー予約が仮確保している時間（スタッフ行）
}
export const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'

export const linkStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', minHeight: 44,
  background: 'none', border: 'none', padding: 0, color: C.sub, fontSize: 14, fontFamily: SANS,
  textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer',
}

export const inputStyle: CSSProperties = {
  width: '100%', height: 46, boxSizing: 'border-box', padding: '0 12px', borderRadius: 8, fontSize: 16, fontFamily: SANS,
  background: C.bg, color: C.text, border: `1px solid ${C.lineStrong}`, outline: 'none', colorScheme: 'light',
}
