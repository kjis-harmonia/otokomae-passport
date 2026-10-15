// 話し言葉からメニューを選ぶ。メニューの名前・価格・時間はサービスマスター（customer_booking_options）が正。
// ここでは「どのメニューのことか」を決めるだけで、名前以外の情報は作らない。

export interface MenuOption {
  code: string
  name: string
  duration_min: number
  price: number | null
  price_from?: boolean | null
}

/** 呼び方の揺れ（話し言葉 → メニュー名に含まれる語） */
const ALIASES: [RegExp, string][] = [
  [/ぬれぱん|濡れぱん|ヌレパン/g, '濡れパン'],
  [/めんて|メンテ(?!ナンス)/g, 'メンテナンス'],
  [/ぱんち/g, 'パンチ'],
  [/かっと/g, 'カット'],
  [/ぱーま/g, 'パーマ'],
  [/にぐろ/g, 'ニグロ'],
  [/あいぱー/g, 'アイパー'],
  [/ぎんぱら/g, '銀パラ'],
  [/ていてい|テイテイ/g, 'テイテイ'],
  [/からー/g, 'カラー'],
  [/しぇーびんぐ|そり/g, 'シェービング'],
]

function normalize(s: string): string {
  let t = s.normalize('NFKC').replace(/\s+/g, '')
  for (const [re, to] of ALIASES) t = t.replace(re, to)
  return t
}

/**
 * 発話に名前が含まれるメニュー。複数当たるときは、発話の中で最も長く一致した名前を優先する
 * （「メンテナンスカット」と言えば「カット」ではなくメンテナンスカット）。
 * 名前の一部（「パンチ」→「パンチパーマ」）でも、それが1件に絞れるなら選ぶ。
 */
export function matchMenu<T extends MenuOption>(utterance: string, menus: readonly T[]): T | null {
  const s = normalize(utterance)
  if (!s) return null
  const full = menus.filter(m => s.includes(normalize(m.name)))
  if (full.length > 0) return full.sort((a, b) => normalize(b.name).length - normalize(a.name).length)[0]
  // 名前の先頭2文字以上が発話に含まれるもの。いちばん長く一致したメニューが1件に決まれば、それを選ぶ
  // （「スキンフェード」は「スキンフェードカット」に7文字、「フェイスパック」には「フェ」2文字しか一致しない）
  // 同じ長さで並んだら、名前の残りが短い方（「スキンフェード」→ セットの「スキンフェード&カラー」より「スキンフェードカット」）
  // 名前の後ろ側でも、名前の半分より長く一致すれば候補にする（「カラー」→「ヘアカラー」。「パーマ」だけでは「パンチパーマ」にしない）
  const scored = menus.map(m => {
    const n = normalize(m.name)
    let len = 0
    let head = true
    for (let l = n.length - 1; l >= 2; l--) if (s.includes(n.slice(0, l))) { len = l; break }
    for (let l = n.length - 1; l >= 3 && l > len; l--) if (l * 2 > n.length && s.includes(n.slice(n.length - l))) { len = l; head = false; break }
    return { m, len, head, rest: n.length - len }
  }).filter(x => x.len > 0)
  // 長さ → 先頭からの一致（「スキンフェード」は「子供スキンフェード」より「スキンフェードカット」）→ 残りの短さ、の順に絞る
  const best = Math.max(0, ...scored.map(x => x.len))
  let tied = scored.filter(x => x.len === best)
  if (tied.some(x => x.head)) tied = tied.filter(x => x.head)
  const fewest = Math.min(...tied.map(x => x.rest))
  const top = tied.filter(x => x.rest === fewest)
  return top.length === 1 ? top[0].m : null
}
