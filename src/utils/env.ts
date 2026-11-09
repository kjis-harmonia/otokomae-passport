export type AppEnv = 'production' | 'staging'

export function getAppEnv(): AppEnv {
  return import.meta.env.VITE_APP_ENV === 'staging' ? 'staging' : 'production'
}

/** テスト用の道具（Staging の帯・リセット・ガチャの先行公開など）だけに使う。新しい機能の出し分けには ginFlow() を使う */
export function isStaging(): boolean {
  return getAppEnv() === 'staging'
}

/** 新しいお客様の流れ（LINE 型の銀ちゃん・お連れ様・予約の変更・キャンセル待ち）のスイッチ。11/9 にひとつにまとめた。
 *  Staging は常に入。本番は Vercel の VITE_GIN_FLOW=true で入る（戻すときはこの設定を外して公開し直すだけ）。
 *  新しい機能を Staging だけに出したいときも isStaging() ではなく、これを使う（引っ越しの日に漏れないように） */
export function ginFlow(): boolean {
  return isStaging() || import.meta.env.VITE_GIN_FLOW === 'true'
}
