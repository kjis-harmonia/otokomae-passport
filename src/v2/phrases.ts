// 銀ちゃんの吹き出しを、文節のまとまりで折り返す（11/11 慶一郎さんの iPhone で「いつ頃がよろ／しいですか？」）
//   CSS の word-break: auto-phrase は Chrome だけ。iPhone の Safari は効かないので、Intl.Segmenter（Safari 14.1〜）で
//   語に分けて、助詞・助動詞・句読点を前の語につなげたまとまりを返す。まとまりは画面で 1 つの塊（inline-block）にする
const TAIL = /^[\p{Script=Hiragana}ー〜]{1,3}$/u // 「は」「が」「です」「ます」「ので」など短いひらがなは前につなぐ
const PUNCT = /^[\s、。，．,.!！?？…・：:」』）)】〕〉》]+$/u // 閉じかっこ・句読点も前に
const OPEN = /^(?:[「『（(【〔〈《]+|[おご御])$/u // 開きかっこ・「お」「ご」（ご来店・お連れ様）は次につなぐ

type Seg = { segment: string; isWordLike?: boolean }

/** 1 行の文を、折り返してよい「まとまり」に分ける。Segmenter が無い端末は文のまま 1 つで返す（今まで通りの折り返し） */
export function phrasesOf(line: string): string[] {
  const S = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => { segment(s: string): Iterable<Seg> } }).Segmenter
  if (!S || !line) return [line]
  let segs: Seg[]
  try { segs = [...new S('ja', { granularity: 'word' }).segment(line)] } catch { return [line] }
  const out: string[] = []
  let pendingOpen = ''
  for (const { segment: s } of segs) {
    if (OPEN.test(s)) { pendingOpen += s; continue }
    const prev = out[out.length - 1] ?? ''
    const glue = out.length > 0 && !pendingOpen && (PUNCT.test(s) || TAIL.test(s)
      // 数と単位（10月・27日・100円・2名・30分）、「¥4,000」「※ガチャ」、1字の漢字＋次（銀＋二郎）、「いつ頃」
      || (/[0-9０-９]$/.test(prev) && /^[年月日時分秒円名件人回歳枚個pt]/.test(s))
      || /[¥￥※#＃]$/.test(prev) || /^[\p{Script=Han}]$/u.test(prev) || /^[頃様]/.test(s)
      // カタカナの続き（テイ＋テイ・パンチ＋パーマ）はひとつに
      || (/[\p{Script=Katakana}ー]$/u.test(prev) && /^[\p{Script=Katakana}ー]/u.test(s)))
    if (glue) out[out.length - 1] += s
    else { out.push(pendingOpen + s); pendingOpen = '' }
  }
  if (pendingOpen) out.push(pendingOpen)
  return out
}
