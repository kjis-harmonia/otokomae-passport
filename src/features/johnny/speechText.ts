// 読み上げ用の言葉に直す（画面の文字はそのまま）。声の AI は「14日」を「じゅうよんか」、「14時」を「じゅうよんじ」と
// 読むことがあるので、日・時・分をひらがなの読みにして渡す
//   14日→じゅうよっか、20日→はつか、10月1日→ついたち、あと1日→いちにち、13日→じゅうさんにち
//   14時→じゅうよじ、19時半→じゅうくじはん、17時15分→じゅうしちじじゅうごふん、120分→ひゃくにじゅっぷん

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

/** 時の読み（0〜24）：4時＝よじ、7時＝しちじ、9時＝くじ、14時＝じゅうよじ、19時＝じゅうくじ */
function hourReading(n: number): string | null {
  if (n < 0 || n > 24) return null
  if (n === 0) return 'れいじ'
  const tens = Math.floor(n / 10), ones = n % 10
  const t = tens === 0 ? '' : tens === 1 ? 'じゅう' : 'にじゅう'
  const o = ones === 4 ? 'よ' : ones === 7 ? 'しち' : ones === 9 ? 'く' : ONES[ones]
  return `${t}${o}じ`
}

const MIN_ONES = ['', 'いっぷん', 'にふん', 'さんぷん', 'よんぷん', 'ごふん', 'ろっぷん', 'ななふん', 'はっぷん', 'きゅうふん']
const MIN_TENS = ['', 'じゅう', 'にじゅう', 'さんじゅう', 'よんじゅう', 'ごじゅう', 'ろくじゅう', 'ななじゅう', 'はちじゅう', 'きゅうじゅう']
/** 分の読み（1〜199）：1分＝いっぷん、10分＝じゅっぷん、15分＝じゅうごふん、30分＝さんじゅっぷん、120分＝ひゃくにじゅっぷん */
function minuteReading(n: number): string | null {
  if (n < 1 || n > 199) return null
  const h = n >= 100 ? 'ひゃく' : ''
  const rest = n % 100, tens = Math.floor(rest / 10), ones = rest % 10
  if (ones === 0) return tens === 0 ? `${h}ぷん` : `${h}${MIN_TENS[tens].slice(0, -1)}っぷん`
  return `${h}${MIN_TENS[tens]}${MIN_ONES[ones]}`
}

export function toSpeech(text: string): string {
  return text.normalize('NFKC')
    .replace(/(\d{1,2})時(?!間)(半)?(?:(\d{1,2})分)?/g, (all, h: string, half: string | undefined, m: string | undefined) => {
      const hr = hourReading(Number(h))
      if (!hr) return all
      if (half) return `${hr}はん`
      if (!m) return hr
      const mr = minuteReading(Number(m))
      return mr ? `${hr}${mr}` : all
    })
    .replace(/(\d{1,3})分/g, (all, m: string) => minuteReading(Number(m)) ?? all)
    .replace(/(月)?(\d{1,2})日(?!本)/g, (all, month: string | undefined, num: string) => {
      const r = dayReading(Number(num), !!month)
      return r ? `${month ?? ''}${r}` : all
    })
}
