import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { snapshotAbsentRows, streamBalanceSnapshot } from '../raw/balance.js'
import {
  BalanceReconciler,
  balanceSignature,
  balanceSweepMode,
  pairKey,
  type ProjectedBalance,
} from '../raw/balanceReconcile.js'
import type { Block as StorageBlock } from '../types/support.js'
import type { RawBalanceObservationRow } from '../raw/types.js'
import { hasFlag, integerOption, optionalIntegerOption } from '../util/cliArgs.js'
import {
  createSnapshotRpcClient,
  loadSnapshotRuntime,
  resolveIndexedSnapshotAnchor,
  resolveSnapshotAnchor,
  runSnapshotProcess,
} from './snapshotRuntime.js'

// Full-state balance sweep: seed once, then reconcile diff-only.
//
// Pages over every System.Account (native) and Tokens.Accounts (token) entry at
// one anchor block.
//
// SEED (a database no snapshot_bootstrap row was ever written to, or without
// --reconcile): one raw_balance_observations row per account/asset at the
// finalized head. This seeds the ~100k dormant accounts the event-driven raw
// indexer never observed, so the Accounts list shows every account, and is what
// the money-market sweep waits for (waitForAccountsSeeded).
//
// RECONCILE (--reconcile on a seeded database): the anchor is pinned to
// min(indexed head, finalized head), every entry is compared with the per-block
// projection as of that block (src/raw/balanceReconcile.ts), and a row — labelled
// snapshot_reconcile — is written ONLY where they differ, plus a storage-default
// row for a pair the projection still shows non-zero that storage no longer holds.
// The raw indexer observes every changed balance per block, so a diff is a missed
// observation: the pass logs a `balance_reconcile_drift` warning naming examples.
//
// Rows supersede older ones via the argMax(…, block_height) every reader uses, so
// re-running at the same block is idempotent (identical rows dedupe).
//
// Usage:
//   npx tsx src/scripts/snapshot-balances.ts [--reconcile] [--dry-run] [--block=N]
//        [--page-size=1000] [--flush=20000] [--native-only] [--tokens-only]
//
// --dry-run: in seed mode counts keys only; in reconcile mode reads and compares
// everything and writes nothing.
//
// State availability: getPairsPaged reads STATE at the anchor block, served by
// RPC_URL. A pruned node only keeps recent state, so a historical --block will
// fail unless RPC_URL is a full-archive node. The head default always works.

const dryRun = hasFlag('dry-run')
// --loop runs a pass immediately, then again every --refresh-hours.
const loop = hasFlag('loop')
const reconcile = hasFlag('reconcile')
const refreshHours = integerOption('refresh-hours', 168)
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

// Has a full seed ever been written? (LowCardinality dictionary probe, ~0.1 s.)
async function hasSeed(): Promise<boolean> {
  const res = await client.query({
    query: `SELECT count() AS c FROM (SELECT 1 FROM price_data.raw_balance_observations WHERE source_kind = 'snapshot_bootstrap' LIMIT 1)`,
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ c: string | number }>())[0]?.c ?? 0) > 0
}

// The per-block projection every balance reader uses: the newest observation per
// (account, asset). Streamed; ~0.8M pairs, ~40 MiB read.
const PROJECTION_SQL = `
  SELECT account_id, asset_id,
    ifNull(argMaxMerge(total_state), '') AS total,
    ifNull(argMaxMerge(free_state), '') AS free,
    ifNull(argMaxMerge(reserved_state), '') AS reserved,
    maxMerge(last_block_state) AS last_block
  FROM price_data.account_asset_latest_balances
  WHERE ({native:UInt8} AND asset_id = '0') OR ({tokens:UInt8} AND asset_id != '0')
  GROUP BY account_id, asset_id`

async function loadProjection(): Promise<Map<string, ProjectedBalance>> {
  const res = await client.query({
    query: PROJECTION_SQL,
    query_params: { native: tokensOnly ? 0 : 1, tokens: nativeOnly ? 0 : 1 },
    format: 'JSONCompactEachRow',
    clickhouse_settings: { max_threads: 4, max_memory_usage: '3000000000' },
  })
  const projection = new Map<string, ProjectedBalance>()
  for await (const rows of res.stream()) {
    for (const row of rows) {
      const [account, asset, total, free, reserved, lastBlock] = row.json<[string, string, string, string, string, number | string]>()
      projection.set(pairKey(account, asset), { sig: balanceSignature(total, free, reserved), lastBlock: Number(lastBlock) })
    }
  }
  return projection
}

async function runOnce(): Promise<void> {
  const seeded = reconcile ? await hasSeed() : false
  const mode = balanceSweepMode({ reconcile, seeded })
  const pinned = mode === 'reconcile' && blockOverride == null ? await resolveIndexedSnapshotAnchor(rpc, client) : null
  const { hash, height } = pinned ?? await resolveSnapshotAnchor(rpc, blockOverride)
  const { block, timestamp } = await buildBlock(hash, height)
  const sourceKind = mode === 'reconcile' ? 'snapshot_reconcile' : 'snapshot_bootstrap'

  console.log(JSON.stringify({
    type: 'snapshot_start',
    mode,
    dry_run: dryRun,
    anchor_block: height,
    anchor_hash: hash,
    anchor_timestamp: timestamp,
    ...(pinned ? { indexed_head: pinned.indexedHead, finalized_head: pinned.finalizedHead } : {}),
    page_size: pageSize,
    flush_threshold: flushThreshold,
    include_native: !tokensOnly,
    include_tokens: !nativeOnly,
    rpc_url: config.RPC_URL,
  }))

  const reconciler = mode === 'reconcile' ? new BalanceReconciler(await loadProjection(), height) : null
  const write = !dryRun
  let buffer: RawBalanceObservationRow[] = []
  let inserted = 0
  const startedAt = Date.now()

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const rows = buffer
    buffer = []
    await client.insert({
      table: 'price_data.raw_balance_observations',
      values: rows,
      format: 'JSONEachRow',
    })
    inserted += rows.length
    console.log(JSON.stringify({ type: 'snapshot_flush', inserted, seconds: Math.round((Date.now() - startedAt) / 1000) }))
  }
  const accept = async (rows: RawBalanceObservationRow[]): Promise<void> => {
    const kept = reconciler ? reconciler.filter(rows) : rows
    if (!write) return
    buffer.push(...kept)
    if (buffer.length >= flushThreshold) await flush()
  }

  const counts = await streamBalanceSnapshot(block, timestamp, {
    pageSize,
    includeNative: !tokensOnly,
    includeTokens: !nativeOnly,
    ingestSource: 'rpc',
    sourceKind,
    // A seed dry run only counts keys; a reconcile dry run compares everything.
    countOnly: dryRun && reconciler == null,
    onObservations: dryRun && reconciler == null ? undefined : accept,
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

  if (reconciler != null) {
    const absent = reconciler.absentPairs({ native: !tokensOnly, tokens: !nativeOnly })
    if (write && absent.length) buffer.push(...snapshotAbsentRows(block, timestamp, 'rpc', 'snapshot_reconcile', absent))
  }
  if (write) await flush()

  console.log(JSON.stringify({
    type: 'snapshot_done',
    mode,
    dry_run: dryRun,
    anchor_block: height,
    native_accounts: counts.nativeAccounts,
    token_entries: counts.tokenEntries,
    total_observations: counts.nativeAccounts + counts.tokenEntries,
    ...(reconciler ? { reconcile: { ...reconciler.stats, diffs: reconciler.diffCount() } } : {}),
    rows_inserted: inserted,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2))

  // A diff is a balance the per-block pipeline did not observe: surface it.
  if (reconciler != null && reconciler.diffCount() > 0) {
    console.warn(JSON.stringify({
      type: 'balance_reconcile_drift',
      level: 'warn',
      anchor_block: height,
      diffs: reconciler.diffCount(),
      changed: reconciler.stats.changed,
      missing: reconciler.stats.missing,
      absent: reconciler.stats.absent,
      examples: reconciler.examples,
    }, null, 2))
  }
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
