import type { ClickHouseClient } from '../../db/client.ts'
import { blockClockCovering, clockCoveredSec, heightAtOrBeforeExact, type BlockClock } from '../../services/blockClock.ts'
import { MONDAY_ANCHOR_SEC, makeBucketing } from '../../services/bucketLadder.ts'
import { loadLpHistory, type LpSpan, type LpVenue } from '../../services/lpHistory.ts'
import { renderUsd } from '../../services/valuation.ts'
import { iso } from '../schemas/common.ts'
import type { ParsedAddress } from './address.ts'
import { dataStatus } from './head.ts'
import { resolveWindow } from './statsData.ts'

// GET /v1/accounts/{address}/liquidity/history — the account's LP positions per
// bucket, on the definition services/lpHistory.ts shares with the explorer. This
// module only resolves the window onto a fixed-grain grid and renders the wire.

// The window machinery is not LP-specific: every account-history route on a fixed
// hour/day/week grid (/liquidity/history, /money-market/history) resolves its
// window, "ended" rule, caps and finality margin here.
export type HistoryBucket = 'hour' | 'day' | 'week'
export type LpHistoryGroupBy = 'position' | 'account'

export const BUCKET_HISTORY_DEFAULT_BUCKETS = 90
export const BUCKET_HISTORY_MAX_BUCKETS = 400

export const BUCKET_HISTORY_STEP_SEC: Record<HistoryBucket, number> = { hour: 3_600, day: 86_400, week: 7 * 86_400 }
const ANCHOR_SEC: Record<HistoryBucket, number> = { hour: 0, day: 0, week: MONDAY_ANCHOR_SEC }

export interface BucketHistoryWindow { from: number; to: number; step: number; anchor: number }

/**
 * The window as whole buckets: every bucket whose START lies in [fromTime,
 * toTime], and only buckets that have ENDED by `nowSec` (a bucket still open has
 * no closed candle at its end). `nowSec` is the INDEXED instant, not the wall
 * clock (resolveBucketHistoryWindow): a bucket the index has not reached the end of
 * is still open as far as its sources are concerned. Defaults: the newest 90
 * ended buckets. A span over 400 buckets, or one holding no ended bucket, is a 400.
 */
export function bucketHistoryWindow(bucket: HistoryBucket, fromTime: number | undefined, toTime: number | undefined, nowSec: number, label = 'liquidity history'): BucketHistoryWindow {
  const step = BUCKET_HISTORY_STEP_SEC[bucket]
  const anchor = ANCHOR_SEC[bucket]
  const floorTo = (t: number) => anchor + Math.floor((t - anchor) / step) * step
  const lastEnd = floorTo(nowSec)
  const to = toTime == null ? lastEnd : Math.min(lastEnd, floorTo(toTime) + step)
  const from = fromTime == null ? to - BUCKET_HISTORY_DEFAULT_BUCKETS * step : floorTo(fromTime + step - 1)
  const window = resolveWindow(from, to, BUCKET_HISTORY_DEFAULT_BUCKETS * step, BUCKET_HISTORY_MAX_BUCKETS * step, label, step)
  return { ...window, step, anchor }
}

// The finality margin and the two cache lifetimes of a bucketed history window
// (services/lpHistory.ts), shared with the explorer's windowed histories.
export { BUCKET_HISTORY_CLOSED_TTL_MS, BUCKET_HISTORY_FINALITY_SEC, BUCKET_HISTORY_SETTLING_TTL_MS } from '../../services/lpHistory.ts'

export interface ResolvedBucketHistoryWindow {
  window: BucketHistoryWindow
  /** A clock covering `window.to`, so every bucket end resolves exactly. */
  clock: BlockClock
  /** Block time of the indexed head (unix seconds). */
  headSec: number
}

/**
 * The window against the INDEX, not the wall clock: a bucket is returned only
 * once the indexed head's block time has reached its end (raw ingestion can lag
 * the wall clock by minutes, and a bucket the head is still inside would carry
 * the head's height and a candle still taking rows), and only once the chain
 * clock covers its end — a clock up to a minute old would otherwise date the end
 * by a height the chain has since passed. The clock is refreshed on demand for
 * that; if the blocks table itself lags, the window clamps to what it covers.
 */
export async function resolveBucketHistoryWindow(
  client: ClickHouseClient, bucket: HistoryBucket, fromTime: number | undefined, toTime: number | undefined, nowMs: number = Date.now(), label = 'liquidity history',
): Promise<ResolvedBucketHistoryWindow> {
  const status = await dataStatus(client)
  const parsedHead = Math.floor(Date.parse(status.indexedHeadTime) / 1000)
  const headSec = Number.isFinite(parsedHead) ? parsedHead : 0
  const indexedNow = Math.min(Math.floor(nowMs / 1000), headSec)
  let window = bucketHistoryWindow(bucket, fromTime, toTime, indexedNow, label)
  const clock = await blockClockCovering(client, window.to)
  const covered = clockCoveredSec(clock)
  if (covered != null && covered < window.to) window = bucketHistoryWindow(bucket, fromTime, toTime, Math.min(indexedNow, covered), label)
  return { window, clock, headSec }
}

/** The fixed-grid Bucketing for a resolved window: every end dated by its exact at-or-before height. */
export function windowBucketing(window: BucketHistoryWindow, clock: BlockClock) {
  const heightAt = (sec: number) => heightAtOrBeforeExact(clock, sec)
  return makeBucketing(clock, window.from, window.to, heightAt(window.from) ?? 0, undefined, undefined, {
    stepSec: window.step, anchorSec: window.anchor, heightAt, dating: { key: 'exact', heightAt },
  })
}

interface WireLeg { assetId: string; amount: string; valueUsd: string | null }
interface WireReward { depositId: string; globalFarmId: number; yieldFarmId: number; assetId: string; amount: string; valueUsd: string | null }
interface WireSpan { fromBlock: number; fromTime: string | null; toBlock: number | null; toTime: string | null; kind: 'direct' | 'farmed' }
export interface LpHistoryResponse {
  bucket: HistoryBucket
  from: string
  to: string
  points: Array<{ bucket: string; blockHeight: number; valueUsd: string; unpriced: number; unclaimedRewardsUsd: string; rewardsIncomplete: number }>
  positions?: Array<{
    venue: LpVenue
    farmed: boolean
    positionId: string | null
    poolKey: string
    shareAssetId: string | null
    spans: WireSpan[]
    points: Array<{ bucket: string; blockHeight: number; shares: string; legs: WireLeg[]; valueUsd: string | null; unclaimedRewards: WireReward[] }>
  }>
  positionsOmitted?: number
}

const wireSpan = (s: LpSpan): WireSpan => ({
  fromBlock: s.fromBlock, fromTime: s.fromTime == null ? null : iso(s.fromTime * 1000),
  toBlock: s.toBlock, toTime: s.toTime == null ? null : iso(s.toTime * 1000),
  kind: s.kind,
})

export async function liquidityHistory(
  client: ClickHouseClient,
  parsed: ParsedAddress,
  opts: { bucket: HistoryBucket; window: BucketHistoryWindow; clock: BlockClock; venues?: ReadonlySet<LpVenue>; groupBy: LpHistoryGroupBy },
): Promise<LpHistoryResponse> {
  const { window, bucket, clock } = opts
  // Every boundary is an hour mark (the window is step-aligned) the clock covers
  // (resolveBucketHistoryWindow), so each bucket end resolves to the exact last block
  // at or before it.
  const bk = windowBucketing(window, clock)
  const history = await loadLpHistory(client, {
    accounts: [parsed.accountId],
    // The EVM side of the account: its bound H160, else the runtime's truncation of
    // the AccountId32 — where a substrate account's position NFTs and vault shares sit.
    h160s: [parsed.evmAddress ?? `0x${parsed.accountId.slice(2, 42)}`],
  }, bk, { grain: bucket === 'hour' ? '1h' : '1d', venues: opts.venues, spanTimes: opts.groupBy !== 'account' })

  const startIso = (b: number) => iso((bk.endSec(b) - bk.step) * 1000)
  const response: LpHistoryResponse = {
    bucket,
    from: iso(window.from * 1000),
    to: iso(window.to * 1000),
    points: history.points.map(p => ({
      bucket: startIso(p.b), blockHeight: bk.endHeight(p.b), valueUsd: renderUsd(p.usd), unpriced: p.unpriced,
      unclaimedRewardsUsd: renderUsd(p.rewardsUsd), rewardsIncomplete: p.rewardsIncomplete,
    })),
  }
  if (opts.groupBy === 'account') return response
  response.positions = history.positions.map(p => ({
    venue: p.venue, farmed: p.farmed, positionId: p.positionId, poolKey: p.poolKey, shareAssetId: p.shareAssetId,
    spans: p.spans.map(wireSpan),
    points: p.points.map(pt => ({
      bucket: startIso(pt.b), blockHeight: bk.endHeight(pt.b), shares: pt.shares.toString(),
      legs: pt.legs.map(l => ({ assetId: String(l.assetId), amount: l.amount.toString(), valueUsd: l.usd == null ? null : renderUsd(l.usd) })),
      valueUsd: pt.usd == null ? null : renderUsd(pt.usd),
      unclaimedRewards: pt.rewards.map(r => ({
        depositId: r.depositId, globalFarmId: r.globalFarmId, yieldFarmId: r.yieldFarmId,
        assetId: String(r.assetId), amount: r.amount.toString(), valueUsd: r.usd == null ? null : renderUsd(r.usd),
      })),
    })),
  }))
  response.positionsOmitted = history.positionsOmitted
  return response
}
