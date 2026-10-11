// The connection-bound half of the account-state repair (accountStateCapture.ts):
// the ClickHouse open-warning read and insert, and the archive-node reads. Used by
// the anchors loop (snapshot-atoken-anchors.ts --loop) and the seed/verify tool
// (snapshot-account-state.ts).

import type { RpcClient } from '@subsquid/rpc-client'
import type { Runtime } from '@subsquid/substrate-runtime'
import { BOUNDED_QUERY_SETTINGS, type ClickHouseClient } from '../db/client.js'
import { ACCOUNT_STATE_KINDS, ACCOUNT_STATE_WARNING_CODE, ACCOUNT_STATE_WARNING_PARSER, type AccountStateKind, type AccountStateRow, type AccountStateRuntime } from '../raw/accountState.js'
import type { AccountStateChain, AccountStateReconcileSource, AccountStateSink, OpenAccountStateWarning } from './accountStateCapture.js'
import { loadRuntimeAt } from './snapshotRuntime.js'

/**
 * THE open set of account-state capture warnings: every raw_parser_warnings row the
 * raw indexer wrote for a (kind, account) it could not read (source_index
 * '<kind>:<account>') whose (block, kind, account) still has no
 * raw_account_state_observations row. Never the bare warning count.
 */
export const OPEN_ACCOUNT_STATE_WARNINGS_SQL = `
  SELECT w.block_height AS block_height, toString(w.block_timestamp) AS block_timestamp, w.kind AS kind, w.account AS account, w.evidence_json AS evidence_json
  FROM (
    SELECT block_height, any(block_timestamp) AS block_timestamp, source_index, any(evidence_json) AS evidence_json,
           splitByChar(':', source_index)[1] AS kind, splitByChar(':', source_index)[2] AS account
    FROM price_data.raw_parser_warnings
    PREWHERE parser = '${ACCOUNT_STATE_WARNING_PARSER}' AND warning_code = '${ACCOUNT_STATE_WARNING_CODE}'
    GROUP BY block_height, source_index
  ) AS w
  LEFT ANTI JOIN (SELECT DISTINCT block_height, kind, account_id FROM price_data.raw_account_state_observations) AS c
    ON c.block_height = w.block_height AND c.kind = w.kind AND c.account_id = w.account
  ORDER BY block_height, kind, account
  LIMIT {limit:UInt32}`

function triggersOf(evidenceJson: string): string[] {
  try {
    const evidence = JSON.parse(evidenceJson) as { triggers?: unknown }
    return Array.isArray(evidence.triggers) ? evidence.triggers.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export function createAccountStateReconcileSource(client: ClickHouseClient): AccountStateReconcileSource {
  return {
    async openWarnings(limit) {
      const res = await client.query({ query: OPEN_ACCOUNT_STATE_WARNINGS_SQL, query_params: { limit }, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
      const rows = await res.json<{ block_height: number; block_timestamp: string; kind: string; account: string; evidence_json: string }>()
      const out: OpenAccountStateWarning[] = []
      for (const r of rows) {
        if (!(ACCOUNT_STATE_KINDS as string[]).includes(r.kind)) continue
        out.push({ blockHeight: Number(r.block_height), blockTimestamp: String(r.block_timestamp), kind: r.kind as AccountStateKind, account: r.account, triggers: triggersOf(r.evidence_json) })
      }
      return out
    },
  }
}

/**
 * Archive-node reads. The executing runtime of block N is the code in N − 1's
 * state; one runtime per spec version is kept (the version at a parent hash is
 * one cheap call, the metadata is loaded once per spec).
 */
export function createAccountStateChain(rpc: RpcClient): AccountStateChain {
  const bySpec = new Map<number, Promise<Runtime>>()
  return {
    blockHash: height => rpc.call<string>('chain_getBlockHash', [height]),
    async executingRuntime(height) {
      const parent = await rpc.call<string>('chain_getBlockHash', [height - 1])
      const version = await rpc.call<{ specVersion: number }>('state_getRuntimeVersion', [parent])
      let runtime = bySpec.get(version.specVersion)
      if (runtime == null) {
        runtime = loadRuntimeAt(rpc, parent)
        runtime.catch(() => bySpec.delete(version.specVersion))
        bySpec.set(version.specVersion, runtime)
      }
      return (await runtime) as unknown as AccountStateRuntime
    },
  }
}

export function createAccountStateSink(client: ClickHouseClient): AccountStateSink {
  return {
    async insert(values: AccountStateRow[]) {
      for (let i = 0; i < values.length; i += 10_000) {
        await client.insert({ table: 'price_data.raw_account_state_observations', values: values.slice(i, i + 10_000), format: 'JSONEachRow' })
      }
    },
  }
}
