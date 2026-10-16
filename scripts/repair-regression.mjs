import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8')
const checks=[]
const check=(name,fn)=>{fn();checks.push(name)}
const compile = source => ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
class RpcError extends Error { constructor(code,message){super(message??code);this.code=code} }
const memory=()=>{const m=new Map;return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),m}}
function load(file,mocks,globals={}){
  const exports={};const context={exports,require:id=>{if(!(id in mocks))throw Error('Unmocked import '+id);return mocks[id]},console,Promise,...globals}
  runInNewContext(compile(read(file)),context,{filename:file})
  return exports
}
function declaration(file,name){const src=read(file);const ast=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);return ast.statements.find(s=>s.name?.text===name).getFullText(ast)}

// Exact API wrapper + durable client queue. Lost acknowledgement is injected after commit.
const storage=memory(), receipts=new Map;let issued=0, calls=[], loseAck=true, invalidReceipt=false
const api={};runInNewContext(compile(declaration('src/utils/ticketStore.ts','issueTickets')),{
  exports:api,RpcError,callStaffRpc:async(fn,p)=>{
    assert.equal(fn,'staff_issue_tickets_once');calls.push({...p})
    if(invalidReceipt)return{tickets:[]}
    if(!receipts.has(p.p_request_id)){
      issued+=p.p_quantity
      receipts.set(p.p_request_id,{tickets:Array.from({length:p.p_quantity},()=>({id:randomUUID(),user_id:p.p_user_id,type:p.p_type,amount:p.p_amount,used:false}))})
    }
    if(loseAck){loseAck=false;throw new RpcError('503','lost response')}
    return receipts.get(p.p_request_id)
  },
})
const queue=()=>load('src/utils/ticketIssuance.ts',{'../utils/ticketStore':api,'../utils/staffSession':{RpcError}},{localStorage:storage,crypto:{randomUUID}})
const input={userId:'test-member',type:'discount',amount:1000,quantity:1,staffName:'検証スタッフ',customerName:'検証会員'}
let q=queue(), request=q.prepareIssuance(input)
await assert.rejects(q.resolveIssuance(request),/lost response/)
check('Lost response retains durable pending request',()=>assert.equal(q.pendingIssuance().requestId,request.requestId))
q=queue();const restored=q.prepareIssuance({...input,amount:500})
check('Reload and changed form keep original request/payload',()=>{assert.equal(restored.requestId,request.requestId);assert.equal(restored.amount,1000)})
await q.resolveIssuance(restored)
check('Retry issues exactly one ticket and clears pending',()=>{assert.equal(issued,1);assert.equal(q.pendingIssuance(),null);assert.equal(calls[0].p_request_id,calls[1].p_request_id)})
invalidReceipt=true;request=q.prepareIssuance(input)
await assert.rejects(q.resolveIssuance(request),/発行結果/)
check('Malformed receipt cannot clear pending or report success',()=>assert.equal(q.pendingIssuance().requestId,request.requestId))
const blocked=queue();storage.setItem=()=>{throw Error('quota')};storage.removeItem('ginjiro_pending_ticket_issue_v1');const before=calls.length
assert.throws(()=>blocked.prepareIssuance(input),/quota/)
check('Storage failure prevents network issuance',()=>assert.equal(calls.length,before))

// Contact failure persists; recovery sends it once; ownership and in-flight edits are preserved.
let owner='member-A',session=true,fail=true,contactCalls=0,reply
const contacts=memory()
const contact=load('src/utils/customerContact.ts',{
  './customerSession':{hasCustomerSession:()=>session,callCustomerRpc:async()=>{contactCalls++;if(reply)return reply;if(fail)throw new RpcError('503');return{registered:true}}},
  './staffSession':{RpcError},'./phone':{normalizePhone:v=>/^0\d{9,10}$/.test(v.replaceAll('-',''))?v.replaceAll('-',''):null},'./userId':{getUserId:()=>owner},
},{localStorage:contacts})
assert.equal(await contact.saveContact('検証 会員','090-0000-0000'),'pending')
check('Network contact failure queued for the member',()=>{assert.equal(contact.pendingContact().name,'検証 会員');assert.equal(JSON.parse(contacts.getItem('ginjiro_pending_contact')).userId,'member-A')})
owner='member-B';await contact.flushPendingContact()
check('Member rebind cannot send another member contact',()=>assert.equal(contactCalls,1))
owner='member-A';fail=false;await contact.flushPendingContact()
check('Recovered connection saves queued contact',()=>{assert.equal(contactCalls,2);assert.equal(contact.pendingContact(),null)})
await assert.rejects(contact.saveContact('検証','not a phone'),/電話番号/)
check('Invalid phone makes no request',()=>assert.equal(contactCalls,2))
session=false;await contact.saveContact('古い名前','09000000000');session=true
let resolve;reply=new Promise(r=>resolve=r);const flushing=contact.flushPendingContact();session=false
await contact.saveContact('新しい名前','08000000000');resolve({});await flushing
check('Old acknowledgement cannot erase newer contact edit',()=>assert.equal(contact.pendingContact().name,'新しい名前'))

// Async camera lease must stop even if permission/start resolves after cancellation.
const life=load('src/utils/qrCameraLifecycle.ts',{})
let ready=0,scan=0,errors=0,stopped=0,startResolve
const device={isScanning:false,stops:0,clears:0,async start(decode){this.decode=decode;await new Promise(r=>startResolve=r);this.isScanning=true},async stop(){this.stops++;this.isScanning=false},clear(){this.clears++}}
const callbacks={onReady:()=>ready++,onScan:()=>scan++,onError:()=>errors++,onStopped:()=>stopped++}
const lease=life.startCameraLease(device,callbacks);await Promise.resolve();const cleanup=lease.cancel();startResolve();await cleanup
check('Late camera start after unmount is stopped once',()=>{assert.equal(device.isScanning,false);assert.equal(device.stops,1);assert.equal(device.clears,1);assert.equal(ready+scan+errors+stopped,0)})
let decode;const dev2={isScanning:false,async start(fn){decode=fn;this.isScanning=true},async stop(){this.isScanning=false},clear(){}}
life.startCameraLease(dev2,callbacks);await new Promise(r=>setImmediate(r));decode('one');decode('two');await new Promise(r=>setImmediate(r))
check('Repeated decodes deliver one result after camera stopped',()=>{assert.equal(scan,1);assert.equal(dev2.isScanning,false)})
const dev3={isScanning:false,async start(){throw Error('denied')},async stop(){},clear(){}}
life.startCameraLease(dev3,callbacks);await new Promise(r=>setImmediate(r))
check('Camera denial reaches manual input error once',()=>assert.equal(errors,1))

// Mobile Notification constructor fails; the SW path must deliver and mark success only then.
let notified=0,marked=0,constructorCalls=0,failNotify=false
const notification=load('src/utils/pushNotification.ts',{
  '../data/reserveLinks':{MAINTENANCE_CUT_URL:'https://example.invalid/booking'},
  './maintenanceSchedule':{shouldShowNotificationBanner:()=>true,hasNotifiedToday:()=>false,markNotifiedToday:()=>marked++},
},{window:{Notification:true},Notification:Object.assign(class{constructor(){constructorCalls++;throw Error('mobile constructor disabled')}},{permission:'granted'}),navigator:{serviceWorker:{getRegistration:async()=>({active:true,showNotification:async()=>{if(failNotify)throw Error('denied');notified++}})}}})
await Promise.all([notification.triggerMaintenanceNotification('2026-10-01'),notification.triggerMaintenanceNotification('2026-10-01')])
check('Mobile uses SW and collapses simultaneous foreground triggers',()=>{assert.equal(notified,1);assert.equal(marked,1);assert.equal(constructorCalls,0)})
failNotify=true;assert.equal(await notification.triggerMaintenanceNotification('2026-10-01'),false)
check('Notification failure is not marked delivered',()=>assert.equal(marked,1))

const handlers={};let opened=null,navigated=null,focused=0
const windows=[{url:'https://app.example/wallet',focus:async()=>focused++,navigate:async url=>{navigated=url;return{focus:async()=>focused++}}}]
runInNewContext(read('public/sw.js'),{URL,self:{location:{origin:'https://app.example'},addEventListener:(name,fn)=>handlers[name]=fn},clients:{matchAll:async()=>windows,openWindow:async url=>opened=url}})
async function click(url){let wait;handlers.notificationclick({notification:{close(){},data:{url}},waitUntil:p=>wait=p});await wait}
await click('https://example.invalid/booking')
check('External notification opens actual booking URL',()=>{assert.equal(opened,'https://example.invalid/booking');assert.equal(focused,0)})
await click('/reserve')
check('Same-origin notification navigates then focuses',()=>{assert.equal(navigated,'https://app.example/reserve');assert.equal(focused,1)})
opened=null;await click('javascript:alert(1)')
check('Notification rejects non-web target URLs',()=>assert.equal(opened,null))
console.log(JSON.stringify({passed:checks.length,checks,realNetworkRequests:0},null,2))
