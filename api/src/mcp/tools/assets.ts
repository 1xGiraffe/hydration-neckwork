import { z } from 'zod'
import { formatParam, type ToolContext, type ToolDefinition, type ToolError, type ToolOutput } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import type { ActiveDca, AssetDetail, AssetListItem, HoldersPage, OpenLimitOrder } from '../types.ts'
import {
  DASH,
  formatAmount,
  formatCount,
  formatPercent,
  formatPercentChange,
  formatUsd,
  scaleAmount,
} from '../format/units.ts'
import { formatTime } from '../format/time.ts'
import {
  accountLabel,
  accountUrl,
  assetPairLabels,
  assetUrl,
  dcaScheduleUrl,
  explorerLink,
  holdersUrl,
  intentUrl,
  isCrossChainDestination,
  poolUrl,
  v3PoolUrl,
  xcDestinationUrl,
} from '../format/refs.ts'
import { escapeCell, h3, joinBlocks, kv, note, section, table } from '../format/md.ts'
import { compactAsset, failure, fit, output, parseInput, tagIcon } from './shared.ts'

/* ============ shared ============ */

/** The asset directory: one 80 KB read, cached 30 s upstream and here. */
const ASSETS_PATH = '/explorer/assets'
const ASSETS_TTL_MS = 30_000

/**
 * `format: "json"` answers with the INTERPRETED record rather than an echo of
 * the upstream body: amounts scaled out of their raw units, nested asset refs
 * collapsed, accounts named. That is the product (spec § 1), and it is also what
 * keeps a reply inside the text budget.
 */
function compactHolder(h: HoldersPage['holders'][number], decimals: number, symbol: string) {
  return {
    rank: h.rank,
    address: h.account?.address ?? null,
    label: h.account ? accountLabel(h.account) : h.tag ? `${h.tag.name} (${h.tag.memberCount} accounts folded)` : null,
    tagGroup: h.tag ? h.tag.tagId : null,
    balance: scaleAmount(h.balance, decimals),
    symbol,
    valueUsd: h.valueUsd ?? null,
    sharePct: h.share == null ? null : h.share * 100,
  }
}

function compactDca(d: ActiveDca) {
  return {
    id: d.id,
    intentId: d.intentId ?? null,
    owner: d.who?.address ?? null,
    direction: d.direction,
    assetIn: compactAsset(d.assetIn),
    assetOut: compactAsset(d.assetOut),
    amountPerTrade: scaleAmount(d.amountPerTrade, d.assetIn.decimals),
    executionsDone: d.executionsDone,
    valueUsdPerTrade: d.valueUsd,
  }
}

function compactOrder(o: OpenLimitOrder & { price?: number | null; priceUsd?: number | null }) {
  return {
    intentId: o.intentId,
    seq: o.seq,
    owner: o.who?.address ?? null,
    assetIn: compactAsset(o.assetIn),
    assetOut: compactAsset(o.assetOut),
    remainingIn: scaleAmount(o.remainingIn, o.assetIn.decimals),
    remainingOut: scaleAmount(o.remainingOut, o.assetOut.decimals),
    limitPrice: o.limitPrice,
    priceUsd: o.priceUsd ?? null,
    valueUsd: o.valueUsd,
    timestamp: o.timestamp,
  }
}

/**
 * Where a token came from, in one cell — or nothing, where the registry does not
 * say.
 *
 * 40 of the 109 directory rows carry neither `origin` nor `parachainId`, and
 * they are not all Hydration's: DOT, KSM, ETH, ASTR, PHA, MYTH, LAOS and KILT
 * sit in that set beside HOLLAR and GIGAHDX. Naming them "Hydration" would
 * state, with the Explorer's authority, that a relay-chain or Ethereum token
 * originates here — and the Explorer itself draws no origin badge for them.
 * Only a `Native` asset is claimed as Hydration's own; anything the registry
 * does not place is left unstated rather than guessed.
 */
function originLabel(a: { origin?: { ecosystem: string; chainId: string } | null; parachainId?: number | null; type?: string; xcDestination?: { chainName: string } }): string | null {
  if (a.xcDestination) return `${a.xcDestination.chainName} (cross-chain destination)`
  // `ecosystem/chainId` — a bare "polkadot 1000" reads like a figure.
  if (a.origin) return `${a.origin.ecosystem}${a.origin.chainId ? `/${a.origin.chainId}` : ''}`
  if (a.parachainId != null) return `parachain ${a.parachainId}`
  return a.type === 'Native' ? 'Hydration native' : null
}

/**
 * Whether the id is absent from Hydration's asset registry.
 *
 * `assetDescriptor` answers an unknown id with a SYNTHETIC descriptor — symbol
 * `#<id>`, no name, 12 decimals — so every field of such a record is a
 * placeholder rather than a fact about the token. Ids like 1000021 reach this
 * state while genuinely being held on chain (395 holder rows), so the record is
 * not the empty shell `looksUnregistered` rejects; it just must not be read as
 * the token's real symbol, name or decimal precision.
 */
function isSyntheticDescriptor(a: { symbol?: string | null; name?: string | null }, assetId: number): boolean {
  return a.symbol === `#${assetId}` && (a.name == null || a.name === '')
}

/**
 * The asset's own identifier, for a table cell. A cross-chain destination's
 * `assetId` is a negative sentinel that routes nowhere, so it is never printed
 * as an id (AGENTS.md § Explorer semantics, via the shared ref rules).
 */
function assetIdCell(a: AssetListItem): string {
  return isCrossChainDestination(a) ? `xc/${a.xcDestination?.platform ?? '?'}` : String(a.assetId)
}

function assetHref(base: string, a: AssetListItem): string {
  return isCrossChainDestination(a) && a.xcDestination ? xcDestinationUrl(base, a.xcDestination.platform) : assetUrl(base, a.assetId)
}

/* ============ list_assets ============ */

const ASSET_SORTS = ['tvl', 'volume', 'holders', 'symbol'] as const
type AssetSort = typeof ASSET_SORTS[number]

interface MarketStatRow { assetId: number; volumeUsd24h: number | null }

const listAssetsInputShape = {
  query: z.string().min(1).max(64).optional().describe(
    'Case-insensitive filter on symbol, name or exact asset id. "usd" finds every USD token; "22" finds asset 22.',
  ),
  sort: z.enum(ASSET_SORTS).optional().describe(
    "Ordering: 'tvl' (default, total USD held on Hydration), 'volume' (24 h traded USD — costs one extra read of the price surface, which covers only the traded assets), 'holders' (holder count), 'symbol' (alphabetical).",
  ),
  limit: z.coerce.number().int().min(1).max(100).optional().describe('Rows to return (default 25).'),
  format: formatParam,
}

const LIST_ASSETS_DESCRIPTION = `The token registry as Hydration sees it: every asset that trades, is held, or is reachable here, with its id, decimals, price, 24 h move, total value held and holder count.

Answers "what tokens exist on Hydration?", "what is the id and decimal precision of USDC?", "which assets hold the most value?", "what is DOT doing today?". This is the tool to reach for BEFORE any call that takes an asset id, because symbols are NOT unique here — four different assets call themselves USDC, three call themselves USDT, and picking the wrong one silently answers about the wrong token. Use \`get_asset\` for one token in depth (holders, venues, DCA, order book, price window); use \`get_pools\` for where liquidity sits.

\`query\` filters on symbol, name or exact id, case-insensitively. \`sort\` is applied here, over the whole registry, not by the server: 'tvl' (default), 'volume', 'holders', 'symbol'.

Reading the answer:
- Decimals differ per asset and every raw on-chain amount must be scaled by the asset's OWN decimals: HOLLAR 18, USDC 6, DOT 10, HDX 12 all appear in one list. This tool already scales what it prints.
- The 24 h column is a signed price move, not a volume.
- TVL here is the total USD value held on Hydration (\`amountUsd\`), which is not the same as pool liquidity; a token can have holders and no venue.
- 'volume' sorting reads the price surface, which covers only the ~54 traded assets; everything else has no 24 h volume and sorts last. That is missing coverage, not zero volume.
- A row whose id reads \`xc/<platform>\` is a CROSS-CHAIN DESTINATION, not a registry asset: it is a token you can sell into over NEAR Intents, it has no Hydration asset id, and its internal id is a negative sentinel that routes nowhere. Address it by its platform slug.
- The holder column here counts ADDRESSES with a positive balance. \`get_asset\` and the asset page report a different, smaller figure: they fold each system tag into one holder and re-anchor bound EVM addresses onto their substrate owner. Neither is wrong, but they are not the same fact — quote \`get_asset\`'s when asked how many holders an asset has.
- The count of assets shown versus registered is stated; nothing is silently dropped.`

const listAssets: ToolDefinition = {
  name: 'list_assets',
  title: 'Token registry',
  description: LIST_ASSETS_DESCRIPTION,
  inputSchema: listAssetsInputShape,
  async handler(input, ctx) {
    const parsed = parseInput(listAssetsInputShape, input)
    if (!parsed.ok) return failure(parsed.error)
    const sort: AssetSort = parsed.value.sort ?? 'tvl'
    const limit = parsed.value.limit ?? 25
    const query = parsed.value.query?.trim().toLowerCase()
    const base = ctx.explorerBaseUrl

    const [assetsResult, statsResult] = await Promise.allSettled([
      ctx.upstream.get<AssetListItem[]>(ASSETS_PATH, undefined, { ttlMs: ASSETS_TTL_MS }),
      sort === 'volume'
        // The Preis surface is the only place a per-asset 24 h volume lives; it
        // is read only when the caller sorts on it, never on the default path.
        ? ctx.upstream.get<MarketStatRow[]>('/market-stats', undefined, { ttlMs: ASSETS_TTL_MS })
        : Promise.resolve(null),
    ])

    if (assetsResult.status === 'rejected') return failure(toolErrorFromUpstream(assetsResult.reason, 'The asset registry'))
    const all = assetsResult.value ?? []
    const errs: ToolError[] = []
    if (statsResult.status === 'rejected') errs.push(toolErrorFromUpstream(statsResult.reason, 'The 24 h volume figures'))
    const volumeById = new Map<number, number | null>()
    if (statsResult.status === 'fulfilled' && statsResult.value) {
      for (const row of statsResult.value) volumeById.set(row.assetId, row.volumeUsd24h)
    }

    const filtered = query
      ? all.filter(a => (
        a.symbol?.toLowerCase().includes(query)
        || a.name?.toLowerCase().includes(query)
        || String(a.assetId) === query
        || a.xcDestination?.chainName?.toLowerCase().includes(query)
      ))
      : all

    const nullsLast = (v: number | null | undefined): number => (v == null ? Number.NEGATIVE_INFINITY : v)
    const sorted = [...filtered].sort((a, b) => {
      if (sort === 'symbol') return (a.symbol ?? '').localeCompare(b.symbol ?? '')
      if (sort === 'holders') return nullsLast(b.holderCount) - nullsLast(a.holderCount)
      if (sort === 'volume') return nullsLast(volumeById.get(b.assetId)) - nullsLast(volumeById.get(a.assetId))
      return nullsLast(b.amountUsd) - nullsLast(a.amountUsd)
    })
    const shown = sorted.slice(0, limit)

    const headers = ['Id', 'Symbol', 'Name', 'Dec', 'Price', '24 h', 'Value held', ...(sort === 'volume' ? ['Volume 24 h'] : []), 'Holder rows', 'Origin']
    const rows = shown.map(a => [
      assetIdCell(a),
      explorerLink(a.symbol ?? `#${a.assetId}`, assetHref(base, a)),
      a.name ?? DASH,
      String(a.decimals),
      a.price == null ? DASH : formatUsd(a.price),
      formatPercentChange(a.change24h),
      a.amountUsd == null ? DASH : formatUsd(a.amountUsd),
      ...(sort === 'volume' ? [volumeById.get(a.assetId) == null ? DASH : formatUsd(volumeById.get(a.assetId) ?? 0)] : []),
      a.holderCount == null ? DASH : formatCount(a.holderCount),
      originLabel(a) ?? DASH,
    ])

    const markdown = fit(joinBlocks(
      `## Hydration assets — ${sort === 'tvl' ? 'by value held' : sort === 'volume' ? 'by 24 h volume' : sort === 'holders' ? 'by holder count' : 'alphabetical'}`,
      kv([
        ['Showing', `${formatCount(shown.length)} of ${formatCount(filtered.length)} matching, out of ${formatCount(all.length)} registered`],
        ['Filter', query ? `symbol, name or id containing ${JSON.stringify(parsed.value.query)}` : null],
      ]),
      table(headers, rows, query ? `no registered asset matches ${JSON.stringify(parsed.value.query)} — symbols are case-insensitive here, and an id must match exactly` : 'the registry returned nothing'),
      filtered.length > shown.length
        ? note(`${formatCount(filtered.length - shown.length)} further matching asset(s) not shown. Raise \`limit\` (max 100) or narrow \`query\`.`)
        : '',
      sort === 'volume'
        ? note('24 h volume comes from the price surface, which covers only the traded assets; an asset with no figure is not covered there, which is not the same as zero volume.')
        : '',
      shown.some(a => isCrossChainDestination(a))
        ? note('A row with an `xc/…` id is a cross-chain destination reachable by selling into it, not a registry asset — it has no Hydration asset id and its internal id is a negative sentinel that routes nowhere.')
        : '',
      // No worked example here on purpose: both counts move every block, and a
      // pair of figures frozen into this sentence would be quotably wrong within
      // a day of being right.
      note('`Holder rows` counts ADDRESSES holding a positive balance. It is not the holder count the asset page shows: that one folds each system tag into one holder and re-anchors a bound EVM address onto its substrate owner, so it is always the smaller of the two. `get_asset` reports the page figure. Quote that one for "how many holders"; quote this one only as a count of addresses.'),
      shown.some(a => originLabel(a) == null)
        ? note('An empty Origin means the registry records no origin chain for that asset — including for foreign tokens such as DOT, ETH and KSM. It is not a claim that the token is Hydration\'s own; only "Hydration native" is that.')
        : '',
      note('Symbols are NOT unique: several distinct assets share one symbol. Always pass the ID to any tool that takes an asset.'),
    ), ctx, 'Lower `limit` or narrow `query`.')

    const json = {
      sort,
      query: parsed.value.query ?? null,
      registered: all.length,
      matching: filtered.length,
      shown: shown.length,
      assets: shown.map(a => ({
        assetId: isCrossChainDestination(a) ? null : a.assetId,
        crossChainPlatform: a.xcDestination?.platform ?? null,
        symbol: a.symbol,
        name: a.name ?? null,
        decimals: a.decimals,
        type: a.type ?? null,
        priceUsd: a.price,
        change24hFraction: a.change24h,
        valueHeldUsd: a.amountUsd,
        volumeUsd24h: sort === 'volume' ? volumeById.get(a.assetId) ?? null : undefined,
        // Accounts with a positive balance — the same figure `get_asset` and the
        // asset page report (a bound EVM address counts with its substrate
        // owner). The key name predates that alignment and stays for callers.
        holderAddressCount: a.holderCount ?? null,
        origin: originLabel(a),
        url: assetHref(base, a),
      })),
    }

    return output(ctx, markdown, json, errs)
  },
}

/* ============ get_asset ============ */

const ASSET_SECTIONS = ['price', 'holders', 'pools', 'dca', 'orders', 'series'] as const
type AssetSection = typeof ASSET_SECTIONS[number]
const DEFAULT_ASSET_SECTIONS: AssetSection[] = ['price']

const MAX_PRICE_POINTS = 10
const MAX_HOLDER_ROWS = 10
const MAX_POOL_ROWS = 8
const MAX_DCA_ROWS = 5
const MAX_BOOK_ROWS = 5

const getAssetInputShape = {
  asset: z.string().min(1).max(64).describe(
    'The asset id (preferred — "22") or a symbol ("DOT"). Symbols are not unique on Hydration: an ambiguous one is answered with the candidates rather than a guess.',
  ),
  include: z.array(z.enum(ASSET_SECTIONS)).optional().describe(
    "Extra sections, each one upstream read: 'price' (default — the daily price path already in the record, no extra read), 'holders' (top holders), 'pools' (where its liquidity sits, a large read trimmed hard), 'dca' (ongoing DCA schedules buying or selling it), 'orders' (the open limit-order book), 'series' (a finer price window; see seriesFrom/seriesTo).",
  ),
  seriesFrom: z.string().min(4).max(32).optional().describe("Start of the 'series' window: a UNIX timestamp in SECONDS ('1755000000') or a calendar day ('2026-08-01'). Defaults to 30 days before seriesTo."),
  seriesTo: z.string().min(4).max(32).optional().describe("End of the 'series' window: UNIX seconds or a calendar day. Defaults to now."),
  format: formatParam,
}

/**
 * A timestamp the caller may write either way. The upstream price route takes
 * `fromTs`/`toTs` in unix SECONDS (not the `from`/`to` calendar days the rest of
 * the surface uses), and an agent that hands it a date silently gets a window in
 * 1970, so both spellings are accepted here and converted.
 */
function toUnixSeconds(value: string | undefined, fallback: number): number | null {
  if (value == null) return fallback
  const trimmed = value.trim()
  if (/^\d{9,11}$/.test(trimmed)) return Number(trimmed)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const ms = Date.parse(`${trimmed}T00:00:00Z`)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  const ms = Date.parse(trimmed.replace(' ', 'T').endsWith('Z') ? trimmed.replace(' ', 'T') : `${trimmed.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * The single most important check in this file.
 *
 * `/explorer/asset/:id` does NOT 404 on an unknown-but-valid id — it answers a
 * shell of nulls with the id echoed back as a `#<id>` symbol. Rendering that
 * shell would state, with the Explorer's authority, that a token exists with no
 * holders, no price and no liquidity. Several independent fields have to be
 * empty at once before this says "unregistered", so a real asset that merely has
 * no holders yet is never mistaken for one.
 */
function looksUnregistered(detail: AssetDetail | null | undefined, assetId: number): boolean {
  const a = detail?.asset
  if (!detail || !a) return true
  return a.symbol === `#${assetId}`
    && (a.name == null || a.name === '')
    && a.price == null
    && !a.amountUsd
    && !detail.holderCount
    && !detail.totalUsd
    && (detail.priceSeries?.length ?? 0) === 0
    && !detail.dcaCount
    && !detail.limitOrderCount
    && !detail.liquiditySourceCount
}

interface ResolvedAsset { assetId: number; from: 'id' | 'symbol'; candidates?: AssetListItem[] }

async function resolveAsset(input: string, ctx: ToolContext): Promise<{ resolved: ResolvedAsset } | { error: ToolOutput }> {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) {
    const assetId = Number(trimmed)
    if (!Number.isSafeInteger(assetId) || assetId > 0xffff_ffff) {
      return { error: failure(invalidArgument(`${trimmed} is not a valid asset id: ids are unsigned 32-bit integers.`)) }
    }
    return { resolved: { assetId, from: 'id' } }
  }

  let registry: AssetListItem[]
  try {
    registry = await ctx.upstream.get<AssetListItem[]>(ASSETS_PATH, undefined, { ttlMs: ASSETS_TTL_MS })
  } catch (err) {
    return { error: failure(toolErrorFromUpstream(err, `The asset registry, needed to resolve the symbol ${JSON.stringify(trimmed)},`)) }
  }

  const wanted = trimmed.toLowerCase()
  // Most-held first, so an ambiguous symbol's candidate list leads with the one
  // a caller most likely meant instead of whatever order the registry returned.
  const matches = registry
    .filter(a => a.symbol?.toLowerCase() === wanted)
    .sort((a, b) => (b.amountUsd ?? -1) - (a.amountUsd ?? -1))
  if (matches.length === 0) {
    const near = registry.filter(a => a.symbol?.toLowerCase().includes(wanted) || a.name?.toLowerCase().includes(wanted)).slice(0, 8)
    return {
      error: failure({
        code: 'NOT_FOUND',
        message: `No registered asset has the symbol ${JSON.stringify(trimmed)}.${near.length ? ` Closest by symbol or name: ${near.map(a => `${a.symbol} (#${a.assetId})`).join(', ')}.` : ''} Note that pool-share tokens and a few derivatives are registered assets but are not in the asset directory the symbol lookup reads — pass their numeric id directly, or call \`search\`.`,
      }),
    }
  }
  if (matches.length > 1) {
    const base = ctx.explorerBaseUrl
    const rows = matches.map(a => [
      assetIdCell(a),
      a.symbol,
      a.name ?? DASH,
      String(a.decimals),
      a.price == null ? DASH : formatUsd(a.price),
      a.amountUsd == null ? DASH : formatUsd(a.amountUsd),
      a.holderCount == null ? DASH : formatCount(a.holderCount),
      originLabel(a) ?? DASH,
    ])
    return {
      error: {
        markdown: joinBlocks(
          `## ${escapeCell(trimmed)} is ambiguous — ${matches.length} registered assets share that symbol`,
          // `Holder rows`, not `Holders`: this is the directory's count of
          // ADDRESSES, the larger of the two published figures. The asset page's
          // folded count is what `get_asset` answers with, and giving both the
          // same column name would put two numbers on one fact.
          table(['Id', 'Symbol', 'Name', 'Dec', 'Price', 'Value held', 'Holder rows', 'Origin'], rows),
          note('Symbols are not unique on Hydration: a Polkadot-bridged token, a Wormhole-wrapped one and a money-market aToken can all call themselves the same thing, and they are different assets with different decimals and different liquidity. Call `get_asset` again with the numeric id of the one you mean — guessing here would answer about the wrong token.'),
          `Explorer: ${matches.map(a => explorerLink(`#${a.assetId}`, assetHref(base, a))).join(' · ')}`,
        ),
        json: {
          query: trimmed,
          ambiguous: true,
          candidates: matches.map(a => ({ assetId: a.assetId, symbol: a.symbol, name: a.name ?? null, decimals: a.decimals, priceUsd: a.price, valueHeldUsd: a.amountUsd, holderAddressCount: a.holderCount ?? null, origin: originLabel(a) })),
        },
        errors: [invalidArgument(`The symbol ${JSON.stringify(trimmed)} matches ${matches.length} registered assets. Call again with one of these ids: ${matches.map(a => a.assetId).join(', ')}.`)],
      },
    }
  }

  const only = matches[0]
  if (isCrossChainDestination(only)) {
    return {
      error: failure({
        code: 'NOT_FOUND',
        message: `${only.symbol} is a CROSS-CHAIN DESTINATION (platform "${only.xcDestination?.platform ?? '?'}"), not a Hydration registry asset: it is a token you can sell into over NEAR Intents, it has no asset id, and the negative number the API carries for it routes nowhere. Ask \`inspect_entity\` for "${only.xcDestination?.platform ?? only.symbol}" instead.`,
      }),
    }
  }
  return { resolved: { assetId: only.assetId, from: 'symbol' } }
}

function priceBlock(detail: AssetDetail): string {
  const series = detail.priceSeries ?? []
  const dates = detail.priceDates ?? []
  if (!series.length) return note('No price history: this asset has never been priced by the index.')
  let minI = 0
  let maxI = 0
  for (let i = 1; i < series.length; i += 1) {
    if (series[i] < series[minI]) minI = i
    if (series[i] > series[maxI]) maxI = i
  }
  const stride = Math.max(1, Math.ceil(series.length / MAX_PRICE_POINTS))
  const path: string[] = []
  for (let i = 0; i < series.length; i += stride) path.push(`${(dates[i] ?? '').slice(0, 10)} ${formatUsd(series[i])}`)
  const lastIdx = series.length - 1
  if ((lastIdx % stride) !== 0) path.push(`${(dates[lastIdx] ?? '').slice(0, 10)} ${formatUsd(series[lastIdx])}`)
  return joinBlocks(
    kv([
      ['Daily history', `${formatCount(series.length)} days, ${(dates[0] ?? '').slice(0, 10)} → ${(dates[lastIdx] ?? '').slice(0, 10)}`],
      ['Low of the daily series', `${formatUsd(series[minI])} on ${(dates[minI] ?? '').slice(0, 10)}`],
      ['High of the daily series', `${formatUsd(series[maxI])} on ${(dates[maxI] ?? '').slice(0, 10)}`],
      ['Path', `${path.join(' · ')}${stride > 1 ? ` — sampled, every ${stride} day(s)` : ''}`],
    ]),
  )
}

function holdersBlock(page: HoldersPage, base: string): string {
  const holders = page.holders ?? []
  const shown = holders.slice(0, MAX_HOLDER_ROWS)
  const rows = shown.map(h => [
    String(h.rank),
    h.account
      ? explorerLink(accountLabel(h.account, { withAddress: true }), accountUrl(base, h.account.address))
      : h.tag
        ? `${tagIcon(h.tag.icon)}${h.tag.name} — ${h.tag.memberCount} account${h.tag.memberCount === 1 ? '' : 's'} folded`
        : DASH,
    formatAmount(h.balance, page.asset.decimals, page.asset.symbol),
    h.valueUsd == null ? DASH : formatUsd(h.valueUsd),
    h.share == null ? DASH : formatPercent(h.share * 100),
  ])
  return joinBlocks(
    // The headline already carries the holder count and the held value; only the
    // link to the rest of the list is new here.
    `Top ${shown.length} of ${formatCount(page.total)} holders (${formatUsd(page.totalUsd)} held) — full list: ${holdersUrl(base, page.asset.assetId)}`,
    table(['#', 'Holder', 'Balance', 'USD', 'Share'], rows, 'nothing holds this asset'),
    holders.length > shown.length ? note(`${holders.length - shown.length} further holder(s) in this page not shown.`) : '',
    shown.some(h => h.account == null && h.tag != null)
      ? note('A holder row without an address folds a whole system tag\'s members into one line — its balance is the tag total, not one account\'s.')
      : '',
  )
}

interface LiquiditySource {
  kind: string
  poolId: number | null
  name: string
  tvlUsd: number | null
  assetAmount: string
  assetUsd: number | null
  assetSharePct: number | null
  poolAddress?: string
}
interface AssetLiquidity {
  asset: { assetId: number; symbol: string; decimals: number }
  totalAmount: string
  totalUsd: number | null
  sources: LiquiditySource[]
  former?: { kind: string; poolId: number | null; name: string; lastActiveAt: string | null }[]
}

function poolsBlock(liq: AssetLiquidity, base: string): string {
  const live = (liq.sources ?? []).filter(s => (s.assetUsd ?? 0) > 0 || (s.assetAmount ?? '0') !== '0')
  const sorted = [...live].sort((a, b) => (b.assetUsd ?? 0) - (a.assetUsd ?? 0))
  const shown = sorted.slice(0, MAX_POOL_ROWS)
  const decimals = liq.asset?.decimals ?? 0
  const rows = shown.map(s => [
    s.poolId != null
      ? explorerLink(s.name, poolUrl(base, s.poolId))
      : s.poolAddress
        ? explorerLink(s.name, v3PoolUrl(base, s.poolAddress))
        : s.name,
    s.kind,
    formatAmount(s.assetAmount, decimals, liq.asset?.symbol),
    s.assetUsd == null ? DASH : formatUsd(s.assetUsd),
    s.assetSharePct == null ? DASH : formatPercent(s.assetSharePct),
    s.tvlUsd == null ? DASH : formatUsd(s.tvlUsd),
  ])
  const emptyCount = (liq.sources ?? []).length - live.length
  return joinBlocks(
    kv([
      ['In pools', `${formatAmount(liq.totalAmount, decimals, liq.asset?.symbol)}${liq.totalUsd == null ? '' : ` (${formatUsd(liq.totalUsd)})`}`],
      ['Live venues', `${formatCount(live.length)} of ${formatCount((liq.sources ?? []).length)} registered`],
    ]),
    table(['Pool', 'Venue', 'Amount', 'USD', 'Share of pool', 'Pool TVL'], rows, 'this asset sits in no pool'),
    sorted.length > shown.length ? note(`${sorted.length - shown.length} smaller live venue(s) not shown.`) : '',
    emptyCount > 0 ? note(`${emptyCount} registered venue(s) hold none of this asset and are omitted.`) : '',
    liq.former?.length ? note(`${liq.former.length} pool(s) once held it and no longer do (most recently ${formatTime(liq.former[0]?.lastActiveAt)}).`) : '',
  )
}

function dcaRows(list: ActiveDca[], base: string): (string | null)[][] {
  return list.slice(0, MAX_DCA_ROWS).map(d => [
    d.intentId ? explorerLink(`#${d.id}`, intentUrl(base, d.intentId)) : explorerLink(String(d.id), dcaScheduleUrl(base, d.id)),
    d.who ? accountLabel(d.who) : DASH,
    // `USDC → USDC` for two different registry assets reads as a no-op, and on
    // this surface — the asset's own page — the colliding leg is exactly the one
    // the reader is asking about. The pair renderer prints the ids when the
    // symbols collide (four assets call themselves USDC).
    assetPairLabels(d.assetIn, d.assetOut).join(' → '),
    formatAmount(d.amountPerTrade, d.assetIn.decimals, d.assetIn.symbol),
    formatCount(d.executionsDone),
    d.valueUsd == null ? DASH : formatUsd(d.valueUsd),
  ])
}

function bookRows(list: (OpenLimitOrder & { price?: number | null; priceUsd?: number | null; size?: string })[], base: string): (string | null)[][] {
  return list.slice(0, MAX_BOOK_ROWS).map(o => [
    explorerLink(`#${o.seq}`, intentUrl(base, o.intentId)),
    accountLabel(o.who),
    `${formatAmount(o.remainingIn, o.assetIn.decimals, o.assetIn.symbol)} → ${formatAmount(o.remainingOut, o.assetOut.decimals, o.assetOut.symbol)}`,
    o.priceUsd == null ? DASH : formatUsd(o.priceUsd),
    o.valueUsd == null ? DASH : formatUsd(o.valueUsd),
    formatTime(o.timestamp),
  ])
}

const GET_ASSET_DESCRIPTION = `One token in depth: what it is worth, who holds it, where its liquidity sits, and what standing orders point at it.

Answers "what is this token doing?", "who holds most of it?", "which pools hold it?", "is anyone DCAing into it?", "how has its price moved?". Use \`list_assets\` to find an asset or compare many; \`inspect_entity\` gives a shorter reading of the same token; \`get_pools\` describes a pool rather than an asset's place across pools.

\`asset\` takes an id ("22") or a symbol ("DOT"). PREFER THE ID. Symbols are not unique — four assets call themselves USDC — and an ambiguous symbol is answered with the candidate list and no guess. A few registered assets (pool-share tokens such as 2-Pool or 2-Pool-GDOT) are not in the symbol directory at all; their ids still work.

\`include\` adds sections, each one upstream read: 'price' (the daily price path, already in the base record — the default), 'holders', 'pools' (where the liquidity sits), 'dca' (ongoing schedules trading it chain-wide), 'orders' (the open limit-order book), 'series' (a finer price window). \`seriesFrom\`/\`seriesTo\` take either UNIX SECONDS or a calendar day and are converted for you — the underlying route takes seconds only, and a date handed to it silently reads a window in 1970.

The trap this tool exists to close: an unknown-but-valid asset id does NOT produce a 404. The Explorer answers a shell of nulls with the id echoed back as its symbol, which renders as a perfectly plausible token with no holders, no price and no liquidity. This tool detects that shell and says no such asset is registered instead. If you get that answer, the id is wrong — do not report the empty record as a finding. The near neighbour of that case is an id that IS held on chain but has no registry entry (1000021 and its kind): the same synthetic descriptor stands in for its symbol, name and decimals, so this tool answers with the real holder and liquidity figures and marks the descriptor as a placeholder — never quote \`#<id>\` as a ticker or its 12 decimals as a precision.

Other things to carry over correctly: amounts are scaled by this asset's own decimals and named; 'Value held' is total USD held on Hydration, which is larger than the amount sitting in pools; a holder row without an address is a whole system tag folded into one line; a price is the index's USD valuation, not a quote you could trade at.`

const getAsset: ToolDefinition = {
  name: 'get_asset',
  title: 'Token detail',
  description: GET_ASSET_DESCRIPTION,
  inputSchema: getAssetInputShape,
  async handler(input, ctx) {
    const parsed = parseInput(getAssetInputShape, input)
    if (!parsed.ok) return failure(parsed.error)
    const sections = new Set<AssetSection>(parsed.value.include?.length ? parsed.value.include : DEFAULT_ASSET_SECTIONS)
    const base = ctx.explorerBaseUrl

    const resolution = await resolveAsset(parsed.value.asset, ctx)
    if ('error' in resolution) return resolution.error
    const { assetId, from } = resolution.resolved

    const nowSec = Math.floor(Date.now() / 1000)
    const seriesTo = sections.has('series') ? toUnixSeconds(parsed.value.seriesTo, nowSec) : null
    const seriesFrom = sections.has('series') ? toUnixSeconds(parsed.value.seriesFrom, (seriesTo ?? nowSec) - 30 * 86_400) : null
    if (sections.has('series')) {
      if (seriesFrom == null || seriesTo == null) {
        return failure([invalidArgument('seriesFrom/seriesTo must be a UNIX timestamp in seconds ("1755000000") or a calendar day ("2026-08-01").')])
      }
      if (seriesTo <= seriesFrom) {
        return failure([invalidArgument(`The series window is empty: seriesTo (${seriesTo}) must be later than seriesFrom (${seriesFrom}).`)])
      }
    }

    const [detailResult, holdersResult, poolsResult, dcaResult, ordersResult, seriesResult] = await Promise.allSettled([
      ctx.upstream.get<AssetDetail>(`/explorer/asset/${assetId}`, undefined, { ttlMs: 15_000 }),
      sections.has('holders') ? ctx.upstream.get<HoldersPage>(`/explorer/holders/${assetId}`, { limit: MAX_HOLDER_ROWS }, { ttlMs: 15_000 }) : Promise.resolve(null),
      sections.has('pools') ? ctx.upstream.get<AssetLiquidity>(`/explorer/asset/${assetId}/liquidity`, undefined, { ttlMs: 60_000, timeoutMs: 90_000 }) : Promise.resolve(null),
      sections.has('dca') ? ctx.upstream.get<{ buys: ActiveDca[]; sells: ActiveDca[] }>(`/explorer/asset/${assetId}/dcas`, undefined, { ttlMs: 15_000 }) : Promise.resolve(null),
      sections.has('orders') ? ctx.upstream.get<{ bids: OpenLimitOrder[]; asks: OpenLimitOrder[] }>(`/explorer/asset/${assetId}/limit-orders`, undefined, { ttlMs: 15_000 }) : Promise.resolve(null),
      sections.has('series') && seriesFrom != null && seriesTo != null
        ? ctx.upstream.get<{ interval: string; priceSeries: number[]; priceDates: string[] }>(`/explorer/asset/${assetId}/prices`, { fromTs: seriesFrom, toTs: seriesTo, points: 120 }, { ttlMs: 30_000 })
        : Promise.resolve(null),
    ])

    if (detailResult.status === 'rejected') {
      return failure(toolErrorFromUpstream(detailResult.reason, `Asset ${assetId}`))
    }
    const detail = detailResult.value

    if (looksUnregistered(detail, assetId)) {
      return failure({
        code: 'NOT_FOUND',
        message: `No asset with id ${assetId} is registered on Hydration. The Explorer answers an unknown-but-valid asset id with an EMPTY SHELL rather than a 404 — a record carrying the id back as its symbol, a null price, no holders, no price history and no liquidity — so this is a missing asset, not an asset with nothing in it. Call \`list_assets\` to find the id you meant.`,
      }, { assetId, registered: false })
    }

    const errs: ToolError[] = []
    const failedSections: string[] = []
    const named = (label: string) => `The ${label} for asset ${assetId}`
    const record = (result: PromiseSettledResult<unknown>, section: string, label: string) => {
      if (result.status !== 'rejected') return
      errs.push(toolErrorFromUpstream(result.reason, named(label)))
      failedSections.push(section)
    }
    record(holdersResult, 'holders', 'holder list')
    record(poolsResult, 'pools', 'liquidity breakdown')
    record(dcaResult, 'dca', 'DCA schedules')
    record(ordersResult, 'orders', 'limit-order book')
    record(seriesResult, 'series', 'price window')

    const holders = holdersResult.status === 'fulfilled' ? holdersResult.value : null
    const pools = poolsResult.status === 'fulfilled' ? poolsResult.value : null
    const dcas = dcaResult.status === 'fulfilled' ? dcaResult.value : null
    const book = ordersResult.status === 'fulfilled' ? ordersResult.value : null
    const window = seriesResult.status === 'fulfilled' ? seriesResult.value : null

    const a = detail.asset
    // Held on chain, but with no registry entry behind its symbol, name and
    // decimals. The figures that come from the index (holders, value held,
    // liquidity) are real; the descriptor around them is not.
    const synthetic = isSyntheticDescriptor(a, assetId)
    const markdown = fit(joinBlocks(
      synthetic
        ? `## Asset #${assetId} — held on chain, but not in the token registry`
        : `## ${escapeCell(a.symbol)}${a.name ? ` — ${escapeCell(a.name)}` : ''} (asset #${assetId})`,
      kv([
        ['Resolved from', from === 'symbol' ? `the symbol ${JSON.stringify(parsed.value.asset)}` : null],
        ['Price', a.price == null ? 'not priced by the index' : formatUsd(a.price)],
        ['24 h', formatPercentChange(a.change24h)],
        ['7 d', a.change7d == null ? null : formatPercentChange(a.change7d)],
        ['Decimals', synthetic
          ? `unknown — the ${a.decimals} the Explorer reports for this id is its fallback default, not this token's own precision. Do not scale a raw amount of it.`
          : `${a.decimals} — scale every raw amount of this asset by 10^${a.decimals}`],
        ['Type', synthetic ? null : a.type ?? null],
        ['Origin', synthetic ? null : originLabel(a)],
        ['Value held on Hydration', detail.totalUsd == null ? DASH : formatUsd(detail.totalUsd)],
        ['Holders', `${formatCount(detail.holderCount)} accounts with a positive balance — a bound EVM address counts with its substrate owner, and every member of a system tag counts (the holder list folds a tag's members into one row, so it has fewer rows than this)`],
        ['Liquidity venues', detail.liquiditySourceCount == null ? null : formatCount(detail.liquiditySourceCount)],
        ['Active DCA schedules', detail.dcaCount ? formatCount(detail.dcaCount) : null],
        ['Open limit orders', detail.limitOrderCount ? formatCount(detail.limitOrderCount) : null],
        ['Explorer', assetUrl(base, assetId)],
      ]),
      synthetic
        ? note(`Asset ${assetId} is NOT in Hydration's asset registry. The Explorer answers an id it holds no metadata for with a synthetic descriptor — the id echoed back as the symbol, no name, no type, no origin, and a fallback of ${a.decimals} decimals — so this token has no symbol, name, type or origin to report here, and that ${a.decimals} is not its precision. The holder, value and liquidity figures in this answer are different: they come from the index and are real, because the id IS held on chain; it simply has no registry entry. Do not quote "#${assetId}" as a ticker and do not scale a raw amount by 10^${a.decimals} on this authority.`)
        : '',
      sections.has('price') ? section('Price history', priceBlock(detail)) : '',
      window
        ? section(`Price window (${window.interval} candles${seriesFrom != null ? `, ${new Date(seriesFrom * 1000).toISOString().slice(0, 10)} → ${new Date((seriesTo ?? nowSec) * 1000).toISOString().slice(0, 10)}` : ''})`, (() => {
          const s = window.priceSeries ?? []
          if (!s.length) return note('No candle covers that window.')
          const stride = Math.max(1, Math.ceil(s.length / MAX_PRICE_POINTS))
          const path: string[] = []
          for (let i = 0; i < s.length; i += stride) path.push(`${(window.priceDates?.[i] ?? '').slice(0, 10)} ${formatUsd(s[i])}`)
          const change = s[0] !== 0 ? (s[s.length - 1] - s[0]) / Math.abs(s[0]) : null
          return kv([
            ['Points', `${formatCount(s.length)} ${window.interval} candles`],
            ['Open → close', `${formatUsd(s[0])} → ${formatUsd(s[s.length - 1])}${change == null ? '' : ` (${formatPercentChange(change)})`}`],
            ['Low / high', `${formatUsd(Math.min(...s))} / ${formatUsd(Math.max(...s))}`],
            ['Path', `${path.join(' · ')}${stride > 1 ? ` — sampled, every ${stride} candle(s)` : ''}`],
          ])
        })())
        : '',
      holders ? section('Top holders', holdersBlock(holders, base)) : '',
      pools ? section('Where the liquidity sits', poolsBlock(pools, base)) : '',
      dcas
        ? section('Ongoing DCA', joinBlocks(
          h3(`Buying ${a.symbol} (${dcas.buys?.length ?? 0})`),
          table(['Schedule', 'Owner', 'Trade', 'Per trade', 'Fills', 'USD/trade'], dcaRows(dcas.buys ?? [], base), `no schedule is buying ${a.symbol}`),
          h3(`Selling ${a.symbol} (${dcas.sells?.length ?? 0})`),
          table(['Schedule', 'Owner', 'Trade', 'Per trade', 'Fills', 'USD/trade'], dcaRows(dcas.sells ?? [], base), `no schedule is selling ${a.symbol}`),
          note('Chain-wide, not per account, and it covers both pallet DCA schedules and DCA intents.'),
        ))
        : '',
      book
        ? section('Open limit orders', joinBlocks(
          h3(`Bids — buying ${a.symbol} (${book.bids?.length ?? 0})`),
          table(['Order', 'Owner', 'Remaining', 'Price', 'USD', 'Placed'], bookRows(book.bids ?? [], base), `nobody has a standing bid for ${a.symbol}`),
          h3(`Asks — selling ${a.symbol} (${book.asks?.length ?? 0})`),
          table(['Order', 'Owner', 'Remaining', 'Price', 'USD', 'Placed'], bookRows(book.asks ?? [], base), `nobody has a standing ask for ${a.symbol}`),
        ))
        : '',
      // A section that failed is simply missing from the answer, which an agent
      // could read as "there is none". Name it instead.
      failedSections.length
        ? note(`These requested sections are MISSING because their read failed, not because there is nothing there: ${failedSections.join(', ')} (see Errors below). Retrying is reasonable.`)
        : '',
      sections.size === 1 && sections.has('price')
        ? note('Ask for `include: ["holders","pools","dca","orders","series"]` — any subset — to add the holder list, the venues, the standing orders, or a finer price window.')
        : '',
    ), ctx, 'Ask for fewer `include` sections.')

    return output(ctx, markdown, {
        assetId,
        registered: true,
        // `registered` says the id is a real asset rather than the null shell.
        // This says something narrower and is present only when it applies: the
        // id is held on chain but carries no registry entry, so the Explorer's
        // symbol/name/type/origin/decimals for it are synthetic placeholders.
        descriptorIsPlaceholder: synthetic ? true : undefined,
        resolvedFrom: from,
        symbol: synthetic ? null : a.symbol,
        name: a.name ?? null,
        decimals: synthetic ? null : a.decimals,
        decimalsFallback: synthetic ? a.decimals : undefined,
        type: synthetic ? null : a.type ?? null,
        origin: synthetic ? null : originLabel(a),
        priceUsd: a.price,
        change24hFraction: a.change24h,
        change7dFraction: a.change7d ?? null,
        valueHeldUsd: detail.totalUsd,
        // The asset page's folded count, not list_assets' raw address count.
        holderCount: detail.holderCount,
        liquiditySourceCount: detail.liquiditySourceCount ?? null,
        dcaCount: detail.dcaCount,
        limitOrderCount: detail.limitOrderCount ?? null,
        url: assetUrl(base, assetId),
        priceHistory: sections.has('price') && detail.priceSeries?.length
          ? {
            days: detail.priceSeries.length,
            firstDate: detail.priceDates?.[0] ?? null,
            lastDate: detail.priceDates?.[detail.priceDates.length - 1] ?? null,
            low: Math.min(...detail.priceSeries),
            high: Math.max(...detail.priceSeries),
          }
          : undefined,
        priceWindow: window
          ? { interval: window.interval, fromTs: seriesFrom, toTs: seriesTo, points: window.priceSeries?.length ?? 0, open: window.priceSeries?.[0] ?? null, close: window.priceSeries?.[window.priceSeries.length - 1] ?? null }
          : undefined,
        holders: holders
          ? {
            total: holders.total,
            totalUsd: holders.totalUsd,
            top: (holders.holders ?? []).slice(0, MAX_HOLDER_ROWS).map(h => compactHolder(h, holders.asset.decimals, holders.asset.symbol)),
          }
          : undefined,
        liquidity: pools
          ? {
            totalAmount: scaleAmount(pools.totalAmount, pools.asset?.decimals ?? 0),
            totalUsd: pools.totalUsd,
            sources: [...(pools.sources ?? [])]
              .sort((x, y) => (y.assetUsd ?? 0) - (x.assetUsd ?? 0))
              .slice(0, MAX_POOL_ROWS)
              .map(src => ({
                kind: src.kind,
                poolId: src.poolId,
                name: src.name,
                amount: scaleAmount(src.assetAmount, pools.asset?.decimals ?? 0),
                amountUsd: src.assetUsd,
                sharePctOfPool: src.assetSharePct,
                poolTvlUsd: src.tvlUsd,
              })),
            venues: pools.sources?.length ?? 0,
            formerVenues: pools.former?.length ?? 0,
          }
          : undefined,
        dca: dcas
          ? { buys: (dcas.buys ?? []).slice(0, MAX_DCA_ROWS).map(compactDca), sells: (dcas.sells ?? []).slice(0, MAX_DCA_ROWS).map(compactDca) }
          : undefined,
        limitOrders: book
          ? { bids: (book.bids ?? []).slice(0, MAX_BOOK_ROWS).map(compactOrder), asks: (book.asks ?? []).slice(0, MAX_BOOK_ROWS).map(compactOrder) }
          : undefined,
    }, errs)
  },
}

export const assetTools: ToolDefinition[] = [listAssets, getAsset]
