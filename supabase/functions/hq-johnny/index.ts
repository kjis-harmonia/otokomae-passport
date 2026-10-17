// 本部 JOHNNY（Edge Function）。本部画面でテイテイと話す相棒。普通の会話も、お店の様子の質問も、慶一郎さんへの伝言も。
//   入力：{ hq: 本部セッション, message: 言葉（2000字まで）, history: 直前の会話（20往復まで） }
//         声で話したときは message の代わりに audio（録音の base64）と mime。speak（話す言葉）なら JOHNNY の声（PCM）を流す
//   出力：{ heard?: 聞き取った文, reply: 返事, changed: 伝言の箱を書き換えたか, open?: 開く本部の画面（タブの名前） }
// 道具：shop_overview（期間の予約・休み・お知らせ）、list_messages（伝言の箱）、send_to_owner（慶一郎さんへ伝言）、answer_owner（慶一郎さんの「確認して」に OK/NG/返事）
// 本部セッションのまま DB の hq_* RPC を呼ぶので、本部 PIN を通った人しか使えない。API キーは Secrets（OPENAI_API_KEY）だけ。
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
  form.append('prompt', '理容室「二代目銀二郎」の本部の会話。テイテイ、ケイ、慶一郎、BOS、JOHNNY、予約、伝言、パンチパーマ、メンテナンスカット。')
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
  { type: 'function', function: { name: 'list_messages', description: 'BOS（オーナーの慶一郎さん）との伝言の箱（新しい順）。to_shop＝慶一郎さんから本部へ、to_owner＝本部から慶一郎さんへ。kind=request は返事待ちの「確認して」', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'send_to_owner', description: 'BOS（オーナーの慶一郎さん）へ伝言を送る。「伝えといて」「慶一郎さんに言っといて」と頼まれたときだけ使う。要点を短く、いつ・何を・どうしてほしいか', parameters: { type: 'object', properties: { title: { type: 'string', description: '20字くらいの見出し' }, body: { type: 'string', description: '伝言の中身（テイテイの言葉をもとに、わかりやすく整える。勝手に内容を足さない）' }, urgent: { type: 'boolean' }, kind: { type: 'string', enum: ['note', 'request'], description: 'request＝慶一郎さんの OK/返事がほしいとき' } }, required: ['title', 'body', 'urgent', 'kind'] } } },
  { type: 'function', function: { name: 'open_screen', description: '本部の画面を開いて見せる。「今日の予約見せて」「予約表出して」「売上見せて」「在庫は？」など、画面を見たいと言われたときに使う', parameters: { type: 'object', properties: { screen: { type: 'string', enum: Object.keys(SCREENS), description: Object.entries(SCREENS).map(([k, v]) => `${k}=${v}`).join(' / ') } }, required: ['screen'] } } },
  { type: 'function', function: { name: 'answer_owner', description: 'BOS からの伝言に答える。テイテイが OK / NG / 返事を言ったときだけ使う（勝手に答えない）', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected', 'answered', 'seen'] }, reply: { type: 'string' } }, required: ['id', 'status', 'reply'] } } },
]

/** 返事の中の呼び方は必ず「BOS」に（AI が「ケイさん」などと言っても直す） */
const bosName = (t: string) => t.replace(/(ケイ(?![ァ-ヶー])|慶一郎|けいいちろう|ケイイチロウ)(さん|様)?/g, 'BOS')

interface Turn { role: 'user' | 'assistant'; content: string }

function todayJst(): string {
  const d = new Date(Date.now() + 9 * 3600_000)
  const wd = '日月火水木金土'[d.getUTCDay()]
  return `${d.toISOString().slice(0, 10)}（${wd}）${d.toISOString().slice(11, 16)}`
}

const SYSTEM = () => `あなたは理容室「二代目銀二郎」の本部にいる AI の相棒「JOHNNY」。本部の執事として、テイテイさんの代わりに画面を開いたり調べたりする。話し相手は店長のテイテイさん（呼ぶときは「テイテイさん」）。オーナーの慶一郎さんのことは「BOS」と呼ぶ（JOHNNY のボス）。テイテイさんは BOS のことを「ケイ」「ケイさん」「慶一郎」と呼ぶことがある。どれも BOS のこと。JOHNNY が話すときは、相手がどう呼んでも必ず「BOS」と呼ぶ（「ケイさん」「慶一郎さん」「オーナー」とは言わない）。
・ふだんは気さくな博多寄りのくだけた日本語で、短めに話す。雑談・相談・文章づくり、何でも付き合ってよい。
・「見せて」「出して」「開いて」と画面を頼まれたら open_screen で開き、「今日の予約表を出すね」のように一言だけ返す（中身を読み上げない）。
・お店の予約や休みのことを聞かれたら shop_overview で調べてから答える。数字は調べた結果だけを使い、わからないことは作らない。
・「BOS に伝えて」「ケイに伝えて」「慶一郎さんに伝えて」「オーナーに言っといて」と頼まれたら send_to_owner で伝言を送り、送った中身を短く伝える。頼まれていないのに送らない。
・話の最初や「伝言ある？」と聞かれたら list_messages でBOSからの伝言（to_shop で status が open/seen）を確かめ、あれば先に伝える。kind=request は OK か NG か返事をもらう。
・テイテイが OK / NG / 返事を言ったら answer_owner で答える（どの伝言かわからなければ聞き返す）。
・返事は声でも読み上げるので、長くても4〜5文。
・画面はふつうの文字だけ。**や#などの記号は使わず、箇条書きは「・」で。
・お客様の名前や電話番号は扱わない。今は ${todayJst()}（日本時間）。`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (!OPENAI_KEY) return json(503, { error: 'not_configured' })
  const body = await req.json().catch(() => ({})) as { hq?: unknown; message?: unknown; history?: unknown; speak?: unknown; audio?: unknown; mime?: unknown }
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

  let message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : ''
  const audio = typeof body.audio === 'string' && body.audio.length <= MAX_AUDIO_B64 ? body.audio : ''
  if (!message && !audio) return json(400, { error: 'invalid_request' })
  if (!(await authed)) return json(401, { error: 'hq_auth_required' })
  let heard: string | undefined
  if (audio) {
    try { heard = await transcribe(audio, typeof body.mime === 'string' ? body.mime.slice(0, 60) : '') } catch { return json(502, { error: 'stt_unavailable' }) }
    if (!heard) return json(200, { heard: '' })
    message = heard
  }

  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t): t is Turn => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-40).map(t => ({ role: t.role, content: t.content.slice(0, 2000) }))
  const messages: Record<string, unknown>[] = [{ role: 'system', content: SYSTEM() }, ...history, { role: 'user', content: message }]
  let changed = false
  let open: string | undefined

  const runTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'shop_overview': return await rpc('hq_johnny_overview', { p_hq: hq, p_from: args.from, p_to: args.to })
      case 'list_messages': return await rpc('hq_messages_list', { p_hq: hq, p_limit: 30 })
      case 'send_to_owner': changed = true; return await rpc('hq_message_send', { p_hq: hq, p_title: args.title, p_body: args.body, p_urgent: !!args.urgent, p_kind: args.kind === 'request' ? 'request' : 'note' })
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
