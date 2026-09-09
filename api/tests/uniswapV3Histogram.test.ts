import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCacheForTests } from '../src/services/cache.ts'
import { initExplorerService, getDailyActivity, v3HistogramTokenArm, V3_HISTOGRAM_NAMES, v3LiquidityHistogramNames } from '../src/services/explorerService.ts'
import { initUniswapV3Service } from '../src/services/uniswapV3Service.ts'

// The daily-activity bars read activity_histogram_events, which uniswap_v3_histogram_mv
// (010) feeds for the concentrated-liquidity venue. The reader must name those rows
// under the same tabs and actions the list classifies them into, and resolve a token
// filter for them through the pool (they carry no asset_refs) — or the chart stays
// empty while the list shows the rows.

const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
const VAULT = '0xa206d0959813f17c17c87147271c49065438648a'
// Precompile token addresses so the registry resolves them without a money-market map.
const DOT = '0x0000000000000000000000000000000100000005'
const HOLLAR = '0x00000000000000000000000000000001000000de'

function recordingClient(rowsFor: (query: string) => unknown[] = () => []) {
  const queries: string[] = []
  return {
    queries,
    client: {
      query: vi.fn(async ({ query }: { query: string }) => { queries.push(query); return { json: async () => rowsFor(query) } }),
    } as never,
  }
}

const registryRows = (query: string): unknown[] => {
  if (query.includes('price_data.uniswap_v3_pools')) return [{ pool_address: POOL, factory: '0xf', token0: DOT, token1: HOLLAR, fee: 3000, tick_spacing: 60, block_height: 1, ts: '2026-09-08 10:37:24', extrinsic_index: 2 }]
  if (query.includes('price_data.uniswap_v3_vaults')) return [{ vault_address: VAULT, factory: '0xg', token0: DOT, token1: HOLLAR, fee: 3000, vault_index: '1', block_height: 2, ts: '2026-09-08 13:07:36' }]
  return []
}

beforeEach(() => resetCacheForTests())

describe('histogram names', () => {
  it('groups the venue rows by the action the feed gives them', () => {
    expect(v3LiquidityHistogramNames('Add')).toEqual(['UniswapV3.Mint', 'Gamma.Deposit'])
    expect(v3LiquidityHistogramNames('Remove')).toEqual(['UniswapV3.Burn', 'Gamma.Withdraw'])
    expect(v3LiquidityHistogramNames('CollectFees')).toEqual(['UniswapV3.Collect'])
    expect(v3LiquidityHistogramNames('Rebalance')).toEqual(['Gamma.Rebalance'])
    expect(v3LiquidityHistogramNames('Claim')).toEqual([])
    expect(v3LiquidityHistogramNames()).toHaveLength(6)
    expect(V3_HISTOGRAM_NAMES).toContain('UniswapV3.Swap')
  })
})

describe('getDailyActivity', () => {
  it('counts the venue under the Trade and Liquidity tabs, narrowed by action like the list', async () => {
    const { client, queries } = recordingClient()
    initExplorerService(client)
    await getDailyActivity('activity', { type: 'trade' })
    await getDailyActivity('activity', { type: 'trade', action: 'swap' })
    await getDailyActivity('activity', { type: 'trade', action: 'dca' })
    await getDailyActivity('activity', { type: 'liquidity' })
    await getDailyActivity('activity', { type: 'liquidity', action: 'CollectFees' })
    await getDailyActivity('activity', { type: 'all' })
    // The WHERE name list, apart from the swap-class identity tuple (which names
    // 'UniswapV3.Swap' in every query, see below).
    const names = (q: string) => /WHERE day > today\(\) - 90 AND event_name IN \(([^)]*)\)/.exec(q)?.[1] ?? ''
    const [trade, swap, dca, liquidity, collect, all] = queries.map(names)
    expect(trade).toContain("'UniswapV3.Swap'")
    expect(swap).toContain("'UniswapV3.Swap'")
    expect(dca).not.toContain('UniswapV3')
    for (const name of ['UniswapV3.Mint', 'UniswapV3.Burn', 'UniswapV3.Collect', 'Gamma.Deposit', 'Gamma.Withdraw', 'Gamma.Rebalance']) expect(liquidity).toContain(`'${name}'`)
    expect(liquidity).not.toContain("'UniswapV3.Swap'")
    expect(collect).toContain("'UniswapV3.Collect'")
    expect(collect).not.toContain("'UniswapV3.Mint'")
    expect(collect).not.toContain("'Gamma.Deposit'")
    expect(all).toContain("'Gamma.Rebalance'")
    // A routed hop's Swap log and its Router.Executed row are one trade: the swap-class
    // identity in the uniqExact tuple must name the v3 swap too.
    expect(queries[0]).toMatch(/event_name IN \([^)]*'UniswapV3\.Swap'[^)]*\), activity_index/)
  })
})

describe('v3HistogramTokenArm', () => {
  it('resolves a token to the pool and vault contracts through the registry, aliases included', async () => {
    const { client } = recordingClient(registryRows)
    initUniswapV3Service(client)
    initExplorerService(client)
    const arm = await v3HistogramTokenArm(['UniswapV3.Swap', 'Gamma.Deposit', 'Omnipool.SellExecuted'], [5])
    expect(arm).toContain(`'${POOL}'`)
    expect(arm).toContain(`'${VAULT}'`)
    expect(arm).toContain("event_name IN ('UniswapV3.Swap','Gamma.Deposit')")
    expect(arm).not.toContain('Omnipool.SellExecuted')
    expect(arm).toContain('FROM price_data.uniswap_v3_events')
    // DOT's aToken (1001) sits in the same pool: the alias reaches it as the feed does.
    expect(await v3HistogramTokenArm(['UniswapV3.Swap'], [1001])).toContain(`'${POOL}'`)
  })
  it('is empty for a token no pool holds, for non-venue names, and for no token', async () => {
    const { client } = recordingClient(registryRows)
    initUniswapV3Service(client)
    initExplorerService(client)
    expect(await v3HistogramTokenArm(['UniswapV3.Swap'], [999])).toBe('')
    expect(await v3HistogramTokenArm(['Omnipool.SellExecuted'], [5])).toBe('')
    expect(await v3HistogramTokenArm(['UniswapV3.Swap'], [])).toBe('')
  })
})
