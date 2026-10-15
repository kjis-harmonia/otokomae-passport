// 電話番号の正規化と表示（DB の app_private.normalize_contact_phone と同じ決まり）

/** 数字だけにする（全角・ハイフン・空白・+81 を吸収）。0 始まり 10〜11 桁でなければ null */
export function normalizePhone(raw: string): string | null {
  const d = raw
    .normalize('NFKC')
    .replace(/[^0-9+]/g, '')
    .replace(/^\+?81/, '0')
  return /^0[0-9]{9,10}$/.test(d) ? d : null
}

/** 090-1234-5678 の形で表示 */
export function formatPhone(digits: string): string {
  if (/^0[789]0[0-9]{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
  if (digits.length === 10) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`
  return digits
}
