import assert from 'node:assert/strict'
import {prepareStagingTestMember} from '../src/shortcuts/testMember.ts'
const checks=[]
function fixture(){
  let session=null,pending=null,contactFails=false
  const calls=[]
  const deps={projectUrl:'https://kfufxzmucjljjouzpumi.supabase.co',session:()=>session,canStore:()=>true,pending:()=>pending,
    rememberPending:x=>{pending=x},rememberSession:(_,s)=>{session=s},
    async rpc(name,args){calls.push({name,args});if(name==='customer_register')return {user_id:'test-member',session:'new-test-session'.padEnd(64,'x')};if(contactFails)throw Error('offline');return {ok:true}},
  }
  return {deps,calls,setExisting:s=>{session=s},failContact:()=>{contactFails=true},restoreContact:()=>{contactFails=false}}
}
const a=(ok,label)=>{assert.ok(ok,label);checks.push(label)}
let f=fixture()
const session=await prepareStagingTestMember(' 検証名 ',f.deps)
a(session===f.deps.session(),'a clean browser receives and saves its own authenticated Staging session')
a(f.calls.map(x=>x.name).join(',')==='customer_register,customer_set_contact','registration completes verified test contact before pairing')
a(f.calls[0].args.p_name==='検証名'&&f.calls[0].args.p_has_visited_before===true,'explicit test registration does not issue a welcome coupon')
a(f.calls[1].args.p_phone==='09000000000'&&f.deps.pending()===null,'only the new test identity receives the documented dummy phone')
await prepareStagingTestMember('別の名前',f.deps)
a(f.calls.length===2,'retries with an existing authenticated member never create another member or overwrite contact')
f=fixture();f.setExisting('existing-member-session'.padEnd(64,'x'))
await prepareStagingTestMember('任意',f.deps)
a(f.calls.length===0,'existing members keep their identity and all account data')
f=fixture();f.failContact()
await assert.rejects(()=>prepareStagingTestMember('検証名',f.deps),/offline/)
a(!!f.deps.session()&&!!f.deps.pending(),'contact failure preserves the completed registration and a retry marker')
f.restoreContact();await prepareStagingTestMember('変更した表示名',f.deps)
a(f.calls.filter(x=>x.name==='customer_register').length===1&&f.deps.pending()===null,'contact retry completes the original member without duplicate signup')
a(f.calls.at(-1).args.p_name==='検証名','contact retry uses the original test identity')
f=fixture();f.deps.projectUrl='https://production.example.test'
await assert.rejects(()=>prepareStagingTestMember('検証名',f.deps),/Staging/)
a(f.calls.length===0,'every non Staging backend is rejected before a write')
f=fixture();f.deps.canStore=()=>false
await assert.rejects(()=>prepareStagingTestMember('検証名',f.deps),/保存/)
a(f.calls.length===0,'blocked browser storage prevents orphaned signup')
f=fixture();await assert.rejects(()=>prepareStagingTestMember(' ',f.deps),/表示名/)
a(f.calls.length===0,'blank names cannot create test accounts')
console.log(JSON.stringify({passed:checks.length,checks,realNetworkCalls:0},null,2))
