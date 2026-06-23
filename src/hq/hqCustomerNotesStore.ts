import { supabase } from '../lib/supabase'

// 銀二郎本部 — 接客メモ（顧客カルテ Phase6-B）
// 「覚えてくれている接客」をシステム化するための自由記述メモ。MVPは追加のみ
// （編集・削除は今回実装しない）。customer_id は customers.id を参照する。
//
// 将来的な発展を想定し、note は完全な自由記述のtextとして保存する
// （「ポマード派」「濡れパン固定」「息子が野球」のような断片的なタグ的記述も
// そのまま1件のメモとして積み上げていけるよう、構造化や分類は今回設けない）。

export interface CustomerNote {
  id: string
  customer_id: string
  note: string
  created_by: string
  created_at: string
}

/** 顧客の接客メモを新しい順に取得（最大50件）。 */
export async function getCustomerNotes(customerId: string, limit = 50): Promise<CustomerNote[]> {
  try {
    const { data, error } = await supabase
      .from('customer_notes')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error || !data) return []
    return data as CustomerNote[]
  } catch {
    return []
  }
}

/** 接客メモを追加する。 */
export async function createCustomerNote(input: {
  customerId: string
  note: string
  createdBy: string
}): Promise<CustomerNote | null> {
  try {
    const { data, error } = await supabase
      .from('customer_notes')
      .insert({
        customer_id: input.customerId,
        note: input.note,
        created_by: input.createdBy,
      })
      .select()
      .single()
    if (error || !data) {
      console.error('[hqCustomerNotesStore] createCustomerNote error:', error)
      return null
    }
    return data as CustomerNote
  } catch (e) {
    console.error('[hqCustomerNotesStore] createCustomerNote exception:', e)
    return null
  }
}
