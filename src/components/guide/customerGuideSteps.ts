// お客様アプリ（銀二郎app）の使い方ガイド：作業ごとの手順。書き方は guideSteps.ts（店舗端末）と同じ。
// 押す場所は各画面の data-guide。画面の中身（銀ちゃんの会話・いつもの/お連れ様・最初の案内・会計）は変えず、目印だけ付けている。
import { launched } from '../../utils/launch'
import { isStaging } from '../../utils/env'
import type { GuideStep, GuideTask } from './guideSteps'

const g = (name: string) => `[data-guide="${name}"]`

// ガチャの解禁日（V2Gacha と同じ。Staging はいつでも開いている）
const GACHA_OPENS = '2026-11-11'
// 11/11：新しい銀二郎と同時に 12:00（launched）で解禁
// Staging はいつでも回せる（試すため）。本番は 12:00（launched）まで閉じたまま（11/11 慶一郎さん）
const gachaOpen = () => isStaging() || (launched() && new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) >= GACHA_OPENS)

// 銀ちゃんの会話（GinChat）：いま聞いていることが data-ask に入る
//   verify・who・menu・when・time・yesno・confirm・done、話している途中は wait
const CHIPS = (...asks: string[]) => asks.map(a => `${g('lc-chips')}[data-ask="${a}"]`).join(', ')
const ASK = (...asks: string[]) => asks.map(a => `${g('lc')}[data-ask="${a}"]`).join(', ')
/** その段階が終わった（ほかの段階に進んだ）。話している途中（wait）は、まだ終わっていない */
const PAST = (...asks: string[]) => `${g('lc')}${[...asks, 'wait'].map(a => `:not([data-ask="${a}"])`).join('')}`
const TALKING = ASK('wait')

const HOME: GuideStep = { target: g('tab-home'), text: '下の「ホーム」を押してください', skipIf: `${g('home-cta')}, ${g('lc')}` }
const MENU_OPEN = (done: string): GuideStep => ({ target: g('menu-open'), text: '右上の ☰ を押してください', skipIf: `${g('menu-people')}, ${done}` })
const MENU_PEOPLE = (done: string): GuideStep => ({ target: g('menu-people'), text: '「いつもの・お連れ様」を押してください', skipIf: done })

export const CUSTOMER_GUIDE_TASKS: GuideTask[] = [
  {
    id: 'c-first',
    title: 'はじめての方へ',
    sub: '次のご来店で、会員QRをスタッフに',
    steps: [
      { target: g('tab-qr'), text: '下の「会員QR」を押してください', skipIf: g('qr-card') },
      { target: g('qr-card'), next: true, read: true, text: '次のご来店で、この画面をスタッフにお見せください', sub: '確認が済むと、銀ちゃんのAI予約が使えます。' },
    ],
  },
  {
    id: 'c-book',
    title: '銀ちゃんとAI予約する',
    sub: '話しかけるか、ボタンを押すだけ',
    // 銀ちゃんの会話の中を案内する（ほかの作業は、会話が出ている間は休む）
    inside: g('lc'),
    steps: [
      HOME,
      { target: g('home-cta'), noJump: true, skipIf: g('lc'), label: '.v2-cta-text b', text: '下の「{label}」を押してください', sub: '銀ちゃんがご予約をお聞きします。' },
      // 本人確認がまだの方は、銀ちゃんが会員QRを案内する。そこで案内を終える
      {
        target: CHIPS('verify'), optional: true, waitWhile: TALKING, next: true, stopHere: true, nextLabel: 'わかりました',
        text: 'はじめに、お店で本人確認をします', sub: '次のご来店で「会員QR」をスタッフにお見せください。確認が済むと、銀ちゃんのAI予約が使えます。',
      },
      { target: g('lc-input'), next: true, waitWhile: TALKING, text: '話しかけても、文字で書いても答えられます', sub: '左のマイクを押すと声で、ここに書いて送ると文字で。下のボタンを押しても進めます。' },
      // お連れ様がいない方は出ない
      { target: CHIPS('who'), optional: true, waitWhile: TALKING, until: PAST('who'), text: 'どなたのご予約か押してください', sub: 'ご一緒の方も押して選び、【次へ】を押すと、まとめてお取りします。' },
      // いつものがある方・髪型の写真から来た方は「はい／ほかのメニュー」、メンテナンスの期限内の方は3つから
      {
        target: CHIPS('menu', 'yesno'), optional: true, waitWhile: TALKING, until: PAST('menu', 'yesno'), text: 'メニューを押してください', sub: 'ほかのメニューは「一覧から選ぶ」から選べます。',
        alts: [{ when: CHIPS('yesno'), text: 'このメニューでよろしければ「はい」を押してください', sub: '違うときは「ほかのメニュー」を押してください。' }],
      },
      // 担当（1人の予約のとき）。続けて「いつもの担当に登録しますか？」が出たら、その説明も
      {
        target: CHIPS('staff', 'yesno'), optional: true, waitWhile: TALKING, until: PAST('staff', 'yesno'), text: 'ご担当を押してください',
        sub: 'いつもの担当なら「はい」、どちらでもよければ「どちらでも」を押してください。',
        alts: [{ when: CHIPS('yesno'), text: '次回からも同じ担当にするか選んでください', sub: '登録すると、次から選ぶのが楽になります。' }],
      },
      { target: CHIPS('when'), waitWhile: TALKING, until: PAST('when'), text: 'ご来店はいつ頃か押してください', sub: '「最短で」はいちばん早い空き、「土日希望」は土日、「日付を選ぶ」はカレンダーから選べます。' },
      // 「日付を選ぶ」のときだけ
      { target: g('lc-cal'), optional: true, waitWhile: TALKING, until: ASK('time', 'ticket', 'confirm', 'done', 'ended'), text: 'ご希望の日を押してください', sub: '空きのある日だけ押せます。' },
      { target: CHIPS('time'), waitWhile: TALKING, until: ASK('ticket', 'confirm', 'done', 'ended'), text: 'ご希望の時間を押してください', sub: '合わないときは「ほかの日」を押してください。' },
      // お持ちの券があるときだけ
      { target: CHIPS('ticket'), optional: true, waitWhile: TALKING, until: ASK('confirm', 'done', 'ended'), text: 'このご予約で使う券を押してください', sub: '使わないときは「券を使わない」。ご来店のときのお会計で差し引きます。' },
      {
        target: g('lc-book'), waitWhile: TALKING, until: ASK('done', 'ended'), text: '内容を確かめて【この内容で予約する】を押してください',
        sub: '予約はこのボタンを押したときに入ります。途中で「やっぱり土曜」「アイパーにする」と言えば、そこだけ直せます。',
      },
      { target: CHIPS('done'), until: ASK('ended'), next: true, read: true, text: 'ご予約できました', sub: '下の「次回予約」でいつでもご確認いただけます。' },
    ],
  },
  {
    id: 'c-usual',
    title: 'いつものを登録・変更する',
    sub: 'ご本人のいつものメニュー',
    inside: '.v2-sheet', // ☰メニュー・いつもの・お連れ様の中を案内する
    steps: [
      MENU_OPEN(g('people-owner-edit')),
      MENU_PEOPLE(g('people-owner-edit')),
      {
        target: g('people-owner-edit'), skipIf: g('people-menus'), text: 'ご本人の「変更」を押してください',
        sub: 'ご来店のあとは、次にアプリを開いたとき銀ちゃんが「〇月〇日は〇〇でしたね」とお聞きして、いつものに登録することもできます。',
      },
      { target: g('people-menus'), text: 'いつものにするメニューを押してください', sub: '押すと保存されます。' },
    ],
  },
  {
    id: 'c-people',
    title: 'お連れ様を登録・管理する',
    sub: 'ご家族・ご友人と一緒に予約',
    inside: '.v2-sheet',
    steps: [
      MENU_OPEN(`${g('people-add')}, ${g('people-name')}`),
      MENU_PEOPLE(`${g('people-add')}, ${g('people-name')}`),
      { target: g('people-add'), skipIf: g('people-name'), text: '「お連れ様を追加」を押してください' },
      // 入れている間は吹き出しを休ませる。入れ終わって欄から離れると次へ
      { target: g('people-name'), text: 'お名前を入れてください', sub: 'お店でお呼びするお名前です（例：父、たろう）。' },
      { target: g('people-menus'), text: 'お連れ様のいつものメニューを押してください', sub: '押すと保存されます。' },
      { target: g('people-list'), next: true, read: true, text: 'お連れ様が登録されました', sub: '次から銀ちゃんの予約で、お名前を押すだけで予約できます。' },
      { target: g('people-remove'), optional: true, next: true, text: '削除するときは「削除」を2回押します', sub: '削除しても、予約と来店の記録は残ります。' },
    ],
  },
  {
    id: 'c-next',
    title: '予約を確認・変更する',
    sub: '日時の確認・変更・キャンセル',
    steps: [
      { target: g('tab-next'), text: '下の「次回予約」を押してください', skipIf: g('next-panel') },
      {
        target: g('next-panel'), next: true, read: true, text: 'ご予約の日時・メニュー・担当が出ます',
        // 予約が無い方（11/11 案内の点検：「現在、ご予約はありません」と食い違っていた）
        alts: [{ when: `${g('next-panel')}:not(:has(${g('next-change')}))`, text: 'ご予約が入ると、ここに日時・メニュー・担当が出ます', sub: '「AI予約する」から、銀ちゃんに予約をお伝えください。' }],
      },
      { target: g('next-change'), optional: true, next: true, text: '変更・キャンセルはここから', sub: 'お電話でも承ります。' },
    ],
  },
  {
    id: 'c-tickets',
    title: 'チケットを見る・使う',
    sub: '割引券・特典・プレゼント',
    inside: '.v2-sheet',
    steps: [
      { target: g('menu-open'), text: '右上の ☰ を押してください', skipIf: `${g('menu-tickets')}, ${g('wallet')}` },
      { target: g('menu-tickets'), text: '「すべてのチケット」を押してください', skipIf: g('wallet') },
      // お持ちの券は「割引チケット」タブに出る（最初はカットクーポンのタブ）
      { target: g('wallet-other'), text: '右の「割引チケット」を押してください', skipIf: `${g('wallet-other')}[aria-pressed="true"]` },
      { target: g('wallet'), next: true, read: true, noDim: true, text: 'お持ちのチケットが並びます', sub: 'ご来店時は「会員QR」をお見せください。' },
    ],
  },
  {
    id: 'c-gacha',
    title: 'ガチャを回す',
    sub: '1日1回無料・ハズレなし',
    available: gachaOpen,
    steps: [
      { target: g('tab-gacha'), text: '下の「ガチャ」を押してください', skipIf: g('gacha-start') },
      { target: g('gacha-start'), text: '「本日のガチャを回す」を押してください', sub: '当たった券は AI予約で使えます。音が出ます。' },
    ],
  },
  // 景品を狙ってポイントをためる（11/11 慶一郎さん）。決まりは DB の gacha_gauge と同じ：
  //   ガチャ1回 0.1pt・月 1pt まで（その月にご来店があると景品のポイントへ）／ガチャ券を使ったご来店でメニュー 5,000円以上 1pt・3,000円以上 0.5pt
  {
    id: 'c-gauge',
    title: '景品を狙ってポイントをためる',
    sub: '狙う景品の選び方・メーターのたまり方',
    available: gachaOpen,
    steps: [
      { target: g('tab-gacha'), text: '下の「ガチャ」を押してください', skipIf: g('gauge') },
      // もう狙う景品を選んでいる方：「変える」から選び直せる
      { target: g('gauge-change'), optional: true, next: true, skipIf: g('gauge-goals'), text: '狙う景品は「変える」から選び直せます', sub: '上ほど高い景品で、必要なポイントが多くなります。' },
      { target: g('gauge-goals'), optional: true, text: '狙う景品を押してください', sub: '上ほど高い景品で、必要なポイントが多くなります。あとから「変える」で選び直せます。' },
      {
        target: g('gauge-month'), optional: true, next: true, read: true, text: 'ガチャを回すと、ここが 0.1pt ずつたまります',
        sub: 'ひと月 1pt までです。その月にご来店があると、たまった分が狙っている景品のメーターに入ります。',
      },
      {
        target: g('gauge'), next: true, read: true, text: 'ご来店でも、景品のメーターがたまります',
        sub: 'ガチャ券を使ってご来店すると、メニュー 5,000円以上で 1pt・3,000円以上で 0.5pt。いっぱいになったら「受け取る」で券に交換できます。',
      },
    ],
  },
  // 初めて開いたときに1回だけ：使い方の場所
  {
    id: 'c-hint',
    title: '使い方',
    sub: '',
    hidden: true,
    quiet: true,
    steps: [{ target: g('guide-open'), next: true, nextLabel: 'わかりました', text: '使い方はここから見られます', sub: '予約のしかたなどを、順番にご案内します。' }],
  },
]
