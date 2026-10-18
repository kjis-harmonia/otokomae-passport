# 来店時の本人確認とJohnny（Staging）

2026-10-18、Stagingへmigration `20261018040349_customer_store_access` を適用し、rollback検証と権限確認に成功。`booking_settings.app_booking_enabled` はtrueのまま。`johnny-agent` v13へ認証チェックを追加し、JWT必須設定を維持した。AI本体・モデル・プロンプトは変更していない。Web差分はPR #4で管理する。本番には適用しない。

通常の会員QRに、5分だけ有効な確認リクエストIDを追加する。QRに本人のセッションや復帰用の秘密値を含めない。
店舗端末はQRから読み取った名前で既存会員を更新せず、登録済みの会員情報をスタッフ認証で取得する。スタッフが来店本人を確認し「本人を確認してJohnnyを有効にする」を押して初めて認証済みになる。
顧客端末はQRに含めない256ビットの秘密値で結果を受け取り、元の会員IDの新しいセッションを保存する。会員・チケット・予約・GINPayのレコードを作り直さない。
確認後はFace IDなどの初回設定を案内し、その後にJohnnyへ進む。すでに設定済みならそのままJohnnyへ進む。

## 認証の区別

- 自己申告の来店経験、会員IDの表示、QRを読んだだけの来店登録、パスキーの所持だけでは店舗確認済みにしない。
- 店舗確認は会員レコードに紐付き、以後の有効な会員セッションやパスキーログインで引き継がれる。旧方式で会員IDを変更した場合は確認を失効させる。
- 新規のお客さまは電話・既存のHOT PEPPER Beautyから予約できる。Johnnyだけを来店確認後に限定する。
- 元の会員情報を持つPWAでQRを開くことを基本にする。端末の保存情報をすべて失い、元の会員IDも分からないケースには、既存の店頭本人確認・会員検索による復旧が必要。
- この仕組みは荒らしの入口を減らす。確認済み会員による不正予約を完全に防ぐ仕組みではない。

## サーバー側の制限

未確認セッションは `customer_booking_options / customer_available_slots / customer_next_slots / customer_day_overview / customer_create_hold / customer_confirm_reservation` を直接呼んでも拒否される。
既存予約の照会・キャンセル・仮押さえの解放、通常の会員証やチケットの閲覧は残す。
現行予約エンジンは `app_private.store_original_customer_*` に移し、クライアントの実行権限を取り消す。公開関数はセッションと店舗確認を検査してから元の処理を呼ぶ。app_privateのUSAGEを一般ロールへ広げないため、公開入口はSECURITY DEFINER・空のsearch_pathを使う。
将来これらの公開関数を作り直すmigrationでは、この認証チェックを残すこと。公開関数を置き換えたらpreflightを再実行する。

`johnny-agent` は会話・録音・文字起こしのみ・音声生成のすべてで、有料APIを呼ぶ前に店舗確認を検査する。相談用の `johnny-style-advice` にも同じ入口を用意するが、当該関数は調査時のStagingには未デプロイだった。未配置のAI機能を新たに有効化する作業は含めない。
認証ヘルパーの適用対象はStaging URLのみ。本番データベース・本番デプロイは操作しない。
OpenAIのモデル・プロンプト・予約AI本体 `agent.ts` は変更しない。

## 保護とデータ

- 承認には、有効な店舗セッション、リクエストと同じ会員ID、スタッフ名が必要。
- 秘密値は顧客端末のメモリーのみ、DBはSHA-256だけ。通信再試行用の復帰結果は秘密値で暗号化し、同じ確認の再試行ではセッションを増やさない。
- 期限切れリクエストは次のリクエスト作成時に削除。定期削除ジョブは設定していない。
- 確認情報・リクエスト・制限カウンターはRLS有効。一般ロールによる直接参照や更新は禁止。
- 作成上限は全体毎分200件、会員IDごと毎時30件。氏名や電話番号だけでは本人と紐付けない。
- 店舗で誰を本人と認めるかは現場確認。偽造QRを見ただけで承認しない。担当者はサーバー上の氏名と来店本人を照合する。
- SMS契約・実送信・課金は不要。SMS試作はローカルに退避してあり、今回の変更には含めない。
- `booking_settings.app_booking_enabled` は変更しない。

## 検証

`node --experimental-transform-types scripts/customer-store-access.test.mjs`（Node 24以上）で、実際のEdge入口を偽の認証応答へ接続し、未確認時の会話・STT・TTS・相談が有料APIへ到達しないことを検証する。
`supabase/tests/preflight_customer_store_access.sql` は使い捨てDBまたはStaging用で、最後にrollbackする。
追加の使い捨てPostgreSQL検証では、6予約APIの拒否、スタッフ認証、会員不一致、秘密値不一致、既存IDとチケットの保持、リトライ、期限切れ、非公開エンジンの実行禁止、旧方式のID変更を確認する。
スマホ幅での顧客→店舗→Face ID案内の操作確認と、実機でのカメラ・Face ID確認は区別して記録する。

Advisor上では私有表のRLSポリシーなし（直接利用を禁止する設計）と公開SECURITY DEFINER RPCの警告が残る。各入口はスタッフセッション・顧客セッション・端末の秘密値を用途に応じて検査し、一般ロールが私有表や元の予約関数を直接利用できないことを確認済み。参照: https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
