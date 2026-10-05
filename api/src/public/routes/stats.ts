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
      summary: 'Chain-wide TVL, 24H volume, HOLLAR supply, protocol revenue and user revenue',
      description: [
        'TVL is CURRENT pooled value at current prices; the Omnipool figure excludes the H2O hub leg, which is the pool\'s internal accounting unit rather than deposited value. A pool whose legs cannot all be priced contributes nothing to its venue instead of making the venue unknown. `uniswapV3Usd` is the concentrated-liquidity (Uniswap v3) pools on Hydration\'s EVM, valued from the holdings their own Mint/Burn/Collect/Swap logs imply; it is part of `totalUsd` like the three pallet venues.',
        '`moneyMarketSupplyUsd` is every money-market reserve\'s supplied side at current prices, across all three isolated markets (core, GIGAHDX, BIL), reconstructed from the aToken anchor plus indexed scaled deltas. It is null, never 0, when the reserve-state model has no rows (the aToken anchor has not been snapshotted) or when nothing in it could be priced, and a reserve the pool has delisted is excluded rather than frozen at its last balance.',
        'It is deliberately NOT part of `totalUsd`, which stays the pooled total, because the two OVERLAP IN BOTH DIRECTIONS. `moneyMarketFoldedUsd` is the part of the money market that is Stableswap share tokens deposited as collateral — a claim on a pool already inside `stableswapUsd`. `pooledATokenUsd` is the inverse: the pools are themselves money-market suppliers and hold the receipts (pool 690 holds aDOT, the stablepools hold aUSDT/aUSDC, the Omnipool holds asset 1001), so that value is inside `moneyMarketSupplyUsd` too. Both are material — each is a sizeable fraction of both totals, so adding the two totals without them would publish the same liquidity twice; read the current amounts from the fields themselves. Staking-backed stHDX is NOT an overlap — that HDX is locked in its holder\'s own wallet and no pool holds it.',
        'The two fold components are published so the surfaces reconcile: `totalUsd + moneyMarketSupplyUsd - moneyMarketFoldedUsd - pooledATokenUsd` equals `/hydration-web/v1/stats`\'s `tvl` to the cent WITHIN ONE COMPUTATION — that endpoint folds these very strings — but two HTTP requests cannot be made to share one computation. This response recomputes about every 60s while that one is memoised 600s (stale-while-revalidate to 1800s), so a back-to-back pair agrees exactly only while it is still serving the generation its fold was built from; most pairs taken over several minutes do not. Neither obvious workaround helps — a query-string cache-buster bypasses the HTTP micro-cache only (both services memoise under fixed keys), and polling until that endpoint\'s ETag changes and then reading this one at once still disagrees, because stale-while-revalidate computes the new value before the request that first serves it. **So check the MAGNITUDE, not equality:** the gap is whatever the components moved in between, in practice well under 0.02% of the total. Agreement inside ~0.02% is correct — checkable in two requests — an exact match is a bonus, and anything larger is worth investigating. Both folds are restricted to pools that HAVE a TVL: poolService gives a pool none unless every leg is priced, so an unpriced pool added nothing and nothing of it may be subtracted.',
        '`volume24h` is the rolling 24 hours of swap legs, each fill counted ONCE (its out side, falling back to its in side). `totalRoutedUsd` nets each routed trade end to end — a multi-hop route counts once, at the larger of its two boundary sides — so the per-venue sums legitimately exceed it. It also drops trades whose every fill is an aToken mint or redeem: those are 1:1 money-market wraps, not swaps. An aToken hop inside a routed swap still counts, as part of that swap; the four per-venue fields are unaffected either way, since `aave` is not among them. `uniswapV3Usd` counts a Uniswap v3 pool\'s fills whether they arrived as a Router-routed hop or as a direct EVM swap (the latter reach the leg model a few minutes behind, through the uniswap_v3_legs derivation).',
        '`asOf`/`blockHeight` describe the indexed-block volume anchor. The TVL snapshot is another current-state model and can sit a few blocks apart. Both are null only while no swap legs are indexed at all.',
        '`hollar.totalSupply` is the HOLLAR outstanding — minted through the money-market facilitators and the HSM, less what repayments and HSM buybacks burned — i.e. the ERC-20\'s `totalSupply`, as a raw integer string in the token\'s own units (asset `222`, 18 decimals; resolve decimals via `/v1/assets`). It is reconstructed from the indexed ERC-20 wallet balances, with no per-request RPC, and is the same read `/coingecko/v1/totalsupply/hollar` publishes in whole tokens. Null — never 0 — when that balance model has no rows.',
        '`protocolRevenue` is the protocol\'s revenue over the trailing 24 hours, 7 days, 30 days and all time: Omnipool trade fees (the protocol\'s share and the H2O fee), liquidation penalties and the protocol liquidator\'s profit, the reserve-factor share of borrow interest, HOLLAR borrow interest, HSM revenue, ICE matched fees, Uniswap v3 protocol fees, network fees and XCM execution fees (what the XCM weight trader charged a message for running here). Each amount is valued in USD at event time (the 1h candle closed when it happened) and only the protocol\'s own share counts — the liquidity providers\' part of a trade fee is not revenue — and a payment the protocol\'s own accounts made to it (the Treasury\'s HOLLAR interest, for example) is excluded. These are exactly the totals the explorer\'s Protocol Revenue page (/revenue/protocol) shows, from one shared computation. HOLLAR borrow interest accrues hourly, so its share lags up to about two hours; every other stream is current to the indexed head. The per-stream, bucketed series is `/api/v1/fees/charts`, which keeps its incumbent\'s stream matrix and does not apply the own-account exclusion, so its sums can differ from these totals.',
        '`userRevenue` is what USERS earned on Hydration over the trailing 24, 168 and 720 CLOSED hours and all time, NET: income (LP fees their positions captured, liquidity-mining rewards, lending interest and incentives, yield-bearing token accrual, HDX staking and GIGAHDX yield and voting rewards, referrer commissions) minus what they paid for it (borrow interest, LP exit and imbalance fees, forfeited staking rewards), each valued in USD at the hour\'s closed candle. It is booked on an ACCRUAL basis — when the chain\'s own arithmetic says an amount is owed, never when it is claimed (a claim only realizes it); referrer commissions are the exception and are booked at claim time, since no per-trade event states them. Only holder class `user` counts: the protocol\'s own accounts and custody no user holds (the Omnipool hub channel, sibling-chain sovereign accounts, unrecorded voting rewards, money-market rewards accrued to a custody contract no claimant can claim) are excluded. Yield that accrued while a token\'s rate sat flat for 14 days or more is spread over that stretch. HDX staking is booked GROSS as it accrues: the share a staker is finally paid depends on governance action points no event states, so the unpaid part is booked negative (forfeited) at the claim or exit — a window can show staking income whose forfeit lands in a later window. Trading P&L, impermanent loss, swap and network fees and liquidations are not user revenue. The figures come from an hourly fold with no raw tail: `publishedThrough` is the end of the newest folded hour and every window ends there, so the windows are "the last N closed hours through `publishedThrough`", not "to now". A window whose hours are not all folded is null — never a plausible 0 — and `allTimeUsd` is null unless `coverage.complete` (no unfolded hour since `coverage.from`). Money-market streams are covered from block 8,200,000 (2025-07-04) and Omnipool LP fees from 2023-08-04; `coverage.unmeasured` names what is not measured — eras no source states, and each token whose accrual the fold marked unmeasured in the last 30 published days with the reason (for example apyUSD, whose peg never moved). User Revenue and `protocolRevenue` are NOT additive: an Omnipool trade fee\'s LP-retained part is user revenue while the protocol\'s part is protocol revenue, and protocol-owned liquidity in the HDX sub-pool is a protocol-revenue stream whose capture is also booked in the fold (to the protocol class). These are exactly the totals the explorer\'s /revenue page shows.',
      ].join('\n\n'),
      response: {
        200: z.object({
          asOf: zIsoTimestamp.nullable(),
          blockHeight: z.number().int().nonnegative().nullable(),
          tvl: z.object({
            omnipoolUsd: z.string().nullable(),
            stableswapUsd: z.string().nullable(),
            xykUsd: z.string().nullable(),
            uniswapV3Usd: z.string().nullable(),
            moneyMarketSupplyUsd: z.string().nullable(),
            moneyMarketFoldedUsd: z.string().nullable(),
            pooledATokenUsd: z.string().nullable(),
            totalUsd: z.string().nullable(),
          }),
          volume24h: z.object({
            omnipoolUsd: z.string(),
            stableswapUsd: z.string(),
            xykUsd: z.string(),
            uniswapV3Usd: z.string(),
            totalRoutedUsd: z.string(),
          }),
          hollar: z.object({
            totalSupply: z.string().nullable(),
          }),
          protocolRevenue: z.object({
            last24hUsd: z.string(),
            last7dUsd: z.string(),
            last30dUsd: z.string(),
            allTimeUsd: z.string(),
          }),
          userRevenue: z.object({
            last24hUsd: z.string().nullable(),
            last7dUsd: z.string().nullable(),
            last30dUsd: z.string().nullable(),
            allTimeUsd: z.string().nullable(),
            publishedThrough: zIsoTimestamp.nullable(),
            coverage: z.object({
              from: zIsoTimestamp.nullable(),
              complete: z.boolean(),
              unmeasured: z.array(z.string()),
            }),
          }),
        }),
      },
    },
  }, async () => platformStats(opts.client))
}
