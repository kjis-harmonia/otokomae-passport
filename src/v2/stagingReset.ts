// Staging だけ：☰「テスト用：登録した直後に戻す」（11/7 慶一郎さん：予約・いつもの・案内が残ると何も検証できない）
//   DB：予約・来店の記録・いつもの・ガチャ・券（Welcome だけ未使用で残す）・AI予約の停止を消す。店頭の確認は済みのまま（staging_reset_me）
//   端末：「？」の案内を見た印・いつもの・いつもの担当・いつものメンバー・お連れ様・次回予約の写し・AI の回数を消す
//   開き直すと、登録が終わった直後と同じく「？」の案内から始まる
import { callCustomerRpc } from '../utils/customerSession'

const LOCAL_KEYS = [
  'ginjiro_guide_seen_customer', 'ginjiro_first_guide',
  'ginjiro_usual_menu', 'ginjiro_usual_staff', 'ginjiro_usual_members',
  'ginjiro_companion_reservations', 'ginjiro_companion_names', 'ginjiro_next_reservation',
  'ginjiro_johnny_ai_count', 'ginjiro_campaign_hidden', 'otokomae_gacha_date', 'otokomae_gacha_result',
]

export async function resetStagingTester(): Promise<void> {
  const r = await callCustomerRpc<{ error?: string } | null>('staging_reset_me')
  if (r && r.error) throw new Error(r.error)
  LOCAL_KEYS.forEach(k => { try { localStorage.removeItem(k) } catch { /* 保存できない端末 */ } })
  window.location.replace(window.location.pathname)
}
