// JOHNNY の画面（顧客の STYLE / BOOKING、本部の JOHNNY）は VITE_JOHNNY_ENABLED=true のビルドでだけ表示する。
// サーバー側（Edge Function の JOHNNY_ENABLED）とは別に判定し、どちらも既定は無効（Production では表示しない）。
// 定数なので、無効のビルドでは JOHNNY の画面と呼び出しがバンドルから取り除かれる。
export const JOHNNY_UI_ENABLED: boolean = import.meta.env.VITE_JOHNNY_ENABLED === 'true'
