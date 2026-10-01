/**
 * Smart Wallet — カード共通型と静的クーポン定義
 *
 * UI はここで定義した WalletCard だけを描画する。
 * 将来 Supabase 等へ移行する場合は、COUPON_DEFINITIONS をテーブルから
 * 取得するように差し替えれば UI 側の変更は不要。
 */

import type { TicketRow, TicketType } from './ticket'

/** 店舗電話番号（漢前Premium は電話予約限定） */
export const SHOP_PHONE_DISPLAY = '090-2800-5425'
export const SHOP_PHONE_TEL     = 'tel:09028005425'

export type WalletCategory = 'cut' | 'classic' | 'special' | 'ginpara' | 'otoku'
export type WalletFilter   = 'cut' | 'premium' | 'other'

export const WALLET_FILTERS: { id: WalletFilter; label: string }[] = [
  { id: 'cut',     label: 'GINJIRO CUT' },
  { id: 'premium', label: '漢前Premiumパーマ' },
  { id: 'other',   label: 'その他' },
]

/** カードの状態（表示トーンと Priority の基準） */
export type WalletCardStatus =
  | 'active'    // 利用可能
  | 'urgent'    // 利用可能・期限間近（残り3日以内）
  | 'waiting'   // 有効だが現在は受付時間外 / 来店記録待ち
  | 'expired'   // 期限切れ
  | 'used'      // 使用済み

export type BookingType = 'phone' | 'web' | 'in-store'

/** 価格行（Premium のように複数メニューを持つカードに対応） */
export interface WalletPriceLine {
  label?:       string
  /** カード前面用の短い表記（狭い幅で価格行が詰まらないように） */
  shortLabel?:  string
  normalPrice?: number
  memberPrice:  number
}

/** 静的クーポン定義（店舗側で管理するマスタ） */
export interface CouponDefinition {
  id:           string
  category:     WalletCategory
  eyebrow:      string          // カード上部の英字ラベル
  title:        string
  subtitle?:    string
  description:  string
  prices:       WalletPriceLine[]
  extras?:      { appliesTo: string; items: string[] }  // 付帯サービス
  conditions:   string[]
  notes:        string[]
  bookingType:  BookingType
  phoneNumber?: string
  isMemberOnly: boolean
  memberBadge?: { en: string; ja: string }
}

/** UI が描画する共通カード */
export interface WalletCard {
  id:           string
  category:     WalletCategory
  eyebrow:      string
  title:        string
  subtitle?:    string
  status:       WalletCardStatus
  /** カード上の状態ラベル（例: あと3日 / 現在受付中 / 有効期限なし） */
  statusLabel:  string
  /** 補足（例: 次回受付 明日 17:00〜） */
  statusHint?:  string
  prices:       WalletPriceLine[]
  validFrom?:   string | null
  validUntil?:  string | null
  bookingType:  BookingType
  phoneNumber?: string
  isMemberOnly: boolean
  /** 小さいほど前面。computeSmartPriority が算出 */
  priority:     number
  accent:       WalletAccent
  /** 保有枚数（漢トク券のグルーピング用） */
  count?:       number
  /** メンテナンス 14日サイクル（残り日数リング用） */
  cycle?:       { remaining: number | null; total: number }
  /** 現在受付中（ライブインジケータ） */
  live?:        boolean
  /** 元データ参照（詳細・使用処理で使う） */
  source:
    | { kind: 'coupon'; definition: CouponDefinition }
    | { kind: 'ticket'; ticketType: TicketType; tickets: TicketRow[] }
}

export type WalletAccent =
  | 'crimson-gold'
  | 'premium-classic'
  | 'premium-special'
  | 'premium-ginpara'
  | 'otoku-300'
  | 'otoku-1000'
  | 'otoku-default'
  | 'muted'

// ── 静的クーポン ──────────────────────────────────────────────────────────────

export const MAINTENANCE_CUT: CouponDefinition = {
  id:          'coupon-maintenance-cut',
  category:    'cut',
  eyebrow:     'GINJIRO ONLY · MAINTENANCE',
  title:       'メンテナンスカット',
  subtitle:    '銀二郎Only',
  description: 'フェード・刈り上げ・ラインを整えて男前をキープ。',
  prices: [
    { label: 'テイテイメンテナンス', memberPrice: 3000 },
    { label: '銀二郎メンテナンス',   normalPrice: 3000, memberPrice: 2500 },
  ],
  conditions:  ['前回来店から14日以内限定', '来店登録（男前パスポートQR）の日を DAY 14 として毎日0:00に1日ずつ減少'],
  notes:       ['ご利用時はスタッフにクーポンQRをご提示ください。', '使用確定は店舗端末でのみ行われます。'],
  bookingType: 'web',
  isMemberOnly: true,
}

const PREMIUM_COMMON = {
  extras:      { appliesTo: '対象メニュー', items: ['スキンフェード', '顔剃り込み'] },
  conditions:  ['アプリ会員限定', '平日：終日受付', '土日祝：17:00〜19:00受付', '電話予約限定'],
  notes:       ['電話予約限定のクーポンです（Web予約は対象外）。', 'ご予約時に対象のPremiumカテゴリ名をお伝えください。'],
  bookingType: 'phone' as const,
  phoneNumber: SHOP_PHONE_DISPLAY,
  isMemberOnly: true,
  memberBadge: { en: 'APP MEMBER ONLY', ja: 'アプリ会員限定' },
}

export const GINJIRO_CLASSICS: CouponDefinition = {
  ...PREMIUM_COMMON,
  id:          'coupon-ginjiro-classics',
  category:    'classic',
  eyebrow:     'GINJIRO CLASSICS',
  title:       'GINJIRO CLASSICS',
  subtitle:    'アイパー / パンチ / ニグロ / 濡れパン',
  description: '銀二郎の王道を会員価格で。アイパー、パンチ、ニグロ、濡れパンが対象です。',
  prices:      [{ label: 'アイパー / パンチ / ニグロ / 濡れパン', shortLabel: 'CLASSICS', normalPrice: 9000, memberPrice: 8000 }],
}

export const SPECIAL_PERM: CouponDefinition = {
  ...PREMIUM_COMMON,
  id:          'coupon-special-perm',
  category:    'special',
  eyebrow:     'SPECIAL PERM',
  title:       'SPECIAL PERM',
  subtitle:    'ピンパーマ / ツイストパーマ',
  description: '動きと質感で魅せる特殊パーマ。ピンパーマ、ツイストパーマが対象です。',
  prices:      [{ label: 'ピンパーマ / ツイストパーマ', shortLabel: 'SPECIAL', normalPrice: 12000, memberPrice: 10000 }],
}

export const GINPARA: CouponDefinition = {
  ...PREMIUM_COMMON,
  id:          'coupon-ginpara',
  category:    'ginpara',
  eyebrow:     'GINPARA',
  title:       'GINPARA',
  subtitle:    '銀パラ',
  description: '銀二郎のプレミアムメニュー、銀パラ専用の会員クーポンです。',
  prices:      [{ label: '銀パラ', shortLabel: 'GINPARA', normalPrice: 16000, memberPrice: 15000 }],
}

export const PREMIUM_COUPONS: CouponDefinition[] = [
  GINJIRO_CLASSICS,
  SPECIAL_PERM,
  GINPARA,
]
