import assert from 'node:assert/strict'
import {handleShortcut,encryptSession} from '../supabase/functions/customer-shortcuts/bridge.ts'
const config={base:'https://kfufxzmucjljjouzpumi.supabase.co',anonKey:'test-public',serviceKey:'test-server-only-key'}
const session='test-session-'.padEnd(64,'x'),token='gjsc_'+'A'.repeat(43),otherToken='gjsc_'+'B'.repeat(43)
const cipher=await encryptSession(session,config),calls=[],checks=[]
let nextUi={type:'confirm_booking',menu_code:'cut',staff_id:'staff-1',starts_at:'2026-10-20T06:00:00Z'}
const fake=async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url,body})
  if(url.endsWith('/shortcut_auth_device'))return Response.json({device_id:body.p_token===token?'device-1':'device-2',session_ciphertext:cipher,days_remaining:3,next_booking:null})
  if(url.endsWith('/shortcut_pair_device'))return Response.json({device_id:'device-1',expires_at:'2026-11-16T00:00:00Z'})
  if(url.endsWith('/johnny-agent'))return Response.json({say:'AIの提案文',ui:nextUi})
  if(url.endsWith('/shortcut_prepare_booking'))return Response.json({proposal_id:'proposal-1',quote:{starts_at:'2026-10-20T06:00:00Z',expires_at:'2026-10-17T03:15:00Z',nominated:true,staff_name:'銀二郎',total_price:5000,items:[{name:'カット'}]}})
  if(url.endsWith('/shortcut_confirm_booking'))return Response.json({id:'reservation-1',starts_at:'2026-10-20T06:00:00Z'})
  throw Error('unexpected request: '+url)
}
const post=async(body,fetcher=fake,c=config)=>{
  const res=await handleShortcut(new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),c,fetcher)
  return {status:res.status,body:await res.json()}
}
const a=(ok,label)=>{assert.ok(ok,label);checks.push(label)}
let r=await post({action:'status',token})
a(r.body.say.includes('あと3日'),'maintenance status matches the server result')
a(!calls.some(c=>c.url.includes('johnny-agent')),'maintenance requires no AI call')
a(!JSON.stringify(r).includes(session)&&!JSON.stringify(r).includes(cipher),'status exposes neither customer session nor ciphertext')
r=await post({action:'pair',session})
a(/^gjsc_[A-Za-z0-9_-]{43}$/.test(r.body.token),'pair issues an independent random scoped token')
const pairing=calls.find(c=>c.url.endsWith('/shortcut_pair_device')).body
a(!pairing.p_ciphertext.includes(session),'customer session is encrypted before database persistence')
r=await post({action:'confirm',token})
a(r.body.error==='confirm_required','confirm without a proposal cannot book')
r=await post({action:'talk',token,message:'火曜日15時に銀二郎でカット'})
const state=r.body.state
a(r.body.kind==='confirm'&&r.body.say.includes('5,000円')&&r.body.say.includes('銀二郎'),'confirmation text uses the held database quote')
a(!calls.some(c=>c.url.endsWith('/shortcut_confirm_booking')),'talk and preview never commit reservations')
const agentCall=calls.find(c=>c.url.endsWith('/johnny-agent'))
a(agentCall.body.session===session&&!('audio' in agentCall.body)&&!('speak' in agentCall.body),'existing Johnny receives text; no paid transcription or speech synthesis')
a(!JSON.stringify(r.body).includes(session),'conversation state never exposes the long lived session')
const confirmations=()=>calls.filter(c=>c.url.endsWith('/shortcut_confirm_booking')).length
let before=confirmations()
r=await post({action:'talk',token,state,message:'はい'})
a(r.body.error==='confirm_required'&&confirmations()===before,'spoken yes cannot bypass the explicit confirmation menu')
r=await post({action:'confirm',token,state:state.slice(0,-3)+'abc'})
a(r.body.error==='invalid_state'&&confirmations()===before,'tampered conversation state cannot confirm')
r=await post({action:'confirm',token:otherToken,state})
a(r.body.error==='invalid_state'&&confirmations()===before,'state is bound to the paired device')
const savedNow=Date.now
Date.now=()=>savedNow()+21*60000
r=await post({action:'confirm',token,state})
Date.now=savedNow
a(r.body.error==='invalid_state'&&confirmations()===before,'expired conversation state cannot confirm')
before=calls.filter(c=>c.url.includes('johnny-agent')).length
r=await post({action:'confirm',token,state})
a(r.body.kind==='complete'&&r.body.reservation_id==='reservation-1','explicit confirmation commits through the idempotent database function')
a(calls.filter(c=>c.url.includes('johnny-agent')).length===before,'final confirmation requires no AI call')
nextUi={type:'confirm_cancel',reservation_id:'someone'}
r=await post({action:'talk',token,message:'キャンセルして'})
a(r.body.kind==='handoff','v1 does not mutate cancellations or changes')
r=await post({action:'confirm',token:'invalid'})
a(r.status===401,'invalid scoped tokens are rejected')
before=calls.length
r=await post({action:'status',token},fake,{...config,base:'https://production.example.test'})
a(r.status===503&&calls.length===before,'bridge refuses every non Staging project before making a request')
r=await post({action:'status',token},async()=>{throw Error(session+' '+config.serviceKey)})
a(r.body.error==='service_unavailable'&&!JSON.stringify(r).includes(session)&&!JSON.stringify(r).includes(config.serviceKey),'transport failures do not leak credentials')
console.log(JSON.stringify({passed:checks.length,checks,realNetworkCalls:0},null,2))
