import type { ClickHouseClient } from '../../db/client.ts'
import { iso } from '../schemas/common.ts'
import { PERC_DECIMALS, renderPerc } from './farmApr.ts'

// GIGAHDX staking APR for GET /v1/staking/gigahdx/apr, from the indexed models
// in clickhouse/schema/006_public.sql. Normative definition: spec § Semantics 10.
// Two independent yield streams, reported separately and summed:
//
// VOTING (realized, not projected). `pallet-gigahdx-rewards` holds an
// accumulator pot (`gigarwd!`) fed by a treasury programme plus 25% of protocol
// trade fees. When the first voter removes their vote on a COMPLETED
// referendum, the pallet freezes `trackPct × pot` into a per-referendum reward
// pool (GigaHdxRewards.RewardPoolAllocated) and pays each staker-voter pro-rata
// on `min(voteBalance, stakedHDX) × convictionMultiplier` (6x ⇒ ×8 … 1x ⇒
// ×0.25, Split/Abstain/no-conviction ⇒ 0). The published rate is annualized HDX
// actually paid into reward pools over the trailing window, divided by the
// typical weighted votes competing per referendum:
//
//   votingApr = 100 · m_max · paidOutPerYear / medianWeightedVotes
//
// with m_max = 8 (Locked6x) and paidOutPerYear annualized by BLOCK TIMESTAMPS
// (never blocks × an assumed block time). Deliberately a stock-free formula:
// the pallet deletes its per-referendum storage as voters claim, and the
// accumulator pot's balance is a backlog, so neither can carry an honest rate.
// Events cannot be deleted, so this number cannot cliff when storage entries
// are cleaned. The headline is the zero-stake limit; personalized,
// `apr(s, m) = 100 · paidOutPerYear · s·m / (medianWeightedVotes + s·m) / s`,
// computed client-side from the two published terms.
//
// BASE (exchange-rate appreciation). `pallet-gigahdx` holds the `gigahdx!` pot
// (base programme + 15% of trade fees); the gigaHDX exchange rate is
// `max(1, (TotalLocked + pot) / stHDX supply)` and every holder earns its
// growth. The published rate is the MEDIAN of the 7/14/28-day slopes of that
// rate, each annualized by timestamps:
//
//   slope_w = 100 · (rate(anchor)/rate(anchor − w) − 1) · secondsPerYear/(w·86400)
//
// A median of three windows is used instead of one two-point delta so a single
// anomalous boundary sample cannot move the result (the one-window form
// amplifies boundary jitter ×13 at 28d). Both rate endpoints are exact integer
// reconstructions: TotalLocked and supply are sums over the deduplicated
// gigahdx_stake_events flows (TotalLocked validated against pallet storage to
// 3e8 planck on 1.24e21), the pot from the indexed balance history.
//
// THE FLOORS. While the treasury programme runs (HDX referendum #101, a fixed
// series of payments to ~mid-2027), each pot receives its drip whatever anyone
// does — 4,109.59 HDX per 600 blocks to gigahdx!, 6,164.38 to gigarwd! — so at
// total participation neither stream pays less than programme/totalStake. The
// floors are guaranteed only while the programme runs; the measured terms need
// no such caveat — they follow a programme change with their windows' lag.

/** 10^-PERC_DECIMALS steps per 1 (shared with farmApr's wire convention). */
const PERC_UNIT = 10n ** BigInt(PERC_DECIMALS)

/** Seconds in the year the rates are quoted over (365.2425 days, as farmApr). */
const SECONDS_PER_YEAR = 31_556_952n

/** Locked6x reward multiplier — `conviction_reward_multiplier / 100` = 800/100. */
const MAX_CONVICTION_MULTIPLIER = 8n

/**
 * GIGAHDX launch: the enactment block of HDX referendum #358 (block 12,959,351,
 * 2026-07-01 07:11:36 UTC). No allocation or flow exists before it; every
 * window is clamped here so a young programme is annualized over the time it
 * actually existed rather than over a window it did not.
 */
export const GIGAHDX_LAUNCH = new Date('2026-07-01T07:11:36.000Z')

/** Trailing window the realized voting rate is measured over. */
export const VOTING_WINDOW_DAYS = 60

/**
 * The base rate is the median slope over these windows; a window longer than
 * the pallet's age is skipped, so the youngest measurable base is 7 days old
 * (before that the floor stands alone, which is the launch gate).
 */
export const BASE_SLOPE_WINDOWS_DAYS = [7, 14, 28] as const

/**
 * The treasury drips: HDX per 600 blocks into each pot. 600 blocks are 3,600 s
 * at the chain's present 6 s cadence, which is what the per-year floors are
 * quoted over; the programme schedules per BLOCK, so a block-time change
 * rescales the floors and this constant's comment is where that lands.
 */
const PROGRAMME_VOTING_PLANCK_PER_TICK = 6_164_380_000_000_000n
const PROGRAMME_BASE_PLANCK_PER_TICK = 4_109_590_000_000_000n
const PROGRAMME_TICK_SECONDS = 3_600n

/** One reward-pool allocation, as `gigahdx_reward_allocations` carries it. */
export interface AllocationRow {
  ref_index: string
  track_id: string
  total_reward: string
  total_weighted_votes: string
  block_height: string
  event_index: string
  block_timestamp: string
}

/**
 * The staking state reconstructed at one boundary timestamp: TotalLocked and
 * stHDX supply from the flow sums, the gigahdx! pot from balance history.
 * Nulls mean "nothing indexed at that time" and propagate honestly.
 */
export interface RateSample {
  /** TotalLocked + pot, planck; null when no flow row exists at the boundary. */
  totalStake: bigint | null
  /** stHDX total issuance, planck; null alongside totalStake. */
  supply: bigint | null
}

export interface GigahdxApr {
  asOf: string
  /** base + voting headline; null when either side is unknown. */
  totalAprPerc: string | null

  /** max(measured, floor) for the exchange-rate stream. */
  baseAprPerc: string | null
  /** Median of the 7/14/28d rate slopes; null in the first 7 days. */
  baseAprMeasuredPerc: string | null
  baseAprFloorPerc: string | null

  /** max(measured, floor) for the voting stream. */
  votingAprPerc: string | null
  /** The realized term alone; null while no allocation is in the window. */
  votingAprMeasuredPerc: string | null
  votingAprFloorPerc: string | null

  /** TotalLocked + the gigahdx! pot at the anchor, raw planck. */
  totalStake: string | null
  votingWindowFrom: string
  votingWindowDays: number
  allocationsInWindow: number
  /** HDX actually paid into reward pools inside the window, raw planck. */
  paidOut: string
  /** The same flow annualized by timestamps, raw planck per year. */
  paidOutPerYear: string
  /** Upper median of the window's per-referendum weighted-vote totals, raw units. */
  medianWeightedVotes: string | null
}

/** Half up on a fraction with a positive denominator; sign rides the numerator. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n)
  return negative ? -rounded : rounded
}

/**
 * Whole history, deduplicated on the event identity: the table is a
 * ReplacingMergeTree over re-insertable raw ranges, so rows collapse through
 * argMax BEFORE anything sums them (AGENTS.md replay rule). The full set is
 * ~one row per completed referendum with GIGAHDX voters (~500/yr), so reading
 * it whole and windowing in TS keeps the window arithmetic in one place —
 * bigint, next to the median.
 */
export function buildAllocationsSql(): string {
  return `-- pub:gigahdx:allocations
SELECT toString(ref_index) AS ref_index,
       toString(argMax(track_id, ingested_at)) AS track_id,
       argMax(total_reward, ingested_at) AS total_reward,
       argMax(total_weighted_votes, ingested_at) AS total_weighted_votes,
       toString(block_height) AS block_height,
       toString(event_index) AS event_index,
       toString(argMax(block_timestamp, ingested_at)) AS block_timestamp
FROM price_data.gigahdx_reward_allocations
GROUP BY ref_index, block_height, event_index`
}

/**
 * The flow sums at each rate boundary, deduplicated first, cut by timestamp:
 * TotalLocked(T) = Σ Staked.hdx + Σ YieldRealized.hdx − Σ Unstaked.hdx and
 * supply(T) = Σ Staked.gigahdx − Σ Unstaked.gigahdx, with signs applied by the
 * caller per event_name. gigahdx_amount is '' on YieldRealized (a realize moves
 * pot HDX into the lock without touching supply), guarded to 0 before the cast.
 */
export function buildStakeFlowsSql(): string {
  return `-- pub:gigahdx:stake
SELECT event_name,
       toString(sumIf(hdx, ts <= {t0:DateTime})) AS hdx_0,
       toString(sumIf(giga, ts <= {t0:DateTime})) AS giga_0,
       toString(sumIf(hdx, ts <= {t7:DateTime})) AS hdx_7,
       toString(sumIf(giga, ts <= {t7:DateTime})) AS giga_7,
       toString(sumIf(hdx, ts <= {t14:DateTime})) AS hdx_14,
       toString(sumIf(giga, ts <= {t14:DateTime})) AS giga_14,
       toString(sumIf(hdx, ts <= {t28:DateTime})) AS hdx_28,
       toString(sumIf(giga, ts <= {t28:DateTime})) AS giga_28
FROM (
  SELECT event_name, block_height, event_index,
         any(block_timestamp) AS ts,
         toDecimal256(argMax(if(hdx_amount = '', '0', hdx_amount), ingested_at), 0) AS hdx,
         toDecimal256(argMax(if(gigahdx_amount = '', '0', gigahdx_amount), ingested_at), 0) AS giga
  FROM price_data.gigahdx_stake_events
  GROUP BY event_name, block_height, event_index
)
GROUP BY event_name`
}

/** The gigahdx! pallet account, hex as the balance models key it. */
const GIGAPOT_ACCOUNT = '0x6d6f646c67696761686478210000000000000000000000000000000000000000'

/**
 * The gigahdx! pot at each rate boundary: the newest balance observation at or
 * before it. Key-prefix bounded — one account, one asset — over the indexed
 * balance history (the pot is native HDX with no locks, so `total` is its free
 * balance). An empty string means no observation existed by that boundary.
 */
export function buildPotHistorySql(): string {
  return `-- pub:gigahdx:pot
SELECT toString(argMaxIf(total, block_height, block_timestamp <= {t0:DateTime})) AS pot_0,
       toString(argMaxIf(total, block_height, block_timestamp <= {t7:DateTime})) AS pot_7,
       toString(argMaxIf(total, block_height, block_timestamp <= {t14:DateTime})) AS pot_14,
       toString(argMaxIf(total, block_height, block_timestamp <= {t28:DateTime})) AS pot_28
FROM price_data.account_balance_history
WHERE account_id = {account:String} AND asset_id = '0'`
}

/** The anchor every window here hangs off: the newest indexed block (Semantics 6). */
export function buildAnchorSql(): string {
  return `-- pub:gigahdx:anchor
SELECT toString(max(block_timestamp)) AS anchor FROM price_data.blocks`
}

export interface GigahdxAprInputs {
  allocations: AllocationRow[]
  /** Rate samples at the anchor and at each slope boundary, keyed by window days (0 = anchor). */
  samples: Map<number, RateSample>
  /** Latest indexed block timestamp. */
  anchor: Date
}

/** rate(T) as an exact fraction, floored at 1: (max(stake, supply), supply). */
function rateFraction(sample: RateSample | undefined): [bigint, bigint] | null {
  if (!sample || sample.totalStake == null || sample.supply == null || sample.supply <= 0n) return null
  return [sample.totalStake > sample.supply ? sample.totalStake : sample.supply, sample.supply]
}

/**
 * The rates, from already-read inputs. Pure so the arithmetic — window clamps,
 * timestamp annualization, medians, slope fractions, floor maxes — pins under
 * test without a database.
 */
export function computeGigahdxApr({ allocations, samples, anchor }: GigahdxAprInputs): GigahdxApr {
  const ageDays = (anchor.getTime() - GIGAHDX_LAUNCH.getTime()) / 86_400_000

  // ---- voting: realized paid-out over the trailing window ----
  const votingFrom = new Date(Math.max(anchor.getTime() - VOTING_WINDOW_DAYS * 86_400_000, GIGAHDX_LAUNCH.getTime()))
  const votingSpanSeconds = BigInt(Math.max(1, Math.floor((anchor.getTime() - votingFrom.getTime()) / 1000)))

  const inWindow = allocations.filter(row => {
    const at = Date.parse(iso(row.block_timestamp))
    return at > votingFrom.getTime() && at <= anchor.getTime()
  })
  const paidOut = inWindow.reduce((sum, row) => sum + BigInt(row.total_reward), 0n)
  const paidOutPerYear = paidOut * SECONDS_PER_YEAR / votingSpanSeconds

  // Upper median (sorted[⌊n/2⌋]), matching the UI's sample median so the two
  // surfaces cannot disagree on the same inputs.
  const weights = inWindow.map(row => BigInt(row.total_weighted_votes)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const medianWeighted = weights.length ? weights[weights.length >> 1] : null

  const votingMeasured = medianWeighted != null && medianWeighted > 0n
    ? divRoundHalfUp(100n * MAX_CONVICTION_MULTIPLIER * paidOutPerYear * PERC_UNIT, medianWeighted)
    : null

  // ---- base: median slope of the exchange rate ----
  const now = rateFraction(samples.get(0))
  const slopes: bigint[] = []
  if (now) {
    for (const windowDays of BASE_SLOPE_WINDOWS_DAYS) {
      if (ageDays < windowDays) continue
      const then = rateFraction(samples.get(windowDays))
      if (!then) continue
      // rateNow/rateThen − 1 = (Nn·Dt − Nt·Dn) / (Nt·Dn), annualized over the
      // window's exact wall-clock span.
      const [nNow, dNow] = now
      const [nThen, dThen] = then
      slopes.push(divRoundHalfUp(
        100n * PERC_UNIT * SECONDS_PER_YEAR * (nNow * dThen - nThen * dNow),
        BigInt(windowDays) * 86_400n * nThen * dNow,
      ))
    }
  }
  slopes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const baseMeasured = slopes.length ? slopes[slopes.length >> 1] : null

  // ---- floors ----
  const totalStake = samples.get(0)?.totalStake ?? null
  const floorOf = (dripPerTick: bigint): bigint | null => totalStake != null && totalStake > 0n
    ? divRoundHalfUp(100n * dripPerTick * SECONDS_PER_YEAR * PERC_UNIT, PROGRAMME_TICK_SECONDS * totalStake)
    : null
  const votingFloor = floorOf(PROGRAMME_VOTING_PLANCK_PER_TICK)
  const baseFloor = floorOf(PROGRAMME_BASE_PLANCK_PER_TICK)

  // max(measured, floor) per stream: the pallet pays the larger of "what was
  // measured" and the programme's guaranteed dilution bound. With one side
  // unknown the other stands alone; with both unknown the stream is null, and
  // a total missing one of its streams is not a smaller total — it is unknown.
  const headline = (measured: bigint | null, floor: bigint | null): bigint | null =>
    measured != null && floor != null ? (measured > floor ? measured : floor) : measured ?? floor
  const votingApr = headline(votingMeasured, votingFloor)
  const baseApr = headline(baseMeasured, baseFloor)

  return {
    asOf: iso(anchor),
    totalAprPerc: baseApr != null && votingApr != null ? renderPerc(baseApr + votingApr) : null,
    baseAprPerc: baseApr != null ? renderPerc(baseApr) : null,
    baseAprMeasuredPerc: baseMeasured != null ? renderPerc(baseMeasured) : null,
    baseAprFloorPerc: baseFloor != null ? renderPerc(baseFloor) : null,
    votingAprPerc: votingApr != null ? renderPerc(votingApr) : null,
    votingAprMeasuredPerc: votingMeasured != null ? renderPerc(votingMeasured) : null,
    votingAprFloorPerc: votingFloor != null ? renderPerc(votingFloor) : null,
    totalStake: totalStake?.toString() ?? null,
    votingWindowFrom: iso(votingFrom),
    votingWindowDays: Number(votingSpanSeconds) / 86_400,
    allocationsInWindow: inWindow.length,
    paidOut: paidOut.toString(),
    paidOutPerYear: paidOutPerYear.toString(),
    medianWeightedVotes: medianWeighted?.toString() ?? null,
  }
}

interface FlowSumsRow {
  event_name: string
  hdx_0: string; giga_0: string
  hdx_7: string; giga_7: string
  hdx_14: string; giga_14: string
  hdx_28: string; giga_28: string
}
interface PotRow { pot_0: string; pot_7: string; pot_14: string; pot_28: string }

/**
 * The rate samples from the two boundary reads. A boundary with not one flow
 * row yet (pre-launch, or an empty database) reports nulls rather than a
 * rate of 0/0.
 */
export function foldRateSamples(flows: FlowSumsRow[], pot: PotRow | undefined): Map<number, RateSample> {
  const samples = new Map<number, RateSample>()
  for (const [windowDays, suffix] of [[0, '0'], [7, '7'], [14, '14'], [28, '28']] as const) {
    let locked = 0n
    let supply = 0n
    for (const row of flows) {
      const hdx = BigInt(row[`hdx_${suffix}`])
      const giga = BigInt(row[`giga_${suffix}`])
      const sign = row.event_name === 'Unstaked' ? -1n : 1n
      locked += sign * hdx
      supply += sign * giga
    }
    const potRaw = pot?.[`pot_${suffix}`]
    const potFree = potRaw ? BigInt(potRaw) : 0n
    samples.set(windowDays, flows.length
      ? { totalStake: locked + potFree, supply }
      : { totalStake: null, supply: null })
    // A boundary CUT can legitimately hold zero flows while the table has rows
    // (a boundary before launch): supply is 0 there, which rateFraction
    // rejects, so the slope for that window is skipped rather than invented.
  }
  return samples
}

export async function gigahdxApr(client: ClickHouseClient): Promise<GigahdxApr> {
  const anchorRes = await client.query({ query: buildAnchorSql(), format: 'JSONEachRow' })
  const [head] = await anchorRes.json<{ anchor: string }>()
  const anchor = new Date(iso(head?.anchor || 0))
  const boundary = (days: number) => iso(new Date(anchor.getTime() - days * 86_400_000)).replace('T', ' ').slice(0, 19)
  const boundaries = { t0: boundary(0), t7: boundary(7), t14: boundary(14), t28: boundary(28) }

  const [allocRes, flowRes, potRes] = await Promise.all([
    client.query({ query: buildAllocationsSql(), format: 'JSONEachRow' }),
    client.query({ query: buildStakeFlowsSql(), query_params: boundaries, format: 'JSONEachRow' }),
    client.query({ query: buildPotHistorySql(), query_params: { ...boundaries, account: GIGAPOT_ACCOUNT }, format: 'JSONEachRow' }),
  ])
  const allocations = await allocRes.json<AllocationRow>()
  const flows = await flowRes.json<FlowSumsRow>()
  const [pot] = await potRes.json<PotRow>()

  return computeGigahdxApr({ allocations, samples: foldRateSamples(flows, pot), anchor })
}
