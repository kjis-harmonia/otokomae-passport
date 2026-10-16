import type { CSSProperties } from 'react'

// 予約台帳まわりの共通の色・文字・スタイル。docs/DESIGN_PRINCIPLES.md：白〜ごく薄いグレー、黒文字、薄い罫線。
// 一日中表示する店舗端末なので、面の差は小さく、文字と罫線で整理する。
// アクセントは「対応が必要なこと（会計待ち）」だけに使う。

// main では本部（黒い画面）のメニュー画面だけが使うので、本部の色（hqTheme）に合わせた暗い色にしている。
// Staging の店舗端末・本部（白い画面）は明るい色のまま（このファイルは main と Staging で色だけ違う）。
export const C = {
  bg: '#16120E',
  surface: '#211B15', // 入力欄・選択中の面
  line: '#2F271E',
  lineSoft: '#241E17', // 30分の罫線
  lineStrong: '#4A3E2D',
  text: '#EFE6D6',
  sub: '#B8AC93',
  mute: '#8C8170',
  danger: '#D86B5C',
  accent: '#C9A24A',
  // タイムライン
  offHours: '#1B1611', // 勤務時間外
  booked: '#241E17', // 予約（これから）
  bookedLine: '#3A3024',
  active: '#2C251C', // 来店済み・施術中・会計待ち
  held: '#1E1914', // フリー予約が仮確保している時間（スタッフ行）
}
export const SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif'

export const linkStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', minHeight: 44,
  background: 'none', border: 'none', padding: 0, color: C.sub, fontSize: 14, fontFamily: SANS,
  textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer',
}

export const inputStyle: CSSProperties = {
  width: '100%', height: 46, boxSizing: 'border-box', padding: '0 12px', borderRadius: 8, fontSize: 16, fontFamily: SANS,
  background: C.bg, color: C.text, border: `1px solid ${C.lineStrong}`, outline: 'none', colorScheme: 'dark',
}
