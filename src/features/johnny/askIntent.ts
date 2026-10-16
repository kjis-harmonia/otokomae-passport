// 予約の途中で出る「質問」を見分ける。
//   menu_info：「パンチって何分？」「カラーいくら？」→ メニュー表（DB）の時間・料金で答える（AI は使わない・無料）
//   consult  ：「どんなパーマが似合う？」「おすすめは？」→ AI に相談する（使うのはこのときだけ）
// どちらでもなければ null（今までどおり予約の言葉として読む）
import { matchMenu, type MenuOption } from './menuMatcher.ts'

export type Ask<T extends MenuOption = MenuOption> =
  | { kind: 'menu_info'; menu: T; topic: 'duration' | 'price' | 'both' }
  | { kind: 'consult' }

const DURATION = /何分|なんぷん|なんふん|何時間|なんじかん|どれ(くらい|ぐらい)|どのくらい|かかる|時間(は|って)/
const PRICE = /いくら|値段|ねだん|料金|りょうきん|何円|なんえん|価格/
const CONSULT = /似合|にあう|おすすめ|オススメ|お勧め|相談|そうだん|迷って|まよって|悩んで|なやんで|どれがいい|何がいい|なにがいい|どんな(髪|かみ|パーマ|ぱーま|スタイル|感じ|かんじ)|イメチェン|変えたい|かえたい/

export function detectAsk<T extends MenuOption>(raw: string, menus: readonly T[]): Ask<T> | null {
  const s = raw.normalize('NFKC').replace(/\s+/g, '')
  if (CONSULT.test(s)) return { kind: 'consult' }
  const d = DURATION.test(s)
  const p = PRICE.test(s)
  if (!d && !p) return null
  const menu = matchMenu(s, menus)
  // 時間・料金を聞いているのにメニューが分からないときは、相談として AI に回す
  if (!menu) return { kind: 'consult' }
  return { kind: 'menu_info', menu, topic: d && p ? 'both' : d ? 'duration' : 'price' }
}

function yen(m: MenuOption): string {
  if (m.price == null) return '料金は店頭でご案内します'
  return `${m.price.toLocaleString('ja-JP')}円${m.price_from ? '〜' : ''}`
}

/** メニュー表だけで作る答え（例：「パンチパーマは120分、8,000円です。」） */
export function answerMenuInfo(ask: Extract<Ask, { kind: 'menu_info' }>): string {
  const m = ask.menu
  if (ask.topic === 'duration') return `${m.name}は、だいたい${m.duration_min}分です。`
  if (ask.topic === 'price') return `${m.name}は${yen(m)}です。`
  return `${m.name}は、だいたい${m.duration_min}分、${yen(m)}です。`
}
