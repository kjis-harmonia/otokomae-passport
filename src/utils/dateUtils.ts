/** 日本時間（Asia/Tokyo）の日付を YYYY-MM-DD 形式で返す */
export function getJapanDateString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * YYYY-MM-DD 文字列に日数を加算して YYYY-MM-DD を返す。
 * new Date('YYYY-MM-DD') の UTC 解釈によるタイムゾーンズレを回避するため
 * 数値に直接分解して Date を構築する。
 */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const d = new Date(year, month - 1, day)
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** YYYY-MM-DD → YYYY / MM / DD（表示用） */
export function formatDisplayDate(dateStr: string): string {
  return dateStr.replaceAll('-', ' / ')
}
