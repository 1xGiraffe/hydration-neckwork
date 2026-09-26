import type { AccountRef, AssetRef } from './explorerService.ts'
import { makeGrain } from './historyGrain.ts'

// Bounded, provenance-carrying pool state history — the pure half.
//
// The stableswap and XYK pool pages chart DAILY series rebuilt from the
// indexer's 600-block state grid: scaled floats, one value per day, carried
// forward across empty days so a chart has no holes. A simulation that
// calibrates on a pool's inventory cannot use that shape — it needs the raw
// integer reserves aligned per asset, the exact block each observation was
// read at (height, hash, time), the pool parameters standing at that block,
// and to know when a slot has NO observation rather than a repeated one.
//
// `/explorer/pool/:poolId/snapshots` is that read model. Every point it returns
// is chain storage read at exactly the block it names; nothing between points
// is interpolated or carried. This module holds the arithmetic — window
// planning, stride selection, coverage, alignment — with no database in reach,
// so each rule is testable on its own. The query half is getPoolSnapshots in
// poolService.

/** The indexer samples every pool's state at heights divisible by this (stableswap_pool_state_history_mv). */
export const SNAPSHOT_GRID_BLOCKS = 600

export const SNAPSHOT_RESOLUTIONS = ['grid', 'hour', 'day', 'block'] as const
export type SnapshotResolution = typeof SNAPSHOT_RESOLUTIONS[number]

/** Points per response, whichever resolution; the caller pages with `nextFromBlock`. */
export const MAX_SNAPSHOT_POINTS = 1000
export const DEFAULT_SNAPSHOT_POINTS = 200
/**
 * The exact per-block read decodes the whole block payload (~270 KB, every
 * pool of every venue) to reach one pool's entry — measured at ~60 MiB read and
 * 60 ms for 200 blocks — so its window is short and the caller pages.
 */
export const MAX_EXACT_BLOCKS = 200
/** How many missing slots a response names before it only counts them. */
export const MISSING_LIST_CAP = 50

export const BUCKET_STEP_SEC = { hour: 3_600, day: 86_400 } as const

export interface SnapshotRequest {
  fromBlock?: number
  toBlock?: number
  /** Unix seconds. */
  fromTs?: number
  toTs?: number
  resolution: SnapshotResolution
  /** `grid` only: the stride in blocks, rounded UP to a multiple of the grid. */
  stepBlocks?: number
  limit: number
}

export interface SnapshotPeg { num: string; den: string; price: number }

export interface PoolSnapshotPoint {
  block: number
  /** Null only when the block's snapshot row carries no hash. */
  hash: string | null
  /** `YYYY-MM-DD HH:MM:SS`, UTC — the spelling every explorer timestamp uses. */
  time: string
  /** Unix seconds of `time`. */
  t: number
  /** `hour`/`day` only: the calendar bucket this observation stands for. */
  bucket?: string
  /** Raw integer per header asset (same order as `assets`); null where the observation lacks that asset. */
  reserves: (string | null)[]
  /** Per header asset, or null when the pool has no pegs (every XYK pool, most stableswap pools). */
  pegs: (SnapshotPeg | null)[] | null
  /** Raw integer share-token supply; see `semantics.issuance` for what "at this block" means per venue. */
  issuance: string | null
  amplification: number | null
  /** Present while an amplification change is ramping (initial ≠ final). */
  amplificationRamp: { initial: number; final: number; initialBlock: number; finalBlock: number } | null
  /** Substrate Permill: parts per MILLION (400 = 0.04%). */
  feePermill: number | null
  specVersion: number | null
}

export interface SnapshotCoverage {
  /** The pool's first and last observation on the grid — its life as the index knows it. */
  firstObservedBlock: number | null
  lastObservedBlock: number | null
  /** Slots the window should carry at this resolution, inside the pool's life. */
  expected: number
  returned: number
  missingCount: number
  /** The first MISSING_LIST_CAP missing slots: block heights (`grid`/`block`) or bucket keys (`hour`/`day`). */
  missing: (number | string)[]
  /** Slots of the requested window past the returned span — unexamined, neither present nor missing. */
  remaining: number
  /** True when the window holds more points than `limit`; continue with `fromBlock: nextFromBlock`. */
  truncated: boolean
  nextFromBlock: number | null
}

export interface PoolSnapshotsResponse {
  kind: 'stableswap' | 'xyk'
  poolId: number
  name: string
  shareToken: AssetRef
  account: AccountRef
  /** Column order of every point's `reserves` and `pegs`. */
  assets: AssetRef[]
  /** The resolved block window the points and coverage describe (each point carries its own time). */
  window: { fromBlock: number; toBlock: number }
  resolution: { kind: SnapshotResolution; stepBlocks: number | null; stepSec: number | null; gridBlocks: number }
  semantics: { points: string; reserves: string; missing: string; issuance: string; fee: string }
  coverage: SnapshotCoverage
  points: PoolSnapshotPoint[]
}

/* ============ request rules ============ */

/**
 * What is wrong with a request, in the caller's words, or null. These are the
 * rules a 400 states, kept apart from the route so the tool tier can quote the
 * same sentence.
 */
export function snapshotRequestProblem(req: SnapshotRequest): string | null {
  if (req.fromBlock != null && req.toBlock != null && req.fromBlock > req.toBlock) return 'fromBlock must not exceed toBlock'
  if (req.fromTs != null && req.toTs != null && req.fromTs > req.toTs) return 'fromTs must not exceed toTs'
  if (req.resolution === 'block' && (req.fromTs != null || req.toTs != null)) {
    return "resolution 'block' is addressed by height: window it with fromBlock/toBlock, not fromTs/toTs"
  }
  if (req.stepBlocks != null && req.resolution !== 'grid') return "stepBlocks applies to resolution 'grid' only"
  return null
}

/* ============ grid arithmetic ============ */

/** How many multiples of `step` lie in [fromBlock, toBlock]. */
export function countSlots(fromBlock: number, toBlock: number, step: number): number {
  if (toBlock < fromBlock || step <= 0) return 0
  return Math.max(0, Math.floor(toBlock / step) - Math.ceil(fromBlock / step) + 1)
}

/** The multiples of `step` in [fromBlock, toBlock], ascending. */
export function gridSlots(fromBlock: number, toBlock: number, step: number): number[] {
  const out: number[] = []
  if (step <= 0) return out
  for (let b = Math.ceil(fromBlock / step) * step; b <= toBlock; b += step) out.push(b)
  return out
}

/** A caller's stride rounded UP to the grid, so every point is an observation. */
export function normalizeStride(stepBlocks: number, grid = SNAPSHOT_GRID_BLOCKS): number {
  return Math.max(1, Math.ceil(stepBlocks / grid)) * grid
}

/**
 * The stride that fits a window's grid slots into `limit` points: the smallest
 * multiple of the grid whose slot count over the window is at most `limit`.
 * Thinning by stride rather than by bucket keeps every point on the chain's own
 * grid, so the same block answers the same point whatever window it is asked in.
 */
export function strideFor(fromBlock: number, toBlock: number, limit: number, grid = SNAPSHOT_GRID_BLOCKS): number {
  const slots = countSlots(fromBlock, toBlock, grid)
  return Math.max(1, Math.ceil(slots / Math.max(1, limit))) * grid
}

/* ============ coverage ============ */

/** Expected slots against the ones present: the count and the first few names. */
export function missingSlots<T extends number | string>(expected: readonly T[], present: Iterable<T>): { missingCount: number; missing: T[] } {
  const have = new Set(present)
  const missing: T[] = []
  let missingCount = 0
  for (const slot of expected) {
    if (have.has(slot)) continue
    missingCount += 1
    if (missing.length < MISSING_LIST_CAP) missing.push(slot)
  }
  return { missingCount, missing }
}

/** The calendar buckets a time span touches, as the keys the points carry. */
export function bucketSlots(resolution: 'hour' | 'day', fromSec: number, toSec: number): string[] {
  if (toSec < fromSec) return []
  return makeGrain(BUCKET_STEP_SEC[resolution]).grid(fromSec, toSec)
}

export function bucketKeyOf(resolution: 'hour' | 'day', sec: number): string {
  return makeGrain(BUCKET_STEP_SEC[resolution]).keyOf(sec)
}

/* ============ alignment ============ */

/**
 * One observation's per-asset values laid out in the header's asset order.
 * A header asset the observation does not carry is null — an absent leg is
 * not an empty one.
 */
export function alignToAssets<T>(headerIds: readonly number[], rowIds: readonly number[], values: readonly T[]): (T | null)[] {
  return headerIds.map(id => {
    const i = rowIds.indexOf(id)
    return i >= 0 && i < values.length ? values[i] : null
  })
}

/**
 * The header asset order for a run of observations: the newest observation's
 * order first, then any id an older observation carried that the newest does
 * not — so a pool whose asset set changed still lays every reserve it ever
 * held under a column.
 */
export function headerAssetIds(rowsOldestFirst: readonly { assetIds: readonly number[] }[]): number[] {
  const out: number[] = []
  for (let i = rowsOldestFirst.length - 1; i >= 0; i -= 1) {
    for (const id of rowsOldestFirst[i].assetIds) if (!out.includes(id)) out.push(id)
  }
  return out
}

/* ============ semantics ============ */

const GRID_MINUTES = 22

export function resolutionDescriptor(resolution: SnapshotResolution, stepBlocks: number | null): PoolSnapshotsResponse['resolution'] {
  return {
    kind: resolution,
    stepBlocks: resolution === 'grid' ? stepBlocks : resolution === 'block' ? 1 : null,
    stepSec: resolution === 'hour' || resolution === 'day' ? BUCKET_STEP_SEC[resolution] : null,
    gridBlocks: SNAPSHOT_GRID_BLOCKS,
  }
}

/** The sentences every response carries, so a reader never has to guess what a point is. */
export function snapshotSemantics(kind: 'stableswap' | 'xyk', resolution: SnapshotResolution, stepBlocks: number | null, atokenLegs: readonly AssetRef[] = []): PoolSnapshotsResponse['semantics'] {
  const exact = 'Each point is the pool\'s state read from chain storage at exactly the block it names (height, hash and time are that block\'s). Nothing between points is interpolated or carried forward: the value between two points is unknown, not constant.'
  const grid = `The indexer samples every pool at block heights divisible by ${SNAPSHOT_GRID_BLOCKS} (about every ${GRID_MINUTES} minutes).`
  const points = resolution === 'grid'
    ? `${exact} ${grid}${stepBlocks != null && stepBlocks > SNAPSHOT_GRID_BLOCKS ? ` This window is thinned to every ${stepBlocks / SNAPSHOT_GRID_BLOCKS}th grid block (one point per ${stepBlocks} blocks).` : ' This window carries every grid block.'}`
    : resolution === 'block'
      ? `${exact} This window carries every block, the exact replay.`
      : `${exact} ${grid} Each ${resolution} bucket is represented by the LAST grid observation at or before its end — a sample that stands for the bucket, stamped with its own block, not the bucket's closing state. ${resolution === 'day' ? 'These are the same observations the explorer\'s pool page charts per day.' : ''}`.trim()
  const judged = 'Coverage is judged over the returned span only: when coverage.truncated is true the window continues past the last point, coverage.remaining counts the unexamined slots and coverage.nextFromBlock is where to continue.'
  const missing = resolution === 'grid' || resolution === 'block'
    ? `coverage.missing lists block heights inside the window with no observation of this pool; a missing slot is absent from points, never zero, never a repeat of its neighbour. ${judged}`
    : `coverage.missing lists calendar buckets between the first and last returned observation with no grid observation of this pool; a missing bucket is absent from points, never zero, never a repeat of its neighbour. ${judged}`
  // Measured on pool 110 at block 15,072,000: the stored aUSDC leg was
  // 807,348,710,299 against the chain's balanceOf of 807,349,250,973 — 0.54
  // aUSDC of interest accrued since the pool account last touched the aToken.
  const reserves = 'reserves are raw integers in the asset\'s own base units, aligned to `assets`: a Substrate asset\'s is the pool account\'s free balance in storage at the block; an ERC-20 asset\'s is its balance slot in the contract\'s storage at the block.'
    + (atokenLegs.length
      ? ` ${atokenLegs.map(a => `${a.symbol} (#${a.assetId})`).join(', ')} ${atokenLegs.length === 1 ? 'is a money-market aToken, whose' : 'are money-market aTokens, whose'} reserve is the pool account's scaled balance × the liquidity index cached at the pool's last aToken interaction — interest accrued since that interaction is NOT included, so the chain's balanceOf at the same block is marginally higher (parts per million over hours).`
      : '')
  const issuance = kind === 'stableswap'
    ? 'issuance is the share token\'s total supply as read from storage at the point\'s block.'
    : 'issuance is the LP token supply standing at the point\'s block: the last supply change at or before it, which is block-exact because XYK supply moves only on liquidity events.'
  const fee = kind === 'stableswap'
    ? 'feePermill is Substrate\'s Permill, parts per MILLION (400 = 0.04%), as stored at the block; amplification is the effective value at the block, with the ramp beside it while one is in progress.'
    : 'feePermill is the runtime\'s fixed XYK trade fee, parts per MILLION (3000 = 0.3%); XYK pools have no amplification and no pegs.'
  return { points, reserves, missing, issuance, fee }
}
