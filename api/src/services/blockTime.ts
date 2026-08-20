import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { runtimeParaBlockMs } from './runtimeConstants.ts'

// One home for "how long is a Hydration block".
//
// Three different numbers hide behind that question and they are NOT
// interchangeable:
//
//  1. The RELAY block time — a solid 6s. Polkadot is not part of Hydration's
//     block-time migration, so anything anchored on relay heights (vesting
//     schedules, `ParachainSystem.LastRelayChainBlockNumber` extrapolation)
//     keeps the hard 6000 in `NOMINAL_RELAY_BLOCK_MS` and must never be routed
//     through the parachain pace.
//  2. The parachain's NOMINAL block interval, `MILLISECS_PER_BLOCK` in the
//     runtime (6000 today, 2000 after the planned upgrade). Every runtime
//     block-count constant is DERIVED from it — `DAYS`, the GIGAHDX cooldown,
//     conviction lock periods — so it is the right slope for turning one of
//     those block counts into a duration. It is NOT `aura.slotDuration`:
//     runtime 440 decouples the author slot (which stays 6000) from the block
//     interval, so that constant reads 6000 on both sides of the switch. See
//     `runtimeParaBlockMs` for the two wall-clock-premised constants that do
//     track it.
//  3. The parachain's MEASURED pace. Elastic scaling means real production runs
//     ahead of the nominal slot: ~5.4–5.8s per block against a 6000ms nominal
//     as of Aug 2026. It is the right number for "how many blocks did the chain
//     actually produce in the last N hours".
//
// (2) is read from runtime metadata when the node is reachable
// (runtimeConstants.ts — an in-memory property read on the pending layer's
// connection) and only INFERRED from indexed blocks when it is not. The
// inference is deliberately conservative, because a wrong nominal is worse than
// a stale one: it multiplies block counts up to ~400k, so adopting the wrong
// rung doubles every projected unlock date and rewrites the whole lock
// snapshot. See resolveParaBlockTime for the three guards that make inference
// safe — a two-rung ladder, a wall-clock-anchored sample, and a refusal to MOVE
// on an out-of-band measurement.

// The relay chain's slot time. Not affected by Hydration's 2s migration.
export const NOMINAL_RELAY_BLOCK_MS = 6_000
// `MILLISECS_PER_BLOCK` in the Hydration runtime today, and the starting value
// for the resolution below before anything has been read or measured.
export const NOMINAL_PARA_BLOCK_MS = 6_000
// Blocks per hour at the nominal slot time — the pre-measurement constant the
// window helpers degrade to.
export const NOMINAL_BLOCKS_PER_HOUR = 3_600_000 / NOMINAL_PARA_BLOCK_MS

// Slot times Hydration's runtime can be on: 6s today, 2s planned. A measured
// pace is snapped to the nearest of these, so an inferred nominal is a step
// function that changes exactly once, at the runtime upgrade, instead of
// tracking throughput noise.
//
// The retired 12s era is deliberately NOT a rung. The chain cannot go back to
// it, and keeping it turned a stall into a date error: measured over 600k
// blocks, ~1% of 100-block windows ran slow enough (>8 485ms, the 6s/12s
// geometric boundary) to resolve to 12 000 and double every projected date.
export const RUNTIME_SLOT_MS_LADDER = [6_000, 2_000] as const

// Sanity band for a measured average. Outside it the read is garbage (empty
// table, a single sampled block, a clock skew) and the nominal is used instead.
const MIN_PLAUSIBLE_BLOCK_MS = 500
const MAX_PLAUSIBLE_BLOCK_MS = 20_000

// How far real production may sit from its nominal slot before a measurement
// stops being evidence about which rung the chain is on. Elastic scaling puts
// today's pace at ~0.92× nominal and a stall pushes it the other way; the
// rungs are 3× apart, so this band accepts ordinary drift and rejects anything
// ambiguous. A rejected measurement does not pick a rung at all (see
// resolveParaBlockTime).
const NOMINAL_MATCH_BAND: readonly [number, number] = [0.6, 1.3]

// A 24h sample needs to be a real day of blocks before its average means
// anything. Below this the window is a partial backfill or a fresh database.
const MIN_DAILY_SAMPLE_BLOCKS = 1_000

export type BlockTimeSource = 'metadata' | 'measured' | 'held'

export interface ResolvedBlockTime {
  // The parachain's nominal slot time, in ms.
  nominalMs: number
  // Where it came from. 'metadata' is authoritative; 'measured' was inferred
  // from a good sample; 'held' means neither was available and the last known
  // (or starting) value is being kept.
  source: BlockTimeSource
  // The wall-clock-anchored sample the resolution saw, or null when the chain
  // could not be measured at all. A caller that must distinguish "measured 6s"
  // from "could not measure" reads THIS, not nominalMs.
  measuredMs: number | null
}

// Average milliseconds per block over the newest `sampleBlocks` indexed blocks.
// Same shape as the `avg_block` sub-select in getStats (explorerService), kept
// pure so a unit test can pin it without a live ClickHouse.
//
// This is the THROUGHPUT sample: short, recent, and responsive, which is what
// "how fast is the chain going right now" wants and exactly what deciding a
// slot time must not use. It reads `blocks`, whose writer probes existing
// heights before inserting into its plain MergeTree. `raw_blocks` is replayable
// ReplacingMergeTree input; reading its physical newest 100 rows during a replay
// can yield only 50 distinct blocks and halve the measured pace until a merge.
export function avgBlockMsSql(sampleBlocks = 100): string {
  const n = Math.max(2, Math.round(sampleBlocks))
  return `SELECT toFloat64(dateDiff('millisecond', min(block_timestamp), max(block_timestamp)) / greatest(count() - 1, 1)) AS ms
    FROM (SELECT block_timestamp FROM price_data.blocks ORDER BY block_height DESC LIMIT ${n})`
}

// Blocks produced in the last 24 hours. Dividing a fixed span of WALL CLOCK by
// the block count is what makes this sample burst- and stall-proof: a 100-block
// window can be entirely inside one stall, but a day cannot, and the sample
// size (~15k blocks today) is set by the day rather than by a block count that
// would itself shrink at the upgrade. This is the sample the nominal is
// inferred from.
export function dailyBlockCountSql(): string {
  return `SELECT count() AS n FROM price_data.blocks WHERE block_timestamp >= now() - INTERVAL 24 HOUR`
}

// Floor/ceiling guard around a measured average: an implausible read falls back
// to the nominal slot time rather than propagating a nonsense slope.
export function clampBlockMs(ms: number | null | undefined): number {
  if (ms == null || !Number.isFinite(ms)) return NOMINAL_PARA_BLOCK_MS
  if (ms < MIN_PLAUSIBLE_BLOCK_MS || ms > MAX_PLAUSIBLE_BLOCK_MS) return NOMINAL_PARA_BLOCK_MS
  return ms
}

// Milliseconds per block implied by a 24h block count, or null when the count
// cannot support an average. Pure, so the guards are unit-testable.
export function dailyBlockMs(blocksInDay: number | null | undefined): number | null {
  if (blocksInDay == null || !Number.isFinite(blocksInDay) || blocksInDay < MIN_DAILY_SAMPLE_BLOCKS) return null
  const ms = 86_400_000 / blocksInDay
  if (ms < MIN_PLAUSIBLE_BLOCK_MS || ms > MAX_PLAUSIBLE_BLOCK_MS) return null
  return ms
}

// The runtime slot time a measured pace points at: the ladder rung closest in
// RATIO (a 5.5s measurement is 0.92× the 6s rung and 2.75× the 2s one, so the
// comparison has to be multiplicative, not absolute). Only meaningful when
// nominalBlockMsMismatch() accepts the same measurement.
export function resolveNominalBlockMs(measuredMs: number): number {
  let best: number = NOMINAL_PARA_BLOCK_MS
  let bestErr = Infinity
  for (const rung of RUNTIME_SLOT_MS_LADDER) {
    const err = Math.abs(Math.log(clampBlockMs(measuredMs) / rung))
    if (err < bestErr) { bestErr = err; best = rung }
  }
  return best
}

// Non-null when the measured pace does not sit plausibly around EITHER rung —
// a stall, a burst, or a slot time this module does not know about. The
// resolution treats it as "no evidence" and holds its previous value; it is the
// load-bearing guard, because no sample size makes an out-of-band reading
// impossible, only rarer.
export function nominalBlockMsMismatch(measuredMs: number): string | null {
  const measured = clampBlockMs(measuredMs)
  const nominal = resolveNominalBlockMs(measured)
  const ratio = measured / nominal
  if (ratio >= NOMINAL_MATCH_BAND[0] && ratio <= NOMINAL_MATCH_BAND[1]) return null
  return `measured ${Math.round(measured)}ms/block is ${ratio.toFixed(2)}× the nearest known runtime slot time (${nominal}ms); `
    + `the chain is stalled/bursting, or a new slot time needs adding to RUNTIME_SLOT_MS_LADDER in services/blockTime.ts`
}

// Blocks the chain produces per hour at a given slot/pace.
export const blocksPerHour = (msPerBlock: number): number => 3_600_000 / clampBlockMs(msPerBlock)

// The nominal a failed or implausible MEASUREMENT degrades to: the runtime's
// own answer while the node is reachable, else the last nominal this process
// established, else the pre-measurement constant. Degrading to the bare
// constant instead would make one bad 100-block read report 6s throughput on a
// 2s chain for a whole cache window even while metadata says 2000ms.
function degradedNominalMs(): number {
  return runtimeParaBlockMs() ?? heldNominalMs ?? NOMINAL_PARA_BLOCK_MS
}

async function readAvgBlockMs(client: ClickHouseClient): Promise<number> {
  try {
    const res = await client.query({ query: avgBlockMsSql(100), format: 'JSONEachRow' })
    const raw = Number((await res.json<{ ms: number | null }>())[0]?.ms ?? 0)
    if (Number.isFinite(raw) && raw >= MIN_PLAUSIBLE_BLOCK_MS && raw <= MAX_PLAUSIBLE_BLOCK_MS) return raw
    const nominal = degradedNominalMs()
    console.warn(`[blocktime] implausible measured block time (${raw}ms), using the ${nominal}ms nominal`)
    return nominal
  } catch (err) {
    const nominal = degradedNominalMs()
    console.warn(`[blocktime] block-time measurement failed, using the ${nominal}ms nominal`, err)
    return nominal
  }
}

// The parachain's measured pace in ms/block, over the newest 100 indexed
// blocks. Cached ~30s: it is read on request paths, and the sample only moves
// meaningfully over minutes. Use this for THROUGHPUT questions ("how many
// blocks in the last N hours", "how fast is the chain going"); use
// paraBlockMs() for durations derived from a runtime block-count constant.
export async function measuredParaBlockMs(client: ClickHouseClient): Promise<number> {
  return cached('blocktime:measured-para-ms', 30_000, () => readAvgBlockMs(client))
}

// The WALL-CLOCK-ANCHORED sample (a full day of blocks — NOT the 100-block one
// measuredParaBlockMs returns), or null when the chain could not be measured:
// the read failed, or the last 24h hold too few blocks for an average to mean
// anything. Null is a distinct answer from any number, which is what lets the
// fuse-period tripwire say "pin unverified" instead of silently reporting that
// everything matches.
export async function measuredParaBlockMsOrNull(client: ClickHouseClient): Promise<number | null> {
  return cached('blocktime:daily-para-ms', 300_000, async () => {
    try {
      const res = await client.query({ query: dailyBlockCountSql(), format: 'JSONEachRow' })
      const n = Number((await res.json<{ n: number | null }>())[0]?.n ?? 0)
      const ms = dailyBlockMs(n)
      if (ms == null) console.warn(`[blocktime] 24h window holds ${n} blocks — too few to infer a slot time`)
      return ms
    } catch (err) {
      console.warn('[blocktime] daily block-count measurement failed', err)
      return null
    }
  })
}

// The resolution decision, as a pure function of its three inputs, so the
// guard that actually carries the risk — refusing to MOVE — is testable without
// a clock, a cache or a database.
//
//   fromMetadata  the runtime's own answer, or null when the node is unreachable
//   measuredMs    the wall-clock-anchored sample, or null when unmeasurable
//   heldMs        the last nominal this process established, or null on first use
export function decideParaBlockTime(
  fromMetadata: number | null,
  measuredMs: number | null,
  heldMs: number | null,
): ResolvedBlockTime & { warning: string | null } {
  // Metadata first: authoritative, free, and correct the instant the runtime
  // upgrades. It also makes every guard below moot while the node is up.
  if (fromMetadata != null) {
    const changed = heldMs != null && heldMs !== fromMetadata
    return {
      nominalMs: fromMetadata,
      source: 'metadata',
      measuredMs,
      warning: changed
        ? `runtime slot time changed ${heldMs}ms → ${fromMetadata}ms; re-pin the block-count constants that are NOT read from metadata (SECURITY_FUSE_PERIOD_BLOCKS)`
        : null,
    }
  }
  const held = heldMs ?? NOMINAL_PARA_BLOCK_MS
  if (measuredMs == null) {
    return {
      nominalMs: held,
      source: 'held',
      measuredMs: null,
      warning: `runtime metadata unavailable and the chain could not be measured; holding ${held}ms/block`,
    }
  }
  // Refuse to MOVE on an out-of-band measurement. Adopting a rung during a
  // stall would rescale every projected date and republish the whole lock
  // snapshot; keeping the previous answer costs nothing while it recovers, and
  // no sample size makes an out-of-band reading impossible — only rarer.
  const anomaly = nominalBlockMsMismatch(measuredMs)
  if (anomaly) {
    return {
      nominalMs: held,
      source: 'held',
      measuredMs,
      warning: `${anomaly}; holding ${held}ms/block rather than moving`,
    }
  }
  return { nominalMs: resolveNominalBlockMs(measuredMs), source: 'measured', measuredMs, warning: null }
}

// The last nominal this process actually established. Held across resolutions
// so an unmeasurable or out-of-band moment cannot MOVE the value — the worst a
// bad sample can do is leave the previous answer in place.
let heldNominalMs: number | null = null

// Resolve the parachain's nominal slot time, preferring the runtime's own
// answer and inferring only when it is unavailable. Cached 5min: the value it
// can take is a step function, so re-deriving it per request buys nothing.
export async function resolveParaBlockTime(client: ClickHouseClient): Promise<ResolvedBlockTime> {
  return cached('blocktime:nominal-para', 300_000, async () => {
    const decision = decideParaBlockTime(
      runtimeParaBlockMs(),
      await measuredParaBlockMsOrNull(client),
      heldNominalMs,
    )
    if (decision.warning) console.warn(`[blocktime] ${decision.warning}`)
    // Only a resolution that actually established a value updates the hold; a
    // held outcome must not overwrite what it is holding.
    if (decision.source !== 'held') heldNominalMs = decision.nominalMs
    const { warning: _warning, ...resolved } = decision
    return resolved
  })
}

// The parachain's NOMINAL slot time: 6000 today, 2000 after the planned
// upgrade. Unlike a raw measurement it does not wobble between refreshes, which
// is what dated snapshot rows need — see lockBreakdownService's projector.
export async function paraBlockMs(client: ClickHouseClient): Promise<number> {
  return (await resolveParaBlockTime(client)).nominalMs
}
