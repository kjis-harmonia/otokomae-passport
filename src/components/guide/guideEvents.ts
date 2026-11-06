// 使い方ガイドを開く合図（店舗端末・SB のどこからでも）
export const GUIDE_OPEN_EVENT = 'ginjiro-guide:open'

/** どこからでもガイドの「これから何を行いますか？」を開く */
export function openStaffGuide() { window.dispatchEvent(new Event(GUIDE_OPEN_EVENT)) }
