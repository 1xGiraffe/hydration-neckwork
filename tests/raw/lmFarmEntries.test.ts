import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LM_ENTRY_UNPARSED_DEPOSIT_ID_CODE, LM_ENTRY_WARNING_CODE, LM_ENTRY_WARNING_PARSER, LM_STORAGE, captureLmFarmEntries, entryEventsFromRawEvents, unparsedDepositEvents,
  type EntryEventSource, type LmStorageRuntime,
} from '../../src/raw/lmFarmEntries.ts'
import { toJsonString } from '../../src/raw/json.ts'
import { RawClickHouseStore } from '../../src/raw/store.ts'

// The in-block capture of liquidity-mining farm entries the raw indexer runs:
// which events name a deposit (the lm_deposit_farm_events MV's extraction), one
// storage read per pallet at the block's hash under the executing runtime, and
// the money-market failure semantics — a failed read is a warning, never a row
// and never an aborted block.

const DEPOSIT_7 = {
  shares: 200365858883236438422n, ammPoolId: 222,
  yieldFarmEntries: [
    { globalFarmId: 133, yieldFarmId: 139, valuedShares: 19527202095720n, accumulatedRpvs: 369928335434911999679005n, accumulatedClaimedRewards: 5n, enteredAt: 33142328, updatedAt: 33142330, stoppedAtCreation: 0 },
    { globalFarmId: 1, yieldFarmId: 2, valuedShares: 10n, accumulatedRpvs: 0n, accumulatedClaimedRewards: 0n, enteredAt: 1, updatedAt: 1, stoppedAtCreation: 0 },
  ],
}
const XYK_DEPOSIT_3 = {
  shares: 665271478856n, ammPoolId: '0xbf80080b4d0077544ef058a29e878ae6f6bdb8cf2f462ab390490f668eb50b73',
  yieldFarmEntries: [{ globalFarmId: 3, yieldFarmId: 4, valuedShares: 710854745187n, accumulatedRpvs: 0n, accumulatedClaimedRewards: 0n, enteredAt: 23222734, updatedAt: 23222734, stoppedAtCreation: 0 }],
}

// Serialized exactly as the indexer's serializeEvent does (toJsonString: a u128 as a string).
const rawEvent = (event_index: number, event_name: string, args: unknown): EntryEventSource =>
  ({ block_height: 100, event_index, event_name, args_json: toJsonString(args) })

const BLOCK = { height: 100, hash: '0xblock100', timestamp: '2026-09-01 00:00:00' }

function fakeRuntime(storage: Record<string, Record<string, unknown>>, opts: { specVersion?: number; fail?: string; missing?: string } = {}) {
  const reads: Array<{ hash: string; name: string; keys: unknown[] }> = []
  const runtime: LmStorageRuntime = {
    specVersion: opts.specVersion ?? 440,
    hasStorageItem: name => name !== opts.missing,
    queryStorage: async (hash, name, keys) => {
      reads.push({ hash, name, keys })
      if (name === opts.fail) throw new Error('rpc down')
      return keys.map(k => storage[name]?.[String(k)])
    },
  }
  return { runtime, reads }
}

describe('entryEventsFromRawEvents — the MV\'s extraction', () => {
  it('names the deposit and farm as lm_deposit_farm_events does, and ignores every other event', () => {
    const events = entryEventsFromRawEvents([
      rawEvent(1, 'OmnipoolLiquidityMining.SharesDeposited', { globalFarmId: 133, yieldFarmId: 139, who: '0x01', lpToken: 5, amount: 1n, depositId: 7n }),
      rawEvent(2, 'OmnipoolLiquidityMining.SharesWithdrawn', { globalFarmId: 1, yieldFarmId: 2, depositId: 7n }),
      rawEvent(3, 'XYKLiquidityMining.SharesRedeposited', { globalFarmId: 3, yieldFarmId: 4, depositId: 3 }),
      rawEvent(4, 'Balances.Transfer', { from: '0x', to: '0x', amount: 1n }),
      rawEvent(5, 'OmnipoolLiquidityMining.SharesRedeposited', { depositId: 9n }),
    ])
    expect(events).toEqual([
      { blockHeight: 100, eventIndex: 1, eventName: 'OmnipoolLiquidityMining.SharesDeposited', depositId: '7', globalFarmId: 133, yieldFarmId: 139 },
      { blockHeight: 100, eventIndex: 3, eventName: 'XYKLiquidityMining.SharesRedeposited', depositId: '3', globalFarmId: 3, yieldFarmId: 4 },
      // JSONExtractUInt of an absent field is 0, and the MV row says so.
      { blockHeight: 100, eventIndex: 5, eventName: 'OmnipoolLiquidityMining.SharesRedeposited', depositId: '9', globalFarmId: 0, yieldFarmId: 0 },
    ])
  })

  it('agrees with the MV\'s SQL it restates', () => {
    const schema = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
    const mv = schema.split('\n').find(l => l.includes('lm_deposit_farm_events_mv'))!
    expect(mv).toContain(`trim(BOTH '"' FROM JSONExtractRaw(args_json, 'depositId')) AS deposit_id`)
    expect(mv).toContain(`toUInt32(JSONExtractUInt(args_json, 'yieldFarmId')) AS yield_farm_id`)
    expect(mv).toContain(`toUInt32(JSONExtractUInt(args_json, 'globalFarmId')) AS global_farm_id`)
  })
})

describe('captureLmFarmEntries', () => {
  const events = entryEventsFromRawEvents([
    rawEvent(4, 'OmnipoolLiquidityMining.SharesDeposited', { globalFarmId: 133, yieldFarmId: 139, depositId: 7n }),
    rawEvent(6, 'OmnipoolLiquidityMining.SharesRedeposited', { globalFarmId: 1, yieldFarmId: 2, depositId: 7n }),
    rawEvent(8, 'OmnipoolLiquidityMining.SharesDeposited', { globalFarmId: 5, yieldFarmId: 6, depositId: 8n }),
    rawEvent(9, 'XYKLiquidityMining.SharesDeposited', { globalFarmId: 3, yieldFarmId: 4, depositId: 3n }),
  ])
  const storage = { [LM_STORAGE.omnipool]: { 7: DEPOSIT_7 }, [LM_STORAGE.xyk]: { 3: XYK_DEPOSIT_3 } }

  it('reads each pallet once at the block hash and writes the rows the repair tool would', async () => {
    const { runtime, reads } = fakeRuntime(storage, { specVersion: 440 })
    const out = await captureLmFarmEntries(BLOCK, events, runtime, 'rpc')
    expect(reads).toEqual([
      { hash: '0xblock100', name: 'OmnipoolWarehouseLM.Deposit', keys: [7n, 8n] },
      { hash: '0xblock100', name: 'XYKWarehouseLM.Deposit', keys: [3n] },
    ])
    expect(out.reads).toBe(2)
    expect(out.warnings).toEqual([])
    expect(out.rows.map(r => [r.pallet, r.deposit_id, r.yield_farm_id, r.event_index, r.is_event_entry, r.capture_status, r.spec_version])).toEqual([
      ['omnipool', '7', 2, 4, 1, 'ok', 440],
      ['omnipool', '7', 139, 4, 1, 'ok', 440],
      // Deposit 8 is not stored at the block end: its entry is gone, counted not valued.
      ['omnipool', '8', 6, 8, 1, 'gone_at_block_end', 440],
      ['xyk', '3', 4, 9, 1, 'ok', 440],
    ])
    expect(out.rows[1]).toEqual({
      pallet: 'omnipool', deposit_id: '7', yield_farm_id: 139, global_farm_id: 133,
      valued_shares: '19527202095720', rpvs_entry: '369928335434911999679005', claimed_raw: '5',
      entered_at_period: 33142328, updated_at_period: 33142330, stopped_at_creation: 0,
      deposit_shares: '200365858883236438422', amm_pool_id: '222', is_event_entry: 1,
      block_height: 100, event_index: 4, event_name: 'OmnipoolLiquidityMining.SharesDeposited',
      block_hash: '0xblock100', spec_version: 440, capture_status: 'ok',
    })
  })

  it('costs nothing for a block without entry events', async () => {
    const { runtime, reads } = fakeRuntime(storage)
    expect(await captureLmFarmEntries(BLOCK, [], runtime, 'rpc')).toEqual({ rows: [], warnings: [], reads: 0 })
    expect(reads).toEqual([])
  })

  it('turns a failed read into one warning per deposit, no row, and leaves the other pallet whole', async () => {
    const { runtime } = fakeRuntime(storage, { fail: LM_STORAGE.omnipool })
    const out = await captureLmFarmEntries(BLOCK, events, runtime, 'sqd')
    // Never a gone_at_block_end for an unread deposit: that states the chain said "not there".
    expect(out.rows.map(r => [r.pallet, r.deposit_id, r.capture_status])).toEqual([['xyk', '3', 'ok']])
    expect(out.warnings.map(w => [w.parser, w.source_kind, w.source_name, w.source_index, w.warning_code, w.warning, w.block_height, w.ingest_source])).toEqual([
      [LM_ENTRY_WARNING_PARSER, 'storage', 'OmnipoolWarehouseLM.Deposit', 'omnipool:7', LM_ENTRY_WARNING_CODE, 'rpc down', 100, 'sqd'],
      [LM_ENTRY_WARNING_PARSER, 'storage', 'OmnipoolWarehouseLM.Deposit', 'omnipool:8', LM_ENTRY_WARNING_CODE, 'rpc down', 100, 'sqd'],
    ])
    expect(JSON.parse(out.warnings[0].evidence_json)).toMatchObject({ pallet: 'omnipool', deposit_id: '7', event_index: 4, yield_farm_ids: [139, 2], spec_version: 440 })
  })

  it('warns for one undecodable deposit without losing the rest of the read', async () => {
    const broken = { ...storage, [LM_STORAGE.omnipool]: { 7: DEPOSIT_7, 8: { shares: 1n, ammPoolId: 5 } } }
    const { runtime } = fakeRuntime(broken)
    const out = await captureLmFarmEntries(BLOCK, events, runtime, 'rpc')
    expect(out.rows.map(r => `${r.pallet}:${r.deposit_id}:${r.yield_farm_id}`)).toEqual(['omnipool:7:2', 'omnipool:7:139', 'xyk:3:4'])
    expect(out.warnings.map(w => [w.source_index, w.warning])).toEqual([['omnipool:8', 'deposit: no yieldFarmEntries']])
  })

  it('refuses a runtime without the storage item rather than decoding with a guess', async () => {
    const { runtime, reads } = fakeRuntime(storage, { missing: LM_STORAGE.xyk })
    const out = await captureLmFarmEntries(BLOCK, events, runtime, 'rpc')
    expect(reads.map(r => r.name)).toEqual(['OmnipoolWarehouseLM.Deposit'])
    expect(out.warnings.map(w => [w.source_index, w.warning])).toEqual([['xyk:3', 'spec 440 has no XYKWarehouseLM.Deposit']])
  })

  it('never drops an entry event without a decimal deposit id: it reads nothing for it and warns', async () => {
    const odd = entryEventsFromRawEvents([
      rawEvent(2, 'OmnipoolLiquidityMining.SharesDeposited', { globalFarmId: 1, yieldFarmId: 2, depositId: '0xdead' }),
      rawEvent(3, 'XYKLiquidityMining.SharesRedeposited', { globalFarmId: 3, yieldFarmId: 4 }),
    ])
    expect(unparsedDepositEvents([...odd, ...odd, ...events]).map(e => e.eventIndex)).toEqual([2, 3])
    const { runtime, reads } = fakeRuntime(storage)
    const out = await captureLmFarmEntries(BLOCK, [...odd, ...events], runtime, 'rpc')
    // The readable deposits are read and written exactly as without the odd events.
    expect(reads.map(r => r.keys)).toEqual([[7n, 8n], [3n]])
    expect(out.rows).toHaveLength(4)
    expect(out.warnings.map(w => [w.parser, w.source_kind, w.source_name, w.source_index, w.warning_code, w.block_height])).toEqual([
      [LM_ENTRY_WARNING_PARSER, 'event', 'OmnipoolLiquidityMining.SharesDeposited', '2', LM_ENTRY_UNPARSED_DEPOSIT_ID_CODE, 100],
      [LM_ENTRY_WARNING_PARSER, 'event', 'XYKLiquidityMining.SharesRedeposited', '3', LM_ENTRY_UNPARSED_DEPOSIT_ID_CODE, 100],
    ])
    expect(JSON.parse(out.warnings[0].evidence_json)).toMatchObject({ event_index: 2, deposit_id: '0xdead', yield_farm_id: 2 })
    // A block whose only entry event is unreadable still warns, with no RPC.
    const alone = fakeRuntime(storage)
    const only = await captureLmFarmEntries(BLOCK, odd.slice(0, 1), alone.runtime, 'rpc')
    expect(only).toMatchObject({ rows: [], reads: 0 })
    expect(only.warnings.map(w => w.warning_code)).toEqual([LM_ENTRY_UNPARSED_DEPOSIT_ID_CODE])
    expect(alone.reads).toEqual([])
  })

  it('is replay-safe: the same block writes the same rows under the same keys', async () => {
    const a = await captureLmFarmEntries(BLOCK, events, fakeRuntime(storage).runtime, 'rpc')
    const b = await captureLmFarmEntries(BLOCK, [...events].reverse(), fakeRuntime(storage).runtime, 'sqd')
    expect(JSON.stringify(b.rows)).toBe(JSON.stringify(a.rows))
    const keys = a.rows.map(r => `${r.pallet}|${r.deposit_id}|${r.yield_farm_id}|${r.block_height}|${r.event_index}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('the raw store writes the rows with every other raw table', () => {
  it('flushes raw_lm_farm_entries in flushAll and counts them toward the flush policy', async () => {
    const inserts: Array<{ table: string; values: unknown[] }> = []
    const store = new RawClickHouseStore({ insert: async (o: { table: string; values: unknown[] }) => { inserts.push(o) } } as never, 10_000)
    const { rows } = await captureLmFarmEntries(BLOCK, entryEventsFromRawEvents([
      rawEvent(4, 'OmnipoolLiquidityMining.SharesDeposited', { globalFarmId: 133, yieldFarmId: 139, depositId: 7n }),
    ]), fakeRuntime({ [LM_STORAGE.omnipool]: { 7: DEPOSIT_7 } }).runtime, 'rpc')
    store.addLmFarmEntries(rows)
    expect(store.pendingRows()).toBe(2)
    await store.flushAll()
    expect(inserts.filter(i => i.table === 'price_data.raw_lm_farm_entries').flatMap(i => i.values)).toEqual(rows)
  })
})

describe('the raw indexer wiring', () => {
  it('captures in every block with the executing runtime, never the grandparent\'s', () => {
    const indexer = readFileSync(new URL('../../src/raw/indexer.ts', import.meta.url), 'utf8')
    const call = indexer.slice(indexer.indexOf('captureLmFarmEntries('), indexer.indexOf('ctx.store.addLmFarmEntries('))
    // subsquid's _runtime is fetched at the parent hash — the code that executed the
    // block; _runtimeOfPrevBlock is one block older and wrong right after an upgrade.
    expect(call).toContain('block.header._runtime,')
    expect(indexer).not.toContain('_runtimeOfPrevBlock')
    expect(call).toContain('block.header.hash')
  })
})
