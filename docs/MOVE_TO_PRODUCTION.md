# Staging → 本番の引っ越し手順（11/9〜）

方針：Staging をそのまま本番へ。**機能は増やさない、磨くだけ**。本番の操作はすべて慶一郎さんの承認のあと。

## 新しい流れのスイッチ

- `ginFlow()`（`src/utils/env.ts`）ひとつで切り替わる。Staging は常に入。本番は Vercel の環境変数 `VITE_GIN_FLOW=true` で入る。
- 中身：LINE 型の銀ちゃん（予約・変更・キャンセル・キャンセル待ち・店頭QRのあとの聞き取り）、☰「いつもの・お連れ様」、登録のあとはそのままホーム（最初の画面＝FirstGuide は出さない）。
- テスト用の道具（Staging の帯・リセット・ガチャ先行公開・登録なしで開く・`?firstguide`）は `isStaging()` のまま。本番には出ない。
- 新しい機能を Staging だけに出したいときも `isStaging()` ではなく `ginFlow()` を使う。

## 荷物（main に無いもの）

- DB migration 9本（順番どおり）
  1. 20261107001000_menu_maintenance_eligible
  2. 20261108000100_treated_person
  3. 20261108000200_checkin_basis
  4. 20261108000300_open_days
  5. 20261108000400_menu_knowledge
  6. 20261108000500_reservation_change
  7. 20261108072151_reservation_change_safety
  8. 20261108220801_booking_person_overlap（本番に同じ人の重なり予約が残っていると止まる＝先に調べる）
  9. 20261109045326_customer_booking_cutover（旧版PWAの曖昧な確定・取消を断る）
- Edge Function `johnny-agent`（usual モード）
- 理容知識 `app_private.menu_knowledge`（記入表が戻ったら `confirmed_at` 付きで入れる。空でも動く）
- **持っていかないもの**：`staging_reset_tester` / `staging_reset_me`（Staging だけの関数。リポジトリにも無い）

## 順番

1. **本番 DB の下見（読むだけ）**：migration が上書きする関数（finalize_sale、create_reservation、customer_confirm_reservation など）が、Staging の土台と同じか比べる。本番にだけある直しがあれば、migration に取り込んでから進む。
2. **重なりの下見**：本番の予約に、同じ人で施術時間が重なっている行がないか調べる（8 が止まらないように）。
3. **DB migration 1〜9 を本番へ**（1本ずつ、失敗したら止める）。
4. **Edge Function `johnny-agent` を本番へ deploy**。
5. **main へ PR → マージ**（この時点では `VITE_GIN_FLOW` が無いので、お客様の見た目は今のまま。登録画面のクリーム色だけ先に変わる）。
6. **Vercel 本番に `VITE_GIN_FLOW=true` → 公開し直し**。ここで新しい流れに切り替わる。
7. **本番で確かめる**：テスト会員で予約 → 変更 → キャンセル、お連れ様、キャンセル待ち、店舗端末の〇名様受付・会計。

## 元に戻すとき

- 画面：Vercel の `VITE_GIN_FLOW` を外して公開し直す → 旧画面に戻る。
- 旧画面から予約を確定・取り消すと、9 の安全対策で断られることがある（「アプリを開き直してください／お店へ」）。戻すのは画面の不具合のときだけにする。
- DB の migration は戻さない（予約・券・銀Payの記録を守るため）。

## 磨きのチェック（引っ越し前）

- [ ] 全端末の検査（Codex）：iPhone Safari／ホーム画面アプリ・Android Chrome・通知・カメラ・マイク
- [ ] 旧バイクの予約画面がどこからも出ない（最初の画面だけは出てよいが、新しい流れでは出ない）
- [ ] 登録 → Welcome クーポン → ホーム → 店頭QR の案内（Staging は `?onboarding=1`）
- [ ] 本物のスマホで慶一郎さんが触る
