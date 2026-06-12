export const BRAND = {
  name: '男前パスポート',
  nameEn: 'OTOKOMAE PASSPORT',
  shopName: '銀二郎',
  tagline: '男の品格を、一枚に。',
} as const

export type MemberRank = 'ブロンズ' | 'シルバー' | 'ゴールド' | 'プラチナ'

export type NavTab = 'home' | 'gacha' | 'tryon' | 'styles' | 'diagnosis' | 'reserve' | 'mypage'

export interface Member {
  id: string
  name: string
  nameKana: string
  rank: MemberRank
  points: number
  visitCount: number
  memberSince: string
  nextVisit?: string
}

export const RANK_THRESHOLD: Record<MemberRank, number> = {
  ブロンズ: 0,
  シルバー: 20000,
  ゴールド: 50000,
  プラチナ: 100000,
}

export interface MemberStatus {
  memberName: string
  rank: MemberRank
  visitCount: number
  stampCount: number
  exp: number
  points: number
}

export interface Coupon {
  id: string
  title: string
  description: string
  amount?: number
  createdAt: string
  used: boolean
}

export const DEFAULT_MEMBER_STATUS: MemberStatus = {
  memberName: 'ゲスト',
  rank: 'ブロンズ',
  visitCount: 3,
  stampCount: 3,
  exp: 0,
  points: 4250,
}

export const MOCK_MEMBER: Member = {
  id: 'GJ-2024-00142',
  name: '田中 銀二郎',
  nameKana: 'タナカ ギンジロウ',
  rank: 'ゴールド',
  points: 4250,
  visitCount: 18,
  memberSince: '2024-04-15',
  nextVisit: '2026-05-15',
}
