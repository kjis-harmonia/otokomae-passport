// スタイルの「予約する」→ Johnny：押したメニューを入れた状態で、予約タブの Johnny を開く（あとは日時と担当を聞く）。
export const JOHNNY_INTENT_EVENT = 'ginjiro:johnny-intent'
/** usual：ホームの「いつもの」から（メニューが分からなければ Johnny がいつものメニューを聞いて登録する） */
export interface JohnnyIntent { menuCode: string | null; label: string; usual?: boolean }

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
