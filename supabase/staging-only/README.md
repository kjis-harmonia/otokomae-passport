# supabase/staging-only

ここの SQL は **Staging（kfufxzmucjljjouzpumi）だけ** に流すもの。本番（ufyzynpmkxytnhebombq）には絶対に流さない。
`supabase/migrations` に置かないのは、本番の `db push` などで間違って入らないようにするため。

| ファイル | 内容 |
| --- | --- |
| `20261112_ginoku.sql` | 銀二郎オークション【銀オク】のテーブル・関数・1分ごとの精算（pg_cron） |
| `20261112_ginoku_seed.sql` | 見本の出品3つ（ガチャ券） |
| `20261112_ginoku_off.sql` | 銀オクを外す（台帳と発行済みの券は残す） |

```sh
npx.cmd supabase db query --remote=kfufxzmucjljjouzpumi --yes -f supabase/staging-only/20261112_ginoku.sql
```
