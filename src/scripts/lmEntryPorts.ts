// The connection-bound half of the liquidity-mining entry repair: the ClickHouse
// reads, archive-node reads and insert that captureRange / reconcileLmEntries
// (lmEntryCapture.ts) take as ports. Shared by the manual tool
// (snapshot-lm-entries.ts) and the anchors loop's reconcile port
// (snapshot-atoken-anchors.ts --loop), so both repair with one implementation.
//
// Every ClickHouse read is bounded under BOUNDED_QUERY_SETTINGS: the entry events
// by a block range (one PREWHERE clause over lm_deposit_farm_events), the captured
// keys by the candidate deposits (raw_lm_farm_entries' key prefix), and the three
// reconcile sets by a LIMIT over tables of ~150k–190k rows (measured 64 ms for the
// full check).

import type { RpcClient } from '@subsquid/rpc-client'
import type { Runtime } from '@subsquid/substrate-runtime'
import { BOUNDED_QUERY_SETTINGS, type ClickHouseClient } from '../db/client.js'
import { LM_ENTRY_WARNING_CODE, LM_ENTRY_WARNING_PARSER } from '../raw/lmFarmEntries.js'
import {
  LM_STORAGE, depositEventsFromRows, targetKey,
  type CaptureChain, type CaptureSink, type CaptureSource, type DepositFarmEventRow, type LmFarmEntryRow, type LmPallet, type LmReconcileSource, type OpenLmEntryWarning, type UnparsedEntryEvent,
} from './lmEntryCapture.js'
import { loadRuntimeAt } from './snapshotRuntime.js'

type Rows = <T>(query: string, params?: Record<string, unknown>) => Promise<T[]>

function boundedRows(client: ClickHouseClient): Rows {
  return async <T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> => {
    const res = await client.query({ query, query_params: params, format: 'JSONEachRow', clickhouse_settings: BOUNDED_QUERY_SETTINGS })
    return res.json<T>()
  }
}

/**
 * `missingTableIsEmpty`: a dry run may precede raw_lm_farm_entries' creation (it
 * writes nothing, so it needs nothing from it) — read a missing table as empty
 * then, and only then.
 */
export function createLmCaptureSource(client: ClickHouseClient, opts: { missingTableIsEmpty?: boolean } = {}): CaptureSource {
  const rows = boundedRows(client)
  const capturedRows: Rows = async (query, params) => {
    try {
      return await rows(query, params)
    } catch (error) {
      const e = error as { type?: string; code?: string }
      if (opts.missingTableIsEmpty && (e.type === 'UNKNOWN_TABLE' || e.code === '60')) return []
      throw error
    }
  }
  return {
    async depositEvents(from, to) {
      // One table carries the event, its deposit and its farm, so there is no
      // second source to be visible later than the first. It is deposit-first, so
      // the block range cannot use its key: a PREWHERE on the two narrow columns
      // (one clause — see AGENTS on PREWHERE + WHERE), ~10 ms.
      // DISTINCT collapses replayed rows (identical but for ingested_at).
      return depositEventsFromRows(await rows<DepositFarmEventRow>(`
        SELECT DISTINCT block_height, event_index, pallet, event_kind, deposit_id, global_farm_id, yield_farm_id
        FROM price_data.lm_deposit_farm_events
        PREWHERE event_kind IN ('deposited', 'redeposited') AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}`,
      { from, to }))
    },
    async specVersions(heights) {
      const out = new Map<number, number>()
      // Sliced like capturedKeys: one bound array stays under the server's field limit.
      for (let i = 0; i < heights.length; i += 2_000) {
        const hs = heights.slice(i, i + 2_000)
        const r = await rows<{ block_height: number; spec_version: number }>(`
          SELECT block_height, max(spec_version) AS spec_version FROM price_data.blocks
          WHERE block_height >= {lo:UInt32} AND block_height <= {hi:UInt32} AND block_height IN {hs:Array(UInt32)}
          GROUP BY block_height`,
        { lo: Math.min(...hs), hi: Math.max(...hs), hs })
        for (const x of r) out.set(Number(x.block_height), Number(x.spec_version))
      }
      return out
    },
    async capturedKeys(from, to, deposits) {
      // Key-prefix read (pallet, deposit_id, …): only the candidate deposits, zipped
      // from two flat arrays (@clickhouse/client cannot bind Array(Tuple(…))). Sliced:
      // a dense chunk names thousands of deposits, and one bound parameter that long
      // is refused by the server ("Field value too long").
      const out = new Set<string>()
      for (let i = 0; i < deposits.length; i += 1_000) {
        const slice = deposits.slice(i, i + 1_000)
        const r = await capturedRows<{ pallet: LmPallet; deposit_id: string; block_height: number }>(`
          SELECT DISTINCT pallet, deposit_id, block_height FROM price_data.raw_lm_farm_entries
          WHERE (pallet, deposit_id) IN arrayZip({pallets:Array(String)}, {ids:Array(String)})
            AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}`,
        { from, to, pallets: slice.map(d => d.pallet), ids: slice.map(d => d.depositId) })
        for (const x of r) out.add(targetKey(x.pallet, String(x.deposit_id), Number(x.block_height)))
      }
      return out
    },
  }
}

/**
 * THE open set of LM capture warnings: every raw_parser_warnings row the raw
 * indexer wrote for a deposit it could not read (source_index '<pallet>:<deposit>')
 * whose (pallet, deposit, block) still has no raw_lm_farm_entries row. A warning is
 * never deleted or rewritten; the repair that closes it is the row landing, so
 * "open" is this anti-join and nothing else — a monitor asks this query (or reads
 * the anchors loop's `lm_entries_reconcile` log line, which reports it before and
 * after each cycle's repair), never the bare warning count.
 */
export const OPEN_LM_ENTRY_WARNINGS_SQL = `
  SELECT DISTINCT w.block_height AS block_height, w.source_index AS source_index
  FROM (
    SELECT block_height, source_index,
           splitByChar(':', source_index)[1] AS w_pallet, splitByChar(':', source_index)[2] AS w_deposit
    FROM price_data.raw_parser_warnings
    PREWHERE parser = '${LM_ENTRY_WARNING_PARSER}' AND warning_code = '${LM_ENTRY_WARNING_CODE}'
  ) AS w
  LEFT ANTI JOIN (SELECT DISTINCT pallet, deposit_id, block_height FROM price_data.raw_lm_farm_entries) AS c
    ON c.pallet = w.w_pallet AND c.deposit_id = w.w_deposit AND c.block_height = w.block_height
  ORDER BY block_height, source_index
  LIMIT {limit:UInt32}`

// Entry targets (a deposit/redeposit event's (pallet, deposit, block)) with no
// raw_lm_farm_entries row. Only targets whose NEWEST event row was ingested over
// an hour ago: the raw indexer writes the events (→ this MV) and the entries of
// one block in separate inserts, so a target just indexed — by raw-live or a
// backfill worker — may be mid-commit rather than missing. (Reading one anyway
// would only rewrite identical rows; the margin just keeps the check quiet.)
// A non-numeric deposit id names no storage key and never becomes a target
// (captureTargets), so re-reading its block could never close it: it is excluded
// here and listed by UNPARSED_ENTRY_EVENTS_SQL instead, which the reconcile
// reports every pass (`unparsed_deposit_ids`) and which keeps its outcome open.
const UNCAPTURED_TARGET_BLOCKS_SQL = `
  SELECT DISTINCT block_height FROM (
    SELECT pallet, deposit_id, block_height
    FROM price_data.lm_deposit_farm_events
    PREWHERE event_kind IN ('deposited', 'redeposited') AND pallet IN ('omnipool', 'xyk') AND match(deposit_id, '^[0-9]+$')
    GROUP BY pallet, deposit_id, block_height
    HAVING max(ingested_at) < now() - INTERVAL 1 HOUR
  ) AS e
  LEFT ANTI JOIN (SELECT DISTINCT pallet, deposit_id, block_height FROM price_data.raw_lm_farm_entries) AS c
    USING (pallet, deposit_id, block_height)
  ORDER BY block_height
  LIMIT {limit:UInt32}`

// Entry events whose deposit id is not a decimal integer — the complement of the
// full check's match() above, over the same PREWHERE-only read. The raw indexer
// also writes an lm_entry_unparsed_deposit_id warning for each; this reads the
// event side, so it also covers blocks indexed before that warning existed.
const UNPARSED_ENTRY_EVENTS_SQL = `
  SELECT DISTINCT block_height, event_index, pallet, deposit_id
  FROM price_data.lm_deposit_farm_events
  PREWHERE event_kind IN ('deposited', 'redeposited') AND NOT match(deposit_id, '^[0-9]+$')
  ORDER BY block_height, event_index
  LIMIT {limit:UInt32}`

export function createLmReconcileSource(client: ClickHouseClient): LmReconcileSource {
  const rows = boundedRows(client)
  return {
    async openWarnings(limit) {
      const r = await rows<{ block_height: number; source_index: string }>(OPEN_LM_ENTRY_WARNINGS_SQL, { limit })
      return r.map((x): OpenLmEntryWarning => ({ blockHeight: Number(x.block_height), sourceIndex: String(x.source_index) }))
    },
    async uncapturedBlocks(limit) {
      const r = await rows<{ block_height: number }>(UNCAPTURED_TARGET_BLOCKS_SQL, { limit })
      return r.map(x => Number(x.block_height))
    },
    async unparsedEntryEvents(limit) {
      const r = await rows<{ block_height: number; event_index: number; pallet: string; deposit_id: string }>(UNPARSED_ENTRY_EVENTS_SQL, { limit })
      return r.map((x): UnparsedEntryEvent => ({ blockHeight: Number(x.block_height), eventIndex: Number(x.event_index), pallet: String(x.pallet), depositId: String(x.deposit_id) }))
    },
  }
}

/**
 * Archive-node reads. Needs an ARCHIVE node: it reads state at historical block
 * hashes. One runtime per spec version, loaded from the state of the block before
 * the first one read with it (its code executed that block).
 */
export function createLmCaptureChain(rpc: RpcClient): CaptureChain {
  const runtimes = new Map<number, Promise<Runtime>>()
  const runtimeFor = (spec: number, height: number): Promise<Runtime> => {
    let p = runtimes.get(spec)
    if (!p) {
      p = rpc.call<string>('chain_getBlockHash', [height - 1]).then(hash => loadRuntimeAt(rpc, hash)).then(rt => {
        if (rt.specVersion !== spec) throw new Error(`runtime before block ${height} is spec ${rt.specVersion}, expected ${spec}`)
        return rt
      })
      p.catch(() => runtimes.delete(spec))
      runtimes.set(spec, p)
    }
    return p
  }
  return {
    async blockHashes(heights) {
      const out = new Map<number, string>()
      for (let i = 0; i < heights.length; i += 500) {
        const slice = heights.slice(i, i + 500)
        const hashes = await rpc.batchCall<string>(slice.map(h => ({ method: 'chain_getBlockHash', params: [h] })))
        slice.forEach((h, k) => { if (typeof hashes[k] === 'string') out.set(h, hashes[k]) })
      }
      return out
    },
    async readDeposits(block, pallet, depositIds) {
      const rt = await runtimeFor(block.layoutSpec, block.height)
      const name = LM_STORAGE[pallet]
      if (!rt.hasStorageItem(name)) throw new Error(`spec ${block.layoutSpec} has no ${name}`)
      return rt.queryStorage(block.hash, name, depositIds.map(id => BigInt(id)))
    },
  }
}

export function createLmCaptureSink(client: ClickHouseClient): CaptureSink {
  return {
    async insert(values: LmFarmEntryRow[]) {
      for (let i = 0; i < values.length; i += 10_000) {
        await client.insert({ table: 'price_data.raw_lm_farm_entries', values: values.slice(i, i + 10_000), format: 'JSONEachRow' })
      }
    },
  }
}
