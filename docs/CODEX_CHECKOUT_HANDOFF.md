# Codex会計・QR修正とClaudeへの接続事項

土台：origin/staging 2f44054。mainへ直接pushしない。

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

## 価格RPC共有待ち

Claudeから、会計用RPC名・引数・返却JSON例・適用コミットを受け取ってからCheckoutの固定価格を置き換える。
Claudeは既存のapp_private.finalize_saleを更新する場合、この公開入口の同一キーのロックを維持すること。

## 公開を止めている券付き会計の既存SQL不具合

`20261018000100_checkout_ticket_mix.sql` の `unnest(v_types) t(type)` は、同じ関数の `t record` 変数と衝突する。
券付きの会計で `record "t" is not assigned yet` が発生する。使い捨てPostgreSQLで再現し、Stagingも同一定義であることを読み取りで確認した。
`ticket_type(value)` などに別名と参照を変更する修正は、価格関数を担当するClaudeへ依頼済み。migrationsをCodex側では変更しない。
この別名だけを使い捨てDBのメモリ内で仮修正すると、`supabase/tests/preflight_checkout_safety.sql` は通るが、正式適用後の再検証は別途必要。

## 実施済み検証

- 会計コントローラ11ケース、古い認証エラーの競合2ケース、アプリアイコン13ケースが成功。
- 実際のCheckoutコンポーネントとローカル模擬APIで4,000円の会計後に応答だけ失わせ、再読み込み・再確認でも決済1回のまま復帰した。
- 使い捨てPostgreSQLは上記SQL衝突を検出。別名の仮修正後は同じキーの再送、GINPay残高6,000円、券の消費、会計取消後の残高10,000円・券の復元、rollbackでデータ不残存を確認。

## 反映前の検証

1. ローカルで通信応答消失後の同じ取引の再確認、保存失敗、二重クリック、別タブ、取消済み会計、別顧客の未確認会計を確認。
2. 使い捨てDB/rollback付きStaging検証で、照合は課金せず、同じキーの再送が既存会計を返すこと、未認証の拒否、QR登録で氏名を変えないことを確認。
3. 本番の券単独使用は維持。会計環境の割引券は確定時にのみ消費する。
4. Claudeの価格/migration整理と併合してstaging-preflightを通し、両方が合意するまで本番へ進めない。
