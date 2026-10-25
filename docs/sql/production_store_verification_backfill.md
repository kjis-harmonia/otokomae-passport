# 15番直前：記録表の権限閉鎖と32人の一括承認

対象本番：`ufyzynpmkxytnhebombq`。SQL作成・ローカル検証まで完了。本番・Stagingへの書き込みはしていない。

2026-10-20更新：最新本番バックアップのコピーで20工程＋権限閉鎖＋30人の一括承認が成功。スマートフォン幅の発券確認はPR #8で完了。実iPhone・公開用設定・新しいWeb公開後の閉鎖Bは別途必要。[最新の検証結果](../production-db-rehearsal.md)と[コマンド一覧](../production-db-commands.md)を正本とする。本番・Stagingへは書き込んでいない。

## 承認済みの対象

2026-10-19 17:12 JSTの読み取りでは、会員59人中30人が対象、29人が対象外。チェックイン30人、完了会計8人、券使用15人（重複あり）。14:18の確認から対象集合は変わっていない。

慶一郎さんは氏名と記録上の最終来店日の名簿を確認し、**「30人全員でOK」**と承認した。除外・同姓同名の統合はしない。個人名入りの名簿は `.qa/store-verification-backfill/member-review.md` に保管し、Gitへ入れない。

対象集合の照合値：`c4824d0dc827cb5ab3f9979455ccede8`。

**2026-10-25 夜の更新：** 本番の再読み取りで候補32人。元の30人（10/20バックアップから取り出し照合値一致を確認）から外れた人は0、追加は10/23に登録・来店した2人。慶一郎さんが「2人ともOK」と承認。公開時の対象は **32人・照合値 `82c2e35ad55d2e36c2256e6b3d11e42e`**。現在の `customer_id:user_id` の集合を固定する照合値。人数が30人のままでもIDの顔ぶれが変われば止める。氏名や来店日の変更を固定する値ではない。

## 根拠と制約

- 現在の会員IDに一致する記録のみ。`has_visited_before` などの自己申告は使わない。同じ会員の複数記録は1人と数える。
- チェックイン：`visit_log.visit_date` または `maintenance_visits.last_visit_date` が日本時間の今日以前。
- 会計：`accounting_sessions.status = 'completed'`、作成日時が現在以前。
- 券使用：`ticket_usage_logs.status = 'used'` で使用日時・使用日が現在以前、または `tickets.used = true` で使用日時が現在以前。
- 未確定・失敗・取消の会計、発券だけ、使用日時なし、未来の記録、今の会員に一致しない古いIDは除外する。

古い記録表には一般向けの書き込み権限が残っていた。過去の記録がすべて店舗認証経由だったとは保証できない。新しい `visit_log` に一致するのは1人、残り29人は古い記録が根拠となる。この制約を踏まえ、今回は店の人による名簿確認で承認した。権限を閉じても過去の記録の由来が証明されるわけではない。

## SQLと動作

| ファイル | 用途 |
|---|---|
| production_lock_legacy_record_writes.sql | 一般向けの表・列書き込みと認証なしの旧更新RPCを閉じる |
| production_store_verification_candidates.sql | 人数・内訳・照合値の読み取り。BEGIN READ ONLY |
| production_seed_store_verifications.sql | 権限閉鎖を確認し、承認済み32人のうち未承認の人だけ登録 |

権限閉鎖の対象13表：
`visit_log`、`maintenance_visits`、`ticket_usage_logs`、`tickets`、`accounting_sessions`、`accounting_session_items`、`accounting_items`、`ticket_issue_logs`、`ticket_transfers`、`maintenance_coupon_tokens`、`customers`、`customer_user_aliases`、`customer_recovery_logs`。

PUBLIC・anon・authenticatedの表／列書き込み権限を外す。継承ロールなどで有効な書き込み権限が残れば全体をロールバックする。旧RPC `complete_customer_onboarding`、`recover_member`、`claim_ticket_transfer` は一般向け実行だけを閉じ、認証付きRPCの内部呼び出し用に本体を残す。

既存のSELECT権限・RLSポリシー・認証付きRPCの実行権限は変えない。読み取り全体を締めるSQLではない。

一括登録は15番と同じ定義の `app_private.customer_store_verifications` だけを先に準備する。RLS有効、PUBLIC・anon・authenticatedの全権限なし。

- `verified_by` は **一括（店の記録あり）**。
- `verified_at` は登録実行時刻。来店日時ではない。
- `staff_session_hash` は `bulk-store-records:…` の監査用ラベル。実在のスタッフセッションを偽装しない。
- `ON CONFLICT DO NOTHING` で既存の承認者・日時を保持する。
- 元の会員・会計・チケット・来店データ、予約設定、migration履歴は変えない。
- ロック待ちは5秒、各文の実行上限は30秒。前提や対象が違えば全体をロールバックする。

## アプリ側の確認

main `848679f` と staging `ca4c923` の顧客・店舗コードで、対象表への直接更新は見つからなかった。更新は認証付きRPCを通る。

ただし公開前に直す必要がある経路を2つ発見した。

1. 店舗の発券画面が旧 `staff_issue_tickets` を呼んでいた。6番のmigrationはこの実行権限を閉じる。画面を `staff_issue_tickets_once` に変更し、送信前に発行番号と入力を保存、応答が消えても同じ番号で再確認する修正を用意した。
2. 券受取のセッションなし経路が旧 `claim_ticket_transfer` を呼んでいた。`customer_claim_transfer` に統一し、セッションがなければ引き継ぎ案内へ進む修正を用意した。

画面修正・本番対応・最終検証が終わる前にDB更新を始めない。DB先行中は旧店舗画面の発券が止まるため、全体の公開手順には店舗の操作を止める時間帯が必要。

## 人が実行する順番

1. 本番対応・Web修正・最終チェックを完了し、全体の公開手順を確認する。`docs/release-runbook.md` と併用する。
2. 本番DBの1〜14番を1本ずつ実行・確認する。
3. 権限閉鎖SQLを実行し、13表と旧RPCの権限閉鎖が成功したことを確認する。
4. 読み取りSQLで32人・照合値 82c2e35ad55d2e36c2256e6b3d11e42e を再確認する。違えば止め、更新した対象を慶一郎さんへ見せ直す。
5. 一括登録SQLを実行する。内部でも1〜14番、15番未適用、権限閉鎖、対象集合を再確認する。
6. 登録件数と既存承認の保持を読み取りで確認してから15番へ。15番の成功時に通常のrolloutで履歴を残す。

各SQLは独立したトランザクション。**1本でも失敗すれば次へ進まない。Codexは本番書き込みを実行しない。**

Windowsで人が1本ずつ貼るコマンドは[本番DBコマンド一覧](../production-db-commands.md)の14-A〜14-Cを使う。古いDesktopチェックアウトでは実行しない。

## ローカル検証結果

架空データと使い捨てPostgreSQL互換環境で検証。本番・Stagingへの書き込み、外部通信はいずれも0。

- 一括登録 **11項目PASS**：根拠の選別／権限閉鎖の必須化／前提migration／15番適用済み／人数変化／同数でのID変更／30人登録と元データ不変／再実行／既存承認保護／私有表権限／15番の定義互換。
- 権限閉鎖 **12項目PASS**：継承権限の取り残しで全体ロールバック、13表の表・列・PUBLIC権限、旧RPC3つの拒否、実際の認証付き会員登録・店舗チェックイン・発券と同一キー再送照合・券使用・譲渡受取・会員復旧・券付き会計・GINPay・会計取消と残高復元、再適用。
- 発券クライアント **8項目PASS**：応答消失／再表示で同じ番号・操作者、保存失敗、壊れた保存、接続先違い、入力改変、完了保存失敗、複数タブ、旧RPCへの後戻り禁止、認証付き券受取。

ローカル成功は本番への適用成功ではない。実行時の前提確認と読み取り検証を省略しない。
