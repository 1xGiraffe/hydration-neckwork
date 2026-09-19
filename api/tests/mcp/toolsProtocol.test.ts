import { describe, expect, it } from 'vitest'
import { networkTools } from '../../src/mcp/tools/network.ts'
import { protocolTools } from '../../src/mcp/tools/protocol.ts'
import { UpstreamError, type UpstreamClient } from '../../src/mcp/upstream.ts'
import type { ToolContext, ToolDefinition, ToolOutput } from '../../src/mcp/toolTypes.ts'

/**
 * The chain-wide tools against recorded shapes, with no network.
 *
 * Two things are pinned here that nothing else can catch: that the revenue
 * payloads' UNIX-SECOND timestamps are read as unix seconds (a ClickHouse
 * parse would land in 1970), and that these very large dashboards render as
 * headline figures plus top-N tables rather than as their raw series.
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
      const value = routes[path]
      if (value instanceof Error) throw value
      return value as T
    },
  }
}

const ctxFor = (upstream: UpstreamClient): ToolContext =>
  ({ upstream, explorerBaseUrl: EXPLORER, publicUrl: 'https://mcp.example', maxTextChars: 24_000 })

const tool = (defs: ToolDefinition[], name: string): ToolDefinition => {
  const found = defs.find(d => d.name === name)
  if (!found) throw new Error(`${name} is not registered`)
  return found
}

const run = (def: ToolDefinition, input: Record<string, unknown>, routes: Record<string, unknown>): Promise<ToolOutput> =>
  def.handler(input, ctxFor(fakeUpstream(routes)))

/* ============ fixtures ============ */

const HDX_ASSET = { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null, origin: null }
const HOLLAR_ASSET = { assetId: 222, iconAssetId: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachainId: null, origin: null }
const AUSDC = { assetId: 1003, iconAssetId: 22, symbol: 'aUSDC', name: null, decimals: 6, parachainId: 1000, origin: null }
const ACCOUNT = {
  accountId: '0x6d6f646c70792f74727372790000',
  address: '13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB',
  emoji: '🏦', tag: { id: 'treasury', name: 'Treasury', color: '', icon: '🏦', memberCount: 7 }, identity: null, profile: null,
}

const STATS = {
  headBlock: 14_745_047,
  finalizedBlock: 14_745_027,
  headTime: '2026-09-18 10:55:12',
  avgBlockSec: 2.4848484848,
  nominalBlockSec: 2,
  transfers24h: 78_083,
  extrinsics24h: 4765,
  activeAccounts24h: 102_971,
  hdxPrice: 0.007722427215,
}

const COUNTS = { blocks: 14_745_170, extrinsics: 4_699_005, events: 323_988_122, transfers: 82_978_679, contracts: 444, maxOffset: 20_000_000 }

const BLOCKS = [
  { height: 14_745_047, timestamp: '2026-09-18 10:55:12', hash: '0x7d2d2e051525a3bc00cdd2dee084985fa7f1166974ec1c400bd1114df982bfd9', author: null, specVersion: 443, extrinsicCount: 3, eventCount: 12, finalized: false },
  { height: 14_745_027, timestamp: '2026-09-18 10:54:32', hash: '0x36a16298608d554bda1754396e2c77f35eb0cd6d30b4c71f6f7965cee7761950', author: ACCOUNT, specVersion: 443, extrinsicCount: 4, eventCount: 170 },
]

// 1787097600 = 2026-08-19T00:00:00Z, 1788220800 = 2026-09-01T00:00:00Z.
const REVENUE = {
  totals: { day: 4301.13, week: 20_491.11, month: 106_105.75, allTime: 3_146_728.97 },
  history: {
    range: '30d',
    bucketSeconds: 86_400,
    series: [{ stream: 'hollar_borrow', points: [{ t: 1_787_097_600, usd: 1112.28 }, { t: 1_788_220_800, usd: 1300.0 }] }],
  },
  breakdown: [
    { stream: 'hollar_borrow', usd: 45_822.5, share: 0.431856 },
    { stream: 'omnipool_protocol_fee', usd: 26_299.94, share: 0.247865 },
  ],
  topAccounts: [{ account: ACCOUNT, usd: 17_494.95 }],
  asOf: '2026-09-18T10:55:54.000Z',
}

const STAKERS = {
  range: '30d',
  bucketSeconds: 2_592_000,
  series: [{ pot: 'staking', points: [{ t: 1_788_220_800, hdx: 153_450.21, usd: 1184.37 }] }],
  totals: { hdx: 202_587_306.7, usd: 1_614_265.63 },
  allTime: { hdx: 202_587_306.7, usd: 1_614_265.63 },
}

const FLOW = {
  items: [{ stream: 'network_fee', block: 14_745_043, t: 1_789_728_906, eventIndex: 54, legIndex: 0, account: ACCOUNT, assetId: 0, usd: 0.004552 }],
  drips: [{ key: '0x1b02', label: 'HOLLAR interest · core', stream: 'hollar_borrow', usdPerBlock: 0.03085908 }],
  cursor: '14745043-54-0',
  head: 14_745_048,
  blockSeconds: 2.4242,
}

const HDX_DASH = {
  price: 0.007734913552,
  change24h: 0.064804626608,
  supply: { totalHdx: 6_422_961_528.48, protocolHdx: 2_537_500_839.18, userHdx: 3_885_460_689.3, holders: 61_136 },
  cohorts: [{ key: 'whale', label: 'Whale', minPct: 0.1, minHdx: 6_422_961.52, accounts: 93, totalHdx: 2_509_349_973.64 }],
  locks: { types: [{ key: 'vote', label: 'Vote locks', accounts: 1358, totalHdx: 1_698_851_080.55 }], totalLockedHdx: 2_169_293_009.77, lockedPctOfUser: 55.83, vestedUnclaimedHdx: 490_800_642.89, snapshotAt: '2026-09-18 10:22:49' },
  unlocks: {
    buckets: [{ label: 'wk 1', fromTs: '2026-09-18 10:22:12', toTs: '2026-09-25 10:22:12', gigahdx: 10_822_960.04, vesting: 262_918.02, vote: 676_804.51, other: 0 }],
    laterHdx: {}, unlockableNowHdx: 1_309_534_813.73, nowHdx: {},
    activeVoteHdx: 2_572_820.81, stakingAnytimeHdx: 807_903_511.08,
    gigaPending: { count: 118, totalHdx: 20_302_377.91, nextUnlockTs: '2026-09-18 10:59:50', maturedCount: 22, maturedHdx: 3_903_050.98 },
  },
  flows: { daily: [{ date: '2026-09-18', buyHdx: 358_532.68, sellHdx: 552_154.73, buyers: 11, sellers: 9 }], dca: { buy: { orders: 5, hdxPerDay: 4_648_446.43 }, sell: { orders: 2, hdxPerDay: 12_770.66 } } },
  churn: { weekly: [{ weekStart: '2026-09-13', newHolders: 16, exitedHolders: 18 }] },
  topMovers: {
    accumulators: [{ account: ACCOUNT, balanceHdx: 2_199_632_654.46, boughtHdx: 7_077_129.32, soldHdx: 0, netHdx: 7_077_129.32 }],
    distributors: [{ account: ACCOUNT, balanceHdx: 0, boughtHdx: 0, soldHdx: 4_324_028.75, netHdx: -4_324_028.75 }],
  },
  gigaMarket: [{ asset: { ...HDX_ASSET, assetId: 670, symbol: 'stHDX' }, supplied: 1_295_138_492.8, suppliedUsd: 10_017_784.27, debt: 0, debtUsd: 0, suppliers: 707, borrowers: 0 }],
  // The two series the rendering must never print.
  structure: { weeks: Array.from({ length: 200 }, (_, i) => `week-${i}`) },
}

const HOLLAR_DASH = {
  // A 90-day trend series, present so the "no raw series" cut is exercised
  // rather than merely written: without it the assertion holds vacuously.
  trends: Array.from({ length: 90 }, (_, i) => ({ day: `2026-06-${i}`, supply: 12_000_000 + i })),
  price: 0.998846530458,
  change24h: 0.00060966,
  pegDeviationBps: -11.53,
  peg: { within25bpsPct: 99.861, maxDevBps: -27.28, min30d: 0.997271, max30d: 0.9996, hourly: Array.from({ length: 720 }, (_, i) => ({ ts: `2026-08-19 ${i}`, close: 0.998 })) },
  supply: { total: 12_714_424.29, holders: 393, inStablepools: 4_713_652.13, inOmnipool: 2_376_515.05, other: 5_624_257.1 },
  hsm: {
    totalHoldingsUsd: 223_585.48,
    collaterals: [{ asset: AUSDC, poolId: 110, holdings: '84462534446', holdingsUsd: 84_485.75, purchaseFeePct: 0, buyBackFeePct: 0.01, maxBuyPrice: 0.998, buybackRatePct: 0.01, maxInHolding: '8000000000000', lastArbTs: '2026-09-16 23:21:24', lastArbDirection: 'in' }],
    lastArb: { ts: '2026-09-16 23:21:24', direction: 'in', asset: AUSDC, hollarAmount: 20.58 },
  },
  pools: [{ poolId: 110, tvlUsd: 1_790_000, hollar: { amount: 1_000_000, usd: 999_000 }, partners: [{ asset: AUSDC, amount: 790_000, usd: 790_000 }], hollarSharePct: 56.01 }],
}

const ICE_DASH = {
  status: { solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false, asOfBlock: 14_413_914 },
  openOrders: { total: 4, limit: 2, dca: 2, byAsset: [{ asset: HOLLAR_ASSET, reserved: '95747020495232621727', reservedUsd: 97.68, orders: 1 }] },
  fillsPerDay: [{ day: '2026-09-17', fills: 227, solutions: 227, usd: 3050, matchedUsd: 0, routedUsd: 4860 }, { day: '2026-09-18', fills: 29, solutions: 29, usd: 756.49, matchedUsd: 0, routedUsd: 759.08 }],
  quality: { medianTimeToFillSec: 0, partialShare: 0.0350877, cancelRate: 0.1857142, expiryRate: 0, priceVsLimitBp: { p10: -0.1, p50: 10.3, p90: 99.3 } },
  feeRevenue: { perDay: [{ day: '2026-09-18', usd: 0 }], potHoldings: [] },
  migration: { migrated: 0, cancelled: 0, remainingSchedules: 27, byReason: [], perDay: [] },
  topPairs: [{ assetIn: AUSDC, assetOut: HOLLAR_ASSET, fills: 38, usd: 18_721.33 }],
  generatedAt: '2026-09-18T10:09:12.689Z',
}

const SECURITY_DASH = {
  head: { blockHeight: 14_745_045, blockTimestamp: '2026-09-18 10:55:06' },
  chainAsOf: '2026-09-18T10:54:49.975Z',
  chainBlock: 14_745_031,
  withdraw: {
    configured: true, limit: 100_000_000, used: 26_410_464.38, usagePct: 26.4104, windowMs: 21_600_000,
    lockdownUntilMs: null, everTripped: false, externalAssetCount: 56,
    egressAccounts: Array.from({ length: 11 }, () => ({ account: ACCOUNT, chain: 'Interlay' })),
    localAssets: [HDX_ASSET, HOLLAR_ASSET],
  },
  fuses: {
    periodBlocks: 14_400, lockedCount: 0, frozenCount: 0, lockdownTotal: 31, releaseTotal: 116,
    rows: [{ asset: HOLLAR_ASSET, status: 'active', limit: '109000000000000000000000', used: '19401213238000000000000', limitUsd: 109_001.54, usedUsd: 19_401.48, headroom: '0', usagePct: 17.79, untilBlock: null, periodEndBlock: 14_756_162, category: 'external', lockdownCount: 2 }],
    lockdowns: Array.from({ length: 31 }, (_, i) => ({ id: i })),
  },
  perBlock: {
    defaultTradePct: 50, defaultAddPct: 5, defaultRemovePct: 5, peakWindowDays: 30,
    rows: [{ asset: HOLLAR_ASSET, reserve: '2377290493290555851376188', reserveUsd: 2_375_046.94, tradeLimitPct: 50, addLimitPct: 5, removeLimitPct: 5, peakPressurePct: 2.15, peakBlockHeight: 13_702_194, overridden: false, tradable: ['Sell', 'Buy', 'Add liquidity', 'Remove liquidity'] }],
  },
  trips: {
    total: 450, enforcementTotal: 443, directTotal: 265, nestedTotal: 185,
    byError: [{ name: 'MaxLiquidityLimitPerBlockReached', count: 442, enforcement: true }],
    byYear: [], recent: Array.from({ length: 20 }, (_, i) => ({ blockHeight: i })),
  },
  freezes: {
    paused: [{ pallet: 'PolkadotXcm', call: 'claim_assets', pausedAtBlock: 13_469_888, pausedAtTimestamp: '2026-08-05 08:51:42', extrinsicIndex: 3, orphaned: false }],
    hubTradability: ['Sell'], omnipool: [], omnipoolAssetCount: 13,
    delisted: Array.from({ length: 27 }, (_, i) => ({ assetId: i })), stableswap: [],
  },
  risk: {
    windowDays: 30,
    markets: [
      { key: 'core', label: 'Money Market', role: 'primary', borrowers: 648, debtUsd: 17_411_732.08, collateralUsd: 30_318_921.48, badDebtUsd: 8904.57, nearLiquidationDebtUsd: 51_232.72 },
      { key: 'gigahdx', label: 'GIGAHDX', role: 'supplemental', borrowers: 52, debtUsd: 504_704.01, collateralUsd: 2_648_353.11, badDebtUsd: 0, nearLiquidationDebtUsd: 0 },
    ],
    liquidations: { day: 1, week: 25, month: 177, total: 8721, lastTimestamp: '2026-09-18 02:54:12', recent: Array.from({ length: 20 }, (_, i) => ({ blockHeight: i })) },
    largestMoves: Array.from({ length: 20 }, (_, i) => ({ blockHeight: i })),
  },
  runtime: { specVersion: 443, upgrades: 66, lastUpgrade: { blockHeight: 14_362_830, blockTimestamp: '2026-09-08 12:30:55' } },
  timeline: Array.from({ length: 327 }, (_, i) => ({ kind: 'lockdown-lifted', label: `event ${i}`, detail: null, blockHeight: i, blockTimestamp: '2026-09-17 09:05:30', asset: null })),
  guardians: { techCommittee: { members: [ACCOUNT], size: 7, majority: 4, superMajority: 5 }, memberSetAtBlock: null, outstandingWhitelisted: [{ callHash: '0xabc', blockHeight: 1, blockTimestamp: '2026-09-01 00:00:00' }] },
  wormhole: { assets: 11, lockedUsd: 11_900_000, issuanceUsd: 11_800_000, inflightCount: 4, queuedCount: 0, worstStatus: 'surplus', deficitUsd: 0, surplusUsd: 24_900, asOf: '2026-09-18T11:18:55.000Z' },
}

const OMNIPOOL = {
  account: ACCOUNT, tvlUsd: 12_184_473, assetCount: 1, hubReserveTotal: '2116534170752941909', lrnaPrice: 5.7568,
  assets: [{ asset: HOLLAR_ASSET, reserve: '2376409055919869598167124', reserveUsd: 2_374_166, hubReserve: '412397534156766257', weightPct: 19.62, capPct: 20, tradable: ['Sell', 'Buy', 'Add liquidity', 'Remove liquidity'] }],
  history: { buckets: ['2026-09-17'], tvlUsd: [12_000_000] },
}

const POOLS_INDEX = {
  totalTvlUsd: 32_000_000,
  pools: [
    { kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd: 12_000_000, sharePct: 37.5, hasPegs: false, composition: [] },
    { kind: 'stableswap', poolId: 690, name: '2-Pool-GDOT', tvlUsd: 20_000_000, sharePct: 62.5, hasPegs: true, composition: [] },
  ],
}

/* ============ get_network_status ============ */

const network = tool(networkTools, 'get_network_status')
const NETWORK_ROUTES = { '/explorer/stats': STATS, '/explorer/counts': COUNTS, '/explorer/blocks': BLOCKS }

describe('get_network_status', () => {
  it('reads its three sources in one pass', async () => {
    const upstream = fakeUpstream(NETWORK_ROUTES)
    await network.handler({}, ctxFor(upstream))
    expect(upstream.calls.sort()).toEqual(['/explorer/blocks?limit=5', '/explorer/counts', '/explorer/stats'])
  })

  it('states the index lag in blocks AND seconds so a retry decision is possible', async () => {
    const out = await run(network, {}, NETWORK_ROUTES)
    expect(out.markdown).toContain('trails the chain head by **20 blocks**')
    // 20 blocks at the NOMINAL 2s slot time, not at the measured 2.48s.
    expect(out.markdown).toContain('(~40s at the nominal slot time)')
    expect(out.markdown).toContain('retry rather than concluding the extrinsic never happened')
  })

  it('prints the measured pace beside the nominal one and says which converts block counts', async () => {
    const out = await run(network, {}, NETWORK_ROUTES)
    expect(out.markdown).toContain('2.48s')
    expect(out.markdown).toContain('2s (the runtime slot time)')
    expect(out.markdown).toContain('defined at the NOMINAL slot time')
  })

  it('marks an unconfirmed block and falls back to its hash when it has no author', async () => {
    const out = await run(network, {}, NETWORK_ROUTES)
    expect(out.markdown).toContain('unconfirmed')
    expect(out.markdown).toContain('0x7d2d2e…82bfd9')
    expect(out.markdown).toContain('🏦 Treasury')
  })

  it('prints heights and counts exactly, never on the compacting scale', async () => {
    const out = await run(network, {}, NETWORK_ROUTES)
    expect(out.markdown).toContain('14,745,047')
    expect(out.markdown).toContain('323,988,122')
    expect(out.markdown).not.toContain('324M')
  })

  it('answers with the rest when one source fails', async () => {
    const out = await run(network, {}, { '/explorer/stats': STATS, '/explorer/blocks': BLOCKS })
    expect(out.markdown).toContain('Chain head')
    expect(out.errors?.some(e => e.message.includes('indexed totals'))).toBe(true)
  })

  it('answers format json with a record that parses', async () => {
    const out = await run(network, { format: 'json' }, NETWORK_ROUTES)
    const parsed = JSON.parse(JSON.stringify(out.json)) as { stats: { headBlock: number }; blocks: unknown[] }
    expect(parsed.stats.headBlock).toBe(14_745_047)
    expect(parsed.blocks).toHaveLength(2)
  })
})

/* ============ get_protocol_stats ============ */

const protocol = tool(protocolTools, 'get_protocol_stats')
const REVENUE_ROUTES = { '/explorer/revenue': REVENUE, '/explorer/revenue/stakers': STAKERS, '/explorer/revenue/flow': FLOW }

describe('get_protocol_stats', () => {
  it('refuses a dashboard that does not exist, naming the ones that do', async () => {
    const out = await run(protocol, { dashboard: 'treasury' }, {})
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(out.errors?.[0].message).toContain('revenue, hdx, hollar, ice, security, liquidity')
  })

  it('reads the revenue trio under ONE range, so the answer is internally consistent', async () => {
    const upstream = fakeUpstream(REVENUE_ROUTES)
    await protocol.handler({ dashboard: 'revenue' }, ctxFor(upstream))
    expect(upstream.calls).toContain('/explorer/revenue?range=30d')
    expect(upstream.calls).toContain('/explorer/revenue/stakers?range=30d')
    expect(upstream.calls).toContain('/explorer/revenue/flow')
  })

  it('reads revenue timestamps as UNIX SECONDS, not as ClickHouse strings', async () => {
    const out = await run(protocol, { dashboard: 'revenue' }, REVENUE_ROUTES)
    // 1787097600 → 2026-08-19, 1788220800 → 2026-09-01, 1789728906 → 2026-09-18.
    expect(out.markdown).toContain('2026-08-19 00:00:00 UTC → 2026-09-01 00:00:00 UTC')
    expect(out.markdown).toContain('2026-09-01 00:00:00 UTC')
    expect(out.markdown).toContain('2026-09-18 10:55:06 UTC')
    // The 1970 tell of a unix value parsed as a date string.
    expect(out.markdown).not.toContain('1970')
  })

  it('turns a per-block drip into a per-day figure at the measured block time', async () => {
    const out = await run(protocol, { dashboard: 'revenue' }, REVENUE_ROUTES)
    expect(out.markdown).toContain('HOLLAR interest · core')
    // 0.03085908 USD/block ÷ 2.4242 s/block × 86,400 s = ~$1.1k/day.
    expect(out.markdown).toMatch(/\$1\.1k/)
  })

  it('returns revenue without its optional companions when they fail', async () => {
    const out = await run(protocol, { dashboard: 'revenue' }, { '/explorer/revenue': REVENUE })
    expect(out.markdown).toContain('Protocol revenue')
    expect(out.errors?.map(e => e.code)).toContain('NOT_FOUND')
    expect(out.markdown).not.toContain('Staker distributions')
  })

  it('renders the HDX dashboard without its 200-week ownership matrix', async () => {
    const out = await run(protocol, { dashboard: 'hdx' }, { '/explorer/hdx': HDX_DASH })
    expect(out.markdown).toContain('6.42B HDX')
    expect(out.markdown).toContain('Whale')
    expect(out.markdown).toContain('Vote locks')
    expect(out.markdown).not.toContain('week-150')
    expect(JSON.stringify(out.json)).not.toContain('week-150')
  })

  it('names GIGAHDX as an isolated market on the HDX dashboard', async () => {
    const out = await run(protocol, { dashboard: 'hdx' }, { '/explorer/hdx': HDX_DASH })
    expect(out.markdown).toContain('GIGAHDX is an ISOLATED lending market')
    expect(out.markdown).toContain('get_money_market')
  })

  it('scales HSM collateral by its own asset decimals and drops the 720-point peg series', async () => {
    const out = await run(protocol, { dashboard: 'hollar' }, { '/explorer/hollar': HOLLAR_DASH })
    // 84462534446 raw at 6 decimals = 84,462.5 aUSDC.
    expect(out.markdown).toContain('84.5k ($84.5k)')
    expect(out.markdown).not.toContain('84462534446')
    // 8000000000000 raw at 6 decimals = 8,000,000.
    expect(out.markdown).toContain('8M')
    expect(JSON.stringify(out.json)).not.toContain('"hourly"')
  })

  it('renders the ICE dashboard with its quality percentiles in basis points', async () => {
    const out = await run(protocol, { dashboard: 'ice' }, { '/explorer/ice': ICE_DASH })
    expect(out.markdown).toContain('Solver mode')
    expect(out.markdown).toContain('200 ppm (0.020%)')
    expect(out.markdown).toContain('median 10.3 bps')
    expect(out.markdown).toContain('positive = better than the limit')
  })

  it('cuts the security dashboard to its top rows and keeps the markets isolated', async () => {
    const out = await run(protocol, { dashboard: 'security' }, { '/explorer/security': SECURITY_DASH })
    expect(out.markdown).toContain('Money Market (`core`)')
    expect(out.markdown).toContain('GIGAHDX (`gigahdx`)')
    expect(out.markdown).toContain('ISOLATED')
    expect(out.markdown).toContain('26.41%')
    // The 327-entry timeline is cut to its head in both renderings.
    expect(out.markdown).not.toContain('event 100')
    const json = JSON.parse(JSON.stringify(out.json)) as { timeline: unknown[]; withdraw: Record<string, unknown> }
    expect(json.timeline).toHaveLength(6)
    expect(json.withdraw.egressAccounts).toBeUndefined()
  })

  it('renders the liquidity dashboard as venues plus the Omnipool weight caps', async () => {
    const out = await run(protocol, { dashboard: 'liquidity' }, { '/explorer/omnipool': OMNIPOOL, '/explorer/pools': POOLS_INDEX })
    expect(out.markdown).toContain('Stableswap')
    expect(out.markdown).toContain('62.50%')
    expect(out.markdown).toContain('20% ⚠ at cap')
    expect(out.markdown).toContain('H2O')
    expect(out.markdown).not.toContain('LRNA')
  })

  it('keeps the liquidity dashboard when only one of its two sources answers', async () => {
    const out = await run(protocol, { dashboard: 'liquidity' }, { '/explorer/omnipool': OMNIPOOL })
    expect(out.markdown).toContain('Omnipool')
    expect(out.errors?.some(e => e.message.includes('liquidity directory'))).toBe(true)
  })

  it('says a range was ignored rather than dropping it silently', async () => {
    const out = await run(protocol, { dashboard: 'ice', range: '1y' }, { '/explorer/ice': ICE_DASH })
    expect(out.markdown).toContain('applies only to the revenue dashboard')
    expect(out.markdown).toContain('"1y" was ignored')
  })

  it('answers format json with a record that parses on every dashboard', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['revenue', REVENUE_ROUTES],
      ['hdx', { '/explorer/hdx': HDX_DASH }],
      ['hollar', { '/explorer/hollar': HOLLAR_DASH }],
      ['ice', { '/explorer/ice': ICE_DASH }],
      ['security', { '/explorer/security': SECURITY_DASH }],
      ['liquidity', { '/explorer/omnipool': OMNIPOOL, '/explorer/pools': POOLS_INDEX }],
    ]
    // `toBeTypeOf('object')` alone accepts `null` — typeof null is 'object' —
    // and `JSON.parse('null')` is under any size budget, so a dashboard that
    // quietly stopped returning a record passed this test whole.
    for (const [dashboard, routes] of cases) {
      const out = await run(protocol, { dashboard, format: 'json' }, routes)
      const text = JSON.stringify(out.json)
      const parsed = JSON.parse(text) as Record<string, unknown> | null
      expect(parsed, dashboard).not.toBeNull()
      expect(parsed, dashboard).toBeTypeOf('object')
      expect(Object.keys(parsed as object), `${dashboard} answered with an empty record`).not.toHaveLength(0)
      // Small enough that the server's text cap cannot cut it into invalid JSON.
      expect(text.length, `${dashboard} json is too large to survive the text budget`).toBeLessThan(24_000)
    }
  })

  // The other half of "a record, not a dump": each dashboard names the raw
  // series it drops, and the size budget above would not notice one coming
  // back — a small fixture fits either way. These are the cuts the source makes.
  it('drops the raw series from every dashboard record', async () => {
    const revenue = await run(protocol, { dashboard: 'revenue', format: 'json' }, REVENUE_ROUTES)
    const history = (revenue.json as { revenue: { history: Record<string, unknown> | null } }).revenue.history
    // The history survives as its shape (range + bucket), never as its points.
    expect(history == null || !('points' in history), 'the revenue history points must not be returned').toBe(true)

    const hdx = await run(protocol, { dashboard: 'hdx', format: 'json' }, { '/explorer/hdx': HDX_DASH })
    expect((hdx.json as Record<string, unknown>).structure, 'the 200-week ownership matrix is not an answer').toBeUndefined()
    expect((hdx.json as Record<string, unknown>).churn).toBeUndefined()

    const hollar = await run(protocol, { dashboard: 'hollar', format: 'json' }, { '/explorer/hollar': HOLLAR_DASH })
    expect((hollar.json as Record<string, unknown>).trends).toBeUndefined()
    expect(JSON.stringify(hollar.json)).not.toContain('"hourly"')
    expect(JSON.stringify(hollar.json)).not.toContain('"reserveHistory"')

    const liquidity = await run(protocol, { dashboard: 'liquidity', format: 'json' }, { '/explorer/omnipool': OMNIPOOL, '/explorer/pools': POOLS_INDEX })
    const omnipool = (liquidity.json as { omnipool: Record<string, unknown> | null }).omnipool
    expect(omnipool && omnipool.history).toBeUndefined()
  })
})
