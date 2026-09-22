/**
 * What the three entry-point tools share.
 *
 * `search`, `inspect_entity` and `get_activity` all speak the same two
 * vocabularies — the identifier grammar the explorer accepts, and the hit shape
 * `/explorer/search` answers with — so both live here rather than in three
 * near-copies. The module also carries the small upstream shapes `types.ts`
 * does not mirror, argument parsing, and the partial-failure helper every tool
 * uses to keep one failed enrichment from losing the whole answer.
 */

import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { AccountRef, AssetRef, ActivityRow, ActivityRevenue, MoneyMarketPosition, SearchResult } from '../types.ts'
import type { ToolContext, ToolError, ToolOutput } from '../toolTypes.ts'
import type { UpstreamClient } from '../upstream.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import { UpstreamError } from '../upstream.ts'
import {
  accountLabel, accountUrl, assetLabelWithId, assetUrl, blockUrl,
  extrinsicUrl, poolUrl, referendumUrl, shortHash, tagUrl, v3PoolUrl, xcDestinationUrl,
} from '../format/refs.ts'
import { formatUsd, scaleBase1e8 } from '../format/units.ts'
import { budget } from '../format/md.ts'
import { fitJson } from '../format/json.ts'

/* ============ the identifier grammar ============ */

/**
 * The thirteen entity kinds `inspect_entity` can render. `kind` forces one and
 * skips detection; without it the shape of the string decides.
 */
export const ENTITY_KINDS = [
  'block', 'extrinsic', 'event', 'trade', 'account', 'asset', 'pool',
  'tag', 'referendum', 'intent', 'dca', 'contract', 'xc-destination',
] as const
export type EntityKind = typeof ENTITY_KINDS[number]

export const RE_NUMERIC = /^\d+$/
export const RE_COORDINATE = /^(\d+)-(\d+)$/
export const RE_HASH64 = /^0x[0-9a-fA-F]{64}$/
export const RE_H160 = /^0x[0-9a-fA-F]{40}$/
// SS58 of any prefix: base58 (no 0, O, I, l), 46-50 characters for a 32-byte
// public key across the prefixes this chain sees (Hydration 63, Polkadot 0,
// Kusama 2, generic 42). Short enough not to swallow a symbol or a tag name.
export const RE_SS58 = /^[1-9A-HJ-NP-Za-km-z]{46,50}$/
// `opengov:410`, `democracy/101`, `opengov 410` — the pallet-qualified form a
// referendum needs, because both pallets index from 0.
export const RE_REFERENDUM = /^(opengov|democracy)[\s:/#-]*(\d+)$/i

export type IdentifierShape =
  | 'numeric' | 'coordinate' | 'hash64' | 'h160' | 'ss58' | 'referendum' | 'text'

/** What a raw identifier LOOKS like, before any upstream call. */
export function identifierShape(raw: string): IdentifierShape {
  const s = raw.trim()
  if (RE_NUMERIC.test(s)) return 'numeric'
  if (RE_COORDINATE.test(s)) return 'coordinate'
  if (RE_HASH64.test(s)) return 'hash64'
  if (RE_H160.test(s)) return 'h160'
  if (RE_REFERENDUM.test(s)) return 'referendum'
  if (RE_SS58.test(s)) return 'ss58'
  return 'text'
}

export interface ReferendumRef { pallet: 'opengov' | 'democracy'; index: number }

/** `opengov:410` / `democracy/101` → the pallet and index that address it. */
export function parseReferendumRef(raw: string): ReferendumRef | null {
  const m = RE_REFERENDUM.exec(raw.trim())
  if (!m) return null
  return { pallet: m[1].toLowerCase() as 'opengov' | 'democracy', index: Number(m[2]) }
}

/** `14743669-2` → the block height and the index within it. */
export function parseCoordinate(raw: string): { height: number; index: number } | null {
  const m = RE_COORDINATE.exec(raw.trim())
  if (!m) return null
  return { height: Number(m[1]), index: Number(m[2]) }
}

/* ============ search hits, as both tools read them ============ */

export interface SearchHitView {
  /** The entity kind `inspect_entity` would render this hit as. */
  kind: EntityKind
  label: string
  /** Exactly what to pass back as `inspect_entity`'s `identifier`. */
  identifier: string
  url: string | null
  /** The one extra fact that tells two hits of the same kind apart. */
  detail: string | null
  json: Record<string, unknown>
}

/** Plural headings, so a group of hits reads as a group. */
export const KIND_HEADING: Record<EntityKind, string> = {
  block: 'Blocks',
  extrinsic: 'Extrinsics',
  event: 'Events',
  trade: 'Trades',
  account: 'Accounts',
  asset: 'Assets',
  pool: 'Pools',
  tag: 'Tags',
  referendum: 'Referenda',
  intent: 'Intents',
  dca: 'DCA schedules',
  contract: 'Contracts',
  'xc-destination': 'Cross-chain destinations',
}

const looksLikeAddress = (s: string | undefined): boolean =>
  s != null && (RE_SS58.test(s) || RE_H160.test(s))

/** A pool hit's `value` is a pool id, the word `omnipool`, or a v3 contract. */
function poolHitUrl(value: string, base: string): string | null {
  if (RE_H160.test(value)) return v3PoolUrl(base, value)
  if (RE_NUMERIC.test(value) || value === 'omnipool') return poolUrl(base, value)
  return null
}

/**
 * One `/explorer/search` hit as something an agent can act on: the kind, the
 * best name, the identifier to pass on, and the page it lives on.
 *
 * Two upstream quirks are absorbed here rather than at each call site. A
 * `referendum` hit's `value` is the title key `"<pallet>:<index>"` and routes
 * nowhere, so its URL is built from `pallet` + `index`. An `xcDestination` hit
 * carries a NEGATIVE sentinel `assetId` that addresses nothing, so no field of
 * it is ever printed — the platform slug is the identifier.
 */
export function viewSearchHit(hit: SearchResult, base: string): SearchHitView | null {
  const value = String(hit.value ?? '')
  if (!value) return null
  switch (hit.type) {
    case 'block':
      return {
        kind: 'block', label: `Block #${Number(value).toLocaleString('en-US')}`, identifier: value,
        url: blockUrl(base, value), detail: null, json: { height: Number(value) },
      }
    case 'extrinsic':
      return {
        kind: 'extrinsic', label: RE_HASH64.test(value) ? shortHash(value) : value, identifier: value,
        url: extrinsicUrl(base, value), detail: null, json: { extrinsic: value },
      }
    case 'address': {
      // `label` is an address form (Polkadot SS58 or H160); `value` is the raw
      // AccountId32, which is a public key and never a label.
      const identifier = looksLikeAddress(hit.label) ? (hit.label as string) : value
      const named = hit.identity?.display?.trim()
      const emoji = hit.emoji ? `${hit.emoji} ` : ''
      return {
        kind: 'account',
        label: named ? `${emoji}${named}${hit.identity?.verified ? ' ✓' : ''}` : `${emoji}${accountLabel(identifier)}`,
        identifier,
        url: accountUrl(base, identifier),
        // The identifier already prints the address; a second elided copy of it
        // would only take up the line.
        detail: null,
        json: { address: identifier, accountId: value, identity: named ?? null },
      }
    }
    case 'asset':
      return {
        kind: 'asset',
        label: hit.asset ? assetLabelWithId(hit.asset) : `${hit.label ?? value} (#${value})`,
        identifier: value,
        url: assetUrl(base, value),
        detail: hit.desc ?? hit.asset?.name ?? null,
        json: { assetId: Number(value), symbol: hit.asset?.symbol ?? hit.label ?? null, name: hit.desc ?? null },
      }
    case 'tag':
      return {
        kind: 'tag', label: hit.label ?? value, identifier: value,
        url: tagUrl(base, value), detail: null, json: { tagId: value, name: hit.label ?? null },
      }
    case 'referendum': {
      const pallet = hit.pallet ?? (value.startsWith('democracy') ? 'democracy' : 'opengov')
      const index = hit.index ?? Number(value.split(':')[1])
      const addressable = Number.isFinite(index)
      return {
        kind: 'referendum',
        label: hit.label ?? `${pallet} #${index}`,
        identifier: addressable ? `${pallet}/${index}` : value,
        url: addressable ? referendumUrl(base, pallet, index) : null,
        detail: [addressable ? `${pallet} #${index}` : null, hit.status].filter(Boolean).join(' · ') || null,
        json: { pallet, index: addressable ? index : null, title: hit.label ?? null, status: hit.status ?? null },
      }
    }
    case 'pool':
      return {
        kind: 'pool', label: hit.label ?? value, identifier: value,
        url: poolHitUrl(value, base),
        detail: [hit.poolKind, hit.tvlUsd != null ? `TVL ${formatUsd(hit.tvlUsd)}` : null].filter(Boolean).join(' · ') || null,
        json: { pool: value, kind: hit.poolKind ?? null, tvlUsd: hit.tvlUsd ?? null },
      }
    case 'xcDestination':
      return {
        kind: 'xc-destination', label: hit.label ?? value, identifier: value,
        url: xcDestinationUrl(base, value),
        detail: hit.desc ?? null,
        json: { platform: value, symbol: hit.label ?? null, description: hit.desc ?? null },
      }
    default:
      return null
  }
}

/** The one call that resolves anything; 10 s upstream cache, so ask freely. */
export async function runSearch(upstream: UpstreamClient, query: string): Promise<SearchResult[]> {
  const hits = await upstream.get<SearchResult[]>('/explorer/search', { q: query }, { ttlMs: 10_000 })
  return Array.isArray(hits) ? hits : []
}

/**
 * A hit kept beside the view built from it.
 *
 * The exact-match test below reads the RAW hit — an asset's `label` is the bare
 * symbol (`HDX`) while its view's label is the rendered `HDX (#0)` and its
 * identifier is the id `0`, so a view alone cannot tell an exact symbol match
 * from a substring one.
 */
export interface SearchHitPair { hit: SearchResult; view: SearchHitView }

/** Every hit this surface can act on, in the upstream's resolution order. */
export function viewSearchHits(hits: readonly SearchResult[], base: string): SearchHitPair[] {
  return hits
    .map(hit => ({ hit, view: viewSearchHit(hit, base) }))
    .filter((p): p is SearchHitPair => p.view != null)
}

/**
 * Kind preference for a free-text query: the specific before the fuzzy.
 * `/explorer/search` appends tags before assets, so a bare `HDX` would
 * otherwise read as the "HDX Kraken LP" tag rather than as the native token.
 */
export const HIT_KIND_PREFERENCE: readonly SearchResult['type'][] =
  ['asset', 'tag', 'xcDestination', 'pool', 'referendum', 'block', 'extrinsic', 'address']

export interface PreferredHit { pair: SearchHitPair; exact: boolean }

/**
 * Which hit the caller most likely MEANT, and whether that is a fact or a guess.
 *
 * The upstream's array order is resolution order, not a ranking (catalogue § 3),
 * so "the first hit" is not an answer to "which one is it". An exact match on the
 * hit's own name or value IS an answer; without one the best this can do is take
 * the most specific kind present, and `exact: false` says so, so the caller can
 * word the difference instead of presenting a guess as a choice.
 *
 * `search` and `inspect_entity` both read it, so the two tools cannot disagree
 * about what one string resolves to — `HDX` opening the native token in one and
 * a seven-member LP tag in the other is exactly the divergence it prevents.
 */
export function preferredHit(pairs: readonly SearchHitPair[], query: string): PreferredHit | null {
  if (!pairs.length) return null
  const lower = query.trim().toLowerCase()
  const ordered = [
    ...HIT_KIND_PREFERENCE.flatMap(type => pairs.filter(p => p.hit.type === type)),
    ...pairs.filter(p => !HIT_KIND_PREFERENCE.includes(p.hit.type)),
  ]
  const exact = ordered.find(p => [p.hit.label, p.hit.value].some(v => String(v ?? '').toLowerCase() === lower))
  if (exact) return { pair: exact, exact: true }
  return { pair: ordered[0] ?? pairs[0], exact: false }
}

/* ============ asset resolution ============ */

export interface ResolvedAsset { assetId: number; label: string }

export interface AssetResolution {
  chosen: ResolvedAsset
  /** Other assets carrying the same symbol — HDXb alone names a dozen bonds. */
  alternatives: ResolvedAsset[]
}

/**
 * An asset id or a symbol to an id. Symbols are NOT unique on Hydration (a bond
 * and its underlying, aDOT over DOT), so the alternatives travel with the
 * answer instead of being silently discarded.
 */
export async function resolveAssetToken(upstream: UpstreamClient, token: string): Promise<AssetResolution | null> {
  const raw = token.trim()
  if (RE_NUMERIC.test(raw)) return { chosen: { assetId: Number(raw), label: `#${raw}` }, alternatives: [] }
  const hits = (await runSearch(upstream, raw)).filter(h => h.type === 'asset')
  if (!hits.length) return null
  const view = (h: SearchResult): ResolvedAsset => ({
    assetId: Number(h.value),
    label: h.asset ? assetLabelWithId(h.asset) : `${h.label ?? h.value} (#${h.value})`,
  })
  const exact = hits.filter(h => (h.label ?? '').toLowerCase() === raw.toLowerCase())
  const ordered = exact.length ? [...exact, ...hits.filter(h => !exact.includes(h))] : hits
  return { chosen: view(ordered[0]), alternatives: ordered.slice(1, 5).map(view) }
}

/* ============ upstream shapes types.ts does not mirror ============ */

export interface TradeHop {
  pool: string
  poolId?: number | null
  /** A v3 hop's tier: hundredths of a basis point as a number, or `"0.3%"`. */
  feeTier?: number | string | null
  poolAddress?: string | null
  assetIn: AssetRef
  assetOut: AssetRef
  /** Null on a hop the router did not book an amount for (an aToken wrap). */
  amountIn: string | null
  amountOut: string | null
  /** The hop's fee in its own asset, which is not always the hop's output asset. */
  fee?: { amount: string; asset: AssetRef } | null
}

/** `/explorer/trade/:h/:i` and `/explorer/trade-event/:h/:i` answer the same shape. */
export interface TradeDetail {
  blockHeight: number
  timestamp: string
  extrinsicIndex: number | null
  eventIndex: number | null
  hash: string | null
  success: boolean
  who: AccountRef | null
  venue: string
  direction: 'Sell' | 'Buy'
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  /** assetOut per one assetIn, already divided out of raw units. */
  executionPrice: number | null
  limit: { kind: 'minReceived' | 'maxPaid'; amount: string; asset: AssetRef; marginPct: number | null } | null
  extrinsicFee: string | null
  extrinsicTip: string | null
  feePayment?: { asset: AssetRef; amount: string; tipAmount: string | null }
  route: TradeHop[]
  dca?: boolean
  revenue?: ActivityRevenue
  poolAddress?: string
  finalized?: boolean
  iceIntents?: unknown[]
}

export interface DcaRouteHop { pool: string; assetIn: number; assetOut: number }

export interface DcaScheduleDetail {
  scheduleId: number
  who: AccountRef | null
  createdAt: { blockHeight: number; timestamp: string; extrinsicIndex: number | null } | null
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  direction: 'Sell' | 'Buy' | ''
  amountPer: string | null
  totalAmount: string | null
  amountPerUsd: number | null
  budgetUsd: number | null
  usdBasis?: 'current' | 'ended'
  /** A BLOCK count; `periodSeconds` is the median actually observed. */
  period: number | null
  periodSeconds: number | null
  maxRetries: number | null
  slippagePermill: number | null
  minAmountOut: string | null
  maxAmountIn: string | null
  /** `[]` means the router chooses the route at execution time. */
  route: DcaRouteHop[] | null
  nextExecutionBlock: number | null
  fundingBalance: string | null
  status: string
  statusAt?: { blockHeight: number; timestamp: string } | null
  statusReason?: string | null
  migratedToIntentId?: string | null
  executions: { count: number; failed: number; attempts: number; totalIn: string | null; totalOut: string | null }
  rows: ActivityRow[]
}

export interface DcaExecutionDetail {
  scheduleId: number
  status: 'executed' | 'failed'
  who: AccountRef | null
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  amountIn: string | null
  amountOut: string | null
  valueUsd: number | null
  executionPrice: number | null
  period: number | null
  failureReason: { label: string; docs: string | null } | null
  revenue?: ActivityRevenue
}

export interface IntentOrderDetail {
  order: {
    intentId: string
    seq: number
    kind: 'swap' | 'dca'
    amountIn: string
    amountOut: string
    partial: boolean
    slippagePpm?: number | null
    budget?: string | null
    period?: number | null
    deadlineMs?: number | null
    blockHeight: number
    extrinsicIndex: number | null
    timestamp: string
  }
  owner: AccountRef | null
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  status: 'open' | 'partially-filled' | 'filled' | 'completed' | 'cancelled' | 'expired'
  filledIn: string | null
  filledOut: string | null
  fills: ActivityRow[]
  fillsTotal: number
  dca: { remainingBudget: string | null; lastExecutionBlock: number | null; nextEligibleBlock: number | null } | null
  migratedFrom?: number | null
  /** assetOut units per one assetIn, as a 12 dp decimal string. */
  limitPriceOutPerIn: string | null
  /** assetIn units per one assetOut — the cap on what the order buys. 12 dp decimal string. */
  limitPriceInPerOut: string | null
  links?: { submission?: { block: number; extrinsicIndex: number | null } | null; solutions?: { block: number; extrinsicIndex: number | null }[] }
}

/** The `contract` block of an address detail — present only on the FULL read. */
export interface ContractInfo {
  address: string
  account?: AccountRef
  verified?: { status: string; name?: string | null; matchType?: string } | null
  verification?: {
    status: string
    name?: string | null
    compilerVersion?: string | null
    /** `exact_match` or `match` — whether the metadata hash matched too. */
    matchType?: string | null
    verifiedAt?: string | null
    abiPresent?: boolean
    sourceFileCount?: number
  } | null
  creation?: {
    method?: string
    deployer?: AccountRef | null
    blockHeight?: number
    extrinsicIndex?: number | null
    timestamp?: string
    txHash?: string | null
  } | null
  codeHash?: string | null
  codeSize?: number | null
  destroyed?: boolean
  txCount?: number | null
  logCount?: number | null
  firstActivity?: string | null
  lastActivity?: string | null
}

/** `/explorer/pool/v3/:address` — a concentrated-liquidity pool's own shape. */
export interface PoolV3Detail {
  kind: 'uniswapv3'
  address: string
  account?: AccountRef
  name?: string | null
  factory?: string | null
  /** Hundredths of a basis point, as the pool contract stores it (3000 = 0.3%). */
  fee?: number | null
  feeTier?: string | null
  tickSpacing?: number | null
  createdBlock?: number | null
  createdAt?: string | null
  token0: AssetRef
  token1: AssetRef
  assets?: { asset: AssetRef; amount: string; usd?: number | null }[]
  tvlUsd?: number | null
  price?: { token1PerToken0: number; token0PerToken1: number; tick?: number } | null
  liquidity?: string | null
  swaps?: number | null
  protocolFee?: { feeProtocol0?: number; feeProtocol1?: number; sharePct?: number | null } | null
  volume?: {
    allUsd?: number | null
    dayUsd?: number | null
    feesAllUsd?: number | null
    feesDayUsd?: number | null
  } | null
  feesCollected?: { amount0?: string; amount1?: string; usd?: number | null } | null
  firstSwapAt?: string | null
  lastSwapAt?: string | null
  positions?: unknown[]
  /** The Gamma vault that manages the range, when one does. */
  vault?: { address: string; account?: AccountRef; tvlUsd?: number | null; depositors?: number | null } | null
}

/* ============ what an account is worth ============ */

export interface PortfolioValue {
  /** Every balance and LP position, valued gross — the upstream `portfolioUsd`. */
  holdingsUsd: number
  /** Owed across every isolated market, summed only to be netted out. */
  moneyMarketDebtUsd: number
  /** Holdings minus that debt: the figure the Explorer page prints. */
  valueUsd: number
  /** How many isolated markets contributed to the debt. */
  markets: number
}

/**
 * The number the Explorer's account and tag pages print under **Value**.
 *
 * `portfolioUsd` is GROSS. It sums every balance and LP position, and assets
 * pledged as money-market collateral are inside it — they are ordinary aToken
 * balances, so an account that has supplied 394k avDOT still holds it. The page
 * nets the money-market DEBT back out (`portfolioUsd` minus every market's
 * `totalDebtBase`, which is what `moneyMarketDebtUsd` does in
 * explorer-ui/src/components/AccountSections.tsx) and that netted figure is what
 * the header shows and what the `/history` series ends on.
 *
 * So the gross figure must never be printed under a bare "Portfolio": it
 * contradicts the page the answer links to and this server's own history tool,
 * and the two numbers can differ by more than half. Both halves are rendered
 * here — the netted Value leads, the gross holdings and the debt stand beside it
 * — so the arithmetic is visible rather than being a second opinion.
 *
 * Debt is SUMMED across the isolated markets only for this subtraction, which is
 * the one place summing them is right: the account owes all of it. No other
 * money-market figure is ever blended (AGENTS.md § Explorer semantics).
 */
export function portfolioValue(
  portfolioUsd: number | null | undefined,
  markets: readonly MoneyMarketPosition[] | null | undefined,
): PortfolioValue {
  const holdingsUsd = Number.isFinite(portfolioUsd) ? Number(portfolioUsd) : 0
  const list = markets ?? []
  const moneyMarketDebtUsd = list.reduce((total, m) => total + (scaleBase1e8(m.totalDebtBase) ?? 0), 0)
  return { holdingsUsd, moneyMarketDebtUsd, valueUsd: holdingsUsd - moneyMarketDebtUsd, markets: list.length }
}

/**
 * The sentence that keeps the two figures apart wherever they are printed.
 * Stated only when there IS debt: with none, gross and net are the same number
 * and the explanation would be noise.
 */
export function valueReconciliation(v: PortfolioValue): string | null {
  if (v.moneyMarketDebtUsd <= 0) return null
  return `**Value** is what the Explorer page shows: holdings ${formatUsd(v.holdingsUsd)} minus ${formatUsd(v.moneyMarketDebtUsd)} of money-market debt across ${v.markets} isolated market${v.markets === 1 ? '' : 's'}. Holdings are GROSS and already include everything pledged as money-market collateral — an aToken is an ordinary balance — so do not subtract the collateral again. Quote Value when asked what this account is worth; quote Holdings only when the question is what it holds.`
}

/**
 * The 404 an address lookup answers is not a coordinate miss, so the generic
 * `blockIndexed` split does not apply: the upstream simply could not read the
 * string as an address. Said in one place so every tool that resolves an
 * address gives the same answer — an account that never transacted still
 * resolves, so a miss here is about the STRING, not about the account.
 */
export function addressNotFound(err: unknown, address: string, what = `The account ${address}`): ToolError {
  if (err instanceof UpstreamError && err.status === 404) {
    return {
      code: 'NOT_FOUND',
      message: `Hydration does not recognize ${JSON.stringify(address)} as an address. Accepted forms: an SS58 address of any prefix (Hydration 63, Polkadot 0, Kusama 2, generic 42 — they all decode to the same account), a raw AccountId32 as 0x + 64 hex, or an EVM address as 0x + 40 hex. An account that has never appeared on chain still resolves, with an empty portfolio, so a miss here means the string itself is not an address rather than that the account does not exist.`,
    }
  }
  return toolErrorFromUpstream(err, what)
}

/* ============ shared constants ============ */

/**
 * The Omnipool hub asset (registry id 1) is called H2O everywhere — UI copy,
 * API descriptions, docs (AGENTS.md § Explorer semantics). Its 12 decimals are a
 * fixed registry property of the one asset the Omnipool route reports without an
 * AssetRef of its own, so they are stated once here rather than costing a
 * registry read in each tool that renders a hub reserve.
 */
export const HUB_SYMBOL = 'H2O'
export const HUB_DECIMALS = 12

/* ============ argument parsing and output ============ */

export interface Parsed<T> { ok: true; value: T }
export interface ParseFailure { ok: false; error: ToolError }

/** zod's first issue as one sentence, so a bad argument reads as advice. */
export function argumentError(issues: readonly { path: PropertyKey[]; message: string }[]): ToolError {
  const first = issues[0]
  const where = first?.path?.length ? `${String(first.path[0])}: ` : ''
  const rest = issues.length > 1 ? ` (${issues.length - 1} further problem${issues.length === 2 ? '' : 's'})` : ''
  return invalidArgument(`${where}${first?.message ?? 'the arguments were not accepted'}${rest}`)
}

/**
 * Validates a call's arguments against the tool's own shape. The one parser
 * every tool uses, so a bad argument reads the same way across the surface.
 *
 * Two deliberate behaviours:
 *
 *  - An explicit `null` is treated as an ABSENT optional. Models routinely spell
 *    "I am not using this parameter" as `null` rather than by omitting the key,
 *    and the coercing numeric params would otherwise read it as 0 and quietly
 *    mean something.
 *  - Unknown keys are REJECTED rather than stripped, so a typo (`accountId` for
 *    `account`) fails loudly instead of returning a plausible answer to a
 *    question nobody asked. Note this bites only on the direct-handler path:
 *    the MCP SDK validates against its own `z.object(shape)` first and strips
 *    unknown keys before the handler runs, so over the protocol the typo is
 *    already gone by the time this sees the arguments.
 */
export function parseInput<T extends ZodRawShape>(
  shape: T,
  input: Record<string, unknown>,
): Parsed<z.infer<z.ZodObject<T>>> | ParseFailure {
  const cleaned = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v !== null && v !== undefined))
  const parsed = z.object(shape).strict().safeParse(cleaned)
  return parsed.success
    ? { ok: true, value: parsed.data as z.infer<z.ZodObject<T>> }
    : { ok: false, error: argumentError(parsed.error.issues) }
}

export interface Settled<T> { value: T | null; error: ToolError | null }

/**
 * One independent upstream read, resolved either way.
 *
 * Every tool that enriches a record fetches the parts concurrently and renders
 * what came back: a failed enrichment becomes a named error beside the payload,
 * never the loss of the payload. `Promise.allSettled` is what makes the failure
 * non-contagious — the caller awaits all of these together.
 */
export async function settle<T>(promise: Promise<T>, what: string): Promise<Settled<T>> {
  const [result] = await Promise.allSettled([promise])
  return result.status === 'fulfilled'
    ? { value: result.value, error: null }
    : { value: null, error: toolErrorFromUpstream(result.reason, what) }
}

/** A rendered answer trimmed to the caller's budget, with a way to ask for less. */
export function fit(markdown: string, ctx: ToolContext, advice?: string): string {
  return budget(markdown.trim(), ctx.maxTextChars, advice)
}

/**
 * How much room the structured record gets.
 *
 * The reply's text block also has to carry an `**Errors**` section when a
 * partial failure is reported, and the transport cuts whatever does not fit —
 * which for JSON means a document that no longer parses. The margin buys space
 * for that section so the trimming stays here, where it can drop whole records.
 */
const JSON_BUDGET_MARGIN = 2_000

/**
 * The uniform reply: a reading, the record behind it, and any gaps in it.
 *
 * The record passes through the JSON budget on the way out — every tool, not
 * only the ones whose payloads are known to be large — because `format: "json"`
 * must always hand back something `JSON.parse` accepts.
 */
export function output(ctx: ToolContext, markdown: string, json: unknown, errors: (ToolError | null | undefined)[] = []): ToolOutput {
  const real = errors.filter((e): e is ToolError => e != null)
  const fitted = fitJson(json, ctx.maxTextChars - JSON_BUDGET_MARGIN)
  return real.length ? { markdown, json: fitted, errors: real } : { markdown, json: fitted }
}

/**
 * The reply for a call that produced nothing at all.
 *
 * The markdown is deliberately EMPTY: `renderToolText` sets `isError` only when
 * there is no payload to read, and an error whose message is also pasted into
 * the body both prints twice and stops the reply being marked as a failure. The
 * whole content of this reply is the error, so everything a caller needs to act
 * on belongs in the error's own message.
 */
export function failure(error: ToolError | ToolError[], json: unknown = null): ToolOutput {
  return { markdown: '', json, errors: Array.isArray(error) ? error : [error] }
}

/** A list trimmed to fit, with the tail counted rather than dropped in silence. */
export function capped<T>(rows: T[], limit: number): { shown: T[]; omitted: number } {
  return { shown: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit) }
}

/** The `tool {json}` form a description tells the agent to call next. */
export function callHint(tool: string, args: Record<string, unknown>): string {
  const cleaned = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null))
  return `\`${tool} ${JSON.stringify(cleaned)}\``
}

/**
 * A tag's icon, when it IS one. `TagRef.icon` is usually an emoji but can be a
 * CDN URL (the Polkadot Treasury tag carries a Discord emoji image), and a URL
 * pasted in front of a name renders as noise.
 */
export function tagIcon(icon: string | null | undefined): string {
  if (!icon) return ''
  const trimmed = icon.trim()
  if (!trimmed || /^https?:/i.test(trimmed) || [...trimmed].length > 4) return ''
  return `${trimmed} `
}

/**
 * An asset reference as the structured record carries it.
 *
 * `format: "json"` answers with the INTERPRETED record rather than an echo of
 * the upstream body, and a nested AssetRef carries icon ids, origin blocks and
 * parachain ids that no answer uses. The three fields that matter to a caller
 * acting on the asset are the id, the symbol and the decimals every raw amount
 * of it must be scaled by.
 */
export interface CompactAsset { assetId: number; symbol: string; decimals: number }
export const compactAsset = (a: { assetId: number; symbol: string; decimals: number }): CompactAsset =>
  ({ assetId: a.assetId, symbol: a.symbol, decimals: a.decimals })
