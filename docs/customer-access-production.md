# Face ID・来店確認の本番公開準備（2026-10-20）

**コードの準備・ローカル検証まで。本番DB・Vercel環境変数・Supabase設定・関数のデプロイは変更していない。今すぐ実行する手順ではない。**
`docs/release-runbook.md` と `sql/production_store_verification_backfill.md` のDB手順と同じ休業中の公開作業として扱う。

## 固定する環境

| 環境 | Supabase | 正規のWeb origin / パスキーRP ID |
|---|---|---|
| Staging | kfufxzmucjljjouzpumi | https://otokomae-passport-staging.vercel.app / otokomae-passport-staging.vercel.app |
| 本番 | ufyzynpmkxytnhebombq | https://otokomae-passport.vercel.app / otokomae-passport.vercel.app |

本番ドメインはVercel CLIの読み取りで、プロジェクト `prj_gR75Amik4oQrDBY0nNj9hKAsXNII`、チーム `kjis-harmonias-projects` のverifiedドメインとして確認した。mainは `848679f` のまま。

クライアントとEdgeは同じ私有情報を含まない環境定義を使う。リクエストのOriginやHostからRP IDを作らず、別環境・未知のプロジェクト・プレビューURLからの認証を受け付けない。Stagingのパスキーを本番用として流用しない。本番の会員データを引き継いだうえで、本番の正規URLで一度設定する。

## ④の公開用ブランチでの更新（2026-10-20）

[公開用PRの準備](production-release-pr.md)で、Webの.env.productionにVITE_CUSTOMER_ACCESS_ENABLED=trueを用意した。以下の「OFF」はリモートの現状を指す。SupabaseのCUSTOMER_ACCESS_ENABLEDとVercel Productionの値は未変更で、⑤の公開手順で人がONにする。実画面の発券確認はPR #8でClaudeが完了し、②の実iPhone認証は別の確認として残る。閉鎖Bは新画面と実機確認のあと・営業再開前に適用し、直後に古いアプリの見え方も確認する。

## 機能の切り替え

| 設定 | 場所 | 本番の既定 |
|---|---|---|
| VITE_CUSTOMER_ACCESS_ENABLED | Vercelの本番プロジェクト、Production環境だけ | 未設定・falseはOFF。文字列trueのみON |
| CUSTOMER_ACCESS_ENABLED | 本番Supabaseのcustomer-passkeysが読む環境変数 | 未設定・falseはOFF。文字列trueのみON |

Stagingは従来どおりON。未知のSupabaseプロジェクトは、フラグをONにしても利用不可。プロジェクトのURL・origin・RP IDの組み合わせも一致しなければ、DBを呼ぶ前に拒否する。

`ONE_TAP_STAGING` という名前を `CUSTOMER_ACCESS_ENABLED` に変え、予約・会員引き継ぎ・店舗確認・Face IDのUIが同じ条件を使うようにした。本番のフラグを変更するまでは、現在の本番画面へ機能を出さない。

お客様用の `johnny-agent` と `johnny-style-advice` は、デプロイ後、本番でも必ず店舗確認RPCを先に呼ぶ。未確認・無効なセッション・通信失敗・migration不足では有料APIを呼ばない。これはフロントのフラグで解除できない。**DB完了前にこれらの関数だけを本番へデプロイしない。**
本部 `hq-johnny` の認証やモデル・プロンプトは変更しない。

## 公開時の順序（まだ実行しない）

1. 発券の実画面確認を完了し、公開するcommitを固定する。新しいブランチをStagingへ取り込んだ後の検証結果も確認する。
2. 休業中に店舗の更新操作を止める。コードだけ・DBだけを先に営業中へ出さない。
3. 本番DBを1本ずつ。1〜14 → 旧記録の書き込み権限閉鎖 → 30人の集合を再確認 → 未承認の人だけ登録 → 15〜20。対象が変わった場合や1本でも失敗した場合は止める。Codexは書かず、慶一郎さんがレビュー済みの `!` コマンドを実行する。
4. DBの成功を読み取りで確認してから、レビュー済みのソースから関数を更新する。既存の `johnny-agent`、`johnny-style-advice`、`johnny-notify`、`hq-johnny` と、新設の `customer-passkeys` が対象。customer-passkeys以外のJWT必須設定を外さない。
5. 本番のcustomer-passkeysの機能フラグをONにする。次は**DB完了後に人が実行する例**で、現時点では実行していない。値trueは機能フラグであり秘密の認証情報ではない。

~~~powershell
! npx --yes supabase@2.121.0 secrets set CUSTOMER_ACCESS_ENABLED=true --project-ref ufyzynpmkxytnhebombq
~~~

6. Vercelの `kjis-harmonias-projects / otokomae-passport` のSettings → Environment Variablesで `VITE_CUSTOMER_ACCESS_ENABLED=true` を **Productionだけ** に設定する。Staging用プロジェクトを変更しない。既存値がある場合は重複追加せずその値を更新する。これも公開作業中に人が行い、今回は未変更。
7. 会計のStaging限定条件を外す作業もレビュー済みにしてから、公開用PRでstaging→mainへ進める。mainへ直接pushしない。フラグを設定しただけでは既存ビルドは変わらず、新しいビルドが必要。
8. 新版johnny-notifyを確認してからwaitlistの毎分ジョブへ進む。本部の「JOHNNYのお知らせ → 送信を始める」は慶一郎さんが操作する。
9. 本番の正規URLで、元の会員ID・券・GINPay残高が保たれたこと、店舗の本人確認、パスキー初回設定、再ログイン、予約を実機で確認してから店舗の操作を再開する。

関数デプロイは、ソースの場所とproject-refを明示した人向けのコマンドを、固定commitの確認後に渡す。端末に残っている別ブランチから実行しない。
`supabase/config.toml` のcustomer-passkeysは、通常のSupabase Authログイン前に独自の会員セッションとWebAuthn署名を検証するため `verify_jwt=false`。これを他の関数へ広げない。サービスキーをブラウザーへ渡さない。

本番の読み取り時点で配置済みなのは johnny-agent v7 / johnny-style-advice v2 / johnny-notify v3 / hq-johnny v14。customer-passkeysは未配置だった。新しい版を公開済みという報告ではない。
旧ショートカットAPIはStaging限定のまま。今回、複雑な連携キー設定を本番へ復活させる作業は含めない。

## 発券画面を本物のPINなしで確認する

コードの確認用サーバーはlocalhostの架空会員・架空発券だけを扱い、外部DBや有料APIへ転送しない。製品のログインや権限を変更する機能ではない。

~~~powershell
node scripts/test-helpers/issuance-ui-fixture.mjs
~~~

ブラウザーで `http://127.0.0.1:5198/staff?qa=issue-recovery` を開き、店舗メニューのチケット・QRの画面へ進む。検証専用の保存情報がlocalhostに作られるので、プライベートウィンドウで使う。

- 320 / 390 / 412px幅で、架空会員の500円×2枚の確認待ち案内と再確認ボタンが読める。
- 「同じ発行を確認・再試行」後に成功し、更新後は確認待ち案内が消える。
- `http://127.0.0.1:5198/__qa/status` で外部転送false、同一番号の発行記録が1つだけと確認する。
- 終了はCtrl+C。実際の会員QR・店舗PINを入力しない。これは本物のカメラ読取や本番への発券テストの代わりではない。

起動・HTMLへの架空状態の準備・同一番号に同じ券を返すこと・外部転送なしはHTTPで検証済み。実画面はブラウザー操作ツールに利用可能なブラウザーがないため、Codexでは未確認。

## 検証

- 回帰テスト57件PASS。署名付きの登録・ログインを実際のEdgeハンドラーへ通し、両環境で成功。反対環境のorigin/RP ID・不正署名・本人確認なし・チャレンジ再利用などは拒否。
- クライアントの接続先と機能フラグ、実際のDenoエントリーのフラグ読み取りを検証。
- 両環境で有料AI前の来店確認を検証。会話・STT・TTS・相談の未確認セッションからの有料API呼び出しは0。
- 型チェック、通常ビルド、本番フラグONのローカルビルド成功。実際の本番フラグは未変更。
- 全体Lintはエラー0、既存SB警告1。migration44本の静的順序・秘密情報検査PASS（DB適用スキップ）。
- 実iPhoneのFace IDと、店舗端末の実発券は未完了。ソフトウェア署名テストと実機確認を区別する。

参考：[SimpleWebAuthnのサーバー検証](https://simplewebauthn.dev/docs/packages/server)、[SupabaseのCORS](https://supabase.com/docs/guides/functions/cors)。既存のSimpleWebAuthn 13.3.3を維持し、ライブラリー更新は行っていない。
