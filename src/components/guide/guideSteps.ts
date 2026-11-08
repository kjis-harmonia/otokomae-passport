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
  /** 読むだけの手順（押す所が無い）。👇 を出さない */
  read?: boolean
  /** この場所が画面にあるときは、言葉をこちらに替える（同じ手順の中で画面が変わるとき：メニュー → お名前 など） */
  alts?: { when: string; text: string; sub?: string }[]
  /** 「次へ」で作業を終える（この先に進めないとき：本人確認がまだ など） */
  stopHere?: boolean
  /** 「次へ」の言葉を変える */
  nextLabel?: string
  /** next と一緒に：囲んだ所を押しても次へ進む（髪型の種類など） */
  tap?: boolean
  /** 囲んだ所の中のこの要素の文字を、text の {label} に入れる（ボタンの文字が変わるとき） */
  label?: string
  /** これが画面にある間（銀ちゃんが話している途中など）は、飛ばさず・先へ進まずに待つ */
  waitWhile?: string
}

export type GuideTask = {
  id: string; title: string; sub: string; steps: GuideStep[]
  /** 選ぶ画面に出さない（自動で1回だけ出す案内） */
  hidden?: boolean
  /** 終わったら「これで終わりです」を出さずに閉じる */
  quiet?: boolean
  /** false のときは選ぶ画面に出さない（解禁前のガチャ など） */
  available?: () => boolean
  /** この上に重なっていても休まない（pauseWhen のうち、この作業が中を案内するもの：銀ちゃんの会話 など） */
  inside?: string
}

const g = (name: string) => `[data-guide="${name}"]`

const OPERATOR: GuideStep = {
  target: g('operator'),
  text: 'まず、自分の名前を押す',
  sub: '会計やチャージの記録に、押した人の名前が残ります。',
  skipIf: `${g('operator')} [aria-pressed="true"]`,
}

/** 会員QRを読むまで（お会計・チェックイン・初回の本人確認で同じ） */
const SCAN: GuideStep[] = [
  OPERATOR,
  { target: g('menu-shop'), text: '「店舗端末」を押す' },
  { target: g('pick-staff'), text: '担当者を選ぶ', skipIf: g('scanner') },
  { target: g('staff-picker'), text: '自分の名前を押す', skipIf: g('scanner') },
  {
    target: g('scanner'), until: g('member-result'),
    text: '「QRを読み取る」を押して、会員QRを映す',
    sub: 'お客様にアプリの「会員QR」を出してもらいます。読めると来店も自動で記録されます。',
  },
]
const CHECKED_IN: GuideStep = { target: g('checkin-done'), next: true, text: '「来店チェックイン完了」が出ていれば記録済みです', sub: 'QRを読んだ時点で、今日の来店が自動で記録されます。' }

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
      ...SCAN,
      { target: g('go-checkout'), text: '「お会計に進む」を押す', skipIf: g('checkout'), optional: true },
      { target: g('co-staff'), text: '施術した担当を押す', skipIf: `${g('co-staff')} [aria-pressed="true"]` },
      { target: g('co-menu'), text: 'メニューを選ぶ', sub: '予約から来たお会計は、最初から入っています。', optional: true },
      { target: g('co-price'), text: '料金が担当で変わるときは、金額を入れる', sub: '右の金額を押して入れ直します。そのままなら「次へ」。', optional: true, next: true, noDim: true },
      { target: g('co-plan'), text: 'お客様が AI予約で選んだ券です', sub: '下の券の枚数に、最初から入っています。', optional: true, next: true },
      { target: g('co-tickets'), text: '使う券の枚数を「− ＋」で入れる', sub: '使わないときは「次へ」。', optional: true, next: true, noDim: true },
      ...payment,
      {
        target: g('usual-menu'), until: g('usual-saved'), optional: true, next: true,
        text: 'お客様の「いつものメニュー」を登録する',
        sub: '会計で選んだメニューが入っています。任意金額のときは一覧から選んで「登録する」。しないときは「次へ」。',
      },
      { target: g('next-customer'), text: '終わったら「次のお客様」を押す', noJump: true },
    ],
  }
}

export const GUIDE_TASKS: GuideTask[] = [
  {
    id: 'checkin',
    title: '来店チェックイン',
    sub: '会員QRを読んで、今日の来店を記録',
    steps: [...SCAN, CHECKED_IN, { target: g('next-customer'), text: '終わったら「次のお客様」を押す', noJump: true }],
  },
  {
    id: 'first-visit',
    title: '初めてアプリを登録したお客様の来店',
    sub: '会員QRを読んで、AI予約の本人確認',
    steps: [
      ...SCAN,
      {
        target: g('store-approve'), until: g('store-approved'),
        text: 'ご本人か確かめてから「本人を確認してAI予約を有効にする」',
        sub: '「AI予約の初回本人確認」の欄です。出ないときは確認済みのお客様です。',
        optional: true,
      },
      { target: g('store-approved'), next: true, optional: true, text: '確認できました', sub: 'お客様のアプリで AI予約が使えるようになります。' },
      CHECKED_IN,
      { target: `${g('go-checkout')}, ${g('checkout')}`, optional: true, next: true, noDim: true, text: 'お会計はこの下で続けます', sub: '手順は「お客様のお会計」のガイドで案内します。' },
      { target: g('next-customer'), text: '終わったら「次のお客様」を押す', noJump: true },
    ],
  },
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
]
