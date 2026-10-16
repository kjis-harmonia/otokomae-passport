#!/usr/bin/env bash
# 本番に予約の仕組みを入れる SQL を、1本ずつ「全部入るか、何も入らないか」に包んで out/ に作る。
# 作るだけで、DB には何もしない。実行は docs/booking-production-rollout.md の手順で 1 本ずつ行う。
set -euo pipefail
cd "$(dirname "$0")"
out=out; rm -rf "$out"; mkdir -p "$out"
i=0
while read -r name; do
  [ -z "$name" ] && continue
  i=$((i + 1)); src="../migrations/$name.sql"; version="${name%%_*}"; label="${name#*_}"
  [ -f "$src" ] || { echo "見つかりません: $src" >&2; exit 1; }
  {
    echo "begin;"
    cat "$src"
    echo
    echo "insert into supabase_migrations.schema_migrations(version, name) values ('$version', '$label') on conflict (version) do nothing;"
    echo "commit;"
  } > "$out/$(printf '%02d' "$i")_$name.sql"
done < booking_prod_order.txt
ls "$out"
