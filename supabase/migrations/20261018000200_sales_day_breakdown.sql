-- ============================================================================
-- 本部の売上（日別）に、支払方法ごとの合計と銀Payの内訳を足す（経理・レジ締め用）
-- ----------------------------------------------------------------------------
-- 前提：20261005000000_checkout.sql・20261017040000_ginpay_charge_bonus.sql 適用済み。置き換えのみ・何度実行しても同じ結果。
-- 追加するキー（既存のキーは変えない）：
--   by_method : 確定した会計の支払方法ごとの件数・合計
--   ginpay    : paid        その日の会計で銀Payから払われた額（取消した会計は含めない）
--               paid_bonus  そのうち特典分（チャージの特典から払われた分。お店に現金は入っていない）
--               charge_cash その日の店頭チャージで受け取った現金
--               charge_bonus その日の店頭チャージで付けた特典
--               charge_count 店頭チャージの件数
--   cash_in   : その日にレジに入った現金（現金の会計＋店頭チャージの現金）
-- ============================================================================

create or replace function app_private.sales_json(p_date date)
returns jsonb language sql stable
set search_path = public, extensions, pg_temp
as $$
  with s as (
    select * from public.accounting_sessions
    where status in ('completed', 'voided') and (coalesce(completed_at, created_at) at time zone 'Asia/Tokyo')::date = p_date
  ),
  pay as (
    select t.amount, t.bonus_amount from public.ginpay_transactions t
    join s on s.id = t.accounting_session_id and s.status = 'completed'
    where t.type = 'payment' and t.status = 'posted'
  ),
  chg as (
    select t.amount, t.bonus_amount from public.ginpay_transactions t
    where t.type = 'charge_store' and t.status = 'posted' and (t.created_at at time zone 'Asia/Tokyo')::date = p_date
  )
  select jsonb_build_object(
    'date', p_date,
    'count', (select count(*) from s where status = 'completed'),
    'total', (select coalesce(sum(total), 0) from s where status = 'completed'),
    'voided', (select count(*) from s where status = 'voided'),
    'by_method', (select coalesce(jsonb_agg(jsonb_build_object('method', m.method, 'count', m.n, 'total', m.total) order by m.total desc), '[]'::jsonb)
                  from (select coalesce(payment_method, 'other') as method, count(*) as n, coalesce(sum(total), 0) as total
                        from s where status = 'completed' group by 1) m),
    'ginpay', jsonb_build_object(
      'paid', (select coalesce(-sum(amount), 0) from pay),
      'paid_bonus', (select coalesce(-sum(bonus_amount), 0) from pay),
      'charge_cash', (select coalesce(sum(amount - bonus_amount), 0) from chg),
      'charge_bonus', (select coalesce(sum(bonus_amount), 0) from chg),
      'charge_count', (select count(*) from chg)),
    'cash_in', (select coalesce(sum(total), 0) from s where status = 'completed' and payment_method = 'cash')
             + (select coalesce(sum(amount - bonus_amount), 0) from chg),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'status', s.status, 'completed_at', coalesce(s.completed_at, s.created_at),
               'customer_name', coalesce((select c.display_name from public.clients c where c.id = app_private.client_root(s.client_id)), nullif(s.customer_name, '')),
               'stylist_name', s.stylist_name, 'payment_method', s.payment_method, 'total', s.total,
               'items', (select string_agg(i.item_name || case when coalesce(i.quantity, 1) > 1 then '×' || i.quantity else '' end, '・' order by i.sort_order nulls last, i.created_at)
                         from public.accounting_session_items i where i.session_id = s.id),
               'has_reservation', s.reservation_id is not null)
             order by coalesce(s.completed_at, s.created_at) desc), '[]'::jsonb) from s)
  )
$$;
