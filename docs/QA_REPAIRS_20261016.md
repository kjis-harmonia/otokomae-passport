# 銀二郎App・店舗端末 修正結果

2026-10-16 JST。確認された5項目を修正し、**Stagingへ反映済み**。

- アプリ: https://otokomae-passport-staging.vercel.app/
- 店舗端末: https://otokomae-passport-staging.vercel.app/staff
- SB: https://otokomae-passport-staging.vercel.app/sb
- 本部: https://otokomae-passport-staging.vercel.app/headquarters
- Vercel: `dpl_8dQhE9i6zsF99JMZ11sYm8WXALHN` / READY
- immutable URL: https://otokomae-passport-staging-1jz7cah9g-kjis-harmonias-projects.vercel.app
- DB: Staging `kfufxzmucjljjouzpumi` のみ。本番 `ufyzynpmkxytnhebombq` は変更していない。
- `booking_settings.app_booking_enabled=false` を維持。公開予約の確定はまだ開放していない。

| 問題 | 修正 | 確認 |
|---|---|---|
| チケット発行の応答が消えた後、再試行で二重発行し得る | 送信前にUUIDと発行内容を端末へ保存。同じUUIDをDBで排他処理し、保存済みの発行結果を返す。確認待ちは再読み込み後も復元。旧APIの直接実行は禁止 | 応答消失→再読み込み→再確認でも発行は1回。Stagingでも同一結果・発行ログ1回を確認 |
| 登録時の連絡先保存が通信失敗すると再送されない | 通信前に会員ID付きで保存待ちにする。起動・オンライン復帰・セッション変更で再送。別会員へ引き継いだ際は他人の保存待ちを送らない | 通信復旧後の保存、会員変更、同時編集時の上書き防止を確認 |
| QRカメラの起動途中で画面を閉じるとカメラが残り得る | 起動Promiseの完了までインスタンスを保持し、キャンセル後に起動しても停止・解放。読み取り完了は1回だけ通知 | 起動遅延・終了・二重読み取り・カメラ拒否のロジックテスト |
| チケット取得失敗を「0枚」と表示 | 前回の取得結果を残し、通信エラーと再読み込みを表示。初回取得失敗では「チケットなし」を表示しない。古い応答で新しい結果を上書きしない | 初回失敗・復旧・既存表示保持・応答順逆転の4項目 |
| スマホ通知の生成・通知タップの移動先が不適切 | Service WorkerのshowNotificationを優先。実際に通知できた場合のみ送信済みにする。通知タップは指定URLを開く。案内文も実装に合わせる | モバイル想定API・同時呼び出し・通知失敗・外部/内部URL・不正URLを確認 |

## 一続きの確認

Stagingの実RPCで次を同じトランザクション内で実行し、PASSを確認した。

`会員登録 → 連絡先保存 → 店舗チェックイン → 来店日の顧客取得 → チケット2枚発行 → 同じ発行を再確認 → 顧客ウォレット取得 → 店舗で2枚使用 → 顧客ウォレットで使用済み取得`

発行内容を変えた同じUUIDの再送、無効なスタッフトークン、旧発行APIの権限、発行結果テーブルの非公開も確認した。最後にrollbackし、検証用会員・チケット・発行結果を残していない。

これはAPI/DBの結合確認。**修正後のブラウザー操作・物理カメラでのQR読み取りの確認を完了したという意味ではない。**

## テストと配信確認

| 確認 | 結果 |
|---|---|
| Johnnyの予約・ルール処理 | 95項目 PASS |
| Johnny相談キャッシュ | 11項目 PASS |
| 今回の発行・連絡先・カメラ・通知 | 18項目 PASS |
| ウォレット通信エラー | 4項目 PASS |
| ローカルPostgresでの発行・原子性・権限 | 8項目 PASS。PGliteは単一接続のため、独立した複数接続の競合試験ではない |
| Johnny Edge Functionの入力・認証・情報量上限 | モックテスト PASS、有料OpenAI呼び出し0 |
| TypeScript / Vite build | PASS。大きいchunkの既存警告あり |
| 新規処理のlint | PASS |
| 既存ファイルの差分lint | 今回追加された問題0。既存のlint問題は残る |
| migration順・秘密情報の静的preflight | 19本の順序・secret scan PASS。全履歴を新規DBへ適用する試験は未実施 |
| Stagingの静的配信 | `/` `/staff` `/sb` `/headquarters` はHTTP 200。21個の配信JSでStaging接続先・新発行API・確認待ちUIを確認。本番DB参照0 |
| 修正後ブラウザーQA | ブラウザーのwebviewが接続できず未完了。新しい空タブでも同じだったため、アプリ自体の不具合とは判定しない |
| 実機 | iPhone/iPad/Androidの実カメラ・通知許可・実通知・QR読取精度は未確認 |

通知は**アプリを開いたときの通知**。アプリを閉じたまま届くバックグラウンドPushの配信・予約は未実装で、対応済みとは扱っていない。

## 今回適用したmigration

| version | name | 対象 |
|---|---|---|
| 20261016091916 | ticket_issue_idempotency | Stagingのみ |
| 20261016095032 | ticket_issue_require_request_id | Stagingのみ |

Staging履歴は17本から19本へ。履歴versionとファイル名を一致させた。旧画面を開きっぱなしの店舗端末は、ページを再読み込みすると新APIを使う。

作業ブランチは `codex/johnny-economy`。既存のJohnny省トークン実装を保ち、Staging側へ本番ブランチの氏名・電話番号の登録フォームを取り込んだ。今回Gitへのコミット・pushはしていない。

既存のSB系migrationも作業ブランチへ整理した。`sb_hotpepper_mail_notices`等3本はDB履歴にSQL本文がなく、元のAntigravityファイルから復元。noticesには、履歴に単独versionが残っていなかったHPB基盤SQLを前置して新規DBの依存関係を補った。**過去migrationをStagingに再適用していない。新規DBへの全履歴適用前には別途検証が必要。**

回帰テスト: `scripts/repair-regression.mjs`, `scripts/wallet-regression.mjs`, `scripts/ticket-issuance-db.test.mjs`, `supabase/tests/preflight_ticket_issue.sql`。

## 見た目をさらに良くする案

1. ホームの上部を「次の予約」「会員QRを見せる」の2つに集約し、大きなスタイル写真をその下に置く。
2. 会員QRは最初から読み取りやすい大きさへ。機種変更用の情報は詳細へまとめる。
3. ワインレッドとアイボリーを軸にし、金色・発光・常時アニメーションを絞る。本文は読みやすいゴシック体、見出しだけ明朝体。
4. 予約を公開する段階で、Shopタブを「予約」へ変え、Johnny→予約確認→会員QR→SB→本部の案内を統一する。

見た目の大幅変更と公開予約の有効化は今回行っていない。
