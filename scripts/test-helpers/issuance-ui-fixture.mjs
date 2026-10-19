// Explicitly launched localhost fixture only. Never forwards to Supabase or a paid API.
import {createServer} from 'vite'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url)).replaceAll('\\','/').replace(/\/$/,'')
const backend='http://127.0.0.1:5198'
const calls=[],receipts=new Map()
const pending={userId:'qa-member',type:'discount',amount:500,quantity:2,staffName:'テイテイ',customerName:'検証用会員',requestId:'11111111-1111-4111-8111-111111111111',backend}
const setup='<script>if(new URL(location.href).searchParams.get("qa")==="issue-recovery"&&!sessionStorage.getItem("qa-seeded")){sessionStorage.setItem("qa-seeded","yes");localStorage.setItem("ginjiro_staff_session",JSON.stringify({token:"local-fake-staff",expiresAt:new Date(Date.now()+3600000).toISOString()}));localStorage.setItem("ginjiro_staff_name","テイテイ");localStorage.setItem("ginjiro_pending_ticket_issue_v1",'+JSON.stringify(JSON.stringify(pending))+');}</script>'
const server=await createServer({root,configFile:root+'/vite.config.ts',
 define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(backend),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('local-fixture-only-no-real-key')},
 server:{host:'127.0.0.1',port:5198,strictPort:true,headers:{'Content-Security-Policy':"connect-src 'self' ws://127.0.0.1:5198; font-src 'self' data:;"}},
 plugins:[{name:'local-issue-fixture',enforce:'pre',
 transformIndexHtml:{order:'pre',handler:html=>html.replace('<head>','<head>'+setup)},
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,backend), fn=url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1]
  if(url.pathname==='/__qa/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({calls,receipts:receipts.size,externalForwarding:false}));return}
  if(!fn)return next()
  let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw||'{}')
  calls.push({fn,requestId:b.p_request_id??null})
  let result
  if(fn==='staff_session_valid')result=true
  else if(fn==='staff_issue_tickets_once'){
   if(!receipts.has(b.p_request_id))receipts.set(b.p_request_id,Array.from({length:b.p_quantity},(_,i)=>({id:b.p_request_id+':'+i,user_id:b.p_user_id,type:b.p_type,title:'検証割引券',amount:b.p_amount,used:false,created_at:new Date().toISOString(),issued_by:b.p_staff_name})))
   result={tickets:receipts.get(b.p_request_id)}
  }else result={error:'qa_unhandled_rpc'}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result))
 })}}
]})
await server.listen();console.log('Local UI fixture: http://127.0.0.1:5198/staff.html?qa=issue-recovery; fake member only; no external database forwarding')
