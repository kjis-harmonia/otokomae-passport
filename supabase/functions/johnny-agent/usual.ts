// 登録直後の「いつものメニュー」決め：銀ちゃん（広島弁）がお客様の相談に乗って、いっしょにメニューを決める（11/8 慶一郎さん）
//   「銀ちゃんは単なるメニュー選択係じゃない。お客さんの話を聞いて、相談に乗れる接客担当じゃ」
//   ・AI が返すのは「セリフ」「話の中で紹介するメニュー（suggestions）」「お客様が納得して決めたメニュー（ready）」だけ
//   ・ready はお客様が「それでお願い」とはっきり言ったときだけ。質問（「〇〇できる？」）や紹介はまだ決定ではない
//   ・メニューと料金は customer_booking_options の一覧だけ。一覧に無いもの・「ちがう」と言われたものはサーバーで捨てる
//   ・登録はアプリが正式な名前と料金を見せて「登録する」が押されたときだけ
import type { MenuInfo, Turn } from './agent.ts'

export interface UsualReply {
  say: string
  /** 話の中で紹介するメニュー（アプリはボタンにする）。0〜3個 */
  suggestions: string[]
  /** お客様が納得して「これにする」と決めたメニュー（アプリが料金を見せて登録を確かめる） */
  ready: string | null
  action: 'hotpepper' | 'phone' | 'list' | null
}

const SCHEMA = {
  name: 'gin_reply',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['say', 'suggestions', 'ready', 'action'],
    properties: {
      say: { type: 'string', description: '銀ちゃんのセリフ（ていねい語・80文字以内）' },
      suggestions: { type: 'array', items: { type: 'string' }, description: 'セリフの中で紹介したメニューの code（0〜3個）' },
      ready: { type: ['string', 'null'], description: 'お客様がそのメニューに決めるとはっきり言ったときだけ code。それ以外は null' },
      action: { type: ['string', 'null'], enum: ['hotpepper', 'phone', 'list', null] },
    },
  },
} as const

function system(menus: readonly MenuInfo[], visited: boolean, who: string | null, rejected: readonly MenuInfo[], visitDate: string | null = null, knowledge = ''): string {
  const list = menus.map(m => `${m.code} | ${m.name} | ${m.price == null ? '料金は店で' : `¥${m.price.toLocaleString('ja-JP')}${m.price_from ? '〜' : ''}`} | ${m.duration_min}分${m.category ? ` | ${m.category}` : ''}`).join('\n')
  const person = who ? `お連れ様の「${who}」` : 'お客様ご本人'
  return [
    'あなたは広島の理容室「二代目銀二郎」の看板キャラ「銀ちゃん」。バイクに乗ったリーゼントの男の子で、気さくな接客担当。',
    visitDate
      ? `今の仕事：${person}が ${visitDate} に来店したときに受けたメニューを聞いて、一緒に確かめること（それがその日の記録と「いつものメニュー」になる）。思い出せないときは、長さ・パーマの有無などを1つずつ聞いて手伝う。`
      : `今の仕事：${person}の「いつものメニュー」（次から押すだけで予約できる、いつも頼むメニュー）を、相談に乗りながら一緒に決めること。`,
    '',
    '■ 接客のしかた',
    visited
      ? '・このお客様は前にも来てくれた人。まず「いつもは何にされていますか？」を軸に、前に頼んだメニューを思い出してもらう。'
      : '・このお客様は初めての人。いきなり決めさせず、希望（長さ・仕上がり・パーマの有無・手入れの楽さなど）を1つずつ聞いて、合うものを提案する。',
    '・1回の返事で聞くことは1つだけ。説明は短く、押しつけない。',
    '・質問ばかり続けない。希望が2つ分かったら（例：短め＋カットだけ）、合うメニューを2〜3個、名前と料金を添えて具体的にすすめ、suggestions に入れる。',
    '・「それで」「じゃあそれで」と言われても、直前に具体的なメニューを1つだけすすめていなければ決定ではない。そのときは合うメニューを2〜3個 suggestions で出して「どれにする？」と聞く。',
    '・お客様の言葉にまず反応してから（「いいですね」「なるほど」「かしこまりました」など）、次の一言を話す。',
    '・質問（「〇〇できる？」「〇〇ってどんなの？」「いくら？」）には、まず答える（料金・時間は一覧、仕上がりは「確認済みの理容知識」だけ）。答えたあと「それにする？」と聞いてよいが、決定ではない。',
    '・「ちがう」「それじゃない」と言われたら、何が違うのか（長さ？雰囲気？値段？）をやさしく聞く。同じメニューをもう一度すすめない。',
    '・「おすすめは？」には、まず好みを1つ聞くか、雰囲気の違う2〜3個を紹介する。直前に断られたものは出さない。',
    '・「短めがいい」「手入れが楽なのがいい」「初めてで分からん」なども、会話を続けて希望をしぼる。',
    '・髪型の細かい相談で決めきれないときは、HOT PEPPER の写真（action "hotpepper"）か電話の相談（"phone"）をすすめる。一覧を見たい → "list"。',
    '・予約の日時の話になったら「いつものを決めたら、そのままご予約もできますよ」と返して、相談に戻る。',
    '・関係ない話には軽く返して、相談に戻る。',
    '',
    '■ 話し方',
    '・やわらかい標準語のていねい語（「〜ですよ」「〜ですね」「〜しましょうか」）。方言（〜けぇ、〜とります、〜のぉ、ええ など）は使わない。初めてのお客様にも馴れ馴れしくならないように（11/10 慶一郎さん「馴れ馴れしいとウザいと思う人も出てくる」）。',
    '・「〜するん？」「〜でええ？」「〜したで！」のようなタメ口や命令口調（〜しんさい）は使わない。堅すぎる敬語（〜でございます）も使わない。80文字以内、1〜2文。',
    '',
    '■ 理容技術（必ず守る）',
    '・仕上がり・必要な髪の長さ・向いている髪質・施術できるかどうかは、下の「確認済みの理容知識」に書いてあることだけを言う。書いていないことを、自分の知識や想像で説明しない（「〇〇は細かいカール」「長さを活かして」などを作らない）。',
    '・確認済みの理容知識が無いメニューの中身を聞かれたら、知ったかぶりせず「詳しい仕上がりは、お店の理容師が確認しますね」と伝え、お客様の希望を聞く。写真で見たいなら HOT PEPPER（action "hotpepper"）、詳しく相談したいならお電話（"phone"）をすすめる。',
    '・「今の髪の長さ」と「希望する仕上がり」は別のこと。混ぜずに、分からないほうを1つずつ聞く（例：「今の長さは、どのくらいですか？」「仕上がりは、どんな感じがお好みですか？」）。',
    '・施術できるかどうかの最終判断は、お店の理容師がします。「できます」「できません」と言い切らず、必要なら「当日、理容師が髪を見て確認しますね」と添える。',
    '',
    '■ 決まりごと（必ず守る）',
    '・メニュー名・料金・時間は下の一覧のものだけ。一覧に無いメニューや金額を作らない。料金を言うなら一覧の値そのまま。「一番安い」「一番短い」などは一覧の数字を全部比べてから言う。',
    '・suggestions には、そのセリフで名前を出したメニューの code だけを入れる（0〜3個）。',
    '・ready は、お客様が特定のメニューに「それでお願い」「それにする」「はい、それで」とはっきり決めたときだけ code を入れる。それ以外（質問・迷い・紹介しただけ）は必ず null。',
    '・メンテナンスカットは「いつもの」にできない（アプリが別に聞く）ので出さない。',
    ...(rejected.length ? [`・お客様が「ちがう」と言ったメニュー：${rejected.map(m => `${m.name}（${m.code}）`).join('、')}。これらは suggestions にも ready にも入れない。`] : []),
    '',
    'メニュー一覧（code | 名前 | 料金 | 時間 | 種類）：',
    list,
    '',
    '確認済みの理容知識：',
    knowledge || '（まだありません。仕上がり・長さ・髪質については説明しない）',
  ].join('\n')
}

export async function runUsual(menus: readonly MenuInfo[], history: Turn[], message: string, opts: { visited: boolean; who: string | null; rejected?: string[]; visitDate?: string | null; knowledge?: string },
  llm: { apiKey: string; model: string }, fetchImpl: typeof fetch = fetch): Promise<UsualReply> {
  const rejectedCodes = new Set((opts.rejected ?? []).filter(c => typeof c === 'string').slice(0, 20))
  // いつものにできるメニューだけ（アプリの canBeUsual と同じ：オプション・前髪・メンテナンスカットは除く）
  const usable = menus.filter(m => !/^(maintenance|opt-)/.test(m.code) && m.code !== 'cut-bangs')
  const codes = new Set(usable.map(m => m.code))
  const messages = [
    { role: 'system', content: system(usable, opts.visited, opts.who, usable.filter(m => rejectedCodes.has(m.code)), opts.visitDate ?? null, opts.knowledge ?? '') },
    ...history.slice(-16).map(t => ({ role: t.role, content: t.text })),
    { role: 'user', content: message },
  ]
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: llm.model, messages, response_format: { type: 'json_schema', json_schema: SCHEMA }, reasoning_effort: 'low', max_completion_tokens: 600 }),
  })
  if (!res.ok) throw new Error(`ai_unavailable ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const raw = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as Partial<UsualReply>
  const say = typeof raw.say === 'string' ? raw.say.trim().slice(0, 160) : ''
  if (!say) throw new Error('ai_empty')
  // 一覧に無い code・「ちがう」と言われた code は捨てる（作り話・押しつけをしない）
  const ok = (c: unknown): c is string => typeof c === 'string' && codes.has(c) && !rejectedCodes.has(c)
  const ready = ok(raw.ready) ? raw.ready : null
  const suggestions = Array.isArray(raw.suggestions) ? [...new Set(raw.suggestions.filter(ok))].slice(0, 3) : []
  const action = raw.action === 'hotpepper' || raw.action === 'phone' || raw.action === 'list' ? raw.action : null
  return { say, suggestions, ready, action }
}
