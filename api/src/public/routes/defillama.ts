import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { errorEnvelope } from '../schemas/common.ts'
import { MAX_BACKFILL_DAYS, backfillRangeError, defillamaBackfill, defillamaVolume } from '../services/defillama.ts'

// The DefiLlama facade (spec § Phase 2 → "DefiLlama facade"). These two routes
// replace HydraDX-api's /defillama/v1/* by a base-URL swap, so their paths,
// field names and JSON types are the incumbent's — deliberately NOT the /v1 wire
// conventions, which is why they live outside /v1. The semantics behind the
// numbers are documented in src/public/services/defillama.ts.

const zVolume = z.object({
  volume_usd: z.number().describe('Netted USD volume over the rolling 24 hours, as a JSON number rounded to cents.'),
})

const zDay = z.object({
  date: z.string().describe('The UTC calendar day, `YYYY-MM-DD`.'),
  volume_usd: z.number().describe('Netted USD volume of the day\'s trades.'),
  dailyFees: z.number().describe('Every fee leg the day\'s trades paid, valued at event time — whatever the fee\'s destination. Fees are NOT part of `volume_usd`.'),
  dailyFeesToAccounts: z.number().describe('The part of `dailyFees` credited to an account: a pool, a referrer, staking, the treasury. This surface does not decide which.'),
  dailyFeesBurned: z.number().describe('The part of `dailyFees` destroyed rather than credited — the Omnipool LRNA protocol fee for most of the chain\'s history. It accrues to nobody.'),
  dailyFeesUnknownDestination: z.number().describe('The part of `dailyFees` whose destination the chain did not record. Pre-Broadcast Omnipool asset fees only; never book it as revenue.'),
  dailyProtocolFees: z.number().describe('The part of `dailyFees` charged in the Omnipool hub asset (LRNA) — the protocol fee. It overlaps the destination classes above rather than adding to them.'),
})

const VOLUME_DESCRIPTION = [
  'Rolling 24-hour trading volume across every venue, in the incumbent feed\'s one-element array shape. A drop-in replacement for `api.hydradx.io/defillama/v1/volume`.',
  'Single-counted: a trade contributes the larger of its two boundary sides ONCE, so a multi-hop route, an Omnipool hub hop and a batch of independent swaps are each counted for what they are. The Hydration Data Lake series this replaces counts one side of every FILL instead — a routed swap once per hop, an Omnipool swap twice because the router reports `A→LRNA` and `LRNA→B` separately — so its figure runs 2–3.4× this one (measured over the week of 2026-08-03: 6.33 M here against 16.97 M there). Money-market wrap round-trips are excluded from DEX volume: a trade whose every fill is an aToken mint or redeem is a 1:1 deposit into the money market, not a swap. An aToken hop INSIDE a routed swap still counts, as part of that swap. Fees are never part of volume.',
  'The window ends at the newest indexed swap fill, not at wall clock or at an independently advancing blocks head, so model catch-up cannot shorten it. Values are event-time priced, from the 1-hour candle that had already closed when each fill happened.',
].join('\n\n')

const BACKFILL_DESCRIPTION = [
  `Historical volume and fees per UTC calendar day, for a DefiLlama reindex. \`startDate\` and \`endDate\` are \`YYYY-MM-DD\` and BOTH inclusive, at most ${MAX_BACKFILL_DAYS} days per request.`,
  'Coverage is the full history of the chain: the first indexed swap is 2023-01-06 (Omnipool block 1,708,104), well before the unified `Broadcast.Swapped` event at block 6,837,788. The same legacy projections feed the other trade surfaces. Fees, however, start on 2023-08-04 (block 3,112,604): the Omnipool swap event carried no fee amount before that runtime, so every fee field reads 0 for the earlier days rather than reporting a fee the chain never published.',
  'Only CLOSED days are served. The range is cut at the start of the day the newest indexed swap fill sits in, so the day in progress is never published as a complete one, and a day is omitted rather than published as `0` when it has no indexed fill at all, or when none of its fills could be valued — a gap means "nothing to report for that day", not "zero volume traded". Measured, the second case is every day from the first Omnipool fill (2023-01-06) to 2023-04-11, whose assets are older than the price feed; the series is dense from 2023-04-12 on.',
  'Volume is netted exactly as `/defillama/v1/volume` nets it — same rule, same money-market wrap exclusion — so the two agree. `dailyFees` is every fee leg valued at event time and is a breakdown of the trade, not extra flow: a stableswap fee is already inside the trade\'s own amounts, so adding fees to volume would count the same value twice. The destination fields split `dailyFees` by where the fee went, including a class the chain did not record for pre-Broadcast Omnipool asset fees — a consumer computing protocol revenue must exclude both the burned and the unknown class rather than assume everything accrued.',
  'The DefiLlama volume adapter today applies a hardcoded 80/20 asset-vs-protocol-fee split and a 50/50 LP-vs-referral split client-side. `dailyProtocolFees` is the real measured protocol (hub-asset) share and replaces the first assumption; the second cannot be replaced from this data, because a fee credited to an account names the recipient but not its role.',
  `Cost: the fold runs calendar months, each subdivided into day-atomic chunks of at most ~1.5 M swap legs (sized from the hourly aggregate, so a busy month splits into a few chunks and a quiet one stays whole). Each chunk is cached for an hour (stale-served for a day). The busiest month of the era (2025-05, ~4.6 M legs) costs ~3.8 s per chunk cold — ~12 s wall for the whole month — and a warm range answers in milliseconds, so a reindex that walks the era in ${MAX_BACKFILL_DAYS}-day requests pays each chunk exactly once.`,
].join('\n\n')

export const defillamaRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/defillama/v1/volume', {
    schema: {
      tags: ['defillama'],
      summary: '24h netted trading volume',
      description: VOLUME_DESCRIPTION,
      response: { 200: z.array(zVolume) },
    },
  }, async () => defillamaVolume(opts.client))

  app.get('/defillama/v1/backfill', {
    schema: {
      tags: ['defillama'],
      summary: 'Per-day historical volume and fees',
      description: BACKFILL_DESCRIPTION,
      querystring: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date').describe('First day, inclusive.'),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date').describe('Last day, inclusive.'),
      }),
      response: {
        200: z.array(zDay),
        400: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
      },
    },
  }, async (req, reply) => {
    const { startDate, endDate } = req.query
    // The range rules (inverted, impossible calendar day, past the day cap) are
    // one function in the service so the bound the description quotes and the
    // bound the endpoint enforces cannot drift apart.
    const invalid = backfillRangeError(startDate, endDate)
    if (invalid) return reply.code(400).send(errorEnvelope('bad_request', invalid))
    return defillamaBackfill(opts.client, startDate, endDate)
  })
}
