// Hotpepper reservation URLs keyed by style title.
// Titles must match exactly: styleStorage titles AND TryOnScreen style names.
// Styles without a URL gracefully fall back to the in-app ReserveScreen.

/** 【14日以内限定】メンテナンスカット専用クーポン予約URL */
export const MAINTENANCE_CUT_URL = 'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000011140746&add=0&addMenu=0&rootCd=10'

const NUREPAN_URL    = 'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000010686417&add=0&addMenu=0&rootCd=10'
const CURL_IPER_URL  = 'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000008738705&add=0&addMenu=0&rootCd=10'
const PUNCH_PERM_URL = 'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000008396509&add=0&addMenu=0&rootCd=10'
const GINPARA_URL    = 'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000009409138&add=0&addMenu=0&rootCd=10'
const NATSU_URL      = 'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000009719294&add=0&addMenu=0&rootCd=10'

export const RESERVE_LINKS: Readonly<Record<string, string>> = {
  // styleStorage titles
  '俺は濡れパン':         NUREPAN_URL,
  'カールアイパー':       CURL_IPER_URL,
  'バチバチパンチパーマ': PUNCH_PERM_URL,
  '銀パラ':               GINPARA_URL,
  '夏ニグロ':             NATSU_URL,
  // TryOnScreen short names (subset of above)
  '濡れパン':             NUREPAN_URL,
  'パンチパーマ':         PUNCH_PERM_URL,
  // 新スタイル — CUT_URL 未定義のため暫定で既存URLへ誘導
  '昭和のアイパー':       CURL_IPER_URL,
  'リーゼントパンチ':     PUNCH_PERM_URL,
  'ジャマイカンアフロ':   CURL_IPER_URL,
  'スペインパーマ':       CURL_IPER_URL,
  'テイテイ刈り':         CURL_IPER_URL,
  '極道ボウズ':           PUNCH_PERM_URL,
  'トラック野郎御用達':   PUNCH_PERM_URL,
  // 新スタイル (2025-06 追加分) — 専用クーポンURL
  'シンサイパンチ':                     'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000008914837&add=0&addMenu=0&rootCd=10',
  '覚醒の色':                           'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000010603641&add=0&addMenu=0&rootCd=10',
  'サラリーマン専用 ギリギリパーマ':     'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000009996260&add=0&addMenu=0&rootCd=10',
  'ちょい悪オヤジ専用 昭和ヘアスタイル': 'https://beauty.hotpepper.jp/CSP/bt/reserve/?storeId=H000583749&couponId=CP00000008738693&add=0&addMenu=0&rootCd=10',
}

export function getReserveUrl(styleTitle: string): string {
  return RESERVE_LINKS[styleTitle] ?? ''
}
