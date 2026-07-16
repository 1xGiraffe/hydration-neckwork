import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { streamBalanceSnapshot } from '../raw/balance.js'
import type { Block as StorageBlock } from '../types/support.js'
import type { RawBalanceObservationRow } from '../raw/types.js'
import { hasFlag, integerOption, optionalIntegerOption } from '../util/cliArgs.js'
import { createSnapshotRpcClient, loadSnapshotRuntime, resolveSnapshotAnchor, runSnapshotProcess } from './snapshotRuntime.js'

// One-shot full-state balance snapshot.
//
// Pages over every System.Account (native) and Tokens.Accounts (token) entry at
// a single anchor block — by default the chain's finalized head — and writes one
// raw_balance_observations row per account/asset. This seeds the ~100k+ dormant
// accounts the event-driven raw indexer never observed, so the Accounts list can
// show every account instead of only those touched within the indexed window.
//
// Run it ONCE (not per backfill chunk). Re-running at the same head is idempotent
// (identical rows dedupe); re-running at a newer head adds higher-block rows that
// supersede the old snapshot via argMax(total, block_height) on the read path.
//
// Usage:
//   npx tsx src/scripts/snapshot-balances.ts [--dry-run] [--block=N]
//        [--page-size=1000] [--flush=20000] [--native-only] [--tokens-only]
//
// State availability: getPairsPaged reads STATE at the anchor block, served by
// RPC_URL. A pruned node only keeps recent state, so a historical --block will
// fail unless RPC_URL is a full-archive node. The head default always works.

const dryRun = hasFlag('dry-run')
// --loop runs an initial full snapshot immediately, then re-snapshots every
// --refresh-hours, so the service seeds all accounts on `docker compose up` and
// keeps dormant balances reasonably fresh without any manual step.
const loop = hasFlag('loop')
const refreshHours = integerOption('refresh-hours', 24)
const pageSize = integerOption('page-size', 1000)
const flushThreshold = integerOption('flush', 20_000)
const nativeOnly = hasFlag('native-only')
const tokensOnly = hasFlag('tokens-only')
const blockOverride = optionalIntegerOption('block')

const client = createClickHouseClient()
const rpc = createSnapshotRpcClient()

async function buildBlock(hash: string, height: number): Promise<{ block: StorageBlock; timestamp: string }> {
  const { runtime, timestamp } = await loadSnapshotRuntime(rpc, hash)
  const block: StorageBlock = { _runtime: runtime, hash, height }
  return { block, timestamp }
}

async function runOnce(): Promise<void> {
  const { hash, height } = await resolveSnapshotAnchor(rpc, blockOverride)
  const { block, timestamp } = await buildBlock(hash, height)

  console.log(JSON.stringify({
    type: 'snapshot_start',
    dry_run: dryRun,
    anchor_block: height,
    anchor_hash: hash,
    anchor_timestamp: timestamp,
    page_size: pageSize,
    flush_threshold: flushThreshold,
    include_native: !tokensOnly,
    include_tokens: !nativeOnly,
    rpc_url: config.RPC_URL,
  }))

  let buffer: RawBalanceObservationRow[] = []
  let inserted = 0
  let flushSeq = 0
  const startedAt = Date.now()

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const rows = buffer
    buffer = []
    await client.insert({
      table: 'price_data.raw_balance_observations',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: `raw-balance-snapshot-${height}-${flushSeq++}-${rows.length}`,
      },
    })
    inserted += rows.length
    console.log(JSON.stringify({ type: 'snapshot_flush', inserted, seconds: Math.round((Date.now() - startedAt) / 1000) }))
  }

  const counts = await streamBalanceSnapshot(block, timestamp, {
    pageSize,
    includeNative: !tokensOnly,
    includeTokens: !nativeOnly,
    ingestSource: 'rpc',
    countOnly: dryRun,
    onObservations: dryRun ? undefined : async (rows) => {
      buffer.push(...rows)
      if (buffer.length >= flushThreshold) await flush()
    },
    onProgress: (c) => {
      const total = c.nativeAccounts + c.tokenEntries
      if (total % 50_000 < pageSize) {
        console.log(JSON.stringify({
          type: 'snapshot_progress',
          native_accounts: c.nativeAccounts,
          token_entries: c.tokenEntries,
          seconds: Math.round((Date.now() - startedAt) / 1000),
        }))
      }
    },
  })

  if (!dryRun) await flush()

  console.log(JSON.stringify({
    type: 'snapshot_done',
    dry_run: dryRun,
    anchor_block: height,
    native_accounts: counts.nativeAccounts,
    token_entries: counts.tokenEntries,
    total_observations: counts.nativeAccounts + counts.tokenEntries,
    rows_inserted: inserted,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2))
}

void runSnapshotProcess({
  loop,
  refreshHours,
  runOnce,
  close: async () => {
    await client.close()
    rpc.close()
  },
})
