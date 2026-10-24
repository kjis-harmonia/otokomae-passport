# 本番リリース手順と引き継ぎ（2026-10-19 Claude → Codex）

Claude は週の利用制限が近いため、ここから先は Codex が引き継ぐ。
**正本は staging ブランチ**。main へ直接 push しない。staging → main は両者（または Codex と慶一郎さん）が「問題なし」を出してから。

## 0. いまの状態（10/19 時点の引き継ぎ。10/20の更新は下記）

**本番公開は保留**。この手順の実行前に [Codexの最終確認と残作業](release-readiness.md) を確認する。Face ID・来店確認の準備コードとフラグ設定は [本番対応の手順](customer-access-production.md) を参照する。設定はまだ変更していない。

2026-10-23更新（Claude 監査）：本番には SB のお知らせ（20261023000100〜0500：AI 予約・キャンセルを全端末へ、サロンボードに入れました、最終警告、送り手が止まったときの帯）と 10/24 の SB のクローズ（20261024000000）を先行適用済みで、本番の履歴は26件。公開は21工程（21＝ai_booking_penalty・AI 予約の当日キャンセル防止）、履歴26→46、閉鎖Bで47。本番バックアップ(10/20)に今日の5本を当てた写しで、21工程＋権限閉鎖＋30人承認＋閉鎖Bまで通しで成功し、閉鎖B後も SB のお知らせ・キャンセル通知が動くことを確認。毎分の `sb-staff-push-minutely`（{"staff":true}）は本番で稼働中。キャンセル待ちの毎分ジョブを開始した後も残してよい（同じ予約を二重には送らない）。

2026-10-20更新：最新バックアップのコピーで20工程＋権限閉鎖＋30人の承認が成功。追加の閉鎖Bを含めたrollback検査も成功。練習用DBは削除し、バックアップを保持。本番・Stagingへは未適用。詳細は[検証記録](production-db-rehearsal.md)。

- staging ブランチ：Claude 分はすべてコミット済み（キャンセル待ち・料金の正本化・本部 JOHNNY・SB・Lint の片づけ）。
- Staging の DB：migration 44本すべて適用済み。毎分のキャンセル待ち（cron `johnny-waitlist-minutely`）稼働中。
- 本番の DB：20261002〜20261018000300 の一部だけ。**未適用 20本**（下の 1.）。
- 本番の関数：johnny-agent / johnny-notify / hq-johnny は**キャンセル待ち版を未デプロイ**（Staging だけ）。
- 手元リハーサル（10/19 実施・成功）：本番バックアップ(10/17) → 今の本番と同じに揃え → 20本を順に当てた。
  20本ともエラーなし、記録 37件、customers 53・tickets 127 は変わらず。
  再実行：`bash <scratchpad>/rehearse_release.sh`（ローカル PG17 port 55432、DB `bk` がバックアップ）。

## 1. 本番 DB に入れる（1本ずつ・結果を見てから次へ）

順番は supabase/rollout/release_prod_order.txt。**人が実行するコマンドの正本は[本番DBコマンド一覧](production-db-commands.md)**。③は[最新コピーの記録](production-db-rehearsal.md)のとおり20工程と30人の一括承認まで成功。ただし閉鎖Bが公開計画から抜けていたため、本番公開は保留する。新しいWebの確認後に閉鎖Bを適用する工程もコマンド一覧へ追加した。

最新バックアップ→履歴と既存データの読み取り→01〜14→権限閉鎖→承認対象再照合→一括承認→15〜20の順。新しい scripts/prepare-production-db-release.mjs で、前後の履歴照合付きSQLと各工程の読み取り確認を生成する。旧いbash生成器の出力で上書きしない。各工程は1トランザクション、1本でも失敗したら停止する。本番へ書き込むのは休業中に慶一郎さんが1ブロックずつ実行する ! コマンドだけ。

| # | 中身 | 担当 |
|---|---|---|
| 01–04 | 会計の土台（銀Pay台帳・会計・カタログ関数の戻し・来店の数え方） | 会計 |
| 05–07 | チケット発行の二重防止・予約の流れの統一 | Codex |
| 08 | customer_shortcuts | Codex |
| 09–10 | 銀Pay チャージ特典・会員QRで顧客を引く | 会計 |
| 11 | customer_passkeys | Codex |
| 12–14 | 会員会計・券の併用・本部の日別内訳 | 会計 |
| 15 | customer_store_access（来店確認がないと予約できない） | Codex |
| 16 | waitlist（キャンセル待ち） | Claude |
| 17 | menu_price_rules（料金の正本：通常/会員・平日終日/土日祝17-19時） | Claude |
| 18 | checkout_safety | Codex |
| 19 | finalize_sale の ticket 別名修正 | Claude |
| 20 | app_private ヘルパー関数の PUBLIC 実行権を外す（セキュリティ） | Claude |

注意：**15 を入れた瞬間から、来店確認の済んでいないお客様はアプリで予約できなくなる**。
慶一郎さんは、店の記録がある既存客30人の名簿を確認し「30人全員でOK」と承認済み。14番のあと、15番の前に **旧記録表の書き込み権限閉鎖 → 対象集合の再確認 → 30人のうち未承認の人だけ登録** を挟む。具体的なSQLと停止条件は [一括承認の手順](sql/production_store_verification_backfill.md) を参照する。自己申告の来店歴は使わず、対象の人数・会員IDが変わっていれば止める。

確認（読み取りのみ）：
```sql
select version from supabase_migrations.schema_migrations where version >= '20261004' order by 1;  -- 03は関数復元のみで履歴を増やさない。他19工程が未適用なら19件増加
select (app_private.ginpay_reconcile_json())->>'consistent';  -- true
select count(*) from public.customers;                        -- 当てる前と同じ
```

## 2〜3. 環境変数・関数・cron（⑤が正本）

[人が1本ずつ貼る⑤のコマンド一覧](production-platform-commands.md)を使う。旧い「既存ジョブを消して即開始するSQL」は使わない。

DB01〜22の成功（15番の来店確認を含む）→ソース・Secrets・Vercel本番対象を確認→johnny-notify→johnny-agent→hq-johnny→customer-passkeys→johnny-style-adviceを1本ずつ確認→両フラグON→毎分ジョブを停止状態で作成、の順。新Web・閉鎖B・古いアプリの実機確認のあとで、人が毎分ジョブを開始する。

本部の「お知らせOFF」はキャンセル待ちの毎分処理を止めない。⑤の準備SQLはactive=falseでcommitし、公開前の仮押さえ・送信を防ぐ。「送信を始める」を自動でONにする工程はない。

公開前にテイテイさんたちのStaging練習（会員QR→チェックイン→会計→券選択→確定）も完了させる。本番スタッフには券の単独使用ボタンがなくなることを共有する。

## 4. 画面（公開用release → main）

④ではmain起点のrelease/20261020へStagingとPR #10の手順を統合した。[公開用PRの準備](production-release-pr.md)を正本にする。以下の1〜2の準備はreleaseブランチで実施済みで、公開自体はまだ行わない。

1. 準備済みのrelease/20261020とrelease→mainのドラフトPRをレビューする。Stagingから作り直して④の変更を落とさない。
2. 会計・GINPayの表示、券の消費を会計確定へ統一、本番ビルドのFace IDフラグONを確認。StaffHomeの3メニューは既に条件なし。
3. ④で57テスト・型チェック・ビルド・Lintと、架空データDBを明示した44本のpreflightが成功。再検査する場合もローカル専用DBを明示する。本番DB・関数・フラグの実作業完了と実機確認を待つ。
4. Vercel の無料枠は1日のデプロイ回数に上限あり。まとめて1回で出す。
5. 本番で確認：アプリ（iPhone・Android）／店舗端末（スマホ）／本部（PC・スマホ）／SB（タブレット・PC・スマホ）。
6. 新しい画面と実機での会員引継ぎが確認できたら、[DBコマンド一覧](production-db-commands.md)末尾の閉鎖Bを人が実行・読み取り確認する。履歴47→48。直後に古いアプリのお客様の見え方と店頭引継ぎも確認する。全画面を再確認し、閉鎖B完了前に営業を再開しない。

## 5. 残っている作業

- CodexのLint差分はPR #7／#8を経て取り込み済み。④でもエラー0を確認。既存SbScreenのref cleanup警告1は残る。
- 本部「予約設定」の「JOHNNY のお知らせ」→「送信を始める」は慶一郎さんが押す（押すまで空き枠のお知らせは出ない）。
- 祝日 `app_private.holidays` は毎年足す（料金の会員時間に使う）。

## ⑥ 当日のタイムテーブル

[休業中の時刻表](release-day-timetable.md)に、09:00開始の仮例・工程ごとの確認/復旧限界・閉鎖B直後の旧PWA確認をまとめた。各関数デプロイは、最新release/cleanの確認に成功した直後だけ動く⑤のラッパーを使う。日付や公開を予約したものではない。⑦と実機・スタッフ練習が未完了なら開始しない。

## 6. 守ること

- 秘密（notify secret・bridge secret・VAPID の秘密鍵）はコミットしない。`Desktop/otokomae-backups/private` にある。
- `supabase db push` は使わない。適用済みの履歴を壊す書き換えをしない。
- デスクトップ JOHNNY を Cloudflare tunnel で出すときは JOHNNY_ACCESS_TOKEN を有効のまま。
- 慶一郎さんへの報告は日本語・やさしい言葉で。
