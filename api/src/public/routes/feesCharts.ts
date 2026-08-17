import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import {
  FEES_BUCKET_SIZES, FEES_DESTINATIONS, FEES_PRODUCT_TYPES, FEES_STREAM_TYPES, FEES_TOTAL_MESSAGE,
  MAX_BUCKETS, BUCKET_SECONDS, bucketCount, combinationsMessage, feesChart,
  isValidCombination,
} from '../services/feesCharts.ts'

// GET /api/v1/fees/charts — the revenue/fees page, drop-in for
// hydration-metrics-aggregator. Semantics and the measured deviations from the
// incumbent are documented in ../services/feesCharts.ts and normative in
// docs/superpowers/specs/2026-08-12-public-rest-api-design.md § Phase 2.
//
// The path is /api/v1/… rather than /v1/… because that is the incumbent's, and a
// drop-in means a base-URL swap and nothing else. Its values are likewise JSON
// numbers rather than decimal strings, which makes it one of the
// inherited-contract exceptions the spec records against the surface's wire
// conventions (with /defillama/v1, /hydration-web/v1 and /lending/v1).

/**
 * An ISO-8601 instant. Looser than `zIsoTimestamp` on precision — the incumbent
 * accepts anything Date.parse does, and rejecting a caller that omits
 * milliseconds would break a drop-in over a formatting detail — but STRICT about
 * the zone. `Date.parse('2026-08-04T00:00:00')` is local time, so a bare instant
 * would silently shift the window by the server's offset and put buckets on
 * instants the caller never asked for. A trailing `Z` or a ±hh:mm offset is
 * required; a date-only `2026-08-04` is UTC by the spec and is accepted.
 */
const ZONED = /(?:[Zz]|[+-]\d{2}:?\d{2})$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const zInstant = z.string()
  .refine(v => Number.isFinite(Date.parse(v)), 'expected an ISO-8601 timestamp')
  .refine(v => ZONED.test(v) || DATE_ONLY.test(v), 'timestamp must carry a UTC "Z" or a ±hh:mm offset')

const querySchema = z.object({
  productType: z.enum(FEES_PRODUCT_TYPES),
  // `total` is a real value on the incumbent with a different response shape, so
  // it is named here and refused with an explanation rather than reported as an
  // unknown enum member.
  streamType: z.union([z.enum(FEES_STREAM_TYPES), z.literal('total')]),
  feeDestination: z.enum(FEES_DESTINATIONS).default('protocol'),
  startTime: zInstant,
  endTime: zInstant,
  bucketSize: z.enum(FEES_BUCKET_SIZES),
})

const pointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
})

const responseSchema = z.object({
  data: z.array(pointSchema),
  periodAggregate: z.number(),
})

const DESCRIPTION = [
  'Bucketed protocol revenue, mirroring `hydration-metrics-aggregator`\'s `/api/v1/fees/charts` so the Hydration UI\'s fees page works against this API by base-URL swap alone. Values are JSON **numbers** here — one of the inherited-contract exceptions to this surface\'s decimal-string convention, alongside `/defillama/v1`, `/hydration-web/v1` and `/lending/v1`.',
  '**Buckets.** A bucket exists when its source had at least one row in it; empty buckets are omitted rather than zero-filled. Bucket starts sit on a grid anchored at 2000-01-03T00:00:00Z (inert for 1hour/6hour/24hour, which are plain UTC hours and days; it is what puts 7day buckets on Mondays and reproduces the incumbent\'s 30day grid). Only buckets whose START falls inside [startTime, endTime] are returned.',
  '**periodAggregate** is the sum of the returned buckets.',
  '**Streams.** `asset`/`protocol` are the Omnipool\'s per-asset and hub (H2O) trade fees. `liquidation_penalty` is the protocol\'s share of a money-market liquidation bonus, read from the aToken transfer that moves it into the Aave collector inside the liquidation\'s block (4,124 of 4,124 liquidation blocks carry it) — the amount that physically moved, per event. **The incumbent\'s series is much larger and wrong**: on the 2026-02-05 cascade it booked 28,898.59 against 1,342.67 of actually-transferred fees (verified per event — e.g. the block 11,246,567 GDOT liquidation\'s transfer is 137.83 GDOT, exactly 10% of its gross bonus), and over the trailing year it reports ~7.6x the transferred total. Expect this stream to read far BELOW the incumbent on cascade days; that is the correction, not a gap. `pepl_liquidation_profit` is the protocol liquidator\'s own profit, straight from the `Liquidation.Liquidated` event. `asset_reserve` is the reserve-factor share of borrow interest (`MintedToTreasury`); no reserve has minted since 2026-06-25, so recent windows are legitimately empty. `borrow_apr` is interest accruing on HOLLAR debt.',
  '**`hsm_revenue`** is the HSM\'s stablepool arbitrage profit plus its buyback fee, per fill. An arbitrage\'s profit is its own pool trade\'s two legs held against each other — HOLLAR retired at face, the aUSDT/aUSDC leg at PARITY (no price feed can perturb a peg leg); a fill counts only when an `HSM.ArbitrageExecuted` in its block names its exact HOLLAR amount, which keeps the protocol liquidator\'s sales through the same pools out. The closed sUSDe/sUSDS collateral era (2025-10-02 … 2026-07-28, ~11% of arb volume) values the collateral leg at its 1h close and drops unpriceable or negative fills. Buyback fees follow the module\'s own configuration history (10% for its first six hours, 1bp since block 9,336,534; purchases have always been free). The incumbent\'s series is NOT comparable: it books balance inflows as revenue — the one governance top-up of the HSM ever made ($201,908.69 from the treasury at block 13,558,633) appears there as 202,976.99 of "revenue" — while a transfer is not a fill and contributes nothing here. Per its rule this stream\'s `periodAggregate` is the MEAN of the returned buckets, not the sum.',
  '**Valuation** is event-time: each amount is priced at the 1h candle that had already closed when it happened. The incumbent prices off the money-market oracle, so values agree in magnitude rather than to the cent. Measured against it: Omnipool `asset` 1.04x over a year and 1.05x over the full range; `pepl_liquidation_profit` 1.03x over a year; the hub `protocol` fee 0.72x on a recent week and 1.47x-1.72x over long ones, for two separate reasons. Coverage: between 2025-02-16 and 2026-02-16 the runtime emitted TWO hub fee legs per fill (one burned, one to the treasury) and this series counts both while the incumbent counts only the burned one — measured over 2026-01-10 to 2026-01-16, ours 5,009.48 against its 2,482.25, while our `burned` alone is 2,504.74, or 1.009x its figure. Pricing: with coverage held equal that 1.009x shows the two H2O prices agreed then, so the recent 0.72x is a present-day divergence in H2O/USD, which is anchored on a thin position.',
  '**Recognition differs on `borrow_apr`.** This series recognises interest as it ACCRUES; the incumbent recognises it when a borrower REPAYS. Measured, ours runs ~4.4x the incumbent over one week and converges to ~1.8x over a year. The accrual is the figure verified against a closed form (HOLLAR debt x borrow rate).',
  '**`asset_reserve` diverges in one era.** Bucket instants match the incumbent exactly and most buckets agree within a few percent (the six most recent within 2.5%), but five 30-day buckets between 2025-08-19 and 2025-12-17 run 1.36x-2.36x, which carries the full-range total to 1.37x and the 1-year total to 1.68x. Those buckets\' treasury mints are dominated by one high-value reserve (11,852.94 DOT in the 2025-08-19 bucket alone, about the whole difference), and the difference is the INCUMBENT\'s: the mint amounts are witnessed independently by the collector\'s own aDOT Mint logs (within 0.6%), and our candles at the two mint instants ($3.87, $4.22) match DOT\'s market price, while the incumbent\'s $25,836.77 bucket implies it valued that DOT near $2.18 — about half market.',
  '**Coverage.** `borrow_apr` starts where the money market\'s aToken anchor does, and returns an empty series (never zeros) while that anchor is unavailable. `asset`+`feeDestination=protocol` excludes pre-2025-01-25 legs, whose destination the runtime did not record; `total` includes them.',
].join('\n\n')

/** The app's error handler turns a statusCode-carrying throw into the one error envelope. */
function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

export const feesChartsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/api/v1/fees/charts', {
    schema: {
      tags: ['fees'],
      summary: 'Bucketed protocol revenue by product and stream',
      description: DESCRIPTION,
      querystring: querySchema,
      response: { 200: responseSchema },
    },
  }, async (req) => {
    const q = req.query

    if (q.streamType === 'total') throw badRequest(FEES_TOTAL_MESSAGE)
    if (!isValidCombination(q.productType, q.streamType, q.feeDestination)) throw badRequest(combinationsMessage())

    const startSeconds = Math.floor(Date.parse(q.startTime) / 1000)
    const endSeconds = Math.floor(Date.parse(q.endTime) / 1000)
    if (endSeconds < startSeconds) throw badRequest('endTime must not precede startTime')
    const buckets = bucketCount(startSeconds, endSeconds, BUCKET_SECONDS[q.bucketSize])
    if (buckets > MAX_BUCKETS) {
      throw badRequest(`bucketSize=${q.bucketSize} over this range is ${buckets} buckets; `
        + `the limit is ${MAX_BUCKETS}. Widen bucketSize or narrow the range.`)
    }

    return feesChart(opts.client, {
      productType: q.productType,
      streamType: q.streamType,
      feeDestination: q.feeDestination,
      startSeconds,
      endSeconds,
      bucketSize: q.bucketSize,
    })
  })
}
