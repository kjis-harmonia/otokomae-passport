import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

// The launcher must create and later drop this disposable clone.
const [psql, port, database] = process.argv.slice(2)
assert(psql && /^\d{4,5}$/.test(port) && database === 'device_audit_person_overlap',
  'Usage: node scripts/booking-person-concurrency.mjs <psql> <local-port> device_audit_person_overlap')
const args = ['-XqAt', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1']
const env = { ...process.env, PGCLIENTENCODING: 'UTF8' }
const run = (sql, applicationName = 'qa-person-observer') =>
  promisify(execFile)(psql, [...args, '-c', sql], {
    env: { ...env, PGAPPNAME: applicationName }, timeout: 15_000, windowsHide: true,
  })
const scalar = async (sql) => (await run(sql)).stdout.trim()

await run(`
create table qa_person_race(session text, client_id uuid, rpc_at timestamptz, raw_at timestamptz, stylists uuid[], menu_codes text[]);
do $$
declare m jsonb; c uuid; a uuid; b uuid; d date := app_private.today_jst()+2;
  t timestamptz; codes text[] := array['qa-person-race'];
begin
  while extract(isodow from d)>5 loop d:=d+1; end loop;
  t := app_private.jst_ts(d,'16:30');
  update public.booking_settings set app_booking_enabled=true, slot_minutes=30, min_lead_minutes=0 where id=1;
  insert into public.business_hours(weekday,is_closed,open_time,close_time)
    values(extract(dow from d)::int,false,'08:00','19:00')
    on conflict (weekday) do update set is_closed=false,open_time='08:00',close_time='19:00';
  insert into public.staff_members(display_name) values('QA Person Race A') returning id into a;
  insert into public.staff_members(display_name) values('QA Person Race B') returning id into b;
  insert into public.staff_shift_templates(staff_id,weekday,start_time,end_time)
    values(a,extract(dow from d)::int,'08:00','19:00'),(b,extract(dow from d)::int,'08:00','19:00');
  insert into public.service_menus(code,name,duration_min,price,is_active,booking_enabled)
    values(codes[1],'QA Person Race',30,3000,true,true);
  insert into public.staff_menu_capabilities(staff_id,menu_id)
    select s,m.id from unnest(array[a,b]) s cross join public.service_menus m where m.code=any(codes);
  m := public.customer_register('QA Person Race',true);
  select id into c from public.customers where user_id=m->>'user_id';
  insert into app_private.customer_store_verifications values(c,now(),'qa','qa');
  insert into qa_person_race values(m->>'session',app_private.member_client(c),t,t+interval '1 hour',array[a,b],codes);
end;
$$;
`)

async function waitUntil(sql, description, checkWorker = () => {}) {
  for (let attempt = 0; attempt < 80; attempt++) {
    checkWorker()
    if (await scalar(sql) === 't') return
    await delay(50)
  }
  throw new Error(description)
}

async function race(name, winnerSql, loserSql, verifyLoser) {
  const winnerName = 'qa-person-winner'
  const loserName = 'qa-person-loser'
  const winner = spawn(psql, args, {
    env: { ...env, PGAPPNAME: winnerName }, windowsHide: true, stdio: 'pipe',
  })
  let stdout = ''
  let stderr = ''
  winner.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  winner.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const finished = new Promise((resolve, reject) => {
    winner.on('error', reject)
    winner.on('close', (code) => resolve(code))
  })
  winner.stdin.on('error', () => {}) // The exit code and stderr carry server failures.
  let losing
  let earlyResult
  try {
    winner.stdin.write('begin;\n' + winnerSql + '\n')
    await waitUntil("select exists(select from pg_stat_activity where application_name='qa-person-winner' and state='idle in transaction')",
      name + ': winner did not finish its write while keeping the transaction open')
    losing = run(loserSql, loserName).then(
      ({ stdout }) => ({ stdout: stdout.trim() }),
      (error) => ({ error }),
    ).then((result) => { earlyResult = result; return result })
    await waitUntil("select exists(select from pg_stat_activity l join pg_stat_activity w on w.pid=any(pg_blocking_pids(l.pid)) " +
      "where l.application_name='qa-person-loser' and w.application_name='qa-person-winner')",
    name + ': loser did not block on the uncommitted write', () => {
      if (earlyResult) throw new Error(name + ': loser finished before blocking. Winner: ' + stdout.trim()
        + '. Loser: ' + (earlyResult.error?.stderr ?? earlyResult.stdout))
    })
    winner.stdin.end('commit;\n')
    assert.equal(await finished, 0, stderr)
    assert.notEqual(stdout.trim(), '', name + ': first write returned no result')
    verifyLoser(await losing)
    return stdout.trim()
  } finally {
    if (winner.exitCode === null) winner.kill()
    await finished.catch(() => {})
    if (losing) await losing
  }
}

// Issuing another hold can release a member's first hold, so each connection
// takes its own hold as part of the complete public booking flow.
const confirmation = (n) => 'with offer as materialized (select session, ' +
  'public.customer_create_hold(session,rpc_at,menu_codes,stylists[' + n + ']) as hold from qa_person_race) ' +
  "select public.customer_confirm_reservation(session,(hold->>'hold_id')::uuid,null) from offer;"
const confirmed = await race('public confirmations on different stylists', confirmation(1), confirmation(2), (loser) => {
  assert.ifError(loser.error)
  assert.deepEqual(JSON.parse(loser.stdout), { error: 'reservation_person_overlap' })
})
assert(JSON.parse(confirmed).id)
assert.equal(await scalar("select count(*) from public.reservations r join qa_person_race q on q.client_id=r.client_id where r.starts_at=q.rpc_at"), '1')
assert.equal(await scalar("select count(*) from public.booking_holds h join qa_person_race q on h.starts_at=q.rpc_at " +
  "where h.staff_id=any(q.stylists) and h.converted_reservation_id is not null"), '1')
console.log('PASS public confirm: different stylists, one committed reservation and one converted hold')

const directInsert = (n) => 'insert into public.reservations(staff_id,client_id,customer_name,starts_at,ends_at,occupied_until,source) ' +
  "select stylists[" + n + "],client_id,'QA race',raw_at,raw_at+interval '30 min',raw_at+interval '30 min','staff' from qa_person_race returning id;"
const inserted = await race('direct writes without booking advisory locks', directInsert(1), directInsert(2), (loser) => {
  assert(loser.error, 'Overlapping direct write committed')
  assert.match(loser.error.stderr, /reservations_treatment_person_no_overlap/)
})
assert.match(inserted, /^[0-9a-f-]{36}$/)
assert.equal(await scalar("select count(*) from public.reservations r join qa_person_race q on q.client_id=r.client_id where r.starts_at=q.raw_at"), '1')
console.log('PASS direct inserts: GiST exclusion blocked the other connection without an RPC lock')
