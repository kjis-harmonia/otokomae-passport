# 会計（銀Pay・レジ）を本番に入れる手順

Staging で動いている会計（店舗端末のお会計・銀Pay チャージと支払い・本部の会計）を本番に入れる。
**DB を先、画面をあと**。DB だけ入っても今の本番の画面は何も変わらない（会計の画面は Staging だけに出しているため）。

## 0. 入れるもの（9本・順番どおり）

`supabase/rollout/accounting_prod_order.txt` の順。`bash supabase/rollout/build_accounting_rollout.sh` で
`supabase/rollout/out_accounting/` に、1本ずつ `begin; … commit;` で包んだ SQL ができる（途中で失敗したらその1本は何も入らない）。

| # | ファイル | 中身 |
|---|---|---|
| 01 | ginpay_ledger | 銀Pay の口座と台帳（取引は書き換え不可・取消は逆向きの取引） |
| 02 | checkout | 会計（確定は1トランザクション・二重タップでも1件） |
| 03 | service_master#checkout_catalog_json | 02 が古い版で上書きする関数を、本番にある新しい版に戻す（記録は増やさない） |
| 04 | client_visit_model | 顧客台帳の来店の数え方（会計を含める） |
| 05 | ginpay_charge_bonus | 段階式のチャージ特典と、現金分・特典分の記録 |
| 06 | ginpay_member_lookup | 会員 QR から顧客を引く |
| 07 | member_checkout | 会員 QR → 今日の予約から会計 |
| 08 | checkout_ticket_mix | 割引券・漢トク券の併用を会計でも可（店の決定 10/17） |
| 09 | sales_day_breakdown | 本部の会計に支払方法ごと・銀Pay の内訳・レジの現金 |

入れないもの：security_hardening_b（別手順 `docs/security-hardening.md`）、POS ブランチ（antigravity/pos-p0-5）の pos_* と ginpay_reconcile_guard（Staging にも入っていない）。

## 1. 手元のリハーサル（2026-10-18 実施済み）

本番バックアップ `Desktop/otokomae-backups/20261017-1209` を手元の PostgreSQL 17 に戻し、10/17 に本番へ当てた4本
（`supabase/rollout/prod_20261017_*.sql`）を当てて今の本番と同じにしてから、上の9本を順に当てた。

- 9本ともエラーなし。
- 当てたあとの関数を Staging と比べた：両方にある 274 本のうち 264 本が同じ。会計・銀Pay の関数はすべて同じ。
  違う10本は予約・SB の関数（Staging に先に入っている別の作業の分）で、会計とは関係ない。
- 通しの確認（最後に rollback）：チャージ 10,000 → 残高 11,000（特典 1,000）／銀Pay で 9,000 の会計（特典から 818 を按分）
  ／同じキーの再送は同じ会計／本部の日別（銀Pay 9,000・チャージの現金 10,000・レジの現金 10,000）／取消で残高 11,000 に戻る
  ／照合 consistent=true。

## 2. 本番の DB（1本ずつ・PC で）

1. バックアップ：`bash supabase/rollout/backup_prod.sh`（pos-p0-5 にある。読み取りのみ）
2. 01〜09 を1本ずつ。毎回、結果を見てから次へ：
   ```
   ! cd ~/.claude/worktrees/sb-staging && npx -y supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq -f "supabase/rollout/out_accounting/01_20261004000000_ginpay_ledger.sql"
   ```
3. 確認（読み取りのみ）：
   ```sql
   select version from supabase_migrations.schema_migrations where version >= '20261004' order by 1;
   select (app_private.ginpay_reconcile_json())->>'consistent';   -- true
   select count(*) from public.accounting_sessions;              -- 当てる前と同じ（23件）
   ```

途中で止まったら：その1本は何も入っていない（トランザクション）。原因を直してその1本からやり直す。
全部やめたいとき：DB は「足すだけ」の変更なので、画面を切り替えなければお店の動きは変わらない。戻す必要があるときはバックアップから。

## 3. 本番の画面（DB のあと）

Staging だけに出している所を本番でも出す。main に Staging の会計の画面を取り込み、次の条件を外す：

- `src/screens/StaffHome.tsx`：メニューの「銀Pay チャージ」「予約」「顧客」（main では外してある）
- `src/screens/AdminScreen.tsx`：チェックイン後の「お会計に進む」（`isStaging()`）
- `src/hq/hqMockData.ts`：本部の会計・銀Pay のタブ（`hqTabEnabled`）
- `src/hq/screens/HqClientsScreen.tsx`：顧客台帳の銀Pay（`isStaging()`）

## 4. 入れたあと

- 税の扱い（`accounting_settings`）は未設定のまま（推測しない）。本部で決めて設定する。
- 最初の1日は、本部の会計の「レジに入った現金」とレジの現金を突き合わせる。
