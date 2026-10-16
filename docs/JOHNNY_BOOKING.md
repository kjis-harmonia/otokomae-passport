# Johnny の予約と相談

Shop から予約アシスタントを開く。2026-10-17の統合修正で、旧Shopの確認番号入力を外して予約へ直接進むようにした。予約可否は顧客セッションとサーバー側の受付設定で確認する。
Claude の顧客用 Johnny を Staging の SB・本部と共存させるための実装。

| 入力・操作 | 処理 | OpenAI 呼び出し |
| --- | --- | --- |
| 日時・メニューの指定、空き検索、仮押さえ・確定 | 日時パーサーと顧客用予約 RPC | なし |
| 音声の聞き取り・読み上げ | ブラウザーの音声機能 | なし |
| 料金・所要時間 | サービスマスターから回答 | なし |
| メニュー不明の料金質問 | メニューを聞き返し、選択後に回答 | なし |
| 「おすすめは？」など曖昧な質問 | 希望や悩みを聞き返す | なし |
| 似合う髪型、くせ毛など個別の相談 | johnny-style-advice 経由 | あり |

相談の判定にも GPT は使わない。成功した相談の返事はページ内のメモリに5分・10件まで保持し、同時の重複リクエストは1つにまとめる。顧客セッション・相談文・メニューの内容が違えば共有しない。失敗の自動再試行は行わない。古い相談の返事で新しい入力を上書きしない。

GPT に送るのは相談文（最大300文字）とメニュー表（最大80件）のみ。顧客の登録情報や会話履歴は添付しない。返事は2文・約100文字を指示し、出力上限は300トークン。API キーは Edge Function の OPENAI_API_KEY のみで扱い、既存の OPENAI_MODEL 設定を尊重する。

`booking_settings.app_booking_enabled` を切り替える処理や migration は含まない。OFF の環境は予約を受け付けず、電話の案内を表示する。Edge Function のデプロイ・Secrets の設定もコードの取り込みとは別操作。

検証:

```sh
node scripts/johnny-booking-regression.mjs
node scripts/johnny-consult-cache.test.mjs
node scripts/johnny-edge.test.mjs
npm run build
npm run lint
```

開発時だけ `?johnny=demo` で模擬の予約・連絡先・相談を使用する。DBへの保存や GPT の課金呼び出しはしない。開発用の表示用予約キャッシュは通常モードと分離する。

方針の参考: [OpenAI: Latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization)（通常処理とキャッシュで LLM の呼び出しを減らす）。

## 今回の検証（2026-10-15）

- 日時・メニュー・質問判定: 95件通過。相談キャッシュ: 11件通過。
- Edge Function: セッション確認、出力上限、実在メニューだけの返却、登録情報・履歴を添付しないことをモックで確認。
- スマートフォン幅390px: 模擬連絡先の入力 → 料金の聞き返し → マスター回答 → 曖昧なおすすめの聞き返し → 髪型相談 → 近い空き時間の提示 → 予約確認 → 完了まで確認。外部API呼び出しは0回。
- TypeScriptと本番ビルドは成功。Johnny関連のlintはエラー・警告0件。全体lintは既存コードの19エラー・5警告が残る（Appの3エラーはStagingの変更前と同じ）。
- Stagingの読み取り確認: 予約受付はfalse、Edge Functionの一覧は空。今回デプロイ・Secrets変更・migration・DBへの書き込みは行っていない。実環境のOpenAI応答は未検証。
