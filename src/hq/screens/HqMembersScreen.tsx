import { HqPanel } from '../components/HqPanel'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'

export function HqMembersScreen() {
  return (
    <HqPanel title="会員分析" code="NO DATA">
      <div style={{ fontFamily: HQ_SANS, color: HQ_COLORS.textSecondary, fontSize: 14, lineHeight: 1.7 }}>
        会員ランク、LTVランキング、新規/離脱トレンドは実データ取得RPCが接続されるまで表示しません。
      </div>
    </HqPanel>
  )
}
