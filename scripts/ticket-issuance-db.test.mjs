import { PGlite } from '../.qa/db/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
const db=new PGlite(), checks=[]
await db.exec(`create role anon; create role authenticated; create schema app_private;
create function app_private.assert_staff(token text) returns void language plpgsql as $$begin if token is distinct from 'test-staff' then raise exception 'staff_auth_required'; end if; end;$$;
create table customers(user_id text primary key); insert into customers values('test-member');
create table tickets(id uuid primary key default gen_random_uuid(), user_id text, type text, title text, amount integer, issued_by text, used boolean);
create table ticket_issue_logs(staff_name text,customer_name text,user_id text,ticket_type text,amount integer,quantity integer,terminal text,status text);
create function fail_late() returns trigger language plpgsql as $$begin if new.staff_name='late_failure' then raise exception 'simulated log failure'; end if;return new;end;$$;
create trigger fail_late before insert on ticket_issue_logs for each row execute function fail_late();`)
const base=readFileSync(new URL('../supabase/migrations/20261001000300_security_hardening_a_functions.sql',import.meta.url),'utf8')
const original=base.match(/create or replace function public\.staff_issue_tickets\([\s\S]*?\$\$;/i)?.[0]
assert.ok(original)
await db.exec(original)
const migration=readdirSync(new URL('../supabase/migrations/',import.meta.url)).find(n=>n.endsWith('_ticket_issue_idempotency.sql'))
await db.exec(readFileSync(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'))
const call=(id,{token='test-staff',amount=1000,quantity=1,staff='検証担当'}={})=>db.query('select public.staff_issue_tickets_once($1,$2,$3,$4,$5,$6,$7,$8) as receipt',[token,id,'test-member','discount',amount,quantity,staff,'検証会員'])
const count=async table=>Number((await db.query('select count(*) as n from '+table)).rows[0].n)
const id=randomUUID(),first=await call(id)
const replay=await call(id)
assert.deepEqual(replay.rows,first.rows);assert.equal(await count('tickets'),1);assert.equal(await count('ticket_issue_logs'),1);checks.push('Committed UUID replay returns same ticket; one log')
const repeated=await Promise.all(Array.from({length:12},()=>call(id)))
assert.ok(repeated.every(r=>r.rows[0].receipt.tickets[0].id===first.rows[0].receipt.tickets[0].id));assert.equal(await count('tickets'),1);checks.push('Queued repeated requests return same receipt (PGlite single connection)')
await assert.rejects(call(id,{amount:500}),/request_payload_mismatch/);assert.equal(await count('tickets'),1);checks.push('Payload mismatch rejected without mutation')
await assert.rejects(call(id,{token:'invalid'}),/staff_auth_required/);checks.push('Staff authentication required even for receipt replay')
await assert.rejects(call(randomUUID(),{quantity:0}),/invalid_quantity/);assert.equal(await count('app_private.ticket_issue_requests'),1);checks.push('Validation failure rolls request row back')
await assert.rejects(call(randomUUID(),{staff:'late_failure'}),/simulated log failure/);assert.equal(await count('tickets'),1);assert.equal(await count('app_private.ticket_issue_requests'),1);checks.push('Late log failure rolls tickets and request back atomically')
await assert.rejects(call(null),/request_id_required/);checks.push('Null request UUID rejected')
const grants=(await db.query(`select has_table_privilege('anon','app_private.ticket_issue_requests','select') as anon_read,has_table_privilege('authenticated','app_private.ticket_issue_requests','select') as auth_read,has_function_privilege('anon','public.staff_issue_tickets_once(text,uuid,text,text,integer,integer,text,text)','execute') as rpc`)).rows[0]
assert.equal(grants.anon_read,false);assert.equal(grants.auth_read,false);assert.equal(grants.rpc,true);checks.push('Private receipts unreadable; only authenticated RPC path exposed')
await db.close()
console.log(JSON.stringify({passed:checks.length,checks,externalDatabaseWrites:0},null,2))
