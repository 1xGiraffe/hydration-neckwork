import { describe, expect, it } from 'vitest'
import { poolTools } from '../../src/mcp/tools/pools.ts'
import { moneyMarketTools } from '../../src/mcp/tools/moneyMarket.ts'
import { governanceTools } from '../../src/mcp/tools/governance.ts'
import { UpstreamError, type UpstreamClient } from '../../src/mcp/upstream.ts'
import type { ToolContext, ToolDefinition, ToolOutput } from '../../src/mcp/toolTypes.ts'

/**
 * The market-facing tools against recorded shapes, with no network.
 *
 * Every fixture below is trimmed from a live response, so the encodings under
 * test are the real ones: a 1e18 health factor beside 1e8 USD beside basis
 * points inside ONE money-market object, a delisted asset's 404 body, and the
 * two referendum pallets that both index from zero.
 */

const EXPLORER = 'https://explorer.example'

interface FakeUpstream extends UpstreamClient { calls: string[] }

/** Routes are matched on the path only; a value that is an Error is thrown. */
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

function ctxFor(upstream: UpstreamClient): ToolContext {
  return { upstream, explorerBaseUrl: EXPLORER, publicUrl: 'https://mcp.example', maxTextChars: 24_000 }
}

const tool = (defs: ToolDefinition[], name: string): ToolDefinition => {
  const found = defs.find(d => d.name === name)
  if (!found) throw new Error(`${name} is not registered`)
  return found
}

const run = (def: ToolDefinition, input: Record<string, unknown>, routes: Record<string, unknown>): Promise<ToolOutput> =>
  def.handler(input, ctxFor(fakeUpstream(routes)))

/* ============ fixtures ============ */

const HDX = { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null, origin: null }
const ADOT = { assetId: 1001, iconAssetId: 5, symbol: 'aDOT', name: null, decimals: 10, parachainId: null, origin: null }
const HOLLAR = { assetId: 222, iconAssetId: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachainId: null, origin: null }
const ACCOUNT = {
  accountId: '0x58f1dbf9ce44114d9b99dc5ba0903528aae6478f6a3417ef0318e7f80069fa41',
  address: '131d4YS25qpuXiHrfJibuFYXwZrzwxpvU1ahvr3TJFNYcmfk',
  emoji: '🐏', tag: null, identity: null, profile: null,
}

const POOLS_INDEX = {
  totalTvlUsd: 32_000_000,
  pools: [
    { kind: 'omnipool', poolId: null, name: 'Omnipool', tvlUsd: 12_000_000, sharePct: 37.5, hasPegs: false, composition: [{ asset: HOLLAR, amount: '1000000000000000000000', usd: 1000, sharePct: 20 }] },
    { kind: 'stableswap', poolId: 690, name: '2-Pool-GDOT', tvlUsd: 4_900_000, sharePct: 15.3, hasPegs: true, composition: [{ asset: ADOT, amount: '19428777881082835', usd: 2_200_000, sharePct: 44.9 }] },
    { kind: 'uniswapv3', poolId: null, address: '0x5c6208a3c316a801f8996750aa7b6f45fc988548', name: 'aDOT / HOLLAR 0.3%', tvlUsd: 10_700, sharePct: 0.03, hasPegs: false, composition: [] },
    { kind: 'xyk', poolId: 1000086, name: 'WUD / DOT', tvlUsd: 0, sharePct: 0, hasPegs: false, composition: [] },
  ],
}

const OMNIPOOL = {
  account: { accountId: '0x6d6f646c6f6d6e69706f6f6c00', address: '13UVJyLnPLowAMzbZewu9zwEGiSMQKniJ2cp4vM4ru2nci9N', emoji: '🐴', tag: null, identity: null, profile: null },
  tvlUsd: 12_184_473,
  assetCount: 2,
  hubReserveTotal: '2116534170752941909',
  lrnaPrice: 5.7568,
  assets: [
    { asset: HOLLAR, reserve: '2376409055919869598167124', reserveUsd: 2_374_166, hubReserve: '412397534156766257', weightPct: 19.62, capPct: 20, tradable: ['Sell', 'Buy', 'Add liquidity', 'Remove liquidity'] },
    // Over its cap on purpose: HDX really sits at ~10% against a 1% cap.
    { asset: HDX, reserve: '159930375385038742873', reserveUsd: 1_235_144, hubReserve: '214600000000000000', weightPct: 10.1362, capPct: 1, tradable: ['Sell', 'Buy'] },
  ],
  history: { buckets: ['2026-09-16', '2026-09-17'], tvlUsd: [11_000_000, 12_184_473] },
}

const POOL_690 = {
  kind: 'stableswap', poolId: 690, name: '2-Pool-GDOT',
  account: { accountId: '0xe21da918e4', address: '167UdiHenqFRAFeb8GxRYGT89BpKi2VPDnUjDFT8H8efqueB', emoji: '🌱', tag: null, identity: null, profile: null },
  shareToken: { assetId: 690, iconAssetId: 69, symbol: '2-Pool-GDOT', name: null, decimals: 18, parachainId: null, origin: null },
  createdBlock: 7_346_897, createdAt: '2025-04-16 08:11:42', destroyed: false,
  tvlUsd: 4_973_487, totalIssuance: '3974062929712950057703944',
  feePermill: 690, maxPegUpdatePerbill: 120,
  amplification: { current: 222, initial: 1000, final: 222, initialBlock: 9_991_888, finalBlock: 10_308_688 },
  assets: [{ asset: ADOT, amount: '19428777881082835', usd: 2_232_800, sharePct: 44.89, peg: { num: '1', den: '1', price: 1 }, pegSource: { kind: 'value' } }],
  paramEvents: [{ blockHeight: 13_134_013, timestamp: '2026-07-14 13:33:03', kind: 'max-peg-update', summary: 'Max peg update set to 0.000012% per block' }],
  history: { buckets: ['2026-09-16', '2026-09-17'], tvlUsd: [5_000_000, 4_973_487] },
}

const V3_POOL = {
  kind: 'uniswapv3', address: '0x5c6208a3c316a801f8996750aa7b6f45fc988548',
  account: { accountId: '0x455448005c', address: '0x5c6208a3c316a801f8996750aa7b6f45fc988548', emoji: '🐱', tag: null, identity: null, profile: null, isContract: true, contractName: 'UniswapV3Pool' },
  name: 'aDOT / HOLLAR 0.3%', factory: '0x776c4fd6a6170165a91ba45dec40a14bcc8ec354',
  fee: 3000, feeTier: '0.3%', tickSpacing: 60, createdBlock: 14_359_646, createdAt: '2026-09-08 10:37:24',
  token0: ADOT, token1: HOLLAR,
  assets: [{ asset: ADOT, amount: '2249585412541', usd: 258, sharePct: 2.4 }],
  tvlUsd: 10_756,
  price: { token1PerToken0: 1.156, token0PerToken1: 0.865, tick: 185_665, sqrtPriceX96: '851850665075534961304083482966456' },
  liquidity: '2805527890065543856', swaps: 1070,
  protocolFee: { feeProtocol0: 4, feeProtocol1: 4, sharePct: 25 },
  volume: { allUsd: 76_850, dayUsd: 7_038, feesAllUsd: 172, feesDayUsd: 15 },
  positions: [],
}

const OMNIPOOL_ASSET_LPS = {
  asset: ADOT, totalShares: '19606555065813221', protocolShares: '347974201169878',
  lpCount: 148, positionCount: 264, total: 149,
  lps: [{ rank: 1, account: ACCOUNT, positions: 1, farmedPositions: 0, shares: '10839458668082924', sharePct: 55.28, amount: '9214547596481730', hubAmount: '15313403352848624', valueUsd: 1_147_116 }],
}

/**
 * The money-market fixture is the load-bearing one: two ISOLATED markets on one
 * account, each with its own 1e18 health factor, 1e8 USD figures and basis-point
 * risk parameters.
 */
const ADDRESS_DETAIL = {
  input: '131d4YS25qpuXiHrfJibuFYXwZrzwxpvU1ahvr3TJFNYcmfk',
  kind: 'substrate',
  accountId: ACCOUNT.accountId,
  emoji: '🐏',
  evmAddress: null,
  ss58: '7KcBM3YRJAvhNQn5ir96h2JJf8sXQWViMGUyguZRU7qGM9Vi',
  ss58Polkadot: '131d4YS25qpuXiHrfJibuFYXwZrzwxpvU1ahvr3TJFNYcmfk',
  tag: null, identity: null, profile: null,
  relatedAccountIds: [], aliases: [], balances: [], topAssets: [], portfolioUsd: 0,
  moneyMarket: [
    {
      marketKey: 'core', market: 'Money Market', role: 'primary', defiSimSupported: true,
      blockHeight: 14_742_263, timestamp: '2026-09-18 09:11:02',
      totalCollateralBase: '78756009831283',      // 1e8 → $787,560.10
      totalSuppliedBase: '78756009831283',
      totalDebtBase: '71540903065595',            // 1e8 → $715,409.03
      availableBorrowsBase: '0',
      liquidationThreshold: '9200',               // basis points → 92.00%
      ltv: '8500',                                // basis points → 85.00%
      healthFactor: '1012784658006712473',        // 1e18 → 1.01
      reserves: [
        { assetId: 1001, symbol: 'aDOT', decimals: 10, supplied: '0', debt: '6210000000000000', suppliedUsd: 0, debtUsd: 703_000, collateral: true, marketKey: 'core' },
      ],
    },
    {
      marketKey: 'gigahdx', market: 'GIGAHDX', role: 'supplemental', defiSimSupported: false, stakingBacked: true,
      blockHeight: 14_745_393, timestamp: '2026-09-18 11:09:23',
      totalCollateralBase: '10800000000',         // 1e8 → $108
      totalSuppliedBase: '10900000000',
      totalDebtBase: '0',
      availableBorrowsBase: '4320000000',         // 1e8 → $43.20
      liquidationThreshold: '7000',               // 70.00%
      ltv: '4000',                                // 40.00%
      healthFactor: 'inf',                        // no debt at all
      reserves: [
        { assetId: 67, symbol: 'GIGAHDX', decimals: 12, supplied: '14200000000000000', debt: '0', suppliedUsd: 109, debtUsd: 0, collateral: true, marketKey: 'gigahdx' },
      ],
    },
  ],
}

const MONEY_MARKET = {
  totalSupplyUsd: 48_333_654,
  totalDebtUsd: 17_411_732,
  positions: [
    { account: ACCOUNT, supplyUsd: 787_560, debtUsd: 715_409, netWorthUsd: 72_151, healthFactor: '1012784658006712473', blockHeight: 14_742_263 },
  ],
}

const SECURITY_RISK = {
  risk: {
    windowDays: 30,
    markets: [
      { key: 'core', label: 'Money Market', role: 'primary', borrowers: 648, debtUsd: 17_411_732, collateralUsd: 30_318_921, underwaterCount: 37, underwaterDebtUsd: 8904, underwaterCollateralUsd: 0.14, badDebtCount: 30, badDebtUsd: 8904, liquidatableCount: 7, liquidatableDebtUsd: 0.03, nearLiquidationCount: 10, nearLiquidationDebtUsd: 51_232 },
      { key: 'gigahdx', label: 'GIGAHDX', role: 'supplemental', borrowers: 52, debtUsd: 504_704, collateralUsd: 2_648_353, underwaterCount: 0, underwaterDebtUsd: 0, underwaterCollateralUsd: 0, badDebtCount: 0, badDebtUsd: 0, liquidatableCount: 0, liquidatableDebtUsd: 0, nearLiquidationCount: 0, nearLiquidationDebtUsd: 0 },
    ],
    liquidations: { day: 1, week: 25, month: 177, total: 8721, lastTimestamp: '2026-09-18 02:54:12' },
  },
}

const HDX_GIGA = {
  gigaMarket: [
    { asset: { ...HDX, assetId: 670, symbol: 'stHDX', name: 'Staked HDX' }, supplied: 1_295_138_492, suppliedUsd: 10_017_784, debt: 0, debtUsd: 0, suppliers: 707, borrowers: 0 },
  ],
}

const REFERENDUM_OPENGOV = {
  pallet: 'opengov', index: 410, title: 'Reduce Omnipool weight cap for aDOT (DOT) from 30% to 10%',
  proposer: ACCOUNT, subsquareUrl: 'https://hydration.subsquare.io/referenda/410',
  track: 8, proposalHash: '0xb4ef77ca954b061d157010d381fd990dfaf533b3515bc8d2ea422336fe18ec33',
  proposalCall: { pallet: 'Omnipool', callName: 'set_asset_weight_cap', args: { assetId: 1001, cap: 100_000 }, encoded: '0x00', byteLength: 10, decodeError: null },
  status: 'confirming', enactment: null,
  submittedAt: { blockHeight: 14_714_655, extrinsicIndex: 2, timestamp: '2026-09-17 15:57:48' },
  concludedAt: null,
  asset: HDX,
  onChainTally: { ayes: '527171825353985268802', nays: '0', support: '101977326258542618397', final: false, blockHeight: 14_716_455, timestamp: '2026-09-17 17:05:12' },
  directTally: { ayes: '2755888430959574152570', nays: '474653925111406532', rawAyes: '654370578430344261387', rawNays: '125147654185234422', support: '654370578430344261387', ayeVoters: 143, nayVoters: 4, splitVoters: 0, voters: 147 },
  indirectTally: null,
  voters: [{ account: ACCOUNT, kind: 'Standard', side: 'Aye', conviction: 'Locked5x', convictionIndex: 5, balance: '64944092053624824131', ayeBalance: '0', nayBalance: '0', abstainBalance: '0', weightedAye: '324720460268124120655', weightedNay: '0', weighted: '324720460268124120655', valueUsd: 2_508_209, blockHeight: 14_722_641, eventIndex: 122, extrinsicIndex: 2, timestamp: '2026-09-17 20:58:30', removed: false }],
  votesShown: 1, votesTotal: 147,
  timeline: [{ event: 'Referenda.Submitted', blockHeight: 14_714_655, extrinsicIndex: 2, timestamp: '2026-09-17 15:57:48' }],
  trackInfo: { id: 8, name: 'omnipool_admin', preparePeriod: 1800, decisionPeriod: 302_400, confirmPeriod: 5400, minEnactmentPeriod: 300, decisionDeposit: '250000000000000000' },
  liveTally: { ayes: '2755888430959574152570', nays: '474653925111406532', support: '654370578430344261387', electorate: '4223299196615875422615' },
  progress: { phase: 'confirming', approval: { currentPerbill: 999_827_797, thresholdPerbill: 852_681_367, passing: true, source: 'chain' }, support: { currentPerbill: 154_942_898, thresholdPerbill: 146_223_423, passing: true, source: 'chain' }, projection: { state: 'passing', confirmableAtBlock: null } },
}

const SEARCH_BOTH_PALLETS = [
  { type: 'block', value: '100' },
  { type: 'referendum', value: 'opengov:100', label: 'Request TC to whitelist GIGAETH launch', pallet: 'opengov', index: 100, status: 'executed' },
  { type: 'referendum', value: 'democracy:100', label: 'HDX listed on more CEXs', pallet: 'democracy', index: 100, status: 'not passed' },
]

/* ============ get_pools ============ */

const pools = tool(poolTools, 'get_pools')

describe('get_pools', () => {
  it('routes the three identifier forms to three different upstream paths', async () => {
    const omni = fakeUpstream({ '/explorer/omnipool': OMNIPOOL })
    await pools.handler({ pool: 'omnipool' }, ctxFor(omni))
    expect(omni.calls).toEqual(['/explorer/omnipool'])

    const byId = fakeUpstream({ '/explorer/pool/690': POOL_690 })
    await pools.handler({ pool: '690' }, ctxFor(byId))
    expect(byId.calls).toEqual(['/explorer/pool/690'])

    const byAddress = fakeUpstream({ '/explorer/pool/v3/0x5c6208a3c316a801f8996750aa7b6f45fc988548': V3_POOL })
    await pools.handler({ pool: '0x5C6208A3C316A801F8996750AA7B6F45FC988548' }, ctxFor(byAddress))
    // Mixed-case input, lower-cased address — a contract is addressed one way.
    expect(byAddress.calls).toEqual(['/explorer/pool/v3/0x5c6208a3c316a801f8996750aa7b6f45fc988548'])
  })

  it('refuses an identifier that is none of the three forms', async () => {
    const out = await run(pools, { pool: 'GDOT pool' }, {})
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(out.markdown).toBe('')
  })

  it('trims the directory and says how much of it is shown', async () => {
    const out = await run(pools, { limit: 2 }, { '/explorer/pools': POOLS_INDEX })
    expect(out.markdown).toContain('Showing the 2 largest of 4 pools')
    // The dead XYK pool is counted but not hidden from the tally.
    expect(out.markdown).toContain('4 (1 hold no liquidity)')
    expect(out.markdown).toContain('Omnipool')
    expect(out.markdown).not.toContain('WUD / DOT')
  })

  it('states the Omnipool weight cap as at or OVER, never as a single warning', async () => {
    const out = await run(pools, { pool: 'omnipool' }, { '/explorer/omnipool': OMNIPOOL })
    expect(out.markdown).toContain('20% ⚠ at cap')   // HOLLAR 19.48 against 20
    expect(out.markdown).toContain('1% ⚠ over cap')  // HDX 10.14 against 1
    // The hub asset is H2O everywhere, never its legacy spelling.
    expect(out.markdown).toContain('H2O')
    expect(out.markdown).not.toContain('LRNA')
  })

  it('summarises a history series instead of printing its points', async () => {
    const out = await run(pools, { pool: 'omnipool', include: ['history'] }, { '/explorer/omnipool': OMNIPOOL })
    expect(out.markdown).toContain('Buckets')
    expect(out.markdown).toContain('2026-09-16 → 2026-09-17')
    expect(JSON.stringify(out.json)).not.toContain('"history"')
  })

  it('scales a stableswap pool and decodes its permill and perbill parameters', async () => {
    const out = await run(pools, { pool: '690' }, { '/explorer/pool/690': POOL_690 })
    // The decode, not the sentence around it: feePermill 690 is 0.069%, and the
    // raw 690 must never be read as the percentage.
    expect(out.markdown).toMatch(/0\.069%[^\n]*690/)
    expect(out.markdown).not.toMatch(/\*\*Swap fee:\*\* 690/)
    expect(out.markdown).toContain('0.000012% per block')
    // 3974062929712950057703944 raw / 1e18 share-token decimals.
    expect(out.markdown).toContain('3.97M issued')
    expect(out.markdown).not.toContain('3974062929712950057703944')
  })

  it('falls back to the Omnipool sub-pool when an id is an asset rather than a share token', async () => {
    const upstream = fakeUpstream({ '/explorer/omnipool/1001/lps': OMNIPOOL_ASSET_LPS })
    const out = await pools.handler({ pool: '1001' }, ctxFor(upstream))
    expect(upstream.calls[0]).toBe('/explorer/pool/1001')
    expect(upstream.calls[1]).toContain('/explorer/omnipool/1001/lps')
    expect(out.markdown).toContain('No pool has share-token id 1001')
    expect(out.markdown).toContain('aDOT (#1001) in the Omnipool')
  })

  it('says a delisted asset is not in the Omnipool instead of raising a bare 404', async () => {
    const upstream = fakeUpstream({
      '/explorer/omnipool/5/lps': new UpstreamError('Asset not in the Omnipool', 404, { error: 'Asset not in the Omnipool' }, '/explorer/omnipool/5/lps'),
    })
    const out = await pools.handler({ pool: '5' }, ctxFor(upstream))
    expect(out.markdown).toContain('not listed in the Omnipool')
    expect(out.markdown).toContain('DELISTED')
    expect(out.markdown).toContain('DOT, asset id 5')
    // The upstream 404 is ANSWERED, not forwarded: the reply is a statement of
    // what is true about asset 5, with no error section and nothing that reads
    // as an outage an agent should retry. A bare NOT_FOUND here would send it
    // looking for a different identifier for an asset it named correctly.
    expect(out.errors ?? [], 'a delisted asset is an answer, not a partial failure').toEqual([])
    expect(out.markdown).not.toMatch(/UPSTREAM_UNAVAILABLE|retry/i)
    // Long enough to be that statement rather than a one-line refusal.
    expect(out.markdown.length).toBeGreaterThan(200)
  })

  it('returns the rest when an enrichment fails', async () => {
    const out = await run(pools, { pool: '690', include: ['composition', 'lps'] }, { '/explorer/pool/690': POOL_690 })
    expect(out.markdown).toContain('2-Pool-GDOT')
    expect(out.errors?.some(e => e.message.includes('liquidity providers'))).toBe(true)
  })

  it('never prints a v3 liquidity value as a raw integer', async () => {
    const out = await run(pools, { pool: V3_POOL.address }, { [`/explorer/pool/v3/${V3_POOL.address}`]: V3_POOL })
    expect(out.markdown).not.toContain('2805527890065543856')
    expect(out.markdown).toContain('sqrt-price liquidity unit')
  })

  it('answers format json with a record that parses', async () => {
    const out = await run(pools, { format: 'json', limit: 2 }, { '/explorer/pools': POOLS_INDEX })
    const parsed = JSON.parse(JSON.stringify(out.json)) as { poolCount: number; shown: unknown[] }
    expect(parsed.poolCount).toBe(4)
    expect(parsed.shown).toHaveLength(2)
  })
})

/* ============ get_money_market ============ */

const mm = tool(moneyMarketTools, 'get_money_market')
const MM_ROUTES = {
  '/explorer/money-market': MONEY_MARKET,
  '/explorer/security': SECURITY_RISK,
  '/explorer/hdx': HDX_GIGA,
  [`/explorer/address/${ADDRESS_DETAIL.input}`]: ADDRESS_DETAIL,
}

describe('get_money_market', () => {
  it('renders each isolated market separately and never blends them', async () => {
    const out = await run(mm, { account: ADDRESS_DETAIL.input }, MM_ROUTES)
    expect(out.markdown).toContain('Money Market (`core`, primary)')
    expect(out.markdown).toContain('GIGAHDX market (`gigahdx`, supplemental)')
    // Both health factors survive, each attached to its own market.
    expect(out.markdown).toContain('1.0128 — in the Money Market only')
    expect(out.markdown).toContain('∞ (no debt) — in the GIGAHDX market only')
    // Exactly two health factors, one per market: never a third, combined one.
    const stated = out.markdown.match(/\*\*Health factor:\*\*/g) ?? []
    expect(stated).toHaveLength(2)
    expect(out.markdown).toContain('never blended across markets')
  })

  it('names the market that carries the account\'s risk, using the lowest REAL health factor', async () => {
    const out = await run(mm, { account: ADDRESS_DETAIL.input }, MM_ROUTES)
    expect(out.markdown).toContain('For this account, the LOWEST real health factor is **1.0128**, in the Money Market')
    // 'inf' is not a number on that scale and must not win the comparison.
    expect(out.markdown).not.toContain('LOWEST real health factor is **∞')
  })

  // With only ONE numeric health factor in the fixture above, every selection
  // rule picks the same market — the comparison can be inverted and nothing
  // fails. These two give it a real choice, and the second makes the
  // SUPPLEMENTAL market the riskier one, so "lowest" cannot be spelled
  // "primary" by accident either.
  it('compares real health factors rather than picking a market by position', async () => {
    const withTwoRealFactors = {
      ...ADDRESS_DETAIL,
      moneyMarket: [
        { ...ADDRESS_DETAIL.moneyMarket[0], healthFactor: '2500000000000000000' },  // 1e18 → 2.5
        { ...ADDRESS_DETAIL.moneyMarket[1], totalDebtBase: '5000000000', healthFactor: '1200000000000000000' }, // → 1.2
      ],
    }
    const out = await run(mm, { account: ADDRESS_DETAIL.input }, {
      ...MM_ROUTES,
      [`/explorer/address/${ADDRESS_DETAIL.input}`]: withTwoRealFactors,
    })
    expect(out.markdown).toContain('LOWEST real health factor is **1.2000**, in the GIGAHDX')
    expect(out.markdown).not.toContain('LOWEST real health factor is **2.5000**')
  })

  // The second sentinel. A supplemental market with debt the explorer cannot
  // rate reports 'unknown', which is NOT 'no debt': reading it as either a
  // number or as safety tells an agent this account is clear when the one
  // market that could liquidate it was never rated.
  it('treats an unrated market as unrated, not as safe and not as a number', async () => {
    const withUnknown = {
      ...ADDRESS_DETAIL,
      moneyMarket: [
        ADDRESS_DETAIL.moneyMarket[0],
        { ...ADDRESS_DETAIL.moneyMarket[1], totalDebtBase: '5000000000', healthFactor: 'unknown' },
      ],
    }
    const out = await run(mm, { account: ADDRESS_DETAIL.input }, {
      ...MM_ROUTES,
      [`/explorer/address/${ADDRESS_DETAIL.input}`]: withUnknown,
    })
    // Never rendered as infinity, as zero, or as the raw sentinel dressed as a figure.
    expect(out.markdown).not.toContain('∞ (no debt) — in the GIGAHDX')
    expect(out.markdown).not.toContain('**Health factor:** 0')
    // The ranking still names the market it could rate, and only that one.
    expect(out.markdown).toContain('LOWEST real health factor is **1.0128**, in the Money Market')
  })

  it('decodes the three encodings that share one position object', async () => {
    const out = await run(mm, { account: ADDRESS_DETAIL.input, market: 'core' }, MM_ROUTES)
    expect(out.markdown).toContain('1.01')          // healthFactor, 1e18
    expect(out.markdown).toContain('$788k')         // totalCollateralBase, 1e8
    expect(out.markdown).toContain('$715k')         // totalDebtBase, 1e8
    expect(out.markdown).toContain('85.00%')        // ltv, basis points
    expect(out.markdown).toContain('92.00%')        // liquidationThreshold, basis points
    // None of the raw encodings leak through.
    expect(out.markdown).not.toContain('1012784658006712473')
    expect(out.markdown).not.toContain('78756009831283')
    expect(out.markdown).not.toContain('8500')
  })

  it('renders the account under its canonical display address, not the prefix-63 form', async () => {
    const out = await run(mm, { account: ADDRESS_DETAIL.input }, MM_ROUTES)
    expect(out.markdown).toContain(ADDRESS_DETAIL.ss58Polkadot)
    expect(out.markdown).not.toContain(ADDRESS_DETAIL.ss58)
  })

  it('calls the primary totals what the upstream actually sums, and publishes no false utilisation', async () => {
    // `/explorer/money-market` answers sum(total_collateral_base) and
    // sum(total_debt_base) over the primary market's positions. Labelled "Total
    // supplied" it overstates supply, and debt over collateral is not
    // utilisation — utilisation is borrowed over supplied per reserve, which
    // this API does not publish at all.
    const out = await run(mm, {}, MM_ROUTES)
    expect(out.markdown).toContain('Collateral pledged')
    expect(out.markdown).not.toContain('Total supplied')
    expect(out.markdown).not.toMatch(/\*\*Utilisation:\*\*/)
    expect(out.markdown).toContain('not utilisation')
    // The same market's collateral appears twice with different totals because
    // the two routes count different sets; the table says which is which.
    expect(out.markdown).toContain("Borrowers' collateral")
    const json = out.json as { primaryMarketTotals: { collateralPledgedUsd: number; borrowedUsd: number } }
    expect(json.primaryMarketTotals.collateralPledgedUsd).toBe(48_333_654)
    expect(json.primaryMarketTotals).not.toHaveProperty('totalSupplyUsd')
  })

  it('states when the figures were taken, on the protocol view as well as the account one', async () => {
    const out = await run(mm, {}, MM_ROUTES)
    expect(out.markdown).toContain('As of the money-market snapshot at block 14,742,263')
    const json = out.json as { asOfBlock: number | null }
    expect(json.asOfBlock).toBe(14_742_263)
  })

  it('filters to one market and refuses a market that does not exist', async () => {
    const one = await run(mm, { market: 'gigahdx' }, MM_ROUTES)
    expect(one.markdown).toContain('GIGAHDX')
    expect(one.markdown).not.toContain('Money Market (`core`)')
    // A narrowed request must not open with another market's totals or its
    // borrower list.
    expect(one.markdown).not.toContain('Collateral pledged')
    expect(one.markdown).not.toContain('Riskiest borrowers')
    expect(one.markdown).toContain("left out, because they are another market's numbers")
    expect((one.json as { primaryMarketTotals: unknown }).primaryMarketTotals).toBeNull()
    // The primary market by name still gets them.
    const core = await run(mm, { market: 'core' }, MM_ROUTES)
    expect(core.markdown).toContain('Collateral pledged')

    const bad = await run(mm, { market: 'nope' }, MM_ROUTES)
    expect(bad.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(bad.errors?.[0].message).toContain('GIGAHDX')
  })

  it('shows the GIGAHDX reserve table and says which market it belongs to', async () => {
    const out = await run(mm, {}, MM_ROUTES)
    expect(out.markdown).toContain('GIGAHDX market reserves')
    expect(out.markdown).toContain('stHDX (#670)')
    expect(out.markdown).toContain('belong to the GIGAHDX market alone')
  })

  it('answers format json with a record that parses', async () => {
    const out = await run(mm, { format: 'json', account: ADDRESS_DETAIL.input }, MM_ROUTES)
    const parsed = JSON.parse(JSON.stringify(out.json)) as { markets: { key: string }[]; account: { positions: { marketKey: string }[] } }
    expect(parsed.markets.map(m => m.key)).toEqual(['core', 'gigahdx'])
    expect(parsed.account.positions.map(p => p.marketKey)).toEqual(['core', 'gigahdx'])
  })
})

/* ============ get_governance ============ */

const gov = tool(governanceTools, 'get_governance')

describe('get_governance', () => {
  it('refuses an index that exists in both pallets, naming both', async () => {
    const out = await run(gov, { kind: 'referendum', index: 100 }, { '/explorer/search': SEARCH_BOTH_PALLETS })
    expect(out.errors?.[0].code).toBe('INVALID_ARGUMENT')
    expect(out.errors?.[0].message).toContain('opengov #100')
    expect(out.errors?.[0].message).toContain('democracy #100')
    expect(out.markdown).toBe('')
  })

  it('resolves an unambiguous index through search and says which pallet it took', async () => {
    const upstream = fakeUpstream({
      '/explorer/search': [SEARCH_BOTH_PALLETS[1]],
      '/explorer/referendum/opengov/100': { ...REFERENDUM_OPENGOV, index: 100 },
      '/explorer/stats': { nominalBlockSec: 2 },
    })
    const out = await gov.handler({ kind: 'referendum', index: 100 }, ctxFor(upstream))
    expect(out.markdown).toContain('Only the opengov pallet has a referendum #100')
    expect(upstream.calls).toContain('/explorer/referendum/opengov/100?limit=25')
  })

  it('reads the pallet it is given without a search round trip', async () => {
    const upstream = fakeUpstream({
      '/explorer/referendum/democracy/100': { ...REFERENDUM_OPENGOV, pallet: 'democracy', index: 100, trackInfo: null, track: null, onChainTally: null, liveTally: null, progress: null, proposer: null },
      '/explorer/stats': { nominalBlockSec: 2 },
    })
    await gov.handler({ kind: 'referendum', pallet: 'democracy', index: 100 }, ctxFor(upstream))
    expect(upstream.calls.some(c => c.startsWith('/explorer/search'))).toBe(false)
  })

  it('states the support definition wherever it prints support', async () => {
    const out = await run(gov, { kind: 'referendum', pallet: 'opengov', index: 410 }, {
      '/explorer/referendum/opengov/410': REFERENDUM_OPENGOV,
      '/explorer/stats': { nominalBlockSec: 2 },
    })
    expect(out.markdown).toContain('counting aye plus abstain and EXCLUDING nay')
    // support 654370578430344261387 / 1e12 = 654,370,578 HDX
    expect(out.markdown).toContain('654M HDX')
    expect(out.markdown).toContain('of the 4.22B HDX electorate')
  })

  it('turns a track\'s block periods into durations at the nominal slot time', async () => {
    const out = await run(gov, { kind: 'referendum', pallet: 'opengov', index: 410 }, {
      '/explorer/referendum/opengov/410': REFERENDUM_OPENGOV,
      '/explorer/stats': { nominalBlockSec: 2 },
    })
    expect(out.markdown).toContain('302,400 blocks (7d)')
    expect(out.markdown).toContain('nominal slot time')
  })

  it('renders a Democracy referendum without inventing a track or an on-chain tally', async () => {
    const out = await run(gov, { kind: 'referendum', pallet: 'democracy', index: 100 }, {
      '/explorer/referendum/democracy/100': { ...REFERENDUM_OPENGOV, pallet: 'democracy', index: 100, track: null, trackInfo: null, onChainTally: null, liveTally: null, progress: null, proposer: null },
      '/explorer/stats': { nominalBlockSec: 2 },
    })
    expect(out.markdown).toContain('none (Democracy has no tracks)')
    expect(out.markdown).toContain('keeps no on-chain tally snapshot')
    expect(out.markdown).toContain('a Democracy referendum is tabled from a queue')
  })

  it('reads both collectives, because the upstream body parameter is required', async () => {
    const upstream = fakeUpstream({ '/explorer/governance/motions': { total: 0, rows: [] } })
    await gov.handler({ kind: 'motions' }, ctxFor(upstream))
    expect(upstream.calls).toEqual(['/explorer/governance/motions?body=tc&limit=25', '/explorer/governance/motions?body=council&limit=25'])
  })

  it('scales a tip payout out of HDX raw units', async () => {
    const out = await run(gov, { kind: 'tips' }, {
      '/explorer/governance/tips': { total: 1, rows: [{ hash: '0xabc', reason: 'https://example/posts/1', beneficiary: ACCOUNT, payout: '370441000000000000', status: 'closed', openedAt: { blockHeight: 1, timestamp: '2024-11-03 16:12:24' }, closedAt: null }] },
    })
    expect(out.markdown).toContain('370k HDX')
    expect(out.markdown).not.toContain('370441000000000000')
  })

  it('answers format json with a record that parses', async () => {
    const out = await run(gov, { kind: 'referendum', pallet: 'opengov', index: 410, format: 'json' }, {
      '/explorer/referendum/opengov/410': REFERENDUM_OPENGOV,
      '/explorer/stats': { nominalBlockSec: 2 },
    })
    const parsed = JSON.parse(JSON.stringify(out.json)) as { pallet: string; index: number; directTally: { support: string } }
    expect(parsed.pallet).toBe('opengov')
    expect(parsed.index).toBe(410)
    expect(parsed.directTally.support).toBe('654370578430344261387')
  })
})
