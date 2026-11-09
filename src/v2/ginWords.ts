// 銀ちゃんの会話：お客様の文から「人」「メニュー」を読み取る小さな部品（11/9 Codex 検査 高：名前の部分一致で別の人まで選ばれていた）
//   試験：scripts/gin-words.test.mjs

/** 文の中に名前が含まれるもののうち、いちばん長い名前のもの（「スペインパーマ&メッシュ」で「スペインパーマ」を選ばない） */
export function longestIn<T>(text: string, list: readonly T[], name: (x: T) => string): T | null {
  let best: T | null = null
  for (const x of list) { const n = name(x); if (n && text.includes(n) && (!best || n.length > name(best).length)) best = x }
  return best
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 文の中に出てくる人（何人でも）。長い名前に含まれる短い名前は、長い名前とは別に書いてあるときだけ数える
 *  例：「太郎丸だけ」→ 太郎丸だけ。「太郎と太郎丸」→ 2人 */
export function namesIn<T>(text: string, list: readonly T[], name: (x: T) => string): T[] {
  const found = list.filter(p => { const n = name(p); return !!n && text.includes(n) })
  return found.filter(p => !found.some(q => {
    const pn = name(p), qn = name(q)
    return q !== p && qn.length > pn.length && qn.includes(pn) && !text.replace(new RegExp(escapeRe(qn), 'g'), '').includes(pn)
  }))
}
