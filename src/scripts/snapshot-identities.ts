import type { RpcClient } from '@subsquid/rpc-client'
import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { hasFlag, integerOption, optionalIntegerOption, stringOption } from '../util/cliArgs.js'
import { toClickHouseDateTime } from '../raw/json.js'
import { createSnapshotRpcClient, loadSnapshotRuntime, resolveSnapshotAnchor, runSnapshotProcess } from './snapshotRuntime.js'
import { parseIdentityChains, type IdentityChain } from './identityChains.js'
import {
  readStorageMap,
  registrationFrom,
  resolveIdentityRows,
  subIdentityFrom,
  tombstoneRow,
  usernameFrom,
  type AccountIdentityRow,
  type ChainIdentityState,
} from './identitySources.js'

// Cross-chain on-chain identity snapshot.
//
// Walks every configured chain's Identity storage at a single anchor block per
// chain and writes one price_data.account_identities row per (chain, account)
// that resolves to a display name — its own registration, else "Parent/Sub" for a
// sub-identity, else its primary username.
//
// The Identity pallet is keyed by AccountId, so the same public key can hold a
// registration on several chains. Every row is kept and the API picks the winner
// by the configured priority (Hydration first). Nothing records which chain a
// displayed name came from; the explorer shows one name per account.
//
// Chains are independent: one unreachable RPC logs and is skipped, leaving every
// other chain's identities in place.
//
// Usage:
//   npx tsx src/scripts/snapshot-identities.ts [--dry-run] [--loop] [--chain=KEY]
//                                              [--block=N] [--page-size=500]
//
// State availability: reads STATE at each chain's anchor. A pruned node only keeps
// recent state, so a pinned `@block` (or --block) anchor needs an archive RPC; the
// head default always works.

const dryRun = hasFlag('dry-run')
// --loop runs an initial snapshot immediately, then re-snapshots every
// --refresh-hours, so the service self-populates on `docker compose up` and keeps
// identities fresh without any manual step.
const loop = hasFlag('loop')
const refreshHours = integerOption('refresh-hours', 1)
const pageSize = integerOption('page-size', 500)
const flushThreshold = integerOption('flush', 5_000)
// Anchor override for a manual run. It applies to every chain being snapshotted,
// so pair it with --chain: block heights are not comparable across chains.
const blockOverride = optionalIntegerOption('block')
const chainFilter = stringOption('chain')?.toLowerCase()

const client = createClickHouseClient()
const configured = parseIdentityChains(config.IDENTITY_CHAINS, config.RPC_URL)
const selected = chainFilter == null ? configured : configured.filter(chain => chain.key === chainFilter)

async function insertRows(rows: AccountIdentityRow[]): Promise<number> {
  if (dryRun || rows.length === 0) return 0
  for (let offset = 0; offset < rows.length; offset += flushThreshold) {
    await client.insert({
      table: 'price_data.account_identities',
      values: rows.slice(offset, offset + flushThreshold),
      format: 'JSONEachRow',
    })
  }
  return rows.length
}

async function displayedAccounts(chain: string): Promise<Set<string>> {
  const res = await client.query({
    query: `
      SELECT account_id
      FROM price_data.account_identities FINAL
      WHERE chain = {chain:String} AND display != ''`,
    query_params: { chain },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ account_id: string }>()
  return new Set(rows.map(row => row.account_id))
}

async function snapshotChain(chain: IdentityChain): Promise<void> {
  let rpc: RpcClient | null = null
  const startedAt = Date.now()
  try {
    rpc = createSnapshotRpcClient(chain.url)
    const { hash, height } = await resolveSnapshotAnchor(rpc, blockOverride ?? chain.block)
    const { runtime, timestamp } = await loadSnapshotRuntime(rpc, hash)

    const state: ChainIdentityState = {
      registrations: await readStorageMap(runtime, hash, 'Identity.IdentityOf', pageSize, registrationFrom),
      subs: await readStorageMap(runtime, hash, 'Identity.SuperOf', pageSize, subIdentityFrom),
      usernames: await readStorageMap(runtime, hash, 'Identity.UsernameOf', pageSize, value => usernameFrom(value) || null),
    }

    const rows = resolveIdentityRows(state, chain, timestamp)
    // An identity cleared on chain has to disappear here too, or the explorer keeps
    // showing a name its owner removed. A dry run stays off ClickHouse entirely, so
    // it can prove a new chain decodes without a database to compare against.
    const live = new Set(rows.map(row => row.account_id))
    const retired = dryRun ? [] : [...await displayedAccounts(chain.key)]
      .filter(accountId => !live.has(accountId))
      .map(accountId => tombstoneRow(chain, accountId, timestamp))

    const inserted = await insertRows([...rows, ...retired])

    console.log(JSON.stringify({
      type: 'identity_snapshot_chain',
      chain: chain.key,
      priority: chain.priority,
      rpc_url: chain.url,
      anchor_block: height,
      pinned: chain.block != null || blockOverride != null,
      registrations: state.registrations.size,
      subs: state.subs.size,
      usernames: state.usernames.size,
      displayed: rows.length,
      retired: retired.length,
      rows_inserted: inserted,
      dry_run: dryRun,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    }))
  } finally {
    rpc?.close()
  }
}

// A chain dropped from the configuration keeps its rows otherwise, and they would
// go on naming accounts forever. Only safe once every configured chain succeeded:
// a partial cycle cannot tell "removed from config" from "failed this pass".
async function retireUnconfiguredChains(timestamp: string): Promise<void> {
  const res = await client.query({
    query: `SELECT DISTINCT chain FROM price_data.account_identities FINAL WHERE display != ''`,
    format: 'JSONEachRow',
  })
  const stored = (await res.json<{ chain: string }>()).map(row => row.chain)
  const keys = new Set(configured.map(chain => chain.key))

  for (const chain of stored) {
    if (keys.has(chain)) continue
    const accounts = await displayedAccounts(chain)
    // Priority is irrelevant for a tombstone: the API never reads a blank display.
    const rows = [...accounts].map(accountId => tombstoneRow({ key: chain, url: '', block: null, priority: 255 }, accountId, timestamp))
    const inserted = await insertRows(rows)
    console.log(JSON.stringify({ type: 'identity_snapshot_chain_retired', chain, retired: rows.length, rows_inserted: inserted, dry_run: dryRun }))
  }
}

async function runOnce(): Promise<void> {
  console.log(JSON.stringify({
    type: 'identity_snapshot_start',
    dry_run: dryRun,
    page_size: pageSize,
    chains: selected.map(chain => chain.key),
  }))

  let failed = 0
  for (const chain of selected) {
    try {
      await snapshotChain(chain)
    } catch (error) {
      failed++
      console.error(JSON.stringify({ type: 'identity_snapshot_chain_error', chain: chain.key, rpc_url: chain.url, reason: (error as Error).message }))
    }
  }

  if (failed === 0 && chainFilter == null && !dryRun) {
    // Wall clock, not a chain anchor: a dropped chain has no anchor to read, and
    // this has to outrank whatever timestamp its stored rows carry.
    await retireUnconfiguredChains(toClickHouseDateTime(Date.now()))
  }

  console.log(JSON.stringify({ type: 'identity_snapshot_done', chains: selected.length, chains_failed: failed, dry_run: dryRun }))
}

void runSnapshotProcess({
  loop,
  refreshHours,
  runOnce,
  close: async () => {
    await client.close()
  },
})
