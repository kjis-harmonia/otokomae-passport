// アプリの新しい予約を受け付ける時刻（営業日の 8:00〜21:00・日本時間・11/19 慶一郎さん）。お正月などの休業日は一日じゅう受け付けない
//   アプリの予約はお店の人が HOT PEPPER（サロンボード）へ手で入れる。夜に入ると朝まで HOT PEPPER 側が空いたままで二重予約になる。
//   本当に止めるのはサーバー（customer_create_hold の app_booking_hours）。ここは日時まで決めてから断られないよう、先に伝えるため
//   休業日は端末では分からないので、サーバーに聞く（customer_app_booking_open）
export const APP_BOOKING_OPEN = 8
export const APP_BOOKING_CLOSE = 21

/** いまアプリで新しい予約を受け付けている時刻か（端末の時計を日本時間に直して見る） */
export function appBookingOpen(now: number = Date.now()): boolean {
  const h = new Date(now + 9 * 3600e3).getUTCHours()
  return h >= APP_BOOKING_OPEN && h < APP_BOOKING_CLOSE
}

// 言い方はお店のお知らせ（11/19 ストーリーズ「銀二郎App AI予約 受付時間変更のお知らせ」）に合わせる
export const APP_BOOKING_HOURS_TEXT = 'アプリのご予約は、営業日の 8:00〜21:00 に承っています。\n時間外のご予約は、HOT PEPPER Beauty をご利用ください。\nご不便をおかけしますが、よろしくお願いいたします。'
