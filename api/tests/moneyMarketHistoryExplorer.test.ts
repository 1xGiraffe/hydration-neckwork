import { describe, expect, it } from 'vitest'

// The explorer's /money-market-history sits on the value chart's grid, like its
// LP twin: priced on the chart's candles at every zoom, one point per day
// un-windowed, and — unlike the chart — still drawn for an EVM account whose
// balance history spans no range (it starts at the first money-market
// observation instead). Drives the real explorer path over a fake client.
describe('explorer money-market history', async () => {
  const { buildMoneyMarketHistory, CHART_PRICE_GRAIN, initExplorerService } = await import('../src/services/explorerService.ts')
  const { resetCacheForTests } = await import('../src/services/cache.ts')
  const H = 3_600
  const T0 = Date.UTC(2026, 8, 1) / 1000
  const HOURS = 72
  const H160 = `0x${'4a'.repeat(20)}`
  const EVM_ACC = `0x45544800${'4a'.repeat(20)}0000000000000000`
  const CORE = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
  const DOT = '0x0000000000000000000000000000000100000005'
  const heightAt = (sec: number) => 1000 + Math.floor((sec - T0) / 6)
  const RAY = 10n ** 27n
  let balanceRange: Record<string, number> = { minb: 1000, maxb: heightAt(T0 + HOURS * H) - 1, mint: T0, maxt: T0 + HOURS * H - 6 }
  let historyStart: Record<string, number> = { obs: heightAt(T0 + 5 * H), delta: 0, anchor: 0 }
  const seen: string[] = []
  const rows = (query: string, params: Record<string, unknown>): Array<Record<string, unknown>> => {
    if (query.includes('max(block_height) AS top')) {
      return Array.from({ length: HOURS }, (_, i) => ({ h: T0 + i * H, top: heightAt(T0 + i * H) + 599, at_mark: heightAt(T0 + i * H), top_ts: T0 + i * H + 3_594 }))
    }
    if (query.includes('min(block_height) AS minb, max(block_height) AS maxb')) return [balanceRange]
    if (query.includes('-- mm:history-start')) return [historyStart]
    if (query.includes('-- mm:reserve-map')) return [{ asset_address: DOT, atoken: 'a5', vdebt: 'd5', pool_proxy: CORE, market_key: 'core' }]
    if (query.includes('-- mm:anchor-block')) return [{ b0: 900 }]
    if (query.includes('-- mm:scaled-anchor')) return [{ holder: H160, contract: 'a5', scaled: '1000000000000' }]
    if (query.includes('-- mm:reserve-indices\n')) return [{ pool: CORE, reserve: DOT, b: -1, liq: String(RAY), vbi: String(RAY), blk: 950, ev: 1, ts: T0 - 300 }]
    if (query.includes('-- mm:reserve-rates\n')) return [{ pool: CORE, reserve: DOT, b: -1, liq_rate: '0', vb_rate: '0', blk: 950, ev: 1 }]
    if (query.includes('-- mm:reserve-update-phase')) return [{ block_height: 950, event_index: 1, init: 0 }]
    if (query.includes('-- mm:block-times')) return (params.hs as number[]).map(h => ({ block_height: h, t: T0 + (h - 1000) * 6 }))
    if (query.includes('-- lp:bucket-closes')) return [{ asset_id: 5, closed_at: T0, px: '2' }]
    if (query.includes('-- mm:incentive-claims-total')) return [{ reward: DOT, ts: T0 + 2 * H, amount: '3000000000000' }]
    if (query.includes('-- mm:incentive-programmes')) return [{ asset: 'a5', reward: DOT }]
    if (query.includes('-- mm:incentive-claim-closes')) return [{ asset_id: 5, closed_at: T0 + H, px: '2' }]
    return []
  }
  initExplorerService({
    query: async (o: { query: string; query_params?: Record<string, unknown> }) => { seen.push(o.query); return { json: async () => rows(o.query, o.query_params ?? {}) } },
  } as never)

  it('prices on the chart\'s grain and keeps the last bucket of each day un-windowed', async () => {
    resetCacheForTests()
    seen.length = 0
    const full = await buildMoneyMarketHistory([EVM_ACC])
    expect(full.priceGrain).toBe(CHART_PRICE_GRAIN)
    const closes = seen.filter(q => q.includes('-- lp:bucket-closes'))
    expect(closes).toHaveLength(1)
    expect(closes[0]).toContain('price_data.ohlc_1d')
    expect(full.dates.map(d => d.slice(0, 10))).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(full.reserveHistoryFrom).toMatchObject({ blockHeight: 900 })
    expect(full.suppliedUsd).toEqual([2, 2, 2])
    const [core] = full.markets
    expect(core).toMatchObject({ marketKey: 'core', market: 'Money Market', role: 'primary', stakingBacked: false })
    expect(core.reserves[0].asset.assetId).toBe(5)
    expect(core.reserves[0].points.map(p => p.i)).toEqual([0, 1, 2])
    expect(core.reserves[0].points[0]).toMatchObject({ supplied: '1000000000000', suppliedUsd: 2, collateral: null })
    // Interest on a flat index is zero, rendered once; claimed incentives are filed under
    // the reward's market and valued at the hour closed by the claim.
    expect(core.reserves[0].points[2]).toMatchObject({ interestEarned: '0', interestPaid: '0', interestEarnedUsd: 0, interestPaidUsd: 0, interestIncomplete: false })
    expect(core.reserves[0].interest).toEqual({ interestEarned: '0', interestPaid: '0', interestEarnedUsd: 0, interestPaidUsd: 0, interestIncomplete: false })
    expect(core.points[2]).toMatchObject({ interestEarnedUsd: 0, interestPaidUsd: 0, interestUnpriced: 0 })
    expect(core).toMatchObject({ interestEarnedUsd: 0, interestPaidUsd: 0, interestUnpriced: 0 })
    expect(core.claimedIncentives).toEqual([{ asset: expect.objectContaining({ assetId: 5 }), amount: '3000000000000', valueUsd: 6, claims: 1, unpricedClaims: 0 }])
  })

  it('starts an EVM account without a balance range at its first observation', async () => {
    resetCacheForTests()
    balanceRange = { minb: 0, maxb: 0, mint: 0, maxt: 0 }
    try {
      const full = await buildMoneyMarketHistory([EVM_ACC])
      expect(full.dates.length).toBeGreaterThan(0)
      expect(full.markets.map(m => m.marketKey)).toEqual(['core'])
    } finally {
      balanceRange = { minb: 1000, maxb: heightAt(T0 + HOURS * H) - 1, mint: T0, maxt: T0 + HOURS * H - 6 }
    }
  })

  it('starts an aToken-only holder (no observation, no balance range) at its first scaled delta', async () => {
    resetCacheForTests()
    balanceRange = { minb: 0, maxb: 0, mint: 0, maxt: 0 }
    historyStart = { obs: 0, delta: heightAt(T0 + 30 * H), anchor: 0 }
    seen.length = 0
    try {
      const full = await buildMoneyMarketHistory([EVM_ACC])
      // The range opens at the delta's day, not at an observation that never happened.
      expect(full.dates[0].slice(0, 10)).toBe('2026-09-02')
      expect(full.markets.map(m => m.marketKey)).toEqual(['core'])
      const start = seen.find(q => q.includes('-- mm:history-start'))!
      expect(start).toContain('price_data.atoken_scaled_deltas')
      expect(start).toContain('price_data.atoken_scaled_anchor')
    } finally {
      balanceRange = { minb: 1000, maxb: heightAt(T0 + HOURS * H) - 1, mint: T0, maxt: T0 + HOURS * H - 6 }
      historyStart = { obs: heightAt(T0 + 5 * H), delta: 0, anchor: 0 }
    }
  })
})

// The un-windowed LP and money-market histories end at the head's own point under a
// head-less key, so they revalidate in the background after a minute instead of
// freezing the head point for the 30-minute TTL; a zoom window (a block range)
// takes the bucketed-history finality rule, and the value chart (/history, whose last point is
// pinned live) is untouched.
describe('un-windowed history caching', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  it('serves both `all` keys stale-while-revalidate, fresh for a minute', () => {
    expect(src).toContain('const UNWINDOWED_HISTORY_FRESH_MS = 60_000')
    expect(src).toContain('if (!window) return cachedSwr(key, UNWINDOWED_HISTORY_FRESH_MS, ACCOUNT_HISTORY_TTL_MS, () => buildLiquidityHistory(accounts))')
    expect(src).toContain('if (!window) return cachedSwr(key, UNWINDOWED_HISTORY_FRESH_MS, ACCOUNT_HISTORY_TTL_MS, () => buildMoneyMarketHistory(accounts, undefined, owner))')
    // A chart-zoom window takes the bucketed-history finality rule instead.
    expect(src).toContain('return cached(key, await windowedHistoryTtlMs(window.toBlock), () => buildLiquidityHistory(accounts, window))')
    expect(src).toContain('return cached(key, ACCOUNT_HISTORY_TTL_MS, () => getAccountHistory(accounts))')
  })
})

describe('moneyMarketIdentities', async () => {
  const { moneyMarketIdentities } = await import('../src/services/explorerService.ts')
  const SUB = `0x${'ab'.repeat(32)}`
  const BOUND = `0x${'cd'.repeat(20)}`
  const BOUND_ACC = `0x45544800${'cd'.repeat(20)}0000000000000000`
  it('is every member\'s H160 (ETH-form, else the first 20 bytes) plus the primary, sorted', () => {
    expect(moneyMarketIdentities([SUB, BOUND_ACC.toUpperCase().replace('0X', '0x'), 'junk'])).toEqual({ h160s: [`0x${'ab'.repeat(20)}`, BOUND].sort(), primary: null })
  })
  it('names the primary: the bound EVM address, else the account\'s own first-20-byte H160', () => {
    expect(moneyMarketIdentities([SUB], { accountId: SUB, evmAddress: BOUND.toUpperCase().replace('0X', '0x') })).toEqual({ h160s: [`0x${'ab'.repeat(20)}`, BOUND].sort(), primary: BOUND })
    expect(moneyMarketIdentities([SUB, BOUND_ACC], { accountId: SUB, evmAddress: null }).primary).toBe(`0x${'ab'.repeat(20)}`)
  })
})
