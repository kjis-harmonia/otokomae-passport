import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
const source=readFileSync(new URL('../src/screens/TicketWalletScreen.tsx',import.meta.url),'utf8')
const start=source.indexOf('  const refreshTickets = useCallback('),end=source.indexOf('  const refreshVisit =',start)
assert.ok(start>0&&end>start)
let tickets=null,error=null,nextResponse,requests=[]
const ctx={useCallback:fn=>fn,userId:'test-member',ticketRequest:{current:0},getUserTickets:()=>nextResponse,
  setTickets:rows=>tickets=rows,setTicketsError:message=>error=message}
runInNewContext(ts.transpileModule(source.slice(start,end)+';this.refresh=refreshTickets',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,ctx)
const tick=()=>new Promise(r=>setImmediate(r))
nextResponse=Promise.reject(Error('offline'));ctx.refresh();await tick()
assert.equal(tickets,null);assert.match(error,/読み込めません/)
const rows=[{id:'ticket-1',amount:1000}];nextResponse=Promise.resolve(rows);ctx.refresh();await tick()
assert.equal(tickets,rows);assert.equal(error,null)
nextResponse=Promise.reject(Error('offline'));ctx.refresh();await tick()
assert.equal(tickets,rows);assert.match(error,/読み込めません/)
let failOld;nextResponse=new Promise((_,reject)=>failOld=reject);ctx.refresh()
const fresh=[{id:'ticket-2'}];nextResponse=Promise.resolve(fresh);ctx.refresh();await tick();failOld(Error('stale failure'));await tick()
assert.equal(tickets,fresh);assert.equal(error,null)
console.log('Wallet regression: 4 checks passed (initial error, recover, retain previous tickets, ignore stale response); no network')
