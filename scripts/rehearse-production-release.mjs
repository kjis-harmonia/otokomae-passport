#!/usr/bin/env node
// Applies the exact human-run files to a disposable loopback PostgreSQL database only.
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const root=resolve(process.argv[2]??dirname(dirname(fileURLToPath(import.meta.url))))
const connection=process.argv[3]
if(!connection)throw new Error('Usage: node scripts/rehearse-production-release.mjs [repo] postgresql://postgres@127.0.0.1:55433/release_rehearsal_NAME')
const url=new URL(connection)
if(!['postgresql:','postgres:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='55433'||!/^\/release_rehearsal_[a-z0-9_]+$/.test(url.pathname)||url.search||url.hash||url.username!=='postgres'||url.password)throw new Error('Only a dedicated disposable loopback DB is allowed; remote URLs and overrides are rejected')
const pg=process.env.RELEASE_PSQL??'C:/Program Files/PostgreSQL/17/bin/psql.exe'
const out=join(root,'supabase/rollout/out_release'),logs=join(root,'.qa','release-rehearsal',url.pathname.slice(1))
mkdirSync(logs,{recursive:true})
const manifest=JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'))
if(manifest.project_ref!=='ufyzynpmkxytnhebombq'||manifest.entries.length!==22||manifest.baseline!==26||manifest.final!==47)throw new Error('Unexpected release manifest')
for(const item of manifest.files){
 if(!/^[a-zA-Z0-9_.-]+\.sql$/.test(item.file)||item.file.includes('..')||createHash('sha256').update(readFileSync(join(out,item.file))).digest('hex')!==item.sha256)throw new Error('Generated SQL changed; review and regenerate before rehearsal')
 if(item.source&&createHash('sha256').update(readFileSync(join(root,'supabase/migrations',item.source+'.sql'))).digest('hex')!==item.source_sha256)throw new Error('Migration source changed since generation')
}
const report={database:url.pathname.slice(1),remote_writes:0,passed:[],status:'RUNNING'}
function sql(text,label){
 const p=spawnSync(pg,['-X','-w','--dbname',connection,'-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],{input:text,encoding:'utf8',maxBuffer:32*1024*1024})
 writeFileSync(join(logs,label+'.log'),JSON.stringify({exit_code:p.status,sqlstates:[...(p.stderr??'').matchAll(/ERROR:\s*([0-9A-Z]{5})\b/g)].map(m=>m[1]),raw_output_saved:false})+'\n')
 if(p.status!==0)throw new Error(label+' failed; stopped. Inspect private .qa log; no subsequent step was run.')
 return p.stdout.trim()
}
function file(name,label=name.replace(/[^a-zA-Z0-9_-]/g,'_')){return sql(readFileSync(join(out,name),'utf8'),label)}
const snapshot=()=>JSON.parse(sql(readFileSync(join(root,'supabase/tests/preflight_baseline_snapshot.sql'),'utf8'),'snapshot-latest'))
let before,bookingBefore
function unchanged(label){const after=snapshot();if(JSON.stringify(after)!==JSON.stringify(before)||sql('select app_booking_enabled from public.booking_settings;','setting-latest')!==bookingBefore)throw new Error(label+': existing business data or booking setting changed; STOP')}
function record(label){report.passed.push(label);writeFileSync(join(logs,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS '+label)}
try{
 file('check_00.sql');before=snapshot();bookingBefore=sql('select app_booking_enabled from public.booking_settings;','setting-before');report.before=before;report.booking_enabled_before=bookingBefore;record('reviewed baseline history and data snapshot')
 for(const entry of manifest.entries){
   if(entry.step==='15'){
     file('production_lock_legacy_record_writes.sql');file('check_acl.sql');unchanged('ACL closure');record('ACL closure / existing data preserved')
     const candidates=file('production_store_verification_candidates.sql');writeFileSync(join(logs,'candidate-counts.txt'),candidates);record('read-only candidate preview')
     file('production_seed_store_verifications.sql');file('check_bulk.sql');unchanged('bulk verification');record('reviewed approvals (32) / existing data preserved')
   }
   file(entry.file);file('check_'+entry.step+'.sql');unchanged('step '+entry.step);record('step '+entry.step+' / history '+entry.history+' / existing data preserved')
 }
 file('check_final.sql');report.status='PASS';report.after=snapshot();report.history=manifest.final
 writeFileSync(join(logs,'report.json'),JSON.stringify(report,null,2)+'\n')
 console.log('PASS full release: '+manifest.entries.length+' steps + ACL closure + reviewed bulk verification; history '+manifest.final)
}catch(error){report.status='STOPPED';report.error=error.message;writeFileSync(join(logs,'report.json'),JSON.stringify(report,null,2)+'\n');console.error(error.message);process.exitCode=1}
