# 本番DBの人向けコマンド一覧（③・本番実行は休業中のみ）

対象は **ufyzynpmkxytnhebombq**。休業中に慶一郎さんが1ブロックずつ実行する。Codexは本番へ書き込まない。今は公開作業の許可ではない。

**指定のDB手順の通し検証は完了。本番公開は保留。** 2026-10-20に明示的な取得許可を受け、最新本番バックアップをDesktop/otokomae-backups/20261020-044459へ保存。コピーで20工程＋権限閉鎖＋30人の一括承認が成功した。会員59人・券130枚・会計23件の検査対象列は不変。30人・照合値 c4824d0dc827cb5ab3f9979455ccede8（10/20時点の記録） も一致した。

**追加の必須工程を発見：20工程だけではセキュリティ閉鎖Bが抜ける。** 会員表などの一般向け読み取りと、日報・商品・旧LIVE/営業状態の書き込み権限が残る。新しいWebの公開・会員引継ぎ確認後、営業を再開する前に、このファイル末尾の「公開後の閉鎖B」を実行する順番とする。20工程のループに自動追加していない。閉鎖Bはコピー上のrollback試験で検査済み、本番には未適用。

## 事前条件と停止条件

- ①発券画面のローカル確認はPR #8で完了。②の実iPhone確認、④のrelease PR、⑤の関数・設定・cron、公開当日の全体手順が完了していること。③だけで公開しない。
- 店舗操作・発券・会計・予約の受付を止める時間を確保する。DB先行中は古い画面の発券が止まる。古いタブを開いたまま営業を再開しない。
- エラー、想定外の件数・照合値、会員・会計・券などの既存データの変化が1つでもあれば停止。次を実行しない。履歴を消す、SQLを作り直して押し通す、db push、無条件再実行をしない。
- SQLは各1トランザクション。失敗した1本はロールバックするが、すでに成功した別の工程は元に戻らない。復旧方針を確認するまで営業再開しない。
- 全コマンドはWindows PowerShell用。パスは現在の作業ツリーを明記している。古いDesktopのチェックアウトでは実行しない。

## 0. まず最新バックアップ（本番は読み取りのみ）

最初に次を貼る。PostgreSQL 17のネイティブツールを使うのでDockerは不要。Supabase本番のConnectでSession pooler（5432）の接続URLを取得し、**パスワードを除いたURL**を入力する。パスワードは次の非表示の入力欄にだけ入れる。URLにパスワードが含まれていれば中止する。プロジェクトとSSLも検査する。

```powershell
! & "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/backup-production-db.ps1"
```

成功条件：BACKUP OK、database.dump・roles.sql・contents.txt・sha256.jsonがGit外のDesktop/otokomae-backups/日時/にできる。会員・券・migration履歴がアーカイブの目次に含まれる。失敗、パスワード不明、権限不足、接続不良なら停止する。パスワードやバックアップ内容をチャットへ貼らない。

読み取り確認：pg_restore --list database.dump で目次を検査する（スクリプト内で実行済み）。SHA256と目次確認だけでは復元の成功は証明されない。復元は127.0.0.1の使い捨てDBで行い、その最新コピーで22工程を通してから戻る。本番へのpg_restoreはこの一覧に含めない。Storageの実ファイル・外部の環境変数・Edge FunctionsはこのDBバックアップの対象外。

## 0-1. SQLを生成（ローカルファイルのみ）

```powershell
! node "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/prepare-production-db-release.mjs"
```

成功条件：22 rollout files、history 26 -> 47、No database connection made。生成先はsupabase/rollout/out_release。既存のbuild_accounting_rollout.shで上書きしない。この一覧用の生成器は工程前後の履歴照合を追加している。Git対象外のmanifest.jsonにSQLと元migrationのSHA256を保存する。

## 0-2. 本番の実行前状態を読み取る

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_00.sql"
```

読み取りSQL：check_00.sql（BEGIN READ ONLY）。返却verificationにはdata・app_booking_enabled・history_count・historyが1つのJSONで入る。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：履歴は26件（本番へ先行で入れた SB のお知らせ 20261023000100〜0500 の5本と 20261024000000_sb_close_time を含む）でversionと名前がレビュー済みの集合に一致する。件数だけでなくSQL内で照合する。dataの9表の件数・合計・md5、app_booking_enabledを保存しておく。以後、全工程で同じ値であること。名簿・連絡先・トークンは出力しない。

## 01〜22（14と15の間に追加の3工程）
### 01. ginpay_ledger

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/01_20261004000000_ginpay_ledger.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_01.sql"
```

読み取りSQL：check_01.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=27、履歴照合値=6f5f1a47b5b31c2591747cf8b6323366（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 02. checkout

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/02_20261005000000_checkout.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_02.sql"
```

読み取りSQL：check_02.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=28、履歴照合値=2bef95944b4b637119b64d2ed3d98bc8（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 03. service_master（カタログ関数だけ復元）

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/03_20261006000000_service_master_checkout_catalog_json.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_03.sql"
```

読み取りSQL：check_03.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=28、履歴照合値=2bef95944b4b637119b64d2ed3d98bc8（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。03は既存versionを維持し、履歴を増やさない。違えば停止する。

### 04. client_visit_model

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/04_20261007000000_client_visit_model.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_04.sql"
```

読み取りSQL：check_04.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=29、履歴照合値=e73cfb8d66ecbab2378a6afd28992a41（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 05. ticket_issue_idempotency

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/05_20261016091916_ticket_issue_idempotency.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_05.sql"
```

読み取りSQL：check_05.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=30、履歴照合値=a8c345e3242e52601c53e7d5c9cb433a（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 06. ticket_issue_require_request_id

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/06_20261016095032_ticket_issue_require_request_id.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_06.sql"
```

読み取りSQL：check_06.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=31、履歴照合値=54f7a807817448eacb74baee2805e14e（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 07. unified_booking_flow

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/07_20261016234902_unified_booking_flow.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_07.sql"
```

読み取りSQL：check_07.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=32、履歴照合値=4ac0a13eca285c03716d8144ecd29e99（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 08. customer_shortcuts

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/08_20261017030847_customer_shortcuts.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_08.sql"
```

読み取りSQL：check_08.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=33、履歴照合値=28bcf8b4beac6bc6719a8130a91afde1（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 09. ginpay_charge_bonus

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/09_20261017040000_ginpay_charge_bonus.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_09.sql"
```

読み取りSQL：check_09.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=34、履歴照合値=4c6605d11cdc10352b794538b4d2ab5a（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 10. ginpay_member_lookup

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/10_20261017050000_ginpay_member_lookup.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_10.sql"
```

読み取りSQL：check_10.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=35、履歴照合値=594346255192cd40ef7164d2937e4ef0（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 11. customer_passkeys

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/11_20261017202804_customer_passkeys.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_11.sql"
```

読み取りSQL：check_11.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=36、履歴照合値=e1b43b7843aa12d3e83de54a04f5991c（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 12. member_checkout

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/12_20261018000010_member_checkout.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_12.sql"
```

読み取りSQL：check_12.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=37、履歴照合値=dcfddfd9c4b88da34d276e3552759f2b（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 13. checkout_ticket_mix

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/13_20261018000100_checkout_ticket_mix.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_13.sql"
```

読み取りSQL：check_13.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=38、履歴照合値=85356cc68329168f82c73269186b5b70（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 14. sales_day_breakdown

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/14_20261018000200_sales_day_breakdown.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_14.sql"
```

読み取りSQL：check_14.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=39、履歴照合値=70b8ee95c89eb046715e395ae1132265（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 14-A. 古い記録への一般書き込みを閉じる

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/production_lock_legacy_record_writes.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_acl.sql"
```

SQL：check_acl.sqlはpg_class・has_table_privilege・has_any_column_privilege・has_function_privilegeで13表と旧RPCを検査する。

次へ：NOTICE legacy record writes locked ok、verification.acl.tables_found=13、writes_closed=true、legacy_functions=3、legacy_closed=true、履歴33件、既存dataと予約設定は0-2と同じ。SELECT権限と認証付きRPCの保存は適用SQL内でも検査する。1つでも違えば停止。

### 14-B. 承認済みの32人を読み取りで再照合

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/production_store_verification_candidates.sql"
```

読み取りSQL：チェックイン／完了会計／使用済み券を現在の会員IDに結び、自己申告has_visited_beforeを使わずcountとmd5を返す。

次へ：candidate_customers=32、candidate_fingerprint=82c2e35ad55d2e36c2256e6b3d11e42e。会員全体は2026-10-25夜の読み取りで71人だが、固定するのは承認済み対象の人数とcustomer_id:user_idの集合。対象が変われば、新しい名簿を店側が確認するまで停止する。10/19の「30人全員でOK」に加え、10/25夜の名簿（元の30人から外れた人0、追加は10/23来店の2人）で慶一郎さんが「2人ともOK」と承認済み。

### 14-C. 未承認の人だけ一括登録

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/production_seed_store_verifications.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_bulk.sql"
```

SQL：check_bulk.sqlはcustomer_store_verificationsとcustomersを結合して承認数・対象集合の照合値・一括ラベル件数、権限、既存dataを返す。

次へ：NOTICE store records bulk verification ok、reviewed_candidates=verified_candidates=32。verification.approvals.approved=32と上記照合値が一致する。新規分verified_byは「一括（店の記録あり）」、既存承認者・日時は保持する。履歴は33件のまま、既存data・設定も同じ。1つでも違えば停止。ここでは15番を履歴へ追加しない。

### 15. customer_store_access

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/15_20261018040349_customer_store_access.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_15.sql"
```

読み取りSQL：check_15.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=40、履歴照合値=258e2888afd9dc45dad508675c813770（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。この工程で未承認客の予約が制限される。承認32人の事前登録がなければ適用SQL自体が停止する。違えば停止する。

### 16. waitlist

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/16_20261019000000_waitlist.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_16.sql"
```

読み取りSQL：check_16.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=41、履歴照合値=d42c439713c84c7c7eb6085f26ae7dff（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 17. menu_price_rules

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/17_20261019000100_menu_price_rules.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_17.sql"
```

読み取りSQL：check_17.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=42、履歴照合値=53994c3ce3606dfc37b6374a84980bf3（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 18. checkout_safety

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/18_20261019000200_checkout_safety.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_18.sql"
```

読み取りSQL：check_18.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=43、履歴照合値=c700d99fe6757dbba3ed548c869ae3b2（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 19. finalize_sale_ticket_alias

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/19_20261019000300_finalize_sale_ticket_alias.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_19.sql"
```

読み取りSQL：check_19.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=44、履歴照合値=89416b1789ddb321909a551e78189a9a（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 20. app_private_helper_grants

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/20_20261019000400_app_private_helper_grants.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_20.sql"
```

読み取りSQL：check_20.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'\n' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=45、履歴照合値=ed50692b1c87a4ce932dd51668d35720（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 21. ai_booking_penalty（AI 予約の当日キャンセル防止）

2時間前を切ったアプリのキャンセル・無断キャンセルで、そのお客様の AI の新規予約を30日止める（店の電話・SB の予約は止めない）。15・16（来店確認・予約の流れ）の後でないと入らない。

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/21_20261023000000_ai_booking_penalty.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_21.sql"
```

読み取りSQL：check_21.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'
' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=46、履歴照合値=beec3b4503fa77ac30d0bb7a90d3e2e6（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

### 22. ginpay_hold（銀Pay の仮支払い）

お客様が AI 予約の確定と同時に銀Pay の残高を押さえる（台帳は動かさない）。支払いの確定は今までどおりレジの会計（会員QR → GINPay → 確定）。予約がキャンセル・無断キャンセルになると押さえは消える。表 app_private.ginpay_holds と customer_ginpay_hold / customer_ginpay_release / customer_ginpay_holds / staff_ginpay_hold を足すだけで、既存の表・関数は変えない。21（予約まわり）の後に入れる。

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/22_20261024000100_ginpay_hold.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_22.sql"
```

読み取りSQL：check_22.sql（BEGIN READ ONLY）。以下の履歴SQLに加えて9表のdata・予約設定・全履歴を返す。

```sql
select count(*) as history_count, md5(coalesce(string_agg(version||':'||coalesce(name,''), E'
' order by version),'')) as history_key from supabase_migrations.schema_migrations;
```

次へ：エラーなし、verification.history_count=47、履歴照合値=1ef4fc16d6e82e5696efff002adc7fdb（SQL内で自動照合）、dataとapp_booking_enabledは0-2と同じ。違えば停止する。

## 最後の読み取り確認

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_final.sql"
```

次へ：履歴47件（公開前の26件＋新規21件、03は復元のみ）、既存data・予約設定不変、13表の書き込み閉鎖と旧RPC閉鎖を維持、承認32人・照合値一致、ginpay_consistent="true"。

## 最後の読み取り確認のあと：メンテナンスカットを予約メニューに足す（データ1行）

Johnny でメンテナンスカット（30分・3,000円・銀二郎／テイテイ）を予約できるようにする。表の形は変えず、service_menus に code=maintenance の行と担当2人を足すだけ（22工程でできる列を使うので、必ず22工程と最後の読み取り確認の後）。14日以内のお客様だけに出すのはアプリと johnny-agent 側。履歴・9表のdataは変わらない。

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output table --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_maintenance_menu.sql"
```

次へ：最後の表が maintenance／メンテナンスカット／30／3000／true／true／true／テイテイ・銀二郎 の1行。エラー（銀二郎・テイテイ が見つかりません など）なら何も書き込まれていないので停止して相談。

**ここで先行DB作業を止める。** [⑤の手順](production-platform-commands.md)に従い5関数のデプロイと設定、停止状態のキャンセル待ちcron、レビュー済みrelease PRの公開、実機確認へ進む。johnny-agentの新しい来店確認ガードはDB15番より前に本番へ出さない。当日の順番と中断時の扱いは[⑥の時刻表](release-day-timetable.md)を参照。新しい画面と引継ぎが確認できたら次の閉鎖Bへ進み、閉鎖B後の再確認を終えるまで営業を再開しない。

## 新しいWebを公開・確認した後：セキュリティ閉鎖B

既存ファイル20261001000400_security_hardening_b_lockdown.sqlを、47件→48件の履歴照合と記録付きで包んだもの。先行22工程に混ぜない。旧い画面・セッションなしの直接読み取りを使う人は、会員証QRをスタッフに見せて同じ会員情報を引き継ぐ案内に変わる。新規登録し直させない。会員・券・残高は削除しない。

慶一郎さんが新しい画面で「店舗確認→Face ID設定→同じ会員ID・券でログイン」を確認し、店舗操作を止めていることが前提。まだなら停止する。

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/post_web_security_lockdown.sql"
```

読み取り確認：
```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/supabase/rollout/out_release/check_post_web_lockdown.sql"
```

新Webの実機確認後、B直前にcheck_final.sqlを再取得し、そのdataをB前後の比較基準にする。DB22完了時からの差分は記録した実機操作に由来するものだけか確認し、不明な差分なら停止。③の01〜22は開始時との不変比較を維持する。承認32人の集合は増減しない。

次へ：preflight_securityのDO検査にエラーがなく、履歴48件、data・予約設定・承認32人の照合値が閉鎖B直前と同じ。会員表・券・会計などの直接アクセスを閉じ、商品の公開読み取りは店販・販売中・表示用の列に制限される。

閉鎖BのSQL・履歴の記録・読み取り確認もコピーでrollback試験済み。16私有表にanon/authenticatedの表・列権限がないこと、商品の最低在庫列は読めず公開表示列は読めること、承認32人の予約オプション取得を確認した。セキュリティ・来店確認・パスキー・会計・GINPayの5検査も閉鎖Bを含めて成功。実行後はアプリ・店舗端末・本部・SBの実機を再確認し、失敗時は営業再開を止める。読み取り権限を無条件に開き直さない。

## リハーサルの再実行方法（本番には接続しない）

最新バックアップをローカルPostgreSQL 17の使い捨てDBへ復元し、履歴26件の開始状態を確認してから実行する。復元先は127.0.0.1:55433、DB名はrelease_rehearsal_で始める。Supabase専用拡張や管理スキーマの扱いを記録し、実本番に復元しない。古いバックアップには後から適用済みのschemaと履歴を補ったことを記録する。

```powershell
node "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/rehearse-production-release.mjs" "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport" "postgresql://postgres@127.0.0.1:55433/release_rehearsal_YYYYMMDD"
```

このスクリプトは外部URL、別ポート、任意のDB名、接続URLのqueryを拒否する。01〜14→権限閉鎖→対象の読み取り→一括承認→15〜22→最終確認の順（メンテナンスカットのメニュー追加 production_maintenance_menu.sql は自動では流さない。最終確認の後に人が実行する）。閉鎖Bは自動実行しない。1本でも失敗すれば終了し、次へ進まない。各工程の既存dataの照合値と予約設定を検査する。ログは終了状態・SQLSTATEだけで、標準出力・エラー本文は保存しない。会員名・認証情報・バックアップの内容をGit・PR・ログへ出さない。練習後は専用DB・抽出SQL・データファイルのコピーを削除し、日時フォルダーのバックアップ本体は残す。

参考：[Supabase公式のバックアップと復元](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)、[PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)。
