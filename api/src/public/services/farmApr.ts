import type { ClickHouseClient } from '../../db/client.ts'
import { assetDescriptor, priceAssetId } from '../../services/explorerAssets.ts'
import { iso } from '../schemas/common.ts'
import { DECIMAL_STRINGS, PRICE_LOOKBACK_DAYS, scaledUsd } from './poolVolumes.ts'

// Liquidity-mining ("farm") APR per Omnipool asset, from the indexed farm
// lifecycle in `price_data.farm_config_events` (clickhouse/schema/006_public.sql).
// Normative definition: spec § Semantics 9.
//
// WHAT THE PALLET PAYS. A global farm hands out, per period,
//
//   global_reward = min(total_shares_z · price_adjustment · yield_per_period,
//                       max_reward_per_period)
//
// in its reward currency, and a yield farm receives the share of it its
// `multiplier` buys. Dividing that by the stake it is paid on gives the rate a
// depositor earns, which is what the Hydration UI renders (the SDK's
// LiquidityMiningApi.farmData). The stake cancels in the uncapped branch, so the
// rate collapses to a `min` of two terms that need very different inputs:
//
//   uncapped = 100 · multiplier · yield_per_period · periodsPerYear
//   capped   = 100 · max_reward_per_period · periodsPerYear
//                  · reward_price / staked_value
//   apr      = min(uncapped, capped)
//
// The first is pure farm configuration — exact from the events. The second is the
// farm's fixed budget spread over what is staked in it, so it needs a valuation.
//
// The capped branch carries NO multiplier, and that is not an omission: the pallet's
// `total_shares_z` is Σ(valued_shares · multiplier) over the global farm's yield
// farms, so with the one live yield farm per global farm this chain has always run,
// the yield farm's `· multiplier` in the numerator and the same factor inside Z
// cancel exactly. `staked_value` here is un-weighted stake, so multiplying it back
// in would halve a multiplier=0.5 farm's published rate. The cancellation only holds
// at that 1:1 topology, which is why a global farm folding to more than one live
// yield farm reports null instead (splitAcrossYieldFarms below).
//
// THE ONE APPROXIMATION, ITS SIZE AND ITS DIRECTION. `total_shares_z` is pallet
// state: the sum of each entry's `valued_shares`, the position's LRNA value FROZEN
// at the block it was deposited. No event carries it, so the denominator here is the
// CURRENT value of the Omnipool positions that are currently farmed
// (`omnipool_position_owner_intervals` with ownership_kind='farmed', valued at the
// newest pool-state sample and the newest closed candle). Two terms separate it from
// the pallet's Z, and they are NOT symmetric:
//
//  * Membership is a ONE-SIDED, always-downward term. A deposit does not name its
//    farm, and deposits left in since-stopped farms keep an open farmed interval
//    while earning nothing, so the denominator can only be too LARGE, never too
//    small: measured +0.15 %, +0.4 %, +0.8 %, +4.4 %, +6.2 %, +9.4 % of stake over
//    the six live farms — every one positive, each pushing the published rate down.
//  * Valuation is two-sided: a stake that APPRECIATED since its deposits is worth
//    more now than the frozen Z says, pushing the rate down again; one that fell
//    pushes it up.
//
// So the error is a downward-biased band, not a centred one. Net, measured against
// chain state on 2026-08-12: −9.0 %, −2.6 %, −1.9 %, −0.7 %, +7.1 %, +8.7 %
// relative (−1.28 pp … +0.94 pp). A farm whose stake moved further since its
// deposits will differ by more. The published number is the pallet's rule computed
// on a current-value denominator, NOT a claim to reproduce the UI digit for digit.
//
// WHAT IS DELIBERATELY NOT FOLDED IN:
//  * The loyalty curve. A deposit starts at `initial_reward_percentage` of the rate
//    and climbs to the full rate with age (25 % for every live farm today), so the
//    published number is the rate a matured deposit earns — the maximum the UI
//    shows as the top of its range.
//  * Farms past their planned schedule. `plannedYieldingPeriods` periods after
//    creation the budget is spent, and what a farm pays after that depends on
//    whether its pot was topped up — pot balances are not readable from the indexed
//    balances for the ERC20-backed reward assets these farms use. Such a farm keeps
//    its entry with a null rate and its reward assets still listed, so a consumer can
//    tell "a farm exists, its rate is unknown" from "no farm here" (see AssetFarmApr).

/** Decimals kept on a percentage, matching the wire convention ("1.7353" = 1.7353 %). */
export const PERC_DECIMALS = 4
const PERC_UNIT = 10n ** BigInt(PERC_DECIMALS)

/** An integer count of 10^-PERC_DECIMALS as the wire's fixed 4-decimal percentage. */
export function renderPerc(value: bigint): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(PERC_DECIMALS + 1, '0')
  const whole = digits.slice(0, digits.length - PERC_DECIMALS)
  return `${negative ? '-' : ''}${whole}.${digits.slice(digits.length - PERC_DECIMALS)}`
}

/** A decimal string as an integer count of 10^-scale; a leading `-` is carried through. */
export function scaled(value: string, scale: number): bigint {
  const input = value.trim()
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(input)
  if (!match) throw new RangeError(`not a decimal: ${value}`)
  const fraction = (match[3] ?? '').slice(0, scale).padEnd(scale, '0')
  const magnitude = BigInt(`${match[2] || '0'}${fraction}`)
  return match[1] === '-' ? -magnitude : magnitude
}

/** Seconds in the year the pallet's rate is quoted over (365.2425 days). */
const SECONDS_PER_YEAR = 31_556_952n
/** A liquidity-mining period is counted in RELAY blocks, which are 6 s apart. */
const RELAY_BLOCK_SECONDS = 6n
/** Perquintill / FixedU128 scale: `yield_per_period` and `multiplier` are 10^18 = 1. */
const FIXED_ONE = 10n ** 18n
/**
 * How stale the newest Omnipool state sample may be and still value a stake. The
 * grid is written every 600 blocks (~1 h); a delisted asset's last row otherwise
 * stays in the table forever.
 */
const STATE_SAMPLE_HOURS = 24

/** One row of the farm lifecycle, as `farm_config_events` carries it. */
export interface FarmConfigRow {
  event_name: string
  global_farm_id: string
  /** Empty on the global-farm events. */
  yield_farm_id: string
  block_height: string
  event_index: string
  block_timestamp: string
  args_json: string
}

/**
 * A yield farm that is live in the pallet's storage — created, not stopped, not
 * terminated, and its global farm not terminated — with the state its APR needs.
 * Live is not the same as PAYING: a farm past `endsAt` is still live storage whose
 * rate cannot be known from indexed data (see the header).
 */
export interface LiveFarm {
  globalFarmId: number
  yieldFarmId: number
  /** The Omnipool asset whose positions this farm incentivises. */
  assetId: number
  rewardAssetId: number
  /** 10^18 = 1×. */
  multiplier: bigint
  /** 10^18 = 100 %/period. */
  yieldPerPeriod: bigint
  /** Raw units of the reward asset, the ceiling on a period's global reward. */
  maxRewardPerPeriod: bigint
  blocksPerPeriod: number
  plannedYieldingPeriods: number
  startedAt: Date
  /** When the planned budget runs out: `plannedYieldingPeriods` periods after the start. */
  endsAt: Date
}

/**
 * The APR of the farms on one Omnipool asset, and which assets pay for them.
 *
 * An asset has an entry here IF AND ONLY IF a farm is live on it, so the pair
 * distinguishes the two cases a bare null cannot: `rewardAssetIds` non-empty with
 * `farmAprPerc` null means a farm exists but its rate is unknown (past its planned
 * schedule, unpriced, no fresh pool state), while no entry at all means no farm.
 */
export interface AssetFarmApr {
  /** Sum over the asset's farms, or null when any of them lacks an input. */
  farmAprPerc: string | null
  rewardAssetIds: string[]
}

/**
 * Every Omnipool liquidity-mining lifecycle event, in chain order.
 *
 * The whole history is ~270 rows, so the fold happens in TS against the raw
 * `args_json` rather than in SQL: the arg names differ per event (a global farm is
 * `id` on creation and `globalFarmId` everywhere else) and the state machine is
 * not expressible row-wise. The MV already normalised the ids into columns, which
 * is what this reads — never the arg.
 *
 * The ORDER BY casts back to a number ON PURPOSE. Every id and height is
 * `toString()`ed for the wire (a 128-bit height must not pass through a double),
 * and ClickHouse resolves ORDER BY against those aliases — so a bare
 * `ORDER BY block_height` is a LEXICOGRAPHIC sort that puts height 5 305 748 after
 * 12 228 202. `foldLiveFarms` re-sorts numerically, so the state machine is correct
 * either way, but a query whose stated order is not chain order is a trap for the
 * next reader: it is one removed `.sort()` from resurrecting stopped farms.
 */
export function buildFarmConfigSql(): string {
  return `-- pub:farm:config
SELECT event_name,
       toString(global_farm_id) AS global_farm_id,
       ifNull(toString(yield_farm_id), '') AS yield_farm_id,
       toString(block_height) AS block_height,
       toString(event_index) AS event_index,
       toString(block_timestamp) AS block_timestamp,
       argMax(args_json, ingested_at) AS args_json
FROM price_data.farm_config_events
WHERE pallet = 'omnipool_lm'
GROUP BY event_name, global_farm_id, yield_farm_id, block_height, event_index, block_timestamp
ORDER BY toUInt64(block_height), toUInt64(event_index)`
}

/**
 * Per asset: the shares of it that are currently farmed, and the newest pool state
 * to value them with.
 *
 * `omnipool_position_owner_intervals` is the LP reconstruction's own model of who
 * holds which position and how (`ownership_kind='farmed'` is "deposited into a
 * farm"); an open interval is `valid_to_block = 0`. It is rebuilt whole under a new
 * `run_id`, so every read collapses its ORDER BY with argMax first.
 *
 * The rows are keyed on the ASSET, not on the yield farm: a deposit does not say
 * which farm it entered, and a position deposited before a farm was created can
 * have been redeposited into it. Both directions of that inexactness are in the
 * measured deviation at the top of this file.
 */
export function buildFarmTvlSql(): string {
  return `-- pub:farm:tvl
WITH intervals AS (
  SELECT account_id, position_id, valid_from_block, valid_from_event,
         argMax(valid_to_block, run_id) AS valid_to,
         argMax(ownership_kind, run_id) AS kind
  FROM price_data.omnipool_position_owner_intervals
  GROUP BY account_id, position_id, valid_from_block, valid_from_event
),
farmed AS (
  SELECT DISTINCT position_id FROM intervals WHERE kind = 'farmed' AND valid_to = 0
),
positions AS (
  SELECT position_id, argMaxMerge(asset_id) AS asset_id, argMaxMerge(shares) AS shares
  FROM price_data.omnipool_position_latest
  GROUP BY position_id
  HAVING asset_id IN ({assets:Array(UInt32)})
),
staked AS (
  SELECT p.asset_id AS asset_id, count() AS positions, sum(toDecimal256(p.shares, 0)) AS shares
  FROM farmed f INNER JOIN positions p ON p.position_id = f.position_id
  GROUP BY p.asset_id
),
samples AS (
  SELECT toUInt32(asset_id) AS asset_id, block_height, block_timestamp,
         toDecimal256(argMax(reserve_raw, ingested_at), 0) AS reserve,
         toDecimal256(argMax(shares_raw, ingested_at), 0) AS pool_shares
  FROM price_data.omnipool_pool_state_history
  WHERE asset_id IN ({assets:Array(UInt32)})
    AND block_timestamp <= {anchor:DateTime}
    AND block_timestamp > {anchor:DateTime} - INTERVAL {stateHours:UInt32} HOUR
  GROUP BY asset_id, block_height, block_timestamp
),
state AS (
  SELECT asset_id,
         argMax(reserve, block_height) AS reserve,
         argMax(pool_shares, block_height) AS pool_shares,
         max(block_timestamp) AS sample_time
  FROM samples GROUP BY asset_id
)
SELECT toString(s.asset_id) AS asset_id,
       toString(k.positions) AS positions,
       toString(k.shares) AS farmed_shares,
       toString(s.reserve) AS reserve_raw,
       toString(s.pool_shares) AS pool_shares,
       toString(s.sample_time) AS sample_time
FROM state s LEFT JOIN staked k ON k.asset_id = s.asset_id
ORDER BY s.asset_id`
}

/**
 * The newest close each asset had already CLOSED by the anchor, bounded by the same
 * staleness lookback the rest of the surface uses — a dead feed must not value
 * today's stake at its final price forever.
 */
export function buildFarmPriceSql(): string {
  return `-- pub:farm:price
SELECT toString(asset_id) AS asset_id,
       toString(argMax(close, interval_start)) AS close,
       toString(max(interval_start) + INTERVAL 1 HOUR) AS price_time
FROM (
  SELECT asset_id, interval_start, argMaxMerge(close_state) AS close
  FROM price_data.ohlc_1h
  WHERE asset_id IN ({priceAssets:Array(UInt32)})
    AND interval_start + INTERVAL 1 HOUR <= {anchor:DateTime}
    AND interval_start > {anchor:DateTime} - INTERVAL {lookbackDays:UInt32} DAY
  GROUP BY asset_id, interval_start
)
GROUP BY asset_id`
}

interface GlobalFarmState {
  rewardAssetId: number
  yieldPerPeriod: bigint
  maxRewardPerPeriod: bigint
  totalRewards: bigint
  blocksPerPeriod: number
  plannedYieldingPeriods: number
  startedAt: Date
  live: boolean
}

interface YieldFarmState {
  globalFarmId: number
  yieldFarmId: number
  assetId: number
  multiplier: bigint
  live: boolean
}

function chainOrder(a: FarmConfigRow, b: FarmConfigRow): number {
  return Number(a.block_height) - Number(b.block_height) || Number(a.event_index) - Number(b.event_index)
}

/**
 * The yield farms live in storage: replay the lifecycle events in chain order and
 * keep the ones that were created, not stopped or terminated, and whose global farm
 * is not terminated. The planned schedule is NOT applied here — `endsAt` is carried
 * so the caller can tell a farm whose rate is unknown from one that does not exist.
 *
 * `GlobalFarmUpdated` carries no `maxRewardPerPeriod`; the pallet keeps it at
 * `total_rewards / planned_yielding_periods`, an identity every `GlobalFarmCreated`
 * in the chain's history satisfies exactly, so the new schedule re-derives it.
 */
export function foldLiveFarms(rows: FarmConfigRow[]): LiveFarm[] {
  const globals = new Map<number, GlobalFarmState>()
  const yields = new Map<string, YieldFarmState>()

  for (const row of [...rows].sort(chainOrder)) {
    const globalFarmId = Number(row.global_farm_id)
    const args = JSON.parse(row.args_json) as Record<string, unknown>
    const global = globals.get(globalFarmId)

    switch (row.event_name) {
      case 'GlobalFarmCreated':
        globals.set(globalFarmId, {
          rewardAssetId: Number(args.rewardCurrency),
          yieldPerPeriod: BigInt(String(args.yieldPerPeriod)),
          maxRewardPerPeriod: BigInt(String(args.maxRewardPerPeriod)),
          totalRewards: BigInt(String(args.totalRewards)),
          blocksPerPeriod: Number(args.blocksPerPeriod),
          plannedYieldingPeriods: Number(args.plannedYieldingPeriods),
          startedAt: new Date(iso(row.block_timestamp)),
          live: true,
        })
        break
      case 'GlobalFarmUpdated': {
        if (!global) break
        const planned = Number(args.plannedYieldingPeriods)
        global.yieldPerPeriod = BigInt(String(args.yieldPerPeriod))
        global.plannedYieldingPeriods = planned
        global.maxRewardPerPeriod = planned > 0 ? global.totalRewards / BigInt(planned) : 0n
        break
      }
      case 'GlobalFarmTerminated':
        if (global) global.live = false
        break
      case 'YieldFarmCreated':
      case 'YieldFarmUpdated':
      case 'YieldFarmResumed': {
        const yieldFarmId = Number(row.yield_farm_id)
        const key = `${globalFarmId}:${yieldFarmId}`
        const previous = yields.get(key)
        yields.set(key, {
          globalFarmId,
          yieldFarmId,
          assetId: args.assetId != null ? Number(args.assetId) : previous?.assetId ?? Number.NaN,
          multiplier: args.multiplier != null ? BigInt(String(args.multiplier)) : previous?.multiplier ?? 0n,
          live: true,
        })
        break
      }
      case 'YieldFarmStopped':
      case 'YieldFarmTerminated': {
        const stopped = yields.get(`${globalFarmId}:${Number(row.yield_farm_id)}`)
        if (stopped) stopped.live = false
        break
      }
      default:
        break
    }
  }

  const live: LiveFarm[] = []
  for (const farm of yields.values()) {
    const global = globals.get(farm.globalFarmId)
    if (!farm.live || !global?.live || !Number.isFinite(farm.assetId)) continue
    const endsAt = new Date(global.startedAt.getTime()
      + global.plannedYieldingPeriods * global.blocksPerPeriod * Number(RELAY_BLOCK_SECONDS) * 1000)
    live.push({
      globalFarmId: farm.globalFarmId,
      yieldFarmId: farm.yieldFarmId,
      assetId: farm.assetId,
      rewardAssetId: global.rewardAssetId,
      multiplier: farm.multiplier,
      yieldPerPeriod: global.yieldPerPeriod,
      maxRewardPerPeriod: global.maxRewardPerPeriod,
      blocksPerPeriod: global.blocksPerPeriod,
      plannedYieldingPeriods: global.plannedYieldingPeriods,
      startedAt: global.startedAt,
      endsAt,
    })
  }
  return live.sort((a, b) => a.assetId - b.assetId || a.globalFarmId - b.globalFarmId)
}

/**
 * Global farms running more than one live yield farm at once.
 *
 * `total_shares_z` is summed across a global farm's yield farms, so its budget is
 * split between them — but the denominator available here is per ASSET, which would
 * hand each of them the whole budget. No global farm in the chain's history has ever
 * had two live yield farms; rather than publish an overstatement if one appears,
 * every asset under such a farm reports null.
 */
function splitAcrossYieldFarms(farms: LiveFarm[]): Set<number> {
  const perGlobal = new Map<number, number>()
  for (const farm of farms) perGlobal.set(farm.globalFarmId, (perGlobal.get(farm.globalFarmId) ?? 0) + 1)
  return new Set([...perGlobal].filter(([, count]) => count > 1).map(([id]) => id))
}

/** Half up on a non-negative fraction. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n)
}

/**
 * A farm's APR as an integer count of 10^-PERC_DECIMALS percent, or null when an
 * input is missing.
 *
 * Integer arithmetic end to end (AGENTS.md): the two branches are single fractions
 * rounded once, so nothing is rounded twice and no double touches a rate built from
 * 128-bit reward amounts.
 *
 * `farmedValueUsd` and `rewardPriceUsd` are integer counts of 1e-12 USD. A farm with
 * nothing staked in it takes the uncapped branch, which is the pallet's own
 * `total_shares_z <= 0` case.
 */
export function farmAprPercScaled(farm: LiveFarm, farmedValueUsd: bigint | null, rewardPriceUsd: bigint | null): bigint | null {
  if (farmedValueUsd == null || rewardPriceUsd == null) return null
  if (farm.blocksPerPeriod <= 0) return null
  const periodBlocks = BigInt(farm.blocksPerPeriod)

  // 100 · multiplier · yield_per_period · secondsPerYear / (6 · blocksPerPeriod)
  const uncapped = divRoundHalfUp(
    farm.multiplier * farm.yieldPerPeriod * SECONDS_PER_YEAR * 100n * PERC_UNIT,
    FIXED_ONE * FIXED_ONE * RELAY_BLOCK_SECONDS * periodBlocks,
  )
  if (farmedValueUsd <= 0n) return uncapped

  // 100 · max_reward_per_period · periodsPerYear · price / staked.
  // No `· multiplier`: it cancels against the same factor inside the pallet's
  // total_shares_z, which `farmedValueUsd` does not carry (see the header).
  const rewardUnit = 10n ** BigInt(assetDescriptor(farm.rewardAssetId).decimals)
  const capped = divRoundHalfUp(
    farm.maxRewardPerPeriod * SECONDS_PER_YEAR * rewardPriceUsd * 100n * PERC_UNIT,
    RELAY_BLOCK_SECONDS * periodBlocks * rewardUnit * farmedValueUsd,
  )
  return capped < uncapped ? capped : uncapped
}

interface FarmTvlRow {
  asset_id: string
  positions: string
  farmed_shares: string
  pool_shares: string
  reserve_raw: string
  sample_time: string
}
interface FarmPriceRow { asset_id: string; close: string; price_time: string }

/**
 * The USD value of the farmed positions in an asset: their share of the pool's
 * shares, taken out of the pool's reserve, at the asset's own current price.
 *
 * The reserve side is used rather than the hub side on purpose — it is the same
 * value at spot, and it avoids resting every farm's denominator on the LRNA feed,
 * which hangs off one thin position.
 */
function farmedValueUsd(row: FarmTvlRow, priceUsd: bigint | undefined): bigint | null {
  if (priceUsd == null) return null
  const poolShares = BigInt(row.pool_shares)
  if (poolShares <= 0n) return null
  const unit = 10n ** BigInt(assetDescriptor(Number(row.asset_id)).decimals)
  return BigInt(row.farmed_shares) * BigInt(row.reserve_raw) * priceUsd / (poolShares * unit)
}

/**
 * A farmed-position model that reports zero farmed positions for EVERY asset is the
 * LP reconstruction being down, not every farm losing its liquidity at once — and
 * an empty farm takes the uncapped branch, so reading the outage literally would
 * publish every farm's ceiling rate. Null is the honest answer.
 */
function isFarmedModelEmpty(rows: FarmTvlRow[]): boolean {
  return rows.length > 0 && rows.every(row => Number(row.positions) === 0)
}

/** Farm APR per Omnipool asset id, at the yield surface's anchor. */
export async function omnipoolFarmAprByAsset(client: ClickHouseClient, anchor: string): Promise<Map<string, AssetFarmApr>> {
  const configRes = await client.query({ query: buildFarmConfigSql(), format: 'JSONEachRow' })
  const farms = foldLiveFarms(await configRes.json<FarmConfigRow>())
  if (!farms.length) return new Map()

  const at = new Date(iso(anchor))
  const split = splitAcrossYieldFarms(farms)
  if (split.size) {
    console.warn(`[public-api] farm APR: global farm(s) ${[...split].join(', ')} run more than one live yield farm — `
      + 'their budget is split across yield farms but the staked value is per asset, so those assets report null')
  }
  // A farm past its planned schedule or under a split global farm still appears in
  // the result (with a null rate and its reward assets), but nothing needs to be
  // read for it.
  const rateable = farms.filter(farm => farm.endsAt > at && !split.has(farm.globalFarmId))

  const assets = [...new Set(rateable.map(f => f.assetId))].sort((a, b) => a - b)
  const priceAssets = [...new Set([...assets, ...rateable.map(f => f.rewardAssetId)].map(priceAssetId))].sort((a, b) => a - b)

  const [tvlRows, prices] = assets.length
    ? await readFarmInputs(client, anchor, assets, priceAssets)
    : [[] as FarmTvlRow[], new Map<number, bigint>()]

  const outage = isFarmedModelEmpty(tvlRows)
  if (outage) {
    console.warn(`[public-api] farm APR: not one farmed Omnipool position across ${tvlRows.length} incentivised assets — `
      + 'reporting null (check omnipool_position_owner_intervals and the derivations service)')
  }
  const staked = new Map(tvlRows.map(row => [Number(row.asset_id), row]))

  const byAsset = new Map<string, AssetFarmApr>()
  for (const farm of farms) {
    const key = String(farm.assetId)
    const previous = byAsset.get(key)
    const row = staked.get(farm.assetId)
    const value = outage || !row ? null : farmedValueUsd(row, prices.get(priceAssetId(farm.assetId)))
    const apr = farm.endsAt > at && !split.has(farm.globalFarmId)
      ? farmAprPercScaled(farm, value, prices.get(priceAssetId(farm.rewardAssetId)) ?? null)
      : null
    // An asset's rate is the sum over its farms, and a sum missing one of its terms
    // is not a smaller sum — it is unknown. The reward assets are listed either way,
    // so a null rate still says a farm is there.
    const total = apr == null || previous?.farmAprPerc === null
      ? null
      : renderPerc(scaled(previous?.farmAprPerc ?? '0', PERC_DECIMALS) + apr)
    byAsset.set(key, {
      farmAprPerc: total,
      rewardAssetIds: [...new Set([...previous?.rewardAssetIds ?? [], String(farm.rewardAssetId)])],
    })
  }
  return byAsset
}

/** The staked value and current prices the rateable farms need, read together. */
async function readFarmInputs(
  client: ClickHouseClient, anchor: string, assets: number[], priceAssets: number[],
): Promise<[FarmTvlRow[], Map<number, bigint>]> {
  const [tvlRes, priceRes] = await Promise.all([
    client.query({
      query: buildFarmTvlSql(),
      query_params: { assets, anchor, stateHours: STATE_SAMPLE_HOURS },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    }),
    client.query({
      query: buildFarmPriceSql(),
      query_params: { priceAssets, anchor, lookbackDays: PRICE_LOOKBACK_DAYS },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    }),
  ])
  return [
    await tvlRes.json<FarmTvlRow>(),
    new Map((await priceRes.json<FarmPriceRow>()).map(row => [Number(row.asset_id), scaledUsd(row.close)])),
  ]
}
