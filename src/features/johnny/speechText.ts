// 読み上げ用の言葉に直す（画面の文字はそのまま）。声の AI は「14日」を「じゅうよんか」と読むことがあるので、
// 「◯日」をひらがなの読みにして渡す（14日→じゅうよっか、20日→はつか、10月1日→ついたち、あと1日→いちにち）。

const ONES = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう']
/** 日の読み（1〜31）。date：日付（10月1日＝ついたち）か、日数（あと1日＝いちにち）か */
function dayReading(n: number, date: boolean): string | null {
  const special: Record<number, string> = { 2: 'ふつか', 3: 'みっか', 4: 'よっか', 5: 'いつか', 6: 'むいか', 7: 'なのか', 8: 'ようか', 9: 'ここのか', 10: 'とおか', 14: 'じゅうよっか', 20: 'はつか', 24: 'にじゅうよっか' }
  if (n === 1) return date ? 'ついたち' : 'いちにち'
  if (special[n]) return special[n]
  if (n < 1 || n > 31) return null
  const tens = Math.floor(n / 10), ones = n % 10
  const t = tens === 0 ? '' : tens === 1 ? 'じゅう' : tens === 2 ? 'にじゅう' : 'さんじゅう'
  // 日付・日数では 7 は「しち」、9 は「く」と読む（じゅうしちにち・にじゅうくにち）
  const o = ones === 7 ? 'しち' : ones === 9 ? 'く' : ONES[ones]
  return `${t}${o}にち`
}

export function toSpeech(text: string): string {
  return text.normalize('NFKC').replace(/(月)?(\d{1,2})日(?!本)/g, (all, month: string | undefined, num: string) => {
    const r = dayReading(Number(num), !!month)
    return r ? `${month ?? ''}${r}` : all
  })
}
