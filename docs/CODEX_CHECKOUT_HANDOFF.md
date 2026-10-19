# Codex会計・QR修正とClaudeへの接続事項

土台：origin/staging 2f44054から開始し、Claudeの9a000bdまで取り込み済み。mainへ直接pushしない。

CodexはCheckout/MemberCheckout/AdminScreen/customerSessionを担当し、migrations・rollout・AI・価格ロジックを編集しない。
SQL案は `docs/sql/codex_checkout_safety.sql`。Claudeが `20261019000200_checkout_safety.sql` に組み込み、Stagingへ適用済み（addd2b1）。本番は未適用。

## 必須のDB入口

- `staff_checkout_result(p_staff text,p_idempotency_key text) -> json | null`
  - assert_staff必須。completed/voidedなら既存sale_json、未確定ならSQL NULL。
  - staff_finalize_saleと同じ取引キーのadvisory transaction lockを取る。
- `staff_finalize_sale` は同じキーの照合・確定を直列化する。既存app_private.finalize_saleの料金/券/GINPay処理を維持する。
- `staff_register_customer` は既存会員の名前を変更せず、新規登録だけ受け付ける。

フロントは保存先への書き込みと照合RPCの存在確認に成功してから初回会計を送る。未配置のRPCへ決済を送らない。
通信エラー時は内容・キー・操作者を端末に残す。再読み込みでも同じ内容を照合/再送し、結果不明の記録は期限や戻る操作で捨てない。
完了済みを再表示したときは既存会計を表示し、別の店頭会計を作る場合だけ明示的に区切る。
Web Locksで同じブラウザ内の複数タブを制御する。別の店舗端末から別キーで作成された取引を自動で同一会計と判断する機能ではない。

## 価格RPCの接続

Claudeの `staff_price_quote(p_staff,p_menu_codes,p_starts_at)`（0e015b0）を使用。
予約明細は予約開始時刻の `charge` を単価として使い、保存された予約の会員価格やwalletの固定価格へ戻さない。
店頭追加の正規サービスも最大20件ごとに同じRPCへ問い合わせ、最初のサーバー時刻に揃える。予約からの追加では予約開始時刻に揃える。
支払単価を直接使うので、数量変更でも会員割引を1件分しか引かない計算にならない。見積欠落・不正な料金・通信失敗時は固定価格で代用しない。
Claudeは既存のapp_private.finalize_saleを更新する場合、この公開入口の同一キーのロックを維持すること。

## 検出して修正済みの券付き会計SQL不具合

`20261018000100_checkout_ticket_mix.sql` の `unnest(v_types) t(type)` は、同じ関数の `t record` 変数と衝突する。
券付きの会計で `record "t" is not assigned yet` が発生する。使い捨てPostgreSQLで再現し、Stagingも同一定義であることを読み取りで確認した。
Claudeが9a000bd / `20261019000300_finalize_sale_ticket_alias.sql` で `ticket_type(value)` へ修正し、Stagingへ適用済み。
Codexも正式migrationを読み込んだ使い捨てDBと、Stagingのrollbackテストで再確認した。migrationsをCodex側では編集していない。

## 実施済み検証

- 会計コントローラ11ケース、古い認証エラーの競合2ケース、価格6ケース、アプリアイコン13ケース（計32件）が成功。
- 実際のCheckoutコンポーネントとローカル模擬APIで4,000円の会計後に応答だけ失わせ、再読み込み・再確認でも決済1回のまま復帰した。
- 正式SQL修正を取り込んだ使い捨てPostgreSQLとStagingで、同じキーの再送、GINPay残高6,000円、券の消費、会計取消後の残高10,000円・券の復元を確認。検証はrollbackしデータを残さない。
- スマホ幅で通常料金9,000円/会員料金8,000円の予約会計と、本部・端末・SBのPIN画面を確認。
- staging-preflightのmigration順序43本・秘密情報チェック成功。ローカルにpsql/pgbenchがないため、同スクリプトの新規DB全migration適用・本番コピー比較・pgbench並行負荷は未実施（Stagingへ同スクリプトを向けない）。

## 反映前の検証

1. ローカルで通信応答消失後の同じ取引の再確認、保存失敗、二重クリック、別タブ、取消済み会計、別顧客の未確認会計を確認。
2. 使い捨てDB/rollback付きStaging検証で、照合は課金せず、同じキーの再送が既存会計を返すこと、未認証の拒否、QR登録で氏名を変えないことを確認。
3. 本番の券単独使用は維持。会計環境の割引券は確定時にのみ消費する。
4. Claudeの価格/migration整理と併合してstaging-preflightを通し、両方が合意するまで本番へ進めない。
