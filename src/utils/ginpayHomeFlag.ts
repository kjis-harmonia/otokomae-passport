// Home の GINPay テスト表示は Staging / テスト端末だけで有効化する。
// 未設定・false の Production ビルドでは DOM に描画しない。
export const GINPAY_HOME_ENABLED: boolean = import.meta.env.VITE_GINPAY_HOME_ENABLED === 'true'
