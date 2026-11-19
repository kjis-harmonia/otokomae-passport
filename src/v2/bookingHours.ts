// アプリの新しい予約を受け付ける時刻（毎日 8:00〜21:00・日本時間・11/19 慶一郎さん）
//   アプリの予約はお店の人が HOT PEPPER（サロンボード）へ手で入れる。夜に入ると朝まで HOT PEPPER 側が空いたままで二重予約になる。
//   本当に止めるのはサーバー（customer_create_hold の app_booking_hours）。ここは日時まで決めてから断られないよう、先に伝えるため
export const APP_BOOKING_OPEN = 8
export const APP_BOOKING_CLOSE = 21

/** いまアプリで新しい予約を受け付けているか（端末の時計を日本時間に直して見る） */
export function appBookingOpen(now: number = Date.now()): boolean {
  const h = new Date(now + 9 * 3600e3).getUTCHours()
  return h >= APP_BOOKING_OPEN && h < APP_BOOKING_CLOSE
}

export const APP_BOOKING_HOURS_TEXT = 'アプリのご予約は、毎日 8:00〜21:00 に承っています。\n朝8時からもう一度お試しいただくか、HOT PEPPER Beauty でご予約ください。'
