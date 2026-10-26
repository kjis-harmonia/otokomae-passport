// Node 24+. Disposable credentials and intercepted fetch only; no external writes or paid API.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import * as webauthn from '@simplewebauthn/server'
import {softwareAuthenticator} from './test-helpers/software-authenticator.mjs'
import {customerEnvironment,customerAccessEnabled} from '../supabase/functions/_shared/customer-environment.ts'
import {createPasskeyHandler} from '../supabase/functions/customer-passkeys/bridge.ts'
const stage=customerEnvironment('https://kfufxzmucjljjouzpumi.supabase.co')
const prod=customerEnvironment('https://ufyzynpmkxytnhebombq.supabase.co')
const session='disposable-member-session-'.repeat(3)
const request=(config,body,origin=config.origin)=>new Request(config.base+'/functions/v1/customer-passkeys',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)})

test('only the two exact projects are recognized; production needs explicit opt-in',()=>{
 assert.equal(customerAccessEnabled(stage.base),true)
 assert.equal(customerAccessEnabled(stage.base,false),true)
 for(const value of [undefined,false,'true','false',1])assert.equal(customerAccessEnabled(prod.base,value),false)
 assert.equal(customerAccessEnabled(prod.base,true),true)
 for(const base of [undefined,'',prod.base+'/',prod.base+'/path',prod.base+'.example',prod.base.replace('https:','http:'),'https://other.supabase.co']){assert.equal(customerEnvironment(base),null);assert.equal(customerAccessEnabled(base,true),false)}
 assert(Object.isFrozen(stage));assert(Object.isFrozen(prod))
 assert.notEqual(stage.origin,prod.origin);assert.notEqual(stage.rpID,prod.rpID)
})

test('disabled, mixed, unknown and foreign-origin configurations fail before database access',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('must not call')}
 const valid={...stage,serviceKey:'fake-fixture-key'}
 for(const config of [
  {...prod,serviceKey:'fake-fixture-key'},
  {...prod,serviceKey:'fake-fixture-key',productionEnabled:false},
  {...prod,serviceKey:'fake-fixture-key',productionEnabled:true,origin:stage.origin},
  {...prod,serviceKey:'fake-fixture-key',productionEnabled:true,rpID:stage.rpID},
  {...valid,base:'https://unknown.supabase.co',productionEnabled:true},
  {...valid,origin:'https://preview.example'},
  {...valid,rpID:prod.rpID},
  {...valid,serviceKey:''},
 ]){
  const response=await createPasskeyHandler(config,webauthn,fetcher)(request(config,{action:'status',session}))
  assert.equal(response.status,503);assert.equal(calls,0)
 }
 for(const environment of [stage,prod]){
  const config={...environment,serviceKey:'fake-fixture-key',productionEnabled:true}
  const handle=createPasskeyHandler(config,webauthn,fetcher)
  for(const origin of [environment===stage?prod.origin:stage.origin,'https://preview.example','null']){
   assert.equal((await handle(request(config,{action:'status',session},origin))).status,403);assert.equal(calls,0)
  }
  const noOrigin=new Request(config.base,{method:'POST',body:'{}'});assert.equal((await handle(noOrigin)).status,403)
  const options=await handle(new Request(config.base,{method:'OPTIONS',headers:{origin:config.origin}}))
  assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-origin'),config.origin);assert.equal(calls,0)
 }
})

for(const environment of [stage,prod])test(environment.name+': real signed enrollment/login goes through the actual bridge with the matching RP and origin',async()=>{
 const config={...environment,serviceKey:'fake-fixture-key-'+environment.name,productionEnabled:true}
 const challenges=new Map(),calls=[];let credential=null
 const fetcher=async(url,options)=>{
  assert.equal(url,config.base+'/rest/v1/rpc/customer_passkey_service')
  const {p_action:action,p_input:input}=JSON.parse(options.body);calls.push(action)
  if(action==='limit')return Response.json({allowed:true})
  if(action==='register_context'){assert.equal(input.session,session);return Response.json({handle:'disposable-handle',name:'架空会員'})}
  if(action==='put_challenge'){challenges.set(input.id,input);return Response.json({ok:true})}
  if(action==='consume_challenge'){
   const challenge=challenges.get(input.id);challenges.delete(input.id)
   if(!challenge||challenge.kind!==input.kind)return Response.json({message:'challenge_expired'},{status:400})
   if(input.kind==='register')assert.equal(input.session,session)
   return Response.json({challenge:challenge.challenge})
  }
  if(action==='finish_register'){credential={...input,handle:'disposable-handle'};return Response.json({ok:true})}
  if(action==='credential'){assert.equal(input.credential_id,credential.credential_id);return Response.json(credential)}
  if(action==='finish_login'){assert.equal(input.old_counter,credential.counter);assert(input.new_counter>input.old_counter);credential.counter=input.new_counter;return Response.json({user_id:'fixture-member',name:'架空会員',session})}
  throw Error('Unexpected action '+action)
 }
 const handle=createPasskeyHandler(config,webauthn,fetcher)
 const post=async body=>{const res=await handle(request(config,body));return {status:res.status,body:await res.json()}}
 const auth=softwareAuthenticator(config.rpID,config.origin)
 let prepared=await post({action:'register_options',session})
 assert.equal(prepared.status,200);assert.equal(prepared.body.options.rp.id,config.rpID)
 assert.equal(prepared.body.options.authenticatorSelection.userVerification,'required')
 let response=await post({action:'register_verify',session,id:prepared.body.id,response:auth.register(prepared.body.options)})
 assert.equal(response.status,200);assert.equal(response.body.ok,true);assert(credential.public_key)
 prepared=await post({action:'login_options'})
 assert.equal(prepared.body.options.rpId,config.rpID);assert.equal(prepared.body.options.userVerification,'required')
 const assertion=auth.authenticate(prepared.body.options)
 response=await post({action:'login_verify',id:prepared.body.id,response:assertion})
 assert.equal(response.status,200);assert.equal(response.body.session,session)
 response=await post({action:'login_verify',id:prepared.body.id,response:assertion});assert.equal(response.status,400)
 for(const changes of [
  {origin:environment===stage?prod.origin:stage.origin},
  {rpID:environment===stage?prod.rpID:stage.rpID},
  {badSignature:true},{flags:1},{challenge:'wrong'},{userHandle:'wrong'}
 ]){
  prepared=await post({action:'login_options'})
  const before=calls.filter(x=>x==='finish_login').length
  response=await post({action:'login_verify',id:prepared.body.id,response:auth.authenticate(prepared.body.options,changes)})
  assert.equal(response.status,400);assert.equal(calls.filter(x=>x==='finish_login').length,before)
 }
})

test('the actual client flag and endpoint follow the configured project, not a production label',async()=>{
 let source=await readFile(new URL('../src/features/customerAccess/passkeys.ts',import.meta.url),'utf8')
 source=source
  .replace(/import \{clearCustomerSession,getCustomerSession,saveCustomerSession\}[^\n]+/,"const clearCustomerSession=()=>{},getCustomerSession=()=>globalThis.__accessFixture.session,saveCustomerSession=()=>{}")
  .replace(/import \{getStoredValue,loadMemberStatus,saveMemberStatus,setStoredValue,ONBOARDING_DONE_KEY,ONBOARDING_NAME_KEY\}[^\n]+/,"const getStoredValue=()=>null,loadMemberStatus=()=>({}),saveMemberStatus=()=>{},setStoredValue=()=>{},ONBOARDING_DONE_KEY='done',ONBOARDING_NAME_KEY='name'")
  .replace(/import \{USER_ID_KEY\}[^\n]+/,"const USER_ID_KEY='user'")
  .replace("'../../../supabase/functions/_shared/customer-environment.ts'",JSON.stringify(new URL('../supabase/functions/_shared/customer-environment.ts',import.meta.url).href))
  .replaceAll('import.meta.env.VITE_SUPABASE_URL','globalThis.__accessFixture.base')
  .replaceAll('import.meta.env.VITE_CUSTOMER_ACCESS_ENABLED','globalThis.__accessFixture.flag')
  .replaceAll('import.meta.env.VITE_SUPABASE_ANON_KEY',"'fake-public-key'")
 source=stripTypeScriptTypes(source,{mode:'transform'})
 assert(!source.includes('../../utils/'),'Fixture imports were not replaced')
 const savedFetch=globalThis.fetch,calls=[]
 globalThis.fetch=async(url,options)=>{calls.push(url);assert.equal(JSON.parse(options.body).session,session);return Response.json({user_id:'fixture-member',name:'架空会員',registered:true})}
 try{
  for(const [base,flag,enabled] of [[stage.base,undefined,true],[stage.base,'false',true],[prod.base,undefined,false],[prod.base,'false',false],[prod.base,'true',true],['https://other.supabase.co','true',false]]){
   globalThis.__accessFixture={base,flag,session}
   const client=await import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+crypto.randomUUID()).toString('base64'))
   assert.equal(client.CUSTOMER_ACCESS_ENABLED,enabled);const before=calls.length
   if(enabled){assert.equal((await client.passkeyStatus()).registered,true);assert.equal(calls.at(-1),base+'/functions/v1/customer-passkeys')}
   else {await assert.rejects(client.passkeyStatus(),/準備中/);assert.equal(calls.length,before)}
  }
 }finally{globalThis.fetch=savedFetch;delete globalThis.__accessFixture}
})

test('actual Deno entry selects the fixed environment and reads a strict production switch',async()=>{
 let source=stripTypeScriptTypes(await readFile(new URL('../supabase/functions/customer-passkeys/index.ts',import.meta.url),'utf8'),{mode:'transform'})
 source=source
  .replace("'npm:@simplewebauthn/server@13.3.3'",JSON.stringify(import.meta.resolve('@simplewebauthn/server')))
  .replace("'./bridge.ts'",JSON.stringify(new URL('../supabase/functions/customer-passkeys/bridge.ts',import.meta.url).href))
  .replace("'../_shared/customer-environment.ts'",JSON.stringify(new URL('../supabase/functions/_shared/customer-environment.ts',import.meta.url).href))
 const savedFetch=globalThis.fetch;let handler,calls=0
 globalThis.fetch=async()=>{calls++;return Response.json({allowed:true})}
 try{
  for(const [environment,flag,status] of [[prod,undefined,503],[prod,'false',503],[prod,'TRUE',503],[prod,'true',200],[stage,undefined,200]]){
   globalThis.Deno={env:{get:name=>({SUPABASE_URL:environment.base,SUPABASE_SERVICE_ROLE_KEY:'fake-local-key',CUSTOMER_ACCESS_ENABLED:flag})[name]},serve:fn=>{handler=fn}}
   await import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+crypto.randomUUID()).toString('base64'))
   const before=calls
   const result=await handler(request(environment,{action:'login_options'}))
   assert.equal(result.status,status)
   if(status===503)assert.equal(calls,before)
   else {assert.equal((await result.json()).options.rpId,environment.rpID);assert.equal(result.headers.get('access-control-allow-origin'),environment.origin)}
  }
 }finally{globalThis.fetch=savedFetch;delete globalThis.Deno}
})
