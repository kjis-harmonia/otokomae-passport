import type { MenuOption } from './menuMatcher'

function isStandaloneExtra(menu: MenuOption): boolean {
  const name = menu.name.normalize('NFKC')
  const hair = /カット|フェード|パーマ|濡れパン|アイパー|パンチ|銀パラ|ギンパラ|刈り|カラー|縮毛|ストレート/.test(name)
  return !hair && /顔[そ剃ぞ]り|シェービング|眉|フェイス|耳掃除|鼻毛|シャンプー|ヘッドスパ|トリートメント/.test(name)
}

/** Presentation only: keep every menu, but never promote an unsolicited standalone extra. */
export function orderMenuSuggestions<T extends MenuOption>(menus: readonly T[], lastMenuCode: string | null): T[] {
  const priority = (m: MenuOption) => {
    if (isStandaloneExtra(m)) return 4
    if (m.code === lastMenuCode) return 0
    if (m.code === 'cut-regular' || /^(通常)?カット$/.test(m.name)) return 1
    if (/スキンフェード/.test(m.name)) return 2
    return 3
  }
  return [...menus].sort((a, b) => priority(a) - priority(b))
}

export interface MenuChoice { menu: MenuOption; first: string | null }

/** Narrate the same ordered choices that are shown, using only returned slot evidence. */
export function presentMenuChoices(items: readonly MenuChoice[], lastMenuCode: string | null, slotLabel: (iso: string) => string): { items: MenuChoice[]; say: string } {
  const byCode = new Map(items.map(item => [item.menu.code, item]))
  const ordered = orderMenuSuggestions([...byCode.values()].map(item => item.menu), lastMenuCode).map(menu => byCode.get(menu.code)!)
  const featured = ordered.filter(item => !isStandaloneExtra(item.menu) && item.first && Number.isFinite(Date.parse(item.first))).slice(0, 3)
  const say = featured.length
    ? `${featured.map(item => `${item.menu.name}なら${slotLabel(item.first!)}から`).join('、')}ご案内できます。ご希望のメニューはどれですか？`
    : 'ご希望のメニューをお聞かせください。'
  return { items: ordered, say }
}
