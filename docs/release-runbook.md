# 本番リリース手順と引き継ぎ（2026-10-19 Claude → Codex）

Claude は週の利用制限が近いため、ここから先は Codex が引き継ぐ。
**正本は staging ブランチ**。main へ直接 push しない。staging → main は両者（または Codex と慶一郎さん）が「問題なし」を出してから。

## 0. いまの状態（10/19 時点）

**本番公開は保留**。この手順の実行前に [Codexの最終確認と残作業](release-readiness.md) を確認する。Face ID・来店確認の準備コードとフラグ設定は [本番対応の手順](customer-access-production.md) を参照する。設定はまだ変更していない。

- staging ブランチ：Claude 分はすべてコミット済み（キャンセル待ち・料金の正本化・本部 JOHNNY・SB・Lint の片づけ）。
- Staging の DB：migration 44本すべて適用済み。毎分のキャンセル待ち（cron `johnny-waitlist-minutely`）稼働中。
- 本番の DB：20261002〜20261018000300 の一部だけ。**未適用 20本**（下の 1.）。
- 本番の関数：johnny-agent / johnny-notify / hq-johnny は**キャンセル待ち版を未デプロイ**（Staging だけ）。
- 手元リハーサル（10/19 実施・成功）：本番バックアップ(10/17) → 今の本番と同じに揃え → 20本を順に当てた。
  20本ともエラーなし、記録 37件、customers 53・tickets 127 は変わらず。
  再実行：`bash <scratchpad>/rehearse_release.sh`（ローカル PG17 port 55432、DB `bk` がバックアップ）。

## 1. 本番 DB に入れる（1本ずつ・結果を見てから次へ）

順番は supabase/rollout/release_prod_order.txt。**人が実行するコマンドの正本は[本番DBコマンド一覧](production-db-commands.md)**。現在③は[リハーサル記録](production-db-rehearsal.md)のとおり一括承認の手前で停止しており、本番実行を保留する。

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

## 2. 本番のキャンセル待ちの毎分ジョブ（DB のあと）

秘密の値はファイルに書かない。今ある `johnny-notify-daily` の中身を写して作る（`!` で渡す）：

```sql
do $$
declare c text;
begin
  select command into c from cron.job where jobname = 'johnny-notify-daily';
  if c is null then raise exception 'no daily job'; end if;
  c := regexp_replace(c, 'body\s*:=\s*''[^'']*''::jsonb', 'body := ''{"waitlist":true}''::jsonb');
  if position('waitlist' in c) = 0 then raise exception 'body not replaced'; end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'johnny-waitlist-minutely';
  perform cron.schedule('johnny-waitlist-minutely', '* * * * *', c);
end $$;
```

**必ず 3. の johnny-notify デプロイを先に**（古い johnny-notify は waitlist を知らない）。

## 3. 本番の関数をデプロイ（DB のあと）

```
npx -y supabase@2.121.0 functions deploy johnny-notify --use-api --project-ref ufyzynpmkxytnhebombq
npx -y supabase@2.121.0 functions deploy johnny-agent  --use-api --project-ref ufyzynpmkxytnhebombq
npx -y supabase@2.121.0 functions deploy hq-johnny     --use-api --project-ref ufyzynpmkxytnhebombq
```
Codex 担当の関数（customer-passkeys など）も、staging と本番の版を比べて必要なら同様に。

## 4. 画面（staging → main）

1. `git fetch && git checkout -b release origin/main && git merge origin/staging`
2. `docs/accounting-production-rollout.md` の 3. にある「Staging だけに出している所」の条件を外す
   （StaffHome のメニュー、AdminScreen の「お会計に進む」、hqMockData の hqTabEnabled、HqClientsScreen の銀Pay）。
3. `npx tsc -b && npx vite build && node scripts/staging-preflight.mjs --skip-build`
4. Vercel の無料枠は1日のデプロイ回数に上限あり。まとめて1回で出す。
5. 本番で確認：アプリ（iPhone・Android）／店舗端末（スマホ）／本部（PC・スマホ）／SB（タブレット・PC・スマホ）。

## 5. 残っている作業

- Codex：自分の Lint 差分（`Desktop/otokomae-passport/.qa/react-lint-cleanup/changes.patch`）を staging に反映・検証・コミット。
  残りの Lint：App.tsx, AdminScreen, TicketWalletScreen, HomeScreen, MyPageScreen, TryOnScreen, FreshnessWidget,
  customer-passkeys/bridge.ts。SbScreen.tsx:82 は warning だけ（ref の cleanup）で急がない。
- 本部「予約設定」の「JOHNNY のお知らせ」→「送信を始める」は慶一郎さんが押す（押すまで空き枠のお知らせは出ない）。
- 祝日 `app_private.holidays` は毎年足す（料金の会員時間に使う）。

## 6. 守ること

- 秘密（notify secret・bridge secret・VAPID の秘密鍵）はコミットしない。`Desktop/otokomae-backups/private` にある。
- `supabase db push` は使わない。適用済みの履歴を壊す書き換えをしない。
- デスクトップ JOHNNY を Cloudflare tunnel で出すときは JOHNNY_ACCESS_TOKEN を有効のまま。
- 慶一郎さんへの報告は日本語・やさしい言葉で。
