import { HqPanel } from '../components/HqPanel'
import { HQ_COLORS, HQ_SANS } from '../hqTheme'

export function HqSettingsScreen() {
  return (
    <HqPanel title="システム設定" code="NO DATA">
      <div style={{ fontFamily: HQ_SANS, color: HQ_COLORS.textSecondary, fontSize: 14, lineHeight: 1.7 }}>
        店舗情報、通知設定、権限設定は実データ取得RPCが接続されるまで表示しません。
      </div>
    </HqPanel>
  )
}
