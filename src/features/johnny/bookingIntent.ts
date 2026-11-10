// スタイルの「予約する」→ Johnny：押したメニューを入れた状態で、予約タブの Johnny を開く（あとは日時と担当を聞く）。
// Staging：予約はすべて LINE 型の会話の銀ちゃん（GinChat）。ここで一か所にまとめて振り分けるので、
//   どの画面から呼んでも旧バイク画面は出ない（11/9 慶一郎さん「旧バイク銀ちゃんがゾンビみたいに復活しよる」）。本番は承認のあと
import { ginFlow } from '../../utils/env'

export const JOHNNY_INTENT_EVENT = 'ginjiro:johnny-intent'
/** usual：ホームの「いつもの」から（メニューが分からなければ Johnny がいつものメニューを聞いて登録する） */
/** group：ホームの「2名以上で予約する」から（ご本人の予約のあと、お連れ様を聞く・11/6） */
/** manage：次回予約の「変更・キャンセル」から（日時を変える・メニューを変える・キャンセルするを最初に出す・11/7） */
/** person：いつものの「どなたのご予約ですか？」で選んだお連れ様（11/8）。無ければ会員本人 */
export interface JohnnyIntent { menuCode: string | null; label: string; usual?: boolean; group?: boolean; manage?: boolean; person?: { id: string; name: string } | null }

let pending: JohnnyIntent | null = null

/** 銀ちゃんの会話を開く（新しい流れ＝ginFlow）。book はメニューが決まっていれば入れて始める */
export function openGinBook(menuCode: string | null = null, label = ''): void {
  window.dispatchEvent(new CustomEvent('ginjiro:gin-book', { detail: { menuCode, label } }))
}

export function requestJohnny(intent: JohnnyIntent): void {
  if (ginFlow()) {
    if (intent.manage) window.dispatchEvent(new Event('ginjiro:gin-change'))
    // 2名以上・いつもの・お連れ様は、銀ちゃんが「どなたのご予約ですか？」から聞く（メニューは決めずに始める）
    else openGinBook(intent.group || intent.usual ? null : intent.menuCode, intent.group || intent.usual ? '' : intent.label)
    return
  }
  pending = intent
  window.dispatchEvent(new CustomEvent(JOHNNY_INTENT_EVENT))
}

/** 予約タブが受け取る（1回だけ） */
export function takeJohnnyIntent(): JohnnyIntent | null {
  const p = pending
  pending = null
  return p
}
