import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { hasFlag, optionalIntegerOption, stringOption } from '../util/cliArgs.js'
import { makeEthCallBatch } from './atokenAnchor.js'
import { createIncentiveAnchorJob } from './mmIncentiveAnchorJob.js'

// Money-market incentive ANCHOR, manual modes: the RewardsController's own
// per-user accrual and user indexes, and each programme's index, at B0 (see
// mmIncentiveAnchor.ts for why and what, mmIncentiveAnchorJob.ts for the
// candidate set). Written to price_data.mm_incentive_anchor; the API's incentive
// history and the mm-incentives refresher add every indexed Accrued/RewardsClaimed
// after B0 to it.
//
// The service capture is the anchors loop (`snapshot-atoken-anchors.ts --loop`,
// the `atoken-anchor` service): once raw ingestion has COMPLETED every block from
// CONTROLLER_LOGS_FROM (the backfill low-water, below the controller's first log)
// to B0, each cycle captures this anchor whole while the table is empty — so a
// fresh database self-establishes it once its logs are all in, never from a
// partial candidate set — and tops it up otherwise: a candidate user a source
// names since that has no row is read at B0 (mmIncentiveAnchor.ts).
//
// Usage:
//   npx tsx src/scripts/snapshot-mm-incentive-anchors.ts [--dry-run] [--out=rows.jsonl] [--anchor-block=8200000] [--force]
//   npx tsx src/scripts/snapshot-mm-incentive-anchors.ts --verify
//
// (no mode) captures whole when the table is empty and tops it up otherwise
// (--force: a full capture always; the rows are pinned at B0, so a recapture
// rewrites identical values); --dry-run reads every key and prints, inserts
// nothing (--out writes the rows as JSONEachRow). --verify is read-only: re-reads
// EVERY stored row at its anchor block and exits non-zero on any mismatch.

const dryRun = hasFlag('dry-run')
const verifyOnly = hasFlag('verify')
const force = hasFlag('force')
const outFile = stringOption('out')
const explicitAnchorBlock = optionalIntegerOption('anchor-block', { min: 1 })

const client = createClickHouseClient()
const job = createIncentiveAnchorJob({
  client,
  ethCall: makeEthCallBatch(config.RPC_URL, fetch, { label: 'mm-incentive-anchor' }),
  anchorBlock: explicitAnchorBlock ?? 8_200_000,
  rpcUrl: config.RPC_URL,
})

async function main(): Promise<void> {
  if (verifyOnly) { if (!await job.verify()) process.exitCode = 1; return }
  // A dry run reads every key, so what the table holds cannot skip it (the loop's rule).
  const mode = force || dryRun || await job.anchorRowCount() === 0 ? 'full' : 'top-up'
  await job.capture({ dryRun, mode, outFile })
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await client.close() })
