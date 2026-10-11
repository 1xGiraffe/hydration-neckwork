// Seed / verify tool for price_data.raw_account_state_observations (the raw
// indexer's account-state hook, src/raw/accountState.ts).
//
// The hook reads an account's locks, vesting schedules, conviction votes and
// proxies at every block whose events or calls name it — so the table states an
// account from the first block that named it after the hook went live. The SEED is
// the one pinned full read that makes every account complete from the hook's start
// block S: every Balances.Locks, Vesting.VestingSchedules, Proxy.Proxies and
// ConvictionVoting.VotingFor entry at the end of block S, decoded with the runtime
// that executed S, written as rows at S (trigger 'seed'). Run it ONCE, after the
// raw-live build carrying the hook has processed S (pick S at or after its first
// block, so no account changes between S and the hook's first read without being
// read). It is idempotent — chain state at a fixed block under the table's
// ReplacingMergeTree key — so a repeat rewrites identical rows. RPC_URL must be an
// archive node (state at S).
//
// Usage:
//   npx tsx src/scripts/snapshot-account-state.ts --block=S [--dry-run]
//   npx tsx src/scripts/snapshot-account-state.ts --verify --block=B
//
// --verify: read-only. A full enumeration at B against argMax(≤ B) of the table for
// every (kind, account) the table holds; exits non-zero on any mismatch. Accounts
// with state at B that the table never observed are counted (`unobserved`), which
// is zero for any B ≥ S once the seed has run.

import { createClickHouseClient, BOUNDED_QUERY_SETTINGS } from '../db/client.js'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'
import type { AccountStateKind } from '../raw/accountState.js'
import { hasFlag, optionalIntegerOption } from '../util/cliArgs.js'
import {
  accountStateDefaults, compareAccountState, enumerateAccountState, seedRows,
  type AccountStateEnumerationRuntime,
} from './accountStateCapture.js'
import { createAccountStateChain, createAccountStateSink } from './accountStatePorts.js'
import { createSnapshotRpcClient } from './snapshotRuntime.js'

const dryRun = hasFlag('dry-run')
const verify = hasFlag('verify')
const blockOption = optionalIntegerOption('block', { min: 1 })

async function main(): Promise<void> {
  if (blockOption == null) throw new Error('--block is required: the seed and the verifier read one pinned block')
  const rpc = createSnapshotRpcClient(config.RPC_URL)
  const chain = createAccountStateChain(rpc)
  const client = createClickHouseClient()
  try {
    const height = blockOption
    const hash = await chain.blockHash(height)
    const runtime = await chain.executingRuntime(height) as AccountStateEnumerationRuntime
    const startedAt = Date.now()
    const enumeration = await enumerateAccountState(runtime, hash)
    const counts = Object.fromEntries([...enumeration].map(([kind, accounts]) => [kind, accounts.size]))
    if (verify) {
      const res = await client.query({
        query: `SELECT kind, account_id, argMax(value_json, (block_height, ingested_at)) AS value_json
                FROM price_data.raw_account_state_observations
                WHERE block_height <= {b:UInt32}
                GROUP BY kind, account_id`,
        query_params: { b: height },
        format: 'JSONEachRow',
        clickhouse_settings: BOUNDED_QUERY_SETTINGS,
      })
      const observed = new Map<AccountStateKind, Map<string, string>>()
      for (const row of await res.json<{ kind: AccountStateKind; account_id: string; value_json: string }>()) {
        let accounts = observed.get(row.kind)
        if (accounts == null) {
          accounts = new Map()
          observed.set(row.kind, accounts)
        }
        accounts.set(row.account_id, row.value_json)
      }
      const result = compareAccountState(enumeration, observed, accountStateDefaults(runtime))
      console.log(JSON.stringify({ type: 'account_state_verify', block: height, chain_accounts: counts, result, seconds: Math.round((Date.now() - startedAt) / 1000) }, null, 2))
      if (Object.values(result).some(r => r.mismatched > 0)) process.exitCode = 1
      return
    }
    const timestamp = Number(await runtime.getStorage(hash, 'Timestamp.Now'))
    const rows = seedRows(enumeration, { height, hash, timestamp: toClickHouseDateTime(timestamp, height), specVersion: runtime.specVersion })
    if (!dryRun) await createAccountStateSink(client).insert(rows)
    console.log(JSON.stringify({ type: 'account_state_seed', dry_run: dryRun, block: height, spec_version: runtime.specVersion, accounts: counts, rows: rows.length, seconds: Math.round((Date.now() - startedAt) / 1000) }))
  } finally {
    await client.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
