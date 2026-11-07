// 登録直後の「いつものメニュー」決め：銀ちゃん（広島弁）がお客様と話して、メニューを1つに絞る（11/8 慶一郎さん「会話が成立しない」）
//   ・メニューは customer_booking_options の一覧だけ。無いメニュー・料金を作らない（アプリが正式な名前と料金で確かめてから登録する）
//   ・AI は「話す言葉」と「候補（menu_code）」「導線（HOT PEPPER・電話・一覧）」だけを返す。登録はアプリが「登録する」を押されたときだけ
import type { MenuInfo, Turn } from './agent.ts'

export interface UsualReply {
  say: string
  /** 1つに絞れた（アプリが料金を出して確かめる） */
  menu_code: string | null
  /** 2〜4個に絞れた */
  options: string[]
  action: 'hotpepper' | 'phone' | 'list' | null
}

const SCHEMA = {
  name: 'gin_reply',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['say', 'menu_code', 'options', 'action'],
    properties: {
      say: { type: 'string', description: '銀ちゃんのセリフ（広島弁・60文字以内・1〜2文）' },
      menu_code: { type: ['string', 'null'], description: '1つに絞れたときだけ、一覧の code' },
      options: { type: 'array', items: { type: 'string' }, description: '2〜4個に絞れたときの一覧の code。無ければ空' },
      action: { type: ['string', 'null'], enum: ['hotpepper', 'phone', 'list', null] },
    },
  },
} as const

function system(menus: readonly MenuInfo[], visited: boolean, who: string | null): string {
  const list = menus.map(m => `${m.code} | ${m.name} | ${m.price == null ? '料金は店で' : `¥${m.price.toLocaleString('ja-JP')}${m.price_from ? '〜' : ''}`} | ${m.duration_min}分`).join('\n')
  return [
    'あなたは広島の理容室「二代目銀二郎」のマスコット「銀ちゃん」。バイクに乗ったリーゼントの男の子。',
    `仕事：${who ? `お連れ様（${who}）` : 'お客様ご本人'}の「いつものメニュー」を、会話で1つに決めること。`,
    `このお客様は${visited ? '前にも来店したことがある' : 'はじめて'}。`,
    '話し方：親しみやすい広島弁（〜じゃ、〜けぇ、〜のぉ、〜しんさい、〜よる）。1〜2文、60文字以内。説明を長くしない。失礼な言い方・下品な言葉はしない。',
    '決まりごと：',
    '・メニューは下の一覧だけ。一覧に無いメニュー名・料金・時間を作らない。料金を言うなら一覧の値そのまま。',
    '・お客様の言葉が1つのメニューに決まるなら menu_code に入れて「〇〇でええ？」と聞く（料金の確認はアプリが出す）。',
    '・2〜4個に絞れるなら options に入れて「どれが近い？」と聞く。あいまいなら、長さ・パーマの有無・仕上がりなどを1つだけ質問する。',
    '・HOT PEPPER のメニューや写真を見たい → action "hotpepper"。お店に電話で相談したい → "phone"。一覧を見て自分で選びたい → "list"。',
    '・「ホットペッパーのメニュー教えて」「何がある？」のように中身を聞かれたら、人気の代表を2〜4個 options に入れて短く紹介する。',
    '・髪型の細かい相談で決めきれんときは、電話の相談（phone）か HOT PEPPER の写真（hotpepper）をすすめる。',
    '・予約の日時の話になったら「いつもの決めたら、ホームからすぐ予約できるけぇ」と返して、メニュー決めに戻る。',
    '・メンテナンスカットは「いつもの」にできない（アプリが別に聞く）ので、menu_code・options に入れない。',
    '・関係ない話には軽く返して、メニュー決めに戻る。',
    '',
    'メニュー一覧（code | 名前 | 料金 | 時間）：',
    list,
  ].join('\n')
}

export async function runUsual(menus: readonly MenuInfo[], history: Turn[], message: string, opts: { visited: boolean; who: string | null },
  llm: { apiKey: string; model: string }, fetchImpl: typeof fetch = fetch): Promise<UsualReply> {
  const usable = menus.filter(m => m.code !== 'maintenance')
  const codes = new Set(usable.map(m => m.code))
  const messages = [
    { role: 'system', content: system(usable, opts.visited, opts.who) },
    ...history.slice(-12).map(t => ({ role: t.role, content: t.text })),
    { role: 'user', content: message },
  ]
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: llm.model, messages, response_format: { type: 'json_schema', json_schema: SCHEMA }, reasoning_effort: 'none', max_completion_tokens: 400 }),
  })
  if (!res.ok) throw new Error(`ai_unavailable ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const raw = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as Partial<UsualReply>
  const say = typeof raw.say === 'string' ? raw.say.trim().slice(0, 120) : ''
  if (!say) throw new Error('ai_empty')
  // 一覧に無い code は捨てる（作り話のメニューを出さない）
  const menu_code = typeof raw.menu_code === 'string' && codes.has(raw.menu_code) ? raw.menu_code : null
  const options = Array.isArray(raw.options) ? [...new Set(raw.options.filter((c): c is string => typeof c === 'string' && codes.has(c)))].slice(0, 4) : []
  const action = raw.action === 'hotpepper' || raw.action === 'phone' || raw.action === 'list' ? raw.action : null
  return { say, menu_code, options: menu_code ? [] : options, action }
}
