# お客さんのワンタップ導線（Staging）

対象DBは kfufxzmucjljjouzpumi のみ。本番への接続・変更はしない。

## 操作

- 通常は端末の会員セッションを維持。ホームの「Johnnyで予約」または下タブ「予約」から直接Johnnyを開く。StagingではSHOP番号入力を挟まない。
- 初回登録は名前・電話番号・来店経験を一画面で入力。既存の登録とWelcomeクーポン判定を使用し、会員登録や予約を自動的に重複作成しない。
- 既存会員は、有効なセッションが残る端末で「かんたんログインを設定」を一度押し、OSの本人確認でパスキーを登録する。
- 保存データがない端末では「会員情報で続ける」からOSの本人確認。登録済みのパスキーから同じ会員IDの新しいセッションを発行する。電話番号・会員ID・パスワードの入力は不要。
- 初めて使う端末の名前や連絡先が、Face IDだけで自動取得されるわけではない。パスキーを登録したことがなく既存セッションも失った会員には、従来の本人確認による引継ぎが必要。旧コード方式は「別の方法」に残す。
- パスキー非対応端末でも既存セッションで利用できる。Face ID以外に指紋や端末PIN等になるかはOSが決める。
- 手動Shortcuts設定ページは廃止し、/shortcuts.html は /?tab=reserve へ移動する。今回の実装はPWAでの認証と予約入口。本物のWidgetKitウィジェットは別途iPhoneアプリが必要。

## 実装と制約

- Edge Function: customer-passkeys。WebAuthnの暗号処理は固定版 @simplewebauthn/server 13.3.3、ブラウザーは13.3.0。独自の署名検証を実装しない。
- 許可origin / RP IDは otokomae-passport-staging.vercel.app に固定。別のVercelプレビューURLではパスキーを登録しない。
- enrollmentは有効な会員セッションにのみ紐付ける。既存パスキーを別キーで暗黙に置換しない。ユーザーID指定や名前一致による既存会員の乗っ取りは認めない。
- challengeは3分有効・一度限り。登録時は元セッションに結びつける。user verification、RP ID、origin、challenge、署名、userHandle、署名カウンターを検証する。
- カウンター更新とセッション発行はDB内で原子的に実行。登録・ログインをしても既存予約・チケット・来店履歴は変更しない。
- 認証情報・一時challenge・rate limitはapp_private内、RLS有効。anon/authenticatedには参照とサービスRPC実行を許可しない。公開RPCはSECURITY INVOKERで、service_roleにのみ実行権限。
- 解除には5分以内のパスキー本人確認が必要。解除後はすべての会員セッションを失効させる。内部テーブルの認証情報は論理失効し、物理削除しない。
- 原文IPを保存しない。サーバー鍵でHMAC化した送信元ごとに30リクエスト/分。認証応答はno-store。秘密鍵と生体情報は受け取らない。
- Johnnyの会話ロジック・OpenAI設定は変更しない。この認証にはOpenAI APIを使用しない。

## 検証

supabase/tests/preflight_customer_passkeys.sql は使い捨てDBかStagingで実行し、必ずrollbackする。本番で実行しない。
実機Face ID、iCloud同期、OSごとの確認画面は実iPhoneで確認が必要。

## 2026-10-17の検証・適用状況

- 実WebAuthn署名＋使い捨てPostgreSQLの統合20項目成功。固定SDKの署名回帰13項目成功。外部AI呼び出し0回。
- SQLのrollbackテスト成功。チャレンジ再利用、カウンター競合、権限、全セッション失効、従来の会員ID引継ぎとの互換性を確認。テスト後の会員・パスキー・challengeは0件。
- ブラウザーで一画面の登録、パスキー設定、保存情報の全削除、ワンタップ認証、同じ会員としてJohnnyの日時質問へ復帰まで成功。OS認証器はローカルの使い捨てソフトウェア認証器で代用。検証DBは会員1・パスキー1・予約0を維持。
- TypeScript/Viteビルド成功。追加した認証モジュール・予約入口・引継ぎ画面のlintは0件。全体の既存lint解消は対象にしない。
- Stagingへのmigration要求は `Invalid or expired requestState` で拒否され、再開指示後の再試行でも同じ確認エラーとなったため後続変更を停止。読み取りは通る。履歴23本・最新20261017050000、パスキーテーブルとRPCなし、app_booking_enabled=trueを再確認。
- DB未適用のためEdge Functionのデプロイとフロント公開も実施していない。未動作の認証画面へ公開先を切り替えない。本番への接続・変更なし。
- 再開時はSupabaseの変更確認を更新し、Stagingの最新履歴と未適用を再確認してからcustomer_passkeysだけを適用する。リポジトリ内の他の未適用migrationを一括適用しない。適用の版番号は実際の履歴とローカルファイルを一致させる。

再検証：`node scripts/customer-passkeys.test.mjs`。Supabase SQLテストは上記rollbackファイルを使用する。

- 最新origin/stagingを統合し、Johnny・通知・銀Pay・ホーム追加ガイドの変更を保持。パスキー設定中はホーム追加の自動案内を抑制し、StagingのBGM自動案内は省略（手動操作は維持）。
