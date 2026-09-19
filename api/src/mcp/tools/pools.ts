import { z } from 'zod'
import { formatParam, type ToolContext, type ToolDefinition, type ToolError, type ToolOutput } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import { UpstreamError } from '../upstream.ts'
import type {
  AccountRef, ActivityRow, AssetRef, PoolCompositionEntry, PoolDetail, PoolListEntry, PoolsIndex,
} from '../types.ts'
import { DASH, formatAmount, formatCount, formatNumber, formatPercent, formatUsd, scaleAmount } from '../format/units.ts'
import { formatTime, relativeAge } from '../format/time.ts'
import { accountLabel, accountUrl, assetLabel, assetLabelWithId, assetUrl, contractUrl, explorerLink, poolUrl, shortHash, v3PoolUrl } from '../format/refs.ts'
import { activityLine } from '../format/activity.ts'
import { bullets, h2, h3, joinBlocks, kv, note, table } from '../format/md.ts'
import { HUB_DECIMALS, HUB_SYMBOL, failure, fit, output, parseInput } from './shared.ts'

/* ============ the shapes types.ts does not mirror ============ */

/** `/explorer/omnipool` minus its history series, which this tool never prints raw. */
interface OmnipoolAsset {
  asset: AssetRef
  reserve: string
  reserveUsd: number | null
  hubReserve: string
  weightPct: number | null
  capPct: number | null
  tradable: string[]
}
interface OmnipoolResponse {
  account: AccountRef
  tvlUsd: number | null
  assetCount: number
  hubReserveTotal: string
  /** The hub asset's USD price. The wire name is the hub's legacy on-chain spelling. */
  lrnaPrice: number | null
  assets: OmnipoolAsset[]
  history?: PoolHistory
}

interface PoolHistory {
  buckets?: string[]
  tvlUsd?: (number | null)[]
  composition?: { asset: AssetRef; amounts?: number[]; usd?: number[] }[]
  issuance?: (number | null)[]
  pegs?: { asset: AssetRef; prices: (number | null)[] }[]
}

interface V3Position {
  manager: string
  tokenId: string
  owner: AccountRef | null
  tickLower: number
  tickUpper: number
  priceLower: number | null
  priceUpper: number | null
  inRange: boolean
  liquidity: string
  amount0: string
  amount1: string
  usd: number | null
  openedAt: string | null
}
interface V3Vault {
  address: string
  account?: AccountRef | null
  shares: string
  depositors: number
  deposits: number
  withdrawals: number
  rebalances: number
  tvlUsd: number | null
  feesUsd: number | null
  feeSharePct: number | null
  lastRebalanceAt: string | null
}
interface UniswapV3PoolDetail {
  kind: 'uniswapv3'
  address: string
  account: AccountRef
  name: string
  factory: string
  fee: number
  feeTier: string
  tickSpacing: number
  createdBlock: number | null
  createdAt: string | null
  token0: AssetRef
  token1: AssetRef
  assets: PoolCompositionEntry[]
  tvlUsd: number | null
  price: { token1PerToken0: number | null; token0PerToken1: number | null; tick: number; sqrtPriceX96: string }
  liquidity: string
  swaps: number
  protocolFee?: { feeProtocol0: number; feeProtocol1: number; sharePct: number | null } | null
  volume?: { allUsd: number | null; dayUsd: number | null; feesAllUsd: number | null; feesDayUsd: number | null } | null
  feesCollected?: { usd: number | null } | null
  firstSwapAt?: string | null
  lastSwapAt?: string | null
  positions?: V3Position[]
  vault?: V3Vault | null
  /** 500 points; never rendered and dropped from the structured record. */
  priceHistory?: unknown
}

interface V3Range {
  owner: string
  tickLower: number
  tickUpper: number
  priceLower: number | null
  priceUpper: number | null
  liquidity: string
  amount0: string
  amount1: string
  positions: number
  inRange: boolean
  ownerKind: 'vault' | 'manager' | 'direct'
}
interface V3LiquidityResponse {
  pool: string
  blockHeight: number
  tick: number
  price: number | null
  liquidity: string
  ticks: { tick: number; price: number | null; liquidityNet: string; liquidityGross: string }[]
  ranges: V3Range[]
  token0: AssetRef
  token1: AssetRef
}

interface V3HistoryPoint {
  bucket: string
  t: number
  close: number | null
  swaps: number
  volumeUsd: number | null
  feesUsd: number | null
  tvlUsd: number | null
}
interface V3HistoryResponse {
  grain: { kind: string; stepSec: number }
  fromSec: number
  toSec: number
  points: V3HistoryPoint[]
  token0: AssetRef
  token1: AssetRef
}

interface PoolLpsResponse {
  poolId: number
  shareToken: AssetRef
  totalShares: string
  tvlUsd: number | null
  total: number
  lps: { rank: number; account: AccountRef | null; shares: string; farmedShares: string | null; sharePct: number | null; valueUsd: number | null }[]
}

interface OmnipoolAssetLpsResponse {
  asset: AssetRef
  totalShares: string
  protocolShares: string
  lpCount: number
  positionCount: number
  total: number
  lps: {
    rank: number; account: AccountRef | null; positions: number; farmedPositions: number
    shares: string; sharePct: number | null; amount: string; hubAmount: string; valueUsd: number | null
  }[]
}

/* ============ constants ============ */

/** `paths.omnipool()` / `paths.liquidity()` in explorer-ui/src/router.tsx. */
const omnipoolPageUrl = (base: string): string => `${base.replace(/\/+$/, '')}/omnipool`
const liquidityPageUrl = (base: string): string => `${base.replace(/\/+$/, '')}/liquidity`

const V3_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const VENUES = ['omnipool', 'stableswap', 'xyk', 'uniswapv3', 'lbp'] as const
const INCLUDES = ['composition', 'lps', 'activity', 'liquidity', 'history'] as const
type Include = typeof INCLUDES[number]

/**
 * A Uniswap v3 `liquidity` value (L). It is not a token amount and has no
 * decimals — it is sqrt-price liquidity, whose only use is comparing depth
 * between ranges — so it is shown on the rough scale rather than as the raw
 * 19-digit integer a reader would mistake for a balance.
 */
/**
 * How many rows each row-bearing section of a single-pool answer may print.
 *
 * `limit` is documented as rows per TABLE, so asking for 100 with both `lps`
 * and `activity` on requests 200 rows and overruns the server's text budget —
 * and the transport then cuts the tail of whichever section renders last,
 * silently. Trimming before rendering is the contract (AGENTS.md § MCP server),
 * so the budget is divided by the number of sections that actually carry rows.
 * ~180 characters a row is the measured width of an LP or activity line with
 * its account pill and explorer link; 80% of the cap leaves room for the
 * heading blocks, the notes and an error section.
 */
const CHARS_PER_ROW = 180
const rowsPerSection = (ctx: ToolContext, limit: number, sections: number): number =>
  Math.max(1, Math.min(limit, Math.floor((ctx.maxTextChars * 0.8) / CHARS_PER_ROW / Math.max(1, sections))))

const liquidityL = (raw: string | null | undefined): string => {
  if (raw == null || raw === '') return DASH
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  if (n === 0) return '0'
  // One notation for the whole column. The rough scale runs out of unit
  // suffixes above 1e18 and falls back to exponential there, so an L table
  // spanning that boundary printed "533Q" beside "2.08e+19" for the same
  // quantity and left a reader to work out which is larger. L is never a token
  // amount, so exponential throughout costs nothing and compares cleanly.
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  return a < 1000 ? `${sign}${formatNumber(a)}` : `${sign}${a.toExponential(2)}`
}

/* ============ description ============ */

const DESCRIPTION = `Where is Hydration's liquidity, and what is inside one pool? Answers both the directory question ("which venues hold the TVL?") and the single-pool question ("what does this pool contain, who provides it, what has it been doing?").

With no 'pool' argument it returns the whole liquidity directory: total TVL, a breakdown by venue (Omnipool, stableswap, XYK, Uniswap v3), and the largest pools with their composition. Filter with 'venue' and 'minTvlUsd', size with 'limit'. Most XYK pools are long-dead with zero TVL, so the answer always states how many of the total it is showing and how many hold no liquidity at all.

With 'pool' set, the identifier decides the route, and the three forms are not interchangeable:
- the literal string 'omnipool' — the Omnipool: TVL, asset count, hub (H2O) reserve, and a per-asset table of reserve, weight and weight CAP. Weight against cap is the number that governs whether more of an asset can be added.
- a numeric id — a stableswap or XYK pool addressed by its SHARE-TOKEN asset id (690, 4200, 110...), not by a position in a list. If no pool carries that share token, the id is retried as an OMNIPOOL-LISTED ASSET and the answer becomes that asset's Omnipool liquidity providers.
- a 0x-prefixed 40-hex address — a Uniswap v3 (concentrated liquidity) pool, addressed by its contract.

'include' adds sections: 'composition' (on by default for one pool), 'lps' (largest liquidity providers; for a v3 pool the open position ranges instead), 'activity' (the pool's recent classified swaps and liquidity events), 'liquidity' (v3 only: the tick table and open ranges by owner), and 'history' (a first/last/min/max summary of the pool's TVL series, never the raw points).

Traps worth knowing. An Omnipool asset that has been DELISTED — DOT, asset id 5, is the standing example — returns "Asset not in the Omnipool" rather than an empty pool; this tool says that in words instead of surfacing an error. Omnipool liquidity is owned per LISTED ASSET, not for the pool as a whole, so 'lps' on pool 'omnipool' has no single answer and the tool names the per-asset call instead. Pool history windows are unix SECONDS (fromTs/toTs upstream), not calendar dates. Every amount is scaled by its own asset's decimals and every row carries its explorer URL.`

/**
 * How an asset's weight stands against its cap. An asset can sit OVER its cap —
 * the cap bounds what may be ADDED, it does not force a reduction — so "over"
 * and "at" are different statements and are said differently.
 */
export function capMarker(weightPct: number | null | undefined, capPct: number | null | undefined): string {
  if (weightPct == null || capPct == null) return ''
  if (weightPct > capPct + 0.01) return ' ⚠ over cap'
  if (weightPct >= capPct - 0.5) return ' ⚠ at cap'
  return ''
}

/* ============ directory ============ */

const VENUE_LABEL: Record<string, string> = {
  omnipool: 'Omnipool', stableswap: 'Stableswap', xyk: 'XYK', uniswapv3: 'Uniswap v3', lbp: 'LBP',
}

function poolEntryUrl(base: string, p: PoolListEntry): string {
  if (p.kind === 'omnipool') return omnipoolPageUrl(base)
  if (p.kind === 'uniswapv3' && p.address) return v3PoolUrl(base, p.address)
  return p.poolId != null ? poolUrl(base, p.poolId) : liquidityPageUrl(base)
}

/** The top few assets by share, as one cell — enough to recognise the pool. */
function compositionCell(composition: PoolCompositionEntry[] | undefined, max = 3): string {
  if (!composition?.length) return DASH
  const shown = composition.slice(0, max).map(c => (
    c.sharePct != null ? `${assetLabel(c.asset)} ${c.sharePct.toFixed(0)}%` : assetLabel(c.asset)
  ))
  if (composition.length > max) shown.push(`+${composition.length - max}`)
  return shown.join(', ')
}

function renderDirectory(
  index: PoolsIndex,
  ctx: ToolContext,
  opts: { venue?: string; minTvlUsd?: number; limit: number },
): { markdown: string; json: unknown } {
  const all = Array.isArray(index.pools) ? index.pools : []
  const byVenue = new Map<string, { count: number; tvl: number }>()
  for (const p of all) {
    const slot = byVenue.get(p.kind) ?? { count: 0, tvl: 0 }
    slot.count += 1
    slot.tvl += p.tvlUsd ?? 0
    byVenue.set(p.kind, slot)
  }
  const empty = all.filter(p => (p.tvlUsd ?? 0) <= 0).length

  let rows = all
  if (opts.venue) rows = rows.filter(p => p.kind === opts.venue)
  if (opts.minTvlUsd != null) rows = rows.filter(p => (p.tvlUsd ?? 0) >= opts.minTvlUsd!)
  const matched = rows.length
  rows = [...rows].sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0)).slice(0, opts.limit)

  const filters = [
    opts.venue ? `venue ${VENUE_LABEL[opts.venue] ?? opts.venue}` : null,
    opts.minTvlUsd != null ? `TVL at least ${formatUsd(opts.minTvlUsd)}` : null,
  ].filter(Boolean).join(', ')

  const markdown = joinBlocks(
    h2('Liquidity'),
    kv([
      ['Total TVL', formatUsd(index.totalTvlUsd)],
      ['Pools', `${formatCount(all.length)} (${formatCount(empty)} hold no liquidity)`],
      ['Directory', explorerLink('explorer', liquidityPageUrl(ctx.explorerBaseUrl))],
    ]),
    table(
      ['Venue', 'Pools', 'TVL'],
      [...byVenue.entries()]
        .sort((a, b) => b[1].tvl - a[1].tvl)
        .map(([kind, v]) => [VENUE_LABEL[kind] ?? kind, formatCount(v.count), formatUsd(v.tvl)]),
    ),
    h2(`Largest pools${filters ? ` (${filters})` : ''}`),
    table(
      ['Pool', 'Venue', 'TVL', 'Share', 'Composition'],
      rows.map(p => [
        explorerLink(p.name, poolEntryUrl(ctx.explorerBaseUrl, p)),
        VENUE_LABEL[p.kind] ?? p.kind,
        formatUsd(p.tvlUsd),
        p.sharePct == null ? DASH : formatPercent(p.sharePct),
        compositionCell(p.composition),
      ]),
      filters ? `no pool matches ${filters}` : 'the directory is empty',
    ),
    note(filters
      ? `Showing ${rows.length} of the ${matched} pool${matched === 1 ? '' : 's'} matching ${filters}, out of ${all.length}. Pass a pool id, the literal "omnipool", or a 0x v3 address to open one.`
      : `Showing the ${rows.length} largest of ${all.length} pools. Pass a pool id, the literal "omnipool", or a 0x v3 address to open one.`),
  )
  return { markdown, json: { totalTvlUsd: index.totalTvlUsd, poolCount: all.length, matched, shown: rows } }
}

/* ============ history, summarised ============ */

/**
 * A bucketed series as five numbers. The raw arrays reach 1,351 points on the
 * Omnipool; printing them would spend the whole budget restating a chart.
 */
function historySummary(history: PoolHistory | undefined, label = 'TVL'): string | null {
  const buckets = history?.buckets
  const series = history?.tvlUsd
  if (!buckets?.length || !series?.length) return null
  const points = buckets
    .map((b, i) => ({ bucket: b, value: series[i] }))
    .filter((p): p is { bucket: string; value: number } => typeof p.value === 'number' && Number.isFinite(p.value))
  if (!points.length) return null
  const first = points[0]
  const last = points[points.length - 1]
  const min = points.reduce((a, b) => (b.value < a.value ? b : a))
  const max = points.reduce((a, b) => (b.value > a.value ? b : a))
  const change = first.value !== 0 ? (last.value - first.value) / first.value : null
  return kv([
    ['Buckets', `${formatCount(points.length)} · ${first.bucket} → ${last.bucket}`],
    [`${label} first`, formatUsd(first.value)],
    [`${label} last`, formatUsd(last.value)],
    [`${label} low`, `${formatUsd(min.value)} (${min.bucket})`],
    [`${label} high`, `${formatUsd(max.value)} (${max.bucket})`],
    ['Change', change == null ? DASH : `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`],
  ])
}

/* ============ one pool ============ */

function renderOmnipool(d: OmnipoolResponse, ctx: ToolContext, includes: Set<Include>): string {
  const hub = scaleAmount(d.hubReserveTotal, HUB_DECIMALS)
  const assets = [...(d.assets ?? [])].sort((a, b) => (b.reserveUsd ?? 0) - (a.reserveUsd ?? 0))
  const head = kv([
    ['Pool', explorerLink('Omnipool', omnipoolPageUrl(ctx.explorerBaseUrl))],
    ['TVL', formatUsd(d.tvlUsd)],
    ['Listed assets', formatCount(d.assetCount)],
    ['Hub reserve', hub == null ? DASH : `${formatNumber(hub)} ${HUB_SYMBOL}${d.lrnaPrice != null ? ` (${formatUsd(hub * d.lrnaPrice)})` : ''}`],
    ['Hub price', d.lrnaPrice == null ? DASH : formatUsd(d.lrnaPrice)],
    ['Pool account', explorerLink(accountLabel(d.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, d.account.address))],
  ])
  const rows = assets.map(a => {
    const cap = capMarker(a.weightPct, a.capPct)
    const restricted = (a.tradable ?? []).length < 4
    return [
      explorerLink(assetLabelWithId(a.asset), assetUrl(ctx.explorerBaseUrl, a.asset.assetId)),
      formatAmount(a.reserve, a.asset.decimals),
      formatUsd(a.reserveUsd),
      formatAmount(a.hubReserve, HUB_DECIMALS),
      a.weightPct == null ? DASH : formatPercent(a.weightPct),
      a.capPct == null ? DASH : `${formatPercent(a.capPct, 0)}${cap}`,
      restricted ? (a.tradable ?? []).join(', ') || 'none' : 'all',
    ]
  })
  return joinBlocks(
    h2('Omnipool'),
    head,
    h3('Assets'),
    table(['Asset', 'Reserve', 'Reserve USD', `Hub (${HUB_SYMBOL})`, 'Weight', 'Cap', 'Tradable'], rows),
    note('Weight is the asset\'s share of the pool\'s hub reserve. An asset at or over its cap takes no further liquidity until governance raises the cap — an asset can sit OVER its cap, because the cap bounds new additions rather than forcing a reduction. "Tradable: all" means sell, buy, add and remove liquidity are all permitted.'),
    includes.has('history') ? joinBlocks(h3('TVL history'), historySummary(d.history) ?? note('no history series in this response')) : null,
    includes.has('lps')
      ? note('Omnipool liquidity is owned per LISTED ASSET rather than for the pool as a whole — each provider holds position NFTs in one asset\'s sub-pool. Call get_pools again with that asset\'s id as `pool` (for example `pool: "1001"`) to see its providers.')
      : null,
    includes.has('activity') || includes.has('liquidity')
      ? note('The Omnipool has no pool-scoped activity or tick route. Use get_activity with `asset` set to a listed asset, or open one stableswap/XYK/v3 pool for its own feed.')
      : null,
  )
}

function renderPoolDetail(d: PoolDetail, ctx: ToolContext, includes: Set<Include>): string {
  const issuance = scaleAmount(d.totalIssuance, d.shareToken?.decimals ?? 18)
  const head = kv([
    ['Pool', `${d.name} · ${d.kind === 'stableswap' ? 'Stableswap' : 'XYK'}`],
    ['Share token', `${assetLabelWithId(d.shareToken)}${issuance == null ? '' : ` · ${formatNumber(issuance)} issued`}`],
    ['TVL', formatUsd(d.tvlUsd)],
    // The wire field is called `feePermill` but its scale is parts per MILLION:
    // 690 is 0.069%, the same division `fmtPermill` does on the explorer's own
    // pool page. Quoting the field name beside the percentage invites a reader
    // to redo the arithmetic per thousand and land on 69%, so the raw value is
    // named for the scale it actually uses.
    ['Swap fee', d.feePermill == null ? DASH : `${(d.feePermill / 10_000).toFixed(3)}% (wire field \`feePermill\` = ${formatCount(d.feePermill)}, whose scale is parts per MILLION despite the name)`],
    ['Amplification', d.amplification ? `${d.amplification.current}${d.amplification.current !== d.amplification.final ? ` → ${d.amplification.final} by block ${formatCount(d.amplification.finalBlock)}` : ''}` : null],
    // perbill: 120 parts per billion per block.
    ['Max peg move', d.maxPegUpdatePerbill == null ? null : `${(d.maxPegUpdatePerbill / 10_000_000).toFixed(6)}% per block`],
    ['Created', d.createdAt ? `${formatTime(d.createdAt)} (block ${formatCount(d.createdBlock)})` : null],
    ['Destroyed', d.destroyed ? 'yes' : null],
    ['Pool account', d.account ? explorerLink(accountLabel(d.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, d.account.address)) : null],
    ['Explorer', explorerLink(`pool ${d.poolId}`, poolUrl(ctx.explorerBaseUrl, d.poolId))],
  ])
  const assetRows = (d.assets ?? []).map(a => [
    explorerLink(assetLabelWithId(a.asset), assetUrl(ctx.explorerBaseUrl, a.asset.assetId)),
    formatAmount(a.amount, a.asset.decimals),
    formatUsd(a.usd),
    a.sharePct == null ? DASH : formatPercent(a.sharePct),
    a.peg ? formatNumber(a.peg.price) : DASH,
    a.pegSource ? (a.pegSource.source ?? a.pegSource.kind) : DASH,
  ])
  const params = (d.paramEvents ?? []).slice(0, 5).map(e => (
    `${formatTime(e.timestamp)} · ${e.kind} · ${e.summary}`
  ))
  return joinBlocks(
    h2(d.name),
    head,
    includes.has('composition') ? joinBlocks(h3('Composition'), table(['Asset', 'Amount', 'USD', 'Share', 'Peg', 'Peg source'], assetRows)) : null,
    params.length ? joinBlocks(h3('Parameter changes'), bullets(params)) : null,
    includes.has('history') ? joinBlocks(h3('TVL history'), historySummary(d.history as PoolHistory | undefined) ?? note('no history series in this response')) : null,
  )
}

function renderV3Detail(d: UniswapV3PoolDetail, ctx: ToolContext, includes: Set<Include>): string {
  const head = kv([
    ['Pool', `${d.name} · Uniswap v3`],
    ['Contract', explorerLink(d.address, v3PoolUrl(ctx.explorerBaseUrl, d.address))],
    ['Fee tier', `${d.feeTier} (tick spacing ${d.tickSpacing})`],
    ['TVL', formatUsd(d.tvlUsd)],
    ['Price', d.price?.token1PerToken0 == null ? DASH : `${formatNumber(d.price.token1PerToken0)} ${assetLabel(d.token1)} per ${assetLabel(d.token0)} (tick ${formatCount(d.price.tick)})`],
    ['Active liquidity', d.liquidity === '0' ? '0 — nothing is in range at the current tick' : `${liquidityL(d.liquidity)} (L, a sqrt-price liquidity unit, not a token amount)`],
    ['Swaps', `${formatCount(d.swaps)}${d.lastSwapAt ? ` · last ${relativeAge(d.lastSwapAt)}` : ''}`],
    ['Volume', d.volume ? `${formatUsd(d.volume.allUsd)} all time · ${formatUsd(d.volume.dayUsd)} in 24 h` : null],
    // `feesAllUsd` is `volume × feeRate × lpShare` (poolService.ts) — the LPs'
    // share AFTER the protocol cut, which is what the explorer's own pool page
    // calls "Fees to LPs". "Swap fees" would read as the gross fee.
    ['Fees to LPs', d.volume ? `${formatUsd(d.volume.feesAllUsd)} all time · ${formatUsd(d.volume.feesDayUsd)} in 24 h (the LPs' share, after the protocol cut below)` : null],
    ['Protocol fee share', d.protocolFee?.sharePct == null ? null : `${formatPercent(d.protocolFee.sharePct, 0)} of the swap fee, accruing inside the pool until governance collects it`],
    ['Created', d.createdAt ? `${formatTime(d.createdAt)} (block ${formatCount(d.createdBlock)})` : null],
    ['Factory', d.factory],
  ])
  const assetRows = (d.assets ?? []).map(a => [
    explorerLink(assetLabelWithId(a.asset), assetUrl(ctx.explorerBaseUrl, a.asset.assetId)),
    formatAmount(a.amount, a.asset.decimals),
    formatUsd(a.usd),
    a.sharePct == null ? DASH : formatPercent(a.sharePct),
  ])
  const vault = d.vault
    ? kv([
      // The vault is a Hypervisor CONTRACT, not a pool: `/pool/<address>` is
      // reserved for the v3 pool itself and answers nothing for this address.
      ['Vault', explorerLink(vaultName(d.vault), contractUrl(ctx.explorerBaseUrl, d.vault.address))],
      ['Vault TVL', formatUsd(d.vault.tvlUsd)],
      ['Depositors', `${formatCount(d.vault.depositors)} · ${formatCount(d.vault.deposits)} deposits, ${formatCount(d.vault.withdrawals)} withdrawals`],
      ['Rebalances', `${formatCount(d.vault.rebalances)}${d.vault.lastRebalanceAt ? ` · last ${relativeAge(d.vault.lastRebalanceAt)}` : ''}`],
      ['Fees earned', formatUsd(d.vault.feesUsd)],
    ])
    : null
  return joinBlocks(
    h2(d.name),
    head,
    includes.has('composition') ? joinBlocks(h3('Composition'), table(['Asset', 'Amount', 'USD', 'Share'], assetRows)) : null,
    vault ? joinBlocks(h3('Managed vault'), vault) : null,
    includes.has('lps')
      ? joinBlocks(
        h3(`Open positions (${formatCount(Math.min((d.positions ?? []).length, V3_POSITION_ROWS))} of ${formatCount((d.positions ?? []).length)}, largest first)`),
        v3PositionsTable(d.positions ?? [], d, ctx),
        d.vault ? note('Positions opened through the NFT manager only. Where a managed vault runs this pool, the vault\'s own ranges hold the liquidity and are listed under "Concentrated liquidity" (include `liquidity`), not here.') : null,
      )
      : null,
  )
}

const vaultName = (v: V3Vault): string => v.account?.contractName ?? v.address

/** Fixed depths for the v3 tables; the counts beside each heading state them. */
const V3_POSITION_ROWS = 15
const V3_RANGE_ROWS = 12
const V3_TICK_ROWS = 12

function v3PositionsTable(positions: V3Position[], d: UniswapV3PoolDetail, ctx: ToolContext): string {
  const rows = [...positions]
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    .slice(0, V3_POSITION_ROWS)
    .map(p => [
      `#${p.tokenId}`,
      p.owner ? explorerLink(accountLabel(p.owner), accountUrl(ctx.explorerBaseUrl, p.owner.address)) : DASH,
      p.priceLower == null || p.priceUpper == null ? `${p.tickLower}…${p.tickUpper}` : `${formatNumber(p.priceLower)}–${formatNumber(p.priceUpper)}`,
      p.inRange ? 'in range' : 'out of range',
      `${formatAmount(p.amount0, d.token0.decimals, assetLabel(d.token0))} + ${formatAmount(p.amount1, d.token1.decimals, assetLabel(d.token1))}`,
      formatUsd(p.usd),
    ])
  return table(['Position', 'Owner', `Range (${assetLabel(d.token1)}/${assetLabel(d.token0)})`, 'State', 'Holdings', 'USD'], rows, 'this pool has no open positions')
}

function renderPoolLps(lps: PoolLpsResponse, ctx: ToolContext): string {
  const rows = (lps.lps ?? []).map(l => [
    formatCount(l.rank),
    l.account ? explorerLink(accountLabel(l.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, l.account.address)) : DASH,
    formatAmount(l.shares, lps.shareToken?.decimals ?? 18),
    l.farmedShares ? formatAmount(l.farmedShares, lps.shareToken?.decimals ?? 18) : DASH,
    l.sharePct == null ? DASH : formatPercent(l.sharePct, 4),
    formatUsd(l.valueUsd),
  ])
  return joinBlocks(
    h3('Liquidity providers'),
    table(['#', 'Account', 'Shares', 'Farmed', 'Share', 'Value'], rows, 'this pool has no share-token holders'),
    note(`${formatCount(lps.total)} holder${lps.total === 1 ? '' : 's'} in total. Shares deposited into a farm are attributed to their economic owner, not to the farm.`),
  )
}

function renderOmnipoolAssetLps(lps: OmnipoolAssetLpsResponse, ctx: ToolContext): string {
  const decimals = lps.asset?.decimals ?? 12
  const protocol = scaleAmount(lps.protocolShares, decimals)
  const rows = (lps.lps ?? []).map(l => [
    formatCount(l.rank),
    l.account ? explorerLink(accountLabel(l.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, l.account.address)) : DASH,
    `${formatCount(l.positions)}${l.farmedPositions ? ` (${formatCount(l.farmedPositions)} farmed)` : ''}`,
    formatAmount(l.amount, decimals, assetLabel(lps.asset)),
    formatAmount(l.hubAmount, HUB_DECIMALS, HUB_SYMBOL),
    l.sharePct == null ? DASH : formatPercent(l.sharePct, 2),
    formatUsd(l.valueUsd),
  ])
  return joinBlocks(
    h2(`${assetLabelWithId(lps.asset)} in the Omnipool`),
    kv([
      ['Asset', explorerLink(assetLabelWithId(lps.asset), assetUrl(ctx.explorerBaseUrl, lps.asset.assetId))],
      ['Providers', `${formatCount(lps.lpCount)} across ${formatCount(lps.positionCount)} position${lps.positionCount === 1 ? '' : 's'}`],
      ['Total shares', formatAmount(lps.totalShares, decimals)],
      ['Protocol-owned shares', protocol == null ? DASH : formatNumber(protocol)],
      ['Pool', explorerLink('Omnipool', omnipoolPageUrl(ctx.explorerBaseUrl))],
    ]),
    table(['#', 'Account', 'Positions', 'Asset side', 'Hub side', 'Share', 'Value'], rows, 'this asset has no attributable position owners'),
    note('The Omnipool holds one sub-pool per listed asset, so liquidity is owned per asset rather than for the pool as a whole. Protocol-owned shares belong to no account.'),
  )
}

function renderV3Liquidity(liq: V3LiquidityResponse, ctx: ToolContext): string {
  const t0 = liq.token0, t1 = liq.token1
  const allRanges = liq.ranges ?? []
  const allTicks = liq.ticks ?? []
  const rangeRows = [...allRanges]
    .sort((a, b) => Number(b.inRange) - Number(a.inRange))
    .slice(0, V3_RANGE_ROWS)
    .map(r => [
      explorerLink(shortHash(r.owner), accountUrl(ctx.explorerBaseUrl, r.owner)),
      r.ownerKind,
      r.priceLower == null || r.priceUpper == null ? `${r.tickLower}…${r.tickUpper}` : `${formatNumber(r.priceLower)}–${formatNumber(r.priceUpper)}`,
      r.inRange ? 'in range' : 'out',
      formatCount(r.positions),
      `${formatAmount(r.amount0, t0.decimals, assetLabel(t0))} + ${formatAmount(r.amount1, t1.decimals, assetLabel(t1))}`,
    ])
  const tickRows = allTicks.slice(0, V3_TICK_ROWS).map(t => [
    formatCount(t.tick),
    t.price == null ? DASH : formatNumber(t.price),
    liquidityL(t.liquidityNet),
    liquidityL(t.liquidityGross),
  ])
  const shown = (n: number, cap: number, what: string): string =>
    n > cap ? `${what} (${formatCount(cap)} of ${formatCount(n)})` : `${what} (${formatCount(n)})`
  return joinBlocks(
    h3('Concentrated liquidity'),
    kv([
      ['At block', formatCount(liq.blockHeight)],
      ['Current tick', `${formatCount(liq.tick)}${liq.price == null ? '' : ` (${formatNumber(liq.price)} ${assetLabel(t1)} per ${assetLabel(t0)})`}`],
      ['Active liquidity', `${liquidityL(liq.liquidity)} (L, a sqrt-price liquidity unit, not a token amount)`],
    ]),
    // The row counts are on the headings because both tables are cut to a fixed
    // depth: a tick table silently showing 12 of 200 rows reads as the whole
    // curve, and a model would then describe liquidity as ending at the last
    // tick printed.
    note(shown(allRanges.length, V3_RANGE_ROWS, 'Open ranges, in-range first')),
    table(['Owner', 'Kind', `Range (${assetLabel(t1)}/${assetLabel(t0)})`, 'State', 'Positions', 'Holdings'], rangeRows, 'no open ranges'),
    note(shown(allTicks.length, V3_TICK_ROWS, 'Initialised ticks, in tick order')),
    table(['Tick', 'Price', 'Liquidity net', 'Liquidity gross'], tickRows, 'no initialised ticks'),
  )
}

function renderV3History(h: V3HistoryResponse): string {
  const pts = (h.points ?? []).filter(p => typeof p.tvlUsd === 'number')
  if (!pts.length) return joinBlocks(h3('History'), note('no history points in this window'))
  const first = pts[0], last = pts[pts.length - 1]
  const maxTvl = pts.reduce((a, b) => ((b.tvlUsd ?? 0) > (a.tvlUsd ?? 0) ? b : a))
  const volume = pts.reduce((sum, p) => sum + (p.volumeUsd ?? 0), 0)
  const fees = pts.reduce((sum, p) => sum + (p.feesUsd ?? 0), 0)
  const swaps = pts.reduce((sum, p) => sum + (p.swaps ?? 0), 0)
  return joinBlocks(
    h3('History'),
    kv([
      ['Window', `${first.bucket} → ${last.bucket} (${formatCount(pts.length)} buckets of ${Math.round((h.grain?.stepSec ?? 0) / 60)}m)`],
      ['TVL first → last', `${formatUsd(first.tvlUsd)} → ${formatUsd(last.tvlUsd)}`],
      ['TVL high', `${formatUsd(maxTvl.tvlUsd)} (${maxTvl.bucket})`],
      ['Price first → last', `${formatNumber(first.close)} → ${formatNumber(last.close)} ${assetLabel(h.token1)} per ${assetLabel(h.token0)}`],
      ['Swaps in window', `${formatCount(swaps)} · ${formatUsd(volume)} volume · ${formatUsd(fees)} fees`],
    ]),
    note('History windows are unix SECONDS upstream (fromTs/toTs), not calendar dates.'),
  )
}

/* ============ handler ============ */

async function handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(INPUT_SHAPE, input)
  if (!parsed.ok) return failure(parsed.error)
  const args = parsed.value
  const limit = args.limit ?? 25
  const errors: ToolError[] = []

  if (!args.pool) {
    try {
      const index = await ctx.upstream.get<PoolsIndex>('/explorer/pools', undefined, { ttlMs: 30_000 })
      const { markdown, json } = renderDirectory(index, ctx, { venue: args.venue, minTvlUsd: args.minTvlUsd, limit })
      return output(ctx, fit(markdown, ctx, 'Lower `limit` or raise `minTvlUsd`.'), json)
    } catch (err) {
      return failure(toolErrorFromUpstream(err, 'The liquidity directory'))
    }
  }

  const includes = new Set<Include>(args.include?.length ? args.include : ['composition'])
  const target = args.pool.trim()

  /* --- the Omnipool --- */
  if (target.toLowerCase() === 'omnipool') {
    try {
      const d = await ctx.upstream.get<OmnipoolResponse>('/explorer/omnipool', undefined, { ttlMs: 30_000 })
      const markdown = renderOmnipool(d, ctx, includes)
      // The history series is deliberately dropped from the structured record
      // too: it is 1,351 points per asset and no answer needs them raw.
      return output(ctx, fit(markdown, ctx), { ...d, history: undefined })
    } catch (err) {
      return failure(toolErrorFromUpstream(err, 'The Omnipool'))
    }
  }

  /* --- a Uniswap v3 pool --- */
  if (V3_ADDRESS.test(target)) {
    const address = target.toLowerCase()
    let detail: UniswapV3PoolDetail
    try {
      detail = await ctx.upstream.get<UniswapV3PoolDetail>(`/explorer/pool/v3/${address}`, undefined, { ttlMs: 30_000 })
    } catch (err) {
      return failure(toolErrorFromUpstream(err, `Uniswap v3 pool ${address}`))
    }
    const [liqRes, actRes, histRes] = await Promise.allSettled([
      includes.has('liquidity') ? ctx.upstream.get<V3LiquidityResponse>(`/explorer/pool/v3/${address}/liquidity`, undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
      // The v3 activity route's `limit` bounds the LOG WINDOW it classifies, not
      // the row count it returns: limit=5 answers `[]` on a pool with a thousand
      // swaps, while limit=100 finds 16. So it is always asked for the widest
      // window and the trimming to `limit` happens here.
      includes.has('activity') ? ctx.upstream.get<ActivityRow[]>(`/explorer/pool/v3/${address}/activity`, { limit: 100 }, { ttlMs: 10_000, timeoutMs: 60_000 }) : Promise.resolve(null),
      includes.has('history') ? ctx.upstream.get<V3HistoryResponse>(`/explorer/pool/v3/${address}/history`, { points: 60 }, { ttlMs: 30_000 }) : Promise.resolve(null),
    ])
    if (liqRes.status === 'rejected') errors.push(toolErrorFromUpstream(liqRes.reason, 'The pool\'s tick liquidity'))
    if (actRes.status === 'rejected') errors.push(toolErrorFromUpstream(actRes.reason, 'The pool\'s activity'))
    if (histRes.status === 'rejected') errors.push(toolErrorFromUpstream(histRes.reason, 'The pool\'s history'))
    const liquidity = liqRes.status === 'fulfilled' ? liqRes.value : null
    const activity = actRes.status === 'fulfilled' ? actRes.value : null
    const history = histRes.status === 'fulfilled' ? histRes.value : null
    // The detail already carries a positions table and the liquidity route a
    // ranges and a ticks table, so the activity list takes a share of the text
    // budget rather than all of it.
    const v3Rows = rowsPerSection(ctx, limit, 1 + (includes.has('lps') ? 1 : 0) + (includes.has('liquidity') ? 2 : 0))

    const markdown = joinBlocks(
      renderV3Detail(detail, ctx, includes),
      liquidity ? renderV3Liquidity(liquidity, ctx) : null,
      history ? renderV3History(history) : null,
      activity
        ? joinBlocks(
          h3(`Recent activity (${formatCount(Math.min(activity.length, v3Rows))} of ${formatCount(activity.length)} resolved rows)`),
          bullets(activity.slice(0, v3Rows).map(r => activityLine(r, ctx.explorerBaseUrl))),
          note('This route classifies a bounded window of the pool\'s logs, so it shows the recent rows it could resolve rather than every swap; the swap COUNT above is the authoritative total.'),
        )
        : null,
    )
    // `priceHistory` is 500 points on the detail and the rendering never uses
    // it; carrying it would blow the text budget for `format: "json"`.
    return output(ctx, fit(markdown, ctx, 'Drop an `include` section or lower `limit`.'), {
      pool: { ...detail, priceHistory: undefined },
      liquidity,
      history: history ? { ...history, points: undefined } : null,
      activity: activity?.slice(0, v3Rows) ?? null,
    }, errors)
  }

  /* --- a share-token pool id, or an Omnipool-listed asset --- */
  if (!/^\d+$/.test(target)) {
    return failure(invalidArgument(`"${target}" is not a pool identifier. Pass a numeric share-token id (for example "690"), the literal "omnipool", or a 0x-prefixed 40-hex Uniswap v3 contract address. Use search to turn a pool NAME into an id.`))
  }
  const poolId = Number(target)

  let detail: PoolDetail | null = null
  let detailError: unknown = null
  try {
    detail = await ctx.upstream.get<PoolDetail>(`/explorer/pool/${poolId}`, undefined, { ttlMs: 30_000 })
  } catch (err) {
    detailError = err
  }

  if (!detail) {
    // No pool carries that share token. The same number is very often an
    // Omnipool-LISTED ASSET instead, whose liquidity is owned per asset, so that
    // is probed before reporting a miss — and the probe's own 404 is the
    // delisting answer ("Asset not in the Omnipool") rather than an error.
    const isMiss = detailError instanceof UpstreamError && detailError.status === 404
    if (!isMiss) {
      return failure(toolErrorFromUpstream(detailError, `Pool ${poolId}`))
    }
    try {
      const lps = await ctx.upstream.get<OmnipoolAssetLpsResponse>(`/explorer/omnipool/${poolId}/lps`, { limit: Math.min(limit, 100) }, { ttlMs: 30_000 })
      return output(ctx, fit(joinBlocks(
        note(`No pool has share-token id ${poolId}; it is an Omnipool-listed asset, so its liquidity is shown per asset below.`),
        renderOmnipoolAssetLps(lps, ctx),
      ), ctx), { omnipoolAssetLps: lps })
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) {
        const delisted = String(err.message).toLowerCase().includes('not in the omnipool')
        const markdown = joinBlocks(
          h2(`No pool for id ${poolId}`),
          bullets([
            `No stableswap or XYK pool carries share-token id ${poolId}.`,
            delisted
              ? `Asset #${poolId} is **not listed in the Omnipool** — the explorer answers "Asset not in the Omnipool". That means it was either DELISTED, its Omnipool position removed so there are no providers left to list (DOT, asset id 5, is the standing case), or never listed at all. Past liquidity is still on the asset page.`
              : `Asset #${poolId} has no Omnipool position either.`,
            `Open ${explorerLink(`asset #${poolId}`, assetUrl(ctx.explorerBaseUrl, poolId))} for the asset itself, or call get_pools with no arguments for the pools that do exist.`,
          ]),
        )
        // No `ToolError` here on purpose. "Asset not in the Omnipool" is the
        // ANSWER — a delisted or never-listed asset has no liquidity providers,
        // which the block above states in words — and attaching a NOT_FOUND
        // would tell a model the lookup failed. It also kept `format: "json"`
        // from parsing: the transport appends the `**Errors**` section to the
        // JSON document as well as to the markdown.
        return output(ctx, fit(markdown, ctx), { poolId, pool: null, omnipoolListed: false, reason: err.message })
      }
      return failure(toolErrorFromUpstream(err, `Omnipool liquidity for asset ${poolId}`))
    }
  }

  const rowSections = (includes.has('lps') ? 1 : 0) + (includes.has('activity') ? 1 : 0)
  const rows = rowsPerSection(ctx, limit, rowSections)
  const [lpsRes, actRes] = await Promise.allSettled([
    includes.has('lps') ? ctx.upstream.get<PoolLpsResponse>(`/explorer/pool/${poolId}/lps`, { limit: rows }, { ttlMs: 30_000 }) : Promise.resolve(null),
    includes.has('activity') ? ctx.upstream.get<ActivityRow[]>(`/explorer/pool/${poolId}/activity`, { limit: rows }, { ttlMs: 10_000, timeoutMs: 60_000 }) : Promise.resolve(null),
  ])
  if (lpsRes.status === 'rejected') errors.push(toolErrorFromUpstream(lpsRes.reason, 'The pool\'s liquidity providers'))
  if (actRes.status === 'rejected') errors.push(toolErrorFromUpstream(actRes.reason, 'The pool\'s activity'))
  const lps = lpsRes.status === 'fulfilled' ? lpsRes.value : null
  const activity = actRes.status === 'fulfilled' ? actRes.value : null

  const markdown = joinBlocks(
    renderPoolDetail(detail, ctx, includes),
    lps ? renderPoolLps(lps, ctx) : null,
    activity ? joinBlocks(h3(`Recent activity (${formatCount(activity.length)} newest rows)`), bullets(activity.map(r => activityLine(r, ctx.explorerBaseUrl)))) : null,
    rows < limit
      ? note(`\`limit\` ${formatCount(limit)} was cut to ${formatCount(rows)} rows per section: the sections requested share one text budget, and the alternative is losing whichever renders last without being told.`)
      : null,
  )
  return output(ctx, fit(markdown, ctx, 'Drop an `include` section or lower `limit`.'),
    { pool: { ...detail, history: undefined }, lps, activity }, errors)
}

const INPUT_SHAPE = {
    pool: z.string().trim().min(1).max(64).optional().describe('One pool. A numeric share-token asset id (690, 4200, 110) for a stableswap or XYK pool; the literal "omnipool" for the Omnipool; a 0x-prefixed 40-hex contract address for a Uniswap v3 pool. A numeric id that matches no pool is retried as an Omnipool-listed asset. Omit for the directory.'),
    venue: z.enum(VENUES).optional().describe('Directory filter: only pools of this venue.'),
    include: z.array(z.enum(INCLUDES)).optional().describe("Extra sections for a single pool: 'composition' (default), 'lps' (largest providers; v3 shows position ranges), 'activity' (recent classified rows), 'liquidity' (v3 tick table and ranges), 'history' (a summary of the TVL series, never the raw points)."),
    minTvlUsd: z.coerce.number().finite().min(0).optional().describe('Directory filter: drop pools below this TVL in USD. Most XYK pools are dead and hold nothing.'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('Rows per table: directory pools, liquidity providers, activity rows. Default 25.'),
    format: formatParam,
}

export const poolTools: ToolDefinition[] = [{
  name: 'get_pools',
  title: 'Liquidity directory and pool detail',
  description: DESCRIPTION,
  inputSchema: INPUT_SHAPE,
  handler,
}]
