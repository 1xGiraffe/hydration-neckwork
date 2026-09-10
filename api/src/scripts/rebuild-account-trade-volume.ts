// Re-derive `account_trade_volume` for chosen month-partitions, using the derivation
// job's own SQL builder and publishing each atomically through the staging twin
// (DROP staging partition → INSERT → REPLACE PARTITION), exactly the three commands
// the runner issues: no second implementation of the model, and no reader ever sees
// a gap.
//
// Why it exists: the runner decides staleness by comparing INGEST watermarks, so a
// change in what the SQL MEANS is invisible to it — no source row moved. That is
// the case whenever an attribution rule changes, as it did when an OTC fill became
// two-sided (the maker books the mirrored legs; src/blocks/otcCounterparty.ts).
//
//   --partitions=197211,197212   rebuild exactly these
//   (default)                    every partition holding an OTC fill
//
// Run it against the api image with this directory mounted:
//   docker compose run --rm --no-deps -v "$PWD/api/src/scripts:/app/src/scripts:ro" \
//     --entrypoint ./node_modules/.bin/tsx api src/scripts/rebuild-account-trade-volume.ts
import { createClickHouseClient } from '../db/client.ts'
import { buildPartitionInsertSql } from '../services/accountTradeVolume.ts'
import { loadExplorerAssets } from '../services/explorerAssets.ts'

const LIVE = 'price_data.account_trade_volume'
const STAGING = `${LIVE}_staging`

const client = createClickHouseClient()
await loadExplorerAssets(client)

const requested = process.argv.find(a => a.startsWith('--partitions='))?.slice('--partitions='.length)
const parts = requested
  ? requested.split(',').map(p => ({ p: p.trim() })).filter(x => /^\d{6}$/.test(x.p))
  : await (await client.query({
      query: `SELECT toString(toYYYYMM(toDateTime(block_height * 12))) AS p
              FROM price_data.raw_events
              WHERE event_name IN ('OTC.Filled','OTC.PartiallyFilled')
              GROUP BY p ORDER BY p`,
      format: 'JSONEachRow',
    })).json<{ p: string }>()
if (!parts.length) { console.error('no partitions to rebuild'); process.exit(1) }

// The valuation's right bound is the partition's newest swap time, exactly as the
// runner passes it: the watermark table's src_max_ts. Read it per partition rather
// than reusing the OTC fill's time, which is only one swap of the month.
const wm = new Map((await (await client.query({
  query: `SELECT toString(p) AS p, toString(max(src_max_ts)) AS max_ts
          FROM price_data.swap_source_partition_watermarks GROUP BY p`,
  format: 'JSONEachRow',
})).json<{ p: string; max_ts: string }>()).map(r => [r.p, r.max_ts]))

console.log(`[atv-rebuild] ${parts.length} partitions${requested ? ' (from --partitions)' : ' holding an OTC fill'}`)
let done = 0
for (const { p } of parts) {
  const maxTs = wm.get(p)
  const started = Date.now()
  await client.command({ query: `ALTER TABLE ${STAGING} DROP PARTITION ${p}` })
  await client.command({ query: buildPartitionInsertSql(p, STAGING, maxTs) })
  await client.command({ query: `ALTER TABLE ${LIVE} REPLACE PARTITION ${p} FROM ${STAGING}` })
  await client.command({ query: `ALTER TABLE ${STAGING} DROP PARTITION ${p}` })
  done += 1
  console.log(`[atv-rebuild] ${p} published (${done}/${parts.length}) in ${Math.round((Date.now() - started) / 1000)}s`)
}
await client.close()
console.log('[atv-rebuild] done')
