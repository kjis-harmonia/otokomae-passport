// 店舗端末の使い方ガイド：作業ごとの手順。
// target＝囲む場所（data-guide の名前）。押したら次へ進む。
// until＝この場所が出たら次へ（カメラで読む・保存が終わる など、押す場所が無い手順）。
// skipIf＝これが画面にあれば、この手順は済んでいるので飛ばす。
// optional＝しばらく待っても場所が出なければ飛ばす（予約で入っている・券が無い など）。
// next＝押さずに「次へ」で進む手順。
// noJump＝先に進んだときの追いつき先にしない（いつも画面にある場所・前の結果が残る場所）。

export type GuideStep = {
  target?: string
  text: string
  sub?: string
  until?: string
  skipIf?: string
  optional?: boolean
  next?: boolean
  noJump?: boolean
  /** まわりを暗くしない（入力欄をいくつも埋める手順） */
  noDim?: boolean
}

export type GuideTask = { id: string; title: string; sub: string; steps: GuideStep[] }

const g = (name: string) => `[data-guide="${name}"]`

const OPERATOR: GuideStep = {
  target: g('operator'),
  text: 'まず、自分の名前を押す',
  sub: '会計やチャージの記録に、押した人の名前が残ります。',
  skipIf: `${g('operator')} [aria-pressed="true"]`,
}

/** 会員QRのお会計。支払い方法の手順だけ「現金（PayPay など）」と「銀Pay」で変える */
function memberCheckout(pay: 'cash' | 'ginpay'): GuideTask {
  const method = `${g('co-method')} [data-method="${pay}"]`
  // 予約のときに銀Pay で先に払っていると、銀Pay が最初から選ばれている（そのときは現金を押さない）
  const prepaid = `${g('co-method')} [data-method="ginpay"][aria-pressed="true"]`
  const payment: GuideStep[] = pay === 'cash' ? [
    { target: prepaid, text: 'このお客様は銀Pay で支払い済みです', sub: '「現金」は押さずに、そのまま確定します。', optional: true, next: true },
    { target: method, text: '「現金」を押す', sub: 'PayPay・カードなどのときも「現金」を押します。', skipIf: `${method}[aria-pressed="true"], ${prepaid}` },
    { target: g('co-confirm'), until: g('paid'), text: '金額を確かめて、ここを押す', sub: '現金のときは、お金を受け取ってから押します。この時点でお会計が確定します。' },
  ] : [
    { target: method, text: '「銀Pay」を押す', sub: 'アプリで先に支払い済みの予約は、もう選ばれています。', skipIf: `${method}[aria-pressed="true"]` },
    { target: g('co-ginpay-account'), text: '支払う口座を押す', optional: true, skipIf: `${g('co-ginpay-account')} [aria-pressed="true"]` },
    { target: g('co-confirm'), until: g('paid'), text: '金額を確かめて「銀Payで会計を確定」', sub: '残高が足りないと押せません。そのときは先に「銀Pay チャージ」で入れます。' },
  ]
  return {
    id: `member-checkout-${pay}`,
    title: pay === 'cash' ? 'お客様のお会計（現金・PayPay など）' : 'お客様のお会計（銀Pay）',
    sub: pay === 'cash' ? '会員QRを読んで、現金・PayPay・カードで会計' : '会員QRを読んで、銀Pay の残高で会計',
    steps: [
      OPERATOR,
      { target: g('menu-shop'), text: '「店舗端末」を押す' },
      { target: g('pick-staff'), text: '担当者を選ぶ', skipIf: g('scanner') },
      { target: g('staff-picker'), text: '自分の名前を押す', skipIf: g('scanner') },
      {
        target: g('scanner'), until: g('member-result'),
        text: '「QRを読み取る」を押して、会員QRを映す',
        sub: 'お客様にアプリの「会員QR」を出してもらいます。読めると来店も自動で記録されます。',
      },
      { target: g('go-checkout'), text: '「お会計に進む」を押す', skipIf: g('checkout'), optional: true },
      { target: g('co-staff'), text: '施術した担当を押す', skipIf: `${g('co-staff')} [aria-pressed="true"]` },
      { target: g('co-menu'), text: 'メニューを選ぶ', sub: '予約で選んだメニューが入っていれば、そのままで大丈夫です。', optional: true },
      { target: g('co-tickets'), text: '使う券を押す', sub: '使わないときは「次へ」。', optional: true, next: true },
      ...payment,
      { target: g('usual-menu'), text: 'いつものメニューを登録する', sub: 'お客様が次からアプリで同じメニューを予約できます。しないときは「次へ」。', optional: true, next: true },
      { target: g('next-customer'), text: '終わったら「次のお客様」を押す', noJump: true },
    ],
  }
}

export const GUIDE_TASKS: GuideTask[] = [
  memberCheckout('cash'),
  memberCheckout('ginpay'),
  {
    id: 'ginpay',
    title: '銀Pay のチャージ',
    sub: '現金を受け取って銀Pay に入れる',
    steps: [
      OPERATOR,
      { target: g('menu-ginpay'), text: '「銀Pay チャージ」を押す' },
      {
        target: g('gp-find'), until: g('gp-tiers'),
        text: '会員QRを読むか、名前で探す',
        sub: '「会員QRを読み取る」を押して、お客様の会員QRをカメラに映します。',
      },
      { target: g('gp-tiers'), text: '受け取る現金の金額を押す', sub: '右側がチャージされる金額（特典込み）です。' },
      { target: g('gp-submit'), text: '「確認へ」を押す' },
      { target: g('gp-submit'), until: g('gp-done'), text: 'お客様に金額を伝えて「チャージ確定」', sub: '現金を受け取ってから押します。' },
      { target: g('gp-done'), text: 'チャージできました', sub: '受け取った現金はレジへ。', next: true },
    ],
  },
  {
    id: 'walkin',
    title: '会員QRが無いお客様のお会計',
    sub: 'ホットペッパー・電話のお客様など',
    steps: [
      OPERATOR,
      { target: g('menu-walkin'), text: '「店頭会計」を押す' },
      {
        target: g('co-client'), until: g('co-client-picked'), noDim: true,
        text: 'お客様の名前か電話番号を入れて選ぶ',
        sub: '見つからない・わからないときは「顧客を選ばずに会計（匿名）」。',
      },
      { target: g('co-staff'), text: '施術した担当を押す', skipIf: `${g('co-staff')} [aria-pressed="true"]` },
      { target: g('co-add'), text: '「＋ メニュー・商品を追加」を押す', skipIf: g('co-picker') },
      { target: g('co-picker'), text: 'メニューを押す', sub: '探すときは上の欄に名前を入れます。' },
      { target: g('co-method'), text: '支払い方法を押す' },
      { target: g('co-confirm'), until: g('walkin-done'), text: '金額を確かめて、ここを押す', sub: 'この時点でお会計が確定します。' },
      { target: g('walkin-done'), text: 'お会計できました', next: true, noJump: true },
    ],
  },
  {
    id: 'sb-booking',
    title: '予約を入れる',
    sub: '電話・ホットペッパーの予約を予約表へ',
    steps: [
      OPERATOR,
      { target: g('menu-sb'), text: '「予約（SB）」を押す' },
      { target: g('sb-new'), text: '「新規予約」を押す' },
      {
        target: g('sb-review'), until: g('sb-register'), noDim: true,
        text: '上から順に入れて「内容を確認」',
        sub: 'お客様名・メニュー・担当・日付・開始時刻。予約経路（電話・ホットペッパー）も選びます。',
      },
      { target: g('sb-register'), text: '内容を確かめて「予約を登録」' },
      { target: g('sb-board'), text: '予約表に入りました', next: true, noJump: true },
    ],
  },
  {
    id: 'sb-close',
    title: '時間をクローズする',
    sub: 'AI予約を入れたくない時間を閉める',
    steps: [
      OPERATOR,
      { target: g('menu-sb'), text: '「予約（SB）」を押す' },
      {
        target: g('sb-board'), until: g('sb-close-choices'), noJump: true,
        text: '閉めたい担当の、閉めたい時間を押す',
        sub: '予約表の空いている所を押します。日付は上の ‹ › で変えます。',
      },
      { target: g('sb-close-choices'), text: 'いつまで閉めるかを押す' },
      { target: g('sb-close-submit'), text: '「クローズする」を押す' },
      { target: g('sb-board'), text: 'クローズしました', sub: '予約表に「クローズ」と出ます。押すと外せます。', next: true, noJump: true },
    ],
  },
]
