export interface StoreRequest {id:string;proof:string;user_id:string;expires_in:number}
export interface StoreRequestOwner {userId:string;session:string|null;revision:number}
export interface StoreRequestSnapshot extends StoreRequestOwner {request:StoreRequest|null;error:string}

export function sameStoreRequestOwner(a:StoreRequestOwner,b:StoreRequestOwner):boolean {
  return a.userId===b.userId&&a.session===b.session&&a.revision===b.revision
}

/** A confirmation request is displayable only for the member who requested it. */
export function currentStoreRequest(snapshot:StoreRequestSnapshot|null,owner:StoreRequestOwner,enabled:boolean){
  if(!enabled||!snapshot||!sameStoreRequestOwner(snapshot,owner))return {request:null,error:''}
  return {request:snapshot.request,error:snapshot.error}
}

export function validStoreRequest(value:unknown,userId:string):value is StoreRequest {
  if(!value||typeof value!=='object')return false
  const r=value as Partial<StoreRequest>
  return typeof r.id==='string'&&r.id.length>0&&typeof r.proof==='string'&&r.proof.length>0&&r.user_id===userId&&
    typeof r.expires_in==='number'&&Number.isFinite(r.expires_in)&&r.expires_in>0
}
