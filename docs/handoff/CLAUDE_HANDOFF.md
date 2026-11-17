# 銀二郎App Sランク磨き監査 — Claude Code 引き継ぎ

本番配信 `67c3782effaa282f887a834464a85933a3ed4561`（PR #137）、Staging配信 `351b132424641e6aca4d71767999dd5a97593b33`。GitHubのコミットステータスとVercelの各固定ドメインを照合済み。行番号は本番版基準。Staging側は該当ファイル・分岐を照合した。銀オクは今回の対象外。

**目的は既存機能の仕上げ。** 以下の再現条件を出発点に、予約者、確定額、会計・券の状態を守りながら、迷いや待ちを減らす。現行の予約・割引・決済ルールを維持する。画面の変更前に `docs/DESIGN_PRINCIPLES.md` を読む。DB/RPC・認証・決済仕様に変更が必要な箇所は、影響範囲と案を出して承認を得る。共有Staging・本番への反映は別工程。

検証区分は **画面**（ローカルChrome・合成データ）、**DB**（使い捨てPostgreSQL 17・合成データ）、**コード**（経路を静的照合、該当操作の実端末通しは未実施）。不具合14件のうち、画面で再現7件、DBで再現1件、コード照合6件。旧形式の予約判定は画面・DBの両方で確認したため1件として集計。

## 1. 先に直す — 予約対象・会計・抽選

### 店舗と会計

**SR-01｜高・コード — お連れ様だけ受付しても本人の会計が開き得る**

- 再現。本人・お連れ様が同日に予約している会員QRを読み、「いいえ」からお連れ様だけ受付する。受付結果が会計に渡らず、先に準備した本人予約が会計対象になる。確認せず確定すると、本人側の予約・メニュー・金額で処理するおそれ。
- 修正・合格条件。受付が返した予約IDを会計の入口に渡す。本人のみ・お連れ様のみ・全員の3通りで、受付済みの予約と会計画面の人／メニュー／金額が一致する。全員受付では「次のお会計」も正しい予約へ。受付未確定と通信失敗時に誤った対象へ進まない。
- [src/screens/AdminScreen.tsx 509行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/screens/AdminScreen.tsx#L509) · [src/screens/AdminScreen.tsx 983行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/screens/AdminScreen.tsx#L983) · [src/screens/AdminScreen.tsx 1845行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/screens/AdminScreen.tsx#L1845) · [src/components/MemberCheckout.tsx 55行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/components/MemberCheckout.tsx#L55) · [supabase/migrations/20261028000000_member_checkout_unpaid_reservation.sql 15行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261028000000_member_checkout_unpaid_reservation.sql#L15)

**SR-02｜高・DB — SBの「施術完了」で未会計の銀Pay仮押さえが閉じる**

- 再現。銀Pay仮押さえ付き予約をSBで「来店済みにする」→「施術完了」。実際の `sb_apply` を使ったローカルDB試験で、予約 `completed`、仮押さえ `closed`、会計0件、銀Pay引き落とし0件。QR会計の予約検索は完了予約を除外するので、該当予約が引き継がれず、ガチャ券・Black Mondayも予約なし会計に乗らない経路がある。
- 修正・合格条件。未会計の施術完了は既存の `awaiting_payment` を使い、会計で `completed` にする案を検討する。SB操作直後に押さえ維持、QRで同じ予約・券が出る、銀Pay確定でのみ引き落とし1件・押さえ終了。従来の取消・無断キャンセル時の解放も確認。状態・RPCの変更案は承認前に提示する。
- [src/sb/SbScreen.tsx 410行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/sb/SbScreen.tsx#L410) · [supabase/migrations/20261016234902_unified_booking_flow.sql 364行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261016234902_unified_booking_flow.sql#L364) · [supabase/migrations/20261024000100_ginpay_hold.sql 45行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261024000100_ginpay_hold.sql#L45) · [supabase/migrations/20261028000000_member_checkout_unpaid_reservation.sql 15行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261028000000_member_checkout_unpaid_reservation.sql#L15)

### お客様の操作と抽選

**SR-03｜高・コード — 「お連れ様の予約をする」でご本人が初期選択**

- 再現。本人は予約なし、同行者Aは予約済み、Bは予約なし。「お連れ様の予約をする」→ 次へ。入口で意図を受け取っても、人物選択の初期値は本人。1人予約の確認文から人の違いを見落とし得る。
- 修正・合格条件。その入口からは予約可能な同行者を選んで進む。1人でも誰の予約か確定前に分かる。Bを選んだとき、画面・確定要求ともBのIDで、本人とAの予約に影響がない。
- [src/v2/GinChat.tsx 510行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L510) · [src/v2/GinChat.tsx 840行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L840) · [src/v2/GinChat.tsx 1125行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L1125)

**SR-04｜高・画面＋コード — ガチャの結果を見ると翌日分の抽選を呼ぶ**

- 再現。1日1回設定・確定済みの状態でガチャを開いたまま、日本時間で日付をまたいで復帰。「本日の結果をもう一度見る」が残り、クリックで抽選RPCが1回呼ばれた。新しい日の抽選がまだなく、未決定券もなければ、このRPCはSQL上、新しい抽選を作る。
- 修正・合格条件。再表示は既存の結果照会に寄せる。復帰して日付が変わったら当日の状態を取り直す。同日再表示・翌日の古い再表示操作とも新規抽選0件。その日の明示的な「回す」でだけ1件。演出音・結果の見せ方を維持。
- [src/v2/V2Gacha.tsx 392行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/V2Gacha.tsx#L392) · [src/v2/V2Gacha.tsx 548行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/V2Gacha.tsx#L548) · [supabase/migrations/20261105000100_gacha_opens_on.sql 11行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261105000100_gacha_opens_on.sql#L11)

## 2. ログイン・予約への復帰・通信を整える

**SR-05｜高・画面 — 更新後、古い初回案内が残ると予約が開かない**

- 再現。初回案内を閉じる前に旧版を離脱した状態を再現し、`ginjiro_first_guide={visited:true}` を残したまま新画面で「次回予約」→「AI予約する」。案内も銀ちゃんも出ない。保存値なしの対照では開いた。変更入口もコード上は同じ描画条件。
- 修正・合格条件。旧案内の表示条件と銀ちゃんの描画を抑止する条件を同じにする。旧値を残した新フローで予約・変更が開く。旧フローの表示・閉じる操作を維持。
- [src/App.tsx 235行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/App.tsx#L235) · [src/App.tsx 427行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/App.tsx#L427)

**SR-06｜高・画面 — 未ログインのキャンセル待ち通知で行き先を失う**

- 再現。有効な `?tab=reserve&hold=…` をログイン情報のないアプリで開く。クエリが消え、ログイン案内も枠も出ずホームに戻った。通知URLのブラウザ試験。OS通知での起動は実機確認が残る。
- 修正・合格条件。ログイン案内への遷移がホーム遷移で上書きされないようにする。今の枠IDを開けるまで保持し、対応する会員で認証したとき有効な枠を1回表示する。期限切れ・別会員・ログイン済みの分岐も確認。追加の自動予約は行わない。
- [src/App.tsx 372行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/App.tsx#L372) · [src/v2/V2App.tsx 25行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/V2App.tsx#L25) · [src/v2/V2App.tsx 76行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/V2App.tsx#L76) · [supabase/functions/johnny-notify/index.ts 157行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/functions/johnny-notify/index.ts#L157)

**SR-07｜中・画面 — メニュー取得が復旧しても一覧が空**

- 再現。最初のメニュー一覧取得だけ503を返し、次を正常応答にする。会話には本人のパンチパーマが出る。「ほかのメニュー」→「一覧から選ぶ」で0行と「見つかりませんでした」になる。ブラウザの記録はメニュー取得2回、候補0行。
- 修正・合格条件。後から取得できた一覧を会話・一覧の両方で使う。通信エラーと正常な0件を分ける。初回だけ503→正常なら4件の合成候補が表示される。連続失敗なら読み直せる。
- [src/v2/GinChat.tsx 252行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L252) · [src/v2/GinChat.tsx 529行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L529) · [src/v2/GinChat.tsx 1697行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L1697) · [src/v2/MenuPickerSheet.tsx 95行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/MenuPickerSheet.tsx#L95)

**SR-08｜中・コード — 日時だけ変更で元の時刻に近い空きが消える**

- 再現。元の予約10:00。同日に10:00と10:20が使える応答で「日時を変更」→同じ日。間引きで10:20を落としてから元の10:00を除外するので、候補なしになる。
- 修正・合格条件。日時のみ変更では元の枠を除外したあと候補を間引く。10:20を選べ、メニューと指名が維持される。メニューのみ変更で元の10:00を使える条件は維持。
- [src/v2/GinChat.tsx 1567行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L1567) · [src/features/johnny/dayAdvisor.ts 99行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/features/johnny/dayAdvisor.ts#L99)

**SR-09｜中・コード — メニュー変更後の空き再照会503を満席と案内**

- 再現。新規予約の最終確認でメニューを変更し、元の時刻の空き再照会だけ503。銀ちゃんが「その時刻は入れなくなってしまいました」と案内する。
- 修正・合格条件。通信失敗では元の時刻と新メニューを保持して再試行。応答正常で空きなしなら別時刻へ、空きありなら同じ時刻を確認する。
- [src/v2/GinChat.tsx 722行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L722) · [src/v2/GinChat.tsx 999行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L999) · [src/v2/GinChat.tsx 1142行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L1142)

**SR-10｜中・画面 — 「次回予約」が復帰後も旧時刻を確定表示**

- 再現。「次回予約」を10:00で表示したまま背景へ。他の端末が11:00に変更した応答に差し替えて復帰イベントを送る。取得回数は増えず、10:00の「ご予約確定」が残った。
- 修正・合格条件。前面復帰時に既存の再取得を呼ぶ。変更・取消が反映され、通信失敗なら既存の「前に確認した内容」の表示に切り替わる。復帰イベントで多重照会しない。
- [src/features/johnny/nextReservation.ts 88行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/features/johnny/nextReservation.ts#L88) · [src/v2/V2Next.tsx 41行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/V2Next.tsx#L41)

## 3. 画面上の情報を揃える

**SR-11｜中・コード — SBで未転記の変更を重ねると変更前の時刻がずれる**

- 再現。SALON BOARDへAで転記した予約を、SBだけでA→B→Cと変更。「変更前」はBになるが、SALON BOARD上はA。
- 修正・合格条件。最後に転記を確認した時点の日時・担当から現在への差分を表示する。未転記のA→B→CはA→C。Bが転記済みならB→C。
- [src/sb/sbBoardTask.ts 55行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/sb/sbBoardTask.ts#L55) · [src/sb/SbScreen.tsx 415行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/sb/SbScreen.tsx#L415)

**SR-12｜中・コード — SBの予定額にガチャ無料券が反映されない**

- 再現。月曜の対象パーマ1明細にそのメニューのガチャ無料券を付け、SBの予約詳細を開く。SBがメニューコードを券の表示名と比較するため、無料券分は「金額は会計で」のまま、Black Mondayの二千円だけを引いた予定額が出る。対象施術1明細・追加なしの会計は0円。
- 修正・合格条件。既存の `menu_codes` で対象明細を照合。Black Monday適用後の残額を無料券で引く。月曜・通常日とも同条件の予定額と会計額が0円。定額券と対象外明細の扱いを維持。
- [src/sb/SbTicketPlan.tsx 37行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/sb/SbTicketPlan.tsx#L37) · [src/utils/checkoutApi.ts 203行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/utils/checkoutApi.ts#L203) · [supabase/migrations/20261117120000_black_monday.sql 499行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261117120000_black_monday.sql#L499)

**SR-13｜中・画面 — 低い横画面でガチャの2枚比較が読めない**

- 再現。保有券が1枚ある合成状態から「当選した券を選ぶ」を開く。667×320のChromeで結果パネルは高さ約448 px、上端が約148 px画面外。パネル内部は縦スクロールなし。
- 修正・合格条件。結果パネルをセーフエリア内に収めて内部スクロールを許す。短い横画面・大きい文字でも当選名、両券の条件、確定・閉じる操作に到達できる。縦画面の演出・結果表示は維持。
- [src/v2/v2.css 473行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/v2.css#L473) · [src/v2/V2Gacha.tsx 712行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/V2Gacha.tsx#L712)

**SR-14｜中・画面＋DB、前回からの残件 — メモだけの旧お連れ様予約**

- 再現。メモが「お連れ様」のみで、ID・親予約ID・名前なし。ローカルDBではお連れ様と判定されるが、予約一覧JSONは判定に使える値を持たず、ブラウザでは本人のいつものを表示。名前だけ・親予約IDだけのケースと、髪型／本人変更の既知ケースは修正済み。
- 修正・合格条件。既存のサーバー判定を予約一覧に明示フラグで渡し、相手のIDが特定できないときは本人の候補を出さない。共有DBの変更は要事前承認。現時点に該当する変更可能な本番予約があるかは未確認。
- [supabase/migrations/20261108000100_treated_person.sql 41行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261108000100_treated_person.sql#L41) · [supabase/migrations/20261108000100_treated_person.sql 202行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/supabase/migrations/20261108000100_treated_person.sql#L202) · [src/v2/GinChat.tsx 1435行](https://github.com/kjis-harmonia/otokomae-passport/blob/67c3782effaa282f887a834464a85933a3ed4561/src/v2/GinChat.tsx#L1435)

## 検証と次の実機試験

- 本番ソースの既存Nodeテスト **174/174**、JOHNNYの予約ルール **85件合格**、アプリ型チェック合格。既存ガチャのブラウザ回帰 **10/10**、同スクリプト内のローカルViteビルド合格。ガチャ回帰は模擬RPCとiPhone 13プロファイルで、iOS実機の結果ではない。
- 追加Chrome試験は、結果再表示の抽選RPC発行、未ログイン通知の入口消失、旧案内での予約停止、次回予約の古い表示、メニュー取得復旧後の空一覧、旧形式の誤表示、横画面の結果切れを再現。旧案内の保存値なしは対照で正常。横画面の計測は対象パネルのセレクタを正した単独再実行で採取。
- ローカルDBでSB施術完了と仮押さえ、旧メモの判定・JSONを照合。試験データは全てロールバック。登録済み店舗端末のカメラ・実画面と実決済は未実施。
- 実機はiPhoneのホーム画面アプリ・Android Chrome/ホーム画面アプリ・登録済み店舗iPadで、**本人とお連れ様の予約 → 日時だけ変更 → QRで1名だけ受付 → 券付き会計**を専用データで1件ずつ進める。氏名・日時・担当・メニュー・適用券・支払額が一致することを確認する。
- 通知タップはログイン済み・期限切れセッションを分ける。更新前の開きっぱなしからの復帰と完全終了→再起動を分ける。ガチャ3編は通常音・消音モード・復帰・結果の再表示を確認し、横画面は券2枚の比較まで通す。実機の未実施項目は合格扱いしない。
- 監査は3エージェントの読み取り点検と親側の再現確認。製品コード、共有DB、公開設定は変更していない。

## 配信・再現資料

- [本番 PR #137](https://github.com/kjis-harmonia/otokomae-passport/pull/137)
- [本番デプロイ](https://vercel.com/kjis-harmonias-projects/otokomae-passport/23sZB5yvMHroFupiGccUomh2DfAr)
- [Stagingデプロイ](https://vercel.com/kjis-harmonias-projects/otokomae-passport-staging/63dYBBCcaxrVPx6medNHekushVZ3)
- このフォルダの `node-tests.log`、`johnny-tests.log`、`gacha-browser.log`、`app-browser-results.log`、`reservation-browser-results.log`、`gacha-short-results.log`、`gacha-short-landscape.png`、`sb-hold-audit.sql`。
