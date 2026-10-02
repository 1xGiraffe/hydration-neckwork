import { describe, expect, it } from 'vitest'
import { accountTools } from '../../src/mcp/tools/account.ts'
import { assetTools } from '../../src/mcp/tools/assets.ts'
import { poolTools } from '../../src/mcp/tools/pools.ts'
import { protocolTools } from '../../src/mcp/tools/protocol.ts'
import { UpstreamError, type UpstreamClient } from '../../src/mcp/upstream.ts'
import type { ToolContext, ToolDefinition, ToolOutput } from '../../src/mcp/toolTypes.ts'

/**
 * Trading volume across the tools, against shapes recorded from the explorer's
 * volume routes (2026-10-02). Pinned: each reading names its ONE definition
 * (routed, pool, asset, per-account netted trades), the explorer's `changePct`
 * is read as a percent, volume/TVL ratios print as percentages, and no series is
 * ever returned raw.
 */

const EXPLORER = 'https://explorer.example'

interface FakeUpstream extends UpstreamClient { calls: string[] }

function fakeUpstream(routes: Record<string, unknown>): FakeUpstream {
  const calls: string[] = []
  return {
    calls,
    async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
      const qs = query
        ? Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join('&')
        : ''
      calls.push(qs ? `${path}?${qs}` : path)
      if (!(path in routes)) throw new UpstreamError('not found', 404, { error: 'not found' }, path)
      return routes[path] as T
    },
  }
}

const ctxFor = (upstream: UpstreamClient): ToolContext =>
  ({ upstream, explorerBaseUrl: EXPLORER, publicUrl: 'https://mcp.example', maxTextChars: 24_000 })

const tool = (defs: ToolDefinition[], name: string): ToolDefinition => defs.find(d => d.name === name)!

async function run(def: ToolDefinition, input: Record<string, unknown>, routes: Record<string, unknown>): Promise<ToolOutput & { calls: string[] }> {
  const upstream = fakeUpstream(routes)
  const out = await def.handler(input, ctxFor(upstream))
  if (process.env.SHOW_MD) console.log(out.markdown)
  return { ...out, calls: upstream.calls }
}

const stat = (volumeUsd: number, prevUsd: number) => ({ volumeUsd, prevUsd, changePct: prevUsd > 0 ? ((volumeUsd - prevUsd) / prevUsd) * 100 : null })
const kpis = (d1: number, p1: number, d7: number, p7: number, d30: number, p30: number) => ({ d1: stat(d1, p1), d7: stat(d7, p7), d30: stat(d30, p30) })

const DOT = { assetId: 5, iconAssetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null, origin: null }
const ADOT = { assetId: 1001, iconAssetId: 5, symbol: 'aDOT', name: null, decimals: 10, parachainId: null, origin: null }
const HOLLAR = { assetId: 222, iconAssetId: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachainId: null, origin: null }
const TRADER = { accountId: `0x${'72'.repeat(32)}`, address: '13b6hRRYPHTxFzs9prvL2YGHQepvd4YhdDb9Tc7khySp3hMN', emoji: '🌻', tag: null, identity: null, profile: null }
const CHART = { stepSec: 86_400, buckets: Array.from({ length: 31 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`), series: { routed: Array(31).fill(1), omnipool: Array(31).fill(1) } }

const PLATFORM = {
  asOf: '2026-10-02T03:00:00.000Z',
  range: '30d',
  routed: kpis(2_533_262.6, 2_634_036.69, 14_348_814.45, 9_150_891.47, 36_407_640.37, 23_362_907.98),
  routedTrades: { d1: 23_517, d7: 115_172, d30: 315_541 },
  venues: [
    { venue: 'omnipool', kpis: kpis(904_846.58, 581_152.5, 4_048_506.25, 3_389_403.27, 14_226_007.03, 12_135_990.41) },
    { venue: 'stableswap', kpis: kpis(2_536_084.96, 3_081_219.36, 15_842_061.71, 11_228_869.1, 40_000_000, 20_000_000) },
    { venue: 'otc', kpis: kpis(38.74, 0, 38.74, 0, 38.74, 0) },
  ],
  venueTotal: kpis(3_684_250.3, 3_851_612.53, 21_874_308.29, 15_692_143.43, 59_400_773.53, 38_171_662.05),
  chart: CHART,
  topPools: [
    { venue: 'stableswap', name: 'HUSDT', poolId: 111, address: null, volume7dUsd: 7_654_981.04, tvlUsd: 1_393_392.84, volumeTvl7d: 3.9438 },
    { venue: 'omnipool', name: 'Omnipool', poolId: null, address: null, volume7dUsd: 4_048_506.25, tvlUsd: 13_316_122.67, volumeTvl7d: 0.3168 },
  ],
  topAssets: [{ asset: HOLLAR, volume7dUsd: 17_089_618.6, sharePct: 39.1 }],
  topTraders: [{ account: TRADER, volume7dUsd: 2_206_890.62, trades: 11_412 }],
  tradersWindow: { fromBlock: 15_006_143, toBlock: 15_284_550, asOfBlock: 15_285_177 },
}

describe("get_protocol_stats dashboard 'volume'", () => {
  it('reads /explorer/volume and renders routed, venue and top tables without the series', async () => {
    const out = await run(tool(protocolTools, 'get_protocol_stats'), { dashboard: 'volume' }, { '/explorer/volume': PLATFORM })
    expect(out.calls).toEqual(['/explorer/volume'])
    expect(out.errors).toBeUndefined()
    expect(out.markdown).toContain('## Volume')
    expect(out.markdown).toContain('Routed volume — every trade once')
    // changePct is a percent upstream: -3.83%, not -383%.
    expect(out.markdown).toMatch(/\| 24 h \| \$2\.53M \| -3\.83% \| 23,517 \|/)
    expect(out.markdown).toContain('| Omnipool | $905k | $4.05M | +19.45% | $14.2M |')
    expect(out.markdown).toContain('**All venues**')
    expect(out.markdown).toContain('sum to MORE than routed volume')
    // 3.94 is a ratio: 394%.
    expect(out.markdown).toMatch(/\[HUSDT\]\(https:\/\/explorer\.example\/pool\/111\).*394%/)
    expect(out.markdown).toContain('[Omnipool](https://explorer.example/omnipool)')
    expect(out.markdown).toContain('11,412')
    const json = out.json as { chart: { buckets: number }; topPools: unknown[] }
    expect(json.chart.buckets).toBe(31)
    expect(JSON.stringify(out.json)).not.toContain('"series"')
  })
})

const ASSET_DETAIL = {
  asset: { ...DOT, price: 1.23, change24h: 0.01, type: 'Token' },
  totalUsd: 10_000_000, holderCount: 12_000, priceSeries: [1, 1.2], priceDates: ['2026-09-30', '2026-10-01'], dcaCount: 0,
}
const ASSET_VOLUME = {
  assetId: 5, assetIds: [5, 1001], assets: [DOT, ADOT], asOf: '2026-10-02T03:00:00.000Z',
  kpis: kpis(696_179.86, 558_239.17, 4_559_519.33, 3_775_833.85, 13_550_395.84, 7_200_697.8),
  byVenue: [
    { venue: 'omnipool', d1: 418_232.91, d7: 2_456_714.77, d30: 8_708_352.27 },
    { venue: 'uniswapv3', d1: 225_425.49, d7: 1_315_724.85, d30: 2_209_037.15 },
    { venue: 'lbp', d1: 0, d7: 0, d30: 0 },
  ],
  allTimeUsd: 1_325_787_473.47,
  volumeTvl: { d7: 1.1448, d30: 3.4816, meanTvl7dUsd: 3_982_742.13, meanTvl30dUsd: 3_891_980.62 },
  chart: { stepSec: 1_209_600, buckets: ['2026-09-01'], series: { omnipool: [1] } },
}

describe("get_asset include 'volume'", () => {
  it('reads /explorer/asset/:id/volume and states asset volume by venue with volume/TVL', async () => {
    const out = await run(tool(assetTools, 'get_asset'), { asset: '5', include: ['volume'] }, {
      '/explorer/asset/5': ASSET_DETAIL,
      '/explorer/asset/5/volume': ASSET_VOLUME,
    })
    expect(out.calls).toEqual(['/explorer/asset/5', '/explorer/asset/5/volume'])
    expect(out.markdown).toContain('## Volume')
    expect(out.markdown).toContain('**Volume 24 h:** $696k (+24.71% vs the prior 24 h)')
    expect(out.markdown).toContain('**7 d volume / TVL:** 114% (over a mean $3.98M in pools)')
    expect(out.markdown).toContain('DOT (#5) + aDOT (#1001)')
    expect(out.markdown).toContain('| Omnipool | $418k | $2.46M | $8.71M |')
    // A venue with nothing in 30 days is left out.
    expect(out.markdown).not.toContain('| LBP |')
    expect(out.markdown).toContain('ASSET volume')
    expect((out.json as { volume: { countedAssetIds: number[] } }).volume.countedAssetIds).toEqual([5, 1001])
  })

  it('does not read the volume route unless asked', async () => {
    const out = await run(tool(assetTools, 'get_asset'), { asset: '5' }, { '/explorer/asset/5': ASSET_DETAIL })
    expect(out.calls).toEqual(['/explorer/asset/5'])
  })
})

const POOL_VOLUME = {
  venue: 'stableswap', poolKey: '111', asOf: '2026-10-02T03:00:00.000Z',
  kpis: kpis(1_343_831.86, 1_335_992.51, 7_654_981.04, 4_988_942.1, 18_738_783.78, 10_676_324.48),
  fees: { d1: { lpUsd: 192.43, protocolUsd: 0 }, d7: { lpUsd: 1_384.49, protocolUsd: 0 }, d30: { lpUsd: 3_569.7, protocolUsd: 0 } },
  fills: { d1: 8083, d7: 32_835, d30: 73_336 },
  allTime: { volumeUsd: 153_993_863.64, lpFeeUsd: 26_672.02, protocolFeeUsd: 0, fills: 586_584 },
  tvlUsd: 1_393_392.84, meanTvl7dUsd: 1_940_998.85, volumeTvl: { d1: 0.9644, d7: 3.9438 }, feeApr7dPct: 3.6923,
  chart: { stepSec: 432_000, buckets: ['2026-09-01'], series: { volume: [1] } },
}
const POOL_DETAIL = {
  poolId: 111, kind: 'stableswap', name: 'HUSDT', shareToken: { assetId: 111, symbol: 'HUSDT', decimals: 18 }, totalIssuance: '1000000000000000000000000',
  tvlUsd: 1_393_392.84, feePermill: 200, assets: [], paramEvents: [],
}

describe("get_pools volume", () => {
  it("reads a stableswap pool's volume for include 'volume' and renders volume & fees", async () => {
    const out = await run(tool(poolTools, 'get_pools'), { pool: '111', include: ['volume'] }, {
      '/explorer/pool/111': POOL_DETAIL,
      '/explorer/pool/111/volume': POOL_VOLUME,
    })
    expect(out.calls).toContain('/explorer/pool/111/volume')
    expect(out.markdown).toContain('### Volume & fees')
    expect(out.markdown).toContain('96.4% over 24 h (against the current TVL $1.39M) · 394% over 7 d')
    expect(out.markdown).toContain('| 7 d | $7.65M | +53.44% | 32,835 | $1.38k | $0 |')
    expect(out.markdown).toContain('**Fee APR (7 d):** 3.69%')
    expect((out.json as { volume: { fills: { d7: number } } }).volume.fills.d7).toBe(32_835)
  })

  it("reads the Omnipool's volume with include 'history', and not without it", async () => {
    const omnipool = { account: TRADER, tvlUsd: 13_316_122.67, assetCount: 1, hubReserveTotal: '1000000000000', lrnaPrice: 1, assets: [] }
    const omniVolume = { ...POOL_VOLUME, venue: 'omnipool', poolKey: 'omnipool', feeApr7dPct: null }
    const withHistory = await run(tool(poolTools, 'get_pools'), { pool: 'omnipool', include: ['history'] }, { '/explorer/omnipool': omnipool, '/explorer/omnipool/volume': omniVolume })
    expect(withHistory.calls).toEqual(['/explorer/omnipool', '/explorer/omnipool/volume'])
    expect(withHistory.markdown).toContain('a user swap through the hub counts once')
    const plain = await run(tool(poolTools, 'get_pools'), { pool: 'omnipool' }, { '/explorer/omnipool': omnipool })
    expect(plain.calls).toEqual(['/explorer/omnipool'])
  })

  it("names a failed volume read instead of failing the pool", async () => {
    const out = await run(tool(poolTools, 'get_pools'), { pool: '111', include: ['volume'] }, { '/explorer/pool/111': POOL_DETAIL })
    expect(out.markdown).toContain('## HUSDT')
    expect(out.errors?.[0]?.message).toContain("The pool's volume")
  })

  it('shows 24 h volume and volume/TVL on directory rows', async () => {
    const index = {
      totalTvlUsd: 2_000_000, volumeAsOf: '2026-10-02T03:00:00.000Z',
      pools: [{ kind: 'stableswap', poolId: 111, name: 'HUSDT', tvlUsd: 1_393_392.84, sharePct: 70, composition: [], hasPegs: false, volume24hUsd: 1_343_831.86, volume7dUsd: 7_654_981.04, volumeTvl24h: 0.9644 }],
    }
    const out = await run(tool(poolTools, 'get_pools'), {}, { '/explorer/pools': index })
    expect(out.markdown).toContain('| 24 h volume | 24 h vol/TVL |')
    expect(out.markdown).toContain('$1.34M | 96.4%')
    expect(out.markdown).toContain('24 h volume is POOL volume')
  })
})

const VOLUME_HISTORY = {
  stepSec: 432_000,
  buckets: [
    { ts: '2026-09-14 00:00:00', endTs: '2026-09-19 00:00:00', blockHeight: 14_900_000, volumeUsd: 0, trades: 0 },
    { ts: '2026-09-19 00:00:00', endTs: '2026-09-24 00:00:00', blockHeight: 15_000_000, volumeUsd: 1_500.5, trades: 12 },
    { ts: '2026-09-24 00:00:00', endTs: '2026-09-29 00:00:00', blockHeight: 15_100_000, volumeUsd: 79_460.49, trades: 551 },
    { ts: '2026-09-29 00:00:00', endTs: '2026-10-02 03:40:12', blockHeight: 15_285_738, volumeUsd: 62_904.44, trades: 300 },
  ],
  totals: { d1: 886.66, d7: 66_289.77, d30: 167_249.34, all: 3_364_473.29 },
  asOfBlock: 15_285_483,
}
const ADDRESS = '12VN3cXsgAjkQnbjEBRkydickdnnuAZwdUYaJWj1NJjzoq25'

describe("get_account_history kind 'volume'", () => {
  const history = tool(accountTools, 'get_account_history')

  it('reads the address volume-history route and renders totals and a bucket summary', async () => {
    const out = await run(history, { address: ADDRESS, kind: 'volume' }, { [`/explorer/address/${ADDRESS}/volume-history`]: VOLUME_HISTORY })
    expect(out.calls).toEqual([`/explorer/address/${ADDRESS}/volume-history`])
    expect(out.markdown).toContain('## Trading volume — ')
    expect(out.markdown).toContain('**All time:** $3.36M — the account page\'s "Trading" figure')
    expect(out.markdown).toContain('**Last 7 d:** $66.3k')
    expect(out.markdown).toContain('**Peak bucket:** $79.5k · 551 trade(s)')
    expect(out.markdown).toContain('**First bucket with trades:** $1.5k · 12 trade(s)')
    expect(out.markdown).toContain('3 with trades')
    expect(out.markdown).toContain('RELATED SET')
    const json = out.json as { buckets: number; bucketsWithTrades: number; peak: { volumeUsd: number } }
    expect(json).toMatchObject({ buckets: 4, bucketsWithTrades: 3, peak: { volumeUsd: 79_460.49 } })
    expect(JSON.stringify(out.json).length).toBeLessThan(3_000)
  })

  it('reads the tag twin for `tag`, passing a block window through', async () => {
    const out = await run(history, { tag: 'treasury', kind: 'volume', fromBlock: 15_000_000, toBlock: 15_200_000 }, { '/explorer/tag/treasury/volume-history': VOLUME_HISTORY })
    expect(out.calls).toEqual(['/explorer/tag/treasury/volume-history?fromBlock=15000000&toBlock=15200000'])
    expect(out.markdown).toContain('## Trading volume — tag `treasury`')
    expect(out.markdown).toContain('A tag SUMS its members')
    expect(out.markdown).toContain('https://explorer.example/tag/treasury')
  })

  it('refuses a tag on another kind, both targets, or neither', async () => {
    for (const input of [{ tag: 'treasury' }, { tag: 'treasury', address: ADDRESS, kind: 'volume' }, { kind: 'volume' }, {}]) {
      const out = await run(history, input, {})
      expect(out.errors?.[0]?.code, JSON.stringify(input)).toBe('INVALID_ARGUMENT')
      expect(out.calls).toEqual([])
    }
  })
})
