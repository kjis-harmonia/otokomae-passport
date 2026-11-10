// Actual customer Edge entry points, intercepted network, no real accounts or AI calls.
import assert from 'node:assert/strict'
import {checkJohnnyStoreAccess} from '../supabase/functions/_shared/johnny-store-access.ts'
const session='local-member-session-'.repeat(3)
let handler,paidCalls=0,dbCalls=0
const realFetch=globalThis.fetch
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'

// Load the actual Deno entry, including parameter properties, without changing
// production code or enabling transform flags for unrelated test processes.
async function loadEdgeEntry(name,environment){
 const entry=new URL('../supabase/functions/'+name+'/index.ts',import.meta.url)
 let source=stripTypeScriptTypes(await readFile(entry,'utf8'),{mode:'transform'})
 source=source.replaceAll("'../_shared/johnny-store-access.ts'",JSON.stringify(new URL('../supabase/functions/_shared/johnny-store-access.ts',import.meta.url).href))
 if(name==='johnny-agent')source=source.replaceAll("'./agent.ts'",JSON.stringify(new URL('./agent.ts',entry).href)).replaceAll("'./usual.ts'",JSON.stringify(new URL('./usual.ts',entry).href))
 assert.doesNotMatch(source,/from\s*['"]\.\.?\//,'Entry imports must resolve to the real source files')
 await import('data:text/javascript;base64,'+Buffer.from(source+'\n// environment: '+environment).toString('base64'))
}
try{
 for(const base of ['https://kfufxzmucjljjouzpumi.supabase.co','https://ufyzynpmkxytnhebombq.supabase.co']){
  assert.deepEqual(await checkJohnnyStoreAccess(base,'fixture','short',()=>{throw Error('must not call')}),{status:401,error:'customer_auth_required'})
  assert.deepEqual(await checkJohnnyStoreAccess(base,'fixture',session,async()=>Response.json({verified:false})),{status:403,error:'store_verification_required'})
  assert.equal(await checkJohnnyStoreAccess(base,'fixture',session,async()=>Response.json({verified:true})),null)
  assert.deepEqual(await checkJohnnyStoreAccess(base,'fixture',session,async()=>Response.json({code:'28000'},{status:400})),{status:401,error:'customer_auth_required'})
  assert.deepEqual(await checkJohnnyStoreAccess(base,'fixture',session,async()=>Response.json({code:'PGRST202'},{status:404})),{status:503,error:'store_access_unavailable'})
  assert.deepEqual(await checkJohnnyStoreAccess(base,'fixture',session,async()=>{throw Error('offline')}),{status:503,error:'store_access_unavailable'})
  globalThis.Deno={env:{get:name=>({SUPABASE_URL:base,SUPABASE_ANON_KEY:'fixture-anon',OPENAI_API_KEY:'fake-test-key-no-real-network'})[name]},serve:fn=>{handler=fn}}
  globalThis.fetch=async(url)=>{
   if(String(url).startsWith('https://api.openai.com/')){paidCalls++;throw Error('Real AI network forbidden')}
   assert.equal(url,base+'/rest/v1/rpc/customer_store_access_status');dbCalls++
   return Response.json({verified:false})
  }
  await loadEdgeEntry('johnny-agent',new URL(base).hostname)
  for(const input of [{session,message:'明日予約したい'},{session,audio:'fixture',mime:'audio/webm'},{session,speak:'こんにちは'},{session,audio:'fixture',transcribe_only:true}]){
   const response=await handler(new Request('https://local.invalid',{method:'POST',body:JSON.stringify(input)}))
   assert.equal(response.status,403);assert.equal((await response.json()).error,'store_verification_required')
  }
  await loadEdgeEntry('johnny-style-advice',new URL(base).hostname)
  const consult=await handler(new Request('https://local.invalid',{method:'POST',body:JSON.stringify({session,message:'髪型を相談したい',menus:[]})}))
  assert.equal(consult.status,403)
 }
 assert.deepEqual(await checkJohnnyStoreAccess('https://unknown.supabase.co','fixture',session,()=>{throw Error('must not call')}),{status:503,error:'store_access_unavailable'})
 assert.equal(paidCalls,0);assert.equal(dbCalls,10)
 console.log('Both Staging and production store-access gates passed: invalid/unverified/approved/offline/missing migration; actual chat/STT/TTS/consult refuse unverified members before AI; unknown projects fail closed; paid AI calls=0')
}finally{globalThis.fetch=realFetch;delete globalThis.Deno}
