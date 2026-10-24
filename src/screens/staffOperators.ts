// 店舗端末を触る人（会計・チャージ・予約の記録に残る「担当者」）。テイテイさん・銀二郎さんは施術に専念するので入れない（10/24 慶一郎さん決定）
export const TERMINAL_OPERATORS = ['リアン', 'シルビア', 'キャンディ'] as const
/** 端末に保存する担当者（店舗端末・予約台帳・顧客・銀Pay・SB で共通） */
export const OPERATOR_KEY = 'ginjiro_staff_name'
