import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { webStats } from '../services/webStats.ts'

// The hydration.net homepage feed (spec § Phase 2 → "hydration.net stats +
// lending caps"). A drop-in for HydraDX-api's `/hydration-web/v1/stats`: same
// path, same five field names, same JSON-number types — deliberately NOT the /v1
// wire conventions, which is why it lives outside /v1. What each number MEANS
// here is documented below and in src/public/services/webStats.ts.

const zWebStats = z.object({
  tvl: z.number().nullable().describe('Total value locked in USD: everything pooled plus the money market\'s supplied side, de-duplicated in BOTH directions — less the money-market collateral that is pool-share tokens, and less the pool reserves that are money-market aTokens. Null — never 0 — if the price feed cannot value a whole venue or the money-market model has no rows.'),
  vol_30d: z.number().nullable().describe('Netted routed trading volume over the rolling 30 days, in USD. Null while no swap leg is indexed at all — an empty projection is not a zero window.'),
  xcm_vol_30d: z.number().nullable().describe('USD value of XCM transfers with Hydration as origin or destination over 30 days, rounded to cents like the other two USD fields. Null when the upstream XCM analytics query is unavailable; never estimated.'),
  assets_count: z.number().int().describe('Assets in the on-chain registry, the same set /v1/assets publishes.'),
  accounts_count: z.number().int().describe('Distinct accounts that have ever held a balance of any asset.'),
})

const DESCRIPTION = [
  'The five figures hydration.net\'s homepage renders. A drop-in replacement for `api.hydradx.io/hydration-web/v1/stats` — identical path, field names and JSON types — served from this indexer\'s own models. The definitions below differ from the incumbent\'s in three places, deliberately.',
  '**`tvl`** is current pooled value at current prices (Omnipool excluding the LRNA hub leg, plus Stableswap and XYK) PLUS the money market\'s supplied side, de-duplicated in BOTH directions. The pooled total and the money-market total overlap two ways, and counting either twice would publish the same liquidity twice. Measured 2026-08-13, against $52.1M supplied and $29.5M pooled: $13.9M of the money market is pool-SHARE tokens deposited as collateral, each a claim on a pool already in the pooled figure; and $8.58M of the POOLS is money-market aTokens, because Hydration\'s pools are themselves suppliers — pool 690 holds aDOT, 4200 holds aETH, the stablepools hold aUSDT/aUSDC/aEURC/aSOL, and the Omnipool holds asset 1001 (aDOT) directly. Both are subtracted. Staked HDX supplied to the GIGAHDX market ($10.9M) is NOT an overlap and stays in: that HDX is locked in its holder\'s own wallet and no pool holds it. `/v1/stats/platform` publishes the components, and `totalUsd + moneyMarketSupplyUsd - moneyMarketFoldedUsd - pooledATokenUsd` equals this field to the cent — but only WITHIN ONE COMPUTATION, and two HTTP requests cannot be made to share one. This response is memoised 600s (stale-while-revalidate to 1800s) while `/v1/stats/platform` recomputes about every 60s, so a back-to-back pair matches exactly only while platform is still serving the generation this fold was built from. **Measured 2026-08-13, 21 back-to-back pairs over 7 minutes: 4 exact, 17 not** — the four fell in the first minute, and every pair after platform\'s next recompute disagreed until this endpoint recomputed. Two recipes that look like they should work and do NOT: a query-string cache-buster (it bypasses the HTTP micro-cache only — both services memoise under fixed keys), and polling until this endpoint\'s ETag changes and then reading platform at once (tried: still $179.07 out, because stale-while-revalidate means the new value is computed before the request that first serves it). **So do not chase an exact match — check the magnitude.** The gap is whatever the components moved in between, and it is small and bounded: over the same run, $179.07 to $8,254.19 on a ~$59.4M base, i.e. **≤0.014%**. Treat agreement inside ~0.02% as correct, an exact match as a bonus that says the two happened to align, and anything larger as worth investigating.',
  '**`vol_30d`** is NETTED routed volume: each trade counts once, at the larger of its two boundary sides, so a multi-hop route is one trade and an Omnipool swap is not counted twice for its two hub hops. Trades whose every fill is an aToken mint or redeem are excluded — those are 1:1 money-market wraps, not swaps. The incumbent feed sums one side of every FILL instead, which runs about 2.9× higher (measured 2026-08-13: $18.90M here against $53.97M there, a ratio of 0.350). The window ends at the newest indexed swap fill rather than at wall clock or an independently advancing blocks head, so model catch-up cannot shorten it.',
  '**`xcm_vol_30d`** is the USD value of XCM journeys with Hydration on either end over the last 30 days, from the same Ocelloids XCM analytics query the incumbent used (verified against it to 0.11%). Transfers the upstream could not price are summed as zero there, so the figure is a floor. When the query is unavailable — no token configured, upstream down — the field is `null`. It is never estimated from indexed data: this indexer sees Hydration\'s side of a journey, not the value of the leg on the other chain.',
  '**`assets_count`** counts the on-chain asset registry, the same set `/v1/assets` publishes. The incumbent reports a much larger number (measured 2026-08-13: 443 against 123) because its indexer also carries assets that are not in Hydration\'s registry. **`accounts_count`** counts distinct accounts that have ever held a balance here, so it only ever grows.',
  'Fresh for 10 minutes, matching the incumbent\'s Redis TTL, then stale-while-revalidate for up to 30: past the 10-minute mark a request is served the last computed figures immediately and triggers a recomputation behind it, so a caller never waits on the 1.8s TVL query and never sees a gap. Only past 30 minutes does a request block on a fresh computation.',
].join('\n\n')

export const webStatsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/hydration-web/v1/stats', {
    schema: {
      tags: ['hydration-web'],
      summary: 'Homepage TVL, volume, XCM volume and counts',
      description: DESCRIPTION,
      response: { 200: zWebStats },
    },
  }, async () => webStats(opts.client))
}
