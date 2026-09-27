import type { AccountRef, AssetRef } from './explorerService.ts'
import { SNAPSHOT_GRID_BLOCKS, type SnapshotCoverage, type SnapshotResolution } from './poolSnapshots.ts'

// Bounded, provenance-carrying Omnipool state history, per listed asset — the
// pure half. The query half is getOmnipoolSnapshots in poolService.
//
// `/explorer/omnipool/snapshots?asset=…` is the Omnipool twin of
// `/explorer/pool/:poolId/snapshots` (same window, resolution, limit, coverage
// and caching contract, stated in poolSnapshots.ts). The Omnipool has no share
// token: its liquidity is held per LISTED ASSET, and every price inside it is
// that asset's hub reserve over its reserve, so a point carries, per requested
// asset, the asset's own state and, once per point, the H2O totals the prices
// and weights are read against.
//
// Every value except the fee is the per-block snapshot's (raw_block_snapshots
// `omnipool`): the exact replay decodes the payloads, the grid reads the MV's
// extraction of the same payloads (see omnipoolGridObservations), so a grid
// point and a replayed block agree on the same block. Two facts a reader cannot see
// in a payload are supplied beside it: the listing history (Omnipool.TokenAdded /
// TokenRemoved — an asset can leave and come back, as asset 11 and 19 did), so a
// delisted asset ENDS at its removal instead of repeating its last stored row;
// and the asset fee, which is chain storage the indexer never snapshots, read
// off the asset's last sale out of the pool (see invertAssetFeePermill).

/** Assets per request: each is one column of every point. */
export const MAX_OMNIPOOL_SNAPSHOT_ASSETS = 8

/** Substrate's Permill denominator. */
const PERMILL = 1_000_000n
/**
 * The smallest sale (amount out, base units) whose event fixes a unique fee
 * rate: at a gross output G ≥ 1e6 each Permill step moves the split by at least
 * one unit, so the fee reads back unambiguously (invertAssetFeePermill).
 */
export const FEE_SALE_MIN_OUT = 1_000_000

export interface OmnipoolAssetFee {
  /** Parts per MILLION (2500 = 0.25%). */
  permill: number
  /** The sale it was read off: the newest Omnipool.SellExecuted at or before the point with this asset OUT and at least FEE_SALE_MIN_OUT base units out. */
  block: number
  eventIndex: number
}

export interface OmnipoolAssetPoint {
  /** Raw integer in the asset's own base units: the Omnipool account's balance of it. */
  reserve: string
  /** Raw H2O (12 decimals) the asset's sub-pool holds. */
  hubReserve: string
  /** Raw integer LP shares issued for the asset, and the protocol-owned part of them. */
  shares: string
  protocolShares: string
  /** Weight cap as stored: FixedU128-scaled Permill, 1e18 = 100% of the pool's hub reserve. */
  cap: string
  /** Omnipool Tradability bits (1 sell · 2 buy · 4 add liquidity · 8 remove liquidity), and their names. */
  tradable: number
  tradableFlags: string[]
  /** Null when no sale out of the pool precedes the point, or its fee cannot be read back (see semantics.fees). */
  assetFee: OmnipoolAssetFee | null
}

export interface OmnipoolSnapshotPoint {
  block: number
  hash: string | null
  /** `YYYY-MM-DD HH:MM:SS`, UTC. */
  time: string
  t: number
  /** `hour`/`day` only: the calendar bucket this observation stands for. */
  bucket?: string
  specVersion: number | null
  /** The pool-wide H2O side at this block: every listed asset's hub reserve summed, and how many assets that is. */
  hub: { reserveTotal: string; assetCount: number }
  /** Per requested asset (same order as `assets`); null where the asset is not in the pool at this block. */
  assets: (OmnipoolAssetPoint | null)[]
}

export interface OmnipoolListingInterval {
  /** Block of the Omnipool.TokenAdded that listed it; null when the ledger holds no add (never, on this chain's history). */
  listedAt: number | null
  /** Block of the Omnipool.TokenRemoved that ended it; null while it is still listed. */
  removedAt: number | null
}

export interface OmnipoolListing {
  /** One entry per requested asset, in `assets` order. */
  assetId: number
  status: 'listed' | 'delisted'
  /** Oldest first. An asset can be removed and listed again. */
  intervals: OmnipoolListingInterval[]
  /** The asset's first and last observation on the 600-block grid. */
  firstObservedBlock: number | null
  lastObservedBlock: number | null
}

export interface OmnipoolSnapshotCoverage extends SnapshotCoverage {
  /**
   * Per requested asset: returned points at which the listing history says the
   * asset was IN the pool but the payload carries no entry for it — an index gap,
   * never a zero reserve. Zero on every live asset so far.
   */
  assetGaps: { assetId: number; count: number }[]
}

export interface OmnipoolSnapshotsResponse {
  kind: 'omnipool'
  name: 'Omnipool'
  account: AccountRef
  hubAsset: AssetRef
  /** Column order of every point's `assets`. */
  assets: AssetRef[]
  listings: OmnipoolListing[]
  window: { fromBlock: number; toBlock: number }
  resolution: { kind: SnapshotResolution; stepBlocks: number | null; stepSec: number | null; gridBlocks: number }
  semantics: { points: string; reserves: string; hub: string; fees: string; listing: string; missing: string }
  coverage: OmnipoolSnapshotCoverage
  points: OmnipoolSnapshotPoint[]
}

/* ============ request ============ */

/**
 * The `asset` parameter: one to MAX_OMNIPOOL_SNAPSHOT_ASSETS registry ids,
 * comma-separated, first mention kept. A string saying what is wrong otherwise,
 * in the caller's words.
 */
export function parseOmnipoolAssetParam(raw: unknown): number[] | string {
  if (typeof raw !== 'string' || !raw.trim()) return 'asset is required: one or more Omnipool asset ids, comma-separated (asset=222 or asset=0,222)'
  const ids: number[] = []
  for (const part of raw.split(',')) {
    const s = part.trim()
    if (!/^\d{1,10}$/.test(s) || Number(s) > 0xffff_ffff) return `asset: "${s}" is not an asset id`
    const id = Number(s)
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length > MAX_OMNIPOOL_SNAPSHOT_ASSETS) return `asset: at most ${MAX_OMNIPOOL_SNAPSHOT_ASSETS} assets per request`
  return ids
}

/* ============ listing history ============ */

export interface ListingEventRow { block_height: number; event_index: number; event_name: string; asset_id: number }

/**
 * Listing intervals per asset from the Omnipool's own add/remove events,
 * oldest first. A removal with no add before it (a ledger that starts mid-life)
 * opens its interval at null rather than inventing a listing block.
 */
export function listingIntervals(rows: readonly ListingEventRow[]): Map<number, OmnipoolListingInterval[]> {
  const out = new Map<number, OmnipoolListingInterval[]>()
  const sorted = [...rows].sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)
  for (const r of sorted) {
    const id = Number(r.asset_id)
    const list = out.get(id) ?? []
    out.set(id, list)
    const open = list.length ? list[list.length - 1] : null
    if (r.event_name === 'Omnipool.TokenAdded') {
      if (open && open.removedAt == null) continue // a replayed add of the open interval
      list.push({ listedAt: Number(r.block_height), removedAt: null })
    } else if (r.event_name === 'Omnipool.TokenRemoved') {
      if (open && open.removedAt == null) open.removedAt = Number(r.block_height)
      else if (!open || open.removedAt !== Number(r.block_height)) list.push({ listedAt: null, removedAt: Number(r.block_height) })
    }
  }
  return out
}

/**
 * Whether the asset is in the pool in the state AFTER `block` — the state a
 * snapshot of that block holds: listed from its TokenAdded block on, gone from
 * its TokenRemoved block on.
 */
export function isListedAt(intervals: readonly OmnipoolListingInterval[] | undefined, block: number): boolean {
  if (!intervals) return false
  return intervals.some(i => (i.listedAt == null || block >= i.listedAt) && (i.removedAt == null || block < i.removedAt))
}

/** Whether any of the assets is in the pool after `block`. */
export function anyListedAt(byAsset: readonly (readonly OmnipoolListingInterval[] | undefined)[], block: number): boolean {
  return byAsset.some(intervals => isListedAt(intervals, block))
}

/**
 * Whether some block strictly between `from` and `to` had NONE of the assets in
 * the pool. The calendar buckets between two observations that straddle such a
 * stretch are not missing observations — there was nothing of these assets to
 * observe — so coverage does not expect them.
 */
export function unlistedBetween(byAsset: readonly (readonly OmnipoolListingInterval[] | undefined)[], from: number, to: number): boolean {
  if (to - from < 2) return false
  // The listed spans clipped to (from, to), merged; any hole is an unlisted stretch.
  const spans: [number, number][] = []
  for (const intervals of byAsset) {
    for (const i of intervals ?? []) {
      const lo = Math.max(from + 1, i.listedAt ?? -Infinity)
      const hi = Math.min(to - 1, i.removedAt == null ? Infinity : i.removedAt - 1)
      if (lo <= hi) spans.push([lo, hi])
    }
  }
  spans.sort((a, b) => a[0] - b[0])
  let reached = from // highest block covered so far
  for (const [lo, hi] of spans) {
    if (lo > reached + 1) return true
    reached = Math.max(reached, hi)
  }
  return reached < to - 1
}

/**
 * Where a run of grid points must read the payload for cap and tradability:
 * the first point, and each point that is the first at or after a change
 * (a TokenAdded / TradableStateUpdated / AssetWeightCapUpdated block of a
 * requested asset) or that runs under a different runtime than the point
 * before it. Between two such points storage cannot have moved them, so the
 * earlier read stands.
 */
export function paramReadBlocks(points: readonly { block: number; specVersion: number }[], changeBlocks: readonly number[]): number[] {
  if (!points.length) return []
  const reads = [points[0].block]
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const cur = points[i]
    if (cur.specVersion !== prev.specVersion || changeBlocks.some(c => c > prev.block && c <= cur.block)) reads.push(cur.block)
  }
  return reads
}

/* ============ payload ============ */

export interface OmnipoolPayloadAsset { reserve: string; hubReserve: string; shares: string; protocolShares: string; cap: string; tradable: number }

/**
 * One block's `omnipool` payload section: every listed asset by id, and the
 * hub totals across all of them. An asset entry without a reserve or hub
 * reserve is left out rather than read as zero.
 */
export function parseOmnipoolSection(section: unknown): { assets: Map<number, OmnipoolPayloadAsset>; hubReserveTotal: bigint; assetCount: number } {
  const assets = new Map<number, OmnipoolPayloadAsset>()
  let hubReserveTotal = 0n
  const list = (section as { assets?: unknown } | null)?.assets
  if (Array.isArray(list)) {
    for (const a of list as Record<string, unknown>[]) {
      if (a == null || a.asset_id == null || a.reserve == null || a.hub_reserve == null) continue
      const hub = String(a.hub_reserve)
      hubReserveTotal += BigInt(hub)
      assets.set(Number(a.asset_id), {
        reserve: String(a.reserve),
        hubReserve: hub,
        shares: String(a.shares ?? '0'),
        protocolShares: String(a.protocol_shares ?? '0'),
        cap: String(a.cap ?? '0'),
        tradable: Number(a.tradable ?? 0),
      })
    }
  }
  return { assets, hubReserveTotal, assetCount: assets.size }
}

/* ============ fees ============ */

/**
 * The asset-fee rate an Omnipool SELL charged, read back from its event.
 *
 * The pallet computes the gross output G, keeps `(1 − f)·G` rounded down
 * (`Permill::mul_floor`) as the amount out, and names the rest as
 * `assetFeeAmount` — so G = amountOut + assetFeeAmount and f is the Permill
 * whose floor reproduces the split exactly. For G ≥ 1e6 base units consecutive
 * rates give distinct splits, so the answer is unique; a smaller sale can fit
 * several rates, and one that fits none (an event whose shape differs) is not a
 * rate at all — both are null rather than a nearest guess.
 */
export function invertAssetFeePermill(amountOut: bigint, feeAmount: bigint): number | null {
  if (amountOut < 0n || feeAmount < 0n) return null
  const gross = amountOut + feeAmount
  if (gross <= 0n) return null
  const guess = Number((feeAmount * PERMILL + gross / 2n) / gross)
  const fits: number[] = []
  for (let p = Math.max(0, guess - 2); p <= Math.min(1_000_000, guess + 2); p += 1) {
    if (gross - ((PERMILL - BigInt(p)) * gross) / PERMILL === feeAmount) fits.push(p)
  }
  return fits.length === 1 ? fits[0] : null
}

/* ============ semantics ============ */

/** The sentences every response carries, so a reader never has to guess what a point is. */
export function omnipoolSnapshotSemantics(resolution: SnapshotResolution, stepBlocks: number | null, atokenAssets: readonly AssetRef[] = []): OmnipoolSnapshotsResponse['semantics'] {
  const read = 'Each point is the Omnipool\'s state in the indexer\'s snapshot of exactly the block it names (height, hash and time are that block\'s). The indexer re-reads the Omnipool at every block with an Omnipool trade or a balance transfer to or from its account — nearly every block — and otherwise carries its last read, which is the chain\'s state for everything only such a block can move (reserve, hub reserve, shares, protocol shares). A cap or tradability change by governance moves no balance, so it appears from the next re-read, typically within a block or two. Nothing between points is interpolated or carried forward by this route: the value between two points is unknown, not constant.'
  const grid = `The indexer samples the Omnipool at block heights divisible by ${SNAPSHOT_GRID_BLOCKS} (about every 22 minutes); points are chosen on that grid, and a grid point carries exactly what that block's snapshot holds — the same per-block snapshot the exact replay reads.`
  const points = resolution === 'grid'
    ? `${read} ${grid}${stepBlocks != null && stepBlocks > SNAPSHOT_GRID_BLOCKS ? ` This window is thinned to every ${stepBlocks / SNAPSHOT_GRID_BLOCKS}th grid block (one point per ${stepBlocks} blocks).` : ' This window carries every grid block.'}`
    : resolution === 'block'
      ? `${read} This window carries every block, the exact replay.`
      : `${read} ${grid} Each ${resolution} bucket is represented by the LAST grid observation at or before its end — a sample that stands for the bucket, stamped with its own block, not the bucket's closing state.${resolution === 'day' ? ' These are the observations the explorer\'s Omnipool page charts per day.' : ''}`
  // Measured against the node: the stored aDOT reserve sat 0.04–0.67 ppm below the
  // chain's free balance at blocks 14,400,000–15,095,125 (0.23 aDOT at 15,090,000)
  // — interest accrued since the Omnipool last moved aDOT. Every other field,
  // HDX's and HOLLAR's reserves included, matched to the raw unit.
  const reserves = 'reserve is a raw integer in the asset\'s own base units: the Omnipool account\'s free balance of it (HDX from System.Account, an ERC-20 asset from its contract\'s balance, every other asset from Tokens.Accounts); hubReserve is raw H2O (12 decimals); shares and protocolShares are the asset\'s LP share issuance and the protocol-owned part of it, raw; cap is the weight cap as stored (1e18 = 100% of the pool\'s total hub reserve); tradable is the Tradability bitmask (1 sell · 2 buy · 4 add liquidity · 8 remove liquidity) with its names. The asset\'s spot price in H2O is hubReserve / reserve (each scaled by its decimals) and its weight hubReserve / hub.reserveTotal.'
    + (atokenAssets.length
      ? ` ${atokenAssets.map(a => `${a.symbol} (#${a.assetId})`).join(', ')} ${atokenAssets.length === 1 ? 'is a money-market aToken, whose' : 'are money-market aTokens, whose'} reserve is the balance the aToken contract reported at the Omnipool's last re-read — interest accrued since that re-read is NOT included, so the chain's balance at the same block is marginally higher (up to about a part per million).`
      : '')
  const hub = 'hub is the pool-wide H2O side at the point: reserveTotal is every listed asset\'s hub reserve summed (raw, 12 decimals) and assetCount how many assets that is — the denominator of every weight. H2O\'s own USD price is not pool state and is not given here.'
  const fees = `assetFee is the Omnipool asset fee (parts per MILLION, 2500 = 0.25%) charged on the asset's most recent SALE out of the pool at or before the point with at least ${FEE_SALE_MIN_OUT.toLocaleString('en-US')} base units out — block and eventIndex name that Omnipool.SellExecuted — read back exactly from its amountOut and assetFeeAmount (a smaller sale fits several rates, so it is passed over rather than guessed at). It is event-derived: the dynamic fee itself is chain storage (DynamicFees.AssetFee) the indexer does not snapshot, and the runtime recomputes it from the oracle on every trade touching the asset on either side (decaying toward the runtime's floor, 0.25% today), so it is the rate last CHARGED, not a quote for a trade at the point. Null when no such sale precedes the point in the index or the event predates fee amounts (below block 3,112,604). The protocol fee is not served: since slip fees were enabled the event's protocolFeeAmount includes the slip fee, so no rate can be read back from it.`
  const listing = 'listings gives each requested asset\'s listing history from the Omnipool\'s own Omnipool.TokenAdded / Omnipool.TokenRemoved events, block-exact. A point after an asset\'s removal carries null for it — the asset ended there; its last stored state is never repeated.'
  const judged = 'Coverage is judged over the returned span only: when coverage.truncated is true the window continues past the last point, coverage.remaining counts the unexamined slots and coverage.nextFromBlock is where to continue.'
  const missing = (resolution === 'grid' || resolution === 'block'
    ? 'coverage.missing lists block heights inside the window with no observation of any requested asset; a missing slot is absent from points, never zero, never a repeat of its neighbour.'
    : 'coverage.missing lists calendar buckets between the first and last returned observation with no grid observation of any requested asset; a missing bucket is absent from points, never zero, never a repeat of its neighbour.')
    + ` coverage.assetGaps counts, per asset, the returned points at which the listing history has it in the pool but the snapshot carries no entry for it. ${judged}`
  return { points, reserves, hub, fees, listing, missing }
}
