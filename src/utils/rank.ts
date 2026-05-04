import type { MemberRank } from '../data/brand'

const RANK_ORDER: MemberRank[] = ['ブロンズ', 'シルバー', 'ゴールド', 'プラチナ']

export function getRankByExp(exp: number): MemberRank {
  if (exp >= 12) return 'プラチナ'
  if (exp >= 7) return 'ゴールド'
  if (exp >= 3) return 'シルバー'
  return 'ブロンズ'
}

export function getRankByPoints(points: number): MemberRank {
  if (points >= 100000) return 'プラチナ'
  if (points >= 50000) return 'ゴールド'
  if (points >= 20000) return 'シルバー'
  return 'ブロンズ'
}

export function getNextRankInfo(points: number): { nextRank: MemberRank | null; remainingPoints: number } {
  if (points < 20000) return { nextRank: 'シルバー', remainingPoints: 20000 - points }
  if (points < 50000) return { nextRank: 'ゴールド', remainingPoints: 50000 - points }
  if (points < 100000) return { nextRank: 'プラチナ', remainingPoints: 100000 - points }
  return { nextRank: null, remainingPoints: 0 }
}

export function getSafeRank(currentRank: MemberRank, computedRank: MemberRank): MemberRank {
  return RANK_ORDER.indexOf(computedRank) > RANK_ORDER.indexOf(currentRank) ? computedRank : currentRank
}

export function calculateEarnedPoints(amount: number): number {
  return amount * 0.5
}

export const RANK_LABEL: Record<MemberRank, string> = {
  ブロンズ: 'BRONZE',
  シルバー: 'SILVER',
  ゴールド: 'GOLD',
  プラチナ: 'PLATINUM',
}
