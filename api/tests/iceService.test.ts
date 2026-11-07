import { describe, expect, it } from 'vitest'
import {
  ICE_LAUNCH_BLOCK, IMMEDIATE_FILL_BLOCKS, bpQuantiles, completionIn, foldDays, foldMigration, foldQuality, foldWindow, initIceService,
  latestGovernanceStatus, loadFeePerDay, matchedPerSolution, openBookSummary, priceVsLimitBp, routingTargetOf, secondsPerBlock,
  type BpSampleRow, type DayRange, type GovernanceEventRow, type MigrationRow, type SolutionFill, type SolutionRoute,
} from '../src/services/iceService.ts'
import type { ActiveDca, OpenLimitOrder, PriceInfo } from '../src/services/explorerService.ts'

const row = (event_name: string, args: unknown, block_height: number): GovernanceEventRow =>
  ({ event_name, args_json: JSON.stringify(args), block_height })

describe('latestGovernanceStatus', () => {
  it('answers the runtime-443 defaults when no governance event exists', () => {
    expect(latestGovernanceStatus([])).toEqual({
      solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: ICE_LAUNCH_BLOCK, routing: [],
    })
  })

  it('takes the latest value of each kind, leaving the others at their defaults', () => {
    const rows = [
      row('ICE.SolverModeSet', { mode: { __kind: 'Passthrough' } }, 14_400_000),
      row('ICE.ProtocolFeeSet', { fee: 150 }, 14_400_010),
      row('ICE.SolverModeSet', { mode: { __kind: 'Disabled' } }, 14_400_020),
    ]
    expect(latestGovernanceStatus(rows)).toEqual({
      solverMode: 'Disabled', protocolFeePpm: 150, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: 14_400_020, routing: [],
    })
  })

  it('folds the migration switch and the Uniswap v3 addresses', () => {
    const rows = [
      row('DCA.MigrationEnabledSet', { enabled: true }, 14_400_000),
      row('Parameters.UniswapV3AddressesSet', { factory: '0xaa', swapRouter: '0xbb', quoter: '0xcc' }, 14_400_005),
      row('DCA.MigrationEnabledSet', { enabled: false }, 14_400_100),
    ]
    expect(latestGovernanceStatus(rows)).toEqual({
      solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false,
      uniswapV3: { factory: '0xaa', swapRouter: '0xbb', quoter: '0xcc' }, asOfBlock: 14_400_100, routing: [],
    })
  })

  it('ignores a malformed row rather than adopting a value it cannot read', () => {
    const rows = [
      row('ICE.SolverModeSet', { mode: { __kind: 'Turbo' } }, 14_400_000),
      row('ICE.ProtocolFeeSet', { fee: 'lots' }, 14_400_001),
      row('Parameters.UniswapV3AddressesSet', { factory: '0xaa' }, 14_400_002),
      { event_name: 'ICE.ProtocolFeeSet', args_json: 'not json', block_height: 14_400_003 },
    ]
    expect(latestGovernanceStatus(rows)).toEqual({
      solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: ICE_LAUNCH_BLOCK, routing: [],
    })
  })
})

// ICE.RoutingUpdated (runtime 447): SolverRouting is a map keyed by the target, so
// the newest update of a target is its state and `state: None` removes it. Shapes
// as the indexer stored them on chain (blocks 15,141,465 – 16,501,446).
describe('the solver routing overrides', () => {
  it('reads every target kind the pallet defines', () => {
    expect(routingTargetOf({ __kind: 'AaveWrap', value: [1001356, 1012] })).toEqual({ kind: 'AaveWrap', assets: [[1001356, 1012]], contracts: [] })
    expect(routingTargetOf({ __kind: 'AaveWraps', value: [[5, 1001], [10, 1002]] })).toEqual({ kind: 'AaveWraps', assets: [[5, 1001], [10, 1002]], contracts: [] })
    expect(routingTargetOf({ __kind: 'StableswapPool', value: 100 })).toEqual({ kind: 'StableswapPool', assets: [[100]], contracts: [] })
    expect(routingTargetOf({ __kind: 'OmnipoolAsset', value: '5' })).toEqual({ kind: 'OmnipoolAsset', assets: [[5]], contracts: [] })
    expect(routingTargetOf({ __kind: 'XykPool', value: [5, 10] })).toEqual({ kind: 'XykPool', assets: [[5, 10]], contracts: [] })
    expect(routingTargetOf({ __kind: 'UniswapV3Pool', value: '0x5C6208a3c316a801f8996750aa7b6f45fc988548' })).toEqual({ kind: 'UniswapV3Pool', assets: [], contracts: ['0x5c6208a3c316a801f8996750aa7b6f45fc988548'] })
    expect(routingTargetOf({ __kind: 'UniswapV3Pools', value: ['0xaa', '0xbb'] })).toEqual({ kind: 'UniswapV3Pools', assets: [], contracts: ['0xaa', '0xbb'] })
  })
  it('refuses a payload it cannot read rather than guessing', () => {
    expect(routingTargetOf({ __kind: 'AaveWrap', value: [5] })).toBeNull()
    expect(routingTargetOf({ __kind: 'Teleport', value: 1 })).toBeNull()
    expect(routingTargetOf(null)).toBeNull()
  })
  it('keeps the newest state per target, drops a removed one, and lists newest first', () => {
    const rows = [
      row('ICE.RoutingUpdated', { target: { __kind: 'StableswapPool', value: 100 }, state: { __kind: 'Included' } }, 15_000_000),
      row('ICE.RoutingUpdated', { target: { __kind: 'AaveWrap', value: [23, 1023] }, state: { __kind: 'Included' } }, 15_000_001),
      row('ICE.RoutingUpdated', { target: { __kind: 'StableswapPool', value: 100 }, state: { __kind: 'Excluded' } }, 15_891_816),
      row('ICE.RoutingUpdated', { target: { __kind: 'UniswapV3Pool', value: '0xaa' }, state: { __kind: 'Included' } }, 15_900_000),
      row('ICE.RoutingUpdated', { target: { __kind: 'UniswapV3Pool', value: '0xaa' }, state: null }, 15_900_005),
    ]
    const status = latestGovernanceStatus(rows)
    expect(status.routing).toEqual([
      { kind: 'StableswapPool', assets: [[100]], contracts: [], state: 'Excluded', block: 15_891_816 },
      { kind: 'AaveWrap', assets: [[23, 1023]], contracts: [], state: 'Included', block: 15_000_001 },
    ])
    expect(status.asOfBlock).toBe(15_900_005)
  })
})

describe('priceVsLimitBp', () => {
  const limit = { amountIn: '1000000000000', amountOut: '5000000' }   // 100 DOT for ≥ 5 USDT → 0.05 USDT per DOT
  it('is zero when the fill lands exactly on the limit', () => {
    expect(priceVsLimitBp(limit, { amountIn: '1000000000000', amountOut: '5000000' })).toBe(0)
    expect(priceVsLimitBp(limit, { amountIn: '500000000000', amountOut: '2500000' })).toBe(0)
  })
  it('is positive when the fill pays more per unit sold than the limit asked', () => {
    // 1% more out for the same in → +100 bp
    expect(priceVsLimitBp(limit, { amountIn: '1000000000000', amountOut: '5050000' })).toBe(100)
  })
  it('is negative when the fill pays less than the limit (a partial with a worse ratio)', () => {
    expect(priceVsLimitBp(limit, { amountIn: '1000000000000', amountOut: '4975000' })).toBe(-50)
  })
  it('keeps a tenth of a basis point and never rounds through a float', () => {
    // 2^100 in, 2^100 + 2^90 out vs a 1:1 limit → +1/1024 → 9.765… bp, truncated to 9.7
    const big = (1n << 100n).toString()
    const bigger = ((1n << 100n) + (1n << 90n)).toString()
    expect(priceVsLimitBp({ amountIn: big, amountOut: big }, { amountIn: big, amountOut: bigger })).toBe(9.7)
  })
  it('is null on a zero or malformed amount', () => {
    expect(priceVsLimitBp(limit, { amountIn: '0', amountOut: '5000000' })).toBeNull()
    // A fill that paid nothing out is not a price; it must not sit at −10,000 bp.
    expect(priceVsLimitBp(limit, { amountIn: '1000000000000', amountOut: '0' })).toBeNull()
    expect(priceVsLimitBp({ amountIn: '1', amountOut: '0' }, { amountIn: '1', amountOut: '1' })).toBeNull()
    expect(priceVsLimitBp(limit, { amountIn: '', amountOut: '1' })).toBeNull()
    expect(priceVsLimitBp(limit, { amountIn: 'null', amountOut: '1' })).toBeNull()
  })
})

describe('foldMigration', () => {
  const days = ['2026-09-08', '2026-09-09']
  const rows: MigrationRow[] = [
    // A dataless variant serialises as a bare JSON string …
    { day: '2026-09-08', event_name: 'DCA.MigrationCancelled', reason_raw: '"BuyOrder"', n: '2' },
    // … a variant with data as an object with its kind.
    { day: '2026-09-09', event_name: 'DCA.MigrationCancelled', reason_raw: '{"__kind":"IntentCreationFailed","value":{"index":21,"error":"0x03000000"}}', n: '1' },
    { day: '2026-09-09', event_name: 'DCA.MigrationCancelled', reason_raw: '"BuyOrder"', n: '3' },
    { day: '2026-09-08', event_name: 'DCA.Migrated', reason_raw: '', n: '12' },
  ]
  it('decodes both reason shapes and counts migrated against cancelled per day', () => {
    expect(foldMigration(rows, 40, days)).toEqual({
      migrated: 12, cancelled: 6, remainingSchedules: 40,
      byReason: [{ reason: 'BuyOrder', count: 5 }, { reason: 'IntentCreationFailed', count: 1 }],
      perDay: [{ day: '2026-09-08', migrated: 12, cancelled: 2 }, { day: '2026-09-09', migrated: 0, cancelled: 4 }],
    })
  })
  it('keeps a count whose reason is missing or unreadable, as the shared decoder reads it', () => {
    // No reason at all is 'Unknown'; text that is not JSON passes through verbatim
    // (dcaMigrationReason's contract) — either way the schedule stays counted.
    const cancelled = (reason_raw: string) => foldMigration([{ day: '2026-09-08', event_name: 'DCA.MigrationCancelled', reason_raw, n: '1' }], 0, days).byReason
    expect(cancelled('')).toEqual([{ reason: 'Unknown', count: 1 }])
    expect(cancelled('not json')).toEqual([{ reason: 'not json', count: 1 }])
  })
})

describe('bpQuantiles', () => {
  it('is all-null without a sample', () => {
    expect(bpQuantiles([])).toEqual({ p10: null, p50: null, p90: null })
  })
  it('reads the nearest-rank deciles of the sorted sample', () => {
    expect(bpQuantiles([5, -3, 0, 12, 7, 1, -1, 3, 9, 2])).toEqual({ p10: -3, p50: 2, p90: 9 })
    expect(bpQuantiles([4])).toEqual({ p10: 4, p50: 4, p90: 4 })
  })
})

// A stand-in for the shared event-time valuation: every leg is worth one dollar per
// raw unit at its block, except an asset the test leaves unpriced.
// It records the blocks it was asked to price at, so a test can see that a row is
// valued at its own solution's block.
function fakeValue(unpriced: ReadonlySet<number> = new Set()) {
  const blocks: number[] = []
  const value = async <T extends object>(rows: T[], pick: (r: T) => { block: number; legs: { assetId: number; decimals: number; raw: string }[] } | null) => {
    for (const row of rows) {
      const p = pick(row)
      if (!p) continue
      blocks.push(p.block)
      const leg = p.legs.find(l => !unpriced.has(l.assetId))
      ;(row as { valueUsd: number | null }).valueUsd = leg ? Number(leg.raw) : null
    }
  }
  return { value, blocks }
}

// Two solutions on one day: the first routes 300 DOT with nothing matched, the
// second matches 200 DOT and routes nothing. The pallet charges its fee on the
// second (matched_X per solution, floored at zero); a per-day netting would set the
// 200 DOT of the second against the first's routes and find no matched volume.
const DOT = 5, USDT = 10
const fill = (block: number, amountIn: string | null, amountOut: string | null = '1', owner = 'a'): SolutionFill => ({ block, owner, assetIn: DOT, assetOut: USDT, amountIn, amountOut })
const twoSolutions = {
  fills: [fill(100, '100'), fill(200, '200', '1', 'b')],
  routes: [{ block: 100, assetId: DOT, netIn: '300' }] as SolutionRoute[],
}

describe('matchedPerSolution', () => {
  it('nets each solution on its own, as the pallet does', () => {
    expect(matchedPerSolution(twoSolutions.fills, twoSolutions.routes)).toEqual([{ block: 200, assetId: DOT, matched: 200n }])
  })
  it('floors a solution that routed more than its intents put in at zero', () => {
    expect(matchedPerSolution([fill(1, '50')], [{ block: 1, assetId: DOT, netIn: '80' }])).toEqual([])
  })
  it('sums every intent of a solution in one asset before netting', () => {
    expect(matchedPerSolution([fill(1, '50'), fill(1, '70', '1', 'b')], [{ block: 1, assetId: DOT, netIn: '100' }])).toEqual([{ block: 1, assetId: DOT, matched: 20n }])
  })
  it('keeps 128-bit amounts exact', () => {
    const big = (1n << 100n) + 7n
    expect(matchedPerSolution([fill(1, big.toString())], [{ block: 1, assetId: DOT, netIn: '7' }])[0].matched).toBe(1n << 100n)
  })
})

describe('completionIn — the final DCA trade the Intent events state no amount for', () => {
  it('spends the per-trade amount when the budget left covers it', () => {
    expect(completionIn({ amountIn: '100', budget: '1000' }, '150')).toBe('100')
  })
  it('spends the remainder when the budget left is short of one trade', () => {
    expect(completionIn({ amountIn: '250000000000000', budget: '1000000000000000' }, '10416666666668')).toBe('10416666666668')
  })
  it('falls back to the budget when no trade preceded it, and to one trade for a rolling intent', () => {
    expect(completionIn({ amountIn: '100', budget: '60' }, undefined)).toBe('60')
    expect(completionIn({ amountIn: '100', budget: '' }, null)).toBe('100')
  })
})

const ranges: DayRange[] = [
  { day: '2026-10-22', lo: 1, hi: 150, closed: true },
  { day: '2026-10-23', lo: 151, hi: 300, closed: false },
]

describe('foldDays', () => {
  it('values every row at its own solution block and files it under that block\'s day', async () => {
    const { value, blocks } = fakeValue()
    const [d1, d2] = await foldDays(ranges, twoSolutions.fills, twoSolutions.routes, [100, 200], value)
    expect(new Set(blocks)).toEqual(new Set([100, 200]))
    expect(d1).toMatchObject({ day: '2026-10-22', fills: 1, solutions: 1, matchedUsd: 0, routedUsd: 300 })
    expect(d2).toMatchObject({ day: '2026-10-23', fills: 1, solutions: 1, matchedUsd: 200, routedUsd: 0 })
    expect([...d2.owners]).toEqual([['b', { fills: 1, usd: 200 }]])
  })
  it('counts a fill it cannot value and keeps it out of every dollar sum', async () => {
    const { value } = fakeValue(new Set([DOT, USDT]))
    const [d1] = await foldDays(ranges, [fill(10, '5'), fill(11, null, null)], [], [10, 11], value)
    expect(d1).toMatchObject({ fills: 2, unpriced: 2, usd: 0 })
  })
})

describe('foldWindow', () => {
  it('rolls the days up, ranks traders and pairs, and snaps sub-cent residue to zero', async () => {
    const { value } = fakeValue()
    const facts = await foldDays(ranges, twoSolutions.fills, twoSolutions.routes, [100, 200], value)
    const w = foldWindow(['2026-10-21', '2026-10-22', '2026-10-23'], facts)
    expect(w.series.map(d => d.day)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23'])
    expect(w.series[0]).toEqual({ day: '2026-10-21', fills: 0, solutions: 0, usd: 0, matchedUsd: 0, routedUsd: 0 })
    expect(w.series[2].matchedUsd).toBe(200)
    expect(w.traders).toBe(2)
    expect(w.topPairs).toEqual([{ assetIn: DOT, assetOut: USDT, fills: 2, usd: 300 }])
    const residue = foldWindow(['2026-10-22'], [{ ...facts[0], matchedUsd: 2.39e-14, routedUsd: 0.004 }])
    expect(residue.series[0]).toMatchObject({ matchedUsd: 0, routedUsd: 0 })
  })
})

describe('foldQuality', () => {
  const row = (fill_out: string, blocks_after: number): BpSampleRow => ({ fill_in: '100', fill_out, limit_in: '100', limit_out: '100', blocks_after })
  it('splits price vs limit between market-style fills and resting orders', () => {
    const q = foldQuality(undefined, null, [row('101', 1), row('101', IMMEDIATE_FILL_BLOCKS), row('100', IMMEDIATE_FILL_BLOCKS + 1)])
    expect(q.priceVsLimitBpImmediate).toEqual({ p10: 100, p50: 100, p90: 100, fills: 2 })
    expect(q.priceVsLimitBpResting).toEqual({ p10: 0, p50: 0, p90: 0, fills: 1 })
    expect(q.priceVsLimitBp.p50).toBe(100)
  })
  it('states time to fill in blocks and, at the window\'s pace, in seconds', () => {
    const q = foldQuality({ closed: '10', filled: '8', cancelled: '1', expired: '1', filled_partially: '2', median_blocks: '1' }, 2.15, [])
    expect(q).toMatchObject({ medianBlocksToFill: 1, medianTimeToFillSec: 2.2, partialShare: 0.25, cancelRate: 0.1, expiryRate: 0.1 })
  })
  it('reads the pace from the window\'s first block to the head', () => {
    expect(secondsPerBlock(ranges, 1_000, 1_598)).toBe(2)
    expect(secondsPerBlock([], 0, 10)).toBeNull()
  })
})

describe('openBookSummary', () => {
  const asset = (assetId: number, decimals = 10) => ({ assetId, symbol: `A${assetId}`, name: null, decimals, parachainId: null })
  const prices = new Map<number, PriceInfo>([[DOT, { price: 4 } as PriceInfo]])
  const limit = (remainingIn: string) => ({ intentId: remainingIn, assetIn: asset(DOT), remainingIn }) as unknown as OpenLimitOrder
  const dca = (intentId: string, assetId = DOT) => ({ intentId, assetIn: asset(assetId) }) as unknown as ActiveDca
  it('holds a limit order\'s unfilled rest and a DCA intent\'s remaining budget, per asset', () => {
    const s = openBookSummary([limit('20000000000'), limit('5000000000')], [dca('9'), dca('8', USDT)], new Map([['9', '10000000000'], ['8', '3']]), prices)
    expect(s).toMatchObject({ total: 4, limit: 2, dca: 2 })
    expect(s.byAsset.map(r => [r.asset.assetId, r.reserved, r.orders])).toEqual([[DOT, '35000000000', 3], [USDT, '3', 1]])
  })
})

// The fee: the published hours up to the stream's own cold mark, the raw tail past it.
describe('loadFeePerDay', () => {
  it('reads the ICE stream\'s own mark and splits the two arms there, summing both per day', async () => {
    const seen: { query: string; params: Record<string, unknown> }[] = []
    initIceService({
      query: async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => {
        seen.push({ query, params: query_params })
        const rows = query.includes('-- ice:fee-mark') ? [{ mark: '2026-11-07 07:04:12', n: '22' }]
          : query.includes('-- ice:fee-cold') ? [{ day: '2026-11-07', usd: 4 }]
            : query.includes('-- ice:fee-tail') ? [{ day: '2026-11-07', usd: 0.5 }, { day: '2026-11-08', usd: 1 }] : []
        return { json: async () => rows }
      },
    } as never)
    const out = await loadFeePerDay('2026-10-09 00:00:00', Date.parse('2026-11-07T10:30:00Z') / 1000)
    expect([...out]).toEqual([['2026-11-07', 4.5], ['2026-11-08', 1]])
    const mark = seen.find(s => s.query.includes('-- ice:fee-mark'))!
    expect(mark.params).toMatchObject({ stream: 'ice_matched_fee' })
    const cold = seen.find(s => s.query.includes('-- ice:fee-cold'))!
    const tail = seen.find(s => s.query.includes('-- ice:fee-tail'))!
    expect(cold.params.mark).toBe('2026-11-07 07:04:12')
    expect(tail.params.mark).toBe('2026-11-07 07:04:12')
    // The raw arm reaches back to the mark (with an hour of slack), not 26 hours.
    expect(tail.params.hours).toBe(5)
  })
})
