#!/usr/bin/env node
// Generate files only. This script never connects to a database.
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'

const root=resolve(process.argv[2]??dirname(dirname(fileURLToPath(import.meta.url))))
const out=join(root,'supabase/rollout/out_release')
const order=readFileSync(join(root,'supabase/rollout/release_prod_order.txt'),'utf8').trim().split(/\r?\n/)
if(order.length!==22||order[20]!=='20261023000000_ai_booking_penalty'||order[21]!=='20261024000100_ginpay_hold'||order[2]!=='20261006000000_service_master#checkout_catalog_json'||!order[14].endsWith('_customer_store_access'))throw new Error('Release order changed; review before generating')
const baseline=[
 ['20261002000000','booking_phase1'],['20261003000000','customer_ledger'],['20261006000000','service_master'],
 ...['sb_reservation_board','sb_capacity_setting','sb_hotpepper_mail','sb_hotpepper_mail_notices','sb_hotpepper_no_coupon','sb_hotpepper_note'].map((n,i)=>['20261015'+String(i*100).padStart(6,'0'),n]),
 ['20261015100000','customer_contact'],['20261016000000','hq_app_booking_switch'],['20261016000100','customer_availability_overview'],
 ['20261017000000','visit_log'],['20261017000100','visit_log_maintenance'],['20261017000200','ticket_rules_checkin_price'],['20261017000300','johnny_push'],
 ['20261018000000','hq_messages'],['20261018000110','hq_tasks'],['20261018000210','open_slot_push'],['20261018000300','menu_price_changes'],
 // 10/23 に本番へ先行して入れた SB のお知らせ5本と、10/24 の SB のクローズ（公開前からある）
 ['20261023000100','staff_push'],['20261023000200','staff_push_ack'],['20261023000300','staff_push_final'],['20261023000400','staff_push_cancel'],['20261023000500','staff_alert_fallback'],['20261024000000','sb_close_time'],
]
function historyKey(rows){return createHash('md5').update([...rows].sort(([a],[b])=>a.localeCompare(b)).map(([v,n])=>v+':'+n).join('\n')).digest('hex')}
function historyGuard(rows){return `do $release_history$\nbegin\n  if (select count(*) from supabase_migrations.schema_migrations) <> ${rows.length}\n    or (select md5(coalesce(string_agg(version || ':' || coalesce(name,''), E'\\n' order by version),'')) from supabase_migrations.schema_migrations) <> '${historyKey(rows)}' then\n    raise exception 'Release history differs from reviewed state (${rows.length} entries); STOP';\n  end if;\nend;\n$release_history$;`}
const stats=readFileSync(join(root,'supabase/tests/preflight_baseline_snapshot.sql'),'utf8')
const statsValue='('+stats.replace(/^--.*$/gm,'').trim().replace(/;$/,'')+')::jsonb'
mkdirSync(out,{recursive:true})
const entries=[],manifest=[];let expected=[...baseline]
const commentAliases=new Map(readdirSync(join(root,'supabase/migrations')).filter(f=>/^\d{14}_.+\.sql$/.test(f)).map(f=>[f.slice(0,8)+'_'+f.slice(15,-4),f.slice(0,-4)]))
const normalizeComments=text=>text.replace(/^[ \t]*--.*$/gm,line=>line.replace(/\b(\d{8}_[a-z0-9_]+)\b/g,name=>commentAliases.get(name)??name))
const payload=(extra='')=>"select jsonb_build_object('data',"+statsValue+",'app_booking_enabled',(select app_booking_enabled from public.booking_settings),'history_count',(select count(*) from supabase_migrations.schema_migrations),'history_key',(select md5(coalesce(string_agg(version||':'||coalesce(name,''),E'\\n' order by version),'')) from supabase_migrations.schema_migrations),'history',(select jsonb_agg(jsonb_build_object('version',version,'name',name) order by version) from supabase_migrations.schema_migrations)"+extra+") as verification;\n"
const snapshot=(rows,extra='')=>'begin read only;\n'+historyGuard(rows)+'\n'+payload(extra)+'commit;\n'
writeFileSync(join(out,'check_00.sql'),snapshot(expected))
for(let i=0;i<order.length;i++){
 const [name,fn]=order[i].split('#'),version=name.slice(0,14),label=name.slice(15)
 const source=readFileSync(join(root,'supabase/migrations',name+'.sql'),'utf8');let body=source
 if(fn){const start=source.indexOf('create or replace function app_private.'+fn+'(');if(start<0)throw new Error('Missing function');const end=source.indexOf('$$;',start);if(end<0)throw new Error('Missing function terminator');body=source.slice(start,end+3)}
 // Existing source migration comments retain legacy filenames. Only generated comment lines
 // use the current filenames so static preflight can inspect the release directory too.
 body=normalizeComments(body)
 const before=[...expected]
 if(!fn){if(expected.some(([v])=>v===version))throw new Error('Version collision');expected.push([version,label])}
 const n=String(i+1).padStart(2,'0'),file=n+'_'+name+(fn?'_'+fn:'')+'.sql'
 let gate=''
 if(i===14)gate=`do $approved_members$\ndeclare n bigint; fp text;\nbegin\n  if to_regclass('app_private.customer_store_verifications') is null then raise exception 'Bulk verification must run before step 15'; end if;\n  select count(*),md5(coalesce(string_agg(c.id::text||':'||c.user_id,E'\\n' order by c.id,c.user_id),'')) into n,fp\n  from public.customers c join app_private.customer_store_verifications v on v.customer_id=c.id;\n  if n <> 30 or fp is distinct from 'c4824d0dc827cb5ab3f9979455ccede8' then raise exception 'Reviewed 30 approvals not present; STOP';end if;\nend;\n$approved_members$;\n`
 const sql='-- GENERATED. Human-run production release: ufyzynpmkxytnhebombq.\nbegin;\nset local lock_timeout=\'5s\';\nset local statement_timeout=\'120s\';\n'+historyGuard(before)+'\n'+gate+body+'\n'+(!fn?`insert into supabase_migrations.schema_migrations(version,name) values('${version}','${label}');\n`:'-- Function restoration only: preserve existing migration history.\n')+historyGuard(expected)+"\nnotify pgrst, 'reload schema';\ncommit;\n"
 writeFileSync(join(out,file),sql);writeFileSync(join(out,'check_'+n+'.sql'),snapshot(expected))
 entries.push({step:n,file,version,label,history:expected.length,history_key:historyKey(expected),function_only:!!fn})
 manifest.push({file,sha256:createHash('sha256').update(sql).digest('hex'),source:name,source_sha256:createHash('sha256').update(source).digest('hex')})
}
for(const file of ['production_lock_legacy_record_writes.sql','production_store_verification_candidates.sql','production_seed_store_verifications.sql']){
 const sql=readFileSync(join(root,'docs/sql',file),'utf8');writeFileSync(join(out,file),sql);manifest.push({file,sha256:createHash('sha256').update(sql).digest('hex')})
}
const tables=['visit_log','maintenance_visits','ticket_usage_logs','tickets','accounting_sessions','accounting_session_items','accounting_items','ticket_issue_logs','ticket_transfers','maintenance_coupon_tokens','customers','customer_user_aliases','customer_recovery_logs']
const acl=`with targets as (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(array[${tables.map(t=>"'"+t+"'").join(',')}])) select count(distinct oid) as tables_found, bool_and(not has_table_privilege(r,oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not has_any_column_privilege(r,oid,'INSERT,UPDATE,REFERENCES')) as writes_closed from targets cross join (values ('anon'::text),('authenticated'::text)) roles(r);\nselect count(*) as legacy_functions,bool_and(not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')) as legacy_closed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('complete_customer_onboarding','recover_member','claim_ticket_transfer');`
const jsonRow=query=>'(select to_jsonb(q) from ('+query.trim().replace(/;$/,'')+') q)'
const [tableAcl,legacyAcl]=acl.split(';').map(x=>x.trim()).filter(Boolean)
const aclFields=",'acl',"+jsonRow(tableAcl)+",'legacy',"+jsonRow(legacyAcl)
const before15=entries.slice(0,14).reduce((rows,e)=>e.function_only?rows:[...rows,[e.version,e.label]],[...baseline])
writeFileSync(join(out,'check_acl.sql'),snapshot(before15,aclFields))
const approvals="select count(*) as approved, md5(coalesce(string_agg(c.id::text||':'||c.user_id,E'\\n' order by c.id,c.user_id),'')) as fingerprint, count(*) filter(where v.verified_by='一括（店の記録あり）') as bulk_label from app_private.customer_store_verifications v join public.customers c on c.id=v.customer_id;"
writeFileSync(join(out,'check_bulk.sql'),snapshot(before15,aclFields+",'approvals',"+jsonRow(approvals)))
writeFileSync(join(out,'check_final.sql'),snapshot(expected,aclFields+",'approvals',"+jsonRow(approvals)+",'ginpay_consistent',(app_private.ginpay_reconcile_json())->>'consistent'"))
// This is a separate post-Web publication step. Never run it in the initial 21-step loop:
// sessionless legacy customer reads must switch to the store verification flow first.
const lockdownName='20261001000400_security_hardening_b_lockdown'
const lockdownSource=readFileSync(join(root,'supabase/migrations',lockdownName+'.sql'),'utf8')
const postExpected=[...expected,[lockdownName.slice(0,14),lockdownName.slice(15)]]
const postFile='post_web_security_lockdown.sql'
const postSql="-- POST-WEB ONLY: confirm new app/customer handover before running.\nbegin;\nset local lock_timeout='5s';\nset local statement_timeout='120s';\n"+historyGuard(expected)+'\n'+normalizeComments(lockdownSource)+"\ninsert into supabase_migrations.schema_migrations(version,name) values('20261001000400','security_hardening_b_lockdown');\n"+historyGuard(postExpected)+"\nnotify pgrst,'reload schema';\ncommit;\n"
writeFileSync(join(out,postFile),postSql)
manifest.push({file:postFile,sha256:createHash('sha256').update(postSql).digest('hex'),source:lockdownName,source_sha256:createHash('sha256').update(lockdownSource).digest('hex')})
const securityTest=readFileSync(join(root,'supabase/tests/preflight_security.sql'),'utf8')
writeFileSync(join(out,'check_post_web_lockdown.sql'),snapshot(postExpected,aclFields+",'approvals',"+jsonRow(approvals)).replace('begin read only;\n',()=>'begin read only;\n'+securityTest+'\n'))
for(const file of readdirSync(out).filter(f=>/^check_(?:\d\d|acl|bulk|final|post_web_lockdown)\.sql$/.test(f))){manifest.push({file,sha256:createHash('sha256').update(readFileSync(join(out,file))).digest('hex')})}
writeFileSync(join(out,'manifest.json'),JSON.stringify({project_ref:'ufyzynpmkxytnhebombq',baseline:baseline.length,final:expected.length,entries,post_web:{file:postFile,check:'check_post_web_lockdown.sql',history:postExpected.length},files:manifest},null,2)+'\n')
console.log(`Prepared ${entries.length} rollout files and read-only checks; history ${baseline.length} -> ${expected.length}. No database connection made.`)
console.log(`Prepared separate post-Web lockdown; history ${expected.length} -> ${postExpected.length}.`+' Do not run before the new Web app is published and verified.')
