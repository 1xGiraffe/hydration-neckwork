import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { csv, zAssetId, zHexAddress, zIsoTimestamp, zPeriod } from '../schemas/common.ts'
import { omnipoolVolumes, poolVolumes, xykPoolMeta } from '../services/poolVolumes.ts'
import { omnipoolYield, stableswapYield } from '../services/poolYield.ts'
import { getUniswapV3PoolLiquidity, uniswapV3HistoryPool, uniswapV3PoolMeta } from '../../services/poolService.ts'
import { ensurePoolService } from '../services/coingecko.ts'
import { fixedV3Grain, v3PoolHistory } from '../../services/uniswapV3History.ts'

// Pool volumes and fee yield. See spec sections "Pools: volumes and yield" and
// "Semantics" rules 1, 3, 4, 5, 6 and 9 — every number here is defined there.

/**
 * The windows these endpoints serve: the shared wire enum MINUS `all` and `1y`.
 * An all-time window is an unbounded scan by definition; a one-year window was
 * measured against the real leg volumes and does not fit the query budget (the
 * Omnipool aggregation exhausts the client's 4 GB cap, stableswap takes 17 s of
 * its 20 s), so it is a 400 rather than an endpoint that 500s under load.
 */
const zVolumePeriod = zPeriod.exclude(['all', '1y'])
/** Yield additionally drops `1h`: an hour of fees annualizes to noise. */
const zYieldWindow = zVolumePeriod.exclude(['1h'])

/** Coverage note repeated on every endpoint below (spec § New ClickHouse models). */
const COVERAGE = 'Coverage is the full indexed swap history, back to the first Omnipool fill at block 1,708,104. Before block 6,837,788 an Omnipool event records the user\'s direct asset pair rather than the router\'s internal LRNA hops, so an LRNA per-asset row exists there only when the user actually traded LRNA.'
const ANCHORING = 'The window is rolling and anchored to the newest indexed swap fill (`asOf`), not to wall clock or to an independently advancing blocks head, so model catch-up cannot shorten it. `asOf` is null while the swap-leg model holds no data at all.'
const VALUATION = 'Legs are valued at the 1-hour candle that had already CLOSED when the fill happened; an asset whose last close is more than 30 days older than the window is treated as unpriced and contributes 0.'

const zVolumeEnvelope = <T extends z.ZodType>(item: T) => z.object({
  period: zVolumePeriod,
  asOf: zIsoTimestamp.nullable(),
  items: z.array(item),
})

const zYieldEnvelope = <T extends z.ZodType>(item: T) => z.object({
  window: zYieldWindow,
  asOf: zIsoTimestamp.nullable(),
  items: z.array(item),
})

const zOmnipoolVolume = z.object({
  assetId: zAssetId,
  volumeUsd: z.string(),
  feeUsd: z.string(),
  protocolFeeUsd: z.string(),
})

const zStableswapVolume = z.object({
  poolId: zAssetId,
  volumeUsd: z.string(),
  feeUsd: z.string(),
})

const zXykVolume = z.object({
  poolAccount: z.string(),
  shareTokenId: zAssetId.nullable(),
  assetA: zAssetId.nullable(),
  assetB: zAssetId.nullable(),
  volumeUsd: z.string(),
  feeUsd: z.string(),
})

const zUniswapV3Volume = z.object({
  pool: z.string().describe('The pool contract address (0x + 40 hex, lowercase).'),
  token0: zAssetId.nullable(),
  token1: zAssetId.nullable(),
  fee: z.number().int().describe('Fee tier in hundredths of a bip: 3000 = 0.3%.'),
  volumeUsd: z.string(),
  feeUsd: z.string(),
})

const zOmnipoolYield = z.object({
  assetId: zAssetId,
  feeAprPerc: z.string().nullable(),
  feeApyPerc: z.string().nullable(),
  farmAprPerc: z.string().nullable(),
  farmRewardAssets: z.array(zAssetId),
  protocolFeeAprPerc: z.string().nullable(),
})

const zStableswapYield = z.object({
  poolId: zAssetId,
  feeAprPerc: z.string().nullable(),
  feeApyPerc: z.string().nullable(),
  farmAprPerc: z.string().nullable(),
})

/** Farm-APR semantics, repeated on both yield endpoints (spec § Semantics 9). */
const FARMS = '`farmAprPerc` is the liquidity-mining rate, summed over every farm running on the asset and paid in `farmRewardAssets`: `min(multiplier · yieldPerPeriod · periodsPerYear, maxRewardPerPeriod · periodsPerYear · rewardPrice / stakedValue)` with `periodsPerYear = 365.2425 d / (6 s · blocksPerPeriod)`, the pallet\'s own reward rule (a farm splits a fixed per-period budget across its stake, and pays its full yield rate until that budget binds). The capped term carries no `multiplier` on purpose: the pallet\'s `total_shares_z` is multiplier-weighted stake, so the factor cancels. The loyalty curve is NOT applied: this is the rate a matured deposit earns, the top of the range the Hydration UI shows. The reward asset is valued at its newest 1-hour close, and one more than 30 days older than the anchor counts as unpriced.'
const FARMS_DEVIATION = 'The stake in the denominator is the CURRENT value of the Omnipool positions that are currently farmed, while the pallet divides by `total_shares_z` — the same positions valued at the block each was deposited. The gap is NOT a centred error band: deposits left in since-stopped farms keep counting toward the current value while earning nothing, so that term only ever ENLARGES the denominator (measured +0.15 % … +9.4 % of stake) and only ever pushes the published rate DOWN, and a stake that has appreciated since its deposits pushes it down again. Net, measured against chain state on 2026-08-12 across all six live farms: −9.0 % … +8.7 % relative (−1.28 pp … +0.94 pp); a farm whose stake has moved further since its deposits will differ by more.'
const FARMS_NULLS = 'A null `farmAprPerc` with a NON-EMPTY `farmRewardAssets` means a farm is running but its rate is not knowable here — it is past its planned schedule (what it still pays then depends on whether its pot was topped up, which is not indexed for these reward assets), its asset has no pool-state sample within 24 hours, its reward asset is unpriced, or its global farm runs more than one yield farm (their shared budget cannot be split per asset). An asset with no farm at all reports an EMPTY `farmRewardAssets`. Note that every farm now running was created in one block and is scheduled to end on 2026-10-26T21:10:36Z, so unless the schedules are extended (a pot top-up alone does not) every `farmAprPerc` becomes null on that date.'

// ---------------------------------------------------------------------------
// Concentrated-liquidity pool history
// ---------------------------------------------------------------------------

const V3_HISTORY_BUCKETS = { '1h': 3_600, '4h': 14_400, '1d': 86_400 } as const
type V3HistoryBucket = keyof typeof V3_HISTORY_BUCKETS
const zV3HistoryBucket = z.enum(['1h', '4h', '1d'])
/**
 * The chart switch a UI offers (24h / 7d / 30d / 1y) as one parameter: the shared
 * wire enum minus `1h` (one bucket) and `all` (unbounded). Each period has the
 * bucket a ~180-point chart wants; `bucket` overrides it.
 */
const zV3HistoryPeriod = zPeriod.exclude(['1h', 'all'])
type V3HistoryPeriod = z.infer<typeof zV3HistoryPeriod>
const V3_PERIOD_SEC: Record<V3HistoryPeriod, number> = { '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400, '1y': 365 * 86_400 }
export const V3_PERIOD_BUCKET: Record<V3HistoryPeriod, V3HistoryBucket> = { '24h': '1h', '7d': '1h', '30d': '4h', '1y': '1d' }
/** Buckets a request may span; a wider window is a 400, never a silently truncated series. */
export const V3_HISTORY_MAX_BUCKETS = 2_000
/** Buckets a request covers when `from` is omitted. */
export const V3_HISTORY_DEFAULT_BUCKETS = 180
const zPoolContract = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a pool contract address: 0x followed by 40 hex characters')

const usd2 = (v: number | null): string | null => (v == null ? null : v.toFixed(2))
const priceText = (v: number | null): string | null => (v == null ? null : Number(v.toPrecision(12)).toString())

const zV3HistoryItem = z.object({
  timestamp: zIsoTimestamp.describe("The bucket's OPEN, UTC-aligned."),
  open: z.string().nullable().describe('token1 per token0 in whole tokens, from the sqrtPriceX96 the swaps reported. A bucket without a swap inherits the previous close (see `swaps`); null before the pool was initialised.'),
  high: z.string().nullable(),
  low: z.string().nullable(),
  close: z.string().nullable(),
  swaps: z.number().int(),
  volume0: z.string().describe('Raw integer sum of the swaps\' token0 legs, both directions.'),
  volume1: z.string(),
  volumeUsd: z.string().nullable().describe("One side of the swaps in USD (the mean of the two priced sides), at the bucket's candle closes; null when neither token has a close."),
  fees0: z.string().describe('Gross swap fee the swaps paid in token0 (input side × fee tier), raw units — before any protocol share.'),
  fees1: z.string(),
  feesUsd: z.string().nullable(),
  liquidity: z.string().nullable().describe("Active liquidity L at the bucket's end: the open ranges straddling the current tick (what the pool's `liquidity()` returned then). Null before the pool is initialised."),
  balance0: z.string().describe("Token0 the pool's own logs imply it held at the bucket's end (mints + swap inflows − collects − protocol collects + flash fees)."),
  balance1: z.string(),
  tvlUsd: z.string().nullable(),
  blockHeight: z.number().int().nullable().describe("The bucket's last pool event."),
})

/**
 * Closed buckets of a pool's history over [from, to]: `from` defaults to
 * V3_HISTORY_DEFAULT_BUCKETS before `to` (or to a `period` before it), `to` to now;
 * both are floored onto the bucket grid and the bucket in progress is never returned.
 */
export function v3HistoryWindow(bucket: V3HistoryBucket, from: string | undefined, to: string | undefined, nowSec: number, period?: V3HistoryPeriod): { fromSec: number; toSec: number } | { error: string } {
  const step = V3_HISTORY_BUCKETS[bucket]
  if (period && from) return { error: '`period` sets the window start itself; pass either `period` or `from`' }
  const toRaw = to ? Math.floor(Date.parse(to) / 1000) : nowSec
  const toGrid = Math.min(Math.floor(toRaw / step) * step, Math.floor(nowSec / step) * step)
  const fromRaw = from ? Math.floor(Date.parse(from) / 1000) : period ? toGrid - V3_PERIOD_SEC[period] : toRaw - V3_HISTORY_DEFAULT_BUCKETS * step
  if (!(fromRaw < toRaw)) return { error: '`from` must be before `to`' }
  const toSec = Math.min(Math.floor(toRaw / step) * step, Math.floor(nowSec / step) * step)
  const fromSec = Math.floor(fromRaw / step) * step
  if ((toSec - fromSec) / step > V3_HISTORY_MAX_BUCKETS) return { error: `at most ${V3_HISTORY_MAX_BUCKETS} buckets per request; narrow the window or widen the bucket` }
  return { fromSec, toSec }
}

export const poolsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/pools/omnipool/volumes', {
    schema: {
      tags: ['pools'],
      summary: 'Omnipool volume and fees per asset',
      description: [
        'Per-asset traded volume over a rolling window. A fill contributes the USD value of ITS legs in that asset; when those legs are unpriced it inherits the fill\'s own value (out side, falling back to the in side). Volume is SINGLE-counted per fill — the data lake counts both sides, so its per-fill numbers are about twice these — and fees are not added to volume.',
        'The LRNA hub legs are not per-asset volume. `feeUsd` is the asset fee that accrues to liquidity providers; `protocolFeeUsd` is the LRNA-denominated protocol fee of the same fills, attributed to the non-hub asset that was sold into the hub.',
        ANCHORING, VALUATION, COVERAGE,
      ].join('\n\n'),
      querystring: z.object({ period: zVolumePeriod.default('24h') }),
      response: { 200: zVolumeEnvelope(zOmnipoolVolume) },
    },
  }, async request => {
    const { period } = request.query
    const { asOf, items } = await omnipoolVolumes(opts.client, period)
    return { period, asOf, items }
  })

  app.get('/v1/pools/stableswap/volumes', {
    schema: {
      tags: ['pools'],
      summary: 'Stableswap volume and fees per pool',
      description: [
        'Per-pool traded volume over a rolling window, single-counted per fill (the USD value of the fill\'s out legs, falling back to its in legs). `poolId` is the pool\'s share-token id. `feeUsd` is the pool\'s fee legs valued at event time.',
        ANCHORING, VALUATION, COVERAGE,
      ].join('\n\n'),
      querystring: z.object({ period: zVolumePeriod.default('24h') }),
      response: { 200: zVolumeEnvelope(zStableswapVolume) },
    },
  }, async request => {
    const { period } = request.query
    const { asOf, items } = await poolVolumes(opts.client, 'stableswap', period)
    return { period, asOf, items: items.map(i => ({ poolId: i.poolKey, volumeUsd: i.volumeUsd, feeUsd: i.feeUsd })) }
  })

  app.get('/v1/pools/xyk/volumes', {
    schema: {
      tags: ['pools'],
      summary: 'XYK volume and fees per pool',
      description: [
        'Per-pool traded volume over a rolling window, keyed by the pool ACCOUNT (a hex public key). `?pools=` filters to a subset; omitted, every pool that traded in the window is returned. Fees are attributed to the asset they were actually charged in (the data lake reports one side\'s fee in the other\'s field for multi-block trades).',
        'A pool account can be reused after a destroy/recreate, so `shareTokenId`/`assetA`/`assetB` describe its newest registry entry; they are null for an account the registry does not know.',
        ANCHORING, VALUATION, COVERAGE,
      ].join('\n\n'),
      querystring: z.object({
        period: zVolumePeriod.default('24h'),
        pools: z.string().optional(),
      }),
      response: { 200: zVolumeEnvelope(zXykVolume) },
    },
  }, async request => {
    const { period } = request.query
    const requested = csv(request.query.pools).map(p => p.toLowerCase())
    for (const pool of requested) {
      if (!zHexAddress.safeParse(pool).success) {
        throw Object.assign(new Error(`not a pool account: ${pool}`), { statusCode: 400 })
      }
    }
    // The whole venue is one cache entry and the subset is taken here, so a
    // caller's arbitrary pool list cannot multiply the cache's cardinality.
    const wanted = new Set(requested)
    const [{ asOf, items }, meta] = await Promise.all([
      poolVolumes(opts.client, 'xyk', period),
      xykPoolMeta(opts.client),
    ])
    return {
      period,
      asOf,
      items: items.filter(i => wanted.size === 0 || wanted.has(i.poolKey)).map(i => {
        const pool = meta.get(i.poolKey)
        return {
          poolAccount: i.poolKey,
          shareTokenId: pool?.shareTokenId ?? null,
          assetA: pool?.assetA ?? null,
          assetB: pool?.assetB ?? null,
          volumeUsd: i.volumeUsd,
          feeUsd: i.feeUsd,
        }
      }),
    }
  })

  app.get('/v1/pools/uniswapv3/volumes', {
    schema: {
      tags: ['pools'],
      summary: 'Concentrated-liquidity (Uniswap v3) volume and fees per pool',
      description: [
        'Per-pool traded volume over a rolling window for the Uniswap v3 pools on Hydration\'s EVM, keyed by the pool CONTRACT address. `?pools=` filters to a subset; omitted, every pool that traded in the window is returned. `feeUsd` is the pool fee (amount in × fee tier) the swaps paid to the pool\'s liquidity providers, valued at event time.',
        'Fills reach this feed two ways: a Router-routed hop through the venue as its Broadcast fill, and a direct EVM swap (SwapRouter02 or any contract) from the pool\'s own Swap log — the latter with a few minutes\' lag. A swap counts once either way.',
        ANCHORING, VALUATION, COVERAGE,
      ].join('\n\n'),
      querystring: z.object({
        period: zVolumePeriod.default('24h'),
        pools: z.string().optional(),
      }),
      response: { 200: zVolumeEnvelope(zUniswapV3Volume) },
    },
  }, async request => {
    const { period } = request.query
    const requested = csv(request.query.pools).map(p => p.toLowerCase())
    for (const pool of requested) {
      if (!/^0x[0-9a-f]{40}$/.test(pool)) {
        throw Object.assign(new Error(`not a pool contract address: ${pool}`), { statusCode: 400 })
      }
    }
    const wanted = new Set(requested)
    const [{ asOf, items }, meta] = await Promise.all([
      poolVolumes(opts.client, 'uniswapv3', period),
      uniswapV3PoolMeta(),
    ])
    return {
      period,
      asOf,
      items: items.filter(i => wanted.size === 0 || wanted.has(i.poolKey)).map(i => {
        const pool = meta.get(i.poolKey)
        return {
          pool: i.poolKey,
          token0: pool?.token0 != null ? String(pool.token0) : null,
          token1: pool?.token1 != null ? String(pool.token1) : null,
          fee: pool?.fee ?? 0,
          volumeUsd: i.volumeUsd,
          feeUsd: i.feeUsd,
        }
      }),
    }
  })

  app.get('/v1/pools/uniswapv3/:pool/history', {
    schema: {
      tags: ['pools'],
      summary: 'Concentrated-liquidity (Uniswap v3) pool history per bucket',
      description: [
        'One row per closed bucket for a pool on Hydration\'s EVM, keyed by the pool CONTRACT address: the price the swaps left the pool at (open/high/low/close, token1 per token0 in whole tokens), the swaps\' volume and gross fees, the active liquidity after the last swap, and the holdings the pool\'s own logs imply. The same builder serves the explorer\'s pool page, so the two cannot disagree on a bucket.',
        'A bucket without a swap carries the previous close forward (its `swaps` is 0) rather than leaving a hole — a concentrated pool\'s price only moves when it trades. Holdings are a running sum from the pool\'s creation, so the first bucket of a window carries the balance already standing in. An aToken side (aDOT) is valued through its reserve\'s candles, like every other USD figure here.',
        `\`timestamp\` is the bucket's OPEN on a UTC-aligned grid; \`from\`/\`to\` are floored onto it, the bucket still in progress is never returned, and the window defaults to the most recent ${V3_HISTORY_DEFAULT_BUCKETS} buckets. The window never opens before the pool's first event: a year asked of a week-old pool returns the week, not a year of nulls. At most ${V3_HISTORY_MAX_BUCKETS} buckets per request — a wider window is a 400, never a silently truncated series.`,
        `\`period\` is the chart switch (24h / 7d / 30d / 1y) as one parameter: the window is the period ending at the last closed bucket, on the bucket a ~180-point chart wants — 24h and 7d hourly, 30d in 4-hour buckets, 1y daily — unless \`bucket\` names another. \`period\` and \`from\` together are a 400. Active liquidity is the pool's open ranges (mints net of burns) straddling the tick at the bucket's end, i.e. what the pool's \`liquidity()\` returns at that moment — a range minted or burnt between two swaps moves it at once; the Swap logs' own liquidity field only reports it at swaps. GET /v1/pools/uniswapv3/{pool}/liquidity serves the same ranges as a distribution over ticks.`,
        VALUATION,
      ].join('\n\n'),
      params: z.object({ pool: zPoolContract }),
      querystring: z.object({
        bucket: zV3HistoryBucket.optional().describe("Bucket width; defaults to the period's (1d when no period)."),
        period: zV3HistoryPeriod.optional().describe('Window ending at the last closed bucket: 24h, 7d, 30d or 1y. Replaces `from`.'),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
      response: {
        200: z.object({
          pool: z.string(),
          token0: zAssetId.describe("token0's registry asset id"),
          token1: zAssetId,
          fee: z.number().int().describe('Fee tier in hundredths of a bip: 3000 = 0.3%.'),
          bucket: zV3HistoryBucket,
          items: z.array(zV3HistoryItem),
        }),
      },
    },
  }, async request => {
    ensurePoolService(opts.client)
    const pool = await uniswapV3HistoryPool(request.params.pool)
    if (!pool) throw Object.assign(new Error('unknown pool: no concentrated-liquidity pool at this address'), { statusCode: 404 })
    const { period, from, to } = request.query
    const bucket: V3HistoryBucket = request.query.bucket ?? (period ? V3_PERIOD_BUCKET[period] : '1d')
    const nowSec = Math.floor(Date.now() / 1000)
    const win = v3HistoryWindow(bucket, from, to, nowSec, period)
    if ('error' in win) throw Object.assign(new Error(win.error), { statusCode: 400 })
    const history = await v3PoolHistory(opts.client, pool, { fromSec: win.fromSec, toSec: win.toSec, grain: fixedV3Grain(V3_HISTORY_BUCKETS[bucket], win.fromSec), closedOnly: true }, nowSec)
    return {
      pool: pool.address, token0: String(pool.asset0), token1: String(pool.asset1), fee: pool.fee, bucket,
      items: history.points.map(p => ({
        timestamp: new Date(p.t * 1000).toISOString(),
        open: priceText(p.open), high: priceText(p.high), low: priceText(p.low), close: priceText(p.close),
        swaps: p.swaps, volume0: p.volume0, volume1: p.volume1, volumeUsd: usd2(p.volumeUsd),
        fees0: p.fees0, fees1: p.fees1, feesUsd: usd2(p.feesUsd),
        liquidity: p.liquidity, balance0: p.balance0, balance1: p.balance1, tvlUsd: usd2(p.tvlUsd), blockHeight: p.blockHeight,
      })),
    }
  })

  app.get('/v1/pools/uniswapv3/:pool/liquidity', {
    schema: {
      tags: ['pools'],
      summary: 'Concentrated-liquidity (Uniswap v3) pool liquidity distribution',
      description: [
        'Where the pool\'s liquidity sits right now, keyed by the pool CONTRACT address: the open positions (every Mint net of the Burns against the same owner and tick range) as the initialised-tick table a Uniswap v3 chart reads (`ticks`: liquidityNet / liquidityGross per tick, ascending), as the liquidity standing between consecutive initialised ticks (`segments`, with the token0/token1 each segment holds at the current price — all token0 above the price, all token1 below, both in the straddling one) and as the ranges themselves (`ranges`, deepest first, each owner named and classed as a Gamma vault, the position manager or a contract minting for itself). `liquidity` is the sum of the ranges straddling `tick`: the figure the pool\'s `liquidity()` returns.',
        'The state is the pool\'s own logs replayed — Initialize and Swap for the tick and sqrt price, Mint and Burn for the ranges — so it is as fresh as the last indexed block (`blockHeight`), not an RPC read; a burn(0) poke changes nothing and is not an event. Prices are token1 per token0 in whole tokens (`price` at the current sqrt price, the per-tick `price` values at 1.0001^tick). Amounts are raw integer units of each token, floored from Float64 arithmetic.',
      ].join('\n\n'),
      params: z.object({ pool: zPoolContract }),
      response: {
        200: z.object({
          pool: z.string(),
          token0: zAssetId.describe("token0's registry asset id"),
          token1: zAssetId,
          fee: z.number().int().describe('Fee tier in hundredths of a bip: 3000 = 0.3%.'),
          tickSpacing: z.number().int(),
          blockHeight: z.number().int().nullable().describe("The pool's last event this state includes."),
          tick: z.number().int().nullable().describe('The current tick (after the last Swap or Initialize); null before the pool is initialised.'),
          sqrtPriceX96: z.string().nullable(),
          price: z.string().nullable().describe('token1 per token0 in whole tokens at the current sqrt price.'),
          liquidity: z.string().nullable().describe('Active liquidity: the open ranges straddling `tick`.'),
          ticks: z.array(z.object({
            tick: z.number().int(),
            price: z.string(),
            liquidityNet: z.string().describe('Liquidity added when the price crosses this tick upwards (negative: removed).'),
            liquidityGross: z.string(),
          })),
          segments: z.array(z.object({
            tickLower: z.number().int(), tickUpper: z.number().int(),
            priceLower: z.string(), priceUpper: z.string(),
            liquidity: z.string(),
            amount0: z.string().describe('token0 this segment holds at the current price, raw units.'),
            amount1: z.string(),
          })),
          ranges: z.array(z.object({
            owner: z.string().describe('The H160 that minted the position into the pool: a Gamma vault, the NonfungiblePositionManager, or a contract of its own.'),
            ownerKind: z.enum(['vault', 'manager', 'direct']),
            tickLower: z.number().int(), tickUpper: z.number().int(),
            priceLower: z.string(), priceUpper: z.string(),
            liquidity: z.string(),
            amount0: z.string(), amount1: z.string(),
            positions: z.number().int().describe('Mints into this range by this owner (a vault re-mints on every rebalance).'),
            inRange: z.boolean(),
          })),
        }),
      },
    },
  }, async request => {
    ensurePoolService(opts.client)
    const dist = await getUniswapV3PoolLiquidity(request.params.pool)
    if (!dist) throw Object.assign(new Error('unknown pool: no concentrated-liquidity pool at this address'), { statusCode: 404 })
    return {
      pool: dist.pool, token0: String(dist.token0.assetId), token1: String(dist.token1.assetId), fee: dist.fee, tickSpacing: dist.tickSpacing,
      blockHeight: dist.blockHeight, tick: dist.tick, sqrtPriceX96: dist.sqrtPriceX96, price: priceText(dist.price), liquidity: dist.liquidity,
      ticks: dist.ticks.map(t => ({ tick: t.tick, price: priceText(t.price) ?? '0', liquidityNet: t.liquidityNet, liquidityGross: t.liquidityGross })),
      segments: dist.segments.map(s => ({ tickLower: s.tickLower, tickUpper: s.tickUpper, priceLower: priceText(s.priceLower) ?? '0', priceUpper: priceText(s.priceUpper) ?? '0', liquidity: s.liquidity, amount0: s.amount0, amount1: s.amount1 })),
      ranges: dist.ranges.map(r => ({ owner: r.owner, ownerKind: r.ownerKind, tickLower: r.tickLower, tickUpper: r.tickUpper, priceLower: priceText(r.priceLower) ?? '0', priceUpper: priceText(r.priceUpper) ?? '0', liquidity: r.liquidity, amount0: r.amount0, amount1: r.amount1, positions: r.positions, inRange: r.inRange })),
    }
  })

  app.get('/v1/pools/omnipool/yield', {
    schema: {
      tags: ['pools'],
      summary: 'Omnipool fee APR/APY per asset',
      description: [
        '`feeAprPerc = 100 × (fee_amount_in_asset / mean_reserve) × 365/W`, a RAW-UNIT ratio: numerator and denominator are the same token, so no price enters and no feed can distort it. `feeApyPerc` compounds that period return over a year.',
        '**The numerator is the LP\'s share, not the whole fee.** Since the unified `Broadcast.Swapped` era (2025-01-25) the runtime splits each asset fee across recipients and emits one fee leg per recipient, so the fee is filtered by RECIPIENT: only legs that stayed in the Omnipool pallet account count. The rest — staking and referrals until 2026-06-22, the protocol\'s fee processor since — is real revenue but it does not accrue to liquidity providers. Measured over the rolling 30 days at 2026-08-12, the pool\'s own share is 50.1–55.0 % of the non-burned asset fee depending on the asset, so counting every non-burned leg would publish roughly 1.9× the rate an LP earns.',
        'There is still no ÷2: the data lake halves the WHOLE fee, which is a different correction that happens to land near this one. Against the recipient-filtered rate the lake\'s figure is 0–10 % low (its ÷2 against the pool\'s measured 50.1–55.0 % share), so a consumer switching from the lake to this endpoint sees a small change here, not the ~2× it would have seen against an unfiltered numerator.',
        '`protocolFeeAprPerc` is the LRNA-denominated protocol fee measured against the asset\'s own hub reserve, reported separately and never blended into the LP APR. `farmAprPerc` is reported separately too — a consumer that wants the total APR adds it to `feeAprPerc`.',
        'The denominator is the mean of the asset\'s `omnipool_pool_state_history` samples INSIDE the window. That grid is uniform (every 600 blocks — ≈1 h at the chain\'s present ~6 s block time, ≈20 min if it moves to 2 s), so the simple mean is the time-weighted average up to grid jitter whatever the cadence; a shorter block time only makes the mean finer. An asset with no in-window sample reports null rather than a rate computed against a stale reserve.',
        FARMS, FARMS_DEVIATION, FARMS_NULLS,
        ANCHORING, COVERAGE,
      ].join('\n\n'),
      querystring: z.object({ window: zYieldWindow.default('30d') }),
      response: { 200: zYieldEnvelope(zOmnipoolYield) },
    },
  }, async request => {
    const { window } = request.query
    const { asOf, items } = await omnipoolYield(opts.client, window)
    return { window, asOf, items }
  })

  app.get('/v1/pools/stableswap/yield', {
    schema: {
      tags: ['pools'],
      summary: 'Stableswap fee APR/APY per pool',
      description: [
        '`feeAprPerc = 100 × (Σ fee_legs_usd / mean_pool_tvl_usd) × 365/W`. A pool earns fees in several assets, so the ratio is USD-weighted (the data lake averages per-asset raw ratios unweighted). Both sides are valued event-time; a TVL sample in which any reserve is unpriced is dropped whole rather than counted short.',
        '`farmAprPerc` is always null here: liquidity mining incentivises Omnipool positions and XYK shares, never a stableswap pool\'s own LPs. When a pool\'s share token is itself an Omnipool asset, the farm running on it is reported on `/v1/pools/omnipool/yield` under that asset id. A pool with no fully priced in-window sample reports null too.',
        ANCHORING, VALUATION, COVERAGE,
      ].join('\n\n'),
      querystring: z.object({ window: zYieldWindow.default('30d') }),
      response: { 200: zYieldEnvelope(zStableswapYield) },
    },
  }, async request => {
    const { window } = request.query
    const { asOf, items } = await stableswapYield(opts.client, window)
    return { window, asOf, items }
  })
}
