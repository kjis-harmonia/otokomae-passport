// スタイルの「予約する」→ Johnny：押したメニューを入れた状態で、予約タブの Johnny を開く（あとは日時と担当を聞く）。
export const JOHNNY_INTENT_EVENT = 'ginjiro:johnny-intent'
/** usual：ホームの「いつもの」から（メニューが分からなければ Johnny がいつものメニューを聞いて登録する） */
/** group：ホームの「2名以上で予約する」から（ご本人の予約のあと、お連れ様を聞く・11/6） */
/** manage：次回予約の「変更・キャンセル」から（日時を変える・メニューを変える・キャンセルするを最初に出す・11/7） */
/** person：いつものの「どなたのご予約ですか？」で選んだお連れ様（11/8）。無ければ会員本人 */
export interface JohnnyIntent { menuCode: string | null; label: string; usual?: boolean; group?: boolean; manage?: boolean; person?: { id: string; name: string } | null }

let pending: JohnnyIntent | null = null

export function requestJohnny(intent: JohnnyIntent): void {
  pending = intent
  window.dispatchEvent(new CustomEvent(JOHNNY_INTENT_EVENT))
}

/** 予約タブが受け取る（1回だけ） */
export function takeJohnnyIntent(): JohnnyIntent | null {
  const p = pending
  pending = null
  return p
}
