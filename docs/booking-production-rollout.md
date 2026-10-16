# 本番に予約の仕組みを入れる手順（2026-10-16）

本番 DB（ufyzynpmkxytnhebombq）に、SB（予約表）と HOT PEPPER メール取込に必要な仕組みを入れる。
会計（銀Pay・レジ）とセキュリティ強化 B は今回は入れない。

## 入れるもの（この順番。`supabase/rollout/booking_prod_order.txt`）

| # | migration | 中身 |
|---|---|---|
| 1 | welcome_coupon_onboarding | 新規登録のクーポン（本番に入っていれば何も変わらない） |
| 2 | prod_schema_catchup | 本番と開発の差分合わせ（同上） |
| 3 | security_hardening_a_functions | スタッフ PIN・お客様セッション（同上） |
| 4 | booking_phase1 | 予約・顧客台帳の土台 |
| 5 | customer_ledger | 顧客カルテ |
| 6 | service_master | メニュー表（種類・予約に出すか） |
| 7 | sb_reservation_board | SB の予約表（同時枠・転記） |
| 8〜11 | sb_hotpepper_* | HOT PEPPER メール取込 |

## 入れないもの

- **security_hardening_b_lockdown**：今の本番アプリはお客様・チケットを直接読んでいる（customerStore など）。B を入れるとそれが止まる。B は別の手順（`docs/security-hardening.md`）で行う。
- **ginpay_ledger / checkout / client_visit_model / pos_***：会計。予約だけなら不要（手元で確認済み）。
- **sb_capacity_setting**：テイテイ・銀二郎の同時受付を 3 にする。お店の判断が要るので、入れる時に別に決める。
- **customer_contact（main 側）**：登録画面の本名・電話番号。予約とは別に入れる。

## 手元でのリハーサル結果（10/2 の本番バックアップで実施）

- 10/2 の本番バックアップを手元の PostgreSQL 17 に戻し、上の 11 本を順に入れた → 全部成功
- 2 回続けて流しても成功し、結果は同じ（途中まで入っている本番でも安全）
- お客様 35 人・チケット 118 枚・会計 23 件はそのまま。顧客台帳に 35 人が引き継がれた
- 今のアプリの直接の読み取り（customers・tickets・ticket_usage_logs・maintenance_visits・products・ticket_transfers）は今までどおり動く
- 予約の流れ（電話予約・転記・同時 3 枠・HOT PEPPER の予約・変更・キャンセル・満杯・指名なし・時間外）のテストが全部通った

## 当日の手順

本番に書き込むのは手順 3 だけ。営業時間外に行う。

1. **バックアップ**：本番を丸ごと手元に保存する（`Desktop/otokomae-backups/<日時>/`）。Free プランで自動バックアップが無いので、これが戻し先になる。
2. **入れる前の確認**：`supabase/rollout/booking_prod_precheck.sql` を本番で実行する（読み取りのみ）。入っている migration と、お客様などの件数を控える。
3. **入れる**：`bash supabase/rollout/build_booking_rollout.sh` で `out/` に包んだ SQL を作り、1 本ずつ実行する。
   `npx supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq -f supabase/rollout/out/<ファイル>`
   1 本ずつ「全部入るか、何も入らないか」になっている。途中で失敗したらそこで止める（それまでの分は入ったまま、本番アプリには影響しない）。
4. **入れた後の確認**：precheck をもう一度実行し、件数が同じで、`has_reservations` などが true になっていること。本番アプリを開いてチケット・会員証が今までどおり出ること。
5. **お店の設定**（入れた後、SB を使い始める前）：営業時間・スタッフの勤務時間・メニューの所要時間（SALON BOARD と合わせる）・同時枠の数・HOT PEPPER 取込の合言葉。Gmail のスクリプトを本番向けに差し替える。

## 戻し方

今回入れるのは新しい表と関数だけで、今のアプリが使っている表の中身や読み取りの権限は変えない。
問題が出たら、まず予約の画面を使わないようにする（`app_booking_enabled` は false のまま）。
それでも戻す必要があるときは、手順 1 のバックアップから戻す。
