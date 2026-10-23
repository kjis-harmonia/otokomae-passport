# ⑤ 本番DB後の環境変数・関数・cron（人が実行する1枚の手順）

**今は実行しない。本番公開は保留。** Codexは下記の変更コマンドを実行していない。休業中に慶一郎さんが1ブロックずつ実行し、失敗・想定外の結果が1つでもあれば停止する。失敗を無視して次へ進めない。全コマンドはWindows PowerShell用。APIキー・PIN・トークンを貼らず、CLIの--debugや環境変数の全件pullも使わない。

| 対象 | 固定値 |
|---|---|
| Supabase本番 | ufyzynpmkxytnhebombq |
| Vercel本番 | kjis-harmonias-projects / otokomae-passport |
| Vercel project ID | prj_gR75Amik4oQrDBY0nNj9hKAsXNII |
| Web / RP ID | https://otokomae-passport.vercel.app / otokomae-passport.vercel.app |
| ソース | release/20261020。アプリ・Edgeは38f9b28と同じ内容。⑤で変えるのは手順・確認器だけ |

全体の順番：③のDB成功 → 下記A〜F（関数・フラグ・停止中cron） → PR #11から新画面公開 → 実機確認 → 閉鎖B → 古いアプリの表示・引継ぎ確認 → 下記Gでキャンセル待ち開始 → 営業再開。⑥で当日の時刻を割り当てる。

**本番スタッフの練習も公開前の条件。** テイテイさんたちにStagingで「会員QR → チェックイン → お会計に進む → 券を選ぶ → 確定」を1回通してもらう。券の単独「使用確定」は公開後になくなる。

## A. DBとソースがそろっているか（読み取り）

③の01〜21と、14/15間の権限閉鎖・承認済み30人の登録が成功したあとだけ進む。③のcheck_21.sqlで履歴44の集合・9表の検査対象値・設定が期待どおりであることを確認済みにする。

```powershell
! & "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/assert-production-platform-source.ps1"
```

次へ：SOURCE OK、release/20261020、リモート最新commitと一致、clean。確認器はoriginのURLを検査し、release参照だけをfetchしてHEADと比較する。fetchできなければ停止。記録したcommitを⑤の最後まで使う。関数ツリー・JWT設定がレビュー済みと違う、未コミット変更、別ブランチなら停止する。

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_platform_ready.sql"
```

次へ：history_count=44、*_readyがすべてtrue、daily_job_count=1、waitlist_job_count=0。notify_enabledとapp_booking_enabledは③で保存した値と同じ。今の本番は履歴24（SB のお知らせ4本を先行適用済み）で来店確認・パスキー・キャンセル待ちが未適用なので、この段階で止まる。**15番適用前にjohnny-agent／johnny-style-adviceを出さない。**

```powershell
! npx --yes supabase@2.121.0 secrets list --project-ref ufyzynpmkxytnhebombq
```

次へ：OPENAI_API_KEY、NOTIFY_SECRET、VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY、VAPID_SUBJECTが存在する。今回は名前だけ確認済み。値の妥当性やVAPIDの鍵ペア一致まで確認したという意味ではない。既存値は再設定・再生成しない。CUSTOMER_ACCESS_ENABLEDがまだ無いのは現状どおりで、Dで追加する。モデル・音声の任意設定とSupabaseが自動注入する値は維持する。秘密の値・digestを報告へ貼らない。

## B. VercelのProductionだけを選ぶ（検査とローカルリンク）

```powershell
! npx --yes vercel@54.18.0 project inspect otokomae-passport --scope kjis-harmonias-projects --non-interactive
```

次へ：project IDが上のprj_…、名前がotokomae-passport、ownerがkjis-harmonia's projects。Stagingプロジェクト、認証待ち、取得不能なら停止。リンクが必要というエラーを無視して設定変更しない。

```powershell
! New-Item -ItemType Directory -Path "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform" -Force | Out-Null
```

```powershell
! npx --yes vercel@54.18.0 link --cwd "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform" --yes --team kjis-harmonias-projects --project prj_gR75Amik4oQrDBY0nNj9hKAsXNII --non-interactive
```

次へ：本番の既存プロジェクトへのリンクだけ成功。新しいプロジェクトの作成はしない。作るのはGit対象外.qa内のCLI用リンクで、アプリやデプロイの変更ではない。

```powershell
! & { $taskLink=Get-Content -LiteralPath "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform/.vercel/project.json" -Raw | ConvertFrom-Json; if ($taskLink.projectId -ne 'prj_gR75Amik4oQrDBY0nNj9hKAsXNII') { throw 'Wrong Vercel project; stop' }; 'PROJECT LINK OK' }
```

```powershell
! npx --yes vercel@54.18.0 project inspect --cwd "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform" --scope kjis-harmonias-projects --non-interactive
```

```powershell
! npx --yes vercel@54.18.0 env ls production --cwd "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform" --scope kjis-harmonias-projects
```

次へ：同じproject ID。ProductionにVITE_SUPABASE_URL・VITE_SUPABASE_ANON_KEY・VITE_APP_ENVがある。値は管理画面で本番project URL・本番公開キー・productionと確認する。秘密のキーをVITE_に設定しない。CLIの一覧で値を検証したことにはしない。既存の接続先や他の変数をこの工程で変更しない。不一致なら停止する。

## C. 関数を1本ずつ（DB成功後、フラグ・cron開始前）

⑥で補強：下の5コマンドは、毎回デプロイの直前にAと同じ確認器を呼ぶ。別ブランチ・ローカルが古い／先行・未コミット変更・不明なorigin・取得失敗・レビュー済みソース不一致なら、npxを一度も呼ばずに停止する。確認後の自動switch／pull／reset／stashや別版での再試行はしない。当日はこのフォルダーで他の作業をしない。ソース確認が成功してもDBの前提を満たした証明にはならないため、AのDB確認も省略しない。

デプロイ前の一覧を保存する（関数名・version・JWTのみ。秘密なし）。

```powershell
! npx --yes supabase@2.121.0 functions list --project-ref ufyzynpmkxytnhebombq --output json
```

現時点の本番：johnny-notify v3、johnny-agent v7（10/20夜に聞き取り修正を本番へ出したため、今は1つ上がっている。当日09:00に記録した値を正とする）、hq-johnny v14、johnny-style-advice v2、4本ともJWT=true。customer-passkeysは未配置。以下は各本で「CLI成功 → 一覧のACTIVE・version更新・JWT → 負のHTTP確認」がそろってから次へ。一覧が期待と違えば停止し、固定のversion番号を推測して進めない。

### C-1. johnny-notify

```powershell
! & "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/deploy-reviewed-production-function.ps1" -Name johnny-notify
```

```powershell
! npx --yes supabase@2.121.0 functions list --project-ref ufyzynpmkxytnhebombq --output json
```

次へ：johnny-notifyがACTIVEで、新版のversionが記録され、verify_jwt=true。--no-verify-jwtを付けない。 ソースはAで確認したものを使う。削除・一括デプロイ・--pruneはしない。

```powershell
! node "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/check-production-edge.mjs" johnny-notify
```
次へ：認証なしGETが401で拒否される。旧版でも401になり得るため、上のversion確認と組み合わせる。これは有効な会員や有料APIの成功試験ではない。

### C-2. johnny-agent

```powershell
! & "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/deploy-reviewed-production-function.ps1" -Name johnny-agent
```

```powershell
! npx --yes supabase@2.121.0 functions list --project-ref ufyzynpmkxytnhebombq --output json
```

次へ：johnny-agentがACTIVEで、新版のversionが記録され、verify_jwt=true。--no-verify-jwtを付けない。 ソースはAで確認したものを使う。削除・一括デプロイ・--pruneはしない。

```powershell
! node "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/check-production-edge.mjs" johnny-agent
```
次へ：認証なしGETが401で拒否される。旧版でも401になり得るため、上のversion確認と組み合わせる。これは有効な会員や有料APIの成功試験ではない。

### C-3. hq-johnny

```powershell
! & "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/deploy-reviewed-production-function.ps1" -Name hq-johnny
```

```powershell
! npx --yes supabase@2.121.0 functions list --project-ref ufyzynpmkxytnhebombq --output json
```

次へ：hq-johnnyがACTIVEで、新版のversionが記録され、verify_jwt=true。--no-verify-jwtを付けない。 ソースはAで確認したものを使う。削除・一括デプロイ・--pruneはしない。

```powershell
! node "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/check-production-edge.mjs" hq-johnny
```
次へ：認証なしGETが401で拒否される。旧版でも401になり得るため、上のversion確認と組み合わせる。これは有効な会員や有料APIの成功試験ではない。

### C-4. customer-passkeys

```powershell
! & "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/deploy-reviewed-production-function.ps1" -Name customer-passkeys
```

```powershell
! npx --yes supabase@2.121.0 functions list --project-ref ufyzynpmkxytnhebombq --output json
```

次へ：customer-passkeysがACTIVEで、新版のversionが記録され、verify_jwt=false。独自の会員セッション・WebAuthn署名を検証するため、この関数だけconfig.tomlのJWT=falseを使う。 ソースはAで確認したものを使う。削除・一括デプロイ・--pruneはしない。

HTTP確認はDのフラグON後に実施する。OFFの503を避けるため、ここでlogin_optionsや認証用POSTを送らない。

### C-5. johnny-style-advice

```powershell
! & "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/deploy-reviewed-production-function.ps1" -Name johnny-style-advice
```

```powershell
! npx --yes supabase@2.121.0 functions list --project-ref ufyzynpmkxytnhebombq --output json
```

次へ：johnny-style-adviceがACTIVEで、新版のversionが記録され、verify_jwt=true。--no-verify-jwtを付けない。 ソースはAで確認したものを使う。削除・一括デプロイ・--pruneはしない。

```powershell
! node "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/check-production-edge.mjs" johnny-style-advice
```
次へ：認証なしGETが401で拒否される。旧版でも401になり得るため、上のversion確認と組み合わせる。これは有効な会員や有料APIの成功試験ではない。

相談用johnny-style-adviceにも来店確認の修正があるため、当初の4本に追加した。主要4本の順序（notify→agent→hq→passkeys）は維持。モデル・プロンプト・本部の有料API方針はこの手順では変更しない。

## D. Face ID・来店確認のフラグをON（まだ新Webは出さない）

```powershell
! npx --yes supabase@2.121.0 secrets set CUSTOMER_ACCESS_ENABLED=true --project-ref ufyzynpmkxytnhebombq
```

```powershell
! node "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/scripts/check-production-edge.mjs" customer-passkeys
```

次へ：本番originのOPTIONS=204・CORSが本番origin、Staging originのOPTIONS=403。設定OFF、別RP ID、未配置、JWT誤設定などで失敗したら停止。確認器はPOSTせず、セッション・チャレンジ・予約を作らない。EdgeのフラグはWebの.env.productionとは別物。

Vercelのフラグは、Bの一覧と管理画面で対象を確認して、**次のどちらか1本だけ**を実行する。VITE_CUSTOMER_ACCESS_ENABLEDは秘密ではなく公開スイッチ。

未登録の場合：

```powershell
! npx --yes vercel@54.18.0 env add VITE_CUSTOMER_ACCESS_ENABLED production --value true --no-sensitive --yes --cwd "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform" --scope kjis-harmonias-projects --non-interactive
```

登録済みで、そのエントリーの対象がProductionだけの場合：

```powershell
! npx --yes vercel@54.18.0 env update VITE_CUSTOMER_ACCESS_ENABLED production --value true --yes --cwd "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform" --scope kjis-harmonias-projects --non-interactive
```

ProductionとPreview等で1エントリーを共有している場合は停止し、Productionだけの設定へ分離してから手順を見直す。--forceで上書きしない。StagingプロジェクトやPreviewの値には触れない。

```powershell
! npx --yes vercel@54.18.0 env ls production --cwd "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/.qa/production-platform" --scope kjis-harmonias-projects
```

次へ：Productionに1つだけ存在し、管理画面でも文字列trueを確認。UIが読めるのは次の新しいビルドから。今の本番ビルドが切り替わったとは扱わない。

## E. 毎分cronを停止状態で用意する（新notify確認後）

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_waitlist_status.sql"
```

次へ：dailyだけ1件、waitlistなし。dailyのschedule・active・command_md5とnotify_enabledを記録する。コマンド本文・Authorization・合言葉は出さない。

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_waitlist_prepare.sql"
```

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_waitlist_status.sql"
```

次へ：johnny-waitlist-minutelyが1件、schedule=* * * * *、active=false、production_notify_url=true、body_is_waitlist=true。dailyのschedule・active・command_md5とnotify_enabledが不変。SQLは既存dailyの認証をDB内でコピーし、本文だけ差し替え、同じトランザクション内で停止する。既存waitlistがあれば上書き・削除せずエラーで止まる。SQL中に秘密はない。ここでは毎分処理は始まらない。

## F. 新画面・閉鎖B・実機の段へ（⑥）

PR #11の公開は別のレビュー済み工程で行う。この⑤にmainへのpush・merge・Vercel本番デプロイを混ぜない。新画面と実機の引継ぎを確認 → ③末尾のpost_web_security_lockdown.sqlと読み取り確認 → 古いアプリの表示・店頭引継ぎを確認、の順。失敗ならEで停止したまま営業再開しない。

**毎分のキャンセル待ちは、本部の「JOHNNYのお知らせ」のenabledを参照しない。** メンテナンス・空き枠のお知らせの「送信を始める」は慶一郎さんの操作に残す。次のGはそれとは別に、実際のキャンセル待ちの仮押さえ・送信を開始する操作。

## G. 公開と閉鎖Bの確認後、営業再開前に毎分cronを開始

前提：Cの新notifyを含む5関数確認済み、Dの両フラグ確認済み、Fの新Web・閉鎖B・古いアプリの引継ぎを実機で確認済み。実際の待ち通知を開始してよい段になったときだけ、人が実行する。SQLは履歴45・閉鎖B・想定どおりの停止ジョブを再確認するが、Webや実機の完了までは自動判定できない。

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_waitlist_activate.sql"
```

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_waitlist_status.sql"
```

次へ：対象1件・毎分・active=true、dailyとnotify_enabledは不変。1〜2分後の同じ読取でrecent_waitlist_runsの新しい行がsucceeded。自動sleepや手動のnet.http_postは実行しない。失敗・HTTP認証エラーは次の停止へ。cronのsucceededはHTTPリクエストをキューへ渡した確認までで、Pushの配達完了ではない。関数ログは管理画面で状態を確認し、会員ID・通知本文・秘密をチャットへ貼らない。実機で通知を受け予約確定まで進む検査は⑦で、同意したテスト会員だけで行う。

## H. 毎分ジョブに問題が出たとき（停止だけ）

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_waitlist_pause.sql"
```

```powershell
! npx --yes supabase@2.121.0 db query --linked --project-ref ufyzynpmkxytnhebombq --output json --file "C:/Users/user/.codex/worktrees/hq-sb-board/otokomae-passport/docs/sql/production_waitlist_status.sql"
```

停止条件：対象1件・active=false、dailyとnotify_enabledは不変。その後は原因を確認するまで開始し直さない。停止前にキューへ入ったHTTP・実行中の処理・すでに作られた仮押さえ／予約／通知は巻き戻らない。会計・券・DB履歴も自動で戻らない。

## 作成時の読み取り確認（2026-10-20）

本番履歴20、daily1件active=true、waitlist0件、notify_enabled=false・上限5。dailyの本番URL・認証ヘッダー・空JSON body1つ・DB/所有者・schedule/alter_jobの署名を値を出さずに確認。必要な既存Secretsは名前のみ確認、CUSTOMER_ACCESS_ENABLEDは未登録。Vercelの本番project ID・owner・Vite設定は読み取り確認。Vercelの変数の値や新デプロイの成功は未確認。**本番にもStagingにも変更を加えていない。**

検証：PostgreSQL 17の架空データ・模擬cronで14項目PASS（途中失敗の完全rollback、履歴不一致、別環境URL、試し送りbody、停止状態の作成、既存ジョブ保護、閉鎖B前の拒否、予約OFFの拒否、開始・再開始拒否・停止・本文変更拒否、daily/通知設定/履歴の保持など）。本物のpg_cron・pg_netや実通知の試験ではない。

HTTP確認器はfetchを差し替えた8ケースPASS。GET/OPTIONS以外を送らないこと、不正statusで停止することを確認し、実通信0。PowerShell確認器の構文、Node構文、migration44本の静的順序・secret scan、差分の空白も検査。変更は手順・運用SQL・確認器だけなので、④のアプリビルドや本番コピー試験は繰り返していない。架空DBは停止・削除し、③のバックアップは保持する。

スタッフのStaging練習・実iPhone確認・本番への適用結果は未完了。

参照：[Supabase関数の公開](https://supabase.com/docs/guides/functions/deploy)、[環境変数](https://supabase.com/docs/guides/functions/secrets)、[Supabase Cron](https://supabase.com/docs/guides/cron)、[Vercel env](https://vercel.com/docs/cli/env)。CLIはこの端末の2.121.0／54.18.0の--helpで確認した書式を使用。
