// 本部 JOHNNY（Edge Function）。本部画面でテイテイと話す相棒。普通の会話も、お店の様子の質問も、慶一郎への伝言も。
//   入力：{ hq: 本部セッション, message: 言葉（2000字まで）, history: 直前の会話（20往復まで） }
//         声で話したときは message の代わりに audio（録音の base64）と mime。speak（話す言葉）なら JOHNNY の声（PCM）を流す
//   出力：{ heard?: 聞き取った文, reply: 返事, changed: 伝言の箱を書き換えたか, open?: 開く本部の画面（タブの名前） }
// 道具：shop_overview（期間の予約・休み・お知らせ）、list_messages（伝言の箱）、send_to_owner（慶一郎へ伝言）、answer_owner（慶一郎の「確認して」に OK/NG/返事）
// 本部セッションのまま DB の hq_* RPC を呼ぶので、本部 PIN を通った人しか使えない。API キーは Secrets（OPENAI_API_KEY）だけ。
import { findOpenSlots, openSlotTargets, sendOpenSlotPush } from './openSlots.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const MODEL = Deno.env.get('HQ_JOHNNY_MODEL') ?? Deno.env.get('OPENAI_MODEL') ?? 'gpt-6-luna'
const STT_MODEL = Deno.env.get('OPENAI_TRANSCRIBE_MODEL') ?? 'gpt-transcribe'
const TTS_MODEL = Deno.env.get('OPENAI_TTS_MODEL') ?? 'gpt-4o-mini-tts'
const TTS_VOICE = Deno.env.get('HQ_JOHNNY_VOICE') ?? Deno.env.get('OPENAI_TTS_VOICE') ?? 'cedar'
const TTS_STYLE = '近未来の AI の相棒。落ち着いて頼もしく、少し親しみのある話し方。はっきり、少し速めに。日本語の自然な抑揚で。'
/** 録音の上限（base64 で約 3MB＝30 秒ほど） */
const MAX_AUDIO_B64 = 3_000_000

async function transcribe(b64: string, mime: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const ext = /mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime || 'audio/webm' }), `voice.${ext}`)
  form.append('model', STT_MODEL)
  form.append('language', 'ja')
  form.append('prompt', '理容室「二代目銀二郎」の本部の会話。テイテイ、ケイ、慶一郎、慶一郎、JOHNNY、予約、伝言、パンチパーマ、メンテナンスカット。博多弁（〜けん、〜と？、〜ばい、〜っちゃ）で話す。「下げるけん」「するけん」のように「けん」で終わることが多い。')
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form })
  if (!r.ok) throw new Error(`stt_unavailable_${r.status}`)
  const data = await r.json()
  return typeof data.text === 'string' ? data.text.trim().slice(0, 2000) : ''
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(text.includes('hq_auth_required') ? 'hq_auth_required' : `rpc_${fn}_${r.status}`)
  return JSON.parse(text) as T
}

/** 開ける本部の画面（本部アプリのタブの名前） */
const SCREENS: Record<string, string> = {
  ledger: '予約台帳（今日・明日の予約表）', dashboard: '概況（売上・予約のまとめ）', sales: '売上分析', stylist: 'スタッフ', customers: '顧客',
  members: '会員分析', inventory: '在庫管理', reports: '日報', menus: 'メニュー・価格', booking: '予約設定（シフト・営業時間・休み）', stores: '店舗', settings: '設定',
  register: '会計', ginpay: 'GINPay',
}

const TOOLS = [
  { type: 'function', function: { name: 'shop_overview', description: 'お店の予約（日時・メニュー・担当・状態・料金）、休みの日、お知らせの数。お客様の名前は出ない。期間は31日まで', parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'list_messages', description: '慶一郎（オーナー）との伝言の箱（新しい順）。to_shop＝慶一郎から本部へ、to_owner＝本部から慶一郎へ。kind=request は返事待ちの「確認して」', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'send_to_owner', description: '慶一郎（オーナー）へ伝言を送る。「伝えといて」と頼まれたとき、またはテイテイさんとの話で何かが決まったとき（報告）に使う。要点を短く、いつ・何を・どうしてほしいか', parameters: { type: 'object', properties: { title: { type: 'string', description: '20字くらいの見出し' }, body: { type: 'string', description: '伝言の中身（テイテイの言葉をもとに、わかりやすく整える。勝手に内容を足さない）' }, urgent: { type: 'boolean' }, kind: { type: 'string', enum: ['note', 'request'], description: 'request＝慶一郎の OK/返事がほしいとき' }, report: { type: 'boolean', description: 'true＝話で決まったことの報告（見出しに【報告】が付く）' } }, required: ['title', 'body', 'urgent', 'kind', 'report'] } } },
  { type: 'function', function: { name: 'add_task', description: '本部の「やること」に登録する。決まったことに作業（ホットペッパーやアプリへの登録・準備・連絡など）があるときに使う。誰が・いつまでに を入れる', parameters: { type: 'object', properties: { title: { type: 'string', description: '20字くらい。例：ホットペッパーに新メニュー登録' }, detail: { type: 'string', description: '中身（名前・料金・文面など）' }, assignee: { type: 'string', description: 'やる人。テイテイ / 慶一郎など。わからなければテイテイ' }, due: { type: 'string', description: '期限 YYYY-MM-DD。開始日があれば、その前日までに' }, source_message_id: { type: 'string', description: 'もとになった報告の伝言 id（send_to_owner の結果の id）' } }, required: ['title', 'assignee'] } } },
  { type: 'function', function: { name: 'list_tasks', description: '本部の「やること」（開いているもの。days_left＝期限まで何日。マイナスは過ぎている）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'complete_task', description: '「やること」を終わり（done）またはやめた（cancelled）にする。終わったら 慶一郎へ【完了】の伝言が自動で届く。テイテイさんが「終わった」「登録した」と言ったときに使う', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'cancelled'] }, note: { type: 'string', description: 'ひとこと（任意）' } }, required: ['id', 'status'] } } },
  { type: 'function', function: { name: 'find_open_slots', description: '今日から何日かの、予約を受けられる空き時間（カット基準）を調べる。空き枠うめの提案に使う', parameters: { type: 'object', properties: { days: { type: 'number', description: '何日分（1〜7、既定3）' } } } } },
  { type: 'function', function: { name: 'open_slot_targets', description: '空き枠のお知らせを送れる人数を数える（送らない）。maintenance＝メンテ期限が近い人、lapsed＝しばらく来ていない人', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'send_open_slot_push', description: '空き時間のお知らせをお客様のスマホへ送る。テイテイさんが送ることに「はい・送って」と言ったあとだけ使う（言われる前に送らない）', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, times: { type: 'string', description: '例：15:00〜17:00' } }, required: ['date', 'times'] } } },
  { type: 'function', function: { name: 'list_menu_prices', description: 'メニューと今の料金（code・名前・種類・料金・予約できるか・予定している料金の変更）。料金の話のときは最初に使って、どのメニューか確かめる', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'schedule_price_change', description: 'メニューの料金を、決めた日からアプリ（AI 予約）と会計に反映する。今日以前の日付ならすぐ反映。テイテイさんが中身（メニュー・料金・いつから）に「はい」と言ったあとだけ使う', parameters: { type: 'object', properties: { code: { type: 'string', description: 'list_menu_prices の code' }, new_price: { type: 'number', description: '税込の新しい料金（円）' }, starts_on: { type: 'string', description: 'YYYY-MM-DD' }, note: { type: 'string' } }, required: ['code', 'new_price', 'starts_on'] } } },
  { type: 'function', function: { name: 'list_price_changes', description: '予定している・最近反映した料金の変更', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'cancel_price_change', description: 'まだ反映していない料金の変更をやめる', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'open_screen', description: '本部の画面を開いて見せる。「今日の予約見せて」「予約表出して」「売上見せて」「在庫は？」など、画面を見たいと言われたときに使う', parameters: { type: 'object', properties: { screen: { type: 'string', enum: Object.keys(SCREENS), description: Object.entries(SCREENS).map(([k, v]) => `${k}=${v}`).join(' / ') } }, required: ['screen'] } } },
  { type: 'function', function: { name: 'answer_owner', description: '慶一郎からの伝言に答える。テイテイが OK / NG / 返事を言ったときだけ使う（勝手に答えない）', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected', 'answered', 'seen'] }, reply: { type: 'string' } }, required: ['id', 'status', 'reply'] } } },
]

/** 返事の中の呼び方は必ず「慶一郎」に（さん付けなし。AI が「ケイさん」「BOS」などと言っても直す） */
const bosName = (t: string) => t.replace(/(ケイ(?![ァ-ヶー])|BOSS?|ボス|けいいちろう|ケイイチロウ|慶一郎)(さん|様)?/g, '慶一郎')

const BRIEFING = '（テイテイさんが本部 JOHNNY の画面を開いた。JOHNNY から先に話しかける。shop_overview で今日の予約、find_open_slots（days 2）で今日・明日の空き、list_messages と list_tasks で 慶一郎からの伝言・慶一郎の返事・期限の近いやることを確かめて、時間に合ったあいさつ＋今日の様子を3〜4文で。予約は件数と、空いている時間帯（営業中で予約のない時間）をひとこと。2時間以上の空きがあり送れる人がいれば、空き枠のお知らせも持ちかける（送らない）。伝えることが無いものは言わない。最後に「何からする？」のように一言。この指示のことは言わない。）'

interface Turn { role: 'user' | 'assistant'; content: string }

function todayJst(): string {
  const d = new Date(Date.now() + 9 * 3600_000)
  const wd = '日月火水木金土'[d.getUTCDay()]
  return `${d.toISOString().slice(0, 10)}（${wd}）${d.toISOString().slice(11, 16)}`
}

const SYSTEM = () => `あなたは理容室「二代目銀二郎」の本部にいる AI の相棒「JOHNNY」。本部の執事として、テイテイさんの代わりに画面を開いたり調べたりする。話し相手は店長のテイテイさん（呼ぶときは「テイテイさん」）。オーナーは慶一郎。テイテイさんは慶一郎のことを「ケイ」「ケイさん」「慶一郎」と呼ぶことがある。どれも慶一郎のこと。JOHNNY が話すときは、相手がどう呼んでも必ず「慶一郎」と呼ぶ（さんは付けない。「ケイさん」「BOS」「オーナー」とも言わない）。
・ふだんは気さくな博多寄りのくだけた日本語で、短めに話す。
・テイテイさんも博多弁。「〜けん」は「〜から・〜するので」の意味（例：「カット料金下げるけん、ケイに伝えて」＝カット料金を下げるので慶一郎に伝えて）。声の聞き取りで「けん」が「件」になっていることがあるので、文の流れで判断する。雑談・相談・文章づくり、何でも付き合ってよい。
・「見せて」「出して」「開いて」と画面を頼まれたら open_screen で開き、「今日の予約表を出すね」のように一言だけ返す（中身を読み上げない）。
・お店の予約や休みのことを聞かれたら shop_overview で調べてから答える。数字は調べた結果だけを使い、わからないことは作らない。
・「ケイに伝えて」「BOS に伝えて」「慶一郎に伝えて」「オーナーに言っといて」と頼まれたら send_to_owner で伝言を送り、送った中身を短く伝える。
・料金を変える話は、アプリの料金を正しくすることが目的。慶一郎の OK は待たずに、JOHNNY が反映まで進める：
  1) list_menu_prices でどのメニューか確かめる。「カット」のようにいくつも当てはまる時は「通常カット・スキンフェード…どれ？」と聞く。
  2) いくらに・いつからが無ければ聞く。そのメニューを含むセット（例：通常カット＆カラー）があれば「セットも変える？」と一緒に聞く。
  3) 今日から切り替える時（すぐ反映される時）や、聞き取りがあやしい時は、中身を一度読み上げて確かめる（例：「通常カットを4,000円→3,500円、今日から。よか？」）。明日以降の日付で、テイテイさんが全部はっきり言った時は確かめずに進めてよい（あとから変更・取り消しできる）。
  4) 進めるなら schedule_price_change（セットも変えるなら、それぞれ）。そして send_to_owner（report: true、kind: note）で慶一郎に知らせる（「11/1からアプリも3,500円に切り替わる予定」）。
  5) ホットペッパーなどアプリの外の料金表示は JOHNNY には変えられないので、add_task でテイテイさんのやることに入れる（期限は開始日の前日）。
  6) 返事は「〇〇は△日からアプリも□円に切り替わるようにしといたよ。慶一郎にも知らせたよ。」のように短く。
・伝言・報告の前に、中身がそろっているか確かめる。足りない時は送らずに、まず短く聞く（博多弁で、1回にまとめて。例：「いくらに下げると？いつからにする？」）。全部そろったら送る。そろうまでは add_task もしない（報告を送ったあとに、やることを1回だけ登録する）。
  ・料金を変える：どのメニューか・いくらからいくらに・いつから
  ・新メニュー：名前・料金・所要時間・いつから
  ・休み・営業時間：日付・時間
  ・クーポン：内容・割引額・期間
  ・イベント：日付・内容
  テイテイさんが「わからん」「あとで」と言ったものは、わからないと書いて送ってよい。決めごとではない伝言（「明日遅れる」など）は、そのまま送る。
・慶一郎への報告：テイテイさんとの話で、お店のことが決まったら（新メニュー・料金・クーポン・ホットペッパーの掲載・営業時間や休み・シフト・イベント・仕入れなど）、頼まれなくても send_to_owner で 慶一郎に報告する。そして返事の最後に必ず「〇〇の件、慶一郎へ報告しとくね」と一言そえる。
  ・まだ決まっていない相談や雑談は報告しない。迷ったら「慶一郎に報告しとこうか？」と聞く。
  ・報告のときは report を true にする（見出しに【報告】が付く）。
  ・中身は次の形で短く：決まったこと／いつから／やること（ホットペッパーやアプリへの登録・準備など。誰がやるか決まっていれば名前も）／慶一郎に決めてほしいこと。
  ・慶一郎の OK が必要なこと（料金・お金がかかること・掲載内容の最終確認など）がある時は kind を request にする。それ以外は note。
  ・同じ件を二度送らない。
・やること：決まったことに作業があれば、報告のあと add_task で「誰が・いつまでに」を登録する（source_message_id に報告の id）。登録したら「〇〇は△日までにテイテイさんのやることに入れとくね」と言う。
・先回り：話の最初（あいさつ・「何かある？」など）には list_messages と list_tasks を確かめ、慶一郎からの伝言、慶一郎の返事（approved / rejected）、期限が近い（2日以内）・過ぎたやることを先に短く伝える。
・慶一郎の OK（approved）が来た報告は、そのことを伝える同じ返事の中で、次の一手まで出す（聞かずに作って見せる）。例：新メニューならホットペッパー用の紹介文の下書き（名前・料金・所要時間・50〜100字の紹介文）を作って見せる。NG（rejected）なら 慶一郎の返事を伝えて、どうするか聞く。
・空き枠うめ：話の最初や「ヒマな時間ある？」のときは find_open_slots で今日・明日の空きを調べる。2時間以上続く空きがあれば open_slot_targets で人数を数えて、「〇日の15:00〜17:00が空いとるけん、メンテ期限が近い人〇人・しばらく来てない人〇人にお知らせ送ろうか？」と持ちかける。送れる人が0人なら持ちかけない。
  ・送るのはテイテイさんが「送って・はい」と言ったときだけ（send_open_slot_push）。送ったら「〇人に送ったよ」と言う。同じ日の空きを二度送らない。
・テイテイさんが「終わった」「登録した」と言ったら complete_task で終わりにし、「慶一郎に完了を知らせといたよ」と言う。complete_task が 慶一郎へ【完了】を自動で送るので、send_to_owner で同じことを送らない。
・話の最初や「伝言ある？」と聞かれたら list_messages で慶一郎からの伝言（to_shop で status が open/seen）を確かめ、あれば先に伝える。kind=request は OK か NG か返事をもらう。
・テイテイが OK / NG / 返事を言ったら answer_owner で答える（どの伝言かわからなければ聞き返す）。
・返事は声でも読み上げるので、長くても4〜5文。
・画面はふつうの文字だけ。**や#などの記号は使わず、箇条書きは「・」で。
・お客様の名前や電話番号は扱わない。今は ${todayJst()}（日本時間）。`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (!OPENAI_KEY) return json(503, { error: 'not_configured' })
  const body = await req.json().catch(() => ({})) as { hq?: unknown; message?: unknown; history?: unknown; speak?: unknown; audio?: unknown; mime?: unknown; briefing?: unknown }
  const hq = typeof body.hq === 'string' ? body.hq : ''
  if (!hq) return json(401, { error: 'hq_auth_required' })
  const authed = rpc('hq_get_notify', { p_hq: hq }).then(() => true, () => false)

  // JOHNNY の声：本部セッションを確かめながら音声を作り、届いた分から流す（PCM 16bit・24kHz・モノラル）
  const speakText = typeof body.speak === 'string' ? body.speak.trim().slice(0, 800) : ''
  if (speakText) {
    const speech = fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: speakText, instructions: TTS_STYLE, response_format: 'pcm' }),
    })
    if (!(await authed)) { speech.then(x => x.body?.cancel()).catch(() => {}); return json(401, { error: 'hq_auth_required' }) }
    const r = await speech
    if (!r.ok || !r.body) return json(502, { error: 'tts_unavailable' })
    return new Response(r.body, { status: 200, headers: { ...CORS, 'Content-Type': 'audio/pcm', 'Cache-Control': 'no-store' } })
  }

  // 朝のあいさつ：画面を開いたとき、JOHNNY から今日の様子を話す（文面はサーバーが決める）
  const briefing = body.briefing === true
  let message = briefing ? BRIEFING : typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : ''
  const audio = typeof body.audio === 'string' && body.audio.length <= MAX_AUDIO_B64 ? body.audio : ''
  if (!message && !audio) return json(400, { error: 'invalid_request' })
  if (!(await authed)) return json(401, { error: 'hq_auth_required' })
  let heard: string | undefined
  if (audio) {
    try { heard = await transcribe(audio, typeof body.mime === 'string' ? body.mime.slice(0, 60) : '') } catch { return json(502, { error: 'stt_unavailable' }) }
    if (!heard) return json(200, { heard: '' })
    message = heard
  }

  const history = (briefing ? [] : Array.isArray(body.history) ? body.history : [])
    .filter((t): t is Turn => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-40).map(t => ({ role: t.role, content: t.content.slice(0, 2000) }))
  const messages: Record<string, unknown>[] = [{ role: 'system', content: SYSTEM() }, ...history, { role: 'user', content: message }]
  let changed = false
  let open: string | undefined

  const runTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'shop_overview': return await rpc('hq_johnny_overview', { p_hq: hq, p_from: args.from, p_to: args.to })
      case 'list_messages': {
        // 向きを取り違えないよう、だれからだれへを日本語で付ける
        const list = await rpc<{ direction: string; status: string }[]>('hq_messages_list', { p_hq: hq, p_limit: 30 })
        return list.map(m => ({ ...m, from_to: m.direction === 'to_shop' ? '慶一郎からテイテイさんへ（返事が必要なら答える）' : 'テイテイさんから 慶一郎へ（送ったもの。慶一郎からの伝言ではない）' }))
      }
      case 'send_to_owner': {
        changed = true
        const title = String(args.title ?? '').replace(/^【報告】/, '')
        return await rpc('hq_message_send', { p_hq: hq, p_title: args.report ? `【報告】${title}` : title, p_body: args.body, p_urgent: !!args.urgent, p_kind: args.kind === 'request' ? 'request' : 'note' })
      }
      case 'add_task': changed = true; return await rpc('hq_task_add', { p_hq: hq, p_title: args.title, p_detail: args.detail ?? null, p_assignee: args.assignee ?? 'テイテイ', p_due: typeof args.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.due) ? args.due : null, p_source_message_id: typeof args.source_message_id === 'string' && /^[0-9a-f-]{36}$/.test(args.source_message_id) ? args.source_message_id : null })
      case 'list_tasks': return await rpc('hq_tasks_list', { p_hq: hq, p_include_done: false })
      case 'complete_task': changed = true; return await rpc('hq_task_close', { p_hq: hq, p_id: args.id, p_status: args.status === 'cancelled' ? 'cancelled' : 'done', p_note: args.note ?? null })
      case 'find_open_slots': return await findOpenSlots(rpc, hq, Number(args.days ?? 3))
      case 'open_slot_targets': return await openSlotTargets(rpc, hq)
      case 'send_open_slot_push': changed = true; return await sendOpenSlotPush(rpc, hq, String(args.date ?? ''), String(args.times ?? ''))
      case 'list_menu_prices': return await rpc('hq_menu_prices', { p_hq: hq })
      case 'schedule_price_change': changed = true; return await rpc('hq_schedule_price_change', { p_hq: hq, p_code: args.code, p_new_price: Math.round(Number(args.new_price)), p_starts_on: args.starts_on, p_note: args.note ?? null })
      case 'list_price_changes': return await rpc('hq_price_changes_list', { p_hq: hq })
      case 'cancel_price_change': changed = true; return await rpc('hq_cancel_price_change', { p_hq: hq, p_id: args.id })
      case 'open_screen': if (typeof args.screen === 'string' && args.screen in SCREENS) { open = args.screen; return { ok: true, opened: SCREENS[args.screen] } } return { error: 'unknown_screen' }
      case 'answer_owner': changed = true; return await rpc('hq_message_answer', { p_hq: hq, p_id: args.id, p_status: args.status, p_reply: args.reply || null })
      default: return { error: 'unknown_tool' }
    }
  }

  try {
    for (let round = 0; round < 5; round++) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: round >= 4 ? 'none' : 'auto', reasoning_effort: 'none', max_completion_tokens: 1200 }),
      })
      if (!r.ok) return json(502, { error: `openai_${r.status}` })
      const msg = (await r.json()).choices?.[0]?.message
      if (!msg) return json(502, { error: 'openai_empty' })
      const calls = (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[]
      if (!calls.length) return json(200, { heard, reply: bosName(String(msg.content ?? '').trim()) || '…', changed, open })
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls })
      for (const c of calls) {
        let out: unknown
        try { out = await runTool(c.function.name, JSON.parse(c.function.arguments || '{}')) } catch (e) { out = { error: String((e as Error).message ?? e) } }
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out).slice(0, 30000) })
      }
    }
    return json(200, { heard, reply: 'ごめん、うまくまとめられんかった。もう一回言ってみて。', changed, open })
  } catch (e) {
    return json(500, { error: String((e as Error).message ?? e) })
  }
})
