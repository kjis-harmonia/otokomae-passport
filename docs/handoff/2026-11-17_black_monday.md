# 引き継ぎ：Black Monday（2026-11-17）

前の担当の Claude（デスクトップ）の利用上限が近いので、富士通の Claude へ引き継ぎます。返事・コメントは全部日本語で書いてください。

## オーナー（慶一郎さん）の決まり
- **Black Monday**
  - 本番に公開します。11/23 までに本番へ入れてください。
  - 11/23（月・祝）の来店から始めます。11/24 は火曜日なので、月曜の 11/23 から始めると仮に決めています。オーナーの返事はまだありません。
- **対象**
  - 毎週月曜（祝日も含む）に来店する、アプリで取った予約（`source='app'`）だけです。HOT PEPPER・電話・飛び込みは通常料金です。
  - 対象メニュー：perm-punch・perm-nurepan・perm-iper・perm-curly・perm-spain・perm-twist・perm-pin。1メニューにつき ¥2,000 引きます。
- **ピンパーマ（perm-pin）を新しく足します**：¥12,000、120分（仮）、担当は perm-twist と同じ人（仮）。
- **ほかの割引との組み合わせ**
  - Welcome クーポン・再来店パーマクーポン（`is_perm_coupon`）とは一緒に使えません。そちらを選んだら Black Monday は外れます。
  - ガチャ券は一緒に使えます。
- **予約の印**
  - 予約の時に印を付け、お会計（finalize_sale）で自動で引きます。
  - 日付を月曜以外に変えたら外し、月曜に変えたら付けます。
- **表示する場所**：銀ちゃんの確認画面（差し引き後の金額）・次回予約・店舗端末のお会計・SB に「Black Monday −¥2,000」と出します。
- **告知ポップアップ**（V2Campaign）
  - Staging で確かめてから、Black Monday と一緒に本番へ出します。
  - 他店のチラシの絵柄は使いません。黒地に金を少し使い、品よく作ります。
- **確かめる順番**：Staging で月曜の予約・変更・取消・お会計を通しで確かめます。そのあと、本番の DB とアプリは**オーナーの承認をもらってから**出します。
- **本番の DB への書き込み**：Claude からは書けません。`! npx.cmd supabase db query --remote=ufyzynpmkxytnhebombq --yes -f <file>` を、オーナー本人に実行してもらいます。そのあと、schema_migrations にも記録を残します。
- **Staging や本番へ出す前**には、必ずオーナーに一声かけてください。

## 今の状態
- **ブランチ**：`handoff/black-monday-1117`。gacha/1111-merge（3ffd87a）の上に、作りかけの変更を WIP として1コミットで載せています。
- **Staging の DB（kfufxzmucjljjouzpumi）にはもう流してあります。**
  - `supabase/migrations/20261117120000_black_monday.sql`
  - `supabase/staging-only/20261117_ginoku_black_monday.sql`
  - 確かめたこと：black_monday のテーブル4つ・関数7つ・perm-pin があります。finalize_sale は Black Monday 入り＋銀オク入りです。
- **画面側（src/）は作りかけです**。エージェントは「checkoutApi.ts・freeTicket.ts・Checkout.tsx を直す」途中で止まりました。型チェック・ビルド・テスト・画面の確認は**まだ**です。
- **試験用の SQL**：`docs/handoff/black-monday-work/`。結果はまだ確かめていません。
- **戻すための SQL**：`supabase/rollback/20261117_black_monday_off.sql`
- `scripts/black-monday.test.mjs` と `src/utils/blackMonday.ts` は、新しく作ったファイルです。

## 残りの作業
1. `npx.cmd tsc -b` と `npm run build` を通す。Checkout.tsx などの作りかけを仕上げる。
2. 巻き戻しの DO ブロックで、Staging の通しの試験をする。
   - 月曜の app 予約に印が付くこと、火曜に変えると外れ、戻すと付くこと
   - 取消した予約の印が効かないこと、hotpepper の予約には付かないこと
   - 会計で ¥2,000 引かれ、kind=campaign の記録が残ること
   - Welcome 券を使うと引かないこと
   - ガチャの無料券と一緒に使っても、合計が負にならないこと
   - 対象メニュー2つで ¥4,000 引かれること
   - 金額がずれた時に total_mismatch になること
3. 銀オクのテスト（`scripts/ginoku-*.test.mjs`）とガチャの回帰（`scripts/gacha-browser-regression.mjs`）がまだ通るか確かめる。
4. スマホ幅で見る：告知ポップアップ・銀ちゃんの確認・次回予約・会計・SB。`docs/DESIGN_PRINCIPLES.md` を守る。
5. 別のエージェントに細かく点検させ、出てきた点を直す。オーナーとこの進め方で合意しています。
6. Staging の branch に push する。push の前にオーナーに一声かける。
7. 本番に出す。
   - origin/main から release ブランチを切り、Black Monday の分だけを cherry-pick して PR を出す。
   - **銀オク（staging-only・V2Auction など）は本番に出しません。** 本番用の migration に ginoku_*・ticket_free_menus・auction_held が入っていないことを grep で確かめる。
   - 本番の DB は、オーナーに `!` で流してもらう。

## 気をつけること
- **銀オク**
  - 当分 Staging 止まりです。本番に出すかどうかは、オーナーに聞かないでください。
  - Staging の関数には、銀オクの上書きが入っています（`supabase/staging-only/README.md`）。
  - 本番用の migration を Staging に流すと、銀オクの版が消えます。そのあと必ず `staging-only/20261117_ginoku_black_monday.sql` を流し直してください。
- **ファイル**：CRLF です。Python は入っていないので、編集には node の .mjs を使ってください。
- **まだ出していないもの**：3ffd87a（johnny-notify を並列で送る直し）は、Supabase の両方にはデプロイ済みです。git では main にも staging にも入っていないので、次のリリースに入れてください。
