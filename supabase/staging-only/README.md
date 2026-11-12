# supabase/staging-only

ここの SQL は **Staging（kfufxzmucjljjouzpumi）だけ** に流すもの。本番（ufyzynpmkxytnhebombq）には絶対に流さない。
`supabase/migrations` に置かないのは、本番の `db push` などで間違って入らないようにするため。

| ファイル | 内容 |
| --- | --- |
| `20261112_ginoku.sql` | 銀二郎オークション【銀オク】のテーブル・関数・1分ごとの精算（pg_cron） |
| `20261112_ginoku_fix1.sql` / `_fix1_off.sql` | 取消・返金の止め、精算を1件ずつ受け止める、平日のみの券は土日祝の予約に付けない |
| `20261112_ginoku_label.sql` / `_label_off.sql` | 利用履歴で銀オクの引き落としを「オークション」と出す |
| `20261112_ginoku_free_and_hold.sql` / `_free_and_hold_off.sql` | 本物の無料券（そのメニューのお会計だけ・その日の料金を引く）と、入札額の押さえ（最高額のあいだ銀Payを押さえる・抜かれたら戻す・落札で引き落としに変える） |
| `20261112_ginoku_seed.sql` | 見本の出品4つ（銀パラ・APACHI・パンチパーマの無料券、500円引き券）。`_free_and_hold.sql` のあとに流す |
| `20261112_ginoku_off.sql` | 銀オクを外す（台帳と発行済みの券は残す）。先に `_free_and_hold_off.sql` を流す |

```sh
npx.cmd supabase db query --remote=kfufxzmucjljjouzpumi --yes -f supabase/staging-only/20261112_ginoku.sql
```

流す順：`20261112_ginoku.sql` → `_fix1.sql` → `_label.sql` → `_free_and_hold.sql` → `_seed.sql`

## 本番にもある関数を Staging だけ置き換えているもの

本番に銀オクを入れるときは、下の関数も一緒に（本番の今の定義と見比べてから）入れること。中身は Staging の定義に銀オクの分を足しただけ。

| 関数 | 置き換えたファイル | 足したこと |
| --- | --- | --- |
| `public.customer_set_ticket_plan` | `_fix1.sql` → `_free_and_hold.sql` | 平日のみの券は土日祝の予約に付けない／無料券はそのメニューの予約だけ |
| `app_private.ginpay_customer_ledger_json` | `_label.sql` | 銀オクの引き落としに `kind: 'auction'` |
| `app_private.ginpay_held_sum` | `_free_and_hold.sql` | 押さえの合計に、銀オクの入札の押さえ（開催中だけ）を足す |
| `app_private.ginpay_hold_summary` | `_free_and_hold.sql` | `auction_holds`（銀オクの押さえの一覧）。`held` は両方の合計 |
| `app_private.finalize_sale` | `_free_and_hold.sql` | 無料券（そのメニューの明細1つ分を DB が計算）／銀オクの平日のみの券は土日祝のお会計で `ginoku_weekday` |
| `app_private.client_tickets_json` | `_free_and_hold.sql` | `free_menu`・`menu_codes`、土日祝は `blocked: 'ginoku_weekday'` |
| `app_private.ticket_json` | `_free_and_hold.sql` | 無料券なら `free_menu`・`menu_codes` |

トリガー：`public.ginpay_transactions` の `ginoku_block_reverse`（`_fix1.sql`）、`app_private.ginoku_auctions` の `ginoku_release_on_close`（`_free_and_hold.sql`）。

- `20261112_ginoku_fix2.sql`（2回目の粗探しの直し）：額とメニューが決まった景品は出品できない（`menu_discount_not_supported`）／店の会計の情報 `app_private.checkout_context_json` に `auction_held`（銀オクの入札で押さえている額）を足す。戻すときは `_fix2_off.sql`
- `20261113_ginoku_change.sql`：予約を変えたとき、銀オクの平日のみの券（土日・祝日へ）と無料券（対象のメニューが無い予約へ）を外す。`app_private.change_effects` を Staging で置き換え。戻すときは `_change_off.sql`
