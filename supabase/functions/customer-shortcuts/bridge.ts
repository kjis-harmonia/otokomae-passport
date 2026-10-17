// Transport for iPhone Shortcuts. Johnny remains a read-only proposal engine.
// Only an explicit confirm action reaches the transaction that commits a booking.
type Obj = Record<string, unknown>
export interface Config { base: string; anonKey: string; serviceKey: string }
interface State { v: 1; device: string; expires: number; history: {role: string; text: string}[]; shown?: Obj; proposal?: string }
const STAGING = 'https://kfufxzmucjljjouzpumi.supabase.co'
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type, authorization, apikey','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'}
const enc = new TextEncoder()
const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
const bytes = (s: string) => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))
const object = (x: unknown): Obj => x && typeof x==='object' && !Array.isArray(x) ? x as Obj : {}
const text = (x: unknown,max=300) => typeof x==='string' ? x.trim().slice(0,max) : ''
class Failure extends Error { code: string; status: number; constructor(code: string,status=409){super(code);this.code=code;this.status=status} }
const MESSAGES: Record<string,string> = {
  shortcut_auth_required:'連携キーが無効か期限切れです。銀二郎appから連携し直してください。',
  customer_auth_required:'銀二郎appで会員情報を確認し、連携し直してください。',
  contact_required:'初回だけ銀二郎appで予約用の氏名と電話番号を登録してください。',
  booking_disabled:'現在アプリからの予約を受け付けていません。店舗へお電話ください。',
  rate_limited:'少し時間を置いて、もう一度お試しください。',
  too_many_devices:'連携数が上限に達しました。銀二郎appで連携を解除してから設定し直してください。',
  proposal_expired:'仮確保の期限が切れました。希望の日時をもう一度お伝えください。',
  hold_expired:'仮確保の期限が切れました。希望の日時をもう一度お伝えください。',
  slot_taken:'その時間は埋まりました。別の時間をお伝えください。',
  quote_changed:'メニューの内容か料金が更新されました。内容を確認し直してください。',
  invalid_state:'会話の有効期限が切れました。新しく予約を始めてください。',
  confirm_required:'表示された内容を確認して「この内容で予約する」を選んでください。',
  invalid_request:'入力を確認して、もう一度お試しください。',
  service_unavailable:'通信できませんでした。時間を置いてお試しください。',
}
async function key(config: Config,purpose: string,algorithm: 'AES-GCM'|'HMAC') {
  const digest=await crypto.subtle.digest('SHA-256',enc.encode('ginjiro-shortcuts-v1:'+purpose+':'+config.serviceKey))
  return crypto.subtle.importKey('raw',digest,algorithm==='HMAC'?{name:'HMAC',hash:'SHA-256'}:{name:'AES-GCM'},false,algorithm==='HMAC'?['sign','verify']:['encrypt','decrypt'])
}
export async function encryptSession(session: string,config: Config) {
  const nonce=crypto.getRandomValues(new Uint8Array(12))
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},await key(config,'session','AES-GCM'),enc.encode(session))
  return 'v1.'+b64(nonce)+'.'+b64(new Uint8Array(encrypted))
}
async function decryptSession(cipher: string,config: Config) {
  const [v,nonce,data]=cipher.split('.')
  if(v!=='v1'||!nonce||!data)throw new Failure('shortcut_auth_required',401)
  try{return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(nonce)},await key(config,'session','AES-GCM'),bytes(data)))}
  catch{throw new Failure('shortcut_auth_required',401)}
}
async function signState(state: State,config: Config) {
  const payload=b64(enc.encode(JSON.stringify(state)))
  return payload+'.'+b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(config,'state','HMAC'),enc.encode(payload))))
}
async function readState(raw: unknown,device: string,config: Config): Promise<State> {
  if(!raw)return {v:1,device,expires:Date.now()+20*60000,history:[]}
  if(typeof raw!=='string'||raw.length>12000)throw new Failure('invalid_state')
  try{
    const parts=raw.split('.')
    if(parts.length!==2||!await crypto.subtle.verify('HMAC',await key(config,'state','HMAC'),bytes(parts[1]),enc.encode(parts[0])))throw Error('signature')
    const state=JSON.parse(new TextDecoder().decode(bytes(parts[0]))) as State
    if(state.v!==1||state.device!==device||state.expires<Date.now()||!Array.isArray(state.history))throw Error('state')
    return state
  }catch{throw new Failure('invalid_state')}
}
const dateTime=(s: string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(s))
const quoteText=(q: Obj)=>`${dateTime(String(q.starts_at))}、${q.nominated?q.staff_name+'指名':'指名なし'}。${(q.items as Obj[]).map(i=>i.name).join('・')}、${Number(q.total_price).toLocaleString('ja-JP')}円。この内容で予約しますか？ 仮確保は${dateTime(String(q.expires_at))}までです。`

export async function handleShortcut(req: Request,config: Config,fetcher: typeof fetch=fetch): Promise<Response> {
  const reply=(status: number,body: Obj)=>new Response(JSON.stringify(body),{status,headers:CORS})
  if(req.method==='OPTIONS')return reply(200,{})
  if(req.method!=='POST')return reply(405,{kind:'error',say:'この操作にはPOSTを使用してください。'})
  if(config.base.replace(/\/$/,'')!==STAGING||!config.anonKey||!config.serviceKey)return reply(503,{kind:'error',say:'この機能はStagingで準備中です。'})
  const rpc=async(name: string,args: Obj,privileged=true): Promise<Obj>=>{
    const apiKey=privileged?config.serviceKey:config.anonKey
    const res=await fetcher(config.base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:apiKey,Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(15000)})
    const data=object(await res.json())
    if(!res.ok)throw new Failure(/shortcut_auth_required/.test(String(data.message))?'shortcut_auth_required':/customer_auth_required/.test(String(data.message))?'customer_auth_required':'service_unavailable',res.status===401||res.status===403?401:503)
    if(typeof data.error==='string')throw new Failure(data.error)
    return data
  }
  try{
    if(Number(req.headers.get('content-length'))>16384)throw new Failure('invalid_request',400)
    const raw=await req.text()
    if(raw.length>16384)throw new Failure('invalid_request',400)
    let body: Obj
    try{body=object(JSON.parse(raw))}catch{throw new Failure('invalid_request',400)}
    const action=text(body.action,30)
    if(action==='pair'){
      const session=text(body.session,200)
      if(session.length<32)throw new Failure('customer_auth_required',401)
      const token='gjsc_'+b64(crypto.getRandomValues(new Uint8Array(32)))
      const created=await rpc('shortcut_pair_device',{p_session:session,p_token:token,p_ciphertext:await encryptSession(session,config)})
      return reply(200,{kind:'paired',token,expires_at:created.expires_at})
    }
    if(!['status','talk','confirm'].includes(action))throw new Failure('invalid_request',400)
    const token=text(body.token,100)
    if(!/^gjsc_[A-Za-z0-9_-]{43}$/.test(token))throw new Failure('shortcut_auth_required',401)
    const auth=await rpc('shortcut_auth_device',{p_token:token})
    if(action==='status'){
      const days=typeof auth.days_remaining==='number'?auth.days_remaining:null
      let say=days===null?'まだ来店の記録がありません。':days<0?'14日以内のメンテナンス優待は期限を過ぎています。':days===0?'メンテナンス優待は本日までです。':`メンテナンス優待はあと${days}日です。`
      const next=object(auth.next_booking)
      if(next.starts_at)say+=` 次のご予約は${dateTime(String(next.starts_at))}です。`
      return reply(200,{kind:'status',say,days_remaining:days,next_booking:auth.next_booking??null})
    }
    const session=await decryptSession(String(auth.session_ciphertext),config)
    const state=await readState(body.state,String(auth.device_id),config)
    if(action==='confirm'){
      if(!state.proposal)throw new Failure('confirm_required')
      const booking=await rpc('shortcut_confirm_booking',{p_token:token,p_session:session,p_proposal_id:state.proposal})
      return reply(200,{kind:'complete',say:`${dateTime(String(booking.starts_at))}で予約を承りました。`,reservation_id:booking.id})
    }
    const message=text(body.message)
    if(!message)throw new Failure('invalid_request',400)
    if(/^(はい|うん|確定|予約する|お願いします)[。!！\s]*$/.test(message)&&state.proposal)throw new Failure('confirm_required')
    const response=await fetcher(config.base+'/functions/v1/johnny-agent',{method:'POST',headers:{apikey:config.anonKey,Authorization:'Bearer '+config.anonKey,'Content-Type':'application/json'},body:JSON.stringify({session,message,history:state.history,shown:state.shown}),signal:AbortSignal.timeout(25000)})
    const answer=object(await response.json()),ui=object(answer.ui)
    if(!response.ok||typeof answer.say!=='string'||!ui.type)throw new Failure(typeof answer.error==='string'?answer.error:'service_unavailable',503)
    state.history=[...state.history,{role:'user',text:message},{role:'assistant',text:text(answer.say,240)}].slice(-8)
    state.expires=Date.now()+20*60000
    state.proposal=undefined
    if(ui.type==='confirm_booking'){
      const result=await rpc('shortcut_prepare_booking',{p_token:token,p_session:session,p_starts_at:ui.starts_at,p_menu_code:ui.menu_code,p_staff_id:ui.staff_id??null})
      const quote=object(result.quote)
      state.proposal=String(result.proposal_id)
      state.shown={confirm:{menu_code:ui.menu_code,starts_at:quote.starts_at,staff_id:quote.nominated?quote.staff_id:null}}
      return reply(200,{kind:'confirm',say:quoteText(quote),state:await signState(state,config)})
    }
    if(['confirm_cancel','confirm_change'].includes(String(ui.type)))return reply(200,{kind:'handoff',say:'ご予約の変更・キャンセルは銀二郎appからお願いします。'})
    if(ui.type==='handoff')return reply(200,{kind:'handoff',say:text(answer.say,240)})
    state.shown=ui.type==='slots'?{menu_code:ui.menu_code,times:ui.times,staff_id:ui.staff_id??null}:undefined
    return reply(200,{kind:'message',say:text(answer.say,240),state:await signState(state,config)})
  }catch(e){
    const code=e instanceof Failure?e.code:'service_unavailable'
    return reply(e instanceof Failure?e.status:503,{kind:'error',error:code,say:MESSAGES[code]??MESSAGES.service_unavailable})
  }
}
