# 銀二郎 男前パスポート

## 概要

銀二郎 男前パスポートは、理容店向けのMVPアプリです。
会員証、毎日ガチャ、スタンプ、ランク、クーポン、髪型試着、予約相談、マイページの主要導線をLocalStorageベースで確認できます。

## 技術構成

- React
- TypeScript
- Vite
- Tailwind CSS
- lucide-react
- framer-motion
- LocalStorage

## 起動方法

Windows環境では以下を実行します。

```bash
npm.cmd run dev
```

表示されたローカルURLをブラウザで開いて確認します。

## build方法

```bash
npm.cmd run build
```

## PWAメモ

- ホーム画面追加対応のため `public/manifest.json` を追加しています。
- `public/icons/icon-192.png` と `public/icons/icon-512.png` は、本番前に銀二郎公式アイコンへ差し替えてください。
- 現在の `icon-192.png` / `icon-512.png` は黒金トーンの仮アイコンです。
- favicon は現在、仮アイコン `icon-192.png` を使用しています。
- 本番前に銀二郎公式ロゴ入りの `icon-192.png` / `icon-512.png` に差し替えてください。
- service worker、push通知、オフラインキャッシュ、本格的なPWAインストール制御は将来対応です。

## ホーム画面追加の確認手順

1. `npm.cmd run dev` で起動します。
2. 表示された Local URL をスマホまたはPCブラウザで開きます。
3. Chrome DevTools の `Application` タブを開きます。
4. `Manifest` で `manifest.json` が読み込まれていることを確認します。
5. `icon-192.png` / `icon-512.png` が認識されていることを確認します。
6. `theme_color` が `#0D0D0D` になっていることを確認します。

### スマホでの確認メモ

iPhone / Safari:

- 同一ネットワークで確認する場合は、PCのローカルIPを使ってアクセスします。
- Safariで開き、共有ボタンから「ホーム画面に追加」を選びます。
- アイコンとアプリ名が表示されることを確認します。

Android / Chrome:

- Chromeで開きます。
- メニューから「ホーム画面に追加」を選びます。
- アイコンとアプリ名が表示されることを確認します。

### PWA確認時の注意事項

- 現在のアイコンは仮アイコンです。
- 本番前に銀二郎公式ロゴ入りPNGへ差し替えてください。
- service workerは未実装のため、完全なオフライン対応はまだしません。
- push通知は未実装です。
- 本番デプロイ後にHTTPS環境で再確認してください。

## 本番前TODO

- [ ] 本番用 `icon-192.png` / `icon-512.png` を銀二郎公式ロゴ入りPNGへ差し替える
- [ ] `manifest.json` の `name` / `short_name` / `theme_color` を最終確認する
- [ ] Vercel などHTTPS環境へデプロイする
- [ ] スマホ実機でホーム画面追加を確認する
- [ ] iPhone Safariで表示確認する
- [ ] Android Chromeで表示確認する
- [ ] 5タブすべて実機で操作確認する
- [ ] ガチャ、クーポン、スタンプ、特典使用を実機で確認する
- [ ] LocalStorage初期化手順を確認する
- [ ] 公式ロゴ・店舗写真・本番文言へ差し替えるか確認する
- [ ] service worker / push通知 / オフライン対応を実装するか判断する

## 主要機能一覧

- 男前パスポート会員証
- 毎日ガチャ
- スタンプ獲得
- 経験値・ランクアップ
- スタンプ10個特典
- クーポン獲得・使用
- 髪型バーチャル試着
- 予約相談
- マイページ
- 最近の活動表示

## 手動確認チェックリスト

- 5タブが切り替わる
- HomeのQuickActionが動く
- ガチャが回せる
- スタンプ+1が反映される
- 経験値+1でランクが変わる
- 100円OFFクーポンがMyPageに表示される
- クーポンを使用済みにできる
- スタンプ10個で特典使用ボタンが出る
- 特典使用でstampCountが0になる
- 試着選択が保存される
- 予約相談が保存される
- ページ更新後も状態が残る

## LocalStorageキー一覧

- `otokomae_member_status`: 会員状態、ランク、スタンプ、経験値
- `otokomae_gacha_date`: ガチャ実行日
- `otokomae_gacha_result`: ガチャ結果
- `otokomae_coupons`: クーポン一覧
- `otokomae_tryon_style`: 試着で選択した髪型
- `otokomae_reserve_menu`: 予約相談で選択したメニュー
- `otokomae_reserve_time`: 予約相談で選択した時間帯

## テストデータ投入例

Chrome DevToolsを開き、`Application` → `Local Storage` → 対象URLを選択して、各キーの値を編集します。
値はJSON文字列として保存します。

### スタンプ10個確認用

キー: `otokomae_member_status`

```json
{
  "memberName": "Guest",
  "rank": "BRONZE",
  "visitCount": 3,
  "stampCount": 10,
  "exp": 0
}
```

投入後にページを更新し、MyPageで特典使用ボタンが表示されることを確認します。

### クーポン確認用

キー: `otokomae_coupons`

```json
[
  {
    "id": "coupon-100off-test",
    "title": "100円OFF",
    "description": "次回来店時に使える100円OFFクーポン",
    "createdAt": "2026-05-01",
    "used": false
  }
]
```

投入後にページを更新し、MyPageでクーポンが表示されることを確認します。
「使用する」を押してOKすると、該当クーポンの`used`が`true`になり、未使用一覧から消えます。

### ガチャ結果を再確認したい場合

同じ日にガチャをもう一度確認したい場合は、以下のキーを削除してからページを更新します。

- `otokomae_gacha_date`
- `otokomae_gacha_result`

## 注意事項

- このMVPはLocalStorageで状態を保持します。
- ブラウザやURLが変わるとLocalStorageの保存先も変わります。
- 外部API連携、店舗側承認、QRコード利用、有効期限チェックは未実装です。
- 手動確認時に状態を初期化したい場合は、対象URLのLocalStorageを削除してください。
