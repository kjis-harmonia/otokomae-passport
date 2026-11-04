update app_private.gacha_holdings set reservation_id = null where user_id = 'u-v2qa-claude-1024';
update app_private.gacha_draws set choice = 'old' where user_id = 'u-v2qa-claude-1024' and choice is null;
select 1 as r;
