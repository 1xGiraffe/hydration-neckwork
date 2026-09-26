/**
 * `inspect_entity` — one identifier in, the right interpreted record out.
 *
 * The detection table is the product. An agent holding a string rarely knows
 * which of thirteen routes it belongs to, and two of the shapes are genuinely
 * ambiguous on this chain: a bare number is a block height AND possibly an
 * asset id, a pool id and a referendum index, and a 0x + 64 hex string is a
 * block hash, an extrinsic hash, an EVM transaction hash or an AccountId32.
 * Both are resolved through `/explorer/search`, which already probes each
 * candidate in the right order, and BOTH report the readings they did not take
 * rather than choosing in silence.
 */

import { z } from 'zod'
import { formatParam } from '../toolTypes.ts'
import type { ToolContext, ToolDefinition, ToolError, ToolOutput } from '../toolTypes.ts'
import type {
  ActivityRow, AddressDetail, AssetDetail, BlockDetail, EventDetail, ExplorerStats,
  ExtrinsicDetail, PoolDetail, ReferendumDetail, SearchResult, TagDetail, XcDestinationDetail,
} from '../types.ts'
import { invalidArgument, notFound, toolErrorFromUpstream } from '../errors.ts'
import { UpstreamError } from '../upstream.ts'
import { bullets, budget, code, h2, h3, joinBlocks, kv, note, table } from '../format/md.ts'
import {
  accountLabel, accountUrl, assetLabel, assetLabelWithId, assetUrl, blockUrl, contractUrl,
  explorerLink, extrinsicAtUrl, extrinsicUrl, eventUrl, holdersUrl, intentUrl, poolUrl,
  referendumUrl, shortAddress, shortHash, tagUrl, tradeUrl, dcaScheduleUrl, dcaExecutionUrl,
  v3PoolUrl, xcDestinationUrl,
} from '../format/refs.ts'
import {
  DASH, formatAmount, formatBase1e8, formatCount, formatDecimalString, formatHealthFactor, formatNumber,
  formatPercent, formatPercentChange, formatUsd,
} from '../format/units.ts'
import { blocksToDuration, formatDuration, formatTime, isUnrecordedTime, relativeAge } from '../format/time.ts'
import { activityDetail, activityLine } from '../format/activity.ts'
import type { EntityKind, SearchHitView } from './shared.ts'
import {
  ENTITY_KINDS, RE_H160, RE_HASH64, RE_NUMERIC,
  addressNotFound, callHint, capped, failure, identifierShape, output, parseInput, parseCoordinate,
  parseReferendumRef, portfolioValue, preferredHit, runSearch, settle, valueReconciliation,
  viewSearchHit, viewSearchHits,
} from './shared.ts'
import type {
  ContractInfo, DcaExecutionDetail, DcaScheduleDetail, IntentOrderDetail, PoolV3Detail, TradeDetail,
} from './shared.ts'

/**
 * The native token's decimals are fixed in the registry, and an extrinsic's
 * `fee` is documented as HDX planck with no asset ref of its own. A non-HDX fee
 * arrives as `feePayment`, which carries its own ref and is preferred.
 */
const NATIVE_FEE = { symbol: 'HDX', decimals: 12 }

const SHAPE = {
  identifier: z.string().min(1).max(128).describe('The thing to look up: a block height or hash, an extrinsic hash or `height-index`, an address (SS58 of any prefix, AccountId32, or EVM H160), an asset symbol or id, a pool id or v3 pool contract, a tag id, `opengov/410`, an ICE intent id, a DCA schedule id, or a cross-chain destination slug.'),
  kind: z.enum(ENTITY_KINDS).optional().describe('Force the reading instead of detecting it. Needed when a bare number is ambiguous (block height vs asset id vs pool id vs referendum index), when a `height-index` names an event or a trade rather than an extrinsic, and to read an EVM address as a contract rather than as an account.'),
  format: formatParam,
}
const DESCRIPTION = `Identify one thing on Hydration and return its interpreted record — amounts scaled and named, accounts resolved to their identity and tag, every figure carrying the canonical Explorer URL for the page it came from.

This is the tool to reach for first when you hold an identifier and want to know what it IS. It detects the shape of the string and routes it, so you never have to pick a route: a bare number is read as a block height; \`height-index\` (e.g. \`14743669-2\`) as the extrinsic at that position; 0x + 64 hex as a block hash, extrinsic hash, EVM transaction hash or AccountId32, probed in that order; 0x + 40 hex as an EVM account, contract or Uniswap-v3 pool; any SS58 address (any prefix) as an account; \`opengov/410\` or \`democracy/101\` as a referendum; and anything else — a symbol, a tag name, a pool name — is resolved through search, taking the asset hit for a bare symbol.

Ambiguity is reported, never hidden. A bare number can be a block height AND an asset id AND a pool id AND a referendum index at the same time; the answer reads the block and NAMES the other candidates with the exact call that opens each. Pass \`kind\` to choose directly.

\`kind\` also unlocks readings detection cannot reach: \`event\` and \`trade\` reinterpret a \`height-index\` coordinate as the event or the classified trade at that position rather than the extrinsic; \`contract\` reads an EVM address as a deployed contract (verification, deployer, code size, transaction count); \`dca\` reads a number as a schedule and a coordinate as one execution of it.

Per kind you get: a block with its classified activity; an extrinsic with its call, signer, decoded failure reason, fee and the activity it produced; a trade with both legs, execution price, venue and route; an account or asset as a COMPACT reading — call get_account or get_asset for the full picture; and pools, tags, referenda, intents, DCA schedules and cross-chain destinations rendered from their own detail routes.

A miss distinguishes two cases an agent must treat differently: NOT_YET_INDEXED means the block has not reached the index (it trails the finalized head by roughly 35-65 seconds) and the right move is to retry; NOT_FOUND means the block is indexed and holds no such row, so the identifier is wrong and retrying will not help. One caveat on assets: an unknown-but-valid asset id does not 404 upstream — it answers a shell of nulls — and the answer says so explicitly rather than rendering the shell as fact.`

/* ============ resolution ============ */

interface Resolved {
  kind: EntityKind
  /** The route argument, already in the form its route takes. */
  target: string
  height?: number
  index?: number
  pallet?: 'opengov' | 'democracy'
  /** Readings this identifier also has, named in the answer. */
  candidates: SearchHitView[]
  errors: ToolError[]
}

const hitsOf = (hits: SearchResult[], type: SearchResult['type']) => hits.filter(h => h.type === type)

function candidatesFrom(hits: SearchResult[], base: string, taken: (v: SearchHitView) => boolean): SearchHitView[] {
  const views: SearchHitView[] = []
  for (const hit of hits) {
    const view = viewSearchHit(hit, base)
    if (!view || taken(view)) continue
    // One candidate per kind is enough to tell the agent the reading exists.
    if (views.some(v => v.kind === view.kind)) continue
    views.push(view)
  }
  return views.slice(0, 4)
}

/** Does `/explorer/asset/:id` describe a real registry asset, or the null shell? */
function isRealAsset(detail: AssetDetail | null): boolean {
  if (!detail?.asset) return false
  const a = detail.asset
  const unnamed = a.name == null && (a.symbol == null || a.symbol === `#${a.assetId}`)
  return !(unnamed && a.price == null && (detail.holderCount ?? 0) === 0 && (detail.totalUsd ?? 0) === 0)
}

// Block heights, asset ids, pool ids and referendum indices are ALL uint32
// upstream, so a decimal longer than this addresses none of them.
const MAX_BLOCK_HEIGHT = 4_294_967_295

/**
 * The one entity a number too large for a uint32 still addresses: an ICE intent,
 * whose id is a u128 decimal string (`33008562192747753225502851072109`).
 *
 * It is resolved BEFORE `/explorer/search` and `/explorer/asset/:id` rather than
 * after, because neither survives a number this size — search answers a
 * ClickHouse 500 (`cannot be parsed as UInt32`) and the asset route a 400 — and
 * because search answers a PHANTOM `block` hit for an out-of-range height, which
 * would otherwise win the resolution and send the read to a block that cannot
 * exist. The probe uses the same query `renderIntent` will, so the detail read
 * that follows a hit is served from the client's cache rather than repeated.
 */
async function resolveOversizedNumeric(id: string, ctx: ToolContext): Promise<Resolved | ToolOutput> {
  const intent = await settle(
    ctx.upstream.get<IntentOrderDetail>(`/explorer/intent/${id}`, { limit: 8 }),
    `intent ${id}`,
  )
  if (intent.value?.order) return { kind: 'intent', target: id, candidates: [], errors: [] }
  // The identifier is echoed VERBATIM: at this size `Number(id)` has already
  // lost digits, and printing a mangled id back misnames the thing that missed.
  return failure(notFound(
    `\`${id}\` addresses nothing on Hydration. It is larger than a block height, an asset id, a pool id or a referendum index can be — all four are unsigned 32-bit — so the only reading left is an ICE intent id, and no intent carries it (it may also be past the u128 an intent id can be). An intent id is the \`intentId\` on an intent activity row; find one with ${callHint('get_activity', { type: 'intent', limit: 5 })}.`,
  ))
}

async function resolveNumeric(id: string, ctx: ToolContext): Promise<Resolved | ToolOutput> {
  const base = ctx.explorerBaseUrl
  // A digit string past uint32 is handled first: see resolveOversizedNumeric.
  if (id.length > 10 || Number(id) > MAX_BLOCK_HEIGHT) return await resolveOversizedNumeric(id, ctx)
  const [search, asset] = await Promise.all([
    settle(runSearch(ctx.upstream, id), `search for ${id}`),
    settle(ctx.upstream.get<AssetDetail>(`/explorer/asset/${id}`, undefined, { ttlMs: 15_000 }), `asset ${id}`),
  ])
  const hits = search.value ?? []
  const assetIsReal = isRealAsset(asset.value)
  const candidates: SearchHitView[] = []
  const pushHit = (type: SearchResult['type']) => {
    const hit = hitsOf(hits, type)[0]
    const view = hit ? viewSearchHit(hit, base) : null
    if (view) candidates.push(view)
  }
  pushHit('block')
  if (assetIsReal && asset.value) {
    candidates.push({
      kind: 'asset',
      label: assetLabelWithId(asset.value.asset),
      identifier: id,
      url: assetUrl(base, id),
      detail: asset.value.asset.name ?? null,
      json: { assetId: Number(id) },
    })
  }
  pushHit('pool')
  // Referendum hits are matched upstream as a SUBSTRING of the index and of the
  // title, so "5" comes back with 54 through 59 as well. Those are not readings
  // of this identifier — a caller told "5 also resolves as referendum 57" would
  // be told something false — so only an exact index survives here.
  for (const hit of hitsOf(hits, 'referendum')) {
    const view = viewSearchHit(hit, base)
    if (view && String(view.json.index ?? '') === id) candidates.push(view)
  }

  // The spec's order: prefer the block, then the registry asset, then whatever
  // else the number addresses. Everything not taken is named in the answer.
  const chosen = candidates[0]
  if (!chosen) {
    // A height at or above the index head is not a miss yet — reading the block
    // is what produces the not-yet-indexed / never-existed split.
    return {
      kind: 'block', target: id, height: Number(id), candidates: [],
      errors: [search.error, asset.error].filter((e): e is ToolError => e != null),
    }
  }
  return {
    kind: chosen.kind,
    target: chosen.identifier,
    height: chosen.kind === 'block' ? Number(id) : undefined,
    pallet: chosen.kind === 'referendum' ? (chosen.json.pallet as 'opengov' | 'democracy') : undefined,
    index: chosen.kind === 'referendum' ? Number(chosen.json.index) : undefined,
    candidates: candidates.slice(1),
    errors: [],
  }
}

async function resolveHash64(id: string, ctx: ToolContext): Promise<Resolved> {
  const base = ctx.explorerBaseUrl
  const search = await settle(runSearch(ctx.upstream, id), `search for ${shortHash(id)}`)
  const hits = search.value ?? []
  // Resolution order is the upstream's: block hash, then substrate extrinsic
  // hash, then EVM transaction hash. The address reading is suppressed upstream
  // when a hash hit won, so a surviving address hit means it is an AccountId32.
  for (const type of ['block', 'extrinsic', 'address'] as const) {
    const hit = hitsOf(hits, type)[0]
    const view = hit ? viewSearchHit(hit, base) : null
    if (!view) continue
    return {
      kind: view.kind,
      target: view.identifier,
      height: view.kind === 'block' ? Number(view.identifier) : undefined,
      candidates: candidatesFrom(hits, base, v => v.kind === view.kind),
      errors: [],
    }
  }
  // Nothing resolved it: read it as an account, which is the only reading a
  // 64-hex string has without a matching block or extrinsic.
  return { kind: 'account', target: id, candidates: [], errors: search.error ? [search.error] : [] }
}

async function resolveH160(id: string, ctx: ToolContext): Promise<Resolved> {
  const base = ctx.explorerBaseUrl
  const search = await settle(runSearch(ctx.upstream, id), `search for ${id}`)
  const hits = search.value ?? []
  const pool = hitsOf(hits, 'pool').map(h => viewSearchHit(h, base)).find(v => v?.identifier.toLowerCase() === id.toLowerCase())
  if (pool) {
    return { kind: 'pool', target: pool.identifier, candidates: candidatesFrom(hits, base, v => v.kind === 'pool'), errors: [] }
  }
  // Every other H160 is an account — a contract's page IS its account page, and
  // the account reading folds the contract facts in when there are any.
  return { kind: 'contract', target: id, candidates: [], errors: search.error ? [search.error] : [] }
}

async function resolveText(id: string, ctx: ToolContext): Promise<Resolved | ToolOutput> {
  const base = ctx.explorerBaseUrl
  const search = await settle(runSearch(ctx.upstream, id), `search for ${JSON.stringify(id)}`)
  const hits = search.value ?? []
  const views = hits.map(h => viewSearchHit(h, base)).filter((v): v is SearchHitView => v != null)
  if (!views.length) {
    const grammar = 'Identifiers this tool reads: a block height or hash; an extrinsic hash or `height-index`; an address (SS58 of any prefix, AccountId32, EVM H160); an asset symbol or id; a pool id or v3 pool contract; a tag id; `opengov/410`; an ICE intent id; a DCA schedule id; a cross-chain destination slug.'
    const error = search.error
      ?? notFound(`Nothing on Hydration resolves ${JSON.stringify(id)}. ${grammar} Try ${callHint('search', { query: id })} for a fuzzy match.`)
    return failure(error)
  }
  // An exact name beats resolution order: `/explorer/search` appends tags before
  // assets, so a bare `HDX` would otherwise read as the "HDX Kraken LP" tag.
  // `preferredHit` is the shared rule — `search`'s closing nudge applies the same
  // one, so the two tools cannot point a caller at two different entities.
  const preferred = preferredHit(viewSearchHits(hits, base), id)?.pair.view ?? views[0]
  return {
    kind: preferred.kind,
    target: preferred.identifier,
    pallet: preferred.kind === 'referendum' ? (preferred.json.pallet as 'opengov' | 'democracy') : undefined,
    index: preferred.kind === 'referendum' ? Number(preferred.json.index) : undefined,
    candidates: candidatesFrom(hits, base, v => v.kind === preferred.kind && v.identifier === preferred.identifier),
    errors: [],
  }
}

/** `kind` was given: skip detection, but still turn a symbol or a title into an id. */
async function resolveWithKind(id: string, kind: EntityKind, ctx: ToolContext): Promise<Resolved | ToolOutput> {
  const shape = identifierShape(id)
  const coord = parseCoordinate(id)
  const base = ctx.explorerBaseUrl

  if (kind === 'referendum') {
    const ref = parseReferendumRef(id)
    if (ref) return { kind, target: id, pallet: ref.pallet, index: ref.index, candidates: [], errors: [] }
    if (RE_NUMERIC.test(id)) {
      // Both pallets index from 0, so a bare index names two referenda. Search
      // says which exist; OpenGov leads because Democracy is retired here.
      const hits = (await settle(runSearch(ctx.upstream, id), `search for ${id}`)).value ?? []
      const refs = hitsOf(hits, 'referendum').map(h => viewSearchHit(h, base)).filter((v): v is SearchHitView => v != null)
      const opengov = refs.find(v => v.json.pallet === 'opengov') ?? refs[0]
      if (opengov) {
        return {
          kind, target: opengov.identifier,
          pallet: opengov.json.pallet as 'opengov' | 'democracy',
          index: Number(opengov.json.index),
          candidates: refs.filter(v => v !== opengov),
          errors: [],
        }
      }
      return { kind, target: id, pallet: 'opengov', index: Number(id), candidates: [], errors: [] }
    }
    return failure(invalidArgument(`kind "referendum" needs an index — \`410\`, \`opengov/410\` or \`democracy/101\` — not ${JSON.stringify(id)}.`))
  }

  if (kind === 'event' || kind === 'trade') {
    if (coord) return { kind, target: id, height: coord.height, index: coord.index, candidates: [], errors: [] }
    if (kind === 'trade' && RE_HASH64.test(id)) {
      // A trade is addressed by its coordinates; the extrinsic hash resolves them.
      const ext = await settle(ctx.upstream.get<ExtrinsicDetail>(`/explorer/extrinsic/${id}`), `extrinsic ${shortHash(id)}`)
      if (ext.value && ext.value.blockHeight > 0) {
        return { kind, target: `${ext.value.blockHeight}-${ext.value.index}`, height: ext.value.blockHeight, index: ext.value.index, candidates: [], errors: [] }
      }
      return failure(ext.error ?? notFound(`No extrinsic ${shortHash(id)} to read a trade from.`))
    }
    return failure(invalidArgument(`kind "${kind}" needs a \`height-index\` coordinate (e.g. \`14743669-48\`), not ${JSON.stringify(id)}.`))
  }

  if (kind === 'dca' && coord) {
    return { kind, target: id, height: coord.height, index: coord.index, candidates: [], errors: [] }
  }

  if (kind === 'asset' && shape === 'text') {
    const hits = (await settle(runSearch(ctx.upstream, id), `search for ${JSON.stringify(id)}`)).value ?? []
    const assets = hitsOf(hits, 'asset').map(h => viewSearchHit(h, base)).filter((v): v is SearchHitView => v != null)
    const exact = assets.find(v => v.label.toLowerCase().startsWith(`${id.trim().toLowerCase()} `)) ?? assets[0]
    if (!exact) return failure(notFound(`No asset on Hydration is called ${JSON.stringify(id)}.`))
    return { kind, target: exact.identifier, candidates: assets.filter(v => v !== exact).slice(0, 4), errors: [] }
  }

  if (kind === 'tag' && shape === 'text' && /\s|[A-Z]/.test(id)) {
    // Tag ids are lower-case slugs; a display name has to go through search.
    const hits = (await settle(runSearch(ctx.upstream, id), `search for ${JSON.stringify(id)}`)).value ?? []
    const tag = hitsOf(hits, 'tag').map(h => viewSearchHit(h, base)).find((v): v is SearchHitView => v != null)
    if (tag) return { kind, target: tag.identifier, candidates: [], errors: [] }
  }

  const NUMERIC_KINDS: EntityKind[] = ['block', 'asset', 'intent', 'dca']
  if (NUMERIC_KINDS.includes(kind) && !RE_NUMERIC.test(id)) {
    return failure(invalidArgument(`kind "${kind}" needs a numeric id, and ${JSON.stringify(id)} is not one.`))
  }
  if (kind === 'pool' && !(RE_NUMERIC.test(id) || RE_H160.test(id) || id === 'omnipool')) {
    return failure(invalidArgument(`kind "pool" needs a pool id, a v3 pool contract address, or \`omnipool\` — not ${JSON.stringify(id)}.`))
  }

  return { kind, target: id, height: coord?.height, index: coord?.index, candidates: [], errors: [] }
}

async function resolve(id: string, kind: EntityKind | undefined, ctx: ToolContext): Promise<Resolved | ToolOutput> {
  if (kind) return await resolveWithKind(id, kind, ctx)
  switch (identifierShape(id)) {
    case 'coordinate': {
      const coord = parseCoordinate(id)!
      return { kind: 'extrinsic', target: id, height: coord.height, index: coord.index, candidates: [], errors: [] }
    }
    case 'referendum': {
      const ref = parseReferendumRef(id)!
      return { kind: 'referendum', target: id, pallet: ref.pallet, index: ref.index, candidates: [], errors: [] }
    }
    case 'ss58':
      return { kind: 'account', target: id, candidates: [], errors: [] }
    case 'h160':
      return await resolveH160(id, ctx)
    case 'hash64':
      return await resolveHash64(id, ctx)
    case 'numeric':
      return await resolveNumeric(id, ctx)
    default:
      return await resolveText(id, ctx)
  }
}

/* ============ shared rendering pieces ============ */

const isToolOutput = (v: Resolved | ToolOutput): v is ToolOutput => 'markdown' in v

/** The readings this identifier also has, each with the call that opens it. */
function alsoLine(candidates: SearchHitView[]): string | null {
  if (!candidates.length) return null
  const parts = candidates.map(c => `${c.kind} ${c.label}${c.detail ? ` (${c.detail})` : ''} → ${callHint('inspect_entity', { identifier: c.identifier, kind: c.kind })}`)
  return `_This identifier also resolves as:_\n${bullets(parts)}`
}

/** Activity lines, capped, with the tail counted and a way to page it. */
function activityBlock(rows: ActivityRow[], base: string, limit: number, more: string | null): string {
  const { shown, omitted } = capped(rows, limit)
  const lines = shown.map(r => `- ${activityLine(r, base)}`)
  const tail = omitted > 0 ? `\n_${omitted} further classified row${omitted === 1 ? '' : 's'} not shown${more ? `; page them with ${more}` : ''}._` : ''
  return shown.length ? `${lines.join('\n')}${tail}` : '_No classified activity._'
}

const timeLine = (ts: string | null | undefined): string | null =>
  ts && !isUnrecordedTime(ts) ? `${formatTime(ts)} (${relativeAge(ts)})` : null

/* ============ per-kind renderings ============ */

async function renderBlock(height: number, ctx: ToolContext, candidates: SearchHitView[]): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const [detail, activity] = await Promise.all([
    settle(ctx.upstream.get<BlockDetail>(`/explorer/block/${height}`), `block ${height}`),
    settle(ctx.upstream.get<ActivityRow[]>(`/explorer/block/${height}/activity`), `block ${height} activity`),
  ])
  if (!detail.value) return failure(detail.error!)
  const b = detail.value
  const eventsNote = b.eventsShown != null && b.eventsShown < b.eventCount
    ? `${formatCount(b.eventCount)} (${b.eventsShown} carried on the block page; the rest page through the events feed)`
    : formatCount(b.eventCount)

  const extrinsics = capped(b.extrinsics ?? [], 10)
  const extrinsicRows = extrinsics.shown.map(x => [
    explorerLink(`${x.blockHeight}-${x.index}`, extrinsicAtUrl(base, x.blockHeight, x.index)),
    x.callName,
    x.signer ? accountLabel(x.signer) : 'unsigned',
    x.success ? 'ok' : `failed${x.errorReason?.label ? ` — ${x.errorReason.label}` : ''}`,
  ])

  const markdown = joinBlocks(
    h2(`Block ${formatCount(b.height)}`),
    kv([
      // The genesis block carries no timestamp and the explorer answers the
      // unix epoch for it; printed as a date it reads as a real moment in 1970.
      ['Time', isUnrecordedTime(b.timestamp)
        ? 'not recorded — the genesis block carries no timestamp, and the explorer answers the unix epoch in its place'
        : timeLine(b.timestamp)],
      ['Status', b.finalized === false ? 'unfinalized — served from the pending head layer, may reorg' : 'finalized'],
      ['Hash', b.hash],
      ['Parent', b.parentHash ? shortHash(b.parentHash) : null],
      ['Author', b.author ? accountLabel(b.author, { withAddress: true }) : null],
      ['Runtime', b.specVersion != null ? `spec ${b.specVersion}` : null],
      ['Extrinsics', b.extrinsicCount == null ? null : formatCount(b.extrinsicCount)],
      ['Events', eventsNote],
      ['Explorer', blockUrl(base, b.height)],
    ]),
    h3('Classified activity'),
    activity.value
      ? activityBlock(activity.value, base, 15, callHint('get_activity', { block: b.height, limit: 50 }))
      : '_Could not be read._',
    h3(`Extrinsics${extrinsics.omitted > 0 ? ` (first 10 of ${b.extrinsicCount})` : ''}`),
    table(['Id', 'Call', 'Signer', 'Result'], extrinsicRows),
    alsoLine(candidates),
  )
  return output(ctx, markdown, { kind: 'block', block: b, activity: activity.value ?? null }, [detail.error, activity.error].filter((e): e is ToolError => e != null))
}

const NOISE_EVENTS = new Set([
  'System.ExtrinsicSuccess', 'System.ExtrinsicFailed', 'TransactionPayment.TransactionFeePaid',
  'Balances.Withdraw', 'Balances.Deposit', 'Balances.Endowed', 'Tokens.Withdrawn', 'Tokens.Deposited',
  'Tokens.Endowed', 'System.NewAccount', 'Treasury.Deposit',
])

/**
 * Fee as actually charged: the signer's own currency when it is not HDX, and the
 * EVM gas a dispatch charged beside the fee (its own asset) — both the account
 * paid, and together they are what the activity row's revenue attributes.
 */
function feeLine(fee: string | null, tip: string | null | undefined, payment: ExtrinsicDetail['feePayment']): string | null {
  const parts: string[] = []
  if (payment) {
    parts.push(formatAmount(payment.amount, payment.asset.decimals, assetLabel(payment.asset)))
    if (payment.tipAmount && payment.tipAmount !== '0') parts.push(`tip ${formatAmount(payment.tipAmount, payment.asset.decimals, assetLabel(payment.asset))}`)
    if (payment.gas) parts.push(`EVM gas ${formatAmount(payment.gas.amount, payment.gas.asset.decimals, assetLabel(payment.gas.asset))}`)
    return parts.join(' · ')
  }
  if (fee == null) return null
  parts.push(formatAmount(fee, NATIVE_FEE.decimals, NATIVE_FEE.symbol))
  if (tip && tip !== '0') parts.push(`tip ${formatAmount(tip, NATIVE_FEE.decimals, NATIVE_FEE.symbol)}`)
  return parts.join(' · ')
}

async function renderExtrinsic(target: Resolved, ctx: ToolContext, candidates: SearchHitView[]): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const byHash = target.height == null
  const path = byHash ? `/explorer/extrinsic/${target.target}` : `/explorer/extrinsic-at/${target.height}/${target.index}`
  const activityPath = byHash ? `/explorer/extrinsic/${target.target}/activity` : `/explorer/extrinsic-at/${target.height}/${target.index}/activity`
  const [detail, activity] = await Promise.all([
    settle(ctx.upstream.get<ExtrinsicDetail>(path), `extrinsic ${target.target}`),
    settle(ctx.upstream.get<ActivityRow[]>(activityPath), `extrinsic ${target.target} activity`),
  ])
  if (!detail.value) return failure(detail.error!)
  const x = detail.value
  const pending = x.mempool === true
  const unfinalized = x.finalized === false && !pending

  const counts = new Map<string, number>()
  for (const ev of x.events ?? []) counts.set(ev.name, (counts.get(ev.name) ?? 0) + 1)
  const notable = [...counts.entries()].filter(([name]) => !NOISE_EVENTS.has(name))
  const notableShown = capped(notable, 10)
  const eventSummary = `${(x.events ?? []).length} event${(x.events ?? []).length === 1 ? '' : 's'}`
    + (notableShown.shown.length ? `: ${notableShown.shown.map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')}` : '')
    + (notableShown.omitted > 0 ? `, +${notableShown.omitted} more kinds` : '')
    + (notable.length < counts.size ? ' (fee and account-plumbing events folded away)' : '')

  const evm = x.evmTx
    ? kv([
      ['EVM transaction', x.evmTx.txHash],
      ['EVM outcome', [x.evmTx.exitKind, x.evmTx.exitDetail].filter(Boolean).join(' — ') || null],
      ['Decoded EVM calls', x.evmCalls?.length ? String(x.evmCalls.length) : null],
    ])
    : null

  const markdown = joinBlocks(
    h2(`Extrinsic ${x.callName}`),
    kv([
      ['Id', pending ? null : `${x.blockHeight}-${x.index}`],
      ['Hash', x.hash],
      ['Status', pending
        ? 'unconfirmed — still in the transaction pool; the outcome below is a DRY-RUN projection, not a fact'
        : unfinalized ? 'unconfirmed — above the finalized head, may reorg away' : 'finalized'],
      ['Result', x.success ? 'success' : `failed — ${x.errorReason?.label ?? 'unknown error'}${x.errorReason?.docs ? ` (${x.errorReason.docs})` : ''}`],
      ['Signer', x.signer ? accountLabel(x.signer, { withAddress: true }) : 'unsigned (inherent)'],
      ['Origin', x.origin ? `${x.origin.kind}${x.origin.state ? ` · ${x.origin.state}` : ''}${x.origin.threshold ? ` · threshold ${x.origin.approvals ?? 0}/${x.origin.threshold}` : ''}` : null],
      ['Fee', feeLine(x.fee, x.tip, x.feePayment)],
      ['Block', pending ? null : `${formatCount(x.blockHeight)} · ${timeLine(x.timestamp)}`],
      ['Explorer', pending ? extrinsicUrl(base, x.hash) : extrinsicAtUrl(base, x.blockHeight, x.index)],
    ]),
    evm ? `${h3('EVM')}\n${evm}` : null,
    h3('Classified activity'),
    activity.value ? activityBlock(activity.value, base, 10, null) : '_Could not be read._',
    h3('Events'),
    eventSummary,
    alsoLine(candidates),
  )
  return output(ctx, markdown, { kind: 'extrinsic', extrinsic: x, activity: activity.value ?? null }, [activity.error].filter((e): e is ToolError => e != null))
}

async function renderEvent(height: number, index: number, ctx: ToolContext): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const detail = await settle(ctx.upstream.get<EventDetail>(`/explorer/event/${height}/${index}`), `event ${height}-${index}`)
  if (!detail.value) return failure(detail.error!)
  const e = detail.value

  // The classified reading of the event lives on its extrinsic's activity, so
  // an event that belongs to one gets the economic action beside the raw row.
  let row: ActivityRow | null = null
  let siblings: ActivityRow[] | undefined
  let rowError: ToolError | null = null
  if (e.extrinsicIndex != null && e.mempool !== true) {
    const activity = await settle(
      ctx.upstream.get<ActivityRow[]>(`/explorer/extrinsic-at/${height}/${e.extrinsicIndex}/activity`),
      `activity of extrinsic ${height}-${e.extrinsicIndex}`,
    )
    rowError = activity.error
    // The extrinsic's whole classified set, not just this event's row: revenue
    // is attributed to exactly one row of an extrinsic, so the siblings are
    // what distinguish "not booked yet" from "booked on another row".
    siblings = Array.isArray(activity.value) ? activity.value : undefined
    row = (siblings ?? []).find(r => r.eventIndex === e.eventIndex) ?? (siblings ?? [])[0] ?? null
  }

  const args = e.args != null ? budget(JSON.stringify(e.args, null, 2), 1_400, 'Read the extrinsic for the full call.') : null
  const markdown = joinBlocks(
    h2(`Event ${e.name}`),
    kv([
      // A pooled event's `blockHeight` is a zero placeholder, and `0-12` printed
      // as a position reads as a coordinate in the genesis block.
      ['Position', e.mempool || e.blockHeight <= 0 ? null : `${e.blockHeight}-${e.eventIndex}`],
      ['Phase', e.phase],
      ['Time', timeLine(e.timestamp)],
      ['Status', e.mempool
        ? 'unconfirmed — still in the transaction pool, so it has no block yet and no position of its own'
        : e.finalized === false ? 'unconfirmed — above the finalized head, may reorg away' : 'finalized'],
      ['Extrinsic', e.extrinsic ? `${e.extrinsic.callName} by ${e.extrinsic.signer ? accountLabel(e.extrinsic.signer) : 'unsigned'} · ${explorerLink(`${e.extrinsic.blockHeight}-${e.extrinsic.index}`, extrinsicAtUrl(base, e.extrinsic.blockHeight, e.extrinsic.index))}` : null],
      ['Explorer', eventUrl(base, e.blockHeight, e.eventIndex)],
    ]),
    row ? `${h3('Classified activity')}\n${activityDetail(row, base, { extrinsicRows: siblings })}` : null,
    args ? `${h3('Arguments')}\n${code(args, 'json')}` : null,
  )
  return output(ctx, markdown, { kind: 'event', event: e, activity: row }, [rowError].filter((e2): e2 is ToolError => e2 != null))
}

function tradeRouteTable(trade: TradeDetail): string {
  const tier = (value: number | string | null | undefined): string => {
    if (value == null) return ''
    // A number is the pool contract's own unit: hundredths of a basis point.
    return typeof value === 'number' ? ` ${formatPercent(value / 10_000)}` : ` ${value}`
  }
  const rows = (trade.route ?? []).map(hop => [
    hop.pool + tier(hop.feeTier),
    // A hop with no booked amounts is a wrap leg the router did not price; the
    // assets still say what it did.
    hop.amountIn == null && hop.amountOut == null
      ? `${assetLabel(hop.assetIn)} → ${assetLabel(hop.assetOut)}`
      : `${formatAmount(hop.amountIn, hop.assetIn.decimals, assetLabel(hop.assetIn))} → ${formatAmount(hop.amountOut, hop.assetOut.decimals, assetLabel(hop.assetOut))}`,
    hop.fee ? formatAmount(hop.fee.amount, hop.fee.asset.decimals, assetLabel(hop.fee.asset)) : DASH,
  ])
  return table(['Pool', 'Leg', 'Fee'], rows, 'the router recorded no hops for this trade')
}

async function renderTrade(height: number, index: number, ctx: ToolContext): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const [extrinsicIndexed, activity] = await Promise.all([
    settle(ctx.upstream.get<TradeDetail>(`/explorer/trade/${height}/${index}`), `trade ${height}-${index}`),
    settle(ctx.upstream.get<ActivityRow[]>(`/explorer/extrinsic-at/${height}/${index}/activity`), `activity of extrinsic ${height}-${index}`),
  ])
  let trade = extrinsicIndexed.value
  let eventIndexed = false
  let error = extrinsicIndexed.error
  if (!trade) {
    // A pallet or block-hook swap belongs to no extrinsic; it is addressed by
    // its EVENT index instead, on a route of its own.
    const fallback = await settle(ctx.upstream.get<TradeDetail>(`/explorer/trade-event/${height}/${index}`), `trade at event ${height}-${index}`)
    trade = fallback.value
    eventIndexed = trade != null
    error = trade ? null : (error ?? fallback.error)
  }
  if (!trade) return failure(error!)

  const row = (activity.value ?? []).find(r => r.type === 'trade' || r.type === 'otc' || r.type === 'intent' || r.type === 'xcswap') ?? null
  const price = trade.executionPrice != null
    ? `${formatNumber(trade.executionPrice)} ${assetLabel(trade.assetOut)} per ${assetLabel(trade.assetIn)}`
    : null
  const limit = trade.limit
    ? `${trade.limit.kind === 'minReceived' ? 'min received' : 'max paid'} ${formatAmount(trade.limit.amount, trade.limit.asset.decimals, assetLabel(trade.limit.asset))}${trade.limit.marginPct != null ? ` (margin ${formatPercent(trade.limit.marginPct)})` : ''}`
    : null

  const markdown = joinBlocks(
    h2(`Trade — ${trade.direction} ${assetLabel(trade.assetIn)} → ${assetLabel(trade.assetOut)}`),
    kv([
      ['Position', `${trade.blockHeight}-${eventIndexed ? 'e' : ''}${eventIndexed ? trade.eventIndex : trade.extrinsicIndex}`],
      ['Time', timeLine(trade.timestamp)],
      ['Status', trade.finalized === false ? 'unconfirmed — may reorg away' : trade.success ? 'executed' : 'failed'],
      ['Trader', trade.who ? accountLabel(trade.who, { withAddress: true }) : null],
      ['Venue', trade.venue],
      ['Sent', formatAmount(trade.amountIn, trade.assetIn.decimals, assetLabelWithId(trade.assetIn))],
      ['Received', formatAmount(trade.amountOut, trade.assetOut.decimals, assetLabelWithId(trade.assetOut))],
      ['Value', trade.valueUsd != null ? formatUsd(trade.valueUsd) : null],
      ['Execution price', price],
      ['Limit', limit],
      ['Fee', feeLine(trade.extrinsicFee, trade.extrinsicTip, trade.feePayment)],
      ['DCA', trade.dca ? 'yes — this fill belongs to a standing schedule' : null],
      ['Explorer', tradeUrl(base, trade.blockHeight, (eventIndexed ? trade.eventIndex : trade.extrinsicIndex) ?? 0, { event: eventIndexed })],
    ]),
    h3('Route'),
    tradeRouteTable(trade),
    row ? `${h3('Classified activity')}\n${activityDetail(row, base, { extrinsicRows: activity.value ?? undefined })}` : null,
    !row && trade.revenue
      ? `${h3('Revenue')}\n${kv([['Protocol', formatUsd(trade.revenue.protocolUsd)], ['LPs', formatUsd(trade.revenue.lpUsd)]])}`
      : null,
  )
  return output(ctx, markdown, { kind: 'trade', trade, activity: row }, [activity.error].filter((e): e is ToolError => e != null))
}

function contractBlock(info: ContractInfo | null | undefined): string | null {
  if (!info) return null
  const verification = info.verification ?? null
  return kv([
    // The address itself is already in the identity block above.
    ['Verification', verification?.status === 'verified'
      ? `verified as ${verification.name ?? 'unnamed'}${verification.compilerVersion ? ` · ${verification.compilerVersion}` : ''}${verification.matchType ? ` · ${verification.matchType}` : ''}`
      : (verification?.status ?? 'not verified')],
    ['Deployed by', info.creation?.deployer ? accountLabel(info.creation.deployer, { withAddress: true }) : null],
    ['Deployed at', info.creation?.blockHeight != null ? `block ${formatCount(info.creation.blockHeight)} · ${formatTime(info.creation.timestamp)}` : null],
    ['Code', info.codeSize != null ? `${formatCount(info.codeSize)} bytes${info.codeHash ? ` · ${shortHash(info.codeHash)}` : ''}` : null],
    ['Transactions', info.txCount != null ? formatCount(info.txCount) : null],
    ['Logs', info.logCount != null ? formatCount(info.logCount) : null],
    ['Active', info.firstActivity ? `${formatTime(info.firstActivity)} → ${formatTime(info.lastActivity)}` : null],
    ['Destroyed', info.destroyed ? 'yes' : null],
  ])
}

async function renderAccount(address: string, ctx: ToolContext, opts: { contract?: boolean } = {}): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  // `summary=1` skips the lock snapshot and the live proxy/multisig reads, which
  // is what makes this a compact reading — but it also drops the `contract`
  // block, so an EVM address is read in full.
  const query = opts.contract ? undefined : { summary: 1 }
  let a: AddressDetail & { contract?: ContractInfo | null }
  try {
    a = await ctx.upstream.get<AddressDetail & { contract?: ContractInfo | null }>(`/explorer/address/${encodeURIComponent(address)}`, query)
  } catch (err) {
    // A 404 here is about the STRING, not about the account: an address that
    // has never transacted still resolves. get_account says exactly this, and
    // the two tools must not answer one question two ways.
    return failure(addressNotFound(err, address, `The account ${shortAddress(address)}`))
  }

  const holdings = [...(a.balances ?? [])]
    .sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
  const top = capped(holdings, 5)
  const holdingRows = top.shown.map(b => [
    assetLabelWithId(b.asset),
    formatAmount(b.total, b.asset.decimals),
    b.valueUsd != null ? formatUsd(b.valueUsd) : DASH,
  ])

  // `totalCollateralBase` and `totalSuppliedBase` are different figures — what
  // is pledged against the debt versus everything deposited — so they are
  // labelled separately here exactly as get_account labels them, rather than
  // one standing in for the other under the word "supplied".
  const mm = (a.moneyMarket ?? []).map(m => [
    `**${m.market}** — collateral ${formatBase1e8(m.totalCollateralBase)}`,
    m.totalSuppliedBase != null ? `supplied ${formatBase1e8(m.totalSuppliedBase)}` : null,
    `debt ${formatBase1e8(m.totalDebtBase)}`,
    `health ${formatHealthFactor(m.healthFactor)}`,
  ].filter(Boolean).join(' · '))
  const positions = [
    a.liquidityPositions?.length ? `${a.liquidityPositions.length} liquidity position${a.liquidityPositions.length === 1 ? '' : 's'}` : null,
    a.moneyMarket?.length ? `money-market position in ${a.moneyMarket.length} isolated market${a.moneyMarket.length === 1 ? '' : 's'}` : null,
    a.activeDcas?.length ? `${a.activeDcas.length} active DCA schedule${a.activeDcas.length === 1 ? '' : 's'}` : null,
    a.openLimitOrders?.length ? `${a.openLimitOrders.length} open limit order${a.openLimitOrders.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean) as string[]

  const identity = a.identity?.display
    ? `${a.identity.display}${a.identity.verified ? ' ✓ (registrar-judged)' : ' (self-declared)'}`
    : null
  const related = (a.relatedAccountIds ?? []).length
  const contractName = a.contract?.verification?.name ?? a.contract?.verified?.name ?? null
  const heading = a.contract
    ? `Contract ${contractName ?? shortAddress(a.contract.address)}`
    : `Account ${identity ?? a.tag?.name ?? shortAddress(a.ss58)}`

  const value = portfolioValue(a.portfolioUsd, a.moneyMarket)
  const markdown = joinBlocks(
    h2(heading),
    kv([
      ['Identity', identity],
      ['System tag', a.tag?.name],
      ['Profile name', a.profile?.name],
      ['Emoji', a.emoji ? `${a.emoji}${a.emojiName ? ` (${a.emojiName})` : ''}` : null],
      ['Hydration address', a.ss58],
      ['Polkadot address', a.ss58Polkadot],
      ['EVM address', a.evmAddress],
      // The page's headline figure, and the same measure get_account_history's
      // series ends on. The gross holdings stand beside it, never in its place.
      ['Value (holdings minus money-market debt)', formatUsd(value.valueUsd)],
      ['Holdings', formatUsd(value.holdingsUsd)],
      ['Money-market debt', value.moneyMarketDebtUsd > 0 ? formatUsd(value.moneyMarketDebtUsd) : null],
      ['Trading volume', a.tradingVolumeUsd != null ? formatUsd(a.tradingVolumeUsd) : null],
      ['Related accounts', related > 1 ? `${related} (every figure here is scoped to the whole set — proxies, the bound EVM account and multisig members included)` : null],
      ['Explorer', opts.contract ? contractUrl(base, a.evmAddress ?? a.ss58) : accountUrl(base, a.ss58)],
    ]),
    holdingRows.length ? `${h3(`Top holdings${top.omitted > 0 ? ` (5 of ${holdings.length})` : ''}`)}\n${table(['Asset', 'Amount', 'Value'], holdingRows)}` : null,
    positions.length ? `${h3('Positions')}\n${bullets(positions)}` : null,
    mm.length ? `${h3('Money market')}\n${bullets(mm)}\n${note('Markets are isolated; a health factor belongs to one of them and must never be blended with another.')}` : null,
    valueReconciliation(value) ? note(valueReconciliation(value)!) : null,
    opts.contract && a.contract ? `${h3('Contract')}\n${contractBlock(a.contract)}` : null,
    `For the full picture — every balance with its locks, LP positions per venue, money-market reserves, schedules and orders — call ${callHint('get_account', { address: a.ss58 })}.`,
  )
  // The json half carries the compact reading too: the full balance sheet is
  // what get_account is for, and repeating it here would double the answer.
  return output(ctx, markdown, {
    // Reading an H160 ASKS for the contract block; only the answer says whether
    // there IS one. Keying the record's `kind` on the request would label every
    // plain EVM-bound wallet a contract in the structured half of the reply.
    kind: a.contract ? 'contract' : 'account',
    account: { ...a, balances: capped(holdings, 10).shown, portfolioSeries: undefined, portfolioDates: undefined, balanceHistory: undefined },
  }, [])
}

async function renderAsset(assetId: string, ctx: ToolContext, candidates: SearchHitView[]): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const detail = await settle(ctx.upstream.get<AssetDetail>(`/explorer/asset/${assetId}`, undefined, { ttlMs: 15_000 }), `asset ${assetId}`)
  if (!detail.value) return failure(detail.error!)
  const d = detail.value
  if (!isRealAsset(d)) {
    return output(ctx, joinBlocks(
      h2(`Asset #${assetId}`),
      `No asset **#${assetId}** is in the Hydration registry.`,
      note('This route does not 404 on an unknown id — it answers a shell of nulls — so the empty record is the absence of an asset, not an asset with no activity.'),
      `List what does exist with ${callHint('list_assets', {})}.`,
    ), { kind: 'asset', assetId: Number(assetId), exists: false }, [notFound(`Asset #${assetId} is not in the registry.`)])
  }
  const a = d.asset
  const markdown = joinBlocks(
    h2(`Asset ${assetLabelWithId(a)}`),
    kv([
      ['Name', a.name],
      ['Type', a.type],
      ['Decimals', String(a.decimals)],
      ['Price', a.price != null ? formatUsd(a.price) : null],
      ['24 h change', a.change24h != null ? formatPercentChange(a.change24h) : null],
      ['Value held on chain', d.totalUsd != null ? formatUsd(d.totalUsd) : null],
      ['Holders', d.holderCount != null ? `${formatCount(d.holderCount)} · ${explorerLink('holders', holdersUrl(base, a.assetId))}` : null],
      ['Active DCA schedules', d.dcaCount != null ? formatCount(d.dcaCount) : null],
      ['Open limit orders', d.limitOrderCount != null ? formatCount(d.limitOrderCount) : null],
      ['Liquidity venues', d.liquiditySourceCount != null ? formatCount(d.liquiditySourceCount) : null],
      ['Origin', a.origin ? `${a.origin.ecosystem} chain ${a.origin.chainId}` : a.parachainId != null ? `parachain ${a.parachainId}` : null],
      ['Explorer', assetUrl(base, a.assetId)],
    ]),
    `For price history, holders, venues and the asset's own activity call ${callHint('get_asset', { asset: String(a.assetId) })}.`,
    alsoLine(candidates),
  )
  return output(ctx, markdown, { kind: 'asset', asset: d }, [])
}

async function renderPool(target: string, ctx: ToolContext, candidates: SearchHitView[]): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  if (target === 'omnipool') {
    return output(ctx, joinBlocks(
      h2('Omnipool'),
      `The Omnipool is a single pool holding every listed asset, and its record is the whole protocol dashboard rather than one pool row — read it with ${callHint('get_pools', { venue: 'omnipool' })}.`,
      `Explorer: ${poolUrl(base, 'omnipool')}`,
      alsoLine(candidates),
    ), { kind: 'pool', pool: 'omnipool' }, [])
  }

  if (RE_H160.test(target)) {
    const detail = await settle(ctx.upstream.get<PoolV3Detail>(`/explorer/pool/v3/${target.toLowerCase()}`), `v3 pool ${shortHash(target)}`)
    if (!detail.value) return failure(detail.error!)
    const p = detail.value
    const price = p.price
      ? `${formatNumber(p.price.token1PerToken0)} ${assetLabel(p.token1)} per ${assetLabel(p.token0)}`
      : null
    const markdown = joinBlocks(
      h2(`Pool ${p.name ?? shortHash(p.address)}`),
      kv([
        ['Venue', `Uniswap v3${p.feeTier ? ` · fee tier ${p.feeTier}` : ''}`],
        ['Contract', p.address],
        ['Pair', `${assetLabelWithId(p.token0)} / ${assetLabelWithId(p.token1)}`],
        ['TVL', p.tvlUsd != null ? formatUsd(p.tvlUsd) : null],
        ['Price', price],
        ['Swaps', p.swaps != null ? formatCount(p.swaps) : null],
        ['Volume (24 h / all)', p.volume ? `${formatUsd(p.volume.dayUsd ?? null)} / ${formatUsd(p.volume.allUsd ?? null)}` : null],
        ['Fees (24 h / all)', p.volume ? `${formatUsd(p.volume.feesDayUsd ?? null)} / ${formatUsd(p.volume.feesAllUsd ?? null)}` : null],
        ['Positions', p.positions ? formatCount(p.positions.length) : null],
        ['Gamma vault', p.vault ? `${p.vault.address}${p.vault.tvlUsd != null ? ` · TVL ${formatUsd(p.vault.tvlUsd)}` : ''}` : null],
        ['Created', p.createdBlock != null ? `block ${formatCount(p.createdBlock)} · ${formatTime(p.createdAt)}` : null],
        ['Last swap', p.lastSwapAt ? timeLine(p.lastSwapAt) : null],
        ['Explorer', v3PoolUrl(base, p.address)],
      ]),
      `For the composition, the LP set and this pool's activity call ${callHint('get_pools', { pool: p.address })}.`,
      alsoLine(candidates),
    )
    return output(ctx, markdown, { kind: 'pool', pool: p }, [])
  }

  const detail = await settle(ctx.upstream.get<PoolDetail>(`/explorer/pool/${target}`), `pool ${target}`)
  if (!detail.value) return failure(detail.error!)
  const p = detail.value
  const rows = (p.assets ?? []).map(entry => [
    assetLabelWithId(entry.asset),
    formatAmount(entry.amount, entry.asset.decimals),
    entry.usd != null ? formatUsd(entry.usd) : DASH,
    entry.sharePct != null ? formatPercent(entry.sharePct) : DASH,
    entry.peg ? formatNumber(entry.peg.price) : DASH,
  ])
  const markdown = joinBlocks(
    h2(`Pool ${p.name} (#${p.poolId})`),
    kv([
      ['Venue', p.kind],
      ['TVL', p.tvlUsd != null ? formatUsd(p.tvlUsd) : null],
      ['Share token', p.shareToken ? assetLabelWithId(p.shareToken) : null],
      ['Shares issued', p.shareToken ? formatAmount(p.totalIssuance, p.shareToken.decimals) : null],
      ['Fee', p.feePermill != null ? formatPercent(p.feePermill / 10_000) : null],
      ['Amplification', p.amplification ? `${p.amplification.current}${p.amplification.current !== p.amplification.final ? ` → ${p.amplification.final}` : ''}` : null],
      ['Pool account', p.account ? accountLabel(p.account, { withAddress: true }) : null],
      ['Created', p.createdBlock != null ? `block ${formatCount(p.createdBlock)} · ${formatTime(p.createdAt)}` : null],
      ['Destroyed', p.destroyed ? 'yes' : null],
      ['Explorer', poolUrl(base, p.poolId)],
    ]),
    h3('Composition'),
    table(['Asset', 'Amount', 'Value', 'Share', 'Peg'], rows),
    `For the LP set, the pool's activity and its history call ${callHint('get_pools', { pool: String(p.poolId) })}.`,
    alsoLine(candidates),
  )
  return output(ctx, markdown, { kind: 'pool', pool: p }, [])
}

async function renderTag(tagId: string, ctx: ToolContext, candidates: SearchHitView[]): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  // ALWAYS summary=1: the full tag record reaches 1.5 MB for `treasury`.
  const detail = await settle(ctx.upstream.get<TagDetail>(`/explorer/tag/${tagId}`, { summary: 1 }), `tag ${tagId}`)
  if (!detail.value) return failure(detail.error!)
  const t = detail.value
  // `topAssets` carries only the dominant asset; the balance sheet is what a
  // reader means by "top holdings".
  const top = capped([...(t.balances ?? [])].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0)), 5)
  const tagValue = portfolioValue(t.portfolioUsd, t.moneyMarket)
  const markdown = joinBlocks(
    h2(`Tag ${t.name}`),
    kv([
      ['Id', t.tagId],
      ['Note', t.note],
      ['Members', t.members?.length != null ? formatCount(t.members.length) : null],
      ['Value (holdings minus money-market debt)', formatUsd(tagValue.valueUsd)],
      ['Holdings', formatUsd(tagValue.holdingsUsd)],
      ['Money-market debt', tagValue.moneyMarketDebtUsd > 0 ? formatUsd(tagValue.moneyMarketDebtUsd) : null],
      ['Holdings ex-HDX', t.portfolioExHdxUsd != null ? formatUsd(t.portfolioExHdxUsd) : null],
      ['Trading volume', t.tradingVolumeUsd != null ? formatUsd(t.tradingVolumeUsd) : null],
      ['Revenue', t.revenueUsd != null ? formatUsd(t.revenueUsd) : null],
      ['Money market', t.moneyMarket?.length ? `${t.moneyMarket.length} isolated market position${t.moneyMarket.length === 1 ? '' : 's'}` : null],
      ['Explorer', tagUrl(base, t.tagId)],
    ]),
    top.shown.length ? `${h3(`Top holdings${top.omitted > 0 ? ` (5 of ${t.balances.length})` : ''}`)}\n${table(['Asset', 'Amount', 'Value'], top.shown.map(b => [assetLabelWithId(b.asset), formatAmount(b.total, b.asset.decimals), b.valueUsd != null ? formatUsd(b.valueUsd) : DASH]))}` : null,
    (t.members ?? []).length ? `${h3('Members')}\n${bullets(capped(t.members, 8).shown.map(m => accountLabel(m, { withAddress: true })))}${t.members.length > 8 ? `\n_${t.members.length - 8} more._` : ''}` : null,
    valueReconciliation(tagValue) ? note(valueReconciliation(tagValue)!) : null,
    `Every figure above aggregates the whole tag. For what its members did, call ${callHint('get_activity', { tag: t.tagId, limit: 25 })}.`,
    alsoLine(candidates),
  )
  return output(ctx, markdown, { kind: 'tag', tag: { ...t, balances: undefined, portfolioSeries: undefined, portfolioDates: undefined, balanceHistory: undefined } }, [])
}

async function renderReferendum(pallet: 'opengov' | 'democracy', index: number, ctx: ToolContext, candidates: SearchHitView[]): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const detail = await settle(ctx.upstream.get<ReferendumDetail>(`/explorer/referendum/${pallet}/${index}`), `referendum ${pallet} #${index}`)
  if (!detail.value) return failure(detail.error!)
  const r = detail.value
  const dec = r.asset?.decimals ?? 12
  const sym = r.asset ? assetLabel(r.asset) : 'HDX'
  const tally = r.liveTally
    ? kv([
      ['Aye', formatAmount(r.liveTally.ayes, dec, sym)],
      ['Nay', formatAmount(r.liveTally.nays, dec, sym)],
      ['Support', `${formatAmount(r.liveTally.support, dec, sym)} — support counts AYE PLUS ABSTAIN capital; nay is excluded`],
      ['Electorate', r.liveTally.electorate ? formatAmount(r.liveTally.electorate, dec, sym) : null],
    ])
    : r.onChainTally
      ? kv([
        ['Aye', formatAmount(r.onChainTally.ayes, dec, sym)],
        ['Nay', formatAmount(r.onChainTally.nays, dec, sym)],
        ['Support', r.onChainTally.support ? `${formatAmount(r.onChainTally.support, dec, sym)} — support counts AYE PLUS ABSTAIN capital; nay is excluded` : null],
        ['As of', `block ${formatCount(r.onChainTally.blockHeight)}${r.onChainTally.final ? ' (final)' : ''}`],
      ])
      : null

  const voters = capped([...(r.voters ?? [])].sort((a, b) => Number(b.weighted ?? 0) - Number(a.weighted ?? 0)), 5)
  const voterRows = voters.shown.map(v => [
    v.account ? accountLabel(v.account) : DASH,
    v.side,
    v.conviction ?? DASH,
    formatAmount(v.weighted, dec, sym),
  ])
  const timeline = capped([...(r.timeline ?? [])].reverse(), 5)

  const markdown = joinBlocks(
    h2(`Referendum ${pallet} #${index}${r.title ? ` — ${r.title}` : ''}`),
    kv([
      ['Status', r.status],
      ['Track', r.trackInfo ? `${r.trackInfo.name} (#${r.trackInfo.id})` : r.track != null ? `#${r.track}` : null],
      ['Proposer', r.proposer ? accountLabel(r.proposer, { withAddress: true }) : null],
      ['Submitted', r.submittedAt ? `block ${formatCount(r.submittedAt.blockHeight)} · ${timeLine(r.submittedAt.timestamp)}` : null],
      ['Concluded', r.concludedAt ? `block ${formatCount(r.concludedAt.blockHeight)} · ${timeLine(r.concludedAt.timestamp)}` : null],
      ['Enactment', r.enactment],
      ['Proposal call', r.proposalCall ? `${r.proposalCall.pallet}.${r.proposalCall.callName}${r.proposalCall.decodeError ? ` (undecodable: ${r.proposalCall.decodeError})` : ''}` : null],
      ['Voters', r.votesTotal != null ? formatCount(r.votesTotal) : null],
      ['Explorer', referendumUrl(base, pallet, index)],
      ['SubSquare', r.subsquareUrl],
    ]),
    tally ? `${h3('Tally')}\n${tally}` : null,
    voterRows.length ? `${h3(`Largest voters${voters.omitted > 0 ? ` (5 of the ${r.voters.length} loaded, ${formatCount(r.votesTotal)} cast in total)` : ''}`)}\n${table(['Account', 'Side', 'Conviction', 'Weighted'], voterRows)}` : null,
    timeline.shown.length ? `${h3('Timeline (latest first)')}\n${bullets(timeline.shown.map(t => `${t.event} — block ${formatCount(t.blockHeight)} · ${formatTime(t.timestamp)}${t.outcome ? ` · ${t.outcome}` : ''}`))}` : null,
    alsoLine(candidates),
  )
  return output(ctx, markdown, { kind: 'referendum', referendum: { ...r, voters: voters.shown, progress: undefined } }, [])
}

async function renderIntent(intentId: string, ctx: ToolContext): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const detail = await settle(ctx.upstream.get<IntentOrderDetail>(`/explorer/intent/${intentId}`, { limit: 8 }), `intent ${intentId}`)
  if (!detail.value) return failure(detail.error!)
  const d = detail.value
  const o = d.order
  const inDec = d.assetIn?.decimals ?? 0
  const outDec = d.assetOut?.decimals ?? 0
  const markdown = joinBlocks(
    h2(`ICE intent #${o.seq} (${o.kind === 'dca' ? 'DCA' : 'limit order'})`),
    kv([
      ['Intent id', o.intentId],
      ['Status', d.status],
      ['Owner', d.owner ? accountLabel(d.owner, { withAddress: true }) : null],
      ['Offered', formatAmount(o.amountIn, inDec, assetLabelWithId(d.assetIn))],
      ['Wanted', formatAmount(o.amountOut, outDec, assetLabelWithId(d.assetOut))],
      ['Filled', `${formatAmount(d.filledIn, inDec, assetLabel(d.assetIn))} → ${formatAmount(d.filledOut, outDec, assetLabel(d.assetOut))} over ${formatCount(d.fillsTotal)} fill${d.fillsTotal === 1 ? '' : 's'}`],
      // Both ways round: the rate of what the order sells, and the cap on what it
      // buys — an order accumulating an asset is read as the second, and neither
      // is recoverable from the other by inverting a truncated decimal. On a DCA
      // intent the limit binds ONE PERIOD's trade, and its slippage never loosens
      // it (pallet_intent enforces the tighter of this floor and an oracle one).
      ['Limit price', d.limitPriceOutPerIn && d.limitPriceInPerOut
        ? `${formatDecimalString(d.limitPriceOutPerIn)} ${assetLabel(d.assetOut)} per ${assetLabel(d.assetIn)}`
          + ` · ${formatDecimalString(d.limitPriceInPerOut)} ${assetLabel(d.assetIn)} per ${assetLabel(d.assetOut)}`
          + (o.kind === 'dca' ? ' (per trade)' : '')
        : null],
      ['Partial fills', o.partial ? 'allowed' : 'all-or-nothing'],
      ['Deadline', o.deadlineMs ? formatTime(new Date(o.deadlineMs).toISOString().replace('T', ' ').slice(0, 19)) : null],
      ['Placed', `block ${formatCount(o.blockHeight)} · ${timeLine(o.timestamp)}`],
      ['DCA budget left', d.dca?.remainingBudget ? formatAmount(d.dca.remainingBudget, inDec, assetLabel(d.assetIn)) : null],
      ['Next eligible block', d.dca?.nextEligibleBlock != null ? formatCount(d.dca.nextEligibleBlock) : null],
      ['Explorer', intentUrl(base, o.intentId)],
    ]),
    h3(`Fills (${(d.fills ?? []).length} most recent of ${formatCount(d.fillsTotal)})`),
    activityBlock(d.fills ?? [], base, 8, null),
  )
  return output(ctx, markdown, { kind: 'intent', intent: d }, [])
}

async function renderDcaSchedule(scheduleId: string, ctx: ToolContext): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const [detail, stats] = await Promise.all([
    settle(ctx.upstream.get<DcaScheduleDetail>(`/explorer/dca/${scheduleId}`, { limit: 8 }), `DCA schedule #${scheduleId}`),
    settle(ctx.upstream.get<ExplorerStats>('/explorer/stats', undefined, { ttlMs: 5_000 }), 'chain stats'),
  ])
  if (!detail.value) return failure(detail.error!)
  const d = detail.value
  const inDec = d.assetIn?.decimals ?? 0
  // The observed median is the honest period; the block count is what the
  // schedule declared, and turning it into time needs the NOMINAL slot second.
  const period = d.periodSeconds != null
    ? `${formatDuration(d.periodSeconds)} (median observed)`
    : d.period != null && stats.value
      ? `${blocksToDuration(d.period, stats.value.nominalBlockSec)} (${formatCount(d.period)} blocks, nominal)`
      : d.period != null ? `${formatCount(d.period)} blocks` : null

  const markdown = joinBlocks(
    h2(`DCA schedule #${d.scheduleId}`),
    kv([
      ['Status', `${d.status}${d.statusReason ? ` — ${d.statusReason}` : ''}`],
      ['Owner', d.who ? accountLabel(d.who, { withAddress: true }) : null],
      ['Direction', d.direction || null],
      ['Trade', `${formatAmount(d.amountPer, inDec, assetLabelWithId(d.assetIn))} → ${assetLabelWithId(d.assetOut)} every ${period ?? DASH}`],
      ['Per trade', d.amountPerUsd != null ? formatUsd(d.amountPerUsd) : null],
      // A zero total is how an open-ended schedule is encoded: it runs until
      // its funding is spent or it is cancelled, not until a budget is hit.
      ['Budget', d.totalAmount == null || /^0+$/.test(d.totalAmount)
        ? 'open-ended — no total set; it runs until the funding below is spent or it is terminated'
        : `${formatAmount(d.totalAmount, inDec, assetLabel(d.assetIn))}${d.budgetUsd != null ? ` (${formatUsd(d.budgetUsd)}${d.usdBasis === 'ended' ? ', priced at the schedule\'s end' : ''})` : ''}`],
      ['Funding left', d.fundingBalance != null ? formatAmount(d.fundingBalance, inDec, assetLabel(d.assetIn)) : null],
      ['Executions', `${formatCount(d.executions?.count)} filled · ${formatCount(d.executions?.failed)} failed of ${formatCount(d.executions?.attempts)} attempts`],
      ['Filled', d.executions?.totalIn ? `${formatAmount(d.executions.totalIn, inDec, assetLabel(d.assetIn))} → ${formatAmount(d.executions.totalOut, d.assetOut?.decimals ?? 0, assetLabel(d.assetOut))}` : null],
      ['Slippage cap', d.slippagePermill != null ? formatPercent(d.slippagePermill / 10_000) : null],
      ['Next execution', d.nextExecutionBlock != null ? `block ${formatCount(d.nextExecutionBlock)}` : null],
      ['Route', d.route == null ? null : d.route.length === 0 ? 'chosen by the router at execution time' : d.route.map(h => h.pool).join(' → ')],
      ['Migrated to intent', d.migratedToIntentId],
      ['Created', d.createdAt ? `block ${formatCount(d.createdAt.blockHeight)} · ${timeLine(d.createdAt.timestamp)}` : null],
      ['Explorer', dcaScheduleUrl(base, d.scheduleId)],
    ]),
    h3(`Recent executions (${(d.rows ?? []).length} most recent of ${formatCount(d.executions?.count)})`),
    activityBlock(d.rows ?? [], base, 8, null),
  )
  return output(ctx, markdown, { kind: 'dca', schedule: { ...d, rows: capped(d.rows ?? [], 8).shown } }, [stats.error].filter((e): e is ToolError => e != null))
}

async function renderDcaExecution(height: number, index: number, ctx: ToolContext): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const detail = await settle(ctx.upstream.get<DcaExecutionDetail>(`/explorer/dca/exec/${height}/${index}`), `DCA execution ${height}-${index}`)
  if (!detail.value) return failure(detail.error!)
  const d = detail.value
  const markdown = joinBlocks(
    h2(`DCA execution — schedule #${d.scheduleId}`),
    kv([
      ['Status', d.status === 'failed' ? `failed — ${d.failureReason?.label ?? 'unknown reason'}${d.failureReason?.docs ? ` (${d.failureReason.docs})` : ''}` : 'executed'],
      ['Owner', d.who ? accountLabel(d.who, { withAddress: true }) : null],
      ['Traded', `${formatAmount(d.amountIn, d.assetIn?.decimals ?? 0, assetLabel(d.assetIn))} → ${formatAmount(d.amountOut, d.assetOut?.decimals ?? 0, assetLabel(d.assetOut))}`],
      ['Value', d.valueUsd != null ? formatUsd(d.valueUsd) : null],
      ['Execution price', d.executionPrice != null ? `${formatNumber(d.executionPrice)} ${assetLabel(d.assetOut)} per ${assetLabel(d.assetIn)}` : null],
      ['Block', `${formatCount(d.blockHeight)} · ${timeLine(d.timestamp)}`],
      ['Revenue', d.revenue ? `protocol ${formatUsd(d.revenue.protocolUsd)} · LPs ${formatUsd(d.revenue.lpUsd)}` : null],
      ['Explorer', dcaExecutionUrl(base, d.blockHeight, d.eventIndex)],
      ['Schedule', dcaScheduleUrl(base, d.scheduleId)],
    ]),
    `The standing order behind this fill: ${callHint('inspect_entity', { identifier: String(d.scheduleId), kind: 'dca' })}.`,
  )
  return output(ctx, markdown, { kind: 'dca', execution: d }, [])
}

async function renderXcDestination(slug: string, ctx: ToolContext): Promise<ToolOutput> {
  const base = ctx.explorerBaseUrl
  const detail = await settle(ctx.upstream.get<XcDestinationDetail>(`/explorer/xc-destination/${slug}`), `cross-chain destination ${slug}`)
  if (!detail.value) return failure(detail.error!)
  const d = detail.value
  const dest = d.destination
  const sold = capped(d.soldAssets ?? [], 5)
  const markdown = joinBlocks(
    h2(`Cross-chain destination ${dest.symbol} (${dest.chainName})`),
    kv([
      ['Asset', `${dest.name} · ${dest.decimals} decimals`],
      ['Platform', dest.platform],
      ['Reference price', d.referencePrice != null ? `${formatUsd(d.referencePrice)} (${d.referenceSource}) — a venue quote, never what a swap actually got` : null],
      ['Swaps', `${formatCount(d.swapCount)} sent · ${formatCount(d.settledCount)} settled`],
      ['Sold', d.soldUsd != null ? formatUsd(d.soldUsd) : 'nothing settled yet'],
      ['Delivered', d.deliveredUsd != null ? formatUsd(d.deliveredUsd) : null],
      ['Recipients', formatCount(d.recipientCount)],
      ['Active', d.firstAt ? `${formatTime(d.firstAt)} → ${formatTime(d.lastAt)}` : null],
      ['Explorer', xcDestinationUrl(base, dest.platform)],
    ]),
    note('This is not a registry asset — it is reachable only by selling into it, and the negative asset id it carries internally addresses nothing.'),
    sold.shown.length ? `${h3('Sold into it')}\n${table(['Asset', 'Swaps', 'Amount', 'Value'], sold.shown.map(s => [assetLabelWithId(s.asset), formatCount(s.swaps), formatAmount(s.amount, s.asset.decimals), s.valueUsd != null ? formatUsd(s.valueUsd) : DASH]))}` : null,
    (d.recent ?? []).length ? `${h3('Recent')}\n${activityBlock(d.recent, base, 6, null)}` : null,
  )
  return output(ctx, markdown, { kind: 'xc-destination', destination: d }, [])
}

/* ============ the tool ============ */

export const inspectEntityTools: ToolDefinition[] = [{
  name: 'inspect_entity',
  title: 'Inspect a Hydration entity',
  description: DESCRIPTION,
  inputSchema: SHAPE,
  async handler(input, ctx) {
    const parsed = parseInput(SHAPE, input)
    if (!parsed.ok) return failure(parsed.error)
    const identifier = parsed.value.identifier.trim()
    const kind = parsed.value.kind

    const resolution = await resolve(identifier, kind, ctx)
    if (isToolOutput(resolution)) return resolution
    const { candidates } = resolution

    /**
     * A failed DETECTION read is reported beside the record it could not enrich.
     *
     * Resolution reads `/explorer/search` to find the other things an identifier
     * also names, and that read can fail on its own (it answers a ClickHouse 500
     * for some inputs). Dropping the failure would print the record with no
     * "also resolves as" line and no sign that the alternatives were looked for
     * and not found — an empty list standing in for a read that never returned.
     */
    const withResolutionErrors = (out: ToolOutput): ToolOutput => (
      resolution.errors.length
        ? { ...out, errors: [...(out.errors ?? []), ...resolution.errors] }
        : out
    )

    try {
      return withResolutionErrors(await renderResolved(resolution, candidates, ctx))
    } catch (err) {
      // A rendering fault must still name what was being read; an UpstreamError
      // that escaped a settle() is reported with its own polarity.
      if (err instanceof UpstreamError) return failure(toolErrorFromUpstream(err, `${resolution.kind} ${resolution.target}`))
      throw err
    }
  },
}]

/** One resolved identifier to its own record. */
async function renderResolved(resolution: Resolved, candidates: SearchHitView[], ctx: ToolContext): Promise<ToolOutput> {
  switch (resolution.kind) {
    case 'block':
      return await renderBlock(resolution.height ?? Number(resolution.target), ctx, candidates)
    case 'extrinsic':
      return await renderExtrinsic(resolution, ctx, candidates)
    case 'event':
      return await renderEvent(resolution.height!, resolution.index!, ctx)
    case 'trade':
      return await renderTrade(resolution.height!, resolution.index!, ctx)
    case 'account':
      return await renderAccount(resolution.target, ctx)
    case 'contract':
      return await renderAccount(resolution.target, ctx, { contract: true })
    case 'asset':
      return await renderAsset(resolution.target, ctx, candidates)
    case 'pool':
      return await renderPool(resolution.target, ctx, candidates)
    case 'tag':
      return await renderTag(resolution.target, ctx, candidates)
    case 'referendum':
      return await renderReferendum(resolution.pallet ?? 'opengov', resolution.index ?? Number(resolution.target), ctx, candidates)
    case 'intent':
      return await renderIntent(resolution.target, ctx)
    case 'dca':
      return resolution.height != null && resolution.index != null
        ? await renderDcaExecution(resolution.height, resolution.index, ctx)
        : await renderDcaSchedule(resolution.target, ctx)
    case 'xc-destination':
      return await renderXcDestination(resolution.target, ctx)
    default:
      return failure(invalidArgument(`no reading is defined for kind ${JSON.stringify(resolution.kind)}.`))
  }
}
