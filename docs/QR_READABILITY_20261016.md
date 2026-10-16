# 銀二郎 QRの読み取り改善

2026-10-16。Staging反映済み。本番・DB・予約受付設定は変更していない。

https://otokomae-passport-staging.vercel.app/

Vercel: `dpl_EV6x5nfGpN56xdiGF6hX8weM5X28` / READY

| 対象 | 変更前 | 変更後 |
|---|---|---|
| 会員QR | 通常108px、拡大には追加タップが必要。カードが上下に動く | 最初から最大300pxで静止表示。320pxの画面でも約247px |
| チケット・メンテナンスQR | 188px、QR自身の余白なし | 最大280px、四方に4セルの白い余白 |
| 会員画面 | 装飾と復旧情報を常時表示 | 白地・黒QRを中心に、復旧情報は折りたたみ |
| 店舗カメラ | 中央220pxを切り出して認識 | 映像全体で認識。背面カメラ・1280×960をideal指定し、QR形式に絞る |
| キーボード | QR画面のフォーカス管理なし | 会員QRでフォーカスを移動・保持、Escapeで閉じて元のボタンへ戻す |

会員ID、氏名、予約情報、チケット有効期限などのQR内容は維持。認証情報や電話番号を追加していない。

## 確認

- 実際のReactコンポーネントからSVGを生成し、画像化して別のQRデコーダーで復元する25項目がPASS。
- 会員・予約情報付き会員・チケット・メンテナンスの4種類を300/260/240px、ぼかしあり/なしで確認。
- 会員QRは320×640、390×740、768×1024の画面幅で確認。390pxではQRが300px、320pxでは247pxで横にはみ出さない。
- チケットQRは390px幅で280px。復旧情報の開閉、Escapeでの閉じる操作とフォーカス復帰も確認。
- 疑似カメラ起動 → 会員QR読み取り → 会員情報・チェックイン表示まで確認。実カメラは使用していない。
- ビルドと新規コンポーネントのlintがPASS。既存の発行・カメラ終了・ウォレット回帰テスト22項目もPASS。差分lintの追加問題0。
- 配信先はStaging専用プロジェクト。ローカル画面確認は外部へ転送しない疑似APIのみ使用。

**実機のカメラ・ピント・照明・画面反射を含む読取精度は未確認。画像テストの成功は、すべての実機で必ず読み取れるという保証ではない。**

## 再実行

作業worktree: `C:\Users\user\.codex\worktrees\hq-sb-board\otokomae-passport`

```powershell
npm install --prefix .qa/qr --no-save --package-lock=false @resvg/resvg-js jsqr
node scripts/qr-readability.test.mjs
npm run build
node scripts/verify-staging-static.mjs
```

QAライブラリは.gitignore/.vercelignoreで除外した`.qa/qr`に置き、アプリのdependenciesは増やしていない。

仕様の参照: [qrcode.react](https://github.com/zpao/qrcode.react)、[カメラ認識領域](https://scanapp.org/html5-qrcode-docs/docs/apis/interfaces/Html5QrcodeCameraScanConfig)。
