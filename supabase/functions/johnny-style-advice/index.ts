// JOHNNY：髪型の相談だけ AI（OpenAI）に聞く Edge Function。お客様アプリの予約アシスタントから呼ぶ。
//   入力：お客様の顧客セッション・相談の文（300字まで）・メニュー表（コード・名前・時間・料金、80件まで）
//   出力：{ reply: 返事（100字くらい）, menu_codes: おすすめ（メニュー表の中から最大3つ） }
// 決まり：
//   ・API キーは Supabase の Secrets（OPENAI_API_KEY）だけ。無ければ 503（アプリは店頭へのご案内に切り替える）
//   ・顧客セッションが有効なときだけ使える（customer_get_tickets で確かめる）。名前・電話番号は AI に送らない
//   ・空き・予約・料金の約束はさせない（メニュー表の料金を言うのは可）。使いすぎは OpenAI の月の上限で止める
// モデルは OPENAI_MODEL（既定 gpt-6-luna）。

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-6-luna'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

interface Menu { code: string; name: string; duration_min: number; price: number | null }

function cleanMenus(raw: unknown): Menu[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 80).flatMap((m): Menu[] => {
    if (!m || typeof m !== 'object') return []
    const { code, name, duration_min, price } = m as Record<string, unknown>
    if (typeof code !== 'string' || typeof name !== 'string' || code.length > 60 || name.length > 60) return []
    return [{ code, name, duration_min: Number(duration_min) || 0, price: typeof price === 'number' ? price : null }]
  })
}

/** 顧客セッションが有効か（無効・失効なら false） */
async function validSession(session: string): Promise<boolean> {
  if (session.length < 32) return false
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/customer_get_tickets`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_session: session }),
  })
  return r.ok
}

const SYSTEM = [
  'あなたは理容室「二代目銀二郎」のアシスタント JOHNNY です。お客様の髪型の相談に、日本語で短く答えます。',
  '・返事は2文まで、100字くらいまで。やさしく、言い切りすぎない。',
  '・おすすめのメニューは、渡されたメニュー表の中から最大3つ、code で選ぶ。表に無いメニューは作らない。',
  '・予約の空き・日時・割引の約束はしない。料金と時間はメニュー表の数字だけを使う。',
  '・髪型と関係ない話は、やさしく予約の相談に戻す。医療・薬の話はしない。',
  '・必ず次の JSON だけで答える：{"reply": "返事", "menu_codes": ["code", ...]}',
].join('\n')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (!OPENAI_KEY) return json(503, { error: 'not_configured' })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'invalid_request' }) }
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 300) : ''
  const session = typeof body.session === 'string' ? body.session : ''
  const menus = cleanMenus(body.menus)
  if (!message) return json(400, { error: 'invalid_request' })
  if (!(await validSession(session))) return json(401, { error: 'customer_auth_required' })

  const menuTable = menus.map(m => `${m.code}\t${m.name}\t${m.duration_min}分\t${m.price == null ? '店頭' : `${m.price}円`}`).join('\n')
  const ai = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      max_completion_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `メニュー表（code・名前・時間・料金）：\n${menuTable}\n\nお客様の相談：${message}` },
      ],
    }),
  })
  if (!ai.ok) return json(502, { error: 'ai_unavailable' })
  try {
    const data = await ai.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
    const known = new Set(menus.map(m => m.code))
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 200) : ''
    const codes = Array.isArray(parsed.menu_codes) ? parsed.menu_codes.filter((c: unknown) => typeof c === 'string' && known.has(c)).slice(0, 3) : []
    if (!reply) return json(502, { error: 'ai_unavailable' })
    return json(200, { reply, menu_codes: codes })
  } catch {
    return json(502, { error: 'ai_unavailable' })
  }
})
