import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { badRequest, iso, zAssetId, zError, zIsoTimestamp, zTimeParam } from '../schemas/common.ts'
import {
  ACTIVITY_KINDS, REVENUE_STREAMS, TVL_VENUES, activityCounts, resolveWindow, revenueStats, tvlStats, volumeStats,
} from '../services/statsData.ts'
import { zVenue } from './tradesShared.ts'
import { normalizePoolKey } from './pools.ts'
import { VOLUME_USD_GROUPS, VOLUME_USD_VENUES, publishedCut, volumeUsdStats } from '../services/volumeData.ts'

const DAY_S = 86_400

const zVolumeRow = z.object({
  bucket: zIsoTimestamp.describe('The bucket start (hour or UTC day).'),
  group: z.string().describe('The grouping key: the venue, the asset id, or `venue:poolKey`.'),
  assetId: zAssetId,
  side: z.enum(['in', 'out']),
  amount: z.string().describe('Raw integer sum of the side\'s legs in `assetId` units. Value it via /v1/assets/{id}; fee legs are never included (they restate value the in/out legs already carry).'),
  legCount: z.number().int(),
})

const zRevenueRow = z.object({
  bucket: zIsoTimestamp,
  stream: z.string(),
  dest: z.string().describe('The omnipool fee legs\' destination split (protocol/lp/burned/pol/unknown); empty for every other stream.'),
  amountUsd: z.string().describe('Event-time-valued USD, 2 decimals.'),
  events: z.number().int(),
})

const zActivityRow = z.object({
  day: z.string(),
  count: z.number().int(),
})

const zTvl = z.object({
  totalUsd: z.string(),
  venues: z.array(z.object({ venue: z.enum(TVL_VENUES), tvlUsd: z.string() })),
  asOfBlock: z.number().int(),
  unpricedAssets: z.array(zAssetId).describe('Live pool assets with no recent price — they contribute 0 rather than a stale valuation.'),
})

export const statsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/stats/volume', {
    schema: {
      tags: ['stats'],
      summary: 'Trade volume per bucket, grouped by venue, asset or pool',
      description: [
        'Sums over the hourly leg pre-aggregate: rows are always PER ASSET AND SIDE (raw integers of different assets cannot be added), and `groupBy` picks the extra dimension — the venue, the asset itself, or `venue:poolKey`. Only in/out legs are summed; fee legs restate value the trade legs already carry and adding them double-counts.',
        'Only CLOSED hours exist in the source by construction, so the current hour is absent and a bucket can gain nothing once its hour has closed — the freshness bound is one derivations cycle (~10 minutes) behind live trades.',
        'Windows: default the last 7 days; at most 30 days for `bucket=hour` and 366 days for `bucket=day`. `venue=`/`asset=` narrow the read.',
        'The `aave` venue is the money market\'s aToken mints and redeems — a 1:1 wrap of an asset into its aToken (DOT→aDOT, a pool share into its money-market wrapper), executed by the Router like any fill but not a swap: nothing trades at a price. Every DEX-volume figure Hydration publishes leaves them out (/v1 platform stats, DefiLlama, CoinGecko, DexScreener, and the Explorer\'s per-account trading volume). `wraps=exclude` does the same here; the default `include` keeps them, as the legs they are, so `groupBy=venue` shows them as their own `aave` group while `groupBy=asset` adds them into each asset\'s sums.',
        'Freshness: the pre-aggregate holds CLOSED hours, each folded on the first derivations cycle after it closes, so the newest bucket trails the head by up to an hour plus one cycle (a per-pool series with a raw tail is /v1/pools/{venue}/{poolKey}/volumes). The `uniswapv3` venue is the concentrated-liquidity pools on Hydration\'s EVM; it appears here once its legs are folded.',
      ].join('\n\n'),
      querystring: z.object({
        groupBy: z.enum(['venue', 'asset', 'pool']).default('venue'),
        bucket: z.enum(['hour', 'day']).default('day'),
        venue: zVenue.optional(),
        asset: zAssetId.optional(),
        wraps: z.enum(['include', 'exclude']).default('include').describe("`exclude` leaves out the `aave` venue's aToken wraps, which are not swaps; the default `include` keeps every leg."),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: z.object({ items: z.array(zVolumeRow) }), 400: zError },
    },
  }, async request => {
    const { groupBy, bucket, venue, asset, wraps } = request.query
    const window = resolveWindow(request.query.fromTime, request.query.toTime, 7 * DAY_S, bucket === 'hour' ? 30 * DAY_S : 366 * DAY_S, 'volume')
    // The source holds closed hours only and advances once per derivations
    // cycle, so the TTL is the freshness bound; a head-keyed entry would be
    // recomputed every block and never hit.
    const key = `data:stats:volume:${groupBy}:${bucket}:${venue ?? ''}:${asset ?? ''}:${wraps}:${window.from}:${window.to}`
    return { items: await cached(key, 60_000, () => volumeStats(opts.client, { groupBy, bucket, from: window.from, to: window.to, venue, assetId: asset == null ? undefined : Number(asset), excludeWraps: wraps === 'exclude' })) }
  })

  app.get('/v1/stats/volume/usd', {
    schema: {
      tags: ['stats'],
      summary: 'USD trade volume per hour or day: routed, by venue, pool or asset',
      description: [
        '`groupBy` picks one of three definitions; they answer different questions and must not be mixed. `routed` is PLATFORM volume: every trade counted ONCE, netted across its route (a DOT→USDT→HDX route is one trade valued at the larger of what went in and what came out, its intermediate hops cancelling), aToken wraps never counted — the definition of public /v1/stats/platform `totalRoutedUsd` and the DefiLlama daily series. `venue` and `pool` are POOL volume: every FILL counted once in the pool it executed in, valued by its out side (the in side when the out side is unpriced) — the definition of /v1/pools/{venue}/volumes. The Omnipool counts a user swap ONCE: its A→H2O first hop adds nothing and the H2O→B fill that completes it carries the swap. A trade routed through two pools counts in BOTH, so venue and pool volumes sum to MORE than routed volume — that is what pool volume means, not a double count. `asset` is ASSET volume: the USD value of each asset\'s own legs in fills, sold plus bought, so one fill A→B adds to A and to B and the assets sum to about twice the pool volume. The Omnipool hub H2O (asset 1) is pool plumbing and has no asset rows.',
        'Identities are the registry\'s, never a display fold: `asset` groups by the raw asset id that traded (an aToken such as aDOT 1001 trading in a pool is its own asset; a stableswap share is its own asset), `pool` by `venue:poolKey` with the poolKey /v1/pools/{venue}/{poolKey}/volumes takes (`omnipool`, a stableswap pool id, an XYK pool account, a v3 contract, an OTC order id, the HSM account, and \'\' for the LBP pallet, which recorded no pool key). The `aave` venue (aToken mints and redeems — 1:1 wraps, not swaps) is in none of these figures; /v1/stats/volume\'s raw legs keep it.',
        'Valuation is event-time: each leg at the hourly candle that had fully CLOSED by the fill (`amount × close`, the asset priced through its underlying where it has no feed of its own), never at today\'s price. A fill (or routed trade, or asset side) with no priced side at all is kept and counted in `unpriced` at 0 USD — never dropped. Fees are never volume: `lpFeeUsd` (fee legs accruing to the pool\'s liquidity providers) and `protocolFeeUsd` (every other fee leg: the Omnipool\'s hub fee and the asset-fee share routed to staking, referrals or burned, OTC and LBP fees) ride beside pool volume and partition the fee a fill paid. A Uniswap v3 fee leg is the whole swap fee; where `setFeeProtocol` is on, its protocol share (1/n, the pool\'s denominator for that token in force at the swap — the `uniswap_v3_fee` revenue stream\'s accrual rule) is in `protocolFeeUsd` and only the rest in `lpFeeUsd`. Legs before 2025-01-25 name no fee recipient, and an Omnipool fee leg without one counts as LP.',
        'Freshness: the source holds CLOSED hours only, published by the derivations service; each hour is folded on the first cycle after it has closed and the price pipeline\'s head has passed it, so the newest published hour trails the indexed head by up to about an hour plus one derivations cycle. `publishedThrough` names the first hour NOT yet published — a bucket reaching it is partial, and nothing after it exists here (no raw tail is added). Below that cut a bucket is final short of a backfill re-folding its hours.',
        'Windows: `fromTime`/`toTime` bound the hours read (`hour >= fromTime AND hour < toTime`, so a day bucket cut by the window is partial); default the last 7 days; at most 30 days for `bucket=hour` and 366 days for `bucket=day`. Filters: `venue=` for venue, pool and asset; `poolKey=` (requires `venue`) for pool and asset; `asset=` for asset. `routed` is platform-wide and takes none.',
      ].join('\n\n'),
      querystring: z.object({
        groupBy: z.enum(VOLUME_USD_GROUPS).default('routed').describe('`routed` (default): platform volume, each trade once; `venue`/`pool`: fills per venue or per `venue:poolKey`; `asset`: each asset\'s legs.'),
        bucket: z.enum(['hour', 'day']).default('day'),
        venue: z.enum(VOLUME_USD_VENUES).optional(),
        poolKey: z.string().min(1).max(128).optional().describe('One pool, in the venue\'s own poolKey form (see /v1/pools/{venue}/{poolKey}/volumes); requires `venue`.'),
        asset: zAssetId.optional().describe('One asset id (groupBy=asset only).'),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: {
        200: z.object({
          groupBy: z.enum(VOLUME_USD_GROUPS),
          bucket: z.enum(['hour', 'day']),
          from: zIsoTimestamp.describe('The resolved window start.'),
          to: zIsoTimestamp.describe('The resolved window end (exclusive).'),
          publishedThrough: zIsoTimestamp.nullable().describe('The first hour the source has NOT published (its newest hour + 1 h); null on an empty source.'),
          items: z.array(z.object({
            bucket: zIsoTimestamp.describe('The bucket start (hour or UTC day).'),
            group: z.string().describe('`routed`; the venue; `venue:poolKey`; or the asset id.'),
            volumeUsd: z.string().describe('Event-time USD, 2 decimals.'),
            trades: z.number().int().optional().describe('groupBy=routed: routed trades with a fill in the bucket.'),
            fills: z.number().int().optional().describe('groupBy=venue|pool: fills carrying volume (an Omnipool hub swap\'s first hop is not counted, matching the volume).'),
            legs: z.number().int().optional().describe('groupBy=asset: the asset\'s in/out legs.'),
            unpriced: z.number().int().describe('Trades, fills or legs (per the grouping) whose value ended at 0 because no side was priced; counted, never dropped.'),
            lpFeeUsd: z.string().optional().describe('groupBy=venue|pool: fee legs to the pool\'s LPs, event-time USD. Not part of volumeUsd.'),
            protocolFeeUsd: z.string().optional().describe('groupBy=venue|pool: every other fee leg, event-time USD. Not part of volumeUsd.'),
          })),
        }),
        400: zError,
      },
    },
  }, async request => {
    const { groupBy, bucket, venue, asset } = request.query
    if (groupBy === 'routed' && (venue || asset || request.query.poolKey)) throw badRequest('groupBy=routed is platform-wide: venue, poolKey and asset do not apply (use groupBy=venue, pool or asset)')
    if (asset != null && groupBy !== 'asset') throw badRequest('asset= applies to groupBy=asset only')
    if (request.query.poolKey != null && !venue) throw badRequest('poolKey= requires venue=')
    if (request.query.poolKey != null && groupBy === 'venue') throw badRequest('poolKey= applies to groupBy=pool or asset')
    const poolKey = request.query.poolKey != null && venue ? normalizePoolKey(venue, request.query.poolKey) : undefined
    const window = resolveWindow(request.query.fromTime, request.query.toTime, 7 * DAY_S, bucket === 'hour' ? 30 * DAY_S : 366 * DAY_S, 'volume/usd')
    // Closed-hour sources that gain an hour about hourly: the window and a plain TTL,
    // never the live head (a head key on a source that moves once an hour never hits).
    const key = `data:stats:volume-usd:${groupBy}:${bucket}:${venue ?? ''}:${poolKey ?? ''}:${asset ?? ''}:${window.from}:${window.to}`
    const [items, cut] = await Promise.all([
      cached(key, 60_000, () => volumeUsdStats(opts.client, { groupBy, bucket, from: window.from, to: window.to, venue, poolKey, assetId: asset == null ? undefined : Number(asset) })),
      publishedCut(opts.client, groupBy),
    ])
    return { groupBy, bucket, from: iso(window.from * 1000), to: iso(window.to * 1000), publishedThrough: cut, items }
  })

  app.get('/v1/stats/revenue', {
    schema: {
      tags: ['stats'],
      summary: 'Protocol Revenue per stream, event-time valued',
      description: [
        `Buckets the protocol's derived revenue facts (\`revenue_events\`). Streams: ${REVENUE_STREAMS.join(', ')}.`,
        'Default `scope=protocol` applies the canonical protocol-revenue rule: the omnipool fee legs the pool keeps for its LPs are excluded, the routed-out / burned / protocol-owned-liquidity legs count, and every other stream counts in full. `scope=all` returns every leg with its `dest`, which is the destination matrix the fee dashboards use.',
        'Only closed hours are ever written by the derivation, so a window reaching now under-reports the newest ~hour; USD is valued at event time (hourly close), never at today\'s price.',
      ].join('\n\n'),
      querystring: z.object({
        bucket: z.enum(['day', 'month']).default('day'),
        scope: z.enum(['protocol', 'all']).default('protocol'),
        stream: z.enum(REVENUE_STREAMS).optional(),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: z.object({ items: z.array(zRevenueRow) }), 400: zError },
    },
  }, async request => {
    const { bucket, scope, stream } = request.query
    const window = resolveWindow(request.query.fromTime, request.query.toTime, 30 * DAY_S, bucket === 'day' ? 366 * DAY_S : 1900 * DAY_S, 'revenue', 300)
    const key = `data:stats:revenue:${bucket}:${scope}:${stream ?? ''}:${window.from}:${window.to}`
    return { items: await cached(key, 300_000, () => revenueStats(opts.client, { bucket, scope, stream, from: window.from, to: window.to })) }
  })

  app.get('/v1/stats/active-accounts', {
    schema: {
      tags: ['stats'],
      summary: 'Daily active accounts (and the activity histograms)',
      description: [
        'Exact per-UTC-day counts. `kind=accounts` (default) is the number of DISTINCT accounts that signed at least one extrinsic that day — the signatory, or the effective signer of an EVM-originated extrinsic, one identity per extrinsic — read from the signer-first projection. `kind=extrinsics` and `kind=events` are the chain\'s activity histograms instead: signed extrinsics per day and all events per day, from replay-safe position bitmaps.',
        'Window: default the last 30 days, at most 366. A day is counted from the rows indexed for it, so the current day grows until it closes.',
      ].join('\n\n'),
      querystring: z.object({
        kind: z.enum(ACTIVITY_KINDS).default('accounts'),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: z.object({ kind: z.enum(ACTIVITY_KINDS), items: z.array(zActivityRow) }), 400: zError },
    },
  }, async request => {
    const { kind } = request.query
    const window = resolveWindow(request.query.fromTime, request.query.toTime, 30 * DAY_S, 366 * DAY_S, 'active-accounts', 300)
    const key = `data:stats:active:${kind}:${window.from}:${window.to}`
    return { kind, items: await cached(key, 300_000, () => activityCounts(opts.client, kind, window.from, window.to)) }
  })

  app.get('/v1/stats/tvl', {
    schema: {
      tags: ['stats'],
      summary: 'Current TVL per venue',
      description: [
        'Latest pool reserves × latest prices, per venue. Delisted assets and dead pools are excluded (each venue keeps only entries at its own state frontier — the histories retain a dead entry\'s last row forever), and a live asset with no recent price contributes 0 and is listed in `unpricedAssets` rather than being valued at an arbitrarily old close.',
        'Venues NEST: the Omnipool holds stableswap share tokens (GDOT, GETH, …), so their liquidity can appear both as the share token\'s value in `omnipool` and as component reserves in `stableswap`; `totalUsd` is the plain sum of the venues. Omnipool hub (H2O) reserves are the pool\'s internal accounting side and are not added separately.',
        '`uniswapv3` is the concentrated-liquidity pools on Hydration\'s EVM, valued from the holdings their own logs imply (mints and swaps in, LP and protocol collects out, flash fees) at current prices — there is no per-block state snapshot of an EVM pool. A pool whose token the registry cannot name contributes nothing.',
      ].join('\n\n'),
      response: { 200: zTvl },
    },
  }, async () => cached('data:stats:tvl', 300_000, () => tvlStats(opts.client)))
}
