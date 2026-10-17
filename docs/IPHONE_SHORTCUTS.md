# iPhoneから銀二郎を使う（Staging試作）

初回だけ、Stagingの銀二郎PWAのマイページ下部「ホーム画面から予約・メンテナンス」を開く。
ページで連携キーを発行し、記載した手順でiPhoneのショートカットを2つ作る。Macは不要。

- メンテナンス確認：最終来店から14日以内の優待の残日数と、次回予約を読み上げる。
- Johnnyで予約：iPhoneの音声入力で文字にし、既存johnny-agentに会話を渡す。DBの仮確保で日時・担当・メニュー・料金を確認し、メニューで「この内容で予約する」を選ぶと確定。

設定ページ：https://otokomae-passport-staging.vercel.app/shortcuts.html

これはショートカットの起動用ウィジェット。日数を常時表示するWidgetKit版は未実装。操作によってショートカットアプリが開く。実際のiPhoneでの導入・音声操作は未検証。

## 実装とデータ

専用API：`https://kfufxzmucjljjouzpumi.supabase.co/functions/v1/customer-shortcuts`

POSTの入力と出力：

| action | 入力 | 出力 |
|---|---|---|
| pair | session（初回PWA内だけ） | kind=paired, token, expires_at |
| status | token | kind=status, say, days_remaining, next_booking |
| talk | token, message, state（初回空） | kind=message / confirm / handoff / error, say, state |
| confirm | token, state | kind=complete, say, reservation_id |

`say`を読み上げ、`state`を次のリクエストへ渡す。confirmの場合だけ「この内容で予約する／話し直す／終了」のメニューを表示する。error・handoffでは停止する。「はい」という発言だけでは確定しない。

専用キーは30日有効、DBにはハッシュだけ保存。元の顧客セッションはサーバー側でAES-GCM暗号化し、クライアントには返さない。連携は元の顧客セッションの失効にも追従する。PWAから全連携を解除できる。APIはStagingのproject refを明示検査し、他環境では動かない。サービスキーの変更後は連携し直す。

会話stateはサーバーが署名し、端末・有効期限に結びつける。DB内部RPCはservice_roleだけ実行可。顧客用の連携解除RPCは既存の会員トークンで所有者を検査する。端末ごとに20リクエスト／分まで。

会話は既存johnny-agentを呼び、既存のモデル設定を維持。iPhoneの音声入力・読み上げを使い、この機能からSTT/TTSを追加呼び出ししない。メンテナンス確認と最終確定ではGPTを呼ばない。変更・キャンセルはPWAへ案内する。

## 2026-10-17の反映・検証

- Staging migration：`20261017030847_customer_shortcuts`。履歴21本。予約受付true、スタッフ枠数設定は維持。本番への接続・変更なし。
- Edge Function：customer-shortcuts v1 / ACTIVE。既存johnny-agentは更新していない。
- Vercel：`dpl_B7ZXkz8r4hr5uYrho4kskfixj8Jc`。通常URLの旧配信が変わっていないことを確認して昇格。
- フロント配信は最新共有済みStaging `88e8086d634705ce3bf528d9d7b3f09d0f09eac9` のソースに新ページ・入口・Vite入力のみ追加。Claudeの作業ツリーには書き込んでいない。
- APIモック20項目、実スキーマのローカルPostgreSQL18項目が成功。外部AI呼び出し0回。
- Stagingで `supabase/tests/preflight_customer_shortcuts.sql` 成功。キー連携、残日数、料金変更、本人所有、確定、重複送信、権限、解除を確認後rollback。顧客1・予約27・連携端末0・提案0は実行前後一致。
- TypeScript＋Viteのローカルビルド・最新Stagingベースのクラウドビルド成功。
- 公開APIは無効キーを401で拒否。公開ページ200。ブラウザー390pxでレイアウトと未認証時の案内を確認。
- setup.tsのlintは0件。MyPageScreenの148行（既存の同期setState）の指摘1件は変更していない。全体lint成功とは扱わない。
- Security Advisorは既存の可変search_path・公開SECURITY DEFINER実行権限等を報告。新しい内部RPC／テーブルはanon・authenticatedから実行／参照できないことを別途確認。Advisorの全件解消は行っていない。

## 再検証

Node.js 24以降：`node scripts/customer-shortcuts.test.mjs`（外部通信なし）。

`supabase/tests/preflight_customer_shortcuts.sql` はテスト用の予約を作成し、最後にrollbackする。使い捨てDBまたは予約受付を有効にしたStagingだけで実行する。本番で実行しない。

## 参考

- [Apple：ショートカットからAPIを呼ぶ](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios)
- [Apple：ショートカットウィジェット](https://support.apple.com/guide/shortcuts/set-up-and-run-shortcuts-from-a-widget-apd029b36d05/ios)
- [Supabase：Edge Functionの認証](https://supabase.com/docs/guides/functions/auth-headers)
- [Advisor：SECURITY DEFINERの公開](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
- [Advisor：関数のsearch_path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
