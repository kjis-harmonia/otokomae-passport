# ④ 公開用ブランチ（2026-10-20）

本番公開は保留。ここではコード・ローカル検証・ドラフトPRだけを準備した。本番／StagingのDB・環境変数・関数・cronは変更していない。main・stagingにもpushしない。

## 土台と統合

- ブランチ：release/20261020。origin/main（848679f）から作成し、origin/staging（20977a6）を取り込んだ。
- ③のPR #10（4c2e193）の手順書と検証スクリプトも取り込んだ。PR #10自体をStagingにmergeしたという意味ではない。
- 本部Johnnyの競合は、Stagingの認証後TTS呼び出し・通常価格／会員価格の版を採用した。関数の最終ソースはStagingと同じ。
- mainに残っていた旧番号のhq_tasks／open_slot_pushのmigrationとrolloutを取り除き、Stagingで整理済みの番号へ統一。最終migrationはStagingと同じ44本。DB履歴は変更していない。

## Stagingからの画面変更

| 箇所 | 公開用ブランチの動き |
|---|---|
| 店舗端末のQRチェックイン後 | 本番でも会計に進める。選択した券は会計確定時に消費 |
| 券の旧「使用確定」 | 会計を通さない単独消費のボタン・処理・確認画面を削除 |
| 本部 | 会計・GINPayのタブ、顧客のGINPayを本番でも表示 |
| StaffHome | 銀Payチャージ・予約・顧客はStagingですでに表示条件なし。追加変更不要 |
| 来店登録の通信エラー | QR結果に案内を表示。削除した旧券消費モーダルへエラーが埋もれない |
| Face ID・来店確認UI | 秘密を含まない.env.productionでVITE_CUSTOMER_ACCESS_ENABLED=true。本番用ビルドで検証 |

店舗PIN・本部PIN・会員セッション・店頭本人確認の検証は維持。Stagingバッジや環境名の表示は維持。旧ショートカットAPIはStaging限定のまま。

## フラグの区別

Viteの.env.productionはWebのビルド設定だけで、Supabase Edgeの設定にはならない。リリース時はVercel Productionの同名変数をtrueにそろえる（プラットフォームの値がファイルより優先）。本番SupabaseのCUSTOMER_ACCESS_ENABLED=trueは⑤の人向け手順で設定する。今回はリモートの両フラグを変更していない。

Edgeは未設定なら拒否する安全側の判定を維持し、ONの署名登録／ログインとOFFの拒否を回帰テストで確認する。来店確認が必要なJohnnyの有料APIは、Webのフラグにかかわらず本人確認RPCが先。本番DBの15番まで成功する前にjohnny-agent／johnny-style-adviceを公開しない。

## 検証

| 検査 | 結果 |
|---|---|
| 回帰テスト | node --experimental-transform-types --test scripts/*.test.mjs：57件すべてPASS、外部通信なし |
| 本番ビルド | tsc -bとVite build成功。接続しない検証用公開キー、本番project URL、WebフラグONでローカル出力 |
| Viteの設定解決 | productionモードで本番project URL・VITE_APP_ENV=production・アクセスフラグtrueをassert |
| Lint | エラー0、既存SbScreenのref cleanup警告1。Git対象外.qaを除外 |
| DB preflight | 専用PG17の127.0.0.1:55434で44本の初回適用・再適用PASS |
| DB機能 | security／service-master／booking／clients／checkout／ginpay／concurrencyすべてPASS。3系統の同時送信は各10クライアント・失敗0 |
| migration・関数の最終ソース | origin/stagingとの差分なし（旧番号の重複ファイルを除去） |
| 差分の空白・秘密検査 | git diff --check、preflight secret scanともPASS |

preflightは--database-urlを上記の専用DBに明示し--skip-buildで実行、ビルドは別途実施。本番コピーのbaseline比較は今回はスキップし、③の最新バックアップ検証を参照する。今回のDBは架空データだけで、本番バックアップの再取得・復元はしていない。サーバーを停止し、専用データディレクトリも削除した。

最初のローカルDB起動ではWindowsの子プロセスが標準出力を保持して待機したため、専用サーバーを停止しpg_ctlの入出力を切り離して完了した。最初のLintは過去の.qa画面確認用ファイル2つを拾ったため、.qaを除外して製品コードの検査を通した。いずれも製品の認証やDB制約を弱めていない。

実機Face ID・カメラ・旧PWAからの引継ぎと、Vercelプレビューの稼働確認は未実施。今回のローカル結果を本番での成功と混同しない。

## merge前・営業再開前の条件

1. ⑤の[環境変数・関数・cronの手順](production-platform-commands.md)、[⑥の当日時刻表](release-day-timetable.md)、[⑦の公開後確認リスト](post-release-device-checklist.md)は作成済み。②の実iPhone確認とスタッフのStaging会計練習は実施報告待ち。公開日決定とClaudeによるPR #11の最終レビューも未完了。
2. 休業中に人が③のDB手順を1本ずつ実行する。30人の人数・照合値が変われば停止。
3. DB成功後に関数・本番フラグを人が設定する。⑤で固定したソースと対象projectを確認する。
4. レビュー後にこのrelease→mainのPRを取り込み、新画面を公開する。mainへ直接pushしない。
5. 新画面と引継ぎを実機で確認したあと、営業再開前にpost_web_security_lockdown.sql（閉鎖B）を人が実行する。
6. 閉鎖B直後に、古いアプリのお客様がどう見えるかと店頭引継ぎを確認する。旧アプリへ戻すだけでは、閉鎖B後の旧入口は戻らない。再登録で代用しない。

⑥では「停止中cronの準備 → 新画面公開・実機確認 → 閉鎖B → 古いアプリの見え方と引継ぎ確認 → 毎分cronの明示開始 → 営業再開」を独立した段にする。

参照：[Viteの環境変数の優先順位](https://vite.dev/guide/env-and-mode)、[Supabase Edgeの環境変数](https://supabase.com/docs/guides/functions/secrets)。
