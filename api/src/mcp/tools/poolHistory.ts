import { z } from 'zod'
import { formatParam, type ToolContext, type ToolDefinition, type ToolOutput } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import { UpstreamError } from '../upstream.ts'
import type { PoolSnapshotPoint, PoolSnapshots, PoolSnapshotResolution } from '../types.ts'
import { DASH, formatAmount, formatCount } from '../format/units.ts'
import { formatTime } from '../format/time.ts'
import { assetLabel, assetLabelWithId, assetUrl, blockUrl, explorerLink, poolUrl } from '../format/refs.ts'
import { bullets, h2, h3, joinBlocks, kv, note, table } from '../format/md.ts'
import { JSON_BUDGET_MARGIN, failure, fit, output, parseInput } from './shared.ts'

/**
 * A pool's state as exact observations — the series a simulation calibrates on.
 *
 * `get_pools` with `include: ['history']` summarises the pool page's daily TVL
 * chart in five numbers, which is what a reader wants and what a model
 * calibrating liquidity or arbitrage cannot use: it needs the raw integer
 * reserves aligned per asset, the pegs and issuance beside them, and the block
 * each observation was read at. `/explorer/pool/:poolId/snapshots` is that
 * read model, and this tool is its window onto it — bounded, with the route's
 * own semantics and coverage repeated in the reply rather than paraphrased.
 */

const RESOLUTIONS = ['grid', 'hour', 'day', 'block'] as const satisfies readonly PoolSnapshotResolution[]

/** Points per call. The JSON form fits fewer (see `trimToBudget`), and says so. */
const DEFAULT_POINTS = 48
const MAX_POINTS = 100

/** A rendered point row: time, block, one cell per asset, the drifting pegs, issuance, A, fee. */
const ROW_BASE_CHARS = 70
const ROW_CHARS_PER_ASSET = 22

const V3_ADDRESS = /^0x[0-9a-fA-F]{40}$/

const DESCRIPTION = `A pool's state history as exact observations: raw integer reserves per asset, peg rationals, share issuance, amplification and fee, each stamped with the block it was read at (height, hash, time). Answers "how did the PRIME/HOLLAR reserves move last week?", "when did pool 110 run short of aUSDC?", "what were the pegs at block 14,400,000?", and feeds a liquidity or arbitrage simulation the aligned series it calibrates on. get_pools with include 'history' gives a five-number TVL summary; this tool gives the points.

'pool' is a stableswap or XYK pool's SHARE-TOKEN id (143, 110, 111, 105...). The Omnipool and Uniswap v3 pools are not served here.

Every point is chain storage read at exactly the block it names — never interpolated, never carried forward — so the value between two points is unknown, not constant. 'resolution' chooses the sampling:
- 'grid' (default): the indexer's 600-block grid (height divisible by 600, about every 22 minutes), thinned to every Nth grid block so the window fits 'limit' points; 'stepBlocks' fixes the stride instead (rounded up to a multiple of 600) and the window is then paged.
- 'hour' / 'day': one point per calendar bucket — the LAST grid observation at or before the bucket's end, standing for the bucket and stamped with its own block. 'day' points are the observations behind the explorer pool page's daily chart.
- 'block': every block, exact — the replay mode, at most 200 blocks per call; window it with fromBlock/toBlock only.

Window with fromBlock/toBlock (heights) or fromTs/toTs (unix SECONDS, not dates); with neither, the newest 'limit' points. 'limit' is points per call (default 48, max 100); a reply that stops short says so under coverage.truncated, counts the unexamined rest in coverage.remaining and names coverage.nextFromBlock to continue from. coverage.missing lists the slots inside the returned span with no observation — a gap is a gap, never zero inventory.

The markdown table scales amounts by each asset's decimals; format 'json' carries the raw integers (reserves, peg num/den, issuance as strings), the block hash and specVersion per point, and fits fewer points per call than markdown. feePermill is Substrate's Permill: parts per MILLION (400 = 0.04%). One reading to know: a money-market aToken leg (aUSDC in pool 110, aUSDT in 111) is stored as the pool's scaled balance × its last cached liquidity index, so interest accrued since the pool last touched that aToken is not in the figure — the reply's semantics.reserves names such legs.`

/* ============ budget ============ */

const serializedLength = (value: unknown): number => JSON.stringify(value, null, 2).length

/**
 * The structured record cut to the text budget by whole points, with the
 * coverage restated so the cut is a paged window rather than a silent one.
 *
 * The shared `fitJson` would trim the same array, but it names the loss in a
 * marker field and leaves `coverage` claiming the untrimmed span. Here the
 * trimming is done first, by the measured per-point cost of the pretty-printed
 * form the transport emits, so `coverage.truncated` / `nextFromBlock` /
 * `remaining` are true of what the caller actually receives.
 */
export function trimToBudget(snapshots: PoolSnapshots, budgetChars: number): PoolSnapshots {
  if (!snapshots.points.length || serializedLength(snapshots) <= budgetChars) return snapshots
  const base = serializedLength({ ...snapshots, points: [] })
  const perPoint = (serializedLength(snapshots) - base) / snapshots.points.length
  const keep = Math.max(1, Math.min(snapshots.points.length - 1, Math.floor((budgetChars - base) / perPoint)))
  const points = snapshots.points.slice(0, keep)
  const dropped = snapshots.points.slice(keep)
  const next = dropped[0]
  const res = snapshots.resolution
  // The dropped points are slots the caller has not seen: they move from
  // "returned" to "remaining" and the span ends at the last point kept. Missing
  // slots after the cut are unknown to the caller too, so they leave the count.
  const lastKept = points[points.length - 1]
  const missingBeforeCut = snapshots.coverage.missing.filter(slot => (
    typeof slot === 'number' ? slot <= lastKept.block : res.kind === 'hour' || res.kind === 'day' ? slot <= (lastKept.bucket ?? '') : true
  ))
  const missingDroppedFromList = snapshots.coverage.missing.length - missingBeforeCut.length
  return {
    ...snapshots,
    window: { ...snapshots.window, toBlock: lastKept.block },
    coverage: {
      ...snapshots.coverage,
      returned: points.length,
      // A named-but-cut missing slot is counted once, in the list; the ones the
      // route only counted past its list cap cannot be placed, and stay.
      missingCount: snapshots.coverage.missingCount - missingDroppedFromList,
      missing: missingBeforeCut,
      remaining: snapshots.coverage.remaining + dropped.length,
      truncated: true,
      nextFromBlock: next.block,
    },
    points,
  }
}

/* ============ rendering ============ */

function describeResolution(s: PoolSnapshots): string {
  const r = s.resolution
  if (r.kind === 'block') return 'every block (exact replay)'
  if (r.kind === 'grid') {
    const every = r.stepBlocks != null && r.stepBlocks > r.gridBlocks ? `every ${formatCount(r.stepBlocks / r.gridBlocks)}th grid block (one point per ${formatCount(r.stepBlocks)} blocks)` : 'every grid block'
    return `${r.gridBlocks}-block grid · ${every}`
  }
  return `one point per ${r.kind}: the last grid observation at or before the bucket's end`
}

function coverageLine(c: PoolSnapshots['coverage']): string {
  const parts = [
    `${formatCount(c.expected)} expected`,
    `${formatCount(c.returned)} returned`,
    `${formatCount(c.missingCount)} missing`,
  ]
  if (c.truncated) parts.push(`${formatCount(c.remaining)} more past the last point — continue with fromBlock ${formatCount(c.nextFromBlock)}`)
  return parts.join(' · ')
}

/** Which peg columns earn a place: an asset whose peg is anything but 1/1 somewhere in the window. */
function driftingPegColumns(s: PoolSnapshots): number[] {
  const drifting: number[] = []
  s.assets.forEach((_, i) => {
    if (s.points.some(p => p.pegs?.[i] != null && p.pegs[i]!.price !== 1)) drifting.push(i)
  })
  return drifting
}

/**
 * A peg to four decimals rather than the rough scale: a peg drifts by parts in
 * a thousand (1.0505 → 1.0526 over a fortnight), which three significant digits
 * print as the same "1.05", and this surface exists to show that movement.
 */
const pegCell = (price: number): string => (Number.isFinite(price) ? price.toFixed(4) : DASH)

function pointRow(p: PoolSnapshotPoint, s: PoolSnapshots, pegCols: number[], base: string): string[] {
  return [
    p.bucket ?? formatTime(p.time),
    explorerLink(formatCount(p.block), blockUrl(base, p.block)),
    ...s.assets.map((a, i) => (p.reserves[i] == null ? DASH : formatAmount(p.reserves[i], a.decimals))),
    ...pegCols.map(i => (p.pegs?.[i] == null ? DASH : pegCell(p.pegs[i]!.price))),
    p.issuance == null ? DASH : formatAmount(p.issuance, s.shareToken.decimals),
    p.amplification == null ? DASH : `${formatCount(p.amplification)}${p.amplificationRamp ? ` (→ ${formatCount(p.amplificationRamp.final)} by ${formatCount(p.amplificationRamp.finalBlock)})` : ''}`,
    p.feePermill == null ? DASH : `${(p.feePermill / 10_000).toFixed(3)}%`,
  ]
}

export function renderSnapshots(s: PoolSnapshots, ctx: ToolContext, rows: number): string {
  const base = ctx.explorerBaseUrl
  const shown = s.points.slice(0, rows)
  const pegCols = driftingPegColumns(s)
  const first = shown[0]
  const last = shown[shown.length - 1]
  const head = kv([
    ['Pool', `${explorerLink(`${s.name} (pool ${s.poolId})`, poolUrl(base, s.poolId))} · ${s.kind === 'stableswap' ? 'Stableswap' : 'XYK'}`],
    ['Assets', s.assets.map(a => `${explorerLink(assetLabelWithId(a), assetUrl(base, a.assetId))} (${a.decimals} decimals)`).join(' · ')],
    ['Window', `block ${formatCount(s.window.fromBlock)} → ${formatCount(s.window.toBlock)}${first ? ` · ${formatTime(first.time)} → ${formatTime(last.time)}` : ''}`],
    ['Resolution', describeResolution(s)],
    ['Coverage', coverageLine(s.coverage)],
    ['Sampled life', s.coverage.firstObservedBlock == null ? 'never sampled on the grid' : `blocks ${formatCount(s.coverage.firstObservedBlock)} → ${formatCount(s.coverage.lastObservedBlock)}`],
  ])
  const headers = [
    s.resolution.kind === 'hour' || s.resolution.kind === 'day' ? 'Bucket' : 'Time',
    'Block',
    ...s.assets.map(a => assetLabel(a)),
    ...pegCols.map(i => `Peg ${assetLabel(s.assets[i])}`),
    `Issuance (${assetLabel(s.shareToken)})`,
    'A',
    'Fee',
  ]
  const cut = s.points.length - shown.length
  return joinBlocks(
    h2(`${s.name} — state snapshots`),
    head,
    h3(`Points (${formatCount(shown.length)}${cut > 0 ? ` of ${formatCount(s.points.length)} fetched` : ''}, oldest first)`),
    table(headers, shown.map(p => pointRow(p, s, pegCols, base)), 'no observation of this pool in the window'),
    cut > 0 ? note(`${formatCount(cut)} fetched point${cut === 1 ? '' : 's'} after block ${formatCount(last.block)} were not rendered: the text budget holds ${formatCount(rows)} rows for this pool. Continue with fromBlock ${formatCount(shown.length < s.points.length ? s.points[shown.length].block : s.coverage.nextFromBlock ?? last.block)}, or narrow the window.`) : null,
    s.coverage.missingCount > 0
      ? note(`Missing (${formatCount(s.coverage.missingCount)}${s.coverage.missing.length < s.coverage.missingCount ? `, first ${formatCount(s.coverage.missing.length)} named` : ''}): ${s.coverage.missing.map(String).join(', ')} — no observation of this pool at those slots. They are absent above, not zero.`)
      : null,
    pegCols.length < s.assets.length && s.points.some(p => p.pegs != null)
      ? note(`Peg columns (four decimals) are shown only for assets whose peg moved off 1/1 in this window; the others sit at 1/1 throughout. The exact peg rationals (num/den) are in \`format: "json"\`.`)
      : null,
    bullets([
      s.semantics.points,
      s.semantics.reserves,
      s.semantics.missing,
      s.semantics.issuance,
      s.semantics.fee,
      'Amounts above are scaled by each asset\'s decimals on the rough display scale; the raw integers, the block hash and specVersion of every point are in `format: "json"`.',
    ]),
  )
}

/* ============ handler ============ */

async function handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(INPUT_SHAPE, input)
  if (!parsed.ok) return failure(parsed.error)
  const args = parsed.value
  const target = args.pool.trim()
  if (target.toLowerCase() === 'omnipool') {
    return failure(invalidArgument('The Omnipool is not served by get_pool_history: its liquidity is held per LISTED ASSET rather than as one pool with a share token, and its per-asset reserves are on get_pools with pool "omnipool" (current state) — no bounded snapshot series is exposed for it yet.'))
  }
  if (V3_ADDRESS.test(target)) {
    return failure(invalidArgument('A Uniswap v3 pool is not served by get_pool_history: its state is a tick range rather than per-asset reserves. Call get_pools with the 0x address and include "history" for its bucketed price/TVL series, or "liquidity" for the tick table.'))
  }
  if (!/^\d+$/.test(target)) {
    return failure(invalidArgument(`"${target}" is not a pool identifier. Pass a stableswap or XYK pool's numeric share-token id (for example "143"). Use search to turn a pool NAME into an id.`))
  }
  const poolId = Number(target)
  const limit = Math.min(args.limit ?? DEFAULT_POINTS, MAX_POINTS)
  const wantsJson = args.format === 'json'

  let snapshots: PoolSnapshots
  try {
    snapshots = await ctx.upstream.get<PoolSnapshots>(`/explorer/pool/${poolId}/snapshots`, {
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      fromTs: args.fromTs,
      toTs: args.toTs,
      resolution: args.resolution,
      stepBlocks: args.stepBlocks,
      limit,
    }, { ttlMs: 30_000, timeoutMs: 60_000 })
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) {
      return failure(invalidArgument(`No stableswap or XYK pool carries share-token id ${poolId}. Call get_pools with no arguments for the pools that exist, or search for the pool's name; an Omnipool-listed asset is not a pool here.`))
    }
    return failure(toolErrorFromUpstream(err, `Pool ${poolId}'s state history`))
  }

  // Trimming happens before rendering, by the shape of THIS pool's rows: a
  // three-asset pool prints wider than a two-asset one, and a table cut by the
  // transport loses its newest rows in silence.
  const rowChars = ROW_BASE_CHARS + ROW_CHARS_PER_ASSET * Math.max(1, snapshots.assets.length)
  const rows = Math.max(1, Math.min(limit, Math.floor((ctx.maxTextChars * 0.8) / rowChars)))
  const record = wantsJson ? trimToBudget(snapshots, ctx.maxTextChars - JSON_BUDGET_MARGIN) : snapshots
  const markdown = renderSnapshots(wantsJson ? record : snapshots, ctx, rows)
  return output(ctx, fit(markdown, ctx, 'Lower `limit` or narrow the window.'), record)
}

const INPUT_SHAPE = {
  pool: z.string().trim().min(1).max(64).describe('The pool\'s SHARE-TOKEN asset id, as a numeric string ("143", "110", "111", "105"). Stableswap and XYK pools only: neither the literal "omnipool" nor a 0x v3 address is served here.'),
  fromBlock: z.coerce.number().int().min(0).max(0xffff_ffff).optional().describe('Start of the window as a BLOCK NUMBER (inclusive). Omit for the pool\'s first observation, or — with toBlock/toTs also omitted — for the newest `limit` points.'),
  toBlock: z.coerce.number().int().min(0).max(0xffff_ffff).optional().describe('End of the window as a BLOCK NUMBER (inclusive). Omit for the newest observation.'),
  fromTs: z.coerce.number().int().min(0).max(0xffff_ffff).optional().describe('Start of the window in unix SECONDS (not a date, not milliseconds); resolves to the first observation at or after it. Not for resolution "block".'),
  toTs: z.coerce.number().int().min(0).max(0xffff_ffff).optional().describe('End of the window in unix SECONDS; resolves to the last observation at or before it. Not for resolution "block".'),
  resolution: z.enum(RESOLUTIONS).optional().describe("Sampling: 'grid' (default; the 600-block grid, thinned to fit `limit`), 'hour' or 'day' (the last grid observation of each calendar bucket), 'block' (every block, exact; at most 200 per call, windowed by height)."),
  stepBlocks: z.coerce.number().int().min(1).max(100_000_000).optional().describe("Resolution 'grid' only: fix the stride in blocks (rounded up to a multiple of 600) instead of letting the window thin itself to `limit`; the window is then paged with coverage.nextFromBlock."),
  limit: z.coerce.number().int().min(1).max(MAX_POINTS).optional().describe(`Points per call (default ${DEFAULT_POINTS}, max ${MAX_POINTS}). The json form fits fewer and says so in coverage.`),
  format: formatParam,
}

export const poolHistoryTools: ToolDefinition[] = [{
  name: 'get_pool_history',
  title: 'Pool state snapshots',
  description: DESCRIPTION,
  inputSchema: INPUT_SHAPE,
  handler,
}]
