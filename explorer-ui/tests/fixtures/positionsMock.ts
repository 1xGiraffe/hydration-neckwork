// Deterministic fixtures for the Orders · Liquidity · Borrow tabs, spliced into
// mockApi's ROUTES ahead of the address/tag catch-alls. Each tab keeps its own
// section; row identities (ids, blocks, pools) match the account/tag fixtures
// they sit beside, so a row links to the same order/pool everywhere.
import type { AccountRef, AssetRef, ExplorerYields, LiquidityHistory, LiquidityRewardsClaimed, MoneyMarketHistory, OrderHistoryPage, OrderHistoryRow, PositionsPresence } from '../../src/types'

type MockRoute = { re: RegExp; fn: (m: RegExpMatchArray, qs: URLSearchParams) => unknown }

// ── shared ────────────────────────────────────────────────────────────────
export function mockPresence(): PositionsPresence {
  return { orderHistory: MOCK_ORDER_HISTORY_TOTAL, liquidityHistory: false, moneyMarketHistory: false }
}

// ── Orders ────────────────────────────────────────────────────────────────
// Forty finished orders, newest end first, cycling through every kind and
// finished status. Self-contained on purpose (mockApi imports this module, so
// importing its tables back would be a cycle): the assets, accounts and time
// base restate mockApi's own (TIP, tsAt, ASSETS ids/decimals/prices, the fox and
// Kraken members), so a row's pair, owner and times agree with the pages it
// links to. Intent ids follow mockIntentOrder's parity rule — an odd low-64-bit
// sequence is a DCA intent, an even one a swap (limit) intent.
const ORD_TIP = 12_848_613
const ORD_NOW_MS = Date.UTC(2026, 6, 15, 12)
const ordTs = (h: number) => new Date(ORD_NOW_MS - (ORD_TIP - h) * 6000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
const ordRaw = (v: number, dec: number) => BigInt(Math.round(v * 1e6)).toString() + '0'.repeat(Math.max(0, dec - 6))
const ORD_U64 = 1n << 64n
type OrdAsset = AssetRef & { price: number }
const ORD_ASSET: Record<string, OrdAsset> = {
  HDX: { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null, price: 0.02184 },
  DOT: { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null, price: 4.4422 },
  USDT: { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000, price: 1.0001 },
  vDOT: { assetId: 15, symbol: 'vDOT', name: 'Voucher DOT', decimals: 10, parachainId: 2030, price: 5.8401 },
  WBTC: { assetId: 19, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, parachainId: 1000, price: 67241.1 },
  WETH: { assetId: 20, symbol: 'WETH', name: 'Wrapped ETH', decimals: 18, parachainId: 1000, price: 3204.4 },
  HOLLAR: { assetId: 1000, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachainId: null, price: 1.0 },
}
const ORD_KRAKEN_TAG = { id: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg' }
const ORD_OWNERS: AccountRef[] = [
  { accountId: '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899', address: '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr', emoji: '🦊', tag: null, identity: { display: 'StakerNode', verified: true, email: 'info@stakernode.com', web: 'https://stakernode.com/', twitter: '@NodeStaker' } },
  { accountId: '0xf73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad', address: '0xF73a2B8c1D4e9A06b5C8f2E1a3D70c9B4e6F18aD', emoji: '🦑', tag: ORD_KRAKEN_TAG, identity: null },
  { accountId: '0x9d8bafc9cbe3ae4f1a7c4d2e0b9f86dc31aa5e72aa11bb22cc33dd44ee55ff66', address: '1MqRsT3uV4wX5yZ6aB7cD8eF9gH0iJ1kL2mN3pQ4rS5tU6v', emoji: '🦑', tag: ORD_KRAKEN_TAG, identity: null },
]
// One row per variant in turn: [kind, status, in, out, statusReason].
const ORD_VARIANTS: [OrderHistoryRow['kind'], OrderHistoryRow['status'], string, string, string | null][] = [
  ['dca', 'completed', 'HDX', 'USDT', null],
  ['limit', 'filled', 'DOT', 'HDX', null],
  ['dca-intent', 'completed', 'DOT', 'HDX', null],
  ['dca', 'terminated', 'USDT', 'vDOT', 'TradeLimitReached'],
  ['limit', 'expired', 'WETH', 'HOLLAR', null],
  ['dca', 'migrated', 'HOLLAR', 'WBTC', null],
  ['dca-intent', 'cancelled', 'USDT', 'DOT', null],
  ['limit', 'cancelled', 'HDX', 'DOT', null],
  ['dca', 'cancelled', 'DOT', 'USDT', null],
  ['dca', 'migration-cancelled', 'vDOT', 'DOT', 'Schedule budget below the intent minimum'],
]
export const MOCK_ORDER_HISTORY_TOTAL = 40
function mockOrderRows(owners: AccountRef[]): OrderHistoryRow[] {
  return Array.from({ length: MOCK_ORDER_HISTORY_TOTAL }, (_, i) => {
    const [kind, status, inSym, outSym, statusReason] = ORD_VARIANTS[i % ORD_VARIANTS.length]
    const assetIn = ORD_ASSET[inSym], assetOut = ORD_ASSET[outSym]
    const endedBlock = ORD_TIP - 1200 - i * 3100 - (i % 3) * 37
    const openedBlock = endedBlock - 4000 - (i % 7) * 900
    // The first cancelled pallet schedule is mockApi's /dca/33573 — two failed
    // attempts and no trade — so its row and its page tell one story.
    const isFixtureSchedule = kind === 'dca' && status === 'cancelled' && i < ORD_VARIANTS.length
    const noTrade = isFixtureSchedule || status === 'expired' || (kind === 'limit' && status === 'cancelled')
    const trades = noTrade ? 0 : kind === 'limit' ? 1 + (i % 3) : 4 + (i * 7) % 40
    const soldUsdTarget = noTrade ? 0 : 120 + ((i * 7919) % 9000)
    const sold = soldUsdTarget / assetIn.price
    const received = soldUsdTarget * 0.994 / assetOut.price
    const seq = kind === 'limit' ? 1000 + 2 * i : 1001 + 2 * i
    const id = kind === 'dca' ? String(isFixtureSchedule ? 33573 : 33400 - i * 7) : (ORD_U64 * BigInt(3 + i) + BigInt(seq)).toString()
    return {
      kind, id, ...(kind === 'dca' ? {} : { seq }),
      who: owners[i % owners.length], assetIn, assetOut,
      direction: kind === 'dca' ? (i % 4 === 3 ? 'Buy' : 'Sell') : null,
      status, statusReason,
      migratedToIntentId: status === 'migrated' ? (ORD_U64 * BigInt(90 + i) + BigInt(2001 + 2 * i)).toString() : null,
      budgetAmount: kind === 'limit' ? ordRaw(Math.max(sold, 100 / assetIn.price), assetIn.decimals) : i % 8 === 0 ? '0' : ordRaw(sold * 1.25 + 1, assetIn.decimals),
      soldAmount: noTrade ? '0' : ordRaw(sold, assetIn.decimals),
      receivedAmount: noTrade ? '0' : ordRaw(received, assetOut.decimals),
      // Every fifteenth order traded in a stretch with no closed candle.
      soldUsd: noTrade ? null : i % 15 === 14 ? null : soldUsdTarget,
      trades,
      failedTrades: isFixtureSchedule ? 2 : status === 'terminated' ? 3 : kind === 'dca' && i % 4 === 1 ? 1 : 0,
      openedBlock, openedIndex: kind === 'dca' ? 2 : 3, openedAt: ordTs(openedBlock),
      endedBlock, endedEventIndex: 4 + (i % 5), endedAt: ordTs(endedBlock),
    }
  })
}
// `path` is the matched request path: an account reads as its own orders, a tag
// (system or list) as its members' in turn.
export function mockOrderHistory(qs: URLSearchParams, path = ''): OrderHistoryPage {
  const offset = Math.max(0, Number(qs.get('offset') ?? 0)), limit = Math.max(1, Number(qs.get('limit') ?? 25))
  const kind = qs.get('kind')
  const addr = /\/address\/([^/]+)\//.exec(path)?.[1]
  const owners = addr
    ? [ORD_OWNERS.find(o => o.address.toLowerCase() === decodeURIComponent(addr).toLowerCase()) ?? { accountId: decodeURIComponent(addr), address: decodeURIComponent(addr), emoji: '👤', tag: null }]
    : ORD_OWNERS.slice(1)
  const rows = mockOrderRows(owners).filter(r => kind === 'dca' ? r.kind !== 'limit' : kind === 'limit' ? r.kind === 'limit' : true)
  return { total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) }
}

// ── Liquidity ─────────────────────────────────────────────────────────────
// One holder's LP book across every venue the tab groups: the fox account's
// Omnipool DOT (bare + farmed NFT), 2-Pool-GDOT in the Omnipool and as wallet
// shares, the HDX/DOT XYK pair (1000194, bare + farmed) and a concentrated-
// liquidity pool (an NFT priced, a vault share unpriced). The base account/tag
// fixtures ship no LP rows, so a spec splices these in with withMockLiquidity.
import type { FarmRewardsSummary, LiquidityHistoryPosition, LpPosition } from '../../src/types'

const LQ = {
  hdx: { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null },
  dot: { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null },
  glmr: { assetId: 16, symbol: 'GLMR', name: 'Moonbeam', decimals: 18, parachainId: 2004 },
  hollar: { assetId: 1000, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachainId: null },
  gdot: { assetId: 1001, symbol: 'GDOT', name: 'Gigadot', decimals: 10, parachainId: null },
  gdotPool: { assetId: 690, symbol: '2-Pool-GDOT', name: 'GDOT stable pool', decimals: 18, parachainId: null },
  xykLp: { assetId: 1000194, symbol: 'HDX/DOT', name: 'HDX / DOT LP', decimals: 12, parachainId: null },
} satisfies Record<string, AssetRef>
export const MOCK_V3_POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
const LQ_OWNER: AccountRef = { accountId: '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899', address: '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr', emoji: '🦊', tag: null }
const lqRaw = (v: number, dec: number): string => (BigInt(Math.round(v * 1e6)) * 10n ** BigInt(dec) / 1_000_000n).toString()

const LQ_FARM_ITEMS = [
  { depositId: '9001', positionId: '71062', globalFarmId: 1, yieldFarmId: 11, venue: 'Omnipool Farm' as const, farmState: 'active' as const, asset: LQ.hdx, claimable: lqRaw(12_400, 12), claimableUsd: 270.82, forfeitIfWithdrawnNow: lqRaw(7_440, 12), projected: true, belowExistentialDeposit: false, payable: true, loyaltyPct: 62.5, lastSyncPeriod: 27_400_000 },
  { depositId: '9001', positionId: '71062', globalFarmId: 2, yieldFarmId: 12, venue: 'Omnipool Farm' as const, farmState: 'active' as const, asset: LQ.dot, claimable: lqRaw(1.2, 10), claimableUsd: 5.33, forfeitIfWithdrawnNow: lqRaw(0.72, 10), projected: true, belowExistentialDeposit: false, payable: true, loyaltyPct: 62.5, lastSyncPeriod: 27_400_000 },
  { depositId: '9002', positionId: 'xyk:1000194:farm', globalFarmId: 3, yieldFarmId: 21, venue: 'XYK Farm' as const, farmState: 'active' as const, asset: LQ.hdx, claimable: lqRaw(0.4, 12), claimableUsd: 0, forfeitIfWithdrawnNow: lqRaw(0.9, 12), projected: true, belowExistentialDeposit: true, payable: false, loyaltyPct: 30, lastSyncPeriod: 27_400_000 },
]
export const MOCK_FARM_REWARDS: FarmRewardsSummary = { asOfBlock: 9_870_000, totalUsd: 276.15, items: LQ_FARM_ITEMS }
const lqUnclaimed = (positionId: string) => LQ_FARM_ITEMS.filter(i => i.positionId === positionId).map(i => ({
  depositId: i.depositId, globalFarmId: i.globalFarmId, yieldFarmId: i.yieldFarmId, asset: i.asset, amount: i.claimable,
  valueUsd: i.claimableUsd, projected: i.projected, belowExistentialDeposit: i.belowExistentialDeposit, payable: i.payable,
}))

export function mockLiquidityPositions(withOwner = false): LpPosition[] {
  const owner = withOwner ? { owner: LQ_OWNER } : {}
  return [
    { positionId: '71061', asset: LQ.dot, amount: lqRaw(1_200, 10), hubAmount: lqRaw(150, 12), shares: lqRaw(1_180, 10), valueUsd: 6_180, venue: 'Omnipool', ...owner },
    { positionId: '71062', asset: LQ.dot, amount: lqRaw(800, 10), hubAmount: lqRaw(40, 12), shares: lqRaw(790, 10), valueUsd: 3_620, venue: 'Omnipool Farm', unclaimedRewards: lqUnclaimed('71062'), ...owner },
    { positionId: '71100', asset: LQ.gdotPool, amount: lqRaw(500, 18), shares: lqRaw(500, 18), valueUsd: 2_550, venue: 'Omnipool', ...owner },
    { positionId: 'share-690', asset: LQ.gdotPool, amount: lqRaw(200, 18), shares: lqRaw(200, 18), valueUsd: 1_020, venue: 'Stablepool' },
    { positionId: 'xyk:1000194:farm', asset: LQ.hdx, amount: lqRaw(19_230, 12), assetB: LQ.dot, amountB: lqRaw(94.5, 10), shares: lqRaw(3_000, 12), valueUsd: 840, venue: 'XYK Farm', unclaimedRewards: lqUnclaimed('xyk:1000194:farm') },
    { positionId: 'xyk:1000194:direct', asset: LQ.hdx, amount: lqRaw(9_390, 12), assetB: LQ.dot, amountB: lqRaw(46.1, 10), shares: lqRaw(1_465, 12), valueUsd: 410, venue: 'XYK' },
    { positionId: 'v3:0xd5a1:1', asset: LQ.dot, amount: lqRaw(214, 10), assetB: LQ.hollar, amountB: lqRaw(950, 18), shares: '0', valueUsd: 1_900, venue: 'Uniswap v3', poolAddress: MOCK_V3_POOL, tokenId: '1' },
    { positionId: 'gamma:0xa2b3', asset: LQ.dot, amount: lqRaw(12, 10), assetB: LQ.hollar, amountB: lqRaw(55, 18), shares: lqRaw(10, 18), valueUsd: null, venue: 'Gamma vault', poolAddress: MOCK_V3_POOL },
  ]
}

/** An account/tag detail with the Liquidity fixture's positions and farm rewards spliced in. */
export function withMockLiquidity<T extends object>(detail: T, withOwner = false): T {
  return { ...detail, liquidityPositions: mockLiquidityPositions(withOwner), farmRewards: MOCK_FARM_REWARDS }
}

export function mockYields(): ExplorerYields {
  return {
    asOf: '2026-09-25T00:00:00.000Z', feeWindow: '30d',
    omnipool: {
      5: {
        totalAprPct: 16.02,
        components: [{ kind: 'omnipool-fee', aprPct: 4.12 }, { kind: 'farm', aprPct: 9.8, asset: LQ.hdx }, { kind: 'farm', aprPct: 2.1, asset: LQ.dot }],
        farms: [{ globalFarmId: 1, yieldFarmId: 11, rewardAsset: LQ.hdx, aprPct: 9.8 }, { globalFarmId: 2, yieldFarmId: 12, rewardAsset: LQ.dot, aprPct: 2.1 }],
      },
      690: {
        totalAprPct: 9.25,
        components: [{ kind: 'omnipool-fee', aprPct: 1.9 }, { kind: 'stablepool-fee', aprPct: 0.85 }, { kind: 'mm-supply', aprPct: 5.6, asset: LQ.gdot, weightPct: 50 }, { kind: 'mm-incentive', aprPct: 0.9, asset: LQ.hdx, weightPct: 50 }],
        farms: [],
      },
    },
    stableswap: {
      690: {
        totalAprPct: 7.35,
        components: [{ kind: 'stablepool-fee', aprPct: 0.85 }, { kind: 'mm-supply', aprPct: 5.6, asset: LQ.gdot, weightPct: 50 }, { kind: 'mm-incentive', aprPct: 0.9, asset: LQ.hdx, weightPct: 50 }],
        farms: [],
      },
    },
    xyk: {
      1000194: {
        totalAprPct: 17.4,
        components: [{ kind: 'xyk-fee', aprPct: 3.4 }, { kind: 'farm', aprPct: 14, asset: LQ.hdx }],
        farms: [{ globalFarmId: 3, yieldFarmId: 21, rewardAsset: LQ.hdx, aprPct: 14 }],
      },
    },
    // The v3 fee window has no TVL to divide by here: an unknown rate, never 0%.
    uniswapV3: { [MOCK_V3_POOL]: { totalAprPct: null, components: [{ kind: 'v3-fee', aprPct: null }], farms: [] } },
    moneyMarket: mockMoneyMarketYields(),
  }
}

export function mockLiquidityRewards(): LiquidityRewardsClaimed {
  return {
    rows: [
      { pallet: 'omnipool', poolAsset: LQ.dot, rewardAsset: LQ.hdx, amount: lqRaw(250_000, 12), valueUsd: 4_870.2, unpricedClaims: 0, claims: 14, firstAt: '2026-03-02T09:12:00.000Z', lastAt: '2026-09-20T18:40:00.000Z' },
      { pallet: 'omnipool', poolAsset: LQ.dot, rewardAsset: LQ.dot, amount: lqRaw(20, 10), valueUsd: 98.4, unpricedClaims: 0, claims: 3, firstAt: '2026-06-11T07:00:00.000Z', lastAt: '2026-09-20T18:40:00.000Z' },
      { pallet: 'xyk', poolAsset: LQ.xykLp, rewardAsset: LQ.hdx, amount: lqRaw(30_000, 12), valueUsd: 610, unpricedClaims: 1, claims: 5, firstAt: '2026-04-18T12:00:00.000Z', lastAt: '2026-08-30T12:00:00.000Z' },
      { pallet: 'omnipool', poolAsset: LQ.glmr, rewardAsset: LQ.hdx, amount: lqRaw(8_000, 12), valueUsd: 150, unpricedClaims: 0, claims: 2, firstAt: '2026-01-05T10:00:00.000Z', lastAt: '2026-05-01T10:00:00.000Z' },
    ],
    totalClaimedUsd: 5_728.6,
    unpricedClaims: 1,
  }
}

const LQ_DAYS = 60
const LQ_FIRST_BLOCK = 9_010_000
const LQ_BLOCKS_PER_DAY = 14_400
const LQ_DAY0_MS = Date.UTC(2026, 6, 27)
export function mockLiquidityHistory(): LiquidityHistory {
  const dates = Array.from({ length: LQ_DAYS }, (_, i) => new Date(LQ_DAY0_MS + i * 86_400_000).toISOString())
  const blocks = dates.map((_, i) => LQ_FIRST_BLOCK + i * LQ_BLOCKS_PER_DAY)
  const valueUsd = dates.map((_, i) => Math.round((11_000 + i * 90 + Math.sin(i / 5) * 700) * 100) / 100)
  // Rewards accrue, then a claim empties them every 15 days.
  const unclaimedRewardsUsd = dates.map((_, i) => Math.round((i % 15) * 18.4 * 100) / 100)
  const unpriced = dates.map((_, i) => (i >= 10 && i < 13 ? 1 : 0))
  const rewardsIncomplete = dates.map(() => 0)
  const at = (day: number) => ({ block: LQ_FIRST_BLOCK + day * LQ_BLOCKS_PER_DAY, time: dates[day] ?? null })
  const pos = (venue: LiquidityHistoryPosition['venue'], farmed: boolean, positionId: string | null, poolKey: string, shareAsset: AssetRef | null, legs: AssetRef[], from: number, to: number | null, value: number | null): LiquidityHistoryPosition => ({
    venue, farmed, positionId, poolKey, shareAsset,
    spans: [{ fromBlock: at(from).block, fromTime: at(from).time, toBlock: to == null ? null : at(to).block, toTime: to == null ? null : at(to).time, kind: farmed ? 'farmed' : 'direct' }],
    points: [{ i: Math.min(to ?? LQ_DAYS - 1, LQ_DAYS - 1), shares: '1', legs: legs.map(a => ({ asset: a, amount: lqRaw(1, a.decimals), valueUsd: value == null ? null : value / legs.length })), valueUsd: value, unclaimedRewards: [] }],
  })
  const positions: LiquidityHistoryPosition[] = [
    pos('omnipool', false, '71061', '5', null, [LQ.dot], 40, null, 6_180),
    pos('omnipool', true, '71062', '5', null, [LQ.dot], 44, null, 3_620),
    pos('omnipool', false, '71100', '690', null, [LQ.gdotPool], 48, null, 2_550),
    pos('stableswap', false, null, '690', LQ.gdotPool, [LQ.gdot], 50, null, 1_020),
    pos('xyk', true, null, '1000194', LQ.xykLp, [LQ.hdx, LQ.dot], 30, null, 840),
    pos('xyk', false, null, '1000194', LQ.xykLp, [LQ.hdx, LQ.dot], 31, null, 410),
    pos('uniswapv3', false, 'v3:0xd5a1:1', MOCK_V3_POOL, null, [LQ.dot, LQ.hollar], 52, null, 1_900),
    pos('gamma', false, 'gamma:0xa2b3', MOCK_V3_POOL, null, [LQ.dot, LQ.hollar], 53, null, null),
    // Closed positions: GLMR in the Omnipool, then a run of older DOT NFTs.
    pos('omnipool', true, '60001', '16', null, [LQ.glmr], 0, 20, 780),
    ...Array.from({ length: 23 }, (_, k) => pos('omnipool', k % 3 === 0, String(65_000 + k), '5', null, [LQ.dot], k, k + 6 + (k % 5), 200 + k * 35)),
  ]
  return { stepSec: 86_400, priceGrain: '1d', dates, blocks, valueUsd, unpriced, unclaimedRewardsUsd, rewardsIncomplete, positions, positionsOmitted: 3 }
}

// ── Borrow ────────────────────────────────────────────────────────────────
// Sixty daily buckets ending on the mock head's day. The reserve coverage floor
// (B0) sits at bucket 10: observations (health factors) run from bucket 4, but
// every reserve amount before the floor is null — unknown, never zero.
const MM_DAYS = 60
const MM_FLOOR = 10
const MM_FIRST_OBS = 4
const MM_DAY0 = Date.UTC(2026, 6, 28)
const MM_BLOCK0 = 9_000_000
/** How far a sharp intra-bucket dip falls below the bucket's closing health factor. */
export const MM_DIP = 0.15
const mmDate = (i: number) => new Date(MM_DAY0 + i * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
const mmAsset = (assetId: number, symbol: string, decimals: number, name: string) => ({ assetId, symbol, name, decimals, parachainId: null })
const MM_HDX = mmAsset(0, 'HDX', 12, 'Hydration')
const MM_PRIME = mmAsset(43, 'PRIME', 6, 'Prime')
const MM_DOT = mmAsset(5, 'DOT', 10, 'Polkadot')
const MM_USDT = mmAsset(10, 'USDT', 6, 'Tether')
const MM_HOLLAR = mmAsset(1000, 'HOLLAR', 18, 'HOLLAR')
const MM_STHDX = mmAsset(670, 'stHDX', 12, 'Staked HDX')
// Accounts the account fixtures give a GIGAHDX position (the fox and the kraken
// EVM wallet), in every form a route can name them by.
const MM_GIGAHDX_HOLDERS = ['1l53butbopxqdxsxjbdqxfv7jz8ftdrzs5jomjgq5z3cv2zr', '0xf73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad', '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899']
const mmRaw = (v: number, dec: number) => BigInt(Math.round(v * 1e6)) * 10n ** BigInt(dec) / 1_000_000n + ''
const mmHf = (v: number) => BigInt(Math.round(v * 1e6)) * 10n ** 12n + ''
const round2 = (v: number) => Math.round(v * 100) / 100

// One reserve's daily path: `amount(i)` in tokens (0 = not held), priced at
// `price`, accruing `rate` a year on the held side. Interest is cumulative from
// the floor, like the API's.
function mmReserve(asset: ReturnType<typeof mmAsset>, side: 'supply' | 'debt', price: number, rate: number, amount: (i: number) => number, collateral: boolean) {
  const points: MoneyMarketHistory['markets'][number]['reserves'][number]['points'] = []
  let cumTok = 0
  const usdAt: (number | null)[] = []
  const earnedAt: number[] = []
  for (let i = 0; i < MM_DAYS; i++) {
    const a = i < MM_FLOOR ? 0 : amount(i)
    if (i >= MM_FLOOR && i > MM_FLOOR) cumTok += amount(i - 1) * rate / 365
    earnedAt.push(cumTok)
    usdAt.push(i < MM_FLOOR ? null : a * price)
    if (a <= 0) continue
    const interestTok = cumTok
    points.push({
      i, supplied: side === 'supply' ? mmRaw(a, asset.decimals) : '0', borrowed: side === 'debt' ? mmRaw(a, asset.decimals) : '0',
      suppliedUsd: side === 'supply' ? round2(a * price) : 0, borrowedUsd: side === 'debt' ? round2(a * price) : 0,
      collateral: side === 'supply' ? collateral : false,
      interestEarned: side === 'supply' ? mmRaw(interestTok, asset.decimals) : '0', interestPaid: side === 'debt' ? mmRaw(interestTok, asset.decimals) : '0',
      interestEarnedUsd: side === 'supply' ? round2(interestTok * price) : 0, interestPaidUsd: side === 'debt' ? round2(interestTok * price) : 0,
      interestIncomplete: false,
    })
  }
  const total = earnedAt[MM_DAYS - 1]
  return {
    reserve: {
      asset, aToken: null, reserveAddress: `0x${asset.assetId.toString(16).padStart(40, '0')}`, points,
      interest: {
        interestEarned: side === 'supply' ? mmRaw(total, asset.decimals) : '0', interestPaid: side === 'debt' ? mmRaw(total, asset.decimals) : '0',
        interestEarnedUsd: side === 'supply' ? round2(total * price) : 0, interestPaidUsd: side === 'debt' ? round2(total * price) : 0, interestIncomplete: false,
      },
    },
    usdAt, side, interestUsdAt: earnedAt.map(t => t * price),
  }
}

type MmMarketParts = { key: string; label: string; role: 'primary' | 'supplemental'; staking: boolean; pool: string; reserves: ReturnType<typeof mmReserve>[]; hf: (i: number) => number; lt: string; claimed: MoneyMarketHistory['markets'][number]['claimedIncentives']; unclaimed: (i: number) => number }

function mmMarket(p: MmMarketParts): MoneyMarketHistory['markets'][number] {
  const points: MoneyMarketHistory['markets'][number]['points'] = []
  for (let i = MM_FIRST_OBS; i < MM_DAYS; i++) {
    const stated = i >= MM_FLOOR
    const sup = p.reserves.filter(r => r.side === 'supply').reduce((s, r) => s + (r.usdAt[i] ?? 0), 0)
    const debt = p.reserves.filter(r => r.side === 'debt').reduce((s, r) => s + (r.usdAt[i] ?? 0), 0)
    // Before the floor only the observation is known; the chain's figures still move.
    const obsSup = stated ? sup : 30_000 + i * 400
    const obsDebt = stated ? debt : 11_000 + i * 150
    const earned = p.reserves.filter(r => r.side === 'supply').reduce((s, r) => s + r.interestUsdAt[i], 0)
    const paid = p.reserves.filter(r => r.side === 'debt').reduce((s, r) => s + r.interestUsdAt[i], 0)
    const unclaimed = p.unclaimed(i)
    const MAX_HF = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    // Every bucket dips a little below its close; every seventh one sharply.
    const lowest = p.hf(i) - (i % 7 === 3 ? MM_DIP : 0.03)
    points.push({
      i, suppliedUsd: stated ? round2(sup) : null, borrowedUsd: stated ? round2(debt) : null,
      netUsd: stated ? round2(sup - debt) : null, unpriced: 0,
      observation: {
        observedAtBlock: MM_BLOCK0 + i * 14_400 - 30, timestamp: mmDate(i),
        healthFactor: obsDebt > 0 ? mmHf(p.hf(i)) : MAX_HF,
        totalCollateralBase: mmRaw(obsSup, 8), totalDebtBase: mmRaw(obsDebt, 8), availableBorrowsBase: mmRaw(Math.max(0, obsSup * 0.65 - obsDebt), 8),
        ltv: '6500', liquidationThreshold: p.lt,
        lowestHealthFactor: obsDebt > 0 ? mmHf(lowest) : MAX_HF, lowestAtBlock: MM_BLOCK0 + i * 14_400 - 7_000,
      },
      eModeCategoryId: null,
      unclaimedRewards: stated && unclaimed > 0 ? [{ asset: MM_HDX, amount: mmRaw(unclaimed / 0.0218, 12), valueUsd: round2(unclaimed), settledAtBlock: MM_BLOCK0 + i * 14_400 - 600 }] : [],
      interestEarnedUsd: stated ? round2(earned) : null, interestPaidUsd: stated ? round2(paid) : null, interestUnpriced: 0,
    })
  }
  const last = points[points.length - 1]
  return {
    marketKey: p.key, market: p.label, poolAddress: p.pool, role: p.role, stakingBacked: p.staking, points,
    reserves: p.reserves.map(r => r.reserve), claimedIncentives: p.claimed,
    interestEarnedUsd: last.interestEarnedUsd, interestPaidUsd: last.interestPaidUsd, interestUnpriced: 0,
  }
}

/**
 * Per account: every holder gets the primary market (PRIME and DOT supplied, HOLLAR
 * borrowed, a USDT supply closed mid-window, a health-factor dip to ~1.2 in the
 * middle, HDX incentives claimed once); the GIGAHDX holders also get the staking
 * market (stHDX against HOLLAR, a flat ~2.4 health factor, nothing claimed).
 */
export function mockMoneyMarketHistory(address = ''): MoneyMarketHistory {
  const wave = (i: number) => Math.sin(i / 6)
  const core = mmMarket({
    key: 'core', label: 'Money Market', role: 'primary', staking: false, pool: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38', lt: '7800',
    reserves: [
      mmReserve(MM_PRIME, 'supply', 1, 0.041, i => 24_000 + i * 90 + wave(i) * 600, true),
      mmReserve(MM_DOT, 'supply', 4.44, 0.012, i => 3_600 + (i > 40 ? 500 : 0), true),
      mmReserve(MM_USDT, 'supply', 1, 0.03, i => (i < 30 ? 6_000 : 0), false),
      mmReserve(MM_HOLLAR, 'debt', 1, 0.069, i => 17_000 + i * 60 + (i >= 32 && i <= 40 ? 5_000 : 0), false),
    ],
    // A stretch in the middle drifts under 1.5 and touches ~1.2 before a repay.
    hf: i => (i >= 32 && i <= 40 ? 1.2 + Math.abs(i - 36) * 0.07 : 1.85 + wave(i) * 0.12),
    claimed: [{ asset: MM_HDX, amount: mmRaw(18_900, 12), valueUsd: 412.5, claims: 3, unpricedClaims: 0 }],
    unclaimed: i => (i < 45 ? (i - MM_FLOOR) * 1.9 : (i - 45) * 2.1),
  })
  const markets = [core]
  if (MM_GIGAHDX_HOLDERS.includes(address.toLowerCase())) {
    markets.push(mmMarket({
      key: 'gigahdx', label: 'GIGAHDX', role: 'supplemental', staking: true, pool: '0x2c4e2ac22a1d8e7b5cfd1fb6b52a0e9a7c1d2e3f', lt: '8000',
      reserves: [
        mmReserve(MM_STHDX, 'supply', 0.001, 0.004, () => 24_000_000, true),
        mmReserve(MM_HOLLAR, 'debt', 1, 0.042, i => 5_000 + i * 20, false),
      ],
      hf: i => 2.38 + wave(i) * 0.06,
      claimed: [],
      unclaimed: () => 0,
    }))
  }
  const dates = Array.from({ length: MM_DAYS }, (_, i) => mmDate(i))
  const blocks = dates.map((_, i) => MM_BLOCK0 + i * 14_400)
  const sumAt = (k: 'suppliedUsd' | 'borrowedUsd', i: number) => i < MM_FLOOR ? null : round2(markets.reduce((s, m) => s + (m.points.find(p => p.i === i)?.[k] ?? 0), 0))
  return {
    stepSec: 86400, priceGrain: '1d', dates, blocks,
    reserveHistoryFrom: { blockHeight: blocks[MM_FLOOR] - 7200, time: mmDate(MM_FLOOR - 0.5).replace(' ', 'T') + '.000Z' },
    suppliedUsd: dates.map((_, i) => sumAt('suppliedUsd', i)),
    borrowedUsd: dates.map((_, i) => sumAt('borrowedUsd', i)),
    unpriced: dates.map(() => 0),
    unclaimedRewardsUsd: dates.map((_, i) => i < MM_FLOOR ? null : round2(markets.reduce((s, m) => s + (m.points.find(p => p.i === i)?.unclaimedRewards.reduce((a, r) => a + (r.valueUsd ?? 0), 0) ?? 0), 0))),
    rewardsIncomplete: dates.map(() => 0),
    markets,
  }
}

// Current reserve rates per market (percent units), keyed like the API: market
// key → underlying asset id. PRIME's aToken and HOLLAR's debt token carry an HDX
// programme so the hover has something to break down.
export function mockMoneyMarketYields(): ExplorerYields['moneyMarket'] {
  return {
    core: {
      43: { supplyApyPct: 4.12, borrowApyPct: 7.8, supplyIncentives: [{ rewardAsset: MM_HDX, aprPct: 1.84 }], borrowIncentives: [] },
      5: { supplyApyPct: 1.21, borrowApyPct: 3.4, supplyIncentives: [], borrowIncentives: [] },
      10: { supplyApyPct: 3.05, borrowApyPct: 5.9, supplyIncentives: [], borrowIncentives: [] },
      1000: { supplyApyPct: 5.2, borrowApyPct: 6.94, supplyIncentives: [], borrowIncentives: [{ rewardAsset: MM_HDX, aprPct: 0.92 }] },
    },
    gigahdx: {
      670: { supplyApyPct: 0.41, borrowApyPct: null, supplyIncentives: [], borrowIncentives: [] },
      1000: { supplyApyPct: 3.1, borrowApyPct: 4.2, supplyIncentives: [], borrowIncentives: [] },
    },
  }
}

const SCOPES = String.raw`(?:address|tag|list-tag)\/(.+)`
export const POSITIONS_ROUTES: MockRoute[] = [
  { re: /^\/explorer\/yields$/, fn: () => mockYields() },
  { re: new RegExp(String.raw`^\/explorer\/${SCOPES}\/positions-presence$`), fn: () => mockPresence() },
  { re: new RegExp(String.raw`^\/explorer\/${SCOPES}\/order-history$`), fn: (m, qs) => mockOrderHistory(qs, m[0]) },
  { re: new RegExp(String.raw`^\/explorer\/${SCOPES}\/liquidity-rewards$`), fn: () => mockLiquidityRewards() },
  { re: new RegExp(String.raw`^\/explorer\/${SCOPES}\/liquidity-history$`), fn: () => mockLiquidityHistory() },
  { re: /^\/explorer\/address\/(.+)\/money-market-history$/, fn: m => mockMoneyMarketHistory(decodeURIComponent(m[1])) },
]
