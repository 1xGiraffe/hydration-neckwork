import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { csv, zAssetId, zHexAddress, zIsoTimestamp, zPeriod } from '../schemas/common.ts'
import { omnipoolVolumes, poolVolumes, xykPoolMeta } from '../services/poolVolumes.ts'
import { omnipoolYield, stableswapYield } from '../services/poolYield.ts'

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
