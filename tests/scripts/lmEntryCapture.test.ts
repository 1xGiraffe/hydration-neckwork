import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENTRY_EVENT_NAMES, captureRange, captureTargets, chunks, depositEventsFromRows, entryEventName, entryRows, executingSpec, normalizeDeposit, reconcileLmEntries, targetKey,
  type CaptureChain, type CaptureSource, type DepositEvent, type DepositFarmEventRow, type LmFarmEntryRow, type LmPallet, type LmReconcileSource, type OpenLmEntryWarning, type UnparsedEntryEvent,
} from '../../src/scripts/lmEntryCapture.ts'
import { OPEN_LM_ENTRY_WARNINGS_SQL } from '../../src/scripts/lmEntryPorts.ts'

// The verify/repair walk of liquidity-mining farm entries (snapshot-lm-entries.ts):
// which storage reads a block range needs, how a decoded Deposit becomes rows,
// which runtime decodes an upgrade block, and that a run is resumable and
// replay-safe. The in-block capture the raw indexer runs is tests/raw/lmFarmEntries.test.ts.

// Decoded `DepositData` exactly as @subsquid/substrate-runtime returned it from
// the archive node (integers as bigint/number, an XYK pool as AccountId32 hex),
// at three runtimes: the first LM era (spec 151), XYK farms (264) and today (443).
const SPEC_151_OMNIPOOL_DEPOSIT_1 = {
  shares: 2837838022810n, ammPoolId: 5,
  yieldFarmEntries: [{ globalFarmId: 1, yieldFarmId: 2, valuedShares: 54867223925985n, accumulatedRpvs: 0n, accumulatedClaimedRewards: 0n, enteredAt: 15943342, updatedAt: 15943342, stoppedAtCreation: 0 }],
}
const SPEC_264_XYK_DEPOSIT_1 = {
  shares: 665271478856n, ammPoolId: '0xbf80080b4d0077544ef058a29e878ae6f6bdb8cf2f462ab390490f668eb50b73',
  yieldFarmEntries: [
    { globalFarmId: 1, yieldFarmId: 2, valuedShares: 710854745187n, accumulatedRpvs: 0n, accumulatedClaimedRewards: 0n, enteredAt: 23222730, updatedAt: 23222730, stoppedAtCreation: 0 },
    { globalFarmId: 3, yieldFarmId: 4, valuedShares: 710854745187n, accumulatedRpvs: 0n, accumulatedClaimedRewards: 0n, enteredAt: 23222734, updatedAt: 23222734, stoppedAtCreation: 0 },
  ],
}
const SPEC_443_OMNIPOOL_DEPOSIT_77881 = {
  shares: 200365858883236438422n, ammPoolId: 222,
  yieldFarmEntries: [{ globalFarmId: 133, yieldFarmId: 139, valuedShares: 19527202095720n, accumulatedRpvs: 369928335434911999679005n, accumulatedClaimedRewards: 0n, enteredAt: 33142328, updatedAt: 33142328, stoppedAtCreation: 0 }],
}

const ev = (blockHeight: number, eventIndex: number, depositId: string, yieldFarmId: number, eventName = 'OmnipoolLiquidityMining.SharesDeposited'): DepositEvent =>
  ({ blockHeight, eventIndex, eventName, depositId, globalFarmId: 1, yieldFarmId })

describe('captureTargets', () => {
  it('reads each deposit once per block, with every farm the block entered', () => {
    const targets = captureTargets([
      ev(10, 3, '7', 2), ev(10, 5, '7', 4, 'OmnipoolLiquidityMining.SharesRedeposited'), ev(10, 4, '8', 2), ev(12, 1, '7', 6),
      ev(10, 9, '7', 2, 'XYKLiquidityMining.SharesDeposited'),
    ])
    expect(targets.map(t => [t.blockHeight, t.pallet, t.depositId, t.eventIndex, t.eventFarms.map(f => f.yieldFarmId)])).toEqual([
      [10, 'omnipool', '7', 3, [2, 4]], [10, 'omnipool', '8', 4, [2]], [10, 'xyk', '7', 9, [2]], [12, 'omnipool', '7', 1, [6]],
    ])
  })

  it('collapses replayed event rows (same block and event index)', () => {
    const targets = captureTargets([ev(10, 3, '7', 2), ev(10, 3, '7', 2), ev(10, 3, '7', 2)])
    expect(targets).toHaveLength(1)
    expect(targets[0].eventFarms).toEqual([{ globalFarmId: 1, yieldFarmId: 2 }])
  })

  it('ignores events that create no entry', () => {
    expect(captureTargets([ev(10, 3, '7', 2, 'OmnipoolLiquidityMining.SharesWithdrawn'), ev(10, 4, '', 2)])).toEqual([])
  })
})

describe('normalizeDeposit — decoded storage across runtimes', () => {
  it('reads the first-era Omnipool, the XYK and the current Omnipool layout alike', () => {
    expect(normalizeDeposit(SPEC_151_OMNIPOOL_DEPOSIT_1, 'omnipool')).toEqual({
      shares: 2837838022810n, ammPoolId: '5',
      entries: [{ globalFarmId: 1, yieldFarmId: 2, valuedShares: 54867223925985n, accumulatedRpvs: 0n, accumulatedClaimedRewards: 0n, enteredAt: 15943342, updatedAt: 15943342, stoppedAtCreation: 0 }],
    })
    const xyk = normalizeDeposit(SPEC_264_XYK_DEPOSIT_1, 'xyk')
    expect(xyk.ammPoolId).toBe('0xbf80080b4d0077544ef058a29e878ae6f6bdb8cf2f462ab390490f668eb50b73')
    expect(xyk.entries.map(e => e.yieldFarmId)).toEqual([2, 4])
    // Above 2^64 stays exact.
    expect(normalizeDeposit(SPEC_443_OMNIPOOL_DEPOSIT_77881, 'omnipool').entries[0].accumulatedRpvs).toBe(369928335434911999679005n)
  })

  it('refuses a layout it does not know rather than guessing a row', () => {
    expect(() => normalizeDeposit({ shares: 1n, ammPoolId: 5 }, 'omnipool')).toThrow(/yieldFarmEntries/)
    expect(() => normalizeDeposit({ ...SPEC_264_XYK_DEPOSIT_1, ammPoolId: 5 }, 'xyk')).toThrow(/AccountId32/)
    const noRpvs = { ...SPEC_151_OMNIPOOL_DEPOSIT_1, yieldFarmEntries: [{ ...SPEC_151_OMNIPOOL_DEPOSIT_1.yieldFarmEntries[0], accumulatedRpvs: undefined }] }
    expect(() => normalizeDeposit(noRpvs, 'omnipool')).toThrow(/accumulatedRpvs/)
  })
})

describe('entryRows', () => {
  const ctx = { blockHash: '0xabc', specVersion: 264 }
  const [target] = captureTargets([ev(6314404, 7, '1', 4, 'XYKLiquidityMining.SharesRedeposited')])

  it('captures every entry of the deposit and marks the one the event created', () => {
    const rows = entryRows(target, normalizeDeposit(SPEC_264_XYK_DEPOSIT_1, 'xyk'), ctx)
    expect(rows.map(r => [r.yield_farm_id, r.is_event_entry, r.capture_status])).toEqual([[2, 0, 'ok'], [4, 1, 'ok']])
    expect(rows[1]).toMatchObject({ pallet: 'xyk', deposit_id: '1', global_farm_id: 3, valued_shares: '710854745187', rpvs_entry: '0', claimed_raw: '0', entered_at_period: 23222734, block_height: 6314404, event_index: 7, block_hash: '0xabc', spec_version: 264 })
  })

  it('states an entry gone at the block end — deposit destroyed, or that farm left — never a value', () => {
    expect(entryRows(target, undefined, ctx).map(r => [r.yield_farm_id, r.capture_status, r.valued_shares])).toEqual([[4, 'gone_at_block_end', '0']])
    const withoutFarm4 = { ...normalizeDeposit(SPEC_264_XYK_DEPOSIT_1, 'xyk') }
    withoutFarm4.entries = withoutFarm4.entries.filter(e => e.yieldFarmId !== 4)
    expect(entryRows(target, withoutFarm4, ctx).map(r => [r.yield_farm_id, r.capture_status])).toEqual([[2, 'ok'], [4, 'gone_at_block_end']])
  })
})

describe('executingSpec — the layout of an upgrade block', () => {
  it('is the parent\'s spec: the block that applied new code still holds the old layout', () => {
    // blocks.spec_version at the upgrade block 14,362,830 is already 443.
    const specs = new Map([[14_362_829, 440], [14_362_830, 443], [14_362_831, 443]])
    expect(executingSpec(specs, 14_362_830)).toBe(440)
    expect(executingSpec(specs, 14_362_831)).toBe(443)
    expect(executingSpec(specs, 14_362_829)).toBeUndefined() // parent not known: no guess
  })
})

// An in-memory source/chain/sink: the sink feeds capturedKeys like the table does.
function harness(events: DepositEvent[], storage: (spec: number, pallet: LmPallet, id: string) => unknown | undefined, specs: Map<number, number>) {
  const table: LmFarmEntryRow[] = []
  const reads: Array<{ height: number; layoutSpec: number; pallet: LmPallet; ids: string[] }> = []
  let inserts = 0
  let failAt: number | null = null
  const keyReads: Array<Array<{ pallet: LmPallet; depositId: string }>> = []
  const source: CaptureSource = {
    depositEvents: async (from, to) => events.filter(e => e.blockHeight >= from && e.blockHeight <= to),
    specVersions: async heights => new Map(heights.filter(h => specs.has(h)).map(h => [h, specs.get(h)!])),
    // Like the key-prefix read: only the deposits asked about.
    capturedKeys: async (from, to, deposits) => {
      keyReads.push(deposits)
      const asked = new Set(deposits.map(d => `${d.pallet}:${d.depositId}`))
      return new Set(table.filter(r => r.block_height >= from && r.block_height <= to && asked.has(`${r.pallet}:${r.deposit_id}`)).map(r => targetKey(r.pallet, r.deposit_id, r.block_height)))
    },
  }
  const chain: CaptureChain = {
    blockHashes: async heights => new Map(heights.map(h => [h, `0x${h.toString(16)}`])),
    readDeposits: async (block, pallet, ids) => {
      if (failAt === block.height) throw new Error('rpc down')
      reads.push({ height: block.height, layoutSpec: block.layoutSpec, pallet, ids })
      return ids.map(id => storage(block.layoutSpec, pallet, id))
    },
  }
  const sink = { insert: async (rows: LmFarmEntryRow[]) => { inserts++; table.push(...rows) } }
  return { source, chain, sink, table, reads, keyReads, inserts: () => inserts, failAt: (h: number | null) => { failAt = h } }
}

describe('captureRange — resumable and replay-safe', () => {
  const specs = new Map([[99, 440], [100, 443], [101, 443], [199, 443], [200, 443]])
  const storage = (_spec: number, pallet: LmPallet, id: string) => (pallet === 'omnipool' && id === '7' ? SPEC_443_OMNIPOOL_DEPOSIT_77881 : undefined)
  const events = [ev(100, 3, '7', 139), ev(200, 1, '7', 139), ev(200, 2, '9', 5)]
  const opts = { dryRun: false, recapture: false, concurrency: 2 }

  it('reads every target at its block with the executing runtime and inserts once per chunk', async () => {
    const h = harness(events, storage, specs)
    const stats = await captureRange(0, 999, h, opts)
    expect(stats).toMatchObject({ events: 3, targets: 3, skipped: 0, blocks: 2, reads: 2, rows: 3, gone: 1 })
    // Block 100 is the upgrade block: decoded with its parent's spec 440.
    expect(h.reads.map(r => [r.height, r.layoutSpec])).toEqual([[100, 440], [200, 443]])
    expect(h.inserts()).toBe(1)
    expect(h.table.map(r => [r.block_height, r.deposit_id, r.capture_status])).toEqual([[100, '7', 'ok'], [200, '7', 'ok'], [200, '9', 'gone_at_block_end']])
  })

  it('skips what is captured on a re-run, and a recapture writes identical rows', async () => {
    const h = harness(events, storage, specs)
    await captureRange(0, 999, h, opts)
    const again = await captureRange(0, 999, h, opts)
    expect(again).toMatchObject({ targets: 0, skipped: 3, reads: 0, rows: 0 })
    expect(h.inserts()).toBe(1)
    const before = JSON.stringify(h.table)
    await captureRange(0, 999, h, { ...opts, recapture: true })
    // A replay adds the same keys with the same values (the table replaces them).
    expect(JSON.stringify(h.table.slice(3))).toBe(before)
  })

  it('writes nothing for a chunk that failed mid-way, so the next run redoes it whole', async () => {
    const h = harness(events, storage, specs)
    h.failAt(200)
    await expect(captureRange(0, 999, h, opts)).rejects.toThrow('rpc down')
    expect(h.table).toEqual([])
    h.failAt(null)
    expect((await captureRange(0, 999, h, opts)).targets).toBe(3)
  })

  it('writes nothing in a dry run but reports and collects the rows', async () => {
    const h = harness(events, storage, specs)
    const collect: LmFarmEntryRow[] = []
    const stats = await captureRange(0, 999, h, { ...opts, dryRun: true, collect })
    expect(stats.rows).toBe(3)
    expect(collect).toHaveLength(3)
    expect(h.table).toEqual([])
  })

  it('refuses a block it has no spec for rather than decoding with a guess', async () => {
    const h = harness([ev(500, 1, '7', 139)], storage, specs)
    await expect(captureRange(0, 999, h, opts)).rejects.toThrow(/no hash\/spec/)
  })
})

describe('the entry events from lm_deposit_farm_events alone', () => {
  const row = (block_height: number, event_index: number, pallet: string, event_kind: string, deposit_id: string, yield_farm_id: number): DepositFarmEventRow =>
    ({ block_height, event_index, pallet, event_kind, deposit_id, global_farm_id: 1, yield_farm_id })

  it('restores each entry event name from the row\'s pallet and kind, and drops the kinds that open no entry', () => {
    expect(ENTRY_EVENT_NAMES.map(n => entryEventName(n.startsWith('Omnipool') ? 'omnipool' : 'xyk', n.endsWith('SharesDeposited') ? 'deposited' : 'redeposited'))).toEqual(ENTRY_EVENT_NAMES)
    for (const kind of ['withdrawn', 'claimed', 'destroyed']) expect(entryEventName('omnipool', kind)).toBeNull()
    expect(entryEventName('stableswap', 'deposited')).toBeNull()
  })

  it('yields the targets the lifecycle + raw-event join did, farm ids and all', () => {
    // The rows as the table holds them (the MV projects pallet/kind from the event
    // name), and the same events as the old two-table read assembled them.
    const rows = [
      row(10, 3, 'omnipool', 'deposited', '7', 2), row(10, 5, 'omnipool', 'redeposited', '7', 4), row(10, 4, 'omnipool', 'deposited', '8', 2),
      row(10, 9, 'xyk', 'deposited', '7', 2), row(12, 1, 'omnipool', 'redeposited', '7', 6), row(12, 2, 'xyk', 'redeposited', '3', 4),
      row(13, 1, 'omnipool', 'withdrawn', '7', 2), row(13, 2, 'omnipool', 'claimed', '7', 2),
    ]
    const joined = [
      ev(10, 3, '7', 2), ev(10, 5, '7', 4, 'OmnipoolLiquidityMining.SharesRedeposited'), ev(10, 4, '8', 2),
      ev(10, 9, '7', 2, 'XYKLiquidityMining.SharesDeposited'), ev(12, 1, '7', 6, 'OmnipoolLiquidityMining.SharesRedeposited'),
      ev(12, 2, '3', 4, 'XYKLiquidityMining.SharesRedeposited'),
    ]
    expect(depositEventsFromRows(rows)).toEqual(joined)
    expect(captureTargets(depositEventsFromRows(rows))).toEqual(captureTargets(joined))
  })

  it('has no second source to be visible later: every event arrives with its farm, replays collapse', () => {
    // The old read threw on a lifecycle row whose raw twin was not visible yet; one
    // row now carries both, so an event is either whole or absent.
    const events = depositEventsFromRows([row(10, 3, 'omnipool', 'deposited', '7', 2), row(10, 3, 'omnipool', 'deposited', '7', 2)])
    expect(events.every(e => Number.isInteger(e.yieldFarmId) && Number.isInteger(e.globalFarmId))).toBe(true)
    expect(captureTargets(events)).toEqual([{ blockHeight: 10, pallet: 'omnipool', depositId: '7', eventIndex: 3, eventName: 'OmnipoolLiquidityMining.SharesDeposited', eventFarms: [{ globalFarmId: 1, yieldFarmId: 2 }] }])
  })

  it('reads the source with one PREWHERE and the captured keys by their key prefix (the ports\' SQL)', () => {
    const script = readFileSync(new URL('../../src/scripts/lmEntryPorts.ts', import.meta.url), 'utf8')
    const body = (name: string) => script.slice(script.indexOf(`async ${name}(`), script.indexOf('\n    },', script.indexOf(`async ${name}(`)))
    const events = body('depositEvents')
    expect(events).toContain('FROM price_data.lm_deposit_farm_events')
    expect(events).not.toMatch(/lp_lifecycle_events|raw_events/)
    const sql = events.slice(events.indexOf('`'), events.lastIndexOf('`'))
    expect(sql).toContain('PREWHERE')
    expect(sql).not.toMatch(/(?<!PRE)WHERE/) // PREWHERE + WHERE drops rows on 26.3
    const keys = body('capturedKeys')
    expect(keys).toContain('(pallet, deposit_id) IN arrayZip({pallets:Array(String)}, {ids:Array(String)})')
  })
})

describe('captureRange — captured keys by deposit', () => {
  const specs = new Map([[99, 440], [100, 443], [149, 443], [150, 443], [199, 443], [200, 443]])
  const storage = (_spec: number, pallet: LmPallet, id: string) => (pallet === 'omnipool' && id === '7' ? SPEC_443_OMNIPOOL_DEPOSIT_77881 : undefined)
  const opts = { dryRun: false, recapture: false, concurrency: 2 }

  it('asks for exactly the candidate deposits, once each, and skips what they have captured', async () => {
    const h = harness([ev(100, 3, '7', 139), ev(200, 1, '7', 139), ev(200, 2, '9', 5), ev(200, 4, '9', 6, 'XYKLiquidityMining.SharesDeposited')], storage, specs)
    await captureRange(0, 999, h, opts)
    expect(h.keyReads[0]).toEqual([{ pallet: 'omnipool', depositId: '7' }, { pallet: 'omnipool', depositId: '9' }, { pallet: 'xyk', depositId: '9' }])
    const again = await captureRange(0, 999, h, opts)
    expect(again).toMatchObject({ targets: 0, skipped: 4 })
  })

  it('reads no keys for a range without entry events, nor on a recapture', async () => {
    const h = harness([ev(100, 3, '7', 139)], storage, specs)
    await captureRange(300, 999, h, opts)
    await captureRange(0, 999, h, { ...opts, recapture: true })
    expect(h.keyReads).toEqual([])
  })
})

describe('reconcileLmEntries — the anchors loop repairs what the indexer could not read', () => {
  const specs = new Map([[99, 443], [100, 443], [199, 443], [200, 443], [299, 443], [300, 443]])
  const storage = (_spec: number, pallet: LmPallet, id: string) => (pallet === 'omnipool' && id === '7' ? SPEC_443_OMNIPOOL_DEPOSIT_77881 : undefined)
  const opts = { dryRun: false, concurrency: 2, limit: 100 }
  // The open set as the anti-join states it: a warning is open while its target has no row.
  function withWarnings(h: ReturnType<typeof harness>, warnings: OpenLmEntryWarning[], events: DepositEvent[], unparsed: UnparsedEntryEvent[] = []): LmReconcileSource & { calls: string[] } {
    const calls: string[] = []
    const has = (pallet: string, id: string, block: number) => h.table.some(r => r.pallet === pallet && r.deposit_id === id && r.block_height === block)
    return {
      calls,
      openWarnings: async limit => { calls.push('open'); return warnings.filter(w => { const [p, id] = w.sourceIndex.split(':'); return !has(p, id, w.blockHeight) }).slice(0, limit) },
      uncapturedBlocks: async limit => {
        calls.push('full')
        return [...new Set(captureTargets(events).filter(t => !has(t.pallet, t.depositId, t.blockHeight)).map(t => t.blockHeight))].slice(0, limit)
      },
      unparsedEntryEvents: async limit => { calls.push('unparsed'); return unparsed.slice(0, limit) },
    }
  }

  it('re-reads each block with an open warning and closes it by inserting its rows', async () => {
    const events = [ev(100, 3, '7', 139), ev(200, 1, '9', 5)]
    const h = harness(events, storage, specs)
    // Block 200 was captured in-block; block 100 failed there and left a warning.
    await captureRange(200, 200, h, { dryRun: false, recapture: false, concurrency: 1 })
    const src = withWarnings(h, [{ blockHeight: 100, sourceIndex: 'omnipool:7' }], events)
    const r = await reconcileLmEntries(src, h, opts)
    expect(r).toMatchObject({ openBefore: 1, uncapturedBlocks: 1, blocks: 1, rows: 1, failed: [], openAfter: 0, truncated: false })
    expect(h.table.filter(t => t.block_height === 100).map(t => [t.deposit_id, t.capture_status])).toEqual([['7', 'ok']])
    // A second pass finds nothing and reads nothing.
    const reads = h.reads.length
    expect(await reconcileLmEntries(src, h, opts)).toMatchObject({ openBefore: 0, uncapturedBlocks: 0, blocks: 0, rows: 0, openAfter: 0 })
    expect(h.reads.length).toBe(reads)
  })

  it('finds gaps no warning names through the full check', async () => {
    const events = [ev(100, 3, '7', 139), ev(300, 1, '9', 5)]
    const h = harness(events, storage, specs)
    const r = await reconcileLmEntries(withWarnings(h, [], events), h, opts)
    expect(r).toMatchObject({ openBefore: 0, uncapturedBlocks: 2, blocks: 2, rows: 2, gone: 1, openAfter: 0 })
    expect(h.table.map(t => [t.block_height, t.capture_status])).toEqual([[100, 'ok'], [300, 'gone_at_block_end']])
  })

  it('keeps a block that still cannot be read open without holding back the others, and repairs it once readable', async () => {
    const events = [ev(100, 3, '7', 139), ev(200, 1, '9', 5)]
    const h = harness(events, storage, specs)
    const src = withWarnings(h, [{ blockHeight: 100, sourceIndex: 'omnipool:7' }, { blockHeight: 200, sourceIndex: 'omnipool:9' }], events)
    h.failAt(100) // e.g. pruned state or a layout the decoder refuses: deterministic for the block
    const first = await reconcileLmEntries(src, h, opts)
    expect(first).toMatchObject({ openBefore: 2, blocks: 2, rows: 1, failed: [{ block: 100, reason: 'rpc down' }], openAfter: 1 })
    expect(first.failed).toHaveLength(1)
    h.failAt(null)
    expect(await reconcileLmEntries(src, h, opts)).toMatchObject({ openBefore: 1, blocks: 1, rows: 1, failed: [], openAfter: 0 })
  })

  it('writes nothing in a dry run and states no after-count', async () => {
    const events = [ev(100, 3, '7', 139)]
    const h = harness(events, storage, specs)
    const r = await reconcileLmEntries(withWarnings(h, [{ blockHeight: 100, sourceIndex: 'omnipool:7' }], events), h, { ...opts, dryRun: true })
    expect(r).toMatchObject({ openBefore: 1, blocks: 1, rows: 1, openAfter: null })
    expect(h.table).toEqual([])
  })

  it('reports a set that reached its cap as truncated', async () => {
    const events = [ev(100, 3, '7', 139), ev(200, 1, '9', 5), ev(300, 1, '9', 5)]
    const h = harness(events, storage, specs)
    const r = await reconcileLmEntries(withWarnings(h, [], events), h, { ...opts, limit: 2 })
    expect(r).toMatchObject({ uncapturedBlocks: 2, blocks: 2, truncated: true })
  })

  it('reports entry events with no decimal deposit id every pass instead of dropping them', async () => {
    const events = [ev(100, 3, '7', 139)]
    const h = harness(events, storage, specs)
    const bad: UnparsedEntryEvent[] = [{ blockHeight: 150, eventIndex: 2, pallet: 'omnipool', depositId: '' }]
    const src = withWarnings(h, [], events, bad)
    const r = await reconcileLmEntries(src, h, opts)
    // The readable gap is still repaired; the unreadable one is counted, never read.
    expect(r).toMatchObject({ uncapturedBlocks: 1, blocks: 1, rows: 1, unparsedDepositIds: 1, firstUnparsed: bad, truncated: false, openAfter: 0 })
    expect(src.calls).toContain('unparsed')
    expect(await reconcileLmEntries(src, h, opts)).toMatchObject({ blocks: 0, unparsedDepositIds: 1 })
    expect(await reconcileLmEntries(src, h, { ...opts, limit: 1 })).toMatchObject({ truncated: true })
  })

  it('lists the unparsed entry events as the complement of the full check, in one PREWHERE clause', () => {
    const ports = readFileSync(new URL('../../src/scripts/lmEntryPorts.ts', import.meta.url), 'utf8')
    const start = ports.indexOf('UNPARSED_ENTRY_EVENTS_SQL = `')
    const sql = ports.slice(start, ports.indexOf('`', start + 40))
    expect(sql).toContain("PREWHERE event_kind IN ('deposited', 'redeposited') AND NOT match(deposit_id, '^[0-9]+$')")
    expect(sql).not.toMatch(/(?<!PRE)WHERE/)
    const full = ports.slice(ports.indexOf('UNCAPTURED_TARGET_BLOCKS_SQL = `'), ports.indexOf('`', ports.indexOf('UNCAPTURED_TARGET_BLOCKS_SQL = `') + 40))
    expect(full).toContain("match(deposit_id, '^[0-9]+$')")
  })

  it('states the open set as the anti-join, in one PREWHERE clause', () => {
    expect(OPEN_LM_ENTRY_WARNINGS_SQL).toContain("PREWHERE parser = 'raw_lm_farm_entries' AND warning_code = 'lm_entry_capture_failed'")
    expect(OPEN_LM_ENTRY_WARNINGS_SQL).toContain('LEFT ANTI JOIN')
    expect(OPEN_LM_ENTRY_WARNINGS_SQL).not.toMatch(/(?<!PRE)WHERE/)
    const ports = readFileSync(new URL('../../src/scripts/lmEntryPorts.ts', import.meta.url), 'utf8')
    const full = ports.slice(ports.indexOf('UNCAPTURED_TARGET_BLOCKS_SQL = `'), ports.indexOf('`', ports.indexOf('UNCAPTURED_TARGET_BLOCKS_SQL = `') + 40))
    expect(full).toContain('LEFT ANTI JOIN')
    expect(full).not.toMatch(/(?<!PRE)WHERE/)
    expect(full).toContain('HAVING max(ingested_at) < now() - INTERVAL 1 HOUR')
  })
})

describe('chunks', () => {
  it('splits a range into bounded chunks', () => {
    expect(chunks(0, 250_000, 100_000)).toEqual([[0, 99_999], [100_000, 199_999], [200_000, 250_000]])
    expect(() => chunks(0, 1, 0)).toThrow()
  })
})
