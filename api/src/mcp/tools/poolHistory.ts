import { z } from 'zod'
import { formatParam, type ToolContext, type ToolDefinition, type ToolOutput } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import { UpstreamError } from '../upstream.ts'
import type { OmnipoolSnapshotPoint, OmnipoolSnapshots, PoolSnapshotPoint, PoolSnapshots, PoolSnapshotResolution } from '../types.ts'
import { DASH, formatAmount, formatCount, formatNumber, formatPercent, scaleAmount } from '../format/units.ts'
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

'pool' is a stableswap or XYK pool's SHARE-TOKEN id (143, 110, 111, 105...), or the literal 'omnipool' with 'asset' naming one or more listed assets by id ("222", "0,222,1001"): per asset its reserve, hub reserve (H2O), LP shares, protocol shares, weight cap, tradability and the asset fee its last sale out of the pool paid, beside the pool-wide H2O total every price and weight is read against. A DELISTED Omnipool asset ends at its removal block (the reply's listings name it); its last state is never repeated. Uniswap v3 pools are not served here.

Every point is chain storage read at exactly the block it names — never interpolated, never carried forward — so the value between two points is unknown, not constant. 'resolution' chooses the sampling:
- 'grid' (default): the indexer's 600-block grid (height divisible by 600, about every 22 minutes), thinned to every Nth grid block so the window fits 'limit' points; 'stepBlocks' fixes the stride instead (rounded up to a multiple of 600) and the window is then paged.
- 'hour' / 'day': one point per calendar bucket — the LAST grid observation at or before the bucket's end, standing for the bucket and stamped with its own block. 'day' points are the observations behind the explorer pool page's daily chart.
- 'block': every block, exact — the replay mode, at most 200 blocks per call; window it with fromBlock/toBlock only.

Window with fromBlock/toBlock (heights) or fromTs/toTs (unix SECONDS, not dates); with neither, the newest 'limit' points. 'limit' is points per call (default 48, max 100); a reply that stops short says so under coverage.truncated, counts the unexamined rest in coverage.remaining and names coverage.nextFromBlock to continue from. coverage.missing lists the slots inside the returned span with no observation — a gap is a gap, never zero inventory.

The markdown table scales amounts by each asset's decimals; format 'json' carries the raw integers (reserves, peg num/den, issuance as strings), the block hash and specVersion per point, and fits fewer points per call than markdown. feePermill is Substrate's Permill: parts per MILLION (400 = 0.04%). One reading to know: a money-market aToken leg (aUSDC in pool 110, aUSDT in 111, aDOT in the Omnipool) is the balance as last read, so interest accrued since the pool last moved that aToken is not in the figure — the reply's semantics.reserves names such legs. Omnipool fees are event-derived (the rate last charged, not a quote) and the protocol fee is not served; semantics.fees says why.`

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
type Paged = Pick<PoolSnapshots, 'window' | 'resolution' | 'coverage'> & { points: { block: number; bucket?: string }[] }

export function trimToBudget<S extends Paged>(snapshots: S, budgetChars: number): S {
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

function describeResolution(s: Pick<PoolSnapshots, 'resolution'>): string {
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

/* ============ omnipool ============ */

const HUB_DECIMALS = 12
/** A rendered Omnipool row: time, block, reserve, hub, price, weight, fee, tradability. */
const OMNI_ROW_CHARS = 150

/** Hub reserve over reserve, each scaled: the asset's spot price in H2O. Display only. */
function priceInHub(a: NonNullable<OmnipoolSnapshotPoint['assets'][number]>, decimals: number): number | null {
  const reserve = scaleAmount(a.reserve, decimals)
  const hub = scaleAmount(a.hubReserve, HUB_DECIMALS)
  return reserve != null && hub != null && reserve > 0 ? hub / reserve : null
}

/** hubReserve / reserveTotal in percent, in integers down to 1e-4 %. */
function weightPct(hubReserve: string, total: string): number | null {
  const t = BigInt(total)
  return t > 0n ? Number((BigInt(hubReserve) * 1_000_000n) / t) / 10_000 : null
}

const tradableCell = (a: NonNullable<OmnipoolSnapshotPoint['assets'][number]>): string =>
  a.tradable === 15 ? 'all' : a.tradableFlags.join(', ')

function listingLine(s: OmnipoolSnapshots, i: number): string {
  const a = s.assets[i]
  const l = s.listings[i]
  const spans = (l?.intervals ?? []).map(iv => (iv.removedAt == null
    ? `listed since block ${iv.listedAt == null ? '?' : formatCount(iv.listedAt)}`
    : `listed ${iv.listedAt == null ? '?' : formatCount(iv.listedAt)} → removed at block ${formatCount(iv.removedAt)}`))
  return `${assetLabelWithId(a)}: ${l?.status === 'delisted' ? 'DELISTED — ' : ''}${spans.join('; ') || 'no listing events indexed'}`
}

export function renderOmnipoolSnapshots(s: OmnipoolSnapshots, ctx: ToolContext, rowsPerAsset: number): string {
  const base = ctx.explorerBaseUrl
  const shown = s.points.slice(0, rowsPerAsset)
  const first = shown[0]
  const last = shown[shown.length - 1]
  const bucketed = s.resolution.kind === 'hour' || s.resolution.kind === 'day'
  const gaps = s.coverage.assetGaps.filter(g => g.count > 0)
  const head = kv([
    ['Pool', `${explorerLink('Omnipool', `${base.replace(/\/+$/, '')}/omnipool`)} · hub asset ${assetLabel(s.hubAsset)}`],
    ['Window', `block ${formatCount(s.window.fromBlock)} → ${formatCount(s.window.toBlock)}${first ? ` · ${formatTime(first.time)} → ${formatTime(last.time)}` : ''}`],
    ['Resolution', describeResolution(s)],
    ['Coverage', coverageLine(s.coverage)],
    ['Sampled life', s.coverage.firstObservedBlock == null ? 'never sampled on the grid' : `blocks ${formatCount(s.coverage.firstObservedBlock)} → ${formatCount(s.coverage.lastObservedBlock)}`],
  ])
  const hubRows = shown.map(p => [
    p.bucket ?? formatTime(p.time),
    explorerLink(formatCount(p.block), blockUrl(base, p.block)),
    formatAmount(p.hub.reserveTotal, HUB_DECIMALS),
    formatCount(p.hub.assetCount),
  ])
  const perAsset = s.assets.map((a, i) => joinBlocks(
    h3(`${explorerLink(assetLabelWithId(a), assetUrl(base, a.assetId))} (${a.decimals} decimals)`),
    table(
      [bucketed ? 'Bucket' : 'Time', 'Block', `Reserve (${assetLabel(a)})`, `Hub (${assetLabel(s.hubAsset)})`, `Price (${assetLabel(s.hubAsset)})`, 'Weight', 'Asset fee', 'Tradable'],
      shown.map(p => {
        const c = p.assets[i]
        const when = p.bucket ?? formatTime(p.time)
        const blk = explorerLink(formatCount(p.block), blockUrl(base, p.block))
        if (!c) return [when, blk, 'not in the pool', DASH, DASH, DASH, DASH, DASH]
        const w = weightPct(c.hubReserve, p.hub.reserveTotal)
        return [
          when, blk,
          formatAmount(c.reserve, a.decimals),
          formatAmount(c.hubReserve, HUB_DECIMALS),
          formatNumber(priceInHub(c, a.decimals)),
          w == null ? DASH : formatPercent(w, 2),
          c.assetFee == null ? DASH : `${(c.assetFee.permill / 10_000).toFixed(2)}%`,
          tradableCell(c),
        ]
      }),
      'no observation in the window',
    ),
  ))
  const cut = s.points.length - shown.length
  return joinBlocks(
    h2(`Omnipool — state snapshots of ${s.assets.map(assetLabel).join(', ')}`),
    head,
    h3('Listing'),
    bullets(s.assets.map((_, i) => listingLine(s, i))),
    h3(`H2O side (${formatCount(shown.length)}${cut > 0 ? ` of ${formatCount(s.points.length)} fetched` : ''} points, oldest first)`),
    table([bucketed ? 'Bucket' : 'Time', 'Block', `Hub reserve total (${assetLabel(s.hubAsset)})`, 'Assets listed'], hubRows, 'no observation in the window'),
    ...perAsset,
    cut > 0 ? note(`${formatCount(cut)} fetched point${cut === 1 ? '' : 's'} after block ${formatCount(last.block)} were not rendered: the text budget holds ${formatCount(rowsPerAsset)} rows per asset. Continue with fromBlock ${formatCount(s.points[shown.length].block)}, ask for fewer assets, or narrow the window.`) : null,
    s.coverage.missingCount > 0
      ? note(`Missing (${formatCount(s.coverage.missingCount)}${s.coverage.missing.length < s.coverage.missingCount ? `, first ${formatCount(s.coverage.missing.length)} named` : ''}): ${s.coverage.missing.map(String).join(', ')} — no observation at those slots. They are absent above, not zero.`)
      : null,
    gaps.length ? note(`Index gaps: ${gaps.map(g => `${assetLabelWithId(s.assets.find(a => a.assetId === g.assetId))} at ${formatCount(g.count)} point${g.count === 1 ? '' : 's'}`).join('; ')} — listed at the time but absent from the snapshot; shown as "not in the pool", not zero.`) : null,
    bullets([
      s.semantics.points,
      s.semantics.reserves,
      s.semantics.hub,
      s.semantics.fees,
      s.semantics.listing,
      s.semantics.missing,
      'Price is hub reserve / reserve (scaled) and weight hub reserve / hub reserve total, computed here for reading; amounts are on the rough display scale. The raw integers, cap, protocol shares, the fee\'s source sale, the block hash and specVersion of every point are in `format: "json"`.',
    ]),
  )
}

type HistoryArgs = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

async function omnipoolHandler(args: HistoryArgs, ctx: ToolContext): Promise<ToolOutput> {
  const assetArg = (args.asset ?? '').trim()
  if (!assetArg) {
    return failure(invalidArgument('pool "omnipool" needs \'asset\': one or more Omnipool asset ids, comma-separated ("222" for HOLLAR, "0,222,1001"). get_pools with pool "omnipool" lists the listed assets; search turns a symbol into an id.'))
  }
  if (!/^\s*\d+(\s*,\s*\d+)*\s*$/.test(assetArg)) {
    return failure(invalidArgument(`"${assetArg}" is not a list of asset ids. Pass numeric ids, comma-separated ("0,222"); search turns a symbol into an id.`))
  }
  const limit = Math.min(args.limit ?? DEFAULT_POINTS, MAX_POINTS)
  const wantsJson = args.format === 'json'
  let snapshots: OmnipoolSnapshots
  try {
    snapshots = await ctx.upstream.get<OmnipoolSnapshots>('/explorer/omnipool/snapshots', {
      asset: assetArg.replace(/\s+/g, ''),
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
      return failure(invalidArgument(`${String((err.body as { error?: string } | null)?.error ?? err.message)}. get_pools with pool "omnipool" lists the assets it holds now.`))
    }
    return failure(toolErrorFromUpstream(err, 'The Omnipool\'s state history'))
  }
  // Every requested asset prints the same rows, so the text budget is shared out
  // per asset before rendering rather than cut by the transport.
  const tables = Math.max(1, snapshots.assets.length) + 1
  const rowsPerAsset = Math.max(1, Math.min(limit, Math.floor((ctx.maxTextChars * 0.7) / (OMNI_ROW_CHARS * tables))))
  const record = wantsJson ? trimToBudget(snapshots, ctx.maxTextChars - JSON_BUDGET_MARGIN) : snapshots
  const markdown = renderOmnipoolSnapshots(record, ctx, rowsPerAsset)
  return output(ctx, fit(markdown, ctx, 'Lower `limit`, ask for fewer assets or narrow the window.'), record)
}

/* ============ handler ============ */

async function handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(INPUT_SHAPE, input)
  if (!parsed.ok) return failure(parsed.error)
  const args = parsed.value
  const target = args.pool.trim()
  if (target.toLowerCase() === 'omnipool') return omnipoolHandler(args, ctx)
  if (args.asset != null) {
    return failure(invalidArgument('\'asset\' applies to pool "omnipool" only: a stableswap or XYK pool is addressed by its share-token id alone.'))
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
  pool: z.string().trim().min(1).max(64).describe('A stableswap or XYK pool\'s SHARE-TOKEN asset id, as a numeric string ("143", "110", "111", "105"), or the literal "omnipool" together with `asset`. A 0x v3 address is not served here.'),
  asset: z.string().trim().max(120).optional().describe('pool "omnipool" only: the listed asset(s) to follow, as registry ids, comma-separated ("222" for HOLLAR, "0,222,1001"; at most 8). Each becomes one table.'),
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
