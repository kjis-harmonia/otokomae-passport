// JOHNNY の試験の会話。いまは 2026-10-17（土）14:00。
//   10/17 今日：テイテイ 14:00-17:30、銀二郎 13-16・17-19 が埋まっている（今からだと 銀二郎 16-17・19-20、テイテイ 17:30-20 が空き）
//   10/18 日：テイテイ 10-12、銀二郎 11-13・15-16 が埋まっている
//   10/19 月：定休日　10/20 火：テイテイ 15-16 だけ埋まっている　10/21 水：終日埋まっている
//   営業 10:00-20:00、15分刻み、当日は30分後から
// expect：types は許す ui の種類。menu・date・time・staff・reservation は ui に入っていてほしい値
export interface Case {
  id: string
  say: string
  history?: { role: 'user' | 'assistant'; text: string }[]
  reservations?: 'none' | 'one' | 'two'
  lastMenu?: string
  shown?: { menu_code?: string; times?: string[]; staff_id?: string | null }
  expect: { types: string[]; menu?: string | string[]; date?: string; time?: string; staff?: 'テイテイ' | '銀二郎' | null; reservation?: string; menusInclude?: string; menusExclude?: string }
}

const book = (menu: string | string[], date: string, time: string, staff?: 'テイテイ' | '銀二郎' | null) => ({ types: ['confirm_booking'], menu, date, time, ...(staff !== undefined ? { staff } : {}) })
const slots = (menu: string | string[], date?: string, staff?: 'テイテイ' | '銀二郎' | null) => ({ types: ['slots'], menu, ...(date ? { date } : {}), ...(staff !== undefined ? { staff } : {}) })
const menus = (date?: string, extra: Partial<Case['expect']> = {}) => ({ types: ['menus'], ...(date ? { date } : {}), ...extra })
const CUT = ['cut-regular']
const ANYCUT = ['cut-regular', 'cut-skin-fade', 'cut-skin-fade-plus', 'cut-buzz']

export const CASES: Case[] = [
  // ── 日だけ・空いてる？（先回りの案内） ──
  { id: 'day-01', say: '今日空いてる？', expect: menus('2026-10-17', { menusExclude: 'perm-ginpara-curly' }) },
  { id: 'day-02', say: '今日いけますか', expect: menus('2026-10-17') },
  { id: 'day-03', say: 'きょうまだ間に合う？', expect: menus('2026-10-17') },
  { id: 'day-04', say: '明日って空きある？', expect: menus('2026-10-18') },
  { id: 'day-05', say: 'あした行きたいんやけど', expect: menus('2026-10-18') },
  { id: 'day-06', say: '火曜日どう？', expect: menus('2026-10-20') },
  { id: 'day-07', say: '来週の火曜って空いとる？', expect: menus('2026-10-20') },
  { id: 'day-08', say: '20日は？', expect: menus('2026-10-20') },
  { id: 'day-09', say: '10月20日空いてますか', expect: menus('2026-10-20') },
  { id: 'day-10', say: '月曜日空いてる？', expect: { types: ['menus', 'none', 'slots'] } }, // 定休日 → 休みと伝えて別の日
  { id: 'day-11', say: '水曜いける？', expect: { types: ['menus', 'none', 'slots'] } }, // 終日埋まり → 別の日
  { id: 'day-12', say: '今週末あいてる？', expect: { types: ['menus', 'slots', 'none'] } },
  { id: 'day-13', say: 'なるべく早く行きたい', expect: { types: ['menus', 'slots', 'none'] } },
  { id: 'day-14', say: '空いてる日ある？', expect: { types: ['menus', 'slots', 'none'] } },
  { id: 'day-15', say: '今日の夕方', expect: menus('2026-10-17') },
  { id: 'day-16', say: '明日の午前中', expect: menus('2026-10-18') },
  { id: 'day-17', say: '明日の昼過ぎ', expect: menus('2026-10-18') },
  { id: 'day-18', say: '明日の夜', expect: menus('2026-10-18') },
  { id: 'day-19', say: '今日の19時いける？', expect: menus('2026-10-17') },
  { id: 'day-20', say: '明日の10時', expect: menus('2026-10-18') },

  // ── メニューだけ（一番早い空き） ──
  { id: 'menu-01', say: '濡れパンしたい', expect: slots('perm-nurepan') },
  { id: 'menu-02', say: 'ぬれぱんお願いします', expect: slots('perm-nurepan') },
  { id: 'menu-03', say: 'パンチパーマあてたい', expect: slots('perm-punch') },
  { id: 'menu-04', say: 'パンチで', expect: slots('perm-punch') },
  { id: 'menu-05', say: 'スキンフェードにしたい', expect: slots(['cut-skin-fade', 'cut-skin-fade-plus']) },
  { id: 'menu-06', say: 'フェードで', expect: slots(['cut-skin-fade', 'cut-skin-fade-plus', 'cut-kids-skin-fade']) },
  { id: 'menu-07', say: 'ダブルメッシュ入れたい', expect: slots('color-double-mesh') },
  { id: 'menu-08', say: '白髪染めしたい', expect: slots('color-gray') },
  { id: 'menu-09', say: '坊主にしたい', expect: slots('cut-buzz') },
  { id: 'menu-10', say: '丸刈りで', expect: slots('cut-buzz') },
  { id: 'menu-11', say: '顔剃りだけでもいい？', expect: slots('shave-men') },
  { id: 'menu-12', say: 'ツイストやりたい', expect: { types: ['slots', 'menus'], menu: ['perm-twist', 'set-twist-mesh', 'set-twist-double-mesh'] } },
  { id: 'menu-13', say: 'アイパーかけたい', expect: slots(['perm-iper', 'perm-curl-iper']) },
  { id: 'menu-14', say: 'ブリーチ2回', expect: slots('color-bleach-2') },
  { id: 'menu-15', say: 'ギンパラ', expect: slots('perm-ginpara-curly') },
  { id: 'menu-16', say: 'カットだけ', expect: slots(CUT) },
  { id: 'menu-17', say: '子供のフェード', expect: slots('cut-kids-skin-fade') },
  { id: 'menu-18', say: 'カットとカラー', expect: slots('set-cut-color') },
  { id: 'menu-19', say: '前髪だけ切りたい', expect: slots('cut-bangs') },
  { id: 'menu-20', say: 'ニグロ', expect: slots('perm-negro') },

  // ── 日時とメニュー ──
  { id: 'both-01', say: '明日の15時にカット', expect: book(CUT, '2026-10-18', '15:00') },
  { id: 'both-02', say: '明日3時にカットで', expect: book(CUT, '2026-10-18', '15:00') },
  { id: 'both-03', say: 'あしたの午後3時からスキンフェード', expect: book(['cut-skin-fade', 'cut-skin-fade-plus'], '2026-10-18', '15:00') },
  { id: 'both-04', say: '火曜の11時に濡れパン', expect: book('perm-nurepan', '2026-10-20', '11:00') },
  { id: 'both-05', say: '20日の10時半からパンチパーマ', expect: book('perm-punch', '2026-10-20', '10:30') },
  { id: 'both-06', say: '今日の6時から通常カット', expect: book(CUT, '2026-10-17', '18:00') },
  { id: 'both-07', say: '今日の4時にカットできる？', expect: book(CUT, '2026-10-17', '16:00') },
  { id: 'both-08', say: '今日の3時にカット', expect: slots(CUT, '2026-10-17') }, // 埋まっている → 近い時間
  { id: 'both-09', say: '今日の夕方に濡れパン', expect: { types: ['slots', 'confirm_booking'], menu: 'perm-nurepan', date: '2026-10-17' } },
  { id: 'both-10', say: '今日ギンパラできる？', expect: { types: ['slots', 'none', 'menus'], menu: 'perm-ginpara-curly' } }, // 今日は入らない → 次の日
  { id: 'both-11', say: '水曜の昼にカット', expect: { types: ['slots'], menu: CUT } }, // 水曜は埋まっている → 別の日
  { id: 'both-12', say: '月曜の10時にカット', expect: { types: ['slots', 'none'], menu: CUT } },
  { id: 'both-13', say: '明日の11時に白髪染め', expect: slots('color-gray', '2026-10-18') }, // 11時は2人とも埋まっている → 近い時間
  { id: 'both-14', say: '明日の朝一でカット', expect: book(CUT, '2026-10-18', '10:00') },
  { id: 'both-15', say: '明日の一番遅い時間でカット', expect: { types: ['slots', 'confirm_booking'], menu: CUT, date: '2026-10-18' } },

  // ── 指名 ──
  { id: 'staff-01', say: '明日の15時にテイテイさんでカット', expect: book(CUT, '2026-10-18', '15:00', 'テイテイ') },
  { id: 'staff-02', say: '明日15時に銀二郎さんでカット', expect: { types: ['slots'], menu: CUT, staff: '銀二郎' } }, // 銀二郎は 15-16 埋まり
  { id: 'staff-03', say: 'テイテイさん空いてる日ある？カットで', expect: { types: ['slots'], menu: CUT, staff: 'テイテイ' } },
  { id: 'staff-04', say: '銀二郎さんに濡れパンお願いしたい', expect: { types: ['slots'], menu: 'perm-nurepan', staff: '銀二郎' } },
  { id: 'staff-05', say: 'ていていで', history: [{ role: 'user', text: '明日の15時にカット' }, { role: 'assistant', text: '明日の15時、通常カットでお取りできます。この日時でお間違いないですか？' }], expect: book(CUT, '2026-10-18', '15:00', 'テイテイ') },
  { id: 'staff-06', say: '誰でもいいです', history: [{ role: 'user', text: '明日の15時にカット' }, { role: 'assistant', text: '担当のご希望はありますか？' }], expect: book(CUT, '2026-10-18', '15:00', null) },

  // ── 前回と同じ ──
  { id: 'last-01', say: 'いつもので', lastMenu: 'perm-punch', expect: slots('perm-punch') },
  { id: 'last-02', say: '前と同じやつで明日', lastMenu: 'perm-punch', expect: { types: ['slots', 'confirm_booking'], menu: 'perm-punch', date: '2026-10-18' } },
  { id: 'last-03', say: '前回と同じで火曜の11時', lastMenu: 'cut-skin-fade', expect: book('cut-skin-fade', '2026-10-20', '11:00') },

  // ── 画面の候補から選ぶ・言い直し ──
  { id: 'pick-01', say: '2つ目で', shown: { menu_code: 'cut-regular', times: ['2026-10-18T03:00:00.000Z', '2026-10-18T04:00:00.000Z', '2026-10-18T05:00:00.000Z'] }, expect: book(CUT, '2026-10-18', '13:00') },
  { id: 'pick-02', say: '一番最初の時間で', shown: { menu_code: 'cut-regular', times: ['2026-10-18T03:00:00.000Z', '2026-10-18T04:00:00.000Z'] }, expect: book(CUT, '2026-10-18', '12:00') },
  { id: 'pick-03', say: '13時のやつ', shown: { menu_code: 'cut-regular', times: ['2026-10-18T03:00:00.000Z', '2026-10-18T04:00:00.000Z', '2026-10-18T05:00:00.000Z'] }, expect: book(CUT, '2026-10-18', '13:00') },
  { id: 'pick-04', say: 'やっぱり火曜日にして', history: [{ role: 'user', text: '明日カット' }, { role: 'assistant', text: '明日は12時、13時、14時が空いています。どれにしますか？' }], expect: { types: ['slots', 'confirm_booking'], menu: CUT, date: '2026-10-20' } },
  { id: 'pick-05', say: 'もうちょい遅い時間ない？', history: [{ role: 'user', text: '明日カット' }, { role: 'assistant', text: '明日は12時、13時、14時が空いています。どれにしますか？' }], shown: { menu_code: 'cut-regular', times: ['2026-10-18T03:00:00.000Z', '2026-10-18T04:00:00.000Z', '2026-10-18T05:00:00.000Z'] }, expect: slots(CUT, '2026-10-18') },
  { id: 'pick-06', say: 'メニューやっぱスキンフェードで', history: [{ role: 'user', text: '明日の15時にカット' }, { role: 'assistant', text: '明日の15時、通常カットでお取りできます。この日時でお間違いないですか？' }], expect: book(['cut-skin-fade', 'cut-skin-fade-plus'], '2026-10-18', '15:00') },
  { id: 'pick-07', say: '時間ずらして16時で', history: [{ role: 'user', text: '明日の15時にカット' }, { role: 'assistant', text: '明日の15時、通常カットでお取りできます。この日時でお間違いないですか？' }], expect: book(CUT, '2026-10-18', '16:00') },

  // ── 質問まじり ──
  { id: 'ask-01', say: '濡れパンっていくら？', expect: { types: ['none', 'slots', 'menus'] } },
  { id: 'ask-02', say: 'パンチパーマって何時間かかる？', expect: { types: ['none', 'slots', 'menus'] } },
  { id: 'ask-03', say: '濡れパンいくらで、明日空いてる？', expect: { types: ['slots', 'confirm_booking'], menu: 'perm-nurepan', date: '2026-10-18' } },
  { id: 'ask-04', say: '何時まで営業してますか', expect: { types: ['none', 'menus'] } },
  { id: 'ask-05', say: 'どんなメニューがありますか', expect: { types: ['none', 'menus'] } },

  // ── キャンセル・変更・確認 ──
  { id: 'cancel-01', say: '予約キャンセルしたい', reservations: 'one', expect: { types: ['confirm_cancel'], reservation: 'r-1020' } },
  { id: 'cancel-02', say: '火曜の予約やめたい', reservations: 'two', expect: { types: ['confirm_cancel'], reservation: 'r-1020' } },
  { id: 'cancel-03', say: 'パンチの予約取り消して', reservations: 'two', expect: { types: ['confirm_cancel'], reservation: 'r-1025' } },
  { id: 'cancel-04', say: 'キャンセルで', reservations: 'two', expect: { types: ['reservations'] } },
  { id: 'cancel-05', say: '予約取り消したい', reservations: 'none', expect: { types: ['none', 'handoff', 'menus'] } },
  { id: 'cancel-06', say: 'ごめん20日行けんくなった', reservations: 'one', expect: { types: ['confirm_cancel', 'slots', 'menus', 'none'] } },
  { id: 'change-01', say: '火曜の予約、明日の15時に変えたい', reservations: 'one', expect: { types: ['confirm_change'], reservation: 'r-1020', date: '2026-10-18', time: '15:00', menu: CUT } },
  { id: 'change-02', say: '予約を1時間遅らせたい', reservations: 'one', expect: { types: ['confirm_change'], reservation: 'r-1020', date: '2026-10-20', time: '16:00' } },
  { id: 'change-03', say: '予約の日にち変えたい', reservations: 'one', expect: { types: ['slots', 'menus', 'none'] } },
  { id: 'change-04', say: '25日のやつを24日の同じ時間にできる？', reservations: 'two', expect: { types: ['confirm_change', 'slots'], reservation: 'r-1025' } },
  { id: 'check-01', say: '予約いつやったっけ', reservations: 'one', expect: { types: ['none', 'reservations'] } },
  { id: 'check-02', say: '次の予約何時？', reservations: 'two', expect: { types: ['none', 'reservations'] } },

  // ── 2人・できないこと・関係ない話 ──
  { id: 'multi-01', say: 'わしと息子で明日行きたい', expect: { types: ['none', 'handoff', 'menus', 'slots'] } },
  { id: 'multi-02', say: '3人でいけますか', expect: { types: ['handoff', 'none'] } },
  { id: 'off-01', say: '今日の天気は？', expect: { types: ['none'] } },
  { id: 'off-02', say: 'ありがとう', expect: { types: ['none'] } },
  { id: 'off-03', say: 'もしもし', expect: { types: ['none'] } },
  { id: 'off-04', say: '駐車場ありますか', expect: { types: ['none', 'handoff'] } },

  // ── 方言・くだけた言い方・聞き間違いぎみ ──
  { id: 'casual-01', say: 'あしたカットいけるん？', expect: { types: ['slots', 'confirm_booking'], menu: CUT, date: '2026-10-18' } },
  { id: 'casual-02', say: 'きょうパンチいけそう？', expect: { types: ['slots', 'confirm_booking'], menu: 'perm-punch', date: '2026-10-17' } },
  { id: 'casual-03', say: 'あさってカットしたいんですけど', expect: { types: ['slots', 'none', 'menus'], menu: CUT } }, // あさっては月曜（休み）
  { id: 'casual-04', say: '髪切りたい', expect: { types: ['slots', 'menus'], menu: ANYCUT } },
  { id: 'casual-05', say: 'さっぱりしたいわ', expect: { types: ['slots', 'menus', 'none'] } },
  { id: 'casual-06', say: '明日の3時半くらいにかっと', expect: book(CUT, '2026-10-18', '15:30') },
  { id: 'casual-07', say: 'ぱんちぱーま明日の11時', expect: { types: ['confirm_booking', 'slots'], menu: 'perm-punch', date: '2026-10-18' } },
  { id: 'casual-08', say: 'あー明日、えっと15時くらいで、カットお願い', expect: book(CUT, '2026-10-18', '15:00') },
]
