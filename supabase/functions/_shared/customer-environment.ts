// Public deployment identities. Never derive an RP ID or trusted origin from a request.
export interface CustomerEnvironment {name:'staging'|'production';base:string;origin:string;rpID:string}
const STAGING:Readonly<CustomerEnvironment>=Object.freeze({name:'staging',base:'https://kfufxzmucjljjouzpumi.supabase.co',origin:'https://otokomae-passport-staging.vercel.app',rpID:'otokomae-passport-staging.vercel.app'})
const PRODUCTION:Readonly<CustomerEnvironment>=Object.freeze({name:'production',base:'https://ufyzynpmkxytnhebombq.supabase.co',origin:'https://otokomae-passport.vercel.app',rpID:'otokomae-passport.vercel.app'})
export function customerEnvironment(base:unknown):Readonly<CustomerEnvironment>|null {
  return base===STAGING.base?STAGING:base===PRODUCTION.base?PRODUCTION:null
}
export function customerAccessEnabled(base:unknown,productionEnabled:unknown=false):boolean {
  const environment=customerEnvironment(base)
  return environment?.name==='staging'||(environment?.name==='production'&&productionEnabled===true)
}
