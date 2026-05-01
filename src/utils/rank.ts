import type { MemberRank } from '../data/brand'

export function getRankByExp(exp: number): MemberRank {
  if (exp >= 12) return 'プラチナ'
  if (exp >= 7) return 'ゴールド'
  if (exp >= 3) return 'シルバー'
  return 'ブロンズ'
}

export const RANK_LABEL: Record<MemberRank, string> = {
  ブロンズ: 'BRONZE',
  シルバー: 'SILVER',
  ゴールド: 'GOLD',
  プラチナ: 'PLATINUM',
}
