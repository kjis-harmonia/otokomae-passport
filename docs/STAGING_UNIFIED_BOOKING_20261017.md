# Staging 統合予約フロー 適用結果（2026-10-17）

対象は Staging `kfufxzmucjljjouzpumi` のみ。本番への接続・変更なし。

| 項目 | 結果 |
|---|---|
| 再試行前 | 履歴19本、最新20261016095032。対象migration・新RPC・仮確保のbooking_lane列は未適用 |
| 適用 | 成功。20261016234902 / unified_booking_flow。履歴20本 |
| 新RPC | staff_member_booking_context / staff_check_in_reservation が存在 |
| 仮確保枠 | booking_holds.booking_lane smallint が存在 |
| 受付枠設定 | テイテイ・銀二郎3、他1を維持 |
| app_booking_enabled | trueを維持（今回の作業前からtrue） |
| 内部関数 | anon・authenticatedともbooking_free_lane / sb_apply / sb_planのEXECUTE不可 |
| 内部表 | anon・authenticatedともsb_requestsのSELECT不可 |
| Staging上の業務検証 | 15項目すべて成功、最後にrollback |
| 検証データ | 顧客1、予約27、会計1、チケット0、GINPay取引3で実行前後一致。合成スタッフ0件 |
| フロントエンド | 修正ソース保存済み。今回の再試行では再配信せず、並行作業の配信を保持 |

15項目：同時刻3枠と4件目拒否、仮確保の別レーン、確定予約の別レーン、氏名・電話の引継ぎ、会員QRから同じ予約の解決、他会員の来店処理拒否、来店処理の再送、来店日の更新、同じ予約と顧客とチケットの会計への引継ぎ、割引会計の再送で1会計、チケット使用、元予約の完了、本部売上への反映、お客様側の完了表示、GINPay再送で残高を1回だけ減算。

検証は同じ接続内での重複時間帯・再送の確認であり、別接続同士の競合・実機カメラ・ブラウザーの全操作の確認は含まない。

ローカルのTypeScript＋Vite最終ビルド成功。既存の予約・QR等117チェック成功。lintはApp.tsxの既存の同期setState警告2件が残っているため、全lint成功とは扱わない。

Security AdvisorはRLS有効でポリシーなし（INFO）、可変search_pathと公開SECURITY DEFINER実行権限（WARN）を報告。今回の新RPCは端末セッショントークンを必須とし、内部関数はクライアントから実行不可。Advisorが全件解消したとの判断はしていない。

- [RLS Enabled No Policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
- [Function Search Path Mutable](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
- [Public Can Execute SECURITY DEFINER Function](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
- [Signed-In Users Can Execute SECURITY DEFINER Function](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)

## 最新の適用履歴

| version | name |
|---|---|
| 20261001000000 | base_schema |
| 20261001000100 | welcome_coupon_onboarding |
| 20261001000200 | prod_schema_catchup |
| 20261001000300 | security_hardening_a_functions |
| 20261001000400 | security_hardening_b_lockdown |
| 20261002000000 | booking_phase1 |
| 20261003000000 | customer_ledger |
| 20261004000000 | ginpay_ledger |
| 20261005000000 | checkout |
| 20261006000000 | service_master |
| 20261007000000 | client_visit_model |
| 20261015000000 | sb_reservation_board |
| 20261015000100 | sb_capacity_setting |
| 20261015000200 | customer_contact |
| 20261015000300 | sb_hotpepper_mail_notices |
| 20261015000400 | sb_hotpepper_no_coupon |
| 20261015000500 | sb_hotpepper_note |
| 20261016091916 | ticket_issue_idempotency |
| 20261016095032 | ticket_issue_require_request_id |
| 20261016234902 | unified_booking_flow |
