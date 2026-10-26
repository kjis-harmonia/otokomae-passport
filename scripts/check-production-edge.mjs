// Human-run negative/preflight HTTP checks only. No POST, member/secret, RPC or paid API.
import assert from 'node:assert/strict'
const allowed=['johnny-notify','johnny-agent','hq-johnny','customer-passkeys','johnny-style-advice']
const name=process.argv[2]
if(!allowed.includes(name))throw Error('Choose exactly one reviewed production function: '+allowed.join(', '))
const base='https://ufyzynpmkxytnhebombq.supabase.co/functions/v1/'
const origin='https://otokomae-passport.vercel.app'
async function request(method,headers={}){
 const r=await fetch(base+name,{method,headers,redirect:'error',signal:AbortSignal.timeout(15000)})
 const status=r.status,cors=r.headers.get('access-control-allow-origin')
 await r.body?.cancel()
 return {status,cors}
}
if(name==='customer-passkeys'){
 const valid=await request('OPTIONS',{Origin:origin})
 assert.equal(valid.status,204,'Expected enabled production passkeys with OPTIONS 204; stop')
 assert.equal(valid.cors,origin,'Wrong production CORS origin; stop')
 const foreign=await request('OPTIONS',{Origin:'https://otokomae-passport-staging.vercel.app'})
 assert.equal(foreign.status,403,'Foreign origin must fail; stop')
 console.log('PASS customer-passkeys: production OPTIONS 204, Staging origin 403. No challenge/session created.')
}else{
 const denied=await request('GET')
 assert.equal(denied.status,401,'Expected gateway JWT rejection 401; verify deployed JWT setting and stop')
 console.log('PASS '+name+': unauthenticated GET rejected with 401. No paid request/notification sent.')
}
