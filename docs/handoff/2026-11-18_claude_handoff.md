# 引き継ぎ：銀二郎アプリ（2026-11-18・デスクトップの Claude → 富士通の Claude）

返事は必ず日本語で書いてください（途中の一言も英語を混ぜない）。

## 決まりごと（慶一郎さん）
- **公開の前に声をかける**：Staging・本番に出す前に、必ず慶一郎さんに一声かける。本番の操作は、1つずつ承認をもらう。
- **本番の DB**
  - Claude からは書き込めない。`! npx.cmd supabase db query --remote=ufyzynpmkxytnhebombq --yes -f C:/…/file.sql` を慶一郎さんに実行してもらう。パスの区切りは「/」（「\」は消える）。
  - 流す時は `begin; … ; insert into supabase_migrations.schema_migrations (version, name) values (…); commit;` の形で、記録も残す。
- **銀オク**
  - 本番に絶対に入れない。当分 Staging 止まりで、本番に出すかどうかは聞かない。
  - 銀オクにあたるもの：src/features/auction/・V2Auction・ginoku.css・freeTicket・supabase/staging-only/・ginoku_*・ticket_free_menus・auction_held。
  - 本番に出す前に、差分を grep して0件を確かめる。出したあとも、本番の JS を全部読んで0件を確かめる（この手順は前回 scratchpad の prodcheck.mjs でやっていた）。
- **本番に出す方法**：origin/main から release ブランチを切り、必要なコミットだけを cherry-pick して、PR を出してマージする。Vercel は main と staging への push だけで版を作る。
- **ファイル**：CRLF。Python は入っていないので、編集は node の .mjs か Edit を使う。
- **DB を直接いじる時**：本番は読み取りだけ（`--read-only`）。Staging の試験は `begin; <migration>; <DO …最後に raise exception 'ROLLBACK_OK'>; commit;` の形で流し、全部巻き戻す。

## 今の状態
- **本番 main**：67c3782（PR #137）
  - Black Monday（11/23 から）
  - 告知（白い「AI予約する」ボタン）
  - ピンパーマ
  - 銀ちゃんのメニュー一覧の「いつもの」
- **本番の DB**：
  - Black Monday（20261117120000）を流してある。
  - テイテイ刈り（20261118120000：90分・予約可・担当テイテイ）も流してあり、記録も入れてある。
  - ただし、このファイルは **main にまだ入っていない**（Staging のコミット bb18975）。次のリリースで main に入れる。
- **origin/staging**：317e2c8。上の内容に、テイテイ刈りの migration と SR-01 を足したもの。
- **review/sr-02**：4717c21。SR-02 の2版目（下を参照）。Staging にも本番にも出していない。

## 残っている作業
1. **SR-01（店の会計：お連れ様だけ受付したのに、ご本人の会計が開く）**
   - 直した内容は Staging に出してある（9253139・317e2c8）。判断は `src/utils/checkoutTarget.ts` で、試験は `scripts/checkout-target.test.mjs` の8件。
   - 残り：店の iPad で、次の5通りを見る。会計の氏名・担当・メニュー・金額が受付した人と一致すれば合格。
     - ご本人だけ
     - お連れ様だけ
     - 全員
     - ご本人が受付済み・未会計で、お連れ様を受付
     - 受付の通信が失敗した時
   - 合格したら本番へ（慶一郎さんの承認をもらってから）。
2. **SR-02（SB の「施術完了」で、会計の前に銀Pay の仮押さえが閉じる）**
   - 2版目を `review/sr-02` に置いてある。
     - DB：`supabase/migrations/20261118130000_sb_complete_awaiting_payment.sql`
     - SB の画面：`src/sb/SbScreen.tsx`・`sbApi.ts`・`sb.css`
     - 試験：`supabase/tests/sr02_sb_complete_rollback_test.sql`
   - 中身：会計の要る未会計の予約（銀Pay の押さえ・期限内のガチャ券・予約に付けた期限内の券・Black Monday）は、「施術完了」で会計待ちにする。完了にするのは会計の確定だけで、`set_reservation_status` で SB・旧スタッフ RPC・本部の操作を共通に断る。
   - 回帰試験10項目は、Staging で巻き戻す形ですべて合格した。
   - **Codex にもう一度見てもらうのを待っているところ。** OK が出たら、Staging の DB に入れるかを慶一郎さんと決める。そのあと本番の DB（慶一郎さんの `!`）とアプリ。
3. **Codex の監査の残り**：`origin/handoff/codex-1117` の `docs/handoff/CLAUDE_HANDOFF.md`
   - SR-03〜SR-14 がまだ。お客様側で先に直すのは次の3つ。
     - SR-04：日付をまたぐと、ガチャの「結果を見る」が新しく抽選してしまう
     - SR-06：未ログインでキャンセル待ちの通知を開くと、行き先が消える
     - SR-05：古い初回案内が残っていると、予約の画面が開かない
   - SR-14（メモが「お連れ様」だけの古い予約）は、本番で変更できる予約が0件だったので、DB の変更はしないことにした。
4. **11/22 の閉店後**：店舗端末・SB・本部を全部開き直してもらう。古い画面のままだと、Black Monday の会計で金額が合わず確定できない。
5. **11/23（初日）**：お会計に「Black Monday −2,000円」が出て、合計が合うかを慶一郎さんと一緒に見る。
6. **テイテイ刈り**：本番のアプリで選べて、日時まで進めるか、慶一郎さんに見てもらう（返事待ち）。
7. **前からの残り**
   - 慶一郎さんが店にいる時に、SB を開いたままの iPad でテスト通知を送り、音が鳴るかを確かめる。
   - 銀オクの決めごと（Staging だけ）：お連れ様が無料券を使えるか、2番手の人が今の残高で払えるか、銀ちゃんで無料券を選べるか、落札の売上をどう数えるか。
