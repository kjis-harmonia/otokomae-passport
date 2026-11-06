// 使い方ガイドを開く合図（店舗端末・SB のどこからでも）
export const GUIDE_OPEN_EVENT = 'ginjiro-guide:open'

/** どこからでもガイドの「これから何を行いますか？」を開く */
export function openStaffGuide() { window.dispatchEvent(new Event(GUIDE_OPEN_EVENT)) }

// お客様アプリの使い方ガイド（上の「？」から）
export const CUSTOMER_GUIDE_OPEN_EVENT = 'ginjiro-guide:open-customer'
export function openCustomerGuide() { window.dispatchEvent(new Event(CUSTOMER_GUIDE_OPEN_EVENT)) }
