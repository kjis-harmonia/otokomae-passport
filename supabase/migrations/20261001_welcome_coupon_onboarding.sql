-- Welcome coupon onboarding guard.
-- Non-destructive: adds nullable customer flags, a duplicate-prevention index,
-- and an atomic onboarding RPC used by the app.

alter table public.customers
  add column if not exists normalized_name text,
  add column if not exists first_visit_answered_at timestamptz,
  add column if not exists first_visit_has_visited_before boolean,
  add column if not exists welcome_coupon_issued_at timestamptz;

create index if not exists customers_normalized_name_idx
  on public.customers (normalized_name);

create unique index if not exists tickets_one_welcome_coupon_per_user_idx
  on public.tickets (user_id)
  where issued_by = 'system-welcome'
    and title = '特殊パーマ Welcomeクーポン';

create or replace function public.complete_customer_onboarding(
  p_user_id text,
  p_name text,
  p_has_visited_before boolean
)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_customer public.customers;
  v_ticket public.tickets;
  v_existing_customer boolean := false;
  v_same_name_exists boolean := false;
  v_recovery_code text;
  v_normalized_name text;
  i integer;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'user_id_required';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name_required';
  end if;

  v_normalized_name := lower(regexp_replace(replace(btrim(p_name), '　', ''), '\s+', '', 'g'));

  select * into v_customer
  from public.customers
  where user_id = p_user_id
  for update;

  if found then
    v_existing_customer := true;

    update public.customers
    set name = btrim(p_name),
        normalized_name = v_normalized_name,
        first_visit_answered_at = coalesce(first_visit_answered_at, now()),
        first_visit_has_visited_before = coalesce(first_visit_has_visited_before, p_has_visited_before),
        updated_at = now()
    where id = v_customer.id
      returning * into v_customer;
  else
    select exists (
      select 1
      from public.customers
      where normalized_name = v_normalized_name
    ) into v_same_name_exists;

    -- Same normalized name is not strong enough to recover the customer,
    -- but it is enough ambiguity to avoid issuing a new-customer Welcome coupon.
    v_existing_customer := v_same_name_exists;

    for i in 1..5 loop
      v_recovery_code :=
        'GIN-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)) ||
        '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));

      exit when not exists (
        select 1 from public.customers where recovery_code = v_recovery_code
      );
    end loop;

    insert into public.customers (
      user_id,
      name,
      recovery_code,
      normalized_name,
      first_visit_answered_at,
      first_visit_has_visited_before
    )
    values (
      p_user_id,
      btrim(p_name),
      v_recovery_code,
      v_normalized_name,
      now(),
      p_has_visited_before
    )
    returning * into v_customer;

    insert into public.customer_user_aliases (customer_id, user_id, is_current)
    values (v_customer.id, p_user_id, true)
    on conflict (user_id) do nothing;
  end if;

  select * into v_ticket
  from public.tickets
  where user_id = p_user_id
    and issued_by = 'system-welcome'
    and title = '特殊パーマ Welcomeクーポン'
  limit 1;

  if not p_has_visited_before and not v_existing_customer and v_ticket.id is null then
    insert into public.tickets (
      user_id,
      type,
      title,
      amount,
      memo,
      issued_by,
      used
    )
    values (
      p_user_id,
      'discount',
      '特殊パーマ Welcomeクーポン',
      2000,
      '対象: 特殊パーマ / 平日のみ（土日利用不可） / 新規のお客様限定',
      'system-welcome',
      false
    )
    on conflict do nothing
    returning * into v_ticket;

    if v_ticket.id is not null then
      update public.customers
      set welcome_coupon_issued_at = now(),
          updated_at = now()
      where id = v_customer.id
      returning * into v_customer;

      return json_build_object(
        'customer', row_to_json(v_customer),
        'ticket', row_to_json(v_ticket),
        'welcome_coupon_issued', true,
        'existing_customer', false
      );
    end if;

    select * into v_ticket
    from public.tickets
    where user_id = p_user_id
      and issued_by = 'system-welcome'
      and title = '特殊パーマ Welcomeクーポン'
    limit 1;
  end if;

  if v_ticket.id is not null then
    update public.customers
    set welcome_coupon_issued_at = coalesce(welcome_coupon_issued_at, v_ticket.created_at),
        updated_at = now()
    where id = v_customer.id
    returning * into v_customer;
  end if;

  return json_build_object(
    'customer', row_to_json(v_customer),
    'ticket', case when v_ticket.id is null then null else row_to_json(v_ticket) end,
    'welcome_coupon_issued', false,
    'existing_customer', v_existing_customer
  );
end;
$$;

grant execute on function public.complete_customer_onboarding(text, text, boolean)
  to anon, authenticated;
