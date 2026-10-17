#!/usr/bin/env bash
# 本番に会計（銀Pay・レジ）を入れる SQL を、1本ずつ「全部入るか、何も入らないか」に包んで out_accounting/ に作る。
# 作るだけで、DB には何もしない。実行は docs/accounting-production-rollout.md の手順で 1 本ずつ行う。
# 順番は accounting_prod_order.txt。「ファイル#関数名」の行は、そのファイルからその関数だけを取り出して当て直す
# （会計の migration が、あとの migration で新しくなった関数を古い版で上書きするため）。
set -euo pipefail
cd "$(dirname "$0")"
out=out_accounting; rm -rf "$out"; mkdir -p "$out"
i=0
while read -r line; do
  [ -z "$line" ] && continue
  i=$((i + 1)); name="${line%%#*}"; fn=""; [ "$line" != "$name" ] && fn="${line#*#}"
  src="../migrations/$name.sql"; version="${name%%_*}"; label="${name#*_}"
  [ -f "$src" ] || { echo "見つかりません: $src" >&2; exit 1; }
  file="$out/$(printf '%02d' "$i")_$name${fn:+_$fn}.sql"
  {
    echo "begin;"
    if [ -n "$fn" ]; then
      echo "-- $name.sql から app_private.$fn だけを当て直す（記録は増やさない）"
      awk -v fn="$fn" 'index($0, "create or replace function app_private." fn "(") == 1 {on=1} on {print} on && $0 == "$$;" {exit}' "$src"
    else
      echo "create schema if not exists supabase_migrations;"
      echo "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"
      cat "$src"
      echo
      echo "insert into supabase_migrations.schema_migrations(version, name) values ('$version', '$label') on conflict (version) do nothing;"
    fi
    echo "commit;"
  } > "$file"
  [ -n "$fn" ] && ! grep -q "create or replace function app_private.$fn(" "$file" && { echo "関数が見つかりません: $fn" >&2; exit 1; }
done < accounting_prod_order.txt
ls "$out"
