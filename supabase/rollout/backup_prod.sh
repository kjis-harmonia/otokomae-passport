#!/usr/bin/env bash
# 本番 DB を丸ごと手元に保存する（読み取りのみ）。保存先：デスクトップ/otokomae-backups/<日時>/
# Supabase CLI の dump は Docker の中で pg_dump を動かす作りなので、--dry-run で手順だけ受け取り、
# このパソコンの PostgreSQL 17 の pg_dump で実行する（接続情報は画面に出さない）。
set -euo pipefail
ref=ufyzynpmkxytnhebombq
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"
dir="/c/Users/user/Desktop/otokomae-backups/$(date +%Y%m%d-%H%M)"
mkdir -p "$dir"
dump() { # $1 = 保存するファイル名、残り = db dump のオプション
  local file="$1"; shift
  # Windows 版の pg_dump は略したオプション名を受け付けないので、正式な名前に直す
  npx supabase@2.121.0 db dump --linked --project-ref "$ref" --dry-run "$@" 2>/dev/null \
    | sed -E 's/--quote-all-identifier( |$)/--quote-all-identifiers\1/g' | bash > "$dir/$file"
  [ -s "$dir/$file" ] || { echo "$file を保存できませんでした" >&2; exit 1; }
}
dump roles.sql --role-only
dump schema.sql
dump data.sql --data-only --use-copy
echo "保存先: $dir"
ls -la "$dir"
for t in customers tickets ticket_usage_logs accounting_sessions products; do
  n=$(awk -v t="COPY \"public\".\"$t\"" 'index($0, t) == 1 {on=1; next} on && $0 == "\\." {on=0} on {c++} END {print c+0}' "$dir/data.sql")
  echo "$t: $n 行"
done
