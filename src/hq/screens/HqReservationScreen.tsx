import { isHqPreview } from '../hqPreview'

export function HqReservationScreen() {
  if (isHqPreview()) return <p className="hq-sb-preview">予約台帳は銀二郎SBの実データ画面です。サンプル表示では接続しません。</p>
  // SBそのものを同じオリジンで表示する。店舗セッション・操作者・送信中の予約を共有し、
  // 本部側に別の予約ロジックやスタッフ認証の迂回を作らない。
  return <iframe className="hq-sb-frame" title="銀二郎SB 予約台帳" src="/sb" allow="microphone; clipboard-write" />
}
