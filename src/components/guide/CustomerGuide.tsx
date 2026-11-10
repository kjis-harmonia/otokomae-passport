import { GuideRunner, type GuideWords } from './GuideRunner'
import { CUSTOMER_GUIDE_TASKS } from './customerGuideSteps'
import { CUSTOMER_GUIDE_OPEN_EVENT } from './guideEvents'

// お客様アプリの使い方ガイド。上の「？」から開く。初めての方には1回だけ「？」の場所を指す。
// 最初の案内・Welcome クーポン・Face ID の案内が出ている間（paused）と、
// お知らせのポップアップ・ホーム画面に追加・ガチャの演出・銀ちゃんの会話が出ている間は何も出さない。
// 銀ちゃんの会話は「銀ちゃんとAI予約する」だけ中を案内する（customerGuideSteps の inside）。
const WORDS: GuideWords = { kicker: '使い方ガイド', title: '何をしますか？', lead: '選ぶと、押す場所を順番にご案内します。', others: 'ほかの使い方を見る' }
// 下から開く画面（☰メニュー・いつもの・お連れ様）・公開の告知と時計の上にも出さない（11/10 夜・11/11）
const COVERS = ['.v2-campaign', '.customer-install-sheet', '.v2-gacha-stage.is-on', '[data-guide="lc"]', '.v2-sheet', '.launch-notice-back', '.launch-layer'].join(', ')

export function CustomerGuide({ paused }: { paused: boolean }) {
  return <GuideRunner ns="customer" tasks={CUSTOMER_GUIDE_TASKS} openEvent={CUSTOMER_GUIDE_OPEN_EVENT} autoTask="c-hint" paused={paused} pauseWhen={COVERS} words={WORDS} chibi />
}
