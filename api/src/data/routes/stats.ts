import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { zAssetId, zError, zIsoTimestamp, zTimeParam } from '../schemas/common.ts'
import {
  ACTIVITY_KINDS, REVENUE_STREAMS, activityCounts, resolveWindow, revenueStats, tvlStats, volumeStats,
} from '../services/statsData.ts'
import { zVenue } from './tradesShared.ts'

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
  venues: z.array(z.object({ venue: z.enum(['omnipool', 'stableswap', 'xyk']), tvlUsd: z.string() })),
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
      ].join('\n\n'),
      querystring: z.object({
        groupBy: z.enum(['venue', 'asset', 'pool']).default('venue'),
        bucket: z.enum(['hour', 'day']).default('day'),
        venue: zVenue.optional(),
        asset: zAssetId.optional(),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: z.object({ items: z.array(zVolumeRow) }), 400: zError },
    },
  }, async request => {
    const { groupBy, bucket, venue, asset } = request.query
    const window = resolveWindow(request.query.fromTime, request.query.toTime, 7 * DAY_S, bucket === 'hour' ? 30 * DAY_S : 366 * DAY_S, 'volume')
    // The source holds closed hours only and advances once per derivations
    // cycle, so the TTL is the freshness bound; a head-keyed entry would be
    // recomputed every block and never hit.
    const key = `data:stats:volume:${groupBy}:${bucket}:${venue ?? ''}:${asset ?? ''}:${window.from}:${window.to}`
    return { items: await cached(key, 60_000, () => volumeStats(opts.client, { groupBy, bucket, from: window.from, to: window.to, venue, assetId: asset == null ? undefined : Number(asset) })) }
  })

  app.get('/v1/stats/revenue', {
    schema: {
      tags: ['stats'],
      summary: 'Protocol revenue per stream, event-time valued',
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
      ].join('\n\n'),
      response: { 200: zTvl },
    },
  }, async () => cached('data:stats:tvl', 300_000, () => tvlStats(opts.client)))
}
