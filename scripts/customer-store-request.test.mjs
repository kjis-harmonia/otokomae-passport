import {test} from 'node:test'
import assert from 'node:assert/strict'
import {currentStoreRequest,sameStoreRequestOwner,validStoreRequest} from '../src/features/customerAccess/storeRequestState.ts'
const owner={userId:'local-member-a',session:'local-session-a',revision:0}
const request={id:'local-request',proof:'local-proof',user_id:owner.userId,expires_in:300}
const snapshot={...owner,request,error:'local-display-error'}
const hidden={request:null,error:''}

test('confirmation request and errors belong to one exact member/session/revision',()=>{
 assert.deepEqual(currentStoreRequest(snapshot,owner,true),{request,error:'local-display-error'})
 for(const other of [{...owner,userId:'local-member-b'},{...owner,session:'local-session-renewed'},{...owner,revision:1}]){
  assert.equal(sameStoreRequestOwner(owner,other),false)
  assert.deepEqual(currentStoreRequest(snapshot,other,true),hidden)
 }
})
test('disabled or unloaded confirmation never exposes the previous request',()=>{
 assert.deepEqual(currentStoreRequest(snapshot,owner,false),hidden)
 assert.deepEqual(currentStoreRequest(null,owner,true),hidden)
})
test('legacy members without a session still have strictly member-bound request state',()=>{
 const legacy={...owner,session:null}
 assert.deepEqual(currentStoreRequest({...snapshot,...legacy},legacy,true),{request,error:'local-display-error'})
 assert.deepEqual(currentStoreRequest({...snapshot,...legacy},owner,true),hidden)
})
test('a server request needs a matching member, nonempty proof/id and finite positive expiry',()=>{
 assert.equal(validStoreRequest(request,owner.userId),true)
 for(const bad of [null,{},[],{...request,id:''},{...request,proof:''},{...request,user_id:'other'},
  ...[undefined,null,0,-1,Infinity,NaN,'300'].map(expires_in=>({...request,expires_in}))])assert.equal(validStoreRequest(bad,owner.userId),false)
})
