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
  // 名前の先頭2文字以上が発話に含まれ、それが1件だけ
  const partial = menus.filter(m => {
    const n = normalize(m.name)
    for (let len = n.length - 1; len >= 2; len--) if (s.includes(n.slice(0, len))) return true
    return false
  })
  return partial.length === 1 ? partial[0] : null
}
