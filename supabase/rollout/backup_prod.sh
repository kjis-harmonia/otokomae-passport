#!/usr/bin/env bash
# 本番 DB を丸ごと手元に保存する（読み取りのみ）。保存先：デスクトップ/otokomae-backups/<日時>/
set -euo pipefail
ref=ufyzynpmkxytnhebombq
dir="/c/Users/user/Desktop/otokomae-backups/$(date +%Y%m%d-%H%M)"
mkdir -p "$dir"
sb() { npx supabase@2.121.0 db dump --linked --project-ref "$ref" "$@"; }
sb --role-only -f "$dir/roles.sql"
sb -f "$dir/schema.sql"
sb --data-only --use-copy -f "$dir/data.sql"
echo "保存先: $dir"
ls -la "$dir"
