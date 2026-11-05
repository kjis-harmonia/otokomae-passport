update public.reservations set status = 'cancelled' where id in ('ac3d008f-e09e-4d7e-8656-dc5661c8829e', 'b2bc72d8-862d-48e0-9325-0d8c92e3c625') and status <> 'cancelled';
update app_private.customer_sessions set revoked_at = now() where token_hash in (app_private.sha256_hex('race-cust-token-0123456789abcdef0123456789'), app_private.sha256_hex('race-cust-token2-0123456789abcdef012345678'));
delete from app_private.staff_sessions where token_hash = app_private.sha256_hex('race-staff-token-0123456789abcdef0123456789');
-- Staging は「何回でも引ける」に戻す（setup.sql で 1日1回にしている。本番では流さない）
update app_private.gacha_settings set repeat = true where id = 1;
select 'done' as r;
