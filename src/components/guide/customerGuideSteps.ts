// お客様アプリ（銀二郎app）の使い方ガイド：作業ごとの手順。書き方は guideSteps.ts（店舗端末）と同じ。
// 押す場所は各画面の data-guide。画面の中身（AI予約・グループ予約・最初の案内・会計）は変えず、目印だけ付けている。
import { isStaging } from '../../utils/env'
import type { GuideStep, GuideTask } from './guideSteps'

const g = (name: string) => `[data-guide="${name}"]`

// ガチャの解禁日（V2Gacha と同じ。Staging はいつでも開いている）
const GACHA_OPENS = '2026-11-11'
const gachaOpen = () => isStaging() || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) >= GACHA_OPENS

const HOME: GuideStep = { target: g('tab-home'), text: '下の「ホーム」を押してください', skipIf: g('home-cta') }

// 本人確認がまだの方は、AI予約の前に「はじめに、店頭で本人確認」が出る。そこで案内を終える
const VERIFY: GuideStep = {
  target: g('jn-verify'), optional: true, next: true, skipIf: g('jn-actions'), stopHere: true, nextLabel: 'わかりました',
  text: 'はじめに、お店で本人確認をします',
  sub: '次のご来店時に「会員QR」をスタッフにお見せください。確認が済むと AI予約が使えます。',
}

// 1人の予約：日にちのあと（カレンダー・時間・担当・確認）のどれかが出たら
const PICK_STAFF = `[data-guide="jn-actions"][data-step="pickStaff"]`
const AFTER_DAY = [g('jn-calendar'), g('jn-times'), PICK_STAFF, g('jn-yes')].join(', ')

export const CUSTOMER_GUIDE_TASKS: GuideTask[] = [
  {
    id: 'c-reserve',
    title: 'AI予約をする',
    sub: '髪型を選んで、日にちと時間を押すだけ',
    steps: [
      HOME,
      { target: g('home-cats'), next: true, text: '髪型の種類を選んでください', sub: '押すと髪型の写真が変わります。横にスワイプすると、ほかの種類も出てきます。' },
      { target: g('home-cards'), next: true, text: 'お好きな髪型の写真を選んでください', sub: '写真は横にスワイプしてめくれます。' },
      { target: g('home-cta'), noJump: true, text: '下の「AI予約する」を押してください' },
      VERIFY,
      { target: `${g('jn-welcome')}, ${g('jn-askmenu')}`, optional: true, until: g('jn-menu'), text: 'メニューを押してください' },
      { target: g('jn-menu'), next: true, text: 'メニューをご確認ください', sub: '違うときは「変える ›」で選び直せます。' },
      { target: g('jn-staff'), optional: true, next: true, text: '担当を選んでください', sub: '押すたびに テイテイ → 銀二郎 → どちらでも と変わります。' },
      { target: g('jn-days'), until: AFTER_DAY, text: 'ご希望の日を押してください', sub: '先の日は「もっと先の日」からカレンダーで選べます。' },
      { target: g('jn-calendar'), optional: true, until: [g('jn-times'), PICK_STAFF, g('jn-yes')].join(', '), text: 'カレンダーで日にちを押してください', sub: '線で消えている日はお休みです。' },
      { target: g('jn-times'), until: `${PICK_STAFF}, ${g('jn-yes')}`, text: 'ご希望の時間を押してください' },
      { target: PICK_STAFF, optional: true, until: g('jn-yes'), text: '担当を押してください' },
      { target: g('jn-price'), optional: true, next: true, text: '金額と使う券をご確認ください', sub: '券は −・＋ で枚数を変えられます（ガチャ券は 0 か 1 枚）。' },
      { target: g('jn-yes'), until: g('jn-done'), text: 'よろしければ「はい」を押してください', sub: 'これで予約が確定します。' },
      { target: g('jn-done'), next: true, read: true, text: 'ご予約できました', sub: '下の「次回予約」でいつでもご確認いただけます。' },
    ],
  },
  {
    id: 'c-group',
    title: '2名以上で予約する',
    sub: 'ご家族・お友だちとご一緒に（3名まで）',
    steps: [
      HOME,
      { target: g('home-usual-chip'), optional: true, skipIf: g('home-group'), text: '上の「いつもの」を押してください' },
      // 「いつもの」がまだ無い方：ここから先に進めない
      {
        target: g('home-cta'), skipIf: g('home-group'), noJump: true, next: true, stopHere: true, nextLabel: 'わかりました',
        text: 'まずは AI予約でご本人の予約をしてください',
        sub: 'いつものメニューが決まると、ここに「2名以上で予約する」が出ます。',
      },
      { target: g('home-group'), until: [g('jn-party'), g('jn-verify'), g('gf-day')].join(', '), text: '「2名以上で予約する」を押してください', sub: '写真を左にめくると出てきます。' },
      VERIFY,
      { target: g('jn-party'), until: `${g('gf-day')}, ${g('gf-calendar')}`, text: '人数を押してください', sub: '途中で戻るときは左上の「戻る」。× は2回押すと閉じます。' },
      { target: g('gf-day'), until: `${g('gf-calendar')}, ${g('gf-times')}`, text: 'ご希望の日を押してください', sub: '皆さまが入れる日だけ押せます。' },
      { target: g('gf-calendar'), optional: true, until: g('gf-times'), text: 'カレンダーで日にちを押してください', sub: '線で消えている日は押せません。' },
      { target: g('gf-times'), until: [g('gf-members'), g('gf-menus'), g('gf-name')].join(', '), text: 'ご案内できる時間を押してください' },
      {
        target: [g('gf-members'), g('gf-name'), g('gf-menus')].join(', '), until: g('gf-yes'), noDim: true,
        text: 'お一人ずつメニューを押してください', sub: 'お連れ様はお名前も入れます。いつものメンバーは名前を押すだけです。',
        alts: [{ when: g('gf-name'), text: 'お名前を入れて「次へ」を押してください', sub: 'お店でお呼びするお名前です。' }],
      },
      { target: g('gf-yes'), until: g('jn-group-done'), text: '内容をご確認のうえ「はい」を押してください' },
      { target: g('jn-group-done'), next: true, read: true, text: 'ご予約できました', sub: '下の「次回予約」でお連れ様の分もご確認いただけます。' },
    ],
  },
  {
    id: 'c-qr',
    title: 'お店で会員QRを見せる',
    sub: 'ご来店のとき・お会計のときに',
    steps: [
      { target: g('tab-qr'), text: '下の「会員QR」を押してください', skipIf: g('qr-card') },
      { target: g('qr-card'), next: true, read: true, text: 'この画面をスタッフにお見せください' },
    ],
  },
  {
    id: 'c-next',
    title: '次回予約を見る・変える',
    sub: '日時の確認・変更・キャンセル',
    steps: [
      { target: g('tab-next'), text: '下の「次回予約」を押してください', skipIf: g('next-panel') },
      { target: g('next-panel'), next: true, read: true, text: 'ご予約の日時・メニュー・担当が出ます' },
      { target: g('next-change'), optional: true, next: true, text: '変更・キャンセルはここから', sub: 'お電話でも承ります。' },
    ],
  },
  {
    id: 'c-tickets',
    title: 'チケットを見る',
    sub: '割引券・特典・プレゼント',
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
  // 初めて開いたときに1回だけ：使い方の場所
  {
    id: 'c-hint',
    title: '使い方',
    sub: '',
    hidden: true,
    quiet: true,
    steps: [{ target: g('guide-open'), next: true, nextLabel: 'わかりました', text: '使い方はここから見られます', sub: '予約のしかたなど、押す場所を順番にご案内します。' }],
  },
]
