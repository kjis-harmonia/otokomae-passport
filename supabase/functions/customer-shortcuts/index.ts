import {handleShortcut} from './bridge.ts'
Deno.serve((request: Request)=>handleShortcut(request,{
  base:Deno.env.get('SUPABASE_URL')??'',
  anonKey:Deno.env.get('SUPABASE_ANON_KEY')??'',
  serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',
}))
