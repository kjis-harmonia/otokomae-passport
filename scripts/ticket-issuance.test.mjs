import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
const drafts=new URL('../',import.meta.url)
class RpcError extends Error {constructor(code,message=code){super(message);this.code=code}}
async function load(file,replacements){let s=stripTypeScriptTypes(await readFile(new URL(file,drafts),'utf8'),{mode:'transform'});for(const [from,to] of replacements){assert(s.includes(from),from);s=s.replace(from,to)}return import('data:text/javascript;base64,'+Buffer.from(s+'\n// '+crypto.randomUUID()).toString('base64'))}
const KEY='ginjiro_pending_ticket_issue_v1'
const input={userId:'member-a',type:'discount',amount:500,quantity:2,staffName:'operator-a',customerName:'fixture-a'}
async function fixture(){
 const values=new Map(),receipts=new Map(),calls=[]
 const harness={backend:'https://local-project-a.example.invalid',RpcError,calls,receipts,values,busy:false,failSave:false,failRemove:false,dropResponse:false,hold:null}
 harness.send=async request=>{calls.push(structuredClone(request));let r=receipts.get(request.requestId);if(!r){r=Array.from({length:request.quantity},(_,i)=>({id:request.requestId+':'+i,...request}));receipts.set(request.requestId,r)}if(harness.hold)await harness.hold;if(harness.dropResponse){harness.dropResponse=false;throw Error('simulated response loss')}return r}
 globalThis.__ticketIssueHarness=harness
 globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(harness.failSave)throw Error('quota');values.set(key,value)},removeItem:key=>{if(harness.failRemove)throw Error('storage failure');values.delete(key)}}
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name,options,work)=>{assert.equal(options.ifAvailable,true);if(harness.busy)return work(null);harness.busy=true;try{return await work({name})}finally{harness.busy=false}}}}})
 const flow=await load('src/utils/ticketIssuance.ts',[
  ["import { issueTickets } from './ticketStore';",'const issueTickets=(p)=>globalThis.__ticketIssueHarness.send(p);'],
  ["import { RpcError } from './staffSession';",'const RpcError=globalThis.__ticketIssueHarness.RpcError;'],
  ['import.meta.env.VITE_SUPABASE_URL','globalThis.__ticketIssueHarness.backend']
 ])
 return {flow,harness}
}
test('ticket issue saves before sending; response loss/reload uses the original request and operator',async()=>{
 const {flow,harness}=await fixture();harness.dropResponse=true
 const request=flow.prepareIssuance(input);assert(harness.values.has(KEY))
 await assert.rejects(flow.withIssuanceLock(()=>flow.resolveIssuance(request)),/response loss/)
 const recovered=flow.pendingIssuance();assert.deepEqual(recovered,request)
 await flow.withIssuanceLock(()=>flow.resolveIssuance(recovered))
 assert.equal(harness.receipts.size,1);assert.equal(harness.calls.length,2)
 assert.deepEqual(harness.calls[0],harness.calls[1]);assert.equal(harness.values.has(KEY),false)
})
test('storage failures and corrupt pending records never send a replacement issue',async()=>{
 const {flow,harness}=await fixture();harness.failSave=true
 assert.throws(()=>flow.prepareIssuance(input),/quota/);assert.equal(harness.calls.length,0)
 harness.failSave=false;harness.values.set(KEY,'{broken')
 assert.throws(()=>flow.prepareIssuance(input),e=>e.code==='pending_issue_invalid');assert.equal(harness.calls.length,0)
})
test('another project and legacy requests with unknown backend cannot be replayed',async()=>{
 const {flow,harness}=await fixture();const request=flow.prepareIssuance(input)
 harness.backend='https://local-project-b.example.invalid'
 await assert.rejects(flow.resolveIssuance(request),e=>e.code==='issue_backend_mismatch');assert.equal(harness.calls.length,0)
 harness.backend=request.backend;const legacy={...request};delete legacy.backend;harness.values.set(KEY,JSON.stringify(legacy))
 assert.throws(()=>flow.prepareIssuance(input),e=>e.code==='issue_backend_mismatch');assert.equal(harness.calls.length,0)
})
test('a pending request cannot be overwritten by a new customer or altered operator',async()=>{
 const {flow,harness}=await fixture();const request=flow.prepareIssuance(input)
 assert.throws(()=>flow.prepareIssuance({...input,userId:'member-b'}),e=>e.code==='pending_issue_exists')
 await assert.rejects(flow.resolveIssuance({...request,staffName:'operator-b'}),e=>e.code==='pending_issue_changed')
 assert.deepEqual(flow.pendingIssuance(),request);assert.equal(harness.calls.length,0)
})
test('completion-storage failure retains the original key and a retry creates no extra tickets',async()=>{
 const {flow,harness}=await fixture();const request=flow.prepareIssuance(input);harness.failRemove=true
 await assert.rejects(flow.resolveIssuance(request),/storage failure/)
 assert.deepEqual(flow.pendingIssuance(),request);harness.failRemove=false
 await flow.resolveIssuance(request);assert.equal(harness.receipts.size,1)
})
test('another browser tab is rejected instead of queued while an issue is in flight',async()=>{
 const {flow,harness}=await fixture();let release;harness.hold=new Promise(resolve=>{release=resolve})
 const first=flow.withIssuanceLock(()=>flow.resolveIssuance(flow.prepareIssuance(input)))
 await Promise.resolve()
 await assert.rejects(flow.withIssuanceLock(()=>flow.resolveIssuance(flow.prepareIssuance(input))),e=>e.code==='issue_busy')
 release();await first;assert.equal(harness.receipts.size,1)
})
async function storeFixture(){
 const h={RpcError,calls:[],session:true,response:{tickets:[]},error:null}
 h.callStaffRpc=async(fn,p)=>{h.calls.push({kind:'staff',fn,p});if(h.error)throw h.error;return h.response}
 h.callRpc=async(fn,p)=>{h.calls.push({kind:'legacy',fn,p});throw Error('Unexpected legacy RPC')}
 h.callCustomerRpc=async(fn,p)=>{if(!h.session)throw new RpcError('customer_auth_required');h.calls.push({kind:'customer',fn,p});return{ticket:{id:'safe-received-ticket'}}}
 globalThis.__ticketStoreHarness=h
 const store=await load('src/utils/ticketStore.ts',[
  ["import { removeStoredValue } from './storage';",'const removeStoredValue=()=>{};'],
  ["import { supabase } from '../lib/supabase';",'const supabase={from(){throw Error("Unexpected direct table access")}};'],
  ["import { callRpc, callStaffRpc, isMissingRpc, RpcError } from './staffSession';",'const {callRpc,callStaffRpc,RpcError}=globalThis.__ticketStoreHarness;const isMissingRpc=()=>false;'],
  ["import { callCustomerRpc, readAsCustomer, saveCustomerSession } from './customerSession';",'const {callCustomerRpc}=globalThis.__ticketStoreHarness;const readAsCustomer=()=>{};const saveCustomerSession=()=>{};']
 ])
 return {store,h}
}
test('ticketStore calls only the durable RPC and validates the complete receipt',async()=>{
 const {store,h}=await storeFixture();const request={...input,requestId:crypto.randomUUID()}
 h.response={tickets:[{id:'one',user_id:input.userId,type:input.type,amount:input.amount},{id:'two',user_id:input.userId,type:input.type,amount:input.amount}]}
 assert.equal((await store.issueTickets(request)).length,2)
 assert.equal(h.calls[0].fn,'staff_issue_tickets_once');assert.equal(h.calls[0].p.p_request_id,request.requestId)
 h.response={tickets:[h.response.tickets[0],h.response.tickets[0]]}
 await assert.rejects(store.issueTickets(request),e=>e.code==='invalid_issue_receipt')
 h.error=new RpcError('PGRST202');await assert.rejects(store.issueTickets(request));assert(h.calls.every(c=>c.fn==='staff_issue_tickets_once'))
})
test('transfer requires a customer session and never falls back to a display-ID based RPC',async()=>{
 const {store,h}=await storeFixture();h.session=false
 await assert.rejects(store.acceptTransfer('local-transfer'),/引き継ぎが必要/);assert.equal(h.calls.length,0)
 h.session=true;assert.equal((await store.acceptTransfer('local-transfer')).id,'safe-received-ticket')
 assert.deepEqual(h.calls,[{kind:'customer',fn:'customer_claim_transfer',p:{p_token:'local-transfer'}}])
})
