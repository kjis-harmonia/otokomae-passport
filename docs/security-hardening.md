# セキュリティ監査対応 設計書（2026-10-02 改訂：最小構成）

対象：監査指摘 1（allow_all 廃止・PIN/パスコード除去）→ 2（保存失敗を成功扱いにしない・一括発行）→ 3（メンテナンスクーポンの使い捨て化・14日再検証）
＋ 追加指摘：お客様用 RPC が `p_user_id` をそのまま本人として信用していた問題、PIN/SHOP ロックが全員共通だった問題。
＋ 最小構成化：**現在の画面から到達できる機能の RPC だけを残す**。廃止機能（LIVE STATUS・営業状態・会計アシスト・発行ログ・会員数）の RPC とアプリ内コードは削除し、テーブルは外部から完全非公開。将来必要になれば Git 履歴から復活させる。

## 決定事項

| 項目 | 決定 |
|---|---|
| スタッフ認証 | PIN 入力画面・担当者の名前選択は現状のまま。**PIN は6桁**。照合はサーバー側（`staff_login`）。認証後14時間有効のスタッフセッション |
| お客様の本人確認 | **顧客セッショントークン方式**。お客様用 RPC は `p_session` を受け取り、user_id はサーバーがトークンから特定する。**`p_user_id` を本人確認に使う RPC は無い** |
| 新規会員 | `customer_register` が **user_id をサーバー側で採番**し、顧客セッションを同時に発行（クライアントは user_id を選べない） |
| 既存会員の移行 | **店頭の紐付けコードのみ**（6桁・10分有効・1回限り・5回失敗で無効）。user_id だけによる自動紐付けは採用しない |
| 端末変更 | スタッフの復旧操作で、新端末の仮会員行を統合。旧会員に Welcome が一度でも発行されていれば（使用済み含む）新端末側の Welcome を無効化 |
| PIN ロック | 登録済み端末キー（端末ごとに判定）＋未登録端末全体のレート制限。IP 単位ロックは不採用（下記） |
| 本部画面 | **本部専用6桁PIN＋本部セッション（14時間）**。店舗スタッフ PIN・セッションとは完全に分離。カルテ・売上履歴・日報・カルテメモ・在庫はすべて本部セッション必須の RPC 経由（テーブル直接アクセスは不可） |
| 廃止機能 | LIVE STATUS・営業状態（本部ダッシュボードの表示も削除）・会計アシスト（会計確定・会計メニュー）・店舗端末の発行ログ／会員数。RPC は作らず、テーブルは外部から読み書き不可 |
| メンテナンスカット | 銀二郎Only ¥3,000 → ¥2,500。5分有効・使い捨てQR＋確定時にサーバーで14日再検証 |
| 適用方式 | Postgres RPC（SECURITY DEFINER）のみ。SQL Editor で適用可能、CLI 不要 |

### 確認結果（採用しなかったもの）

- **既存会員の自動移行に使える端末固有の秘密は無い**：端末にあるのは user_id（会員QRに含まれ第三者も知り得る）と `ginjiro_member_issued_at`（DB に保存されておらず照合不可）のみ。よって既存会員は紐付けコード方式のみ。
- **信頼できる接続元IPは未確認**：確認には本番 Supabase にヘッダー確認用の関数を作る必要があり、本番未適用の方針のため見送り。IP 単位ロックは採用せず、端末キー＋レート制限で構成した。

## 仕組み

```
お客様（新規）   customer_register(名前, 来店歴) ─→ user_id 採番 + 顧客セッション発行（＋「いいえ」なら Welcome 1枚）
お客様（既存）   店頭：スタッフが staff_issue_bind_code → 6桁コード
                 端末：customer_bind_with_code(user_id, コード) ─→ 顧客セッション発行（旧セッションは全失効）
お客様（以後）   customer_*(p_session, …) ─→ サーバーがセッションから user_id を特定
店舗端末         staff_login(PIN, 端末キー) ─→ スタッフセッション（14時間）＋（初回）端末キー
                 staff_*(p_staff, …) ─→ サーバーがスタッフセッションを検証
本部画面         hq_login(本部PIN, 本部端末キー) ─→ 本部セッション（14時間）＋（初回）本部端末キー
                 hq_*(p_hq, …) ─→ サーバーが本部セッションを検証（スタッフセッションでは通らない）
```

- セッション・端末キー・紐付けコードは **ハッシュのみ DB に保存**（`app_private` スキーマ。API からは見えない）。
- 顧客セッションは期限なし・失効可（再紐付け・端末変更で失効）。端末の localStorage に保存。
- 会員QR・チケット使用QR は従来どおり user_id を含むが、それを使うのは**スタッフ認証済みの店舗端末だけ**。user_id を知っていてもお客様用 RPC では何もできない。

## RPC 一覧

| 区分 | RPC | 内容 |
|---|---|---|
| 認証 | `staff_login(pin, device_key)` / `staff_session_valid` / `staff_logout` | PIN 照合・スタッフセッション・端末キー |
| 認証 | `verify_shop_passcode(passcode, session)` | SHOP パスコード照合（正誤のみ） |
| お客様 | `customer_register(name, has_visited_before)` | 新規登録（サーバー採番）＋セッション＋Welcome |
| お客様 | `customer_bind_with_code(user_id, code)` | 既存会員の紐付け（店頭コード必須） |
| お客様 | `customer_get_tickets` / `customer_get_last_visit` / `customer_get_profile`（復旧コード含む）/ `customer_get_today_usage` | 本人データの読み取り（`p_session`） |
| お客様 | `customer_create_transfer` / `customer_cancel_transfer` / `customer_claim_transfer` / `get_transfer_preview` | 譲渡（送る人・受け取る人ともセッション） |
| お客様 | `customer_issue_maintenance_coupon(session)` | クーポンQR用 5分トークン |
| 店舗 | `staff_issue_bind_code(user_id, staff_name)` | 既存会員の紐付けコード発行 |
| 店舗 | `staff_register_customer` / `staff_customer_context` / `staff_search_customers(p_staff, p_query)` | 会員QR読み取り・会員検索（復旧） |
| 店舗 | `staff_issue_tickets`（一括）/ `staff_use_tickets`（一括・Welcome平日のみ）/ `staff_check_in` | 発行・使用・来店登録 |
| 店舗 | `staff_preview_maintenance_coupon` / `staff_redeem_maintenance_coupon` | クーポン確認・確定 |
| 店舗 | `staff_recover_member` | 端末変更（仮会員行の統合・Welcome 重複無効化・旧セッション失効） |
| 店舗 | `staff_products_list` / `staff_product_create` / `staff_product_update` / `staff_product_delete`（論理削除）/ `staff_product_adjust` | 店舗端末の在庫管理 |
| 本部 | `hq_login(pin, device_key)` / `hq_session_valid` / `hq_logout` | 本部専用 PIN 照合・本部セッション・本部端末キー |
| 本部 | `hq_list_customers` / `hq_get_customer(user_id)` | 本部カルテの会員一覧・会員詳細（復旧コードは返さない） |
| 本部 | `hq_accounting_sessions(期間, 会員)` / `hq_accounting_session_items(ids)` | 売上履歴の読み取り（ダッシュボード・スタイリスト・カルテ）。**書き込み RPC は無い** |
| 本部 | `hq_daily_reports` / `hq_daily_report_source` / `hq_save_daily_report` | 日報の一覧・手動作成（同日は上書き） |
| 本部 | `hq_customer_notes` / `hq_create_customer_note` | カルテメモの読み取り・追加 |
| 本部 | `hq_products_list` / `hq_product_create` / `hq_product_update` / `hq_product_delete` / `hq_product_adjust` | 本部の在庫管理（店舗端末と同じ処理） |
| 管理者（SQL Editor のみ） | `app_private.set_secret`（staff_pin / hq_pin / shop_passcode）/ `app_private.revoke_staff_devices` / `app_private.revoke_hq_devices` | PIN・パスコード設定、端末キー全失効 |

**作らない RPC（機能廃止）**：`staff_set_live_status` / `staff_set_shop_status` / `staff_customer_stats` / `staff_recent_issue_logs` / `staff_hold_maintenance_coupon`（会計中確保。`held_at` 列も廃止し、クーポン再発行時は未使用トークンをすべて失効） / `staff_create_guest_customer` / `staff_daily_report_source` / `staff_save_daily_report` / `staff_accounting_items` / `staff_create_accounting_item` / `staff_update_accounting_item` / `staff_checkout`。

**廃止**：`get_my_*`（作成しない・存在すれば削除）。ステップB で `complete_customer_onboarding`・`claim_ticket_transfer`・`recover_member` の anon 実行権を削除（いずれも user_id をそのまま信用するため）。

## ロック（総当たり対策）

| 対象 | 条件 | 動作 |
|---|---|---|
| スタッフ PIN・登録済み端末 | その端末の失敗が10分で5回 | その端末だけ10分ロック |
| スタッフ PIN・未登録端末 | 未登録端末全体の失敗が10分で10回 | 未登録端末からのログインを一時停止（**登録済みの店舗端末は影響なし**） |
| 本部 PIN・登録済み本部端末 | その端末の失敗が10分で5回 | その端末だけ10分ロック |
| 本部 PIN・未登録端末 | 未登録全体の失敗が10分で10回 | 未登録端末からの本部ログインを一時停止（登録済み本部端末・店舗端末は影響なし） |
| SHOP パスコード・セッションあり | その端末の失敗が10分で5回 | その端末だけロック |
| SHOP パスコード・セッションなし | 全体で10分30回 | セッション無しからの照合を一時停止（会員は影響なし） |
| 新規登録 | 全体で10分100件 | 一時停止（Welcome 目的の大量登録対策） |

PIN は6桁（100万通り）。未登録端末は10分10回までのため、総当たりは現実的に不可能。

## テーブルのアクセス（ステップB適用後）

| テーブル | anon 直接アクセス |
|---|---|
| tickets / ticket_issue_logs / ticket_usage_logs / ticket_transfers / maintenance_visits / customer_user_aliases / customer_recovery_logs / maintenance_coupon_tokens | **不可**（RPC 経由のみ） |
| customers | **不可**（読み取りも禁止）。お客様本人は `customer_get_profile`（顧客セッション）、店舗端末は `staff_customer_context` / `staff_search_customers`（スタッフセッション）、本部カルテは `hq_list_customers` / `hq_get_customer`（本部セッション）のみ |
| live_statuses / shop_status / accounting_items | **不可**（機能廃止。RPC も無い） |
| accounting_sessions / accounting_session_items | **不可**。本部の売上履歴は `hq_accounting_sessions` / `hq_accounting_session_items` の読み取りのみ（書き込み経路なし） |
| daily_reports / customer_notes | **不可**。本部 RPC のみ（日報：一覧・手動作成／カルテメモ：読み取り・追加） |
| products | 書き込み不可。お客様 SHOP 用に **店販・販売中の行だけ**、表示に必要な列（id, name, category, is_active, current_stock, price, accounting_group, created_at, updated_at）のみ公開読み取り。在庫管理は店舗 `staff_product*`・本部 `hq_product*` |
| app_private.*（スタッフ・本部・顧客のセッション、紐付けコード、端末キー、PIN ハッシュ） | 不可（スキーマごと非公開） |

## アプリ側の変更

| ファイル | 変更 |
|---|---|
| `src/utils/customerSession.ts`（新規） | 顧客セッションの保存・`customer_*` 呼び出し・紐付けコード入力・移行期間の読み取り切替 |
| `src/utils/staffSession.ts`（新規） | スタッフセッション・端末キー・`staff_*` 呼び出し・エラー文言 |
| `src/components/PreviousTicketsBind.tsx`（新規） | 「以前のチケットを引き継ぐ」。常設表示はせず、Wallet では必要なときだけ小さなモーダル（引き継ぐ／あとで。あとでは7日間自動表示しない）、My画面にはセッションの無い端末だけ導線を表示。中身は従来どおり店頭の6桁コード → `customer_bind_with_code`。サーバーがステップA未適用なら非表示 |
| `src/hq/hqSession.ts`（新規） | 本部セッション・本部端末キー・`hq_*` 呼び出し（店舗スタッフとは別の保存キー） |
| `src/hq/HqPinGate.tsx`（新規）・`src/hq-main.tsx` | 本部画面の入口に本部専用6桁 PIN 画面。本部セッションがある間だけ本部画面を表示、切れたら PIN 画面へ |
| `src/hq/hqCustomerKarteStore.ts` | 会員一覧・会員詳細・会員の売上履歴をすべて本部 RPC 経由に変更 |
| `src/hq/hqDataStore.ts` / `screens/HqDashboardScreen.tsx` | 売上履歴を本部 RPC で取得（15秒ごとの再取得）。営業状態の表示を削除 |
| `src/hq/hqDailyReportStore.ts` / `hqCustomerNotesStore.ts` | 日報・カルテメモを本部 RPC 経由に |
| `src/hq/hqInventoryStore.ts` / `src/utils/dataAuthMode.ts`（新規） | 在庫：お客様は店販の公開読み取り、店舗端末は `staff_product*`、本部は `hq_product*`（画面ごとに認証モードを切替） |
| `src/screens/StaffPinGate.tsx` | PIN 6桁・サーバー照合・端末キー。ロック中・通信不可・未設定を表示 |
| `src/App.tsx` | SHOP パスコードをサーバー照合（セッション単位）。開発用リセットで顧客セッションも消去 |
| `src/utils/ticketStore.ts` | お客様：セッション経由（読み取り・譲渡・受け取り・登録）。店舗：`getTicketsForStaff`・一括発行・一括使用 |
| `src/utils/customerStore.ts` | お客様：セッション経由。店舗：`getCustomerContextForStaff`・`issueBindCode`・検索・復旧 |
| `src/screens/AdminScreen.tsx` | 会員QR読み取り後に「アプリ紐付けコードを発行」。会員情報の取得はすべてスタッフ認証経由。非表示だった LIVE STATUS・会計アシスト・発行ログ・会員数のコードと裏での読み取りを削除 |
| 削除 | `screens/AccountingAssistTab.tsx` / `utils/accountingStore.ts` / `components/LiveStatusSection.tsx` / `components/liveStatus*.css` / `data/liveStatus.ts` / `utils/liveStatusStore.ts` / `utils/shopStatusStore.ts`（いずれも画面から到達不能） |
| `src/screens/TicketWalletScreen.tsx` | 引き継ぎは必要時のみモーダル（未引き継ぎでもチケット一覧は通常表示）。クーポンQR は `customer_issue_maintenance_coupon` |
| `src/screens/MyPageScreen.tsx` / `HomeScreen.tsx` / `components/PassportCard.tsx` | お客様の読み取りをセッション経由に |

**移行期間の扱い**：ステップA 適用後〜ステップB 適用前は、セッション未取得の既存会員の「読み取り」だけ従来の直接読み取りで表示する（現状と同じ公開範囲）。書き込み（譲渡・クーポンQR 等）はセッション必須。ステップB 後は直接読み取りが RLS で失敗し、Wallet の「以前のチケットを引き継ぐ」案内（または My画面の導線）から、店頭の引き継ぎコードで引き継ぐ。

## 切替手順（A → 実機確認 → 速やかに B）

ステップB は既存会員全員の紐付け完了を待たずに実行する。B 後、未紐付けの既存会員は次回来店時に店頭の10分コードで順次紐付ける。

1. （適用済み）`20261001_welcome_coupon_onboarding.sql`
2. **catch-up**：`20261001_prod_schema_catchup.sql` を SQL Editor で実行（本番に無かった customer_notes テーブルと daily_reports.payment_summary 列を追加。冪等。**これを先に実行しないとステップA が失敗する**）
3. **ステップA**：`20261001_security_hardening_a_functions.sql` を SQL Editor で実行（追加のみ・今のアプリに影響なし）
4. PIN とパスコードを設定（値はファイルやチャットに残さず、その場で入力。旧値は公開済みのため**新しい値**にする）
   ```sql
   select app_private.set_secret('staff_pin', '＜6桁の数字＞');
   select app_private.set_secret('shop_passcode', '＜新パスコード＞');
   select app_private.set_secret('hq_pin', '＜本部専用の6桁（スタッフPINとは別の値）＞');
   ```
5. **新アプリを公開**
6. **実機確認**（すべて新アプリ・本番 Supabase で）
   - 新規登録（「いいえ」→ Welcome 発行 →「クーポンを見る」→ Wallet その他に表示 / 「はい」→ クーポンなし）
   - Wallet（CUT / Premium / その他の各タブ）
   - 店舗端末：6桁 PIN ログイン（端末キー登録）・会員QR 読み取り・来店チェックイン
   - 本部画面：本部専用6桁 PIN ログイン → ダッシュボード（売上）・顧客カルテ（一覧・詳細・メモ追加）・日報作成・在庫が動く（店舗スタッフ PIN では入れない）
   - 店舗端末の在庫管理・お客様アプリの SHOP（店販商品の表示）
   - 既存会員：店舗端末で紐付けコード発行 → お客様アプリで入力 → Wallet に既存チケット表示
   - メンテナンスQR（**前回来店日から14日以内のテスト会員**で実施。新規登録直後の会員では不可）：お客様側表示（5分・自動更新）→ 店舗端末で確定 → 再利用拒否
7. 問題なければ**速やかにステップB**：`20261001_security_hardening_b_lockdown.sql`
8. B 直後に下記「本番確認SQL」を実行し、旧経路が残っていないことを確認。あわせて、**既存会員で顧客セッション未紐付けの端末**で、Wallet を開くと「以前のチケットを引き継ぐ」の小さなモーダル（引き継ぐ／あとで）が出ること、My画面に同じ導線があることを確認（新規会員の端末には何も出ないこと）
9. 問題があれば `20261001_security_hardening_rollback.sql` で直接アクセスと旧 RPC を復元（旧アプリに戻す場合のみ）

## ステップA〜B 間に残る旧経路と、B 後の状態

A〜B の間は、旧アプリ・移行期間のために以下が開いたまま。**B でこれらはすべて外部（anon / authenticated）から使えなくなる**（PGlite で検証済み、下記）。

| 種別 | 経路 | A〜B 間 | B 後 |
|---|---|---|---|
| 旧RPC | `complete_customer_onboarding(p_user_id, …)`（user_id を信用・既存会員の名前上書き可） | 実行可 | 実行不可 |
| 旧RPC | `claim_ticket_transfer(p_token, p_to_user_id)`（受け取る人を user_id で指定） | 実行可 | 実行不可 |
| 旧RPC | `recover_member(old, new, …)`（スタッフ認証なし） | 実行可 | 実行不可 |
| 旧RPC（旧A案） | `get_my_*` / `issue_maintenance_coupon_token` / `create_ticket_transfer` / `cancel_ticket_transfer`（p_user_id 版） | A で削除（作られない） | 存在しない |
| 直接アクセス | tickets / ticket_issue_logs / maintenance_visits / ticket_transfers / ticket_usage_logs / customer_user_aliases / customer_recovery_logs / maintenance_coupon_tokens | allow_all（新表は RLS のみ） | RLS ＋ テーブル権限剥奪（読み書き不可） |
| 直接アクセス | customers | allow_all | 読み書きとも不可（RPC 経由のみ） |
| 直接アクセス | live_statuses / shop_status / accounting_items / accounting_sessions / accounting_session_items / daily_reports / customer_notes | allow_all | 読み書きとも不可 |
| 直接アクセス | products | allow_all | 店販・販売中の行の SHOP 用列の読み取りのみ |
| Realtime | 上記ロック対象テーブルの変更通知 | 購読可 | 読み取り権限が無いため配信されない |
| アプリ内コード | `legacyReadTickets` / `legacyReadLastVisit` / `legacyReadCustomer` / `legacyReadTodayUsage`（セッション未取得の既存会員の表示用） | 動作 | 権限エラーで失敗 → 「以前のチケットを引き継ぐ」を案内 |
| アプリ内コード | onboarding の `complete_customer_onboarding` 代替 / 受け取りの `claim_ticket_transfer` 代替 | A 適用後は使われない（新RPC優先・セッション有無で分岐） | 呼ばれても権限エラー |

アプリ内の移行用コードは B 後は使われないため、B 実施後の次のリリースで削除する。

## 本番確認SQL（B 直後に SQL Editor で実行・読み取りのみ）

リポジトリ外で作られた関数・ポリシーが本番に残っていないかを確認する。

```sql
-- 1) anon が実行できる public の関数（許可リスト47個のみであること）
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  and has_function_privilege('anon', p.oid, 'execute')
order by 1;

-- 2) anon / authenticated のテーブル単位の権限（0件であること。products は下の列単位の権限のみ）
select table_name, privilege_type
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated') and table_schema = 'public'
order by 1, 2;

-- 3) ロック対象テーブルに残っているポリシー（0件であること）
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('tickets','ticket_issue_logs','maintenance_visits','ticket_transfers','ticket_usage_logs',
                    'customer_user_aliases','customer_recovery_logs','maintenance_coupon_tokens','customers',
                    'accounting_items','accounting_sessions','accounting_session_items','daily_reports','customer_notes',
                    'live_statuses','shop_status');
-- products は public_read_retail（店販・販売中の select）の1件のみであること
select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'products';

-- 4) 列単位の権限（products の SELECT 9列 × anon/authenticated のみであること。customers 等は出てこないこと）
select table_name, grantee, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and grantee in ('anon', 'authenticated')
order by 1, 2, 3;
```

許可リスト（47）：`staff_login, staff_session_valid, staff_logout, verify_shop_passcode, hq_login, hq_session_valid, hq_logout, customer_register, customer_bind_with_code, customer_get_tickets, customer_get_last_visit, customer_get_profile, customer_get_today_usage, customer_create_transfer, customer_cancel_transfer, customer_claim_transfer, get_transfer_preview, customer_issue_maintenance_coupon, staff_register_customer, staff_customer_context, staff_search_customers, staff_issue_tickets, staff_use_tickets, staff_check_in, staff_preview_maintenance_coupon, staff_redeem_maintenance_coupon, staff_recover_member, staff_issue_bind_code, staff_products_list, staff_product_create, staff_product_update, staff_product_delete, staff_product_adjust, hq_list_customers, hq_get_customer, hq_accounting_sessions, hq_accounting_session_items, hq_daily_reports, hq_daily_report_source, hq_save_daily_report, hq_customer_notes, hq_create_customer_note, hq_products_list, hq_product_create, hq_product_update, hq_product_delete, hq_product_adjust`

いずれも現在の画面から呼ばれている（アプリの呼び出し箇所と照合済み）。

## 検証結果

### 1. 認可・機能（PGlite：schema → Welcome SQL → A ×2 → 既存会員作成 → B ×2 → 各シナリオ → ロールバック）

**76件すべて成功**。主な確認内容：
- 旧 `get_my_*`・`issue_maintenance_coupon_token(p_user_id)` が存在しない／B 後は `complete_customer_onboarding`・`claim_ticket_transfer`・`recover_member` を anon が呼べない
- すべての `customer_*` RPC が user_id をセッションとして渡されても拒否（`customer_auth_required`）
- 新規登録はサーバー採番の user_id＋64桁セッション。「いいえ」で Welcome 1枚、「はい」で0枚。他人のセッションでは他人のチケットが見えない
- 紐付けコード：コード未発行・期限切れ（10分）・5回失敗・使用済みはすべて拒否。正しいコードで紐付け成功、再紐付けで旧セッション失効、存在しない会員には発行不可
- 譲渡：他人のチケットは譲渡不可、自分への受け取り不可、別会員がセッションで受け取り可
- 端末変更：新端末に会員行が既にあっても復旧成功（仮会員行は1件に統合）、旧会員の名前・復旧コード・未使用チケット・来店日が移行、旧会員が Welcome を受け取っていれば新端末の Welcome を無効化、受け取っていなければ残す、旧端末セッション失効
- PIN：4桁は設定不可・6桁で成功＋端末キー発行。未登録端末からの失敗12回で未登録はロックされるが、**登録済み端末はログイン可能**。登録済み端末は自分の失敗5回でのみロック
- SHOP：セッション無しからの大量失敗で一時停止しても、**会員（セッションあり）は照合可能**
- 既存の一括発行・使用・Welcome 平日ルール・メンテナンスクーポンの確定/再利用拒否が引き続き動作
- A・B は2回実行しても同じ状態（冪等）。A 適用後も旧アプリの直接アクセスは動作。ロールバックで直接アクセス復元

### 2. B 後の旧経路の閉鎖（PGlite：Supabase 既定権限を再現 → A〜B 間に旧経路でデータ作成 → B ×2 → anon / authenticated で総点検）

**231件すべて成功**。
- 外部ロールが実行できる public 関数が、anon・authenticated とも**許可リスト47個と完全一致**（過不足なし）。廃止機能の RPC 12種は存在しない
- 旧RPC 7種（上表）が anon・authenticated とも実行不可。ブロックされた旧オンボーディングで既存会員の名前が書き換わらない
- ロック対象8テーブルが anon・authenticated とも select / insert / update / delete すべて権限エラー
- customers：anon・authenticated とも **SELECT（全列・基本列・単一列・件数）/ INSERT / UPDATE / DELETE すべて不可**。テーブル単位・列単位の SELECT 権限がどちらも残っていないことも確認
- customers 直接 SELECT 禁止後も、**顧客セッション RPC で本人プロフィール（名前・復旧コード）を取得できる**（セッションの持ち主の分だけ）
- **スタッフ RPC で対象会員の情報（会員・チケット・最終来店日）を取得でき、名前検索もできる**。スタッフセッションが無ければ拒否
- 廃止機能のテーブル（live_statuses / shop_status / accounting_items）：anon・authenticated とも select・件数・insert・update・delete すべて不可。テーブル単位・列単位の SELECT 権限も無い（行も変化なし）
- 本部系テーブル（accounting_sessions / accounting_session_items / daily_reports / customer_notes）：anon・authenticated とも直接の読み書きすべて不可
- **SHOP**：products は店販・販売中の行の SHOP 用列だけ読める。店販以外の行・min_stock・`select *`・書き込みは不可。店舗端末で在庫を変えると SHOP にも反映、論理削除した商品は SHOP から消える
- **店舗端末の在庫管理**：スタッフセッションで一覧（全カテゴリー・最低在庫含む）・追加・更新・入出庫・論理削除。不正な値は保存されない。セッション無し・本部セッションでは不可
- **本部の売上履歴・日報・カルテ・在庫**：本部セッションで売上履歴（期間・会員で絞り込み）と明細、日報の元データ取得・手動作成（同日は上書き）・一覧、カルテメモの読み取り・追加（空は拒否）、在庫の一覧・追加・更新・入出庫・削除が動く。セッション無し・店舗スタッフセッションではすべて拒否（データも作られない）
- app_private の6表・内部関数（PIN 設定・セッション判定）は不可
- アプリの移行用コード（直接読み取り5経路・旧RPC代替2経路）がすべて失敗する
- 正規経路は B 後も動作：新規登録・本人の読み取り・スタッフ PIN・未紐付け既存会員の店頭コード紐付け。**A〜B 間に旧経路で作られたデータも、紐付け後は新経路で見える**
- authenticated ロール（Supabase のメール登録で誰でもなれる）でも user_id はセッションとして使えない
- **本部カルテ**（anon・authenticated の両方で確認）
  1. 未認証（セッションなし・偽造トークン）では会員一覧・会員詳細とも取得不可
  2. 店舗スタッフセッションでは取得不可。スタッフ PIN では本部に入れず、本部 PIN では店舗端末に入れず、本部セッションはスタッフ RPC に使えない
  3. 本部セッションなら会員一覧・会員詳細を取得可（復旧コードは含まない。存在しない会員は null）
  4. 本部セッションを持っていても customers の直接 SELECT は不可
  5. B 後も本部カルテが動作（一覧 RPC＋本部の会計データ、詳細の customers.id でカルテメモ参照）
  - 本部 PIN は6桁必須・外部から設定不可。本部 PIN の大量失敗で未登録端末は一時停止するが、登録済み本部端末と店舗スタッフのログインは影響なし。ログアウト・本部 PIN 変更で本部セッション失効（スタッフセッションは影響なし）

### 3. 本番バックアップからの切替リハーサル（PGlite：2026-10-02 の本番 schema.sql / data.sql を復元 → catch-up ×2 → A ×2 → B ×2）

**48件すべて成功**。
- 復元直後の状態が本番と一致（全15テーブルの件数、customer_notes 無し、payment_summary 無し）。catch-up 無しではステップA が `type "public.customer_notes" does not exist` で失敗する（本番で見つかった問題の再現）
- catch-up：2回実行しても成功。customer_notes は schema.sql と同じ列・索引・外部キー（on delete cascade）・RLS 有効・ポリシー無し（B 前でも外部から読み書き不可）。payment_summary は jsonb not null default '[]'。既存の日報1件は値が変わらない
- ステップA・B とも2回実行して成功。全テーブルの件数が変わらない（データ消失なし）
- B 後：外部から実行できる関数が47個（拡張機能の関数を除く）。customer_notes・daily_reports ほか直接読み取り不可、SHOP は販売中の店販のみ
- 本部カルテメモ：既存会員へのメモ追加・読み取り、空メモ拒否、本部セッション無しは拒否
- 日報：既存の1件が payment_summary [] 付きで一覧に出る。新規作成で payment_summary が正しく保存され、既存の1件は変わらない
- 本番データの既存会員を店舗端末で読み取れる。本部カルテに35名全員が出る

### 4. アプリ

アプリ側：型チェック・ビルド成功。lint は変更ファイルのエラー数が変更前（HEAD）と同じ（既存の react-refresh 等のみ、新規エラーなし）。アプリが名前で直接呼ぶ全 RPC の関数名・引数名が SQL 定義と一致することを機械的に照合済み（在庫 RPC は店舗/本部の切替呼び出しのため PGlite テストで確認）。廃止 RPC・廃止テーブルへの参照がアプリに残っていないことを確認。**本番 Supabase には未適用のため、実機での通し確認は未実施**。

## 残存リスク・運用上の注意

- **既存会員は店頭での紐付けが必要**：B は実機確認後すぐ実施するため、B 後しばらくは未紐付けの既存会員がアプリでチケット等を見られない（会員QR の提示・店頭でのチケット使用やクーポン確定などスタッフ側の操作は可能）。次回来店時に店頭の10分コードで順次紐付ける
- **紐付けコードは店頭の本人確認が前提**：スタッフは会員QR とお客様本人（名前等）を確認してから発行する
- **Welcome の濫用**：新規登録を繰り返せば Welcome を複数受け取れる（全体レート制限のみ）。店頭での新規確認が必要
- **（解消済み）本部カルテ**：本部専用 PIN＋本部セッションの RPC（hq_list_customers / hq_get_customer）に移行したため、customers を完全非公開にしても B 後も表示できる
- **売上データの新規作成経路は無い**：会計アシスト廃止に伴い、accounting_sessions への書き込み RPC は作っていない。本部の売上履歴・日報は既存データの表示と集計のみ
- **本部の売上分析・会員分析・設定画面はモックデータ**（DB を読まないため今回の対象外）
- **本部端末の紛失時**：`app_private.revoke_hq_devices()` と本部 PIN の変更
- **店舗端末**：14時間ごとに PIN 再入力。端末を紛失した場合は `app_private.revoke_staff_devices()` と PIN 変更
- **未登録端末のログイン一時停止**：第三者が失敗を繰り返すと、新しい端末の初回登録が10分ほどできない（既存の店舗端末は影響なし）
- 今日が平日のため、Welcome の「土日は拒否」側の分岐は PGlite でも実地確認できていない（SQL の条件のみ確認）
