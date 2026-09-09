import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ICE_LAUNCH_BLOCK, bpQuantiles, foldFills, foldMigration, latestGovernanceStatus, priceVsLimitBp, type GovernanceEventRow, type MigrationRow } from '../src/services/iceService.ts'

const iceService = readFileSync(new URL('../src/services/iceService.ts', import.meta.url), 'utf8')

const row = (event_name: string, args: unknown, block_height: number): GovernanceEventRow =>
  ({ event_name, args_json: JSON.stringify(args), block_height })

describe('latestGovernanceStatus', () => {
  it('answers the runtime-443 defaults when no governance event exists', () => {
    expect(latestGovernanceStatus([])).toEqual({
      solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: ICE_LAUNCH_BLOCK,
    })
  })

  it('takes the latest value of each kind, leaving the others at their defaults', () => {
    const rows = [
      row('ICE.SolverModeSet', { mode: { __kind: 'Passthrough' } }, 14_400_000),
      row('ICE.ProtocolFeeSet', { fee: 150 }, 14_400_010),
      row('ICE.SolverModeSet', { mode: { __kind: 'Disabled' } }, 14_400_020),
    ]
    expect(latestGovernanceStatus(rows)).toEqual({
      solverMode: 'Disabled', protocolFeePpm: 150, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: 14_400_020,
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
      uniswapV3: { factory: '0xaa', swapRouter: '0xbb', quoter: '0xcc' }, asOfBlock: 14_400_100,
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
      solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: ICE_LAUNCH_BLOCK,
    })
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

// The first day of the venue (2026-09-09, 51 solutions): the dashboard reported
// $112,582 "routed" against $16,577 of fills. Every hop of a route has an `in` leg
// on the pot's projection — 247 legs over 54 routes — so a 4-hop route (USDT →
// aUSDT → HOLLAR → H2O → aDOT) was counted four times, hub and intermediates
// included. Routed is what each ROUTE took in, once: the per-asset net of its legs.
describe('foldFills', () => {
  const days = ['2026-09-09']
  const solutions = new Map([['2026-09-09', 3]])
  // Intent #34's three DCA trades (14402274/96/317): 3 × 190218680 aUSDC in, valued
  // $570.60 off the fills' legs; the pot routed the same 570656040 aUSDC, valued
  // $570.36 off its input leg.
  const fills = [{ hour: '2026-09-09 12:00:00', day: '2026-09-09', a_in: 1003, a_out: 1000766, fills: '3', sum_in: '570656040', sum_out: '569735289', block: 14402317, valueUsd: 570.597636 }]
  const routed = [{ hour: '2026-09-09 12:00:00', day: '2026-09-09', asset_id: 1003, sum_in: '570656040', block: 14402317, valueUsd: 570.363313 }]

  it('reports the fills once, the routes once, and no matched volume on a fully routed day', () => {
    expect(foldFills(fills, routed, solutions, days)).toEqual([
      { day: '2026-09-09', fills: 3, solutions: 3, usd: 570.597636, matchedUsd: 0, routedUsd: 570.363313 },
    ])
  })

  it('reads matched volume from the raw shortfall of the routes, priced like the fills', () => {
    // 60 aUSDC more filled than routed → $60 at the fills' $1.0000 per aUSDC (570.597636 / 570.656040).
    const more = [{ ...fills[0], sum_in: '630656040', valueUsd: 630.597636 }]
    const [day] = foldFills(more, routed, solutions, days)
    expect(day.matchedUsd).toBeCloseTo(60_000_000 * (630.597636 / 630_656_040), 6)
    expect(day.routedUsd).toBe(570.363313)
  })

  it('never reads a valuation gap between the two legs as matched volume', () => {
    // Same raw amounts, routed valued higher than the fills: still zero, not clamped noise.
    const [day] = foldFills(fills, [{ ...routed[0], valueUsd: 571.9 }], solutions, days)
    expect(day.matchedUsd).toBe(0)
  })

  it('grids every requested day, empty ones at zero', () => {
    expect(foldFills([], [], new Map(), ['2026-09-08', '2026-09-09'])).toEqual([
      { day: '2026-09-08', fills: 0, solutions: 0, usd: 0, matchedUsd: 0, routedUsd: 0 },
      { day: '2026-09-09', fills: 0, solutions: 0, usd: 0, matchedUsd: 0, routedUsd: 0 },
    ])
  })
})

describe('routed and fill reads', () => {
  it('nets each route per asset on its op_key and keeps the positive side only', () => {
    expect(iceService).toContain('GROUP BY block_height, op_key, asset_id')
    expect(iceService).toContain("greatest(toInt256(sumIf(toUInt256OrZero(amount), leg_kind = 'in')) - toInt256(sumIf(toUInt256OrZero(amount), leg_kind = 'out')), toInt256(0)) AS net_in")
    expect(iceService).toContain('WHERE net_in > 0')
    // Never the bare per-hop sum again.
    expect(iceService).not.toMatch(/leg_kind = 'in'\n\s+GROUP BY hour, day, asset_id/)
  })
  it("counts a DCA intent's completing trade as a fill, with the settlement reader's amounts", () => {
    expect(iceService).toContain("event_name = '${DCA_COMPLETED_EVENT}'")
    expect(iceService).toContain('buckets.push(...await loadCompletionFills())')
    expect(iceService).toContain('iceSettlementsFor(rows, await getIntentOrders(rows.map(r => r.intent_id)))')
  })
})

// The dashboard's reads run against the live ClickHouse: every one must carry a
// block or time bound and the per-query resource caps the brief mandates.
describe('iceService reads', () => {
  const statements = iceService.split(/query:\s*`/).slice(1).map(s => s.split('`')[0])
  it('bounds and caps every statement', () => {
    expect(statements.length).toBeGreaterThanOrEqual(8)
    for (const sql of statements) {
      expect(sql, sql).toMatch(/block_height >= \{launch:UInt32\}|account_id = \{|id NOT IN/)
      expect(sql, sql).toContain('SETTINGS max_memory_usage=')
      expect(sql, sql).toContain('max_threads=')
      expect(sql, sql).not.toMatch(/PREWHERE[\s\S]*WHERE/)
    }
  })
  it('deduplicates the replaceable tables before summing over them', () => {
    expect(iceService).toContain('price_data.intent_orders FINAL')
    expect(iceService).toContain('price_data.intent_events FINAL')
    expect(iceService).toContain('price_data.dca_events FINAL')
    expect(iceService).toContain('price_data.revenue_events FINAL')
    expect(iceService).toContain('price_data.pool_swap_legs_by_account FINAL')
  })
  it('caches the model stale-while-revalidate under the agreed key', () => {
    expect(iceService).toContain("cachedSwr('explorer:ice-dashboard:model', 300_000, 48 * 3_600_000")
  })
  it("reads the fee stream Task 8 writes", () => {
    expect(iceService).toContain("stream = 'ice_matched_fee'")
  })
  it('classifies a limit order as anything that is not a DCA intent, like the feed', () => {
    expect(iceService).not.toContain("kind = 'swap'")
    expect(iceService).toContain("kind != 'dca'")
  })
  it('is handed its client at boot rather than opening a pool of its own', () => {
    expect(iceService).not.toContain('createClickHouseClient')
    expect(iceService).toContain('export function initIceService(c: ClickHouseClient)')
  })
})
