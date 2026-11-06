import { GUIDE_TASKS } from './guideSteps'
import { GUIDE_OPEN_EVENT } from './guideEvents'
import { GuideRunner } from './GuideRunner'

// 店舗端末の使い方ガイド。店舗端末（/staff）と SB（/sb）の両方に置き、ページが変わっても続きから案内する。
// 本体は GuideRunner（お客様アプリと共通）
export function StaffGuide({ autoOpen = false }: { autoOpen?: boolean }) {
  return <GuideRunner ns="staff" tasks={GUIDE_TASKS} openEvent={GUIDE_OPEN_EVENT} autoOpen={autoOpen} />
}
