// 予約の途中で出る「質問」を見分ける。
//   menu_info：「パンチって何分？」「カラーいくら？」→ メニュー表（DB）の時間・料金で答える（AI は使わない・無料）
//   consult  ：髪型・髪の悩みの相談だけ AI に聞く。曖昧な質問は無料で聞き返す。
// どちらでもなければ null（今までどおり予約の言葉として読む）
import { matchMenu, type MenuOption } from './menuMatcher.ts'

export type MenuInfoTopic = 'duration' | 'price' | 'both'
export type Ask<T extends MenuOption = MenuOption> =
  | { kind: 'menu_info'; menu: T; topic: MenuInfoTopic }
  | { kind: 'clarify_menu'; topic: MenuInfoTopic }
  | { kind: 'clarify_style' }
  | { kind: 'clarify_booking' }
  | { kind: 'consult' }

const DURATION = /何分|なんぷん|なんふん|何時間|なんじかん|どれ(くらい|ぐらい)|どのくらい|かかる|時間(は|って)/
const PRICE = /いくら|値段|ねだん|料金|りょうきん|何円|なんえん|価格/
const ADVICE = /おすすめ|オススメ|お勧め|相談|そうだん|迷って|まよって|悩んで|なやんで|どれがいい|何がいい|なにがいい|変えたい|かえたい/
const STYLE = /髪|かみ|パーマ|ぱーま|カット|かっと|パンチ|ぱんち|濡れパン|ぬれぱん|アイパー|フェード|カラー|からー|スタイル|イメチェン|くせ毛|クセ毛|癖毛|ボリューム/
const STYLE_QUESTION = /似合|にあう|イメチェン|どんな(髪|かみ|パーマ|ぱーま|スタイル)|くせ毛|クセ毛|癖毛|髪.{0,8}(広が|傷|いた|ぺたん|細|硬|かた|柔らか|やわらか)/
const BOOKING = /日時|日付|曜日|時間|何時|いつ|予約|空き|空いて/

export function detectAsk<T extends MenuOption>(raw: string, menus: readonly T[], selectedMenu?: T): Ask<T> | null {
  const s = raw.normalize('NFKC').replace(/\s+/g, '')
  if (STYLE_QUESTION.test(s)) return { kind: 'consult' }
  // 「予約の時間を変えたい」「明日は何時がおすすめ？」も GPT へは送らない。
  if (ADVICE.test(s) && BOOKING.test(s)) return { kind: 'clarify_booking' }
  if (ADVICE.test(s) && STYLE.test(s)) return { kind: 'consult' }
  const d = DURATION.test(s)
  const p = PRICE.test(s)
  if (d || p) {
    const topic = d && p ? 'both' : d ? 'duration' : 'price'
    const menu = matchMenu(s, menus) ?? selectedMenu
    return menu ? { kind: 'menu_info', menu, topic } : { kind: 'clarify_menu', topic }
  }
  if (ADVICE.test(s)) return { kind: 'clarify_style' }
  return null
}

function yen(m: MenuOption): string {
  if (m.price == null) return '店頭でご案内'
  return `${m.price?.toLocaleString('ja-JP')}円${m.price_from ? '〜' : ''}`
}

/** メニュー表だけで作る答え（例：「パンチパーマは120分、8,000円です。」） */
export function answerMenuInfo(ask: Extract<Ask, { kind: 'menu_info' }>): string {
  const m = ask.menu
  if (ask.topic === 'duration') return `${m.name}は、だいたい${m.duration_min}分です。`
  if (m.price == null) return ask.topic === 'price'
    ? `${m.name}の料金は店頭でご案内します。`
    : `${m.name}は、だいたい${m.duration_min}分です。料金は店頭でご案内します。`
  if (ask.topic === 'price') return `${m.name}は${yen(m)}です。`
  return `${m.name}は、だいたい${m.duration_min}分、${yen(m)}です。`
}
