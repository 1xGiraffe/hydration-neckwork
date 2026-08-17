import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { zIsoTimestamp } from '../schemas/common.ts'
import { platformStats } from '../services/platformStats.ts'

// Platform headline figures. See spec section "Platform stats" and "Semantics"
// rules 2 and 6.

export const statsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/stats/platform', {
    schema: {
      tags: ['stats'],
      summary: 'Chain-wide TVL and 24h volume',
      description: [
        'TVL is CURRENT pooled value at current prices; the Omnipool figure excludes the LRNA hub leg, which is the pool\'s internal accounting unit rather than deposited value. A pool whose legs cannot all be priced contributes nothing to its venue instead of making the venue unknown.',
        '`moneyMarketSupplyUsd` is every money-market reserve\'s supplied side at current prices, across all three isolated markets (core, GIGAHDX, BIL), reconstructed from the aToken anchor plus indexed scaled deltas. It is null, never 0, when the reserve-state model has no rows (the aToken anchor has not been snapshotted) or when nothing in it could be priced, and a reserve the pool has delisted is excluded rather than frozen at its last balance.',
        'It is deliberately NOT part of `totalUsd`, which stays the pooled total, because the two OVERLAP IN BOTH DIRECTIONS. `moneyMarketFoldedUsd` is the part of the money market that is Stableswap share tokens deposited as collateral — a claim on a pool already inside `stableswapUsd`. `pooledATokenUsd` is the inverse: the pools are themselves money-market suppliers and hold the receipts (pool 690 holds aDOT, the stablepools hold aUSDT/aUSDC, the Omnipool holds asset 1001), so that value is inside `moneyMarketSupplyUsd` too. Measured 2026-08-13: $13.9M and $8.58M respectively, against $52.1M supplied and $29.5M pooled. Staking-backed stHDX ($10.9M) is NOT an overlap — that HDX is locked in its holder\'s own wallet and no pool holds it.',
        'The two fold components are published so the surfaces reconcile: `totalUsd + moneyMarketSupplyUsd - moneyMarketFoldedUsd - pooledATokenUsd` equals `/hydration-web/v1/stats`\'s `tvl` to the cent WITHIN ONE COMPUTATION — that endpoint folds these very strings — but two HTTP requests cannot be made to share one computation. This response recomputes about every 60s while that one is memoised 600s (stale-while-revalidate to 1800s), so a back-to-back pair agrees exactly only while it is still serving the generation its fold was built from: measured 2026-08-13, 21 back-to-back pairs over 7 minutes were **4 exact, 17 not**. Neither obvious workaround helps — a query-string cache-buster bypasses the HTTP micro-cache only (both services memoise under fixed keys), and polling until that endpoint\'s ETag changes and then reading this one at once was still $179.07 out, because stale-while-revalidate computes the new value before the request that first serves it. **So check the MAGNITUDE, not equality:** the gap is whatever the components moved in between, measured over that run at $179.07 to $8,254.19 on a ~$59.4M base, i.e. ≤0.014%. Agreement inside ~0.02% is correct — checkable in two requests — an exact match is a bonus, and anything larger is worth investigating. Both folds are restricted to pools that HAVE a TVL: poolService gives a pool none unless every leg is priced, so an unpriced pool added nothing and nothing of it may be subtracted.',
        '`volume24h` is the rolling 24 hours of swap legs, each fill counted ONCE (its out side, falling back to its in side). `totalRoutedUsd` nets each routed trade end to end — a multi-hop route counts once, at the larger of its two boundary sides — so the per-venue sums legitimately exceed it. It also drops trades whose every fill is an aToken mint or redeem: those are 1:1 money-market wraps, not swaps. An aToken hop inside a routed swap still counts, as part of that swap; the three per-venue fields are unaffected either way, since `aave` is not among them.',
        '`asOf`/`blockHeight` describe the indexed-block volume anchor. The TVL snapshot is another current-state model and can sit a few blocks apart. Both are null only while no swap legs are indexed at all.',
      ].join('\n\n'),
      response: {
        200: z.object({
          asOf: zIsoTimestamp.nullable(),
          blockHeight: z.number().int().nonnegative().nullable(),
          tvl: z.object({
            omnipoolUsd: z.string().nullable(),
            stableswapUsd: z.string().nullable(),
            xykUsd: z.string().nullable(),
            moneyMarketSupplyUsd: z.string().nullable(),
            moneyMarketFoldedUsd: z.string().nullable(),
            pooledATokenUsd: z.string().nullable(),
            totalUsd: z.string().nullable(),
          }),
          volume24h: z.object({
            omnipoolUsd: z.string(),
            stableswapUsd: z.string(),
            xykUsd: z.string(),
            totalRoutedUsd: z.string(),
          }),
        }),
      },
    },
  }, async () => platformStats(opts.client))
}
