import type { ClickHouseClient } from '../db/client.ts'
import { cached, cachedSwr } from './cache.ts'
import { assetDescriptor, allExplorerAssets, ATOKEN_UNDERLYING_ID, PRICE_ALIAS_ID, SHARE_TOKEN_UNDERLYING_ID, UNDERLYING_TO_ATOKEN_ID, priceAssetId, displayAssetId, type ExplorerAsset } from './explorerAssets.ts'
import { accountVolumeSource } from './accountTradeVolume.ts'
import { tagForAccount, taggedAccountByH160, taggedTruncationPairs, ammPoolAccounts, getTag as getTagRecord, allTags } from './tagService.ts'
import { identityForAccount, searchIdentitiesByDisplay, type AccountIdentity } from './identityService.ts'
import { normalizeAddress, hydrationAddress, polkadotAddress, reservedH160AccountId, type NormalizedAddress } from './addressIdentity.ts'
import { accountIcon, emojisMatchingName, emojiNameFor, parseSuffixEmojiQuery } from './omniwatchIdentity.ts'
import { encodeAddress, base58Encode } from '@polkadot/util-crypto'
import { hexToU8a } from '@polkadot/util'
import { proxyInfoFor, multisigCompositionFor, multisigMembershipsFor, pendingMultisigOps, type ProxyRelation, type PendingMultisigOp } from './proxyMultisigService.ts'
import { ERC20_WALLET_ASSETS, ERC20_WALLET_ASSET_IDS } from './erc20WalletService.ts'
import { xcmJourneySourcesFor, xcmJourneysByOriginTx } from './xcmJourneyService.ts'
import { queryLockBreakdowns, type AssetLockBreakdown, type BalanceLockComponent, type BalanceLockTranche, type BalanceUnlockSlice } from './lockBreakdownService.ts'
import { createHash } from 'node:crypto'

let client: ClickHouseClient
export function initExplorerService(c: ClickHouseClient): void { client = c }

// shared shapes
export type AssetRef = ExplorerAsset
export interface AccountRef {
  accountId: string
  address: string                                   // Hydration SS58
  emoji: string                                     // Omniwatch/snakewatch identity emoji (keyed by SS58 prefix-63 address)
  emojiName?: string                                // human-readable name for the custom emoji/icon (e.g. Discord emoji name)
  emojiUrl?: string                                 // custom image icon (e.g. a Discord avatar) — render in place of the emoji char
  tag: { id: string; name: string; color: string; icon: string } | null
  identity?: AccountIdentity | null   // on-chain Identity.IdentityOf display + judgement status
}

function asset(assetIdStr: string | number): AssetRef {
  const id = typeof assetIdStr === 'number' ? assetIdStr : parseInt(assetIdStr, 10)
  return assetDescriptor(Number.isFinite(id) ? id : 0)
}

// EVM-truncated AccountId32 → H160 (else null).
function evmFromAccountId(acc: string): string | null {
  return acc.slice(2, 10) === '45544800' && acc.slice(50) === '0000000000000000' ? '0x' + acc.slice(10, 50) : null
}
// An account's truncated-H160 form (where its EVM-side activity is indexed): the
// account itself if already truncated, else 0x45544800 + first-20-bytes + zeros.
function evmAccountForm(acc: string): string | null {
  if (evmFromAccountId(acc)) return acc
  return /^0x[0-9a-f]{64}$/i.test(acc) ? '0x45544800' + acc.slice(2, 42) + '0000000000000000' : null
}
// Money-market reserve EVM address → substrate asset id. Reserves are either the
// ERC20 precompile (0x…01 + 8-hex assetId) or a deployed token (e.g. HOLLAR).
// Money-market reserve contracts that aren't the standard ERC20 precompile (e.g.
// HOLLAR). Extend via EXPLORER_EXTRA_MM_CONTRACT_ASSET ({"0x…":<assetId>}) when a
// new market adds a deployed-token reserve.
function envContractAssetMap(): Record<string, number> {
  const raw = process.env.EXPLORER_EXTRA_MM_CONTRACT_ASSET?.trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(v)
      if (/^0x[0-9a-fA-F]{40}$/.test(k) && Number.isInteger(id)) out[k.toLowerCase()] = id
    }
    return out
  } catch {
    console.error('[Explorer] EXPLORER_EXTRA_MM_CONTRACT_ASSET is not valid JSON; ignoring')
    return {}
  }
}
const MM_CONTRACT_ASSET: Record<string, number> = { '0x531a654d1696ed52e7275a8cede955e82620f99a': 222, ...envContractAssetMap() }
function assetIdFromMmAddress(addr: string): number | null {
  const h = (addr ?? '').toLowerCase().replace(/^0x/, '')
  if (MM_CONTRACT_ASSET['0x' + h] != null) return MM_CONTRACT_ASSET['0x' + h]
  if (h.length === 40 && /^0{30}01/.test(h)) return parseInt(h.slice(32), 16)
  return null
}
export function mmReserveAddressForAsset(assetId: number): string[] {
  const reserveId = ATOKEN_UNDERLYING_ID[assetId] ?? assetId
  const standard = '0x' + '0'.repeat(30) + '01' + reserveId.toString(16).padStart(8, '0')
  const deployed = Object.entries(MM_CONTRACT_ASSET)
    .filter(([, id]) => id === reserveId)
    .map(([addr]) => addr)
  return [...new Set([standard, ...deployed])]
}
function mmAssetIdSql(expr: string): string {
  const addr = `lower(ifNull(${expr}, ''))`
  const h = `replaceRegexpOne(${addr}, '^0x', '')`
  const contractAddrs = Object.keys(MM_CONTRACT_ASSET).map(a => `'${a}'`)
  const contractIds = Object.values(MM_CONTRACT_ASSET).map(id => String(id))
  const fallback = `if(length(${h}) = 40 AND substring(${h}, 1, 32) = '00000000000000000000000000000001', reinterpretAsUInt32(reverse(unhex(substring(${h}, 33, 8)))), 0)`
  return contractAddrs.length
    ? `transform(${addr}, [${contractAddrs.join(',')}], [${contractIds.join(',')}], ${fallback})`
    : fallback
}
function mmAssetKnownSql(expr: string): string {
  const addr = `lower(ifNull(${expr}, ''))`
  const h = `replaceRegexpOne(${addr}, '^0x', '')`
  const contractAddrs = Object.keys(MM_CONTRACT_ASSET).map(a => `'${a}'`)
  const standard = `(length(${h}) = 40 AND substring(${h}, 1, 32) = '00000000000000000000000000000001')`
  return contractAddrs.length ? `(${addr} IN (${contractAddrs.join(',')}) OR ${standard})` : standard
}
// Resolve a tag's display icon for aggregate (SQL-grouped) rows: prefer the
// explicit icon from the DB row, else the icon the tagService derived (from the
// tag's first member's omniwatch emoji). Keeps grouped rows consistent with
// per-account tag display.
function tagIcon(tagId: string, dbIcon: string): string {
  if (dbIcon) return dbIcon
  return getTagRecord(tagId)?.icon || '🏷️'
}

// H160 → bound substrate account (EVMAccounts.Bound), refreshed periodically.
// Lets display refs resolve an ETH-prefixed AccountId32 back to the substrate
// account the user actually operates as — EVM is not primary for bound accounts.
let evmBindings = new Map<string, string>()
let evmBindingsRefreshTimer: ReturnType<typeof setInterval> | null = null
let evmBindingsInflight: Promise<void> | null = null

async function loadEvmBindingsUncached(): Promise<void> {
  const res = await client.query({
    query: `SELECT DISTINCT lower(evm_address) AS evm, lower(account_id) AS account_id
            FROM price_data.raw_account_aliases
            WHERE relationship = 'explicit_binding' AND alias_type = 'substrate_account_id'
              AND account_id != '' AND evm_address != ''`,
    format: 'JSONEachRow',
  })
  const m = new Map<string, string>()
  for (const r of await res.json<{ evm: string; account_id: string }>()) {
    if (ACCOUNT_RE.test(r.account_id) && !evmFromAccountId(r.account_id)) m.set(r.evm, r.account_id)
  }
  evmBindings = m
}

export function loadEvmBindings(): Promise<void> {
  if (evmBindingsInflight) return evmBindingsInflight
  const request = loadEvmBindingsUncached().finally(() => {
    if (evmBindingsInflight === request) evmBindingsInflight = null
  })
  evmBindingsInflight = request
  return request
}

export function startEvmBindingsRefresh(): void {
  if (evmBindingsRefreshTimer) return
  evmBindingsRefreshTimer = setInterval(() => { void loadEvmBindings().catch(() => {}) }, 10 * 60_000)
  evmBindingsRefreshTimer.unref()
}

// Canonical display identity for an account id: ETH-prefixed forms resolve to
// the real account they stand for — module/sovereign truncations to the padded
// substrate account, bound H160s to their substrate owner, and truncations of
// tagged derived accounts (e.g. a stableswap pool's EVM-side aToken holdings)
// to the pool account. Only genuine, unbound EVM accounts keep the ETH-prefixed
// id (and display their H160).
function resolveDisplayAccountId(accountId: string): string {
  const evm = evmFromAccountId(accountId)
  if (!evm) return accountId
  return reservedH160AccountId(evm.slice(2)) ?? evmBindings.get(evm) ?? taggedAccountByH160(evm) ?? accountId
}

export function accountRef(accountId: string): AccountRef {
  const resolved = resolveDisplayAccountId(accountId)
  const t = tagForAccount(resolved)
  // Display the EVM address for EVM accounts, otherwise the Polkadot SS58 (prefix 0);
  // the omniwatch icon is keyed by the Hydration form internally by accountIcon().
  const evm = evmFromAccountId(resolved)
  const id = identityForAccount(resolved)
  const icon = accountIcon(resolved)
  return {
    accountId: resolved,
    address: evm ?? polkadotAddress(resolved),
    emoji: icon.emoji,
    emojiName: icon.emojiName,
    emojiUrl: icon.emojiUrl,
    tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon } : null,
    identity: id,
  }
}

// DefiSim accepts a raw AccountId32 for native accounts and an H160 for genuine
// EVM accounts. Keep aggregate/tag targets in that exact form so the UI never
// has to guess from an opaque fallback string.
function defiSimTargetForAccountId(accountId: string): string {
  const ref = accountRef(accountId)
  return EVM_RE.test(ref.address) ? ref.address : ref.accountId
}

const ACCOUNT_RE = /^0x[0-9a-f]{64}$/
const EVM_RE = /^0x[0-9a-f]{40}$/
function sqlAccountList(accounts: string[]): string {
  const safe = accounts.filter(a => ACCOUNT_RE.test(a))
  return safe.length ? safe.map(a => `'${a}'`).join(',') : "''"
}
function sqlUIntList(values: Array<string | number>): string {
  const safe = [...new Set(values.map(v => String(v)).filter(v => /^\d+$/.test(v)))]
  return safe.length ? safe.join(',') : ''
}
function evmAccountIdFromAddress(evmAddress: string): string | null {
  return EVM_RE.test(evmAddress) ? '0x45544800' + evmAddress.slice(2) + '0000000000000000' : null
}

// The compact read models below fully cover history (their materialized views
// populate them for every raw range as it is ingested), so the request path
// reads them unconditionally. These two helpers centralize the model table
// names their callers embed in SQL.
function otcActivityTable(alias = ''): string {
  return `price_data.otc_activity${alias ? ` AS ${alias}` : ''} FINAL`
}
// Every XCM consumer collapses stable (block,event) identities while decoding.
// Avoid FINAL here: it disables primary-key pruning on this 55M-row replacing
// model and turns bounded block/asset lookups into multi-gigabyte partition
// merges during request handling.
function xcmEventActivityTable(alias = ''): string {
  return `price_data.xcm_event_activity${alias ? ` AS ${alias}` : ''}`
}

// Published only after a complete, count-checked generation of every current
// bare/farmed Omnipool NFT position has been written. Until then `/accounts`
// keeps its previous wallet/MM-only semantics instead of reading partial claims.
let omnipoolAccountClaimsReady = false
export function setOmnipoolAccountClaimsReady(): void { omnipoolAccountClaimsReady = true }

// Published only after a complete generation has combined every configured
// market's scaled reserve balances, latest indices, and aggregate risk state.
// Until then the directory retains its previous aggregate-position query.
let moneyMarketAccountValuesReady = false
export function setMoneyMarketAccountValuesReady(): void { moneyMarketAccountValuesReady = true }

// (block_height, event_index) IN-prefilter from the account-activity index. The
// surrounding query keeps its precise conditions — this only shrinks the scanned
// granule set, so a hit set that also passes the original WHERE is unchanged.
// Bounded newest-first: mirrors the callers' own newest-first LIMIT reads.
function accountActivityRefsSql(accountListSql: string, eventCond: string, bound: string, limit: number): string {
  return `(block_height, event_index) IN (
    SELECT block_height, event_index FROM price_data.account_activity
    WHERE account IN (${accountListSql}) AND ${bound}${eventCond ? ` AND ${eventCond}` : ''}
    GROUP BY block_height, event_index
    ORDER BY block_height DESC, event_index DESC
    LIMIT ${limit})`
}

// Unfiltered recent-first feeds only need the newest slice of history: bound the
// scan by block_height (primary-key prunable) and fall back to the full range
// only when the window returns fewer rows than the SQL asked for (sparse
// filters, deep offsets, end of data). Worst case = one cheap extra query on
// top of exactly what ran before.
const FEED_WINDOW_BLOCKS = 100_800 // ~7 days at 6s blocks
// A Hydration block targets roughly six seconds. Keep hot feed results for most
// of that interval so staggered clients share one ClickHouse read per block.
const LIVE_CACHE_MS = 5_000
// Keep candidate walks below the API client's 100k result-row guard. Sparse
// filters fail explicitly with 413 instead of leaking a ClickHouse 500 after a
// power-of-four widening step crosses the transport limit.
const MAX_ACTIVITY_SOURCE_ROWS = 90_000
function activityQueryTooBroad(): Error {
  return Object.assign(new Error('Requested activity page requires too many candidate rows; narrow the filters or date range'), {
    code: 'ACTIVITY_QUERY_TOO_BROAD',
    statusCode: 503,
  })
}
async function withFeedWindow<T>(tw: string | null, expectRows: number, depth: number, run: (bound: string) => Promise<T[]>): Promise<T[]> {
  if (tw) return run(tw)
  if (depth > 10_000) return run('1')
  const rows = await run(`block_height > (SELECT max(block_height) FROM price_data.raw_blocks) - ${FEED_WINDOW_BLOCKS}`)
  return rows.length >= expectRows ? rows : run('1')
}

// Full-data guarantee for POST-filtered feeds: a filter must never see only a
// recency window ("an hour of chain"). Pages walk backward through the whole
// history by block cursor; each page fetches up to `pageSize` candidate rows
// (newest-first) and keeps the ones `matches` accepts, until `want` filtered
// rows exist or history is exhausted. Rows must expose blockHeight (ActivityRow
// shape) for the cursor. Callers cache results, so the rare deep walk for a
// narrow filter is paid once per TTL.
export async function fetchFilteredDeep<T>(
  tw: string | null,
  want: number,
  run: (bound: string, pageLimit: number) => Promise<T[]>,
  matches: (t: T) => boolean,
  blockOf: (t: T) => number,
  eventOf: (t: T) => number,
  keyOf: (t: T) => string,
  opts: {
    pageSize?: number
    pageState?: () => { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null }
  } = {},
): Promise<T[]> {
  // Most callers already push token/value predicates into ClickHouse, so a
  // fixed 25k candidate page massively over-fetches for the usual 25-row UI
  // page (and makes every source in the merged activity scan deep history at
  // once).  Scale the first-class cursor page to the requested result count;
  // sparse post-filters still retain full-history semantics because the loop
  // keeps walking backwards until `want` matches have been collected.
  const initialPageSize = opts.pageSize ?? Math.min(Math.max(want * 2, 500), 25_000)
  // Grow sparse walks geometrically. Common filters stop after the cheap first
  // page; sparse filters continue until enough matches exist or history ends.
  const base = tw ?? '1'

  const out: T[] = []
  const seen = new Set<string>()
  let cursor: { blockHeight: number; eventIndex: number } | null = null
  for (let page = 0; ; page++) {
    // Walk the same descending (block,event) order used by every raw-event
    // source. A block-only inclusive cursor can repeat the first LIMIT rows
    // forever when one dense block straddles a page boundary.
    const bound = cursor == null
      ? base
      : `(${base}) AND (block_height < ${cursor.blockHeight} OR (block_height = ${cursor.blockHeight} AND event_index < ${cursor.eventIndex}))`
    const pageSize = Math.min(initialPageSize * 2 ** Math.min(page, 16), 25_000)
    const rows = await run(bound, pageSize)
    for (const r of rows) {
      const k = keyOf(r)
      if (seen.has(k)) continue
      seen.add(k)
      if (matches(r)) out.push(r)
    }
    const pageState = opts.pageState?.()
    if (out.length >= want || (pageState?.scanned ?? rows.length) < pageSize) break
    let next = pageState?.cursor ?? null
    if (!pageState) {
      for (const row of rows) {
        const candidate = { blockHeight: blockOf(row), eventIndex: eventOf(row) }
        if (!Number.isSafeInteger(candidate.blockHeight) || !Number.isSafeInteger(candidate.eventIndex)) continue
        if (next == null || candidate.blockHeight < next.blockHeight ||
          (candidate.blockHeight === next.blockHeight && candidate.eventIndex < next.eventIndex)) next = candidate
      }
    }
    if (next == null || (cursor != null &&
      (next.blockHeight > cursor.blockHeight ||
        (next.blockHeight === cursor.blockHeight && next.eventIndex >= cursor.eventIndex)))) break
    cursor = next
  }
  return out
}

export function activitySourceCoversCutoff(
  sourceSize: number,
  fetchSize: number,
  oldest: { blockHeight: number; eventIndex: number } | null,
  cutoff: { blockHeight: number; eventIndex?: number | null } | null,
): boolean {
  if (sourceSize < fetchSize) return true
  if (!oldest || !cutoff) return false
  return oldest.blockHeight < cutoff.blockHeight ||
    (oldest.blockHeight === cutoff.blockHeight && oldest.eventIndex <= (cutoff.eventIndex ?? -1))
}

export function activitySourcesNeedingMore<T extends {
  rawSize: number
  fetchSize: number
  oldest: { blockHeight: number; eventIndex: number } | null
  valueIrrelevant?: boolean
}>(
  sources: T[],
  cutoff: { blockHeight: number; eventIndex?: number | null } | null,
  skipValueIrrelevant: boolean,
): T[] {
  return sources.filter(source => {
    if (skipValueIrrelevant && source.valueIrrelevant) return false
    return cutoff
      ? !activitySourceCoversCutoff(source.rawSize, source.fetchSize, source.oldest, cutoff)
      : source.rawSize >= source.fetchSize
  })
}

export function completeActivityPageCutoff<T extends { blockHeight: number; eventIndex?: number | null }>(
  visibleRows: T[],
  want: number,
): T | null {
  return visibleRows.length >= want ? visibleRows[want - 1] ?? null : null
}

// Once one independently complete activity family supplies a merged-page
// cutoff, every other family only needs to prove coverage back to that point.
// Source readers accept day bounds rather than timestamps, so include the
// cutoff's entire UTC day (rows earlier on that day are harmless and make the
// boundary proof conservative). Preserve a caller's later explicit bound.
export function activityCutoffFromDate<T extends { timestamp: string }>(
  requestedFrom: string | undefined,
  cutoffRows: T[],
  want: number,
): string | undefined {
  if (cutoffRows.length < want) return requestedFrom
  const cutoffDay = cutoffRows[want - 1]?.timestamp.slice(0, 10)
  if (!cutoffDay || !/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay)) return requestedFrom
  return requestedFrom && requestedFrom > cutoffDay ? requestedFrom : cutoffDay
}

// Adjacent UI pages should reuse the same source-prefix cache whenever that
// prefix already proves the deeper merged cutoff. Power-of-two buckets keep
// page 1/2 (16 rows per family), page 3/4 (32), etc. on identical source keys.
export function activitySourceSeedSize(want: number): number {
  const target = Math.max(10, Math.ceil(want / 4))
  let bucket = 16
  while (bucket < target && bucket < MAX_ACTIVITY_SOURCE_ROWS) bucket *= 2
  return Math.min(bucket, MAX_ACTIVITY_SOURCE_ROWS)
}

export function accountTransferWindowSaturated(rawRows: number, rawLimit: number, olderIndexedRefs: boolean): boolean {
  return rawRows >= rawLimit || olderIndexedRefs
}

// Build a block_timestamp WHERE fragment for a day-range filter (YYYY-MM-DD).
// Returns null when no valid dates are given (callers then use the recent window).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function timeWindow(from?: string, to?: string): string | null {
  const parts: string[] = []
  if (from && DATE_RE.test(from)) parts.push(`block_timestamp >= '${from} 00:00:00'`)
  if (to && DATE_RE.test(to)) parts.push(`block_timestamp < '${to} 00:00:00' + INTERVAL 1 DAY`)
  return parts.length ? parts.join(' AND ') : null
}

export interface ExtrinsicListFilters { call?: string; result?: 'success' | 'failed'; origin?: 'signed' | 'proxy' | 'multisig' }
export interface EventListFilters { event?: string }
export interface ValueListFilters { token?: string; min?: number; unit?: 'usd' | 'token' }
export interface VoteListFilters { referendum?: string; conviction?: string }

function textNameFilter(field: string, paramPrefix: string): string {
  return `AND (
    ${field} = {${paramPrefix}:String}
    OR positionCaseInsensitive(${field}, {${paramPrefix}:String}) > 0
    OR positionCaseInsensitive(replaceAll(${field}, '.', ' '), {${paramPrefix}Visible:String}) > 0
    OR position(replaceRegexpAll(lowerUTF8(${field}), '[^0-9a-z]', ''), {${paramPrefix}Compact:String}) > 0
  )`
}
function textNameParams(paramPrefix: string, value?: string): Record<string, string> {
  const raw = value?.trim() ?? ''
  return {
    [paramPrefix]: raw,
    [`${paramPrefix}Visible`]: raw.replace(/\s*\.\s*/g, ' ').trim(),
    [`${paramPrefix}Compact`]: raw.toLowerCase().replace(/[^0-9a-z]+/g, ''),
  }
}

function filterKey(filters?: object): string {
  if (!filters) return ''
  return Object.entries(filters)
    .filter(([, v]) => v != null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&')
}

function assetIdsForToken(token?: string): number[] | undefined {
  const t = token?.trim()
  if (!t) return undefined
  const n = Number.parseInt(t, 10)
  const ids = allExplorerAssets()
    .filter(a => a.symbol.toLowerCase() === t.toLowerCase() || (Number.isInteger(n) && a.assetId === n))
    .map(a => a.assetId)
  return [...new Set(ids)]
}

function assetIdFilterSql(assetExpr: string, ids?: number[]): string {
  if (ids == null) return ''
  if (!ids.length) return 'AND 0'
  return `AND toUInt32(${assetExpr}) IN (${ids.join(',')})`
}
function eventAssetRefsFilterSql(ids: number[] | undefined, eventNamesSql: string, bound = '1'): string {
  if (ids == null) return ''
  if (!ids.length) return 'AND 0'
  return `AND (block_height, event_index) IN (
    SELECT block_height, event_index
    FROM price_data.event_asset_refs
    WHERE ${bound} AND asset_id IN (${ids.join(',')}) AND event_name IN (${eventNamesSql})
  )`
}
function currencyIdSql(args = 'args_json'): string {
  return `multiIf(
    JSONHas(${args}, 'currencyId'), JSONExtractInt(${args}, 'currencyId'),
    JSONHas(${args}, 'currency_id'), JSONExtractInt(${args}, 'currency_id'),
    JSONHas(${args}, 'assetId'), JSONExtractInt(${args}, 'assetId'),
    JSONHas(${args}, 'asset_id'), JSONExtractInt(${args}, 'asset_id'),
    0
  )`
}
// Module pots whose transfer legs are pure swap/fee plumbing on an ACCOUNT
// page (the trade/dca rows already represent the action): router hops, pool
// legs, fee sweeps. Other pallet pots — treasury (donations/funding), vesting
// payouts, LM reward claims — are the account's real value movements and stay
// visible. The GLOBAL transfer feed keeps its blanket module exclusion.
const NOISY_TRANSFER_POTS = [
  '0x6d6f646c726f7574657265780000000000000000000000000000000000000000', // routerex (swap hops)
  '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000', // omnipool (pool legs)
  '0x6d6f646c66656570726f632f0000000000000000000000000000000000000000', // feeproc/ (fee sweeps)
]
const noisyPotList = () => NOISY_TRANSFER_POTS.map(a => `'${a}'`).join(',')

// The treasury pot receives every extrinsic's transaction fee — and deposits such
// as a referral-code registration — as a Balances/Currencies transfer. Those are
// fees/deposits, not user transfers: a routed swap's fee leg is already dropped as
// trade noise, but non-swap fees/deposits (Referrals.register_code, XCM inherents
// like ParachainSystem.set_validation_data, plain batches) are not. So on a normal
// account's transfer feed a transfer *to* the treasury is surfaced only when its
// originating extrinsic is itself a token-transfer call (a genuine donation);
// payouts *from* the treasury stay visible.
const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const TRANSFER_CALL_NAMES = new Set([
  'Balances.transfer', 'Balances.transfer_keep_alive', 'Balances.transfer_all', 'Balances.transfer_allow_death',
  'Tokens.transfer', 'Tokens.transfer_all', 'Tokens.transfer_keep_alive',
  'Currencies.transfer', 'Currencies.transfer_native_currency',
  'XTokens.transfer', 'XTokens.transfer_multiasset', 'XTokens.transfer_multicurrencies',
  'XTokens.transfer_multiassets', 'XTokens.transfer_with_fee', 'XTokens.transfer_multiasset_with_fee',
])

// XCM sovereign / system accounts — sibling-parachain (`sibl`), sovereign
// parachain (`para`) and relay (`Parent`) — are bridge plumbing, never a user's
// own transfer. Distinct from the `modl` pallet pots, which include genuine
// payout sources such as the treasury.
const XCM_SOVEREIGN_PREFIXES = ['7369626c', '70617261', '506172656e74']

// Non-plumbing transfer-leg filter shared by user-facing surfaces: keep a leg
// only when NEITHER side is a pure-plumbing account — a noisy swap/fee pot
// (router/omnipool/feeproc), an XCM sovereign/system account, or an AMM pool /
// money-market reserve (`plumbingList`). Unlike the GLOBAL feed's blanket
// `0x6d6f646c…` module exclusion, this keeps genuine pallet-pot payouts
// (treasury funding, vesting, LM rewards) — the account's real value movements.
// Block activity, the superset that re-derives every /transfer detail link, must
// classify with this so a treasury payout shown on an account page also resolves
// on its own detail page.
export function nonPlumbingTransferLegSql(fromExpr: string, toExpr: string, plumbingList: string): string {
  const xcm = XCM_SOVEREIGN_PREFIXES.join('|')
  return `AND ${fromExpr} NOT IN (${noisyPotList()})
                AND ${toExpr} NOT IN (${noisyPotList()})
                AND NOT match(${fromExpr}, '^0x(${xcm})')
                AND NOT match(${toExpr}, '^0x(${xcm})')
                AND ${fromExpr} NOT IN (${plumbingList})
                AND ${toExpr} NOT IN (${plumbingList})`
}

// The `bind` CTE body shared by grouped rankings: ETH-prefixed rows standing
// for a real account map onto it — explicit EVMAccounts bindings plus
// truncations of TAGGED derived accounts (a stableswap pool's aToken pot must
// fold into the pool's row, not rank as its own "Stableswap Pool" lookalike).
// LIMIT 1 BY guards the join against a same-eth_id pair from both sources.
function bindCteSql(): string {
  const pairs = taggedTruncationPairs()
    .map(([h160, owner]) => `('0x45544800${h160.slice(2).toLowerCase()}0000000000000000', '${owner.toLowerCase()}')`)
  return `SELECT eth_id, owner FROM (
              SELECT DISTINCT concat('0x45544800', substring(lower(evm_address), 3, 40), '0000000000000000') AS eth_id,
                     lower(account_id) AS owner
              FROM price_data.raw_account_aliases
              WHERE relationship = 'explicit_binding' AND alias_type = 'substrate_account_id'
                AND account_id != '' AND evm_address != ''${pairs.length ? `
              UNION DISTINCT
              SELECT eth_id, owner FROM values('eth_id String, owner String', ${pairs.join(', ')})` : ''}
            ) ORDER BY eth_id LIMIT 1 BY eth_id`
}

// XYK.PoolCreated seeds a brand-new pool — a liquidity action in its own
// right ('Create'), not a pair of raw transfers to an unknown account.
function liqActionFor(eventName: string): 'Add' | 'Remove' | 'Create' | 'Claim' {
  if (eventName.endsWith('RewardClaimed')) return 'Claim'   // LM reward claims
  return eventName.endsWith('PoolCreated') ? 'Create' : eventName.endsWith('Removed') ? 'Remove' : 'Add'
}

// Enrich Create-pool activity rows with BOTH seed legs (the same-extrinsic
// transfers into the new pool account), so feeds show "A x + B y" like the
// extrinsic page — not just the first asset. Rows whose legs can't be found
// keep their single-leg display.
async function enrichPoolCreations(cands: { row: ActivityRow; pool: string; assetB: number }[]): Promise<void> {
  const usable = cands.filter(c => c.row.extrinsicIndex != null && c.pool && c.assetB >= 0)   // assetB 0 = HDX
  if (!usable.length) return
  const tuples = [...new Set(usable.map(c => `(${c.row.blockHeight},${c.row.extrinsicIndex})`))].join(',')
  const res = await client.query({
    query: `SELECT block_height, extrinsic_index,
              if(event_name = 'Balances.Transfer', 0, JSONExtractInt(args_json,'currencyId')) AS asset_id,
              JSONExtractString(args_json,'to') AS to_acc,
              JSONExtractString(args_json,'amount') AS amount
            FROM price_data.raw_events
            WHERE (block_height, extrinsic_index) IN (${tuples})
              AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')`,
    format: 'JSONEachRow',
  })
  const legByKey = new Map<string, string>()
  for (const t of await res.json<{ block_height: number; extrinsic_index: number; asset_id: number; to_acc: string; amount: string }>()) {
    if (t.amount) legByKey.set(`${t.block_height}:${t.extrinsic_index}:${t.asset_id}:${t.to_acc.toLowerCase()}`, t.amount)
  }
  // Combined value at block time. Pool creation is a two-leg action, so an
  // incomplete leg or price leaves the value unknown instead of showing a
  // plausible-looking partial/current value.
  for (const c of cands) c.row.valueUsd = null
  const closes = await historicalCloses(usable.flatMap(c => c.row.asset
    ? [{ assetId: c.row.asset.assetId, ts: c.row.timestamp }, { assetId: c.assetB, ts: c.row.timestamp }]
    : []))
  for (const c of usable) {
    const a = c.row.asset
    if (!a) continue
    const aB = asset(c.assetB)
    const key = (assetId: number) => `${c.row.blockHeight}:${c.row.extrinsicIndex}:${assetId}:${c.pool.toLowerCase()}`
    const amountA = legByKey.get(key(a.assetId)) ?? c.row.amount
    const amountB = legByKey.get(key(c.assetB))
    c.row.assetIn = a
    c.row.assetOut = aB
    c.row.amountIn = amountA
    c.row.amountOut = amountB ?? null
    c.row.amount = amountA
    const closeA = closes.get(historicalPriceKey(a.assetId, c.row.timestamp))
    const closeB = closes.get(historicalPriceKey(aB.assetId, c.row.timestamp))
    const legs = [
      exactUsdLeg(amountA, a.decimals, closeA),
      exactUsdLeg(amountB, aB.decimals, closeB),
    ]
    if (legs.every((leg): leg is ExactUsdLeg => leg != null)) {
      exactHistoricalValues.set(c.row, legs)
      c.row.valueUsd = legs.reduce((sum, leg) => sum + Number(leg.raw) / 10 ** leg.decimals * Number(leg.closeRaw), 0)
    }
  }
}

function transferAssetIdSql(args = 'args_json'): string {
  return `if(event_name = 'Balances.Transfer', 0, ${currencyIdSql(args)})`
}
// Liquidity events reference assets in several shapes: Omnipool `assetId`, XYK
// `assetA`+`assetB`, Stableswap `poolId` + a nested `assets:[{assetId,…}]` array.
// Match the selected ids against ALL of them — a single-field check misses XYK's
// second leg and every Stableswap underlying (e.g. HOLLAR sits in that array).
function liquidityAssetMatchExpr(idsCsv: string, args = 'args_json'): string {
  return `(JSONExtractInt(${args},'assetId') IN (${idsCsv})
    OR JSONExtractInt(${args},'assetA') IN (${idsCsv})
    OR JSONExtractInt(${args},'assetB') IN (${idsCsv})
    OR JSONExtractInt(${args},'poolId') IN (${idsCsv})
    OR hasAny(arrayMap(e -> JSONExtractInt(e,'assetId'), JSONExtractArrayRaw(${args},'assets')), [${idsCsv}]))`
}
function liquidityTokenFilterSql(ids?: number[], args = 'args_json'): string {
  if (ids == null) return ''
  if (!ids.length) return 'AND 0'
  return `AND ${liquidityAssetMatchExpr(ids.join(','), args)}`
}

const UINT256_MAX = (1n << 256n) - 1n

function decimalFraction(value: string | number): { numerator: bigint; denominator: bigint } {
  const input = String(value).trim()
  const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input)
  if (!match) throw new Error(`Invalid non-negative decimal: ${input}`)
  const fraction = match[2] ?? ''
  const exponent = Number(match[3] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) throw new Error(`Decimal exponent out of range: ${input}`)
  let numerator = BigInt(`${match[1]}${fraction}`)
  const scale = fraction.length - exponent
  if (scale <= 0) {
    numerator *= 10n ** BigInt(-scale)
    return { numerator, denominator: 1n }
  }
  return { numerator, denominator: 10n ** BigInt(scale) }
}

/** Smallest raw-unit integer whose value is at least the requested threshold. */
export function minimumRawAmountForValue(minValue: string | number, unitValue: string | number, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('decimals must be an integer from 0 to 255')
  const min = decimalFraction(minValue)
  const unit = decimalFraction(unitValue)
  if (unit.numerator === 0n) return null
  if (min.numerator === 0n) return 0n
  const numerator = min.numerator * unit.denominator * 10n ** BigInt(decimals)
  const denominator = min.denominator * unit.numerator
  return (numerator + denominator - 1n) / denominator
}

export interface RawValueThreshold { assetId: number; amount: string }

function valueThresholds(prices: Map<number, PriceInfo>, minValue: number, unit: 'usd' | 'token'): RawValueThreshold[] {
  const thresholds: RawValueThreshold[] = []
  for (const a of allExplorerAssets()) {
    const price = prices.get(a.assetId)
    const unitValue = unit === 'token' ? '1' : price?.priceRaw ?? (price && price.price > 0 ? String(price.price) : '0')
    const amount = minimumRawAmountForValue(minValue, unitValue, a.decimals)
    if (amount != null && amount <= UINT256_MAX) thresholds.push({ assetId: a.assetId, amount: amount.toString() })
  }
  return thresholds
}

export function exactValuePredicateSql(
  assetExpr: string,
  rawAmountExpr: string,
  thresholds: RawValueThreshold[],
  options: { amountIsUInt256?: boolean; hasAmountExpr?: string } = {},
): string {
  if (!thresholds.length) return '0'
  const ids = thresholds.map(t => t.assetId).join(',')
  const amounts = thresholds.map(t => `'${t.amount}'`).join(',')
  const asset = `toUInt32(${assetExpr})`
  const amount = options.amountIsUInt256 ? `toUInt256(${rawAmountExpr})` : `toUInt256OrZero(${rawAmountExpr})`
  const hasAmount = options.hasAmountExpr ?? `notEmpty(toString(${rawAmountExpr}))`
  return `(${hasAmount} AND ${asset} IN (${ids}) AND ${amount} >= toUInt256(transform(${asset}, [${ids}], [${amounts}], '0')))`
}

const HISTORICAL_PRICE_SCALE = 1_000_000_000_000n

interface HistoricalRawValueThreshold { assetId: number; numerator: string }

function historicalValueThresholds(minValue: number): { thresholds: HistoricalRawValueThreshold[]; denominator: string } {
  const min = decimalFraction(minValue)
  const thresholds: HistoricalRawValueThreshold[] = []
  for (const a of allExplorerAssets()) {
    const numerator = min.numerator * HISTORICAL_PRICE_SCALE * 10n ** BigInt(a.decimals)
    if (numerator <= UINT256_MAX) thresholds.push({ assetId: a.assetId, numerator: numerator.toString() })
  }
  return { thresholds, denominator: min.denominator.toString() }
}

/** Exact UInt256 comparison against a row's Decimal128(12) historical close. */
export function exactHistoricalValuePredicateSql(
  assetExpr: string,
  rawAmountExpr: string,
  closeExpr: string,
  thresholds: HistoricalRawValueThreshold[],
  minDenominator: string,
  options: { amountIsUInt256?: boolean; hasAmountExpr?: string } = {},
): string {
  if (!thresholds.length) return '0'
  const ids = thresholds.map(t => t.assetId).join(',')
  const denominatorValue = BigInt(minDenominator)
  const calculable = thresholds.filter(t => denominatorValue <= BigInt(t.numerator))
  const oneRawUnit = thresholds.filter(t => BigInt(t.numerator) > 0n && denominatorValue > BigInt(t.numerator))
  const zeroThreshold = thresholds.filter(t => BigInt(t.numerator) === 0n)
  const asset = `toUInt32(${assetExpr})`
  const amount = options.amountIsUInt256 ? `toUInt256(${rawAmountExpr})` : `toUInt256OrZero(${rawAmountExpr})`
  const hasAmount = options.hasAmountExpr ?? `notEmpty(toString(${rawAmountExpr}))`
  const priceAtoms = `toUInt256(${closeExpr} * toDecimal128('1000000000000', 0))`
  const branches: string[] = []
  if (zeroThreshold.length) branches.push(`(${asset} IN (${zeroThreshold.map(t => t.assetId).join(',')}) AND ${amount} >= toUInt256(0))`)
  if (oneRawUnit.length) branches.push(`(${asset} IN (${oneRawUnit.map(t => t.assetId).join(',')}) AND ${amount} >= toUInt256(1))`)
  if (calculable.length) {
    const calcIds = calculable.map(t => t.assetId).join(',')
    const numerators = calculable.map(t => `'${t.numerator}'`).join(',')
    const numerator = `toUInt256(transform(${asset}, [${calcIds}], [${numerators}], '0'))`
    const denominator = `toUInt256('${minDenominator}')`
    const quotient = `intDivOrZero(${numerator}, ${denominator})`
    const remainder = `moduloOrZero(${numerator}, ${denominator})`
    const threshold = `(intDivOrZero(${quotient}, ${priceAtoms}) + toUInt256(${remainder} != 0 OR moduloOrZero(${quotient}, ${priceAtoms}) != 0))`
    branches.push(`(${asset} IN (${calcIds}) AND ${amount} >= ${threshold})`)
  }
  return `(${hasAmount} AND ${asset} IN (${ids}) AND ${closeExpr} > 0 AND ${priceAtoms} > 0 AND (${branches.join(' OR ') || '0'}))`
}

function historicalClosesRelationSql(): string {
  const priceIds = [...new Set(allExplorerAssets().flatMap(a => [a.assetId, historicalPriceAssetId(a.assetId)]))].join(',')
  // Hash ASOF requires a left/right equi-key even when the valued asset is a
  // constant (HDX votes and referral claims). The timestamp-derived key below
  // is 1 for every non-null event timestamp and leaves the price match unchanged.
  return `(SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close,
                  toUInt8(1) AS asof_join_key
           FROM price_data.ohlc_1h
           WHERE asset_id IN (${priceIds || '0'})
           GROUP BY asset_id, interval_start)`
}

export interface EventValueFilterSql { joinSql: string; predicateSql: string }

export function eventValueFilterSql(
  assetExpr: string,
  rawAmountExpr: string,
  timestampExpr: string,
  filters: ValueListFilters | undefined,
  prices: Map<number, PriceInfo>,
  alias: string,
  options: { amountIsUInt256?: boolean; hasAmountExpr?: string } = {},
): EventValueFilterSql {
  if (filters?.min == null) return { joinSql: '', predicateSql: '' }
  if (filters.unit === 'token') {
    const thresholds = valueThresholds(prices, filters.min, 'token')
    return { joinSql: '', predicateSql: `AND ${exactValuePredicateSql(assetExpr, rawAmountExpr, thresholds, options)}` }
  }
  const { thresholds, denominator } = historicalValueThresholds(filters.min)
  return {
    joinSql: `ASOF LEFT JOIN ${historicalClosesRelationSql()} ${alias}
              ON ${alias}.asof_join_key = toUInt8(isNotNull(${timestampExpr}))
             AND ${alias}.asset_id = ${priceAliasIdSql(assetExpr)}
             AND ${alias}.price_time <= ${timestampExpr}`,
    predicateSql: `AND ${exactHistoricalValuePredicateSql(assetExpr, rawAmountExpr, `${alias}.close`, thresholds, denominator, options)}`,
  }
}

// USD price map
// Latest + 24h-ago USD price per asset from the bounded recent window (avoids a
// full scan of the 485M-row prices table). Cached 30s in memory.
export interface PriceInfo { price: number; change24h: number; priceRaw?: string }
let priceMap = new Map<number, PriceInfo>()
let priceLoadedAt = 0
let priceRefreshInflight: Promise<Map<number, PriceInfo>> | null = null
// Account directory/detail values share one pinned price generation. It advances
// atomically with the five-minute MM account-value generation, preventing two
// adjacent page requests from straddling the general 30-second price refresh.
let accountValuePriceMap = new Map<number, PriceInfo>()
let accountValueGenerationEpoch = 0

// `prices` contains one row per asset per block, so asking it for max(block_height)
// scans the entire table. The much smaller `blocks` table advances atomically with
// the price rows and provides the same head for bounded price reads.
async function latestPriceBlock(): Promise<number> {
  return cached('explorer:price-head', 5_000, async () => {
    const res = await client.query({
      query: `SELECT max(block_height) AS head FROM price_data.blocks`,
      format: 'JSONEachRow',
    })
    return Number((await res.json<{ head: number | null }>())[0]?.head ?? 0)
  })
}

// "24h"/"7d"-style windows were historically fixed block-count offsets that
// assumed a constant block time (12s, later 6s), so `head - 7200` was taken to
// mean "24h ago". The chain now produces ~5.6s blocks, so those offsets cover
// far LESS wall-clock than their names imply (7200 blocks ≈ 11h, not 24h).
// These helpers resolve a cutoff HEIGHT from a wall-clock window via the blocks
// table, keeping the reading queries height-predicated — so the
// (asset_id, block_height) / block_height sort keys still prune the scan —
// while the window means an actual span of time.

// SQL returning the lowest block_height produced within the last `hours`
// (NULL / 0 rows when the table is empty). Kept pure so a unit test can assert
// the INTERVAL literal without a live ClickHouse.
export function cutoffWindowSql(hours: number): string {
  return `SELECT min(block_height) AS h FROM price_data.blocks WHERE block_timestamp >= now() - INTERVAL ${Math.max(1, Math.round(hours))} HOUR`
}

// Fallback cutoff when the blocks table can't answer (empty/error): assume 6s
// blocks (600/hour), which reproduces the exact pre-fix constant (24h → head −
// 14400, 7d → head − 100800) so behaviour degrades to the old windows.
export function fallbackCutoffHeight(head: number, hours: number): number {
  return Math.max(0, head - Math.round(hours * 600))
}

// Resolve the block height that was the chain head `hours` ago. Cached briefly:
// it advances slowly relative to a 24h/7d window and is read on hot paths, and a
// timer-driven refresher should resolve it once per pass rather than per asset.
export async function cutoffHeightForWindow(hours: number, head: number): Promise<number> {
  return cached(`explorer:cutoff:${hours}`, 30_000, async () => {
    try {
      const res = await client.query({ query: cutoffWindowSql(hours), format: 'JSONEachRow' })
      const h = Number((await res.json<{ h: number | null }>())[0]?.h ?? 0)
      if (h > 0) return h
    } catch { /* fall through to the 6s-block estimate */ }
    return fallbackCutoffHeight(head, hours)
  })
}

export async function ensurePrices(): Promise<Map<number, PriceInfo>> {
  if (priceMap.size && Date.now() - priceLoadedAt < 30_000) return priceMap
  // Single-flight: ensurePrices is on the hot path of nearly every endpoint, so
  // when the TTL lapses under load, concurrent requests share one in-flight
  // refresh rather than each firing its own and stampeding ClickHouse. The
  // stale map is served meanwhile (only a cold start ever waits).
  priceRefreshInflight ??= refreshPrices().finally(() => { priceRefreshInflight = null })
  return priceMap.size ? priceMap : priceRefreshInflight
}

async function loadFreshPrices(): Promise<Map<number, PriceInfo>> {
  priceRefreshInflight ??= refreshPrices().finally(() => { priceRefreshInflight = null })
  return priceRefreshInflight
}

async function ensureAccountValuePrices(): Promise<Map<number, PriceInfo>> {
  if (!accountValuePriceMap.size) accountValuePriceMap = new Map(await loadFreshPrices())
  return accountValuePriceMap
}
async function refreshPrices(): Promise<Map<number, PriceInfo>> {
  try {
    const head = await latestPriceBlock()
    if (!head) return priceMap
    // Timestamp-derived cutoffs so "24h"/"7d" track wall-clock as block time
    // drifts (~5.6s now). Resolved once per refresh, not per asset.
    const [dayStart, weekStart, cut72] = await Promise.all([
      cutoffHeightForWindow(24, head),
      cutoffHeightForWindow(168, head),
      cutoffHeightForWindow(72, head),
    ])
    // The fallback "price then" window is a block SPAN relative to each asset's
    // own latest tick (the ~24h→72h band before it), so express both edges as
    // the real block count spanning those windows at the current rate.
    const span24h = Math.max(1, head - dayStart)
    const span72h = Math.max(1, head - cut72)
    const res = await client.query({
      query: `
        SELECT asset_id,
          toString(argMax(usd_price, block_height)) AS price_raw,
          toString(argMin(usd_price, block_height)) AS price_then_raw
        FROM price_data.prices
        WHERE block_height > {dayStart:UInt32} AND usd_price > 0
        GROUP BY asset_id`,
      query_params: { dayStart },
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ asset_id: number; price_raw: string; price_then_raw: string }>()
    const m = new Map<number, PriceInfo>()
    for (const r of rows) {
      const price = Number(r.price_raw)
      const priceThen = Number(r.price_then_raw)
      const change = priceThen > 0 ? (price - priceThen) / priceThen : 0
      if (Number.isFinite(price) && price > 0) m.set(r.asset_id, { price, priceRaw: r.price_raw, change24h: change })
    }
    // Some low-activity assets (e.g. PEN) have a valid recent price history, but
    // their latest tick can sit outside the narrow live-price window above. Fill
    // only missing registry assets from a bounded 7d window, computing the change
    // against roughly 24h before that asset's own latest tick.
    const missing = allExplorerAssets().map(a => a.assetId).filter(id => !m.has(id))
    if (missing.length) {
      // Both scan legs are bounded by (asset_id IN …, block_height > head − 7d),
      // allowing the (asset_id, block_height) primary key to prune the scan.
      const fbRes = await client.query({
        query: `
          WITH latest AS (
            SELECT asset_id, max(block_height) AS latest_block,
              argMax(usd_price, block_height) AS price
            FROM price_data.prices
            WHERE block_height > {weekStart:UInt32}
              AND usd_price > 0 AND asset_id IN ({ids:Array(UInt32)})
            GROUP BY asset_id
          )
          SELECT p.asset_id AS asset_id, any(l.latest_block) AS latest_block,
            toString(any(l.price)) AS price_raw,
            toString(argMaxIf(p.usd_price, p.block_height,
              p.block_height <= l.latest_block - {span24h:UInt32} AND p.block_height > l.latest_block - {span72h:UInt32})) AS price_then_raw
          FROM price_data.prices p
          INNER JOIN latest l ON l.asset_id = p.asset_id
          WHERE p.asset_id IN ({ids:Array(UInt32)}) AND p.block_height > {weekStart:UInt32} AND p.usd_price > 0
          GROUP BY p.asset_id`,
        query_params: { ids: missing, weekStart, span24h, span72h }, format: 'JSONEachRow',
      })
      for (const r of await fbRes.json<{ asset_id: number; price_raw: string; price_then_raw: string }>()) {
        const price = Number(r.price_raw)
        const priceThen = Number(r.price_then_raw)
        const change = priceThen > 0 ? (price - priceThen) / priceThen : 0
        if (Number.isFinite(price) && price > 0) m.set(r.asset_id, { price, priceRaw: r.price_raw, change24h: change })
      }
    }
    // aTokens carry no price feed — alias each to its priced underlying (resolved
    // TRANSITIVELY: GIGAHDX → stHDX → HDX) so every value/volume computation that
    // reads this map values them 1:1.
    for (const aToken of Object.keys(PRICE_ALIAS_ID)) {
      const u = m.get(priceAssetId(Number(aToken)))
      if (u && !m.has(Number(aToken))) m.set(Number(aToken), u)
    }
    // Replace the 1:1 underlying-proxy price of pool-SHARE tokens with their true
    // per-share NAV (Σ reserve×price / issuance). Done after the alias loop so the
    // reserves (including aTokens) are already priced. A pool we can't fully price
    // keeps the proxy. See loadStableswapNav.
    for (const [shareId, navPerShare] of await loadStableswapNav(m)) {
      m.set(shareId, { price: navPerShare, priceRaw: String(navPerShare), change24h: m.get(shareId)?.change24h ?? 0 })
    }
    priceMap = m
    priceLoadedAt = Date.now()
  } catch { /* serve stale on error */ }
  return priceMap
}
function usdValue(prices: Map<number, PriceInfo>, assetId: number, raw: string, decimals: number): number | null {
  const p = prices.get(assetId)
  if (!p) return null
  const amt = Number(raw) / 10 ** decimals
  return Number.isFinite(amt) ? amt * p.price : null
}
function priceTransformArrays(prices: Map<number, PriceInfo>): { idsSql: string; unitsSql: string } {
  const ids: string[] = []
  const units: string[] = []
  for (const a of allExplorerAssets()) {
    const p = prices.get(a.assetId)
    if (p && p.price > 0) {
      ids.push(`'${a.assetId}'`)
      units.push((p.price / 10 ** a.decimals).toExponential())
    }
  }
  return {
    idsSql: ids.length ? '[' + ids.join(',') + ']' : "['']",
    unitsSql: units.length ? '[' + units.join(',') + ']' : '[0.]',
  }
}

// historical (block-time) valuation
// A flow (trade, transfer, liquidation) is worth what it was worth WHEN it
// happened, so we value its raw amount at the latest completed hourly close,
// never the current price or a close later in the event's hour. The per-block
// price table (price_data.prices)
// would be exact, but an ASOF join against it loads every price tick in the
// events' block span — and majors tick every block, so a whale trading across
// the whole chain would pull tens of millions of rows. The pre-aggregated
// hourly close is one row per asset/hour, so the joined side stays bounded.

// Pool-share assets have no historical NAV series. A current reserve snapshot
// is not a valid substitute for an old flow, so historical valuation leaves
// them unpriced. Other aliases are contractual 1:1 claims (aTokens and bonds).
function historicalPriceAssetId(assetId: number): number {
  return SHARE_TOKEN_UNDERLYING_ID[assetId] == null ? priceAssetId(assetId) : assetId
}

// SQL: map an asset-id expression to the id whose historical price feed values
// it. Share tokens remain unpriced because they need a historical NAV series.
function priceAliasIdSql(expr: string): string {
  const from = Object.keys(PRICE_ALIAS_ID).filter(k => SHARE_TOKEN_UNDERLYING_ID[Number(k)] == null)
  // transform() applies once — resolve chained aliases (GIGAHDX → stHDX → HDX)
  // to their terminal priced id here.
  const to = from.map(k => priceAssetId(Number(k)))
  if (!from.length) return `toUInt32(${expr})`
  return `transform(toUInt32(${expr}), [${from.join(',')}], [${to.join(',')}], toUInt32(${expr}))`
}

function rawAmountNormalizationSql(expr: string, targetDecimals: number): string {
  const assets = allExplorerAssets().filter(a => a.decimals <= targetDecimals)
  const ids = assets.map(a => a.assetId)
  const factors = assets.map(a => `'${10n ** BigInt(targetDecimals - a.decimals)}'`)
  const fallback = 10n ** BigInt(targetDecimals - 12)
  return `toDecimal256(transform(toUInt32(${expr}), [${ids.join(',') || '0'}], [${factors.join(',') || "'1'"}], '${fallback}'), 0)`
}

// SQL fragment valuing a CTE of event legs at their block-time price, emitted as
// the CTE `${outName}` (account_id, volume_usd). `legsCte` must expose
// (account_id, asset_id, block_time, amount) rows — block_time is the event's
// wall-clock time, ASOF-matched to the last completed hourly close. The joined
// close is bounded to the priced-asset universe (a static list, so the — often
// expensive — legs CTE is referenced only once).
export function historicalVolumeSql(legsCte: string, outName: string): string {
  const priceIds = [...new Set(allExplorerAssets().flatMap(a => [a.assetId, historicalPriceAssetId(a.assetId)]))].join(',')
  const maxDecimals = Math.max(12, ...allExplorerAssets().map(a => a.decimals))
  if (maxDecimals > 65) throw new Error(`Historical volume does not support asset decimals above 65 (found ${maxDecimals})`)
  // Decimal256 is ClickHouse's widest overflow-checking fixed-point type. An
  // unrepresentable leg fails the query explicitly; it must never wrap or be
  // coerced to zero in an account ranking.
  const normalizedAmount = `multiplyDecimal(toDecimal256(l.amount, 0), ${rawAmountNormalizationSql('l.asset_id', maxDecimals)}, 0)`
  const exactValue = `multiplyDecimal(${normalizedAmount}, toDecimal256(p.close, 12), 12)`
  return `
            ${outName} AS (
              SELECT l.account_id AS account_id,
                     toFloat64(sum(${exactValue})) / 1e${maxDecimals} AS volume_usd
              FROM ${legsCte} l
              ASOF LEFT JOIN (
                SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
                FROM price_data.ohlc_1h
                WHERE asset_id IN (${priceIds || '0'})
                GROUP BY asset_id, interval_start
              ) p ON p.asset_id = ${priceAliasIdSql('l.asset_id')} AND p.price_time <= l.block_time
              WHERE match(l.account_id, '^0x[0-9a-f]{64}$')
                AND NOT match(l.account_id, '^0x(6d6f646c|7369626c|70617261)')
              GROUP BY account_id
            )`
}

// A displayed flow (a past trade/transfer/liquidation amount shown with its USD
// value) should carry the value it had WHEN it happened, not now. Given a list
// of rows that each expose an event timestamp + an asset + a raw amount, this
// batch-fetches the last completed hourly close and rewrites its valueUsd. One
// extra query is issued per page. Rows without a valid historical price get
// null rather than a current-price substitute.
function normalizeTs(ts: string): string {
  return ts.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '').trim()
}
export function historicalPriceHour(ts: string): string {
  const normalized = normalizeTs(ts)
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)
    ? `${normalized.slice(0, 13)}:00:00`
    : normalized
}
function historicalPriceKey(assetId: number, ts: string): string {
  return `${historicalPriceAssetId(assetId)}|${normalizeTs(ts)}`
}

// Completed hourly closes are immutable. Candidate walkers repeatedly value
// different events from the same asset/hour; retaining a bounded process cache
// avoids reopening the full aggregate price table for those identical lookups.
const HISTORICAL_CLOSE_CACHE_LIMIT = 50_000
const historicalCloseByHour = new Map<string, string | null>()
function cacheHistoricalClose(key: string, close: string | null): void {
  if (historicalCloseByHour.has(key)) historicalCloseByHour.delete(key)
  historicalCloseByHour.set(key, close)
  while (historicalCloseByHour.size > HISTORICAL_CLOSE_CACHE_LIMIT) {
    const oldest = historicalCloseByHour.keys().next().value as string | undefined
    if (oldest == null) break
    historicalCloseByHour.delete(oldest)
  }
}

async function historicalCloses(pairs: { assetId: number; ts: string }[]): Promise<Map<string, string>> {
  const requested = new Map<string, { priceId: number; hour: string; hourKey: string }>()
  const missingHours = new Map<string, { priceId: number; ts: string }>()
  for (const p of pairs) {
    const priceId = historicalPriceAssetId(p.assetId)
    const ts = normalizeTs(p.ts)
    const hour = historicalPriceHour(ts)
    const hourKey = `${priceId}|${hour}`
    requested.set(`${priceId}|${ts}`, { priceId, hour, hourKey })
    if (!historicalCloseByHour.has(hourKey)) missingHours.set(hourKey, { priceId, ts: hour })
  }
  if (!requested.size) return new Map()
  const out = new Map<string, string>()
  const values = [...missingHours.values()]
  // Candidate widening can value several thousand rows at once. Keep tuple SQL
  // comfortably below ClickHouse's max_query_size. Events in one asset/hour
  // share the same completed close, so the tuple list is hour-deduplicated.
  for (let start = 0; start < values.length; start += 2_000) {
    const batch = values.slice(start, start + 2_000)
    const priceIds = [...new Set(batch.map(p => p.priceId))]
    const tuples = batch.map(p => `(${p.priceId},'${p.ts}')`).join(',')
    const res = await client.query({
      query: `
        SELECT ev.asset_id AS asset_id, ev.ts AS ts, toString(p.close) AS close
        FROM (
          SELECT toUInt32(tupleElement(pr, 1)) AS asset_id, tupleElement(pr, 2) AS ts
          FROM (SELECT arrayJoin([${tuples}]) AS pr)
        ) ev
        ASOF LEFT JOIN (
          SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
          FROM price_data.ohlc_1h
          WHERE asset_id IN (${priceIds.join(',')})
          GROUP BY asset_id, interval_start
        ) p ON p.asset_id = ev.asset_id AND p.price_time <= toDateTime(ev.ts)`,
      format: 'JSONEachRow',
    })
    for (const r of await res.json<{ asset_id: number; ts: string; close: string }>()) {
      const key = `${r.asset_id}|${r.ts}`
      cacheHistoricalClose(key, Number(r.close) > 0 ? r.close : null)
    }
  }
  for (const [key, request] of requested) {
    const close = historicalCloseByHour.get(request.hourKey)
    if (close) out.set(key, close)
  }
  return out
}

interface ExactUsdLeg { raw: bigint; decimals: number; priceAtoms: bigint; closeRaw: string }
const exactHistoricalValues = new WeakMap<object, ExactUsdLeg[]>()

function exactUsdLeg(raw: string | null | undefined, decimals: number, closeRaw: string | undefined): ExactUsdLeg | null {
  if (!raw || !/^\d+$/.test(raw) || !closeRaw) return null
  const close = decimalFraction(closeRaw)
  const scaled = close.numerator * HISTORICAL_PRICE_SCALE
  if (scaled % close.denominator !== 0n) return null
  const priceAtoms = scaled / close.denominator
  if (priceAtoms <= 0n) return null
  return { raw: BigInt(raw), decimals, priceAtoms, closeRaw }
}

function exactUsdMeetsMinimum(legs: ExactUsdLeg[], minimum: number): boolean {
  if (!legs.length) return false
  const maxDecimals = Math.max(...legs.map(leg => leg.decimals))
  const valueNumerator = legs.reduce(
    (sum, leg) => sum + leg.raw * leg.priceAtoms * 10n ** BigInt(maxDecimals - leg.decimals),
    0n,
  )
  const valueDenominator = HISTORICAL_PRICE_SCALE * 10n ** BigInt(maxDecimals)
  const threshold = decimalFraction(minimum)
  return valueNumerator * threshold.denominator >= threshold.numerator * valueDenominator
}
// valueUsd basis pickers per row shape: a trade/activity is valued on its OUT leg
// (the asset received), a transfer/liquidity/mm flow on the moved asset.
type HistPick = { assetId: number; decimals: number; raw: string; ts: string } | null
function activityHistPick(r: ActivityRow): HistPick {
  // Create-pool rows already carry their combined BLOCK-TIME value (both seed
  // legs — see enrichPoolCreations); a single-asset repricing would clobber it.
  if (r.type === 'liquidity' && r.liqAction === 'Create') return null
  if (r.assetOut && r.amountOut != null) return { assetId: r.assetOut.assetId, decimals: r.assetOut.decimals, raw: r.amountOut, ts: r.timestamp }
  if (r.asset && r.amount != null) return { assetId: r.asset.assetId, decimals: r.asset.decimals, raw: r.amount, ts: r.timestamp }
  return null
}
function tradeHistPick(r: TradeRow): HistPick {
  return { assetId: r.assetOut.assetId, decimals: r.assetOut.decimals, raw: r.amountOut, ts: r.timestamp }
}
function transferHistPick(r: TransferRow): HistPick {
  return { assetId: r.asset.assetId, decimals: r.asset.decimals, raw: r.amount, ts: r.timestamp }
}
// Rewrite each row's valueUsd to its block-time value. `pick` returns the asset
// + raw amount that valueUsd represents (the OUT leg of a trade, the moved asset
// of a transfer, …) and the row's timestamp, or null to leave the row untouched.
async function applyHistoricalUsd<T>(rows: T[], pick: (r: T) => { assetId: number; decimals: number; raw: string; ts: string } | null): Promise<void> {
  const picks = rows.map(pick)
  const pairs = picks.filter((p): p is NonNullable<typeof p> => p != null).map(p => ({ assetId: p.assetId, ts: p.ts }))
  if (!pairs.length) return
  const closes = await historicalCloses(pairs)
  rows.forEach((r, i) => {
    const p = picks[i]
    if (!p) return
    const close = closes.get(historicalPriceKey(p.assetId, p.ts))
    const leg = exactUsdLeg(p.raw, p.decimals, close)
    if (typeof r === 'object' && r != null) {
      if (leg) exactHistoricalValues.set(r, [leg])
      else exactHistoricalValues.delete(r)
    }
    const amt = Number(p.raw) / 10 ** p.decimals
    ;(r as { valueUsd: number | null }).valueUsd = leg != null && Number.isFinite(amt) ? amt * Number(leg.closeRaw) : null
  })
}

function rowMeetsExactUsdMinimum(row: object & { valueUsd: number | null }, minimum: number): boolean {
  const exact = exactHistoricalValues.get(row)
  if (exact) return exactUsdMeetsMinimum(exact, minimum)
  return row.valueUsd != null && Number.isFinite(row.valueUsd) && row.valueUsd >= minimum
}

// stableswap share-token NAV pricing
// A pool-share token (2-Pool-apyUSD, GIGA GDOT/GETH/GSOL, the stable n-Pools, …)
// is worth its slice of the pool's reserves, NOT one unit of a "main underlying".
// We compute the market NAV per share
//     navPerShare = Σ(reserve_i × usdPrice_i) / totalIssuance
// from the latest per-block stableswap snapshot. The on-chain `peg_multipliers`
// scale only the internal trading curve and are deliberately NOT applied to a
// reserve-value NAV. Reserve prices come from the already-aliased price map
// (aTokens resolved to their underlying); a pool whose
// reserves we can't fully price is skipped so the caller keeps the 1:1 proxy.
interface SnapshotPool { pool_id: number; assets: string | number[]; reserves: string[]; total_issuance: string }
function parsePoolAssets(assets: string | number[]): number[] {
  if (Array.isArray(assets)) return assets.map(Number)
  // Compact form: a hex byte-string, one byte per asset id (only used for ids ≤ 255).
  const h = assets.startsWith('0x') ? assets.slice(2) : assets
  const out: number[] = []
  for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16))
  return out
}
let navMap = new Map<number, number>()
let navLoadedAt = 0
async function loadStableswapNav(prices: Map<number, PriceInfo>): Promise<Map<number, number>> {
  if (navMap.size && Date.now() - navLoadedAt < 30_000) return navMap
  try {
    const res = await client.query({
      query: `SELECT JSONExtractRaw(payload_json, 'stableswap') AS ss
              FROM price_data.raw_block_snapshots
              WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots)
              LIMIT 1`,
      format: 'JSONEachRow',
    })
    const row = (await res.json<{ ss: string }>())[0]
    const pools = (safeJson(row?.ss) as { pools?: SnapshotPool[] } | null)?.pools ?? []
    const m = new Map<number, number>()
    for (const pool of pools) {
      const ids = parsePoolAssets(pool.assets)
      const reserves = pool.reserves ?? []
      if (!ids.length || ids.length !== reserves.length) continue
      let nav = 0, ok = true
      for (let i = 0; i < ids.length; i++) {
        const px = prices.get(ids[i])?.price
        if (px == null) { ok = false; break }
        nav += (Number(reserves[i]) / 10 ** asset(ids[i]).decimals) * px
      }
      // navPerShare must be USD per whole share, so scale issuance by the share
      // token's own decimals (its asset id == pool_id).
      const issuance = Number(pool.total_issuance) / 10 ** asset(pool.pool_id).decimals
      if (ok && issuance > 0 && Number.isFinite(nav)) m.set(pool.pool_id, nav / issuance)
    }
    if (m.size) { navMap = m; navLoadedAt = Date.now() }
  } catch { /* keep last good NAV map */ }
  return navMap
}

// overview
export interface ExplorerStats {
  headBlock: number
  finalizedBlock: number
  headTime: string
  avgBlockSec: number
  transfers24h: number
  extrinsics24h: number
  activeAccounts24h: number
  hdxPrice: number | null
}

export async function getStats(): Promise<ExplorerStats> {
  return cached('explorer:stats', 3000, async () => {
    // Wall-clock 24h cutoff height (blocks now run ~5.6s, so the old head−7200
    // covered only ~11h). The counts read replayable ReplacingMergeTree raw
    // tables, so they dedup by row identity: a replay before the next merge
    // would otherwise double-count events/extrinsics.
    const cutoff24h = await cutoffHeightForWindow(24, await latestPriceBlock())
    const [mainRes, prices] = await Promise.all([
      client.query({
        query: `
          WITH (SELECT max(block_height) FROM price_data.raw_blocks) AS head
          SELECT
            toUInt64(head) AS head_block,
            (SELECT toString(max(block_timestamp)) FROM price_data.raw_blocks WHERE block_height = head) AS head_time,
            (SELECT toFloat64(dateDiff('second', min(block_timestamp), max(block_timestamp)) / greatest(count() - 1, 1))
               FROM (SELECT block_timestamp FROM price_data.raw_blocks ORDER BY block_height DESC LIMIT 100)) AS avg_block,
            toUInt64((SELECT uniqExact((block_height, event_index)) FROM price_data.raw_events
               WHERE block_height > {cutoff24h:UInt32} AND event_name IN ('Balances.Transfer','Tokens.Transfer'))) AS transfers_24h,
            toUInt64((SELECT uniqExact((block_height, extrinsic_index)) FROM price_data.raw_extrinsics
               WHERE block_height > {cutoff24h:UInt32} AND coalesce(signer, effective_signer) IS NOT NULL)) AS extrinsics_24h,
            toUInt64((SELECT uniqExact(account_id) FROM price_data.raw_balance_observations
               WHERE block_height > {cutoff24h:UInt32})) AS active_accounts_24h
        `,
        query_params: { cutoff24h },
        format: 'JSONEachRow',
      }),
      ensurePrices(),
    ])
    const row = (await mainRes.json<{ head_block: string; head_time: string; avg_block: number; transfers_24h: string; extrinsics_24h: string; active_accounts_24h: string }>())[0]
    const head = Number(row?.head_block ?? 0)
    return {
      headBlock: head,
      finalizedBlock: Math.max(0, head - 2),
      headTime: row?.head_time ?? '',
      avgBlockSec: Number(row?.avg_block ?? 0),
      transfers24h: Number(row?.transfers_24h ?? 0),
      extrinsics24h: Number(row?.extrinsics_24h ?? 0),
      activeAccounts24h: Number(row?.active_accounts_24h ?? 0),
      hdxPrice: prices.get(0)?.price ?? null,
    }
  })
}

// recent blocks
export interface BlockSummary {
  height: number
  timestamp: string
  hash: string
  author: AccountRef | null
  specVersion: number
  extrinsicCount: number
  eventCount: number
}

export async function getRecentBlocks(limit: number, offset = 0): Promise<BlockSummary[]> {
  return cached(`explorer:blocks:${limit}:${offset}`, LIVE_CACHE_MS, async () => {
    const blocksRes = await client.query({
      query: `
        SELECT block_height, toString(block_timestamp) AS ts, block_hash, author, spec_version
        FROM price_data.raw_blocks
        ORDER BY block_height DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { limit, offset },
      format: 'JSONEachRow',
    })
    const blocks = await blocksRes.json<{ block_height: number; ts: string; block_hash: string; author: string | null; spec_version: number }>()
    if (!blocks.length) return []
    const heights = blocks.map(b => b.block_height)
    const minH = Math.min(...heights)
    const maxH = Math.max(...heights)
    const [extRes, evRes] = await Promise.all([
      client.query({
        query: `SELECT block_height, count() AS c FROM price_data.raw_extrinsics
                WHERE block_height >= {min:UInt32} AND block_height <= {max:UInt32} GROUP BY block_height`,
        query_params: { min: minH, max: maxH }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT block_height, count() AS c FROM price_data.raw_events
                WHERE block_height >= {min:UInt32} AND block_height <= {max:UInt32} GROUP BY block_height`,
        query_params: { min: minH, max: maxH }, format: 'JSONEachRow',
      }),
    ])
    const extCounts = new Map<number, number>()
    for (const r of await extRes.json<{ block_height: number; c: string }>()) extCounts.set(r.block_height, Number(r.c))
    const evCounts = new Map<number, number>()
    for (const r of await evRes.json<{ block_height: number; c: string }>()) evCounts.set(r.block_height, Number(r.c))
    return blocks.map(b => ({
      height: b.block_height,
      timestamp: b.ts,
      hash: b.block_hash,
      author: b.author ? accountRef(b.author) : null,
      specVersion: b.spec_version,
      extrinsicCount: extCounts.get(b.block_height) ?? 0,
      eventCount: evCounts.get(b.block_height) ?? 0,
    }))
  })
}

// single block
export interface ExtrinsicOrigin {
  kind: 'proxy' | 'multisig'
  state?: 'pending' | 'executed' | 'cancelled'
  threshold?: number
  signatories?: number
  approvals?: number
  callHash?: string
}
export interface ExtrinsicSummary {
  blockHeight: number
  index: number
  hash: string
  timestamp: string
  signer: AccountRef | null
  success: boolean
  callName: string
  fee: string | null
  origin?: ExtrinsicOrigin
}
interface ExtrinsicSummaryRow {
  block_height: number
  extrinsic_index: number
  extrinsic_hash: string
  ts: string
  signer: string | null
  success: number
  call_name: string
  fee: string | null
  display_call_name?: string
  display_success?: number | null
  origin_kind?: string
  ms_state?: string
  ms_threshold?: number
  ms_signatories?: number
  ms_approvals?: number
  ms_call_hash?: string
}

function extrinsicSummary(row: ExtrinsicSummaryRow): ExtrinsicSummary {
  const summary: ExtrinsicSummary = {
    blockHeight: row.block_height,
    index: row.extrinsic_index,
    hash: row.extrinsic_hash,
    timestamp: row.ts,
    signer: row.signer ? accountRef(row.signer) : null,
    success: row.display_success != null ? row.display_success === 1 : row.success === 1,
    callName: row.display_call_name || row.call_name,
    fee: row.fee,
  }
  if (row.origin_kind === 'proxy') {
    summary.origin = { kind: 'proxy' }
  } else if (row.origin_kind === 'multisig') {
    summary.origin = {
      kind: 'multisig',
      state: (row.ms_state as ExtrinsicOrigin['state']) ?? 'executed',
      threshold: row.ms_threshold || undefined,
      signatories: row.ms_signatories || undefined,
      approvals: row.ms_approvals || undefined,
      callHash: row.ms_call_hash || undefined,
    }
  }
  return summary
}

function uniqueExtrinsicSummaries(rows: ExtrinsicSummaryRow[]): ExtrinsicSummary[] {
  const seen = new Set<string>()
  return rows.flatMap(row => {
    const key = `${row.block_height}:${row.extrinsic_index}`
    if (seen.has(key)) return []
    seen.add(key)
    return [extrinsicSummary(row)]
  })
}
export interface BlockEvent { eventIndex: number; extrinsicIndex: number | null; name: string; args: unknown }
export interface BlockDetail extends BlockSummary {
  parentHash: string
  stateRoot: string | null
  extrinsicsRoot: string | null
  extrinsics: ExtrinsicSummary[]
  events: BlockEvent[]
}

export async function getBlock(height: number): Promise<BlockDetail | null> {
  return cached(`explorer:block:${height}`, 10000, async () => {
    const [blockRes, extRes, evRes, evListRes] = await Promise.all([
      client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, block_hash, parent_hash, state_root, extrinsics_root, author, spec_version
                FROM price_data.raw_blocks WHERE block_height = {h:UInt32} LIMIT 1`,
        query_params: { h: height }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, coalesce(signer, effective_signer) AS signer, success, call_name, fee
                FROM price_data.raw_extrinsics WHERE block_height = {h:UInt32} ORDER BY extrinsic_index`,
        query_params: { h: height }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT count() AS c FROM price_data.raw_events WHERE block_height = {h:UInt32}`,
        query_params: { h: height }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT event_index, extrinsic_index, event_name, args_json
                FROM price_data.raw_events WHERE block_height = {h:UInt32} ORDER BY event_index LIMIT 400`,
        query_params: { h: height }, format: 'JSONEachRow',
      }),
    ])
    const block = (await blockRes.json<{ block_height: number; ts: string; block_hash: string; parent_hash: string; state_root: string | null; extrinsics_root: string | null; author: string | null; spec_version: number }>())[0]
    if (!block) return null
    const exts = await extRes.json<{ extrinsic_index: number; extrinsic_hash: string; ts: string; signer: string | null; success: number; call_name: string; fee: string | null }>()
    const eventCount = Number((await evRes.json<{ c: string }>())[0]?.c ?? 0)
    const evSeen = new Set<number>()
    const events: BlockEvent[] = (await evListRes.json<{ event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }>())
      .filter(r => (evSeen.has(r.event_index) ? false : (evSeen.add(r.event_index), true)))
      .map(r => ({ eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index, name: r.event_name, args: safeJson(r.args_json) }))
    // De-dup replay rows by extrinsic_index.
    const seen = new Set<number>()
    const extrinsics: ExtrinsicSummary[] = []
    for (const e of exts) {
      if (seen.has(e.extrinsic_index)) continue
      seen.add(e.extrinsic_index)
      extrinsics.push({
        blockHeight: block.block_height,
        index: e.extrinsic_index,
        hash: e.extrinsic_hash,
        timestamp: e.ts,
        signer: e.signer ? accountRef(e.signer) : null,
        success: e.success === 1,
        callName: e.call_name,
        fee: e.fee,
      })
    }
    return {
      height: block.block_height,
      timestamp: block.ts,
      hash: block.block_hash,
      parentHash: block.parent_hash,
      stateRoot: block.state_root,
      extrinsicsRoot: block.extrinsics_root,
      author: block.author ? accountRef(block.author) : null,
      specVersion: block.spec_version,
      extrinsicCount: extrinsics.length,
      eventCount,
      extrinsics,
      events,
    }
  })
}

// recent extrinsics
export async function getRecentExtrinsics(limit: number, signedOnly: boolean, from?: string, to?: string, offset = 0, filters: ExtrinsicListFilters = {}): Promise<ExtrinsicSummary[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:extrinsics:${limit}:${offset}:${signedOnly}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const callFilter = filters.call?.trim() ? textNameFilter('call_name', 'callName') : ''
    const resultFilter = filters.result === 'success' ? 'AND success = 1' : filters.result === 'failed' ? 'AND success = 0' : ''
    const rows = await withFeedWindow(tw, limit, offset + limit, async (bound) => {
      const res = await client.query({
        query: `
          SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, coalesce(signer, effective_signer) AS signer, success, call_name, fee
          FROM price_data.raw_extrinsics
          WHERE ${bound}
            ${signedOnly ? 'AND coalesce(signer, effective_signer) IS NOT NULL' : ''}
            ${callFilter}
            ${resultFilter}
          ORDER BY block_height DESC, extrinsic_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset, ...textNameParams('callName', filters.call) }, format: 'JSONEachRow',
      })
      return res.json<ExtrinsicSummaryRow>()
    })
    return uniqueExtrinsicSummaries(rows)
  })
}

// single extrinsic
export interface ExtrinsicDetail extends ExtrinsicSummary {
  version: number
  tip: string | null
  callArgs: unknown
  error: unknown
  events: { eventIndex: number; name: string; args: unknown }[]
}

interface ExtrinsicDetailRow {
  block_height: number
  extrinsic_index: number
  extrinsic_hash: string
  ts: string
  version: number
  signer: string | null
  success: number
  call_name: string
  fee: string | null
  tip: string | null
  call_args_json: string
  error_json: string | null
}

async function hydrateExtrinsicDetail(row: ExtrinsicDetailRow): Promise<ExtrinsicDetail> {
  const eventResult = await client.query({
    query: `SELECT event_index, event_name, args_json FROM price_data.raw_events
            WHERE block_height = {height:UInt32} AND extrinsic_index = {index:UInt32} ORDER BY event_index`,
    query_params: { height: row.block_height, index: row.extrinsic_index },
    format: 'JSONEachRow',
  })
  const eventRows = await eventResult.json<{ event_index: number; event_name: string; args_json: string }>()
  const seen = new Set<number>()
  const events: ExtrinsicDetail['events'] = []
  for (const event of eventRows) {
    if (seen.has(event.event_index)) continue
    seen.add(event.event_index)
    events.push({ eventIndex: event.event_index, name: event.event_name, args: safeJson(event.args_json) })
  }

  return {
    blockHeight: row.block_height,
    index: row.extrinsic_index,
    hash: row.extrinsic_hash,
    timestamp: row.ts,
    signer: row.signer ? accountRef(row.signer) : null,
    success: row.success === 1,
    callName: row.call_name,
    fee: row.fee,
    version: row.version,
    tip: row.tip,
    callArgs: safeJson(row.call_args_json),
    error: row.error_json ? safeJson(row.error_json) : null,
    events,
  }
}

export async function getExtrinsic(hash: string): Promise<ExtrinsicDetail | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
  return cached(`explorer:extrinsic:${hash.toLowerCase()}`, 10000, async () => {
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, version, coalesce(signer, effective_signer) AS signer, success, call_name, fee, tip, call_args_json, error_json
              FROM price_data.raw_extrinsics WHERE extrinsic_hash = {hash:String} ORDER BY block_height DESC LIMIT 1`,
      query_params: { hash: hash.toLowerCase() }, format: 'JSONEachRow',
    })
    const row = (await res.json<ExtrinsicDetailRow>())[0]
    return row ? hydrateExtrinsicDetail(row) : null
  })
}

// recent transfers
export interface TransferRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  from: AccountRef
  to: AccountRef
  amount: string
  asset: AssetRef
  valueUsd: number | null
}

interface RawTransferEventRow {
  block_height: number
  ts: string
  event_index: number
  extrinsic_index: number | null
  event_name: string
  from_acc: string
  to_acc: string
  amount: string
  asset_id: number
}

function transferEventPriority(name: string): number {
  if (name === 'Currencies.Transferred') return 3
  if (name === 'Tokens.Transfer') return 2
  return 1
}

function dedupeTransferEvents<T extends RawTransferEventRow>(rows: T[]): T[] {
  const maxPriority = new Map<string, number>()
  for (const r of rows) {
    const key = `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${r.from_acc.toLowerCase()}|${r.to_acc.toLowerCase()}|${r.amount}`
    const p = transferEventPriority(r.event_name)
    if (p > (maxPriority.get(key) ?? 0)) maxPriority.set(key, p)
  }
  return rows.filter(r => {
    const key = `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${r.from_acc.toLowerCase()}|${r.to_acc.toLowerCase()}|${r.amount}`
    return transferEventPriority(r.event_name) === maxPriority.get(key)
  })
}

// Money-market protocol accounts (aToken/vDebt/pool contracts) in truncated-
// account form: the counterparties of supply/withdraw/borrow/repay token legs.
// Derived from the same reserve map that feeds the "Supply & Borrow" tag, so
// newly listed reserves are covered automatically.
async function mmReserveAccountIds(): Promise<Set<string>> {
  const tokens = await getMmReserveTokens()
  const out = new Set<string>()
  for (const t of tokens) {
    for (const h160 of [t.aToken, t.vDebt, t.poolProxy]) {
      if (/^0x[0-9a-fA-F]{40}$/.test(h160)) out.add('0x45544800' + h160.slice(2).toLowerCase() + '0000000000000000')
    }
  }
  return out
}

// Truncated-account form of EVERY indexed money-market contract (aToken, variable-
// debt token, pool proxy) across ALL markets — not just the configured ones
// getMmReserveTokens filters to. A supply/withdraw/borrow/repay leg's counterparty
// is one of these; suppressing them keeps an MM leg from being mislabeled a
// transfer marker (its value change is the position curve, represented elsewhere).
// Reads the same atoken_reserve_map the reserve reconstruction uses; cached.
async function mmContractAccountIds(): Promise<Set<string>> {
  return cached('explorer:mm-contract-accounts', 60_000, async () => {
    const res = await client.query({
      query: `SELECT DISTINCT lower(c) AS h160 FROM (
                SELECT arrayJoin([atoken, vdebt, pool_proxy]) AS c FROM price_data.atoken_reserve_map FINAL
              ) WHERE match(h160, '^0x[0-9a-f]{40}$')`,
      format: 'JSONEachRow',
    })
    const out = new Set<string>()
    for (const r of await res.json<{ h160: string }>()) out.add('0x45544800' + r.h160.slice(2) + '0000000000000000')
    return out
  })
}

// An asset the value reconstruction cannot price on the wallet curve (share
// tokens have no historical NAV feed — they're valued via LP decomposition, not
// a token close). A swap only MOVES reconstructed value when it trades into such
// an asset; a swap between two priced assets is value-neutral churn.
function isUnpricedAsset(assetId: number): boolean {
  return SHARE_TOKEN_UNDERLYING_ID[assetId] != null
}

async function moneyMarketExtrinsicsForTransfers(rows: TransferRow[]): Promise<Set<string>> {
  const pairs = [...new Set(rows
    .filter(r => r.extrinsicIndex != null)
    .map(r => `(${r.blockHeight},${r.extrinsicIndex})`))]
  if (!pairs.length) return new Set()
  const res = await client.query({
    query: `
      SELECT e.block_height, e.extrinsic_index
      FROM price_data.raw_events e
      INNER JOIN price_data.raw_money_market_events m
        ON m.block_height = e.block_height AND m.event_index = e.event_index
      WHERE (e.block_height, e.extrinsic_index) IN (${pairs.join(',')})
        AND m.event_name IN ('Supply','Borrow','Repay','Withdraw','LiquidationCall')
        AND lower(ifNull(m.pool_address, '')) IN (${configuredMmPoolsSql()})
        AND m.user_address NOT LIKE '0x6d6f646c%'
      GROUP BY e.block_height, e.extrinsic_index`,
    format: 'JSONEachRow',
  })
  const mm = new Set<string>()
  for (const r of await res.json<{ block_height: number; extrinsic_index: number | null }>()) {
    if (r.extrinsic_index != null) mm.add(`${r.block_height}:${r.extrinsic_index}`)
  }
  return mm
}

async function getRecentTransfers(limit: number, from?: string, to?: string, offset = 0, userOnly = false, filters: ValueListFilters = {}, suppressMoneyMarket = false): Promise<TransferRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:transfers:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${userOnly}:${filterKey(filters)}:${suppressMoneyMarket}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const useAssetTransferReadModel = tokenIds != null
    const useTimeTransferReadModel = tokenIds == null
    const useTransferReadModel = useAssetTransferReadModel || useTimeTransferReadModel
    const transferTable = useAssetTransferReadModel ? 'transfer_activity' : 'transfer_activity_by_time'
    const assetExpr = useTransferReadModel ? 'asset_id' : transferAssetIdSql()
    const amountExpr = useTransferReadModel ? 'amount' : `JSONExtractString(args_json, 'amount')`
    const tokenFilter = assetIdFilterSql(assetExpr, tokenIds)
    const tokenRefsFilter = useTransferReadModel ? '' : eventAssetRefsFilterSql(tokenIds, `'Balances.Transfer','Tokens.Transfer','Currencies.Transferred'`)
    const postUsdFilter = filters.min != null && filters.unit !== 'token'
    const amountFilter = eventValueFilterSql(assetExpr, amountExpr, 'block_timestamp',
      postUsdFilter ? { ...filters, min: undefined, unit: undefined } : filters, prices, 'transfer_price')
    // userOnly drops pallet/pool/fee legs (module accounts 0x6d6f646c…) so the
    // Activity's "Transfers" tab shows genuine user↔user transfers, not swap noise.
    const plumbing = [...ammPoolAccounts(), ...(await mmReserveAccountIds())]
    const plumbingList = plumbing.length ? plumbing.map(a => `'${a}'`).join(',') : "''"
    const userFilter = userOnly && useTransferReadModel
      ? `AND NOT match(from_account, '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND NOT match(to_account, '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND from_account NOT IN (${plumbingList})
         AND to_account NOT IN (${plumbingList})`
      : userOnly
      ? `AND NOT match(JSONExtractString(args_json,'from'), '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND NOT match(JSONExtractString(args_json,'to'), '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND JSONExtractString(args_json,'from') NOT IN (${plumbingList})
         AND JSONExtractString(args_json,'to') NOT IN (${plumbingList})`
      : ''
    const want = offset + limit
    const scanLimit = suppressMoneyMarket ? Math.max(want * 4, limit + 250) : limit
    const scanOffset = suppressMoneyMarket ? 0 : offset
    const buildTransferRows = async (rawRows: RawTransferEventRow[]): Promise<TransferRow[]> => {
      const raw = dedupeTransferEvents(rawRows)
      const seen = new Set<string>()
      const out: TransferRow[] = []
      for (const r of raw) {
        const key = `${r.block_height}:${r.event_index}`
        if (seen.has(key)) continue
        seen.add(key)
        const a = asset(r.asset_id)
        out.push({
          blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          from: accountRef(r.from_acc), to: accountRef(r.to_acc), amount: r.amount, asset: a,
          valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
        })
      }
      await applyHistoricalUsd(out, transferHistPick)
      return out
    }
    const fetchPage = async (bound: string, pageLimit: number, pageOffset: number): Promise<TransferRow[]> => {
      const res = await client.query({
        query: `
          SELECT block_height, ts, event_index, extrinsic_index,
            event_name,
            from_acc, to_acc, amount, asset_id
          FROM
          (
            SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index,
              event_name,
              ${useTransferReadModel ? 'from_account' : "JSONExtractString(args_json, 'from')"} AS from_acc,
              ${useTransferReadModel ? 'to_account' : "JSONExtractString(args_json, 'to')"} AS to_acc,
              ${amountExpr} AS amount,
              ${assetExpr} AS asset_id,
              multiIf(event_name = 'Currencies.Transferred', 3, event_name = 'Tokens.Transfer', 2, 1) AS priority
            FROM price_data.${useTransferReadModel ? transferTable : 'raw_events'}
            ${amountFilter.joinSql}
            WHERE ${bound}
              ${useTransferReadModel ? '' : "AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')"}
              ${userFilter}
              ${tokenRefsFilter}
              ${tokenFilter}
              ${amountFilter.predicateSql}
            ORDER BY block_height DESC, priority DESC, event_index DESC
            LIMIT 1 BY block_height, extrinsic_index, asset_id, lower(from_acc), lower(to_acc), amount
          )
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      return buildTransferRows(await res.json<RawTransferEventRow>())
    }
    if (postUsdFilter) {
      let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
      const fetchValuePage = async (bound: string, pageLimit: number): Promise<TransferRow[]> => {
        const runRaw = async (rawBound: string, rawLimit: number): Promise<RawTransferEventRow[]> => {
          const res = await client.query({
            query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                      ${useTransferReadModel ? 'from_account' : "JSONExtractString(args_json, 'from')"} AS from_acc,
                      ${useTransferReadModel ? 'to_account' : "JSONExtractString(args_json, 'to')"} AS to_acc,
                      ${amountExpr} AS amount, ${assetExpr} AS asset_id
                    FROM price_data.${useTransferReadModel ? transferTable : 'raw_events'}
                    ${amountFilter.joinSql}
                    WHERE ${rawBound}
                      ${useTransferReadModel ? '' : "AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')"}
                      ${userFilter} ${tokenRefsFilter} ${tokenFilter} ${amountFilter.predicateSql}
                    ORDER BY block_height DESC, event_index DESC
                    LIMIT {limit:UInt32}`,
            query_params: { limit: rawLimit }, format: 'JSONEachRow',
          })
          return res.json<RawTransferEventRow>()
        }
        let raw = await runRaw(bound, pageLimit)
        pageState = {
          scanned: raw.length,
          cursor: raw.length ? { blockHeight: raw.at(-1)!.block_height, eventIndex: raw.at(-1)!.event_index } : null,
        }
        // Complete the boundary block before collapsing pallet mirror events;
        // otherwise a LIMIT split could keep a lower-priority mirror on one
        // page and its canonical Currencies.Transferred sibling on the next.
        if (raw.length >= pageLimit) {
          const boundary = raw.at(-1)!.block_height
          const boundaryRows = await runRaw(`(${tw ?? '1'}) AND block_height = ${boundary}`, 25_000)
          const byEvent = new Map(raw.map(row => [`${row.block_height}:${row.event_index}`, row]))
          for (const row of boundaryRows) byEvent.set(`${row.block_height}:${row.event_index}`, row)
          raw = [...byEvent.values()].sort((left, right) =>
            right.block_height - left.block_height || right.event_index - left.event_index)
          pageState.cursor = { blockHeight: boundary, eventIndex: 0 }
        }
        return buildTransferRows(raw)
      }
      const deep = await fetchFilteredDeep(tw, want,
        fetchValuePage,
        row => rowMeetsExactUsdMinimum(row, filters.min!),
        row => row.blockHeight, row => row.eventIndex,
        row => `${row.blockHeight}:${row.eventIndex}`,
        { pageSize: 25_000, pageState: () => pageState })
      return deep.slice(offset, offset + limit)
    }
    const out = await withFeedWindow(tw, scanLimit, scanOffset + scanLimit,
      bound => fetchPage(bound, scanLimit, scanOffset))
    if (suppressMoneyMarket) {
      const mmExtrinsics = await moneyMarketExtrinsicsForTransfers(out)
      const filtered = out.filter(t => !(t.extrinsicIndex != null && mmExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)))
      if (filtered.length < want && out.length >= scanLimit) throw activityQueryTooBroad()
      return filtered.slice(offset, offset + limit)
    }
    return out
  })
}

// holders (grouped by label)
export interface HolderRow {
  rank: number
  account: AccountRef | null                 // null when this is a multi-account tag group
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  balance: string
  lastBlock: number
  valueUsd?: number | null
  share?: number                             // fraction of the asset's total held USD
}

export interface HoldersPage { asset: AssetRef; holders: HolderRow[]; total: number; totalUsd: number }

// Paginated holder list. `limit`/`offset` page the full set (no hard cap), and
// `total`/`totalUsd` describe the whole holder base regardless of the page so the
// UI can show the true count, per-holder share, and a pager.
export async function getHolders(assetId: number, limit: number, offset = 0): Promise<HoldersPage> {
  const a = asset(assetId)
  const enrichShare = (rows: HolderRow[], prices: Map<number, PriceInfo>, totalUsd: number): HolderRow[] => rows.map(h => {
    const valueUsd = usdValue(prices, assetId, h.balance, a.decimals)
    return { ...h, valueUsd, share: totalUsd > 0 ? (valueUsd ?? 0) / totalUsd : 0 }
  })

  // Giga/display assets are backed by hidden stableswap-share ids (GDOT←690,
  // GETH←4200, …). Their economic holder list combines direct display/share
  // balances and replaces each money-market aToken custody row with its actual
  // suppliers; otherwise the visible asset has zero holders or names the vault.
  const foldedShareIds = Object.entries(SHARE_TOKEN_UNDERLYING_ID)
    .filter(([, displayId]) => displayId === assetId)
    .map(([shareId]) => Number(shareId))
  if (foldedShareIds.length) {
    return cached(`explorer:holders:${assetId}:${limit}:${offset}`, 30000, async () => {
      const prices = await ensurePrices()
      const all = await getFoldedDisplayAssetHolders(assetId, foldedShareIds)
      const totalRaw = all.reduce((sum, row) => sum + BigInt(row.balance), 0n)
      const totalUsd = usdValue(prices, assetId, totalRaw.toString(), a.decimals) ?? 0
      const page = all.slice(offset, limit > 0 ? offset + limit : all.length)
        .map((holder, index) => ({ ...holder, rank: offset + index + 1 }))
      return { asset: a, holders: enrichShare(page, prices, totalUsd), total: all.length, totalUsd }
    })
  }

  // aTokens never hit substrate balances — their true holders are the money-market
  // suppliers reconstructed from indexed anchors and event deltas. Those
  // sets are small, so fetch all and page in memory.
  if (ATOKEN_UNDERLYING_ID[assetId] != null) {
    return cached(`explorer:holders:${assetId}:${limit}:${offset}`, 30000, async () => {
      const prices = await ensurePrices()
      const all = await getATokenHolders(assetId, 1_000_000)
      const totalUsd = all.reduce((s, h) => s + (usdValue(prices, assetId, h.balance, a.decimals) ?? 0), 0)
      const page = all.slice(offset, limit > 0 ? offset + limit : all.length)
        .map((h, i) => ({ ...h, rank: offset + i + 1 }))
      return { asset: a, holders: enrichShare(page, prices, totalUsd), total: all.length, totalUsd }
    })
  }
  return cached(`explorer:holders:${assetId}:${limit}:${offset}`, 30000, async () => {
    const prices = await ensurePrices()
    const res = await client.query({
      query: `
        WITH
          tags AS (
            SELECT account_id, any(label_id) AS label_id, any(label_name) AS label_name, any(color) AS color, any(icon) AS icon
            FROM price_data.account_tags FINAL WHERE deleted = 0 GROUP BY account_id
          ),
          latest_raw AS (
            SELECT
              account_id,
              toUInt256OrZero(argMaxMerge(total_state)) AS latest_bal,
              maxMerge(last_block_state) AS latest_block
            FROM price_data.account_asset_latest_balances
            WHERE asset_id = {asset:String}
            GROUP BY account_id
          ),
          bind AS (
            ${bindCteSql()}
          ),
          latest AS (
            -- Holder pages must reflect current state. The latest-balance aggregate
            -- is refreshed by full RPC balance snapshots; falling back to an older
            -- non-zero observation resurrects accounts that now hold zero.
            -- ETH-prefixed rows standing for a real account (module/sovereign
            -- truncations, bound H160s) are remapped onto it, like the accounts list.
            SELECT
              coalesce(b.owner, if(
                substring(l.account_id, 3, 8) = '45544800' AND substring(l.account_id, 11, 8) IN ('6d6f646c', '7369626c', '70617261'),
                concat('0x', substring(l.account_id, 11, 40), '000000000000000000000000'),
                l.account_id)) AS account_id,
              sum(l.bal) AS bal, max(l.last_block) AS last_block FROM (
              ${ERC20_WALLET_ASSET_IDS.includes(assetId) ? `
              -- ERC-20-backed asset: the plain latest Tokens-side balance plus
              -- the separate authoritative ERC-20-side wallet pot.
              SELECT account_id, latest_bal AS bal, latest_block AS last_block FROM latest_raw
              UNION ALL
              -- ERC-20-side holdings (separate pot, see erc20WalletService) —
              -- summed per account above.
              SELECT account_id, toUInt256OrZero(argMax(total, updated_at)) AS bal, 0 AS last_block
              FROM price_data.erc20_wallet_balances WHERE asset_id = {asset:String}
              GROUP BY account_id HAVING bal > 0` : `
              SELECT latest_raw.account_id AS account_id, latest_raw.latest_bal AS bal, latest_raw.latest_block AS last_block
              FROM latest_raw`}
            ) l
            LEFT JOIN bind b ON b.eth_id = l.account_id
            GROUP BY account_id
          ),
          grouped AS (
            SELECT
              if(t.label_id = '', latest.account_id, t.label_id) AS group_key,
              t.label_id AS label_id,
              any(t.label_name) AS label_name,
              any(t.color) AS color,
              any(t.icon) AS icon,
              count() AS member_count,
              sum(latest.bal) AS gbal,
              max(latest.last_block) AS last_block,
              any(latest.account_id) AS sample_account
            FROM latest
            LEFT JOIN tags t ON t.account_id = latest.account_id
            GROUP BY group_key, label_id
            HAVING gbal > 0
          )
        SELECT group_key, label_id, label_name, color, icon, member_count,
               toString(gbal) AS balance, last_block, sample_account,
               count() OVER () AS total, toString(sum(gbal) OVER ()) AS total_bal
        FROM grouped
        ORDER BY gbal DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { asset: String(assetId), limit, offset }, format: 'JSONEachRow',
    })
    const rows = await res.json<{ group_key: string; label_id: string; label_name: string; color: string; icon: string; member_count: string; balance: string; last_block: number; sample_account: string; total: string; total_bal: string }>()
    const total = rows.length ? Number(rows[0].total) : 0
    const totalUsd = rows.length ? (usdValue(prices, assetId, rows[0].total_bal, a.decimals) ?? 0) : 0
    const holders: HolderRow[] = rows.map((r, i) => {
      const isTag = r.label_id !== ''
      const valueUsd = usdValue(prices, assetId, r.balance, a.decimals)
      return {
        rank: offset + i + 1,
        account: isTag ? null : accountRef(r.sample_account),
        tag: isTag ? { tagId: r.label_id, name: r.label_name, color: r.color, icon: tagIcon(r.label_id, r.icon), memberCount: Number(r.member_count) } : null,
        balance: r.balance,
        lastBlock: r.last_block,
        valueUsd,
        share: totalUsd > 0 ? (valueUsd ?? 0) / totalUsd : 0,
      }
    })
    return { asset: a, holders, total, totalUsd }
  })
}

// address detail
// `frozen` is the non-transferable part of `free` (per-account max lock, summed
// across the account set); `breakdown` lists the lock/reserve/hold/deposit
// components and `timeline` the binding unlock schedule (when how much of the
// frozen balance actually unlocks, and which lock causes it) — both from the
// background lock snapshot (see lockBreakdownService).
export interface AddressBalance { asset: AssetRef; total: string; free: string; reserved: string; frozen?: string; breakdown?: BalanceLockComponent[]; timeline?: BalanceUnlockSlice[]; lastBlock: number; valueUsd: number | null }
interface AggregatedBalanceRow { asset_id: string; total: string; free: string; reserved: string; last_block: number }

async function queryAggregatedBalances(accountListSql: string): Promise<AggregatedBalanceRow[]> {
  const result = await client.query({
    query: `
      SELECT asset_id, toString(sum(t)) AS total, toString(sum(f)) AS free, toString(sum(rsv)) AS reserved, max(lb) AS last_block FROM (
        SELECT account_id, asset_id,
          toUInt256OrZero(argMaxMerge(total_state)) AS t,
          toUInt256OrZero(argMaxMerge(free_state)) AS f,
          toUInt256OrZero(argMaxMerge(reserved_state)) AS rsv,
          maxMerge(last_block_state) AS lb
        FROM price_data.account_asset_latest_balances
        WHERE account_id IN (${accountListSql})
        GROUP BY account_id, asset_id
      ) GROUP BY asset_id HAVING sum(t) > 0 ORDER BY asset_id`,
    format: 'JSONEachRow',
  })
  return result.json<AggregatedBalanceRow>()
}

function valueAccountBalances(rows: AggregatedBalanceRow[], prices: Map<number, PriceInfo>): AddressBalance[] {
  return rows
    .map(row => {
      const balanceAsset = asset(row.asset_id)
      return {
        asset: balanceAsset,
        total: row.total,
        free: row.free,
        reserved: row.reserved,
        lastBlock: row.last_block,
        valueUsd: usdValue(prices, balanceAsset.assetId, row.total, balanceAsset.decimals),
      }
    })
    .sort((left, right) => (right.valueUsd ?? 0) - (left.valueUsd ?? 0))
}

// The largest holdings (up to 4), highest first, keeping only those worth > $10
// AND at least 10% of the account's total held value. Fed the same valued +
// folded balances the detail pages build (wallet + MM-collateral aTokens +
// ERC-20), so the accounts-list icons and the hover card always agree.
export function topHeldTokens(balances: AddressBalance[]): { asset: AssetRef; valueUsd: number }[] {
  const total = balances.reduce((sum, b) => sum + Math.max(0, b.valueUsd ?? 0), 0)
  return balances
    .filter(b => (b.valueUsd ?? 0) > 10 && (b.valueUsd ?? 0) >= 0.10 * total)
    .sort((left, right) => (right.valueUsd ?? 0) - (left.valueUsd ?? 0))
    .slice(0, 4)
    .map(b => ({ asset: b.asset, valueUsd: b.valueUsd as number }))
}

// Rescale a base-10 integer amount string from `fromDec` to `toDec` decimal places
// (truncating when shrinking). Used to bring amounts onto a common decimal scale.
function rescaleRaw(raw: string, fromDec: number, toDec: number): string {
  if (fromDec === toDec || !raw) return raw
  const neg = raw.startsWith('-')
  let s = neg ? raw.slice(1) : raw
  if (toDec > fromDec) s += '0'.repeat(toDec - fromDec)
  else { const drop = fromDec - toDec; s = s.length > drop ? s.slice(0, -drop) : '0' }
  return (neg ? '-' : '') + (s || '0')
}

// Fold held Stableswap pool-share tokens (2-Pool-GDOT, …) into their underlying
// main asset (GDOT) for per-account display, mirroring preis-ui which hides
// "-Pool" tokens. The share token is already priced via its underlying, so value
// is preserved and the portfolio total is unchanged; rows for the same underlying
// merge. The share token and its underlying can carry different decimals (e.g.
// 2-Pool-PRIME has 18, PRIME has 6), so raw amounts are normalised to the display
// asset's scale before summing. No-op when the account holds no share tokens.
export function foldShareBalances(balances: AddressBalance[]): AddressBalance[] {
  if (!balances.some(b => displayAssetId(b.asset.assetId) !== b.asset.assetId)) return balances
  const byId = new Map<number, AddressBalance>()
  for (const b of balances) {
    const did = displayAssetId(b.asset.assetId)
    const dispAsset = did === b.asset.assetId ? b.asset : asset(did)
    const total = rescaleRaw(b.total, b.asset.decimals, dispAsset.decimals)
    const free = rescaleRaw(b.free, b.asset.decimals, dispAsset.decimals)
    const reserved = rescaleRaw(b.reserved, b.asset.decimals, dispAsset.decimals)
    const cur = byId.get(did)
    if (!cur) {
      byId.set(did, { ...b, asset: dispAsset, total, free, reserved })
    } else {
      cur.total = (BigInt(cur.total) + BigInt(total)).toString()
      cur.free = (BigInt(cur.free) + BigInt(free)).toString()
      cur.reserved = (BigInt(cur.reserved) + BigInt(reserved)).toString()
      cur.valueUsd = (cur.valueUsd ?? 0) + (b.valueUsd ?? 0)
      cur.lastBlock = Math.max(cur.lastBlock, b.lastBlock)
    }
  }
  return [...byId.values()].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
}

// Attach the background lock-snapshot components to the final displayed balance
// rows. Components are keyed by on-chain asset id; folding may have merged a
// source asset into its display asset (share tokens), so components map through
// displayAssetId with a decimal rescale, merging additively when several source
// assets land on one display row.
export function attachLockBreakdowns(balances: AddressBalance[], breakdowns: Map<number, AssetLockBreakdown>): AddressBalance[] {
  if (!breakdowns.size) return balances
  interface ComponentAgg { kind: BalanceLockComponent['kind']; source: string; amount: bigint; claimable: bigint; tranches?: BalanceLockTranche[]; mixed: boolean }
  const byDisplay = new Map<number, { frozen: bigint; components: Map<string, ComponentAgg>; timeline?: BalanceUnlockSlice[] }>()
  for (const [assetId, b] of breakdowns) {
    const did = displayAssetId(assetId)
    const fromDec = asset(assetId).decimals
    const toDec = did === assetId ? fromDec : asset(did).decimals
    const scale = (v: string) => BigInt(rescaleRaw(v, fromDec, toDec) || '0')
    const agg = byDisplay.get(did) ?? { frozen: 0n, components: new Map<string, ComponentAgg>() }
    agg.frozen += scale(b.frozen)
    if (b.timeline?.length && !agg.timeline) agg.timeline = b.timeline.map(s => ({ ...s, amount: scale(s.amount).toString() }))
    for (const c of b.components) {
      const key = `${c.kind}|${c.source}`
      const cur = agg.components.get(key)
      const tranches = c.tranches?.map(t => ({ ...t, amount: scale(t.amount).toString() }))
      if (cur) {
        // Two source assets folded onto one display row: amounts add, but the
        // tranche timelines would interleave misleadingly — drop them.
        cur.amount += scale(c.amount)
        cur.claimable += scale(c.claimable ?? '0')
        cur.mixed = true
      } else {
        agg.components.set(key, { kind: c.kind, source: c.source, amount: scale(c.amount), claimable: scale(c.claimable ?? '0'), tranches, mixed: false })
      }
    }
    byDisplay.set(did, agg)
  }
  return balances.map(b => {
    const agg = byDisplay.get(b.asset.assetId)
    if (!agg?.components.size) return b
    const breakdown = [...agg.components.values()]
      .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0))
      .map(c => ({
        kind: c.kind, source: c.source, amount: c.amount.toString(),
        ...(c.claimable > 0n ? { claimable: c.claimable.toString() } : {}),
        ...(c.tranches?.length && !c.mixed ? { tranches: c.tranches } : {}),
      }))
    return { ...b, frozen: agg.frozen.toString(), breakdown, ...(agg.timeline?.length ? { timeline: agg.timeline } : {}) }
  })
}

async function queryLockBreakdownsSafe(accountListSql: string): Promise<Map<number, AssetLockBreakdown>> {
  try {
    return await queryLockBreakdowns(client, accountListSql)
  } catch (err) {
    // Balances render without the breakdown rather than failing the page.
    console.error('[locks] breakdown read failed', err)
    return new Map()
  }
}

// Wallet-held stableswap pool-share tokens (2-Pool-GDOT, 4-Pool, …) ARE liquidity
// positions — surface them as such (venue 'Stablepool') instead of leaving them
// buried in the balance fold. Must be fed the RAW balance rows, before
// foldShareBalances relabels them into their underlying: only wallet-held shares
// qualify — share collateral supplied to a money market stays on that market's
// card, and GIGA tokens (GDOT/GETH/GSOL) stay ordinary balances (they're products,
// not something the holder LP'd into). Display-only rows: their USD value is
// already counted once via the folded wallet balances, so callers must NOT add
// them into lpUsd/portfolio.
export function stableswapLpPositions(balances: AddressBalance[]): LpPosition[] {
  return balances
    .filter(b => b.total !== '0' && (SHARE_TOKEN_UNDERLYING_ID[b.asset.assetId] != null || /^\d+-Pool(-|$)/.test(b.asset.symbol)))
    .map(b => ({ positionId: `share-${b.asset.assetId}`, asset: b.asset, amount: b.total, shares: b.total, valueUsd: b.valueUsd, venue: 'Stablepool' }))
}
export interface MoneyMarketPosition {
  marketKey: string                 // 'core', 'gigahdx', … — which isolated market
  market: string                    // display label, e.g. 'GIGAHDX'
  role: 'primary' | 'supplemental'  // primary owns global summaries + DefiSim
  defiSimSupported: boolean
  stakingBacked?: boolean           // collateral backed by locked-in-wallet HDX (display-only in net worth)
  blockHeight: number
  timestamp: string
  totalCollateralBase: string
  // Total supplied value can exceed liquidation-eligible collateral when a
  // reserve is lendable but not enabled as collateral. Risk math must always
  // use totalCollateralBase; presentation uses this field when available.
  totalSuppliedBase?: string
  totalDebtBase: string
  availableBorrowsBase: string
  liquidationThreshold: string
  ltv: string
  healthFactor: string
  // Present for aggregate/tag positions: a real member whose position can be
  // opened in DefiSim (never the tag id or an unrelated first member).
  simAccount?: string
  reserves?: MmReserve[]
}
// Proxy & multisig relations resolved to displayable account refs.
export interface ProxyRelationDisplay { account: AccountRef; proxyType: string; delay: number }
export interface AccountProxyDisplay {
  isPure: { creator: AccountRef; proxyType: string; blockHeight: number; timestamp: string } | null
  delegates: ProxyRelationDisplay[]    // accounts that can act for this one
  delegatorOf: ProxyRelationDisplay[]  // accounts this one can act for
}
export interface MultisigDisplay {
  threshold: number
  signatories: AccountRef[]
  pending: { callHash: string; depositor: AccountRef; approvals: AccountRef[]; sinceBlock: number }[]
}
export interface MultisigMembershipDisplay { account: AccountRef; threshold: number; signatories: number }

export interface AddressDetail {
  input: string
  kind: string
  accountId: string
  emoji: string
  emojiName?: string
  emojiUrl?: string
  evmAddress: string | null
  ss58: string
  ss58Polkadot: string
  tag: { id: string; name: string; color: string; icon: string } | null
  identity: AccountIdentity | null
  relatedAccountIds: string[]
  aliases: { accountId: string | null; evmAddress: string | null; primaryProfile: string; relationship: string; confidence: number }[]
  balances: AddressBalance[]
  // Up to 4 largest holdings (> $10 and ≥ 10% of held value) — the shared icon set
  // for the accounts list and the hover card. Derived from `balances` above.
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd: number
  liquidationVolumeUsd: number
  moneyMarket: MoneyMarketPosition[]          // one entry per isolated market the account has a position in
  liquidityPositions?: LpPosition[]
  activeDcas?: ActiveDca[]
  proxy: AccountProxyDisplay | null
  multisig: MultisigDisplay | null
  multisigMemberships: MultisigMembershipDisplay[]
}

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

// Resolve an address input to its canonical AccountId32 + the full set of
// related account_ids (self + alias-linked accounts of the same entity). Shared
// by getAddress and the per-account activity/extrinsics/events endpoints so they
// all scope to the same related set. Returns null when the input isn't a valid
// address.
interface AccountAliasRow {
  account_id: string | null
  evm_address: string | null
  primary_profile: string
  relationship: string
  confidence: number
}

interface RelatedAccounts {
  norm: NonNullable<ReturnType<typeof normalizeAddress>>
  related: string[]
  aliasRows: AccountAliasRow[]
}
// A bare EVM H160 is ambiguous: it is either a genuine ("pure") EVM account, or
// the default first-20-bytes EVM mapping of a real substrate account that touched
// the EVM money market (borrow/lending) — Hydration encodes the latter as a
// truncated AccountId32 0x45544800 + H160 + zeros, which normalizeAddress reports
// as kind 'evm'. An EVMAccounts.Bound event records the true substrate AccountId32
// behind an H160; when one exists we re-anchor identity to that substrate account
// so it is shown by its SS58 (e.g. 16Cbxt…) instead of the H160. The bound
// account's first 20 bytes equal the H160, so money-market H160 derivation
// (norm.accountId.slice(2,42)) still resolves to the same EVM-side position.
export function boundSubstrateAccount(
  aliasRows: { account_id: string | null; evm_address: string | null; relationship: string }[],
  evmAddress: string,
): string | null {
  for (const a of aliasRows) {
    if (a.relationship !== 'explicit_binding' || a.evm_address !== evmAddress) continue
    if (a.account_id && ACCOUNT_RE.test(a.account_id) && !evmFromAccountId(a.account_id)) return a.account_id
  }
  return null
}

// Like normalizeAddress, but re-anchors a bound EVM H160 to its substrate account
// (see boundSubstrateAccount). For callers that don't already hold the alias rows.
async function canonicalizeAddress(input: string): Promise<NormalizedAddress | null> {
  const norm = normalizeAddress(input)
  if (!norm || norm.kind !== 'evm' || !norm.evmAddress) return norm
  const res = await client.query({
    query: `SELECT account_id FROM price_data.raw_account_aliases
            WHERE primary_profile = {pp:String}
              AND alias_type = 'substrate_account_id' AND relationship = 'explicit_binding'
            LIMIT 1`,
    query_params: { pp: 'evm:' + norm.evmAddress }, format: 'JSONEachRow',
  })
  const bound = (await res.json<{ account_id: string }>())[0]?.account_id
  if (bound && ACCOUNT_RE.test(bound) && !evmFromAccountId(bound)) return normalizeAddress(bound) ?? norm
  return norm
}

export async function resolveRelatedAccounts(addressInput: string): Promise<RelatedAccounts | null> {
  const norm0 = normalizeAddress(addressInput)
  if (!norm0 || !norm0.accountId) return null
  const aliasRes = await client.query({
    query: `SELECT DISTINCT account_id, evm_address, primary_profile, relationship, confidence
            FROM price_data.raw_account_aliases
            WHERE account_id = {acc:String} OR evm_address = {evm:String}`,
    query_params: { acc: norm0.accountId, evm: norm0.evmAddress ?? '' }, format: 'JSONEachRow',
  })
  let aliasRows = await aliasRes.json<AccountAliasRow>()
  const queriedEvms = new Set<string>()
  if (norm0.evmAddress && EVM_RE.test(norm0.evmAddress)) queriedEvms.add(norm0.evmAddress)
  const evmAliases = new Set<string>()
  if (norm0.evmAddress && EVM_RE.test(norm0.evmAddress)) evmAliases.add(norm0.evmAddress)
  for (const a of aliasRows) {
    const evm = a.evm_address?.toLowerCase()
    if (evm && EVM_RE.test(evm)) evmAliases.add(evm)
  }
  const evmsToLoad = [...evmAliases].filter(evm => !queriedEvms.has(evm))
  if (evmsToLoad.length) {
    const evmAliasRes = await client.query({
      query: `SELECT DISTINCT account_id, evm_address, primary_profile, relationship, confidence
              FROM price_data.raw_account_aliases
              WHERE evm_address IN ({evms:Array(String)})`,
      query_params: { evms: evmsToLoad }, format: 'JSONEachRow',
    })
    const seen = new Set(aliasRows.map(a => JSON.stringify(a)))
    for (const row of await evmAliasRes.json<AccountAliasRow>()) {
      const key = JSON.stringify(row)
      if (!seen.has(key)) {
        seen.add(key)
        aliasRows.push(row)
      }
    }
  }
  // Re-anchor H160 inputs to the substrate side when EVMAccounts.Bound proves a
  // real account owns the H160, or when the H160 is the runtime truncation of a
  // tagged derived account (e.g. a stableswap pool's EVM-side aToken holdings).
  // Substrate inputs may discover the same H160 from the first query, so
  // related also includes its truncated EVM AccountId below.
  let norm = norm0
  if (norm0.kind === 'evm' && norm0.evmAddress) {
    const bound = boundSubstrateAccount(aliasRows, norm0.evmAddress) ?? taggedAccountByH160(norm0.evmAddress)
    if (bound) norm = normalizeAddress(bound) ?? norm0
  }
  const related = new Set<string>([norm.accountId])
  // The account's own truncated-H160 pot (runtime AccountId→EVM mapping) always
  // belongs to this entity — include it even when no alias row was observed yet.
  const ownEvmForm = evmAccountForm(norm.accountId)
  if (ownEvmForm) related.add(ownEvmForm)
  for (const a of aliasRows) if (a.account_id && ACCOUNT_RE.test(a.account_id)) related.add(a.account_id.toLowerCase())
  for (const evm of evmAliases) {
    const accountId = evmAccountIdFromAddress(evm)
    if (accountId) related.add(accountId)
  }
  return { norm, related: [...related], aliasRows }
}

export async function getAddress(addressInput: string, opts: { summary?: boolean } = {}): Promise<AddressDetail | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  const { norm, aliasRows } = resolved
  // The hover card shows only name + value + top holdings + volumes. `summary` skips
  // the expensive extras it never renders (LP positions, DCA, proxy/multisig live
  // reads) so the preview loads fast; the detail page still requests the full object.
  const summary = opts.summary === true
  return cached(`explorer:address:${accountValueGenerationEpoch}:${norm.accountId}${summary ? ':summary' : ''}`, 8000, async () => {
    // 1. Aliases — discover all account_ids belonging to the same entity.
    const related = new Set<string>(resolved.related)
    const list = sqlAccountList([...related])
    // MM positions are stored under each account's truncated-H160 (EVM) form, not
    // its full AccountId, so the stored-position fallback must look them up there.
    const mmList = sqlAccountList([...new Set([...related].map(evmAccountForm).filter(Boolean) as string[])])

    const [balanceRows, lockBreakdowns, mmRes, prices] = await Promise.all([
      queryAggregatedBalances(list),
      summary ? Promise.resolve(new Map<number, AssetLockBreakdown>()) : queryLockBreakdownsSafe(list),
      moneyMarketAccountValuesReady ? Promise.resolve(null) : client.query({
        query: `
          SELECT pool_address,
                 max(block_height) AS lb,
                 toString(argMax(block_timestamp, ${moneyMarketPositionOrderSql()})) AS ts,
                 argMax(total_collateral_base, ${moneyMarketPositionOrderSql()}) AS total_collateral_base,
                 argMax(total_debt_base, ${moneyMarketPositionOrderSql()}) AS total_debt_base,
                 argMax(available_borrows_base, ${moneyMarketPositionOrderSql()}) AS available_borrows_base,
                 argMax(current_liquidation_threshold, ${moneyMarketPositionOrderSql()}) AS current_liquidation_threshold,
                 argMax(ltv, ${moneyMarketPositionOrderSql()}) AS ltv,
                 argMax(health_factor, ${moneyMarketPositionOrderSql()}) AS health_factor
          FROM price_data.raw_money_market_positions
          WHERE account_id IN (${mmList})
          GROUP BY pool_address`,
        format: 'JSONEachRow',
      }),
      ensureAccountValuePrices(),
    ])

    const rawBalances = valueAccountBalances(balanceRows, prices)
    // Wallet-held pool shares double as LP display rows (see stableswapLpPositions) —
    // captured before the fold below hides them behind their underlying.
    const stableLp = stableswapLpPositions(rawBalances)
    let balances: AddressBalance[] = foldShareBalances(rawBalances)

    // Latest indexed position per market (pool_address). Unknown pools are ignored.
    const mmRows = mmRes ? await mmRes.json<{ pool_address: string; lb: number; ts: string; total_collateral_base: string; total_debt_base: string; available_borrows_base: string; current_liquidation_threshold: string; ltv: string; health_factor: string }>() : []
    const storedByMarket = new Map<string, MoneyMarketPosition>()
    for (const r of mmRows) {
      if (r.total_collateral_base === '0' && r.total_debt_base === '0') continue
      const m = MM_MARKET_BY_POOL.get((r.pool_address ?? '').toLowerCase())
      if (!m) continue
      storedByMarket.set(m.key, {
        ...moneyMarketFields(m),
        blockHeight: r.lb, timestamp: r.ts,
        totalCollateralBase: r.total_collateral_base, totalSuppliedBase: r.total_collateral_base, totalDebtBase: r.total_debt_base,
        availableBorrowsBase: r.available_borrows_base, liquidationThreshold: r.current_liquidation_threshold,
        ltv: r.ltv, healthFactor: r.health_factor === MAX_UINT256 ? 'inf' : r.health_factor,
      })
    }
    // Money-market positions live on the EVM side and never hit substrate balances.
    // Query the indexed H160 form as well as the account-id form above: explicit for
    // EVM accounts, or Hydration's first-20-byte mapping for substrate accounts.
    const mmH160 = norm.evmAddress ?? '0x' + norm.accountId.slice(2, 42)
    const indexedByMarket = new Map<string, MoneyMarketPosition>()
    for (const position of await getMoneyMarketPositions(mmH160)) indexedByMarket.set(position.marketKey, position)
    // Merge the freshest indexed result over the account-scoped fallback, per market.
    const byMarket = new Map<string, MoneyMarketPosition>(storedByMarket)
    for (const [marketKey, position] of indexedByMarket) byMarket.set(marketKey, position)
    // Attach indexed per-reserve detail (supplied/debt tokens) to each market.
    // Reserve balances include supplied assets that are not collateral-enabled, so
    // read them even when the aggregate position has no collateral or debt.
    const reservesByMarket = new Map<string, MmReserve[]>()
    for (const r of await getMoneyMarketReserves(mmH160)) {
      const k = r.marketKey ?? 'core'
      ;(reservesByMarket.get(k) ?? reservesByMarket.set(k, []).get(k)!).push(r)
    }
    for (const [k, rs] of reservesByMarket) {
      const pos = byMarket.get(k)
      byMarket.set(k, pos ? attachMmReserves(pos, rs, prices) : moneyMarketFromReserves(k, rs, prices))
    }

    // Surface supplied aToken collateral as a wallet balance — it IS the account's
    // aToken holding (e.g. aDOT), matching the Hydration wallet. EXCEPT staking-backed
    // markets (GIGAHDX): there the collateral (stHDX) is backed by HDX that stays locked
    // in the wallet, which is already counted — so we never fold it into balances or
    // portfolio value (it remains visible in that market's card). Debt is not a balance.
    let moneyMarket = orderMoneyMarkets([...byMarket.values()])
    const countedPositions = moneyMarket.filter(p => !p.stakingBacked)
    const foldedMmUsd = countedPositions.reduce((s, p) => s + applyMmCollateralToBalances(balances, p, prices), 0)
    // MM collateral is added under the reserve's own asset id (Hydration's money
    // market uses the pool tokens, e.g. the 2-Pool-GETH reserve), so re-fold to
    // merge that supplied collateral into the underlying main asset as well.
    balances = foldShareBalances(balances)
    // ERC-20-side wallet holdings (HOLLAR): read from the bounded snapshot and
    // summed onto any Tokens-side balance — the two pots are separate on-chain.
    balances = mergeErc20Balances(balances, await erc20WalletHoldings(mmH160), prices)
    // Attach the lock/reserve components once the display rows are final.
    balances = attachLockBreakdowns(balances, lockBreakdowns)
    // Fold each market's borrow-position display the same way (2-Pool-GETH → GETH);
    // done now, after applyMmCollateralToBalances has consumed the unfolded reserves.
    moneyMarket = moneyMarket.map(p => p.reserves?.length ? { ...p, reserves: foldShareReserves(p.reserves) } : p)
    // Count MM collateral the per-reserve read couldn't surface (RPC shortfall) so a
    // borrower's portfolio stays correct (collateral − debt > 0). Staking-backed
    // markets are excluded — their collateral is the already-counted locked HDX.
    const collateralShortfall = countedPositions.reduce((s, p) => s + mmCollateralShortfallUsd(p, 0), 0)
    const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0) + Math.max(0, collateralShortfall - foldedMmUsd)
    const volumeAccounts = [...new Set([...related, ...[...related].map(evmAccountForm).filter(Boolean) as string[]])]
    const [tradingVolumeUsd, liquidationVolumeUsd] = await Promise.all([
      tradingVolumeByAccount(volumeAccounts).then(m => [...m.values()].reduce((s, v) => s + v, 0)),
      liquidationVolumeByAccount(volumeAccounts).then(m => [...m.values()].reduce((s, v) => s + v, 0)),
    ])

    const tag = tagForAccount(norm.accountId)
    const onchainId = identityForAccount(norm.accountId)
    const addrIcon = accountIcon(norm.accountId)
    // LP positions stay even in summary — they count toward the displayed value, so
    // dropping them would make the hover's value disagree with the detail page. Only
    // DCA/proxy/multisig (below), which the card never shows, are skipped.
    const [bareLp, farmLp, xykLp, activeDcas] = await Promise.all([
      getOmnipoolPositions([...related]),
      getFarmingPositions([...related]),
      getXykPositions([...related], balances),
      summary ? Promise.resolve([]) : getActiveDcas([...related]),
    ])
    // Proxy & multisig relations (in-memory indexes refreshed by the
    // proxyMultisigService; pending ops come from indexed events).
    const toProxyRel = (r: ProxyRelation): ProxyRelationDisplay => ({ account: accountRef(r.accountId), proxyType: r.proxyType, delay: r.delay })
    const proxyRaw = summary ? null : proxyInfoFor([...related])
    const proxy: AccountProxyDisplay | null = proxyRaw ? {
      isPure: proxyRaw.isPure ? { creator: accountRef(proxyRaw.isPure.creator), proxyType: proxyRaw.isPure.proxyType, blockHeight: proxyRaw.isPure.blockHeight, timestamp: proxyRaw.isPure.timestamp } : null,
      delegates: proxyRaw.delegates.map(toProxyRel),
      delegatorOf: proxyRaw.delegatorOf.map(toProxyRel),
    } : null
    const msigComp = summary ? null : multisigCompositionFor([...related])
    const msigPending: PendingMultisigOp[] = msigComp ? await pendingMultisigOps(norm.accountId) : []
    const multisig: MultisigDisplay | null = msigComp ? {
      threshold: msigComp.threshold,
      signatories: msigComp.signatories.map(s => accountRef(s)),
      pending: msigPending.map(p => ({ callHash: p.callHash, depositor: accountRef(p.depositor), approvals: p.approvals.map(a => accountRef(a)), sinceBlock: p.sinceBlock })),
    } : null
    const multisigMemberships: MultisigMembershipDisplay[] = multisigMembershipsFor([...related])
      .map(m => ({ account: accountRef(m.accountId), threshold: m.threshold, signatories: m.signatories }))
    // Omnipool LP = bare positions + farmed deposits. Bare and farmed are disjoint by
    // NFT ownership (a farmed position's NFT is held by the LM pallet), so no de-dup
    // is needed. Each is valued at its withdraw value. Staking is intentionally NOT
    // added: the staked HDX principal is already counted (it's locked-but-free HDX in
    // the wallet balance), and the official Hydration net worth excludes the
    // pot-held, loyalty-slashable pending rewards.
    const lpPositions = [...bareLp, ...farmLp, ...xykLp].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
    // Only NFT-held positions add value here — stableLp rows are wallet balances
    // already counted in portfolioUsd, they're appended for display only.
    const lpUsd = lpPositions.reduce((s, p) => s + (p.valueUsd ?? 0), 0)
    // Pin the history's final point to the authoritative current net worth so the
    // chart ends exactly on the headline figure (the live aToken valuation can
    // differ from the MM base collateral by a small amount). Copy first — history
    // is a shared cached object.
    return {
      input: addressInput,
      kind: norm.kind,
      accountId: norm.accountId,
      emoji: addrIcon.emoji,
      emojiName: addrIcon.emojiName,
      emojiUrl: addrIcon.emojiUrl,
      evmAddress: norm.evmAddress,
      ss58: norm.ss58 ?? hydrationAddress(norm.accountId),
      ss58Polkadot: norm.ss58Polkadot ?? '',
      tag: tag ? { id: tag.tagId, name: tag.name, color: tag.color, icon: tag.icon } : null,
      identity: onchainId,
      relatedAccountIds: [...related],
      aliases: aliasRows.map(a => ({ accountId: a.account_id, evmAddress: a.evm_address, primaryProfile: a.primary_profile, relationship: a.relationship, confidence: a.confidence })),
      balances,
      topAssets: topHeldTokens(balances),
      portfolioUsd: portfolioUsd + lpUsd,
      tradingVolumeUsd,
      liquidationVolumeUsd,
      moneyMarket,
      liquidityPositions: [...lpPositions, ...stableLp].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0)),
      activeDcas,
      proxy,
      multisig,
      multisigMemberships,
      portfolioSeries: [],
      portfolioDates: [],
      balanceHistory: [],
    }
  })
}

export async function getAddressHistory(addressInput: string): Promise<{ portfolioSeries: number[]; portfolioDates: string[]; balanceHistory: AssetBalanceHistory[] } | null> {
  const detail = await getAddress(addressInput)
  if (!detail) return null
  // The reconstruction is cached under the same scope key the value-event jump
  // detection uses, so chart and markers share one heavy walk. Only the trivial
  // final-point pin is recomputed per request.
  const history = await getAccountHistoryShared(detail.relatedAccountIds, `addr:${detail.accountId}`)
  const debtUsd = detail.moneyMarket.reduce((s, p) => s + Number(p.totalDebtBase) / 1e8, 0)
  const portfolioSeries = history.portfolioSeries.slice()
  if (portfolioSeries.length) portfolioSeries[portfolioSeries.length - 1] = +(detail.portfolioUsd - debtUsd).toFixed(2)
  return {
    portfolioSeries,
    portfolioDates: history.portfolioDates,
    balanceHistory: history.balanceHistory,
  }
}

// indexed Money Market positions
// Event observations plus the periodic snapshot service keep current aggregate
// positions in ClickHouse; account requests perform no per-user RPC reads.
// AAVE v3 markets are isolated pools: getUserAccountData(user) on one pool returns
// ONLY that pool's aggregate, with its OWN health factor. A borrower in two markets
// (e.g. core + GIGAHDX) therefore has TWO independent positions/health factors — we
// never blend them, since liquidation is per-market. Core is primary and GIGAHDX
// is a built-in supplemental market; EXPLORER_MM_MARKETS remains available for
// future deployments.
// `stakingBacked` marks a market (GIGAHDX) whose collateral (stHDX) is backed by HDX
// that stays LOCKED IN THE WALLET — so its collateral is display-only and must not be
// added to portfolioUsd (the locked HDX is already counted). See applyMmCollateralToBalances.
interface ApiMmMarket {
  key: string
  label: string
  poolProxy: string
  role: 'primary' | 'supplemental'
  defiSimSupported: boolean
  stakingBacked: boolean
}
const CORE_MM_MARKET: ApiMmMarket = {
  key: 'core', label: 'Money Market', poolProxy: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38',
  role: 'primary', defiSimSupported: true, stakingBacked: false,
}
const GIGAHDX_MM_MARKET: ApiMmMarket = {
  key: 'gigahdx', label: 'GIGAHDX', poolProxy: '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923',
  role: 'supplemental', defiSimSupported: false, stakingBacked: true,
}
function envMmMarkets(): ApiMmMarket[] {
  const raw = process.env.EXPLORER_MM_MARKETS?.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: ApiMmMarket[] = []
    parsed.forEach((e, i) => {
      const r = (e ?? {}) as Record<string, unknown>
      const poolProxy = typeof r.poolProxy === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.poolProxy) ? r.poolProxy.toLowerCase() : null
      if (!poolProxy) { console.error(`[Explorer] EXPLORER_MM_MARKETS[${i}].poolProxy invalid; skipping`); return }
      const key = typeof r.key === 'string' && r.key.trim() ? r.key.trim() : `market${i + 1}`
      out.push({
        key, label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : key, poolProxy,
        role: 'supplemental', defiSimSupported: false, stakingBacked: r.stakingBacked === true,
      })
    })
    return out
  } catch {
    console.error('[Explorer] EXPLORER_MM_MARKETS is not valid JSON; ignoring')
    return []
  }
}
// Core first, then extra markets, deduped by pool proxy.
const MM_MARKETS: ApiMmMarket[] = (() => {
  const seen = new Set<string>(); const out: ApiMmMarket[] = []
  const keys = new Set<string>()
  for (const m of [CORE_MM_MARKET, GIGAHDX_MM_MARKET, ...envMmMarkets()]) {
    if (!seen.has(m.poolProxy) && !keys.has(m.key)) { seen.add(m.poolProxy); keys.add(m.key); out.push(m) }
  }
  return out
})()
const MM_MARKET_BY_POOL = new Map<string, ApiMmMarket>(MM_MARKETS.map(m => [m.poolProxy, m]))
const MM_MARKET_BY_KEY = new Map<string, ApiMmMarket>(MM_MARKETS.map(m => [m.key, m]))
const MM_MARKET_ORDER = new Map<string, number>(MM_MARKETS.map((m, i) => [m.key, i]))
const configuredMmPoolsSql = () => MM_MARKETS.map(m => `'${m.poolProxy}'`).join(',')
const supplementalMmPoolsSql = () => MM_MARKETS.filter(m => m.role === 'supplemental').map(m => `'${m.poolProxy}'`).join(',') || "''"
const countedMmPoolsSql = () => MM_MARKETS.filter(m => !m.stakingBacked).map(m => `'${m.poolProxy}'`).join(',') || "''"
function moneyMarketFields(m: ApiMmMarket): Pick<MoneyMarketPosition, 'marketKey' | 'market' | 'role' | 'defiSimSupported' | 'stakingBacked'> {
  return { marketKey: m.key, market: m.label, role: m.role, defiSimSupported: m.defiSimSupported, stakingBacked: m.stakingBacked }
}
function orderMoneyMarkets<T extends Pick<MoneyMarketPosition, 'marketKey'>>(positions: T[]): T[] {
  return positions.sort((a, b) => (MM_MARKET_ORDER.get(a.marketKey) ?? Number.MAX_SAFE_INTEGER) - (MM_MARKET_ORDER.get(b.marketKey) ?? Number.MAX_SAFE_INTEGER))
}
// ERC-20-backed wallet assets (HOLLAR): served from the erc20_wallet_balances table
// (refreshed every 10 min by erc20WalletService) rather than a per-request eth_call.
// The table is keyed by the anchored account_id; match this h160 by the ETH-prefixed
// form, the reserved (module) form, or a substrate account whose truncation is the h160.
async function erc20WalletHoldings(h160: string): Promise<{ asset: AssetRef; raw: bigint }[]> {
  const body = /^0x[0-9a-fA-F]{40}$/.test(h160) ? h160.slice(2).toLowerCase() : ''
  if (!body) return []
  return cached(`explorer:erc20-wallet:${body}`, 15000, () => erc20WalletHoldingsForAccounts([h160]))
}

// Aggregate EVM-side wallet holdings for a bounded account set in one query.
// Tag pages use this instead of issuing one query per member; exact ETH-prefixed
// and reserved forms plus the native AccountId→H160 truncation mirror the account
// detail lookup above.
async function erc20WalletHoldingsForAccounts(h160s: string[]): Promise<{ asset: AssetRef; raw: bigint }[]> {
  const bodies = [...new Set(h160s
    .filter(h => /^0x[0-9a-fA-F]{40}$/.test(h))
    .map(h => h.slice(2).toLowerCase()))]
  if (!bodies.length) return []
  const exactAccounts = [...new Set(bodies.flatMap(body => [
    '0x45544800' + body + '0000000000000000',
    reservedH160AccountId(body),
  ]).filter((account): account is string => account != null))]
  const res = await client.query({
    query: `SELECT asset_id, toString(sum(toUInt256(total))) AS total
            FROM price_data.erc20_wallet_balances FINAL
            WHERE asset_id IN {assets:Array(String)}
              AND (lower(account_id) IN {accounts:Array(String)}
                OR substring(lower(account_id), 3, 40) IN {bodies:Array(String)})
            GROUP BY asset_id`,
    query_params: {
      assets: ERC20_WALLET_ASSET_IDS.map(String),
      accounts: exactAccounts,
      bodies,
    },
    format: 'JSONEachRow',
  })
  const out: { asset: AssetRef; raw: bigint }[] = []
  for (const r of await res.json<{ asset_id: string; total: string }>()) {
    const raw = BigInt(r.total || '0')
    if (raw > 0n) out.push({ asset: asset(Number(r.asset_id)), raw })
  }
  return out
}

// Fold live ERC-20 holdings into the Tokens-side balance list: summed when the
// asset already has a (separate-pot) Tokens balance, appended otherwise.
export function mergeErc20Balances(balances: AddressBalance[], holdings: { asset: AssetRef; raw: bigint }[], prices: Map<number, PriceInfo>): AddressBalance[] {
  if (!holdings.length) return balances
  const out = balances.slice()
  for (const h of holdings) {
    if (h.raw <= 0n) continue
    const existing = out.findIndex(b => b.asset.assetId === h.asset.assetId)
    if (existing >= 0) {
      const b = out[existing]
      const total = (BigInt(b.total || '0') + h.raw).toString()
      const free = (BigInt(b.free || '0') + h.raw).toString()
      out[existing] = { ...b, total, free, valueUsd: usdValue(prices, b.asset.assetId, total, b.asset.decimals) }
    } else {
      const total = h.raw.toString()
      out.push({ asset: h.asset, total, free: total, reserved: '0', lastBlock: 0, valueUsd: usdValue(prices, h.asset.assetId, total, h.asset.decimals) })
    }
  }
  return out.sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
}

// Per-market positions (collateral/debt/health-factor), one row per isolated pool,
// from raw_money_market_positions maintained by snapshots and event indexing.
// Explorer requests never call getUserAccountData directly.
async function getMoneyMarketPositions(h160: string): Promise<MoneyMarketPosition[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(h160)) return []
  return cached(`explorer:mm-positions:${accountValueGenerationEpoch}:${h160.toLowerCase()}`, 15000, async () => {
    const accountId = evmAccountIdFromAddress(h160.toLowerCase())
    if (moneyMarketAccountValuesReady && accountId) {
      const current = await client.query({
        query: `SELECT pool_address,block_height AS lb,toString(block_timestamp) AS ts,
            toString(total_collateral_base) AS c,toString(total_debt_base) AS d,
            toString(available_borrows_base) AS ab,toString(liquidation_threshold) AS lt,
            toString(ltv) AS ltv,toString(health_factor) AS hf
          FROM price_data.money_market_account_value_snapshots
          WHERE snapshot_id=(SELECT argMax(snapshot_id,computed_at)
            FROM price_data.money_market_account_value_snapshot_state WHERE snapshot_key='current')
            AND account_id={accountId:String} AND reserve_present=0`,
        query_params: { accountId }, format: 'JSONEachRow',
      })
      const out: MoneyMarketPosition[]=[]
      for (const row of await current.json<{ pool_address: string; lb: number; ts: string; c: string; d: string; ab: string; lt: string; ltv: string; hf: string }>()) {
        if (row.c==='0' && row.d==='0') continue
        const market=MM_MARKET_BY_POOL.get(row.pool_address.toLowerCase())
        if (!market) continue
        out.push({
          ...moneyMarketFields(market),blockHeight:row.lb,timestamp:row.ts,
          totalCollateralBase:row.c,totalSuppliedBase:row.c,totalDebtBase:row.d,
          availableBorrowsBase:row.ab,liquidationThreshold:row.lt,ltv:row.ltv,
          healthFactor:row.hf===MAX_UINT256?'inf':row.hf,
        })
      }
      return orderMoneyMarkets(out)
    }
    const res = await client.query({
      query: `SELECT pool_address, max(block_height) AS lb, toString(argMax(block_timestamp, ${moneyMarketPositionOrderSql()})) AS ts,
                argMax(total_collateral_base, ${moneyMarketPositionOrderSql()}) AS c, argMax(total_debt_base, ${moneyMarketPositionOrderSql()}) AS d,
                argMax(available_borrows_base, ${moneyMarketPositionOrderSql()}) AS ab, argMax(current_liquidation_threshold, ${moneyMarketPositionOrderSql()}) AS lt,
                argMax(ltv, ${moneyMarketPositionOrderSql()}) AS ltv, argMax(health_factor, ${moneyMarketPositionOrderSql()}) AS hf
              FROM price_data.raw_money_market_positions
              WHERE user_address = {h:String} GROUP BY pool_address`,
      query_params: { h: h160.toLowerCase() }, format: 'JSONEachRow',
    })
    const out: MoneyMarketPosition[] = []
    for (const r of await res.json<{ pool_address: string; lb: number; ts: string; c: string; d: string; ab: string; lt: string; ltv: string; hf: string }>()) {
      const collateral = r.c || '0', debt = r.d || '0'
      if (collateral === '0' && debt === '0') continue  // no position in this market
      const m = MM_MARKET_BY_POOL.get((r.pool_address ?? '').toLowerCase())
      if (!m) continue
      out.push({
        ...moneyMarketFields(m),
        blockHeight: r.lb, timestamp: r.ts,
        totalCollateralBase: collateral, totalSuppliedBase: collateral, totalDebtBase: debt, availableBorrowsBase: r.ab || '0',
        liquidationThreshold: r.lt || '0', ltv: r.ltv || '0',
        healthFactor: r.hf === MAX_UINT256 ? 'inf' : (r.hf || 'inf'),
      })
    }
    return orderMoneyMarkets(out)
  })
}

// Per-reserve money-market balances reconstructed from indexed aToken/vDebt
// anchors and event deltas. Reused by account/tag positions and Hollar metrics.
export interface MmReserve {
  assetId: number
  iconAssetId?: number
  symbol: string
  decimals: number
  parachainId?: number | null
  origin?: AssetRef['origin']
  supplied: string
  debt: string
  suppliedUsd: number | null
  debtUsd: number | null
  collateral: boolean
  marketKey?: string
}

// Fold money-market reserves like wallet balances: a pool-share reserve (Hydration's
// money market uses the 2-Pool tokens, e.g. 2-Pool-GETH / 2-Pool-HUSDC) is shown as
// its underlying main asset (GETH / HUSDC), rescaling the supplied/debt amounts to
// the underlying's decimals. USD values are unchanged (the share token is priced via
// its underlying); reserves that fold to the same id merge. DISPLAY only — apply
// AFTER MM collateral is folded into wallet balances, since that step matches on the
// unfolded reserve id (folding first would overwrite the wallet's own pool holding).
export function foldShareReserves(reserves: MmReserve[]): MmReserve[] {
  if (!reserves.some(r => displayAssetId(r.assetId) !== r.assetId)) return reserves
  const byId = new Map<number, MmReserve>()
  for (const r of reserves) {
    const did = displayAssetId(r.assetId)
    const d = did === r.assetId ? null : asset(did)
    const supplied = d ? rescaleRaw(r.supplied, r.decimals, d.decimals) : r.supplied
    const debt = d ? rescaleRaw(r.debt, r.decimals, d.decimals) : r.debt
    const cur = byId.get(did)
    if (!cur) byId.set(did, d ? {
      ...r,
      assetId: did,
      iconAssetId: d.iconAssetId,
      symbol: d.symbol,
      decimals: d.decimals,
      parachainId: d.parachainId,
      origin: d.origin,
      supplied,
      debt,
    } : { ...r })
    else {
      cur.supplied = (BigInt(cur.supplied) + BigInt(supplied)).toString()
      cur.debt = (BigInt(cur.debt) + BigInt(debt)).toString()
      cur.suppliedUsd = (cur.suppliedUsd ?? 0) + (r.suppliedUsd ?? 0)
      cur.debtUsd = (cur.debtUsd ?? 0) + (r.debtUsd ?? 0)
      cur.collateral = cur.collateral || r.collateral
    }
  }
  return [...byId.values()].sort((a, b) => (b.suppliedUsd ?? b.debtUsd ?? 0) - (a.suppliedUsd ?? a.debtUsd ?? 0))
}
// Reserve set, per-account balances, and totals come from the indexed anchor table
// and event deltas. The shared reserve configuration is cached and reused by the
// per-account reserve read and aToken holder derivation.
export interface MmReserveToken { asset: string; aToken: string; vDebt: string; poolProxy: string; marketKey: string }
// Reserve → aToken/vDebt/pool map from atoken_reserve_map, refreshed by
// snapshot-atoken-anchors.ts from on-chain reserve data.
async function getMmReserveTokens(): Promise<MmReserveToken[]> {
  return cached('explorer:mm-reserve-tokens', 60000, async () => {
    const res = await client.query({
      query: `SELECT asset_address, pool_proxy,
                     argMax(atoken, updated_at) AS atoken, argMax(vdebt, updated_at) AS vdebt,
                     argMax(market_key, updated_at) AS market_key
              FROM price_data.atoken_reserve_map GROUP BY pool_proxy, asset_address`,
      format: 'JSONEachRow',
    })
    return (await res.json<{ asset_address: string; atoken: string; vdebt: string; pool_proxy: string; market_key: string }>())
      .filter(r => MM_MARKET_BY_POOL.get(r.pool_proxy.toLowerCase())?.key === (r.market_key || 'core'))
      .map(r => ({ asset: r.asset_address, aToken: r.atoken, vDebt: r.vdebt, poolProxy: r.pool_proxy, marketKey: r.market_key || 'core' }))
  })
}

// aToken / variable-debt scaled-balance reconstruction (no per-request RPC)
// balance = ( scaled_anchor@B0 + Σ scaled_delta(events, block > B0) ) · index_now / RAY.
// See clickhouse/schema/041_atoken_anchors.sql. B0 is read from the anchor table so a
// re-anchor at a new block is picked up automatically; 0 ⇒ anchor missing (guard).
const ATOKEN_RAY = 10n ** 27n

async function aTokenAnchorBlock(): Promise<number> {
  return cached('explorer:atoken-b0', 60000, async () => {
    const res = await client.query({ query: `SELECT max(anchor_block) AS b0 FROM price_data.atoken_scaled_anchor`, format: 'JSONEachRow' })
    return Number((await res.json<{ b0: number | null }>())[0]?.b0 ?? 0)
  })
}

// Latest liquidityIndex + variableBorrowIndex per reserve (RAY units) for the final
// scaled→actual multiply, from indexed ReserveDataUpdated events.
async function reserveIndicesNow(): Promise<Map<string, { liq: bigint; vbi: bigint }>> {
  return cached('explorer:mm-reserve-indices', 30000, async () => {
    const res = await client.query({
      query: `SELECT pool_address AS pool, reserve_address AS reserve,
              toString(argMax(liquidity_index, tuple(block_height,event_index,ingested_at))) AS liq,
              toString(argMax(variable_borrow_index, tuple(block_height,event_index,ingested_at))) AS vbi
            FROM price_data.money_market_reserve_indices FINAL
            GROUP BY pool, reserve`,
      format: 'JSONEachRow',
    })
    const m = new Map<string, { liq: bigint; vbi: bigint }>()
    for (const r of await res.json<{ pool: string; reserve: string; liq: string; vbi: string }>())
      m.set(`${r.pool}:${r.reserve}`, { liq: BigInt(r.liq || '0'), vbi: BigInt(r.vbi || '0') })
    return m
  })
}

interface ATokenReserve {
  assetId: number
  token: MmReserveToken
  liquidityIndex: bigint
}

// Registry aToken id → active receipt-token contract. Both the
// directory summary and holder detail use this exact mapping and balance
// semantics; their independent cache windows only affect short-lived freshness.
async function getATokenReserves(): Promise<ATokenReserve[]> {
  return cached('explorer:atoken-reserves', 30000, async () => {
    const [tokens, indices] = await Promise.all([getMmReserveTokens(), reserveIndicesNow()])
    // Registered aTokens exist outside the primary market too (GIGAHDX is the
    // gigahdx market's aToken over stHDX). An underlying listed in several
    // markets would match its first reserve — none is today.
    const out: ATokenReserve[] = []
    for (const [aTokenId, underlyingId] of Object.entries(ATOKEN_UNDERLYING_ID)) {
      const reserveAddresses = new Set(mmReserveAddressForAsset(underlyingId).map(address => address.toLowerCase()))
      const token = tokens.find(candidate => reserveAddresses.has(candidate.asset.toLowerCase()))
      if (!token) continue
      const liquidityIndex = indices.get(`${token.poolProxy.toLowerCase()}:${token.asset.toLowerCase()}`)?.liq ?? 0n
      if (liquidityIndex <= 0n) continue
      out.push({ assetId: Number(aTokenId), token, liquidityIndex })
    }
    return out
  })
}

// Scaled balance per holder for ONE token contract (aToken or vDebt): anchor + Σ delta.
// Module/pallet accounts are included (caller filters them from a displayed list).
async function reconstructHolderScaled(contract: string, b0: number): Promise<{ holder: string; scaled: bigint }[]> {
  const deltaTable = 'price_data.atoken_scaled_deltas_by_contract'
  const res = await client.query({
    query: `
      SELECT holder, toString(sum(anchor) + sum(delta)) AS scaled FROM (
        SELECT holder, toInt256(scaled_balance) AS anchor, toInt256(0) AS delta
        FROM price_data.atoken_scaled_anchor FINAL
        WHERE contract_address = {c:String} AND holder != ''
        UNION ALL
        SELECT holder, toInt256(0) AS anchor, sum(scaled_delta) AS delta
        FROM ${deltaTable} FINAL
        WHERE contract_address = {c:String} AND block_height > {b0:UInt32}
        GROUP BY holder
      ) GROUP BY holder HAVING (sum(anchor) + sum(delta)) > 0`,
    query_params: { c: contract.toLowerCase(), b0 }, format: 'JSONEachRow',
  })
  return (await res.json<{ holder: string; scaled: string }>()).map(r => ({ holder: r.holder.toLowerCase(), scaled: BigInt(r.scaled) }))
}

// Current positive holder counts for multiple aToken contracts in one scan.
// This is the count-only equivalent of reconstructHolderScaled: the same
// anchor/delta fold and module-account exclusion, without materializing every
// holder or enriching account identities for the asset directory.
export async function reconstructATokenHolderCounts(
  db: ClickHouseClient,
  contracts: string[],
  b0: number,
): Promise<Map<string, number>> {
  const normalized = [...new Set(contracts.map(contract => contract.toLowerCase()).filter(contract => /^0x[0-9a-f]{40}$/.test(contract)))]
  if (!normalized.length) return new Map()
  const deltaTable = 'price_data.atoken_scaled_deltas_by_contract'
  const res = await db.query({
    query: `
      SELECT contract, count() AS holders
      FROM (
        SELECT contract, holder, sum(anchor) + sum(delta) AS scaled
        FROM (
          SELECT lower(contract_address) AS contract, lower(holder) AS holder,
            toInt256(scaled_balance) AS anchor, toInt256(0) AS delta
          FROM price_data.atoken_scaled_anchor FINAL
          WHERE contract_address IN ({contracts:Array(String)}) AND holder != ''
          UNION ALL
          SELECT contract_address AS contract, holder, toInt256(0) AS anchor,
            sum(scaled_delta) AS delta
          FROM ${deltaTable} FINAL
          WHERE contract_address IN ({contracts:Array(String)}) AND block_height > {b0:UInt32}
          GROUP BY contract, holder
        )
        GROUP BY contract, holder
        HAVING scaled > 0 AND NOT startsWith(holder, '0x6d6f646c')
      ) GROUP BY contract`,
    query_params: { contracts: normalized, b0 },
    format: 'JSONEachRow',
    // Folding all core aToken contracts in one pass avoids rescanning the large
    // log table once per token. Spill aggregation state early so this directory
    // summary stays well below the API's normal per-query memory ceiling.
    clickhouse_settings: {
      max_threads: 4,
      max_memory_usage: '3000000000',
      max_bytes_before_external_group_by: '500000000',
    },
  })
  const counts = new Map<string, number>()
  for (const row of await res.json<{ contract: string; holders: string | number }>()) {
    const count = Number(row.holders)
    if (Number.isSafeInteger(count) && count >= 0) counts.set(row.contract.toLowerCase(), count)
  }
  return counts
}

// GIGAHDX market totals for the HDX dashboard: per-reserve supplied/debt from
// the scaled-total reconstruction × current indices, plus holder counts. stHDX
// has no market price of its own — it's staked HDX, valued at the HDX price.
export interface GigaMarketReserveStat { asset: AssetRef; supplied: number; suppliedUsd: number | null; debt: number; debtUsd: number | null; suppliers: number; borrowers: number }
export async function getGigaMarketStats(): Promise<GigaMarketReserveStat[] | null> {
  return cached('explorer:giga-market-stats', 300_000, async () => {
    const b0 = await aTokenAnchorBlock()
    if (!b0) return null
    const tokens = (await getMmReserveTokens()).filter(t => t.marketKey === 'gigahdx')
    if (!tokens.length) return null
    const contracts = tokens.flatMap(t => [t.aToken, t.vDebt])
    const [indices, totals, counts, prices] = await Promise.all([
      reserveIndicesNow(), reconstructTotalScaled(contracts, b0),
      reconstructATokenHolderCounts(client, contracts, b0), ensurePrices(),
    ])
    const out: GigaMarketReserveStat[] = []
    for (const t of tokens) {
      const idx = indices.get(`${t.poolProxy.toLowerCase()}:${t.asset.toLowerCase()}`)
      const assetId = assetIdFromMmAddress(t.asset)
      if (!idx || assetId == null) continue
      const reg = asset(assetId)
      const dec = 10 ** (reg.decimals ?? 12)
      const supplied = Number((totals.get(t.aToken.toLowerCase()) ?? 0n) * idx.liq / ATOKEN_RAY) / dec
      const debt = Number((totals.get(t.vDebt.toLowerCase()) ?? 0n) * idx.vbi / ATOKEN_RAY) / dec
      const price = prices.get(assetId)?.price ?? (assetId === 670 ? prices.get(0)?.price : undefined)
      out.push({
        asset: reg,
        supplied, suppliedUsd: price != null ? supplied * price : null,
        debt, debtUsd: price != null ? debt * price : null,
        suppliers: counts.get(t.aToken.toLowerCase()) ?? 0,
        borrowers: counts.get(t.vDebt.toLowerCase()) ?? 0,
      })
    }
    return out.length ? out : null
  })
}

// GIGAHDX liquidation levels. In this isolated market ALL collateral is
// HDX-priced (stHDX) and all debt is a $1-stable (HOLLAR), so the health
// factor falls linearly with the HDX price and a position crosses HF = 1 at
// exactly currentPrice / HF. Positions already below HF 1 keep their (higher)
// derived price -- the chart clamps them into its top bucket.
export interface GigaLiquidationPoint { price: number; stHdx: number }
interface GigaPositionRow { total_collateral_base: string; total_debt_base: string; health_factor: string }
export function liquidationPointsFromPositions(rows: GigaPositionRow[], currentPrice: number): GigaLiquidationPoint[] {
  const out: GigaLiquidationPoint[] = []
  if (!(currentPrice > 0)) return out
  for (const r of rows) {
    const debt = Number(r.total_debt_base)
    const collateralUsd = Number(r.total_collateral_base) / 1e8
    const hf = Number(r.health_factor) / 1e18
    if (!(debt > 0) || !(collateralUsd > 0) || !Number.isFinite(hf) || hf <= 0) continue
    out.push({ price: currentPrice / hf, stHdx: collateralUsd / currentPrice })
  }
  return out.sort((a, b) => a.price - b.price)
}

export interface GigaLiquidations { currentPrice: number; points: GigaLiquidationPoint[] }
export async function getGigaLiquidationLevels(): Promise<GigaLiquidations | null> {
  return cached('explorer:giga-liquidations', 300_000, async () => {
    const pool = (await getMmReserveTokens()).find(t => t.marketKey === 'gigahdx')?.poolProxy
    const currentPrice = (await ensurePrices()).get(0)?.price
    if (!pool || !(currentPrice != null && currentPrice > 0)) return null
    // Latest snapshot per borrower; the snapshot loop keeps these current.
    const res = await client.query({
      query: `SELECT argMax(total_collateral_base, ${moneyMarketPositionOrderSql()}) AS total_collateral_base,
                     argMax(total_debt_base, ${moneyMarketPositionOrderSql()}) AS total_debt_base,
                     argMax(health_factor, ${moneyMarketPositionOrderSql()}) AS health_factor
              FROM price_data.raw_money_market_positions
              WHERE lower(pool_address) = {pool:String}
              GROUP BY user_address
              HAVING toFloat64OrZero(total_debt_base) > 0`,
      query_params: { pool: pool.toLowerCase() }, format: 'JSONEachRow',
    })
    const points = liquidationPointsFromPositions(await res.json<GigaPositionRow>(), currentPrice)
    return points.length ? { currentPrice, points } : null
  })
}

// totalSupply (scaled) for every requested contract: holder='' anchor +
// Σ (Mint − Burn) after B0. BalanceTransfer nets to zero across holders. Keeping
// all reserve contracts in one query avoids repeatedly scanning raw_evm_logs.
async function reconstructTotalScaled(contracts: string[], b0: number): Promise<Map<string, bigint>> {
  const normalized = [...new Set(contracts.map(c => c.toLowerCase()).filter(c => /^0x[0-9a-f]{40}$/.test(c)))]
  if (!normalized.length) return new Map()
  const deltaTable = 'price_data.atoken_scaled_deltas_by_contract'
  const res = await client.query({
    query: `
      SELECT contract, toString(sum(anchor) + sum(delta)) AS scaled
      FROM (
        SELECT contract_address AS contract,
          toInt256(argMax(scaled_balance, updated_at)) AS anchor,
          toInt256(0) AS delta
        FROM price_data.atoken_scaled_anchor
        WHERE holder = '' AND contract_address IN ({contracts:Array(String)})
        GROUP BY contract
        UNION ALL
        SELECT contract_address AS contract, toInt256(0) AS anchor,
          sum(scaled_delta) AS delta
        FROM ${deltaTable} FINAL
        WHERE contract_address IN ({contracts:Array(String)}) AND block_height > {b0:UInt32}
        GROUP BY contract
      ) GROUP BY contract`,
    query_params: { contracts: normalized, b0 }, format: 'JSONEachRow',
  })
  const totals = new Map<string, bigint>()
  for (const row of await res.json<{ contract: string; scaled: string }>()) {
    totals.set(row.contract.toLowerCase(), BigInt(row.scaled || '0'))
  }
  return totals
}

// Scaled balance per token contract for ONE account (aToken supplied + vDebt debt),
// bounded to the account's own events via has(participants, h).
async function reconstructAccountScaled(h160: string, b0: number): Promise<Map<string, bigint>> {
  const h = h160.toLowerCase()
  const res = await client.query({
    query: `
      SELECT contract, toString(sum(anchor) + sum(delta)) AS scaled FROM (
        SELECT lower(contract_address) AS contract, toInt256(scaled_balance) AS anchor, toInt256(0) AS delta
        FROM price_data.atoken_scaled_anchor FINAL WHERE holder = {h:String}
        UNION ALL
        SELECT contract_address AS contract, toInt256(0) AS anchor, sum(scaled_delta) AS delta
        FROM price_data.atoken_scaled_deltas FINAL
        WHERE holder = {h:String} AND block_height > {b0:UInt32}
        GROUP BY contract
      ) GROUP BY contract HAVING (sum(anchor) + sum(delta)) > 0`,
    query_params: { h, b0 }, format: 'JSONEachRow',
  })
  const m = new Map<string, bigint>()
  for (const r of await res.json<{ contract: string; scaled: string }>()) m.set(r.contract.toLowerCase(), BigInt(r.scaled))
  return m
}

// Per-reserve supplied (aToken) and debt (vDebt), reconstructed from the anchor
// and indexed event deltas without request-time RPC.
export async function getMoneyMarketReserves(h160: string): Promise<MmReserve[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(h160)) return []
  return cached(`explorer:mm-reserves:${accountValueGenerationEpoch}:${h160.toLowerCase()}`, 15000, async () => {
    const accountId=evmAccountIdFromAddress(h160.toLowerCase())
    if (moneyMarketAccountValuesReady && accountId) {
      const [prices,result]=await Promise.all([
        ensureAccountValuePrices(),
        client.query({
          query: `SELECT market_key,asset_id,toString(supplied) AS supplied,toString(debt) AS debt
            FROM price_data.money_market_account_value_snapshots
            WHERE snapshot_id=(SELECT argMax(snapshot_id,computed_at)
              FROM price_data.money_market_account_value_snapshot_state WHERE snapshot_key='current')
              AND account_id={accountId:String} AND reserve_present=1`,
          query_params:{accountId},format:'JSONEachRow',
        }),
      ])
      const out: MmReserve[]=[]
      for (const row of await result.json<{ market_key:string;asset_id:number;supplied:string;debt:string }>()) {
        const underlying=asset(row.asset_id)
        const supplied=BigInt(row.supplied||'0')
        const displayId=supplied>0n ? UNDERLYING_TO_ATOKEN_ID[underlying.assetId] : undefined
        const display=displayId!=null ? asset(displayId) : underlying
        out.push({
          assetId:display.assetId,symbol:display.symbol,decimals:underlying.decimals,
          iconAssetId:display.iconAssetId,parachainId:display.parachainId,origin:display.origin,
          supplied:row.supplied,debt:row.debt,
          suppliedUsd:usdValue(prices,underlying.assetId,row.supplied,underlying.decimals),
          debtUsd:usdValue(prices,underlying.assetId,row.debt,underlying.decimals),
          collateral:supplied>0n,marketKey:row.market_key,
        })
      }
      return out.sort((a,b)=>(b.suppliedUsd??b.debtUsd??0)-(a.suppliedUsd??a.debtUsd??0))
    }
    const b0 = await aTokenAnchorBlock()
    if (!b0) return []
    const [prices, tokens, indices, byContract] = await Promise.all([
      ensureAccountValuePrices(), getMmReserveTokens(), reserveIndicesNow(), reconstructAccountScaled(h160, b0),
    ])
    if (!byContract.size || !tokens.length) return []
    const out: MmReserve[] = []
    for (const t of tokens) {
      const resIdx = indices.get(`${t.poolProxy.toLowerCase()}:${t.asset.toLowerCase()}`)
      if (!resIdx) continue
      const aScaled = byContract.get(t.aToken.toLowerCase()) ?? 0n
      const dScaled = byContract.get(t.vDebt.toLowerCase()) ?? 0n
      const sup = aScaled > 0n ? (aScaled * resIdx.liq) / ATOKEN_RAY : 0n
      const dbt = dScaled > 0n ? (dScaled * resIdx.vbi) / ATOKEN_RAY : 0n
      if (sup <= 0n && dbt <= 0n) continue
      const underId = assetIdFromMmAddress(t.asset)
      const reg = underId != null ? asset(underId) : null
      const decimals = reg?.decimals ?? 18
      const p = reg ? prices.get(reg.assetId) : undefined
      // Label supplied collateral with the aToken the user holds (DOT→aDOT), matching
      // the Hydration wallet/borrow UI; debt stays the borrowed underlying.
      const aTokenId = sup > 0n && reg ? UNDERLYING_TO_ATOKEN_ID[reg.assetId] : undefined
      const disp = aTokenId != null ? asset(aTokenId) : null
      out.push({
        assetId: disp?.assetId ?? reg?.assetId ?? -1, symbol: disp?.symbol ?? (reg?.symbol ?? '?'), decimals,
        iconAssetId: disp?.iconAssetId ?? reg?.iconAssetId,
        parachainId: disp?.parachainId ?? reg?.parachainId ?? null,
        origin: disp?.origin ?? reg?.origin ?? null,
        supplied: sup.toString(), debt: dbt.toString(),
        suppliedUsd: p ? Number(sup) / 10 ** decimals * p.price : null,
        debtUsd: p ? Number(dbt) / 10 ** decimals * p.price : null,
        collateral: sup > 0n,
        marketKey: t.marketKey ?? 'core',
      })
    }
    return out.sort((a, b) => (b.suppliedUsd ?? b.debtUsd ?? 0) - (a.suppliedUsd ?? a.debtUsd ?? 0))
  })
}

// Batched form of reconstructAccountScaled: current scaled aToken/vDebt balances
// for MANY holders in a single raw_evm_logs scan (anchor@B0 + Σ post-B0 deltas).
// Used by the accounts-directory top-holdings enrichment so one page costs one scan
// instead of one reconstruction per row. Returns holder → contract → scaled.
async function reconstructAccountsScaled(h160s: string[], b0: number): Promise<Map<string, Map<string, bigint>>> {
  const hs = [...new Set(h160s.map(h => h.toLowerCase()).filter(h => /^0x[0-9a-f]{40}$/.test(h)))]
  const out = new Map<string, Map<string, bigint>>()
  if (!hs.length || !b0) return out
  const res = await client.query({
    query: `
      SELECT holder, contract, toString(sum(anchor) + sum(delta)) AS scaled FROM (
        SELECT lower(holder) AS holder, lower(contract_address) AS contract,
          toInt256(scaled_balance) AS anchor, toInt256(0) AS delta
        FROM price_data.atoken_scaled_anchor FINAL WHERE lower(holder) IN {hs:Array(String)}
        UNION ALL
        SELECT holder, contract_address AS contract, toInt256(0) AS anchor,
          sum(scaled_delta) AS delta
        FROM price_data.atoken_scaled_deltas FINAL
        WHERE holder IN {hs:Array(String)} AND block_height > {b0:UInt32}
        GROUP BY holder, contract
      ) GROUP BY holder, contract HAVING (sum(anchor) + sum(delta)) > 0`,
    query_params: { hs, b0 }, format: 'JSONEachRow',
  })
  for (const r of await res.json<{ holder: string; contract: string; scaled: string }>()) {
    const h = r.holder.toLowerCase()
    const m = out.get(h) ?? out.set(h, new Map<string, bigint>()).get(h)!
    m.set(r.contract.toLowerCase(), BigInt(r.scaled))
  }
  return out
}

// Per-holder supplied-collateral (aToken) reserves for a bounded holder set, built
// from batched reconstruction — the batched twin of getMoneyMarketReserves, used to
// fold MM collateral into the accounts-directory top-holdings enrichment. Debt
// reserves are still emitted (collateral:false) but callers fold only supplied.
async function mmReservesByHolder(h160s: string[]): Promise<Map<string, MmReserve[]>> {
  const out = new Map<string, MmReserve[]>()
  const hs = [...new Set(h160s.map(h => h.toLowerCase()).filter(h => /^0x[0-9a-f]{40}$/.test(h)))]
  if (!hs.length) return out
  const b0 = await aTokenAnchorBlock()
  if (!b0) return out
  const [prices, tokens, indices] = await Promise.all([ensureAccountValuePrices(), getMmReserveTokens(), reserveIndicesNow()])
  // Reconstruct in small holder chunks: hasAny(participants, …) over the whole
  // raw_evm_logs table blows ClickHouse's per-query memory once the holder set is
  // large, so cap each scan's matched rows AND how many scans run at once.
  const CHUNK = 8
  const CHUNK_CONCURRENCY = 4
  const chunks: string[][] = []
  for (let i = 0; i < hs.length; i += CHUNK) chunks.push(hs.slice(i, i + CHUNK))
  const byHolder = new Map<string, Map<string, bigint>>()
  let nextChunk = 0
  const chunkWorker = async (): Promise<void> => {
    while (nextChunk < chunks.length) {
      const part = await reconstructAccountsScaled(chunks[nextChunk++], b0)
      for (const [h, m] of part) byHolder.set(h, m)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, chunkWorker))
  for (const [h, byContract] of byHolder) {
    const reserves: MmReserve[] = []
    for (const t of tokens) {
      const resIdx = indices.get(`${t.poolProxy.toLowerCase()}:${t.asset.toLowerCase()}`)
      if (!resIdx) continue
      const aScaled = byContract.get(t.aToken.toLowerCase()) ?? 0n
      const dScaled = byContract.get(t.vDebt.toLowerCase()) ?? 0n
      const sup = aScaled > 0n ? (aScaled * resIdx.liq) / ATOKEN_RAY : 0n
      const dbt = dScaled > 0n ? (dScaled * resIdx.vbi) / ATOKEN_RAY : 0n
      if (sup <= 0n && dbt <= 0n) continue
      const underId = assetIdFromMmAddress(t.asset)
      const reg = underId != null ? asset(underId) : null
      const decimals = reg?.decimals ?? 18
      const p = reg ? prices.get(reg.assetId) : undefined
      const aTokenId = sup > 0n && reg ? UNDERLYING_TO_ATOKEN_ID[reg.assetId] : undefined
      const disp = aTokenId != null ? asset(aTokenId) : null
      reserves.push({
        assetId: disp?.assetId ?? reg?.assetId ?? -1, symbol: disp?.symbol ?? (reg?.symbol ?? '?'), decimals,
        iconAssetId: disp?.iconAssetId ?? reg?.iconAssetId,
        parachainId: disp?.parachainId ?? reg?.parachainId ?? null,
        origin: disp?.origin ?? reg?.origin ?? null,
        supplied: sup.toString(), debt: dbt.toString(),
        suppliedUsd: p ? Number(sup) / 10 ** decimals * p.price : null,
        debtUsd: p ? Number(dbt) / 10 ** decimals * p.price : null,
        collateral: sup > 0n,
        marketKey: t.marketKey ?? 'core',
      })
    }
    if (reserves.length) out.set(h, reserves)
  }
  return out
}

export interface MoneyMarketScaledHolding {
  holder: string
  contract: string
  scaled: bigint
}

export interface LatestMoneyMarketAggregate {
  holder: string
  poolAddress: string
  marketKey: string
  totalCollateralBase: bigint
  totalDebtBase: bigint
  availableBorrowsBase: bigint
  liquidationThreshold: number
  ltv: bigint
  healthFactor: bigint
  blockHeight: number
  blockTimestamp: string
}

export interface MoneyMarketAccountValueClaim {
  accountId: string
  holder: string
  poolAddress: string
  marketKey: string
  reservePresent: boolean
  assetId: number
  supplied: bigint
  debt: bigint
  totalCollateralBase: bigint
  totalDebtBase: bigint
  availableBorrowsBase: bigint
  liquidationThreshold: number
  ltv: bigint
  healthFactor: bigint
  blockHeight: number
  blockTimestamp: string
}

// Convert a complete current scaled-balance generation into compact raw reserve
// claims. Aggregate Aave base values stay on one header row per account/market;
// reserve rows retain integer principal so request-time valuation can use the
// same current Explorer prices as account detail.
export function buildMoneyMarketAccountValueClaims(
  holdings: MoneyMarketScaledHolding[],
  tokens: MmReserveToken[],
  indices: Map<string, { liq: bigint; vbi: bigint }>,
  aggregates: LatestMoneyMarketAggregate[],
): MoneyMarketAccountValueClaim[] {
  const contractMap = new Map<string, { token: MmReserveToken; side: 'supplied' | 'debt' }>()
  for (const token of tokens) {
    const poolAddress = token.poolProxy.toLowerCase()
    const normalized = { ...token, asset: token.asset.toLowerCase(), poolProxy: poolAddress }
    for (const [contract, side] of [[token.aToken, 'supplied'], [token.vDebt, 'debt']] as const) {
      const key = contract.toLowerCase()
      if (contractMap.has(key)) throw new Error(`duplicate money-market reserve contract ${key}`)
      contractMap.set(key, { token: normalized, side })
    }
  }

  type ReserveClaim = { supplied: bigint; debt: bigint; token: MmReserveToken }
  const reserves = new Map<string, ReserveClaim>()
  const holderMarkets = new Set<string>()
  const seenHoldings = new Set<string>()
  for (const holding of holdings) {
    if (holding.scaled <= 0n) continue
    const holder = holding.holder.toLowerCase()
    const holdingKey = `${holder}|${holding.contract.toLowerCase()}`
    if (seenHoldings.has(holdingKey)) throw new Error(`duplicate money-market scaled holding ${holdingKey}`)
    seenHoldings.add(holdingKey)
    const mapped = contractMap.get(holding.contract.toLowerCase())
    if (!mapped) throw new Error(`unmapped positive money-market contract ${holding.contract}`)
    const idx = indices.get(`${mapped.token.poolProxy}:${mapped.token.asset}`)
    if (!idx) throw new Error(`missing money-market reserve index ${mapped.token.poolProxy}:${mapped.token.asset}`)
    const assetId = assetIdFromMmAddress(mapped.token.asset)
    if (assetId == null) throw new Error(`unmapped money-market reserve asset ${mapped.token.asset}`)
    const actual = holding.scaled * (mapped.side === 'supplied' ? idx.liq : idx.vbi) / ATOKEN_RAY
    const holderMarket = `${holder}|${mapped.token.poolProxy}`
    holderMarkets.add(holderMarket)
    if (actual <= 0n) continue
    const key = `${holderMarket}|${assetId}`
    const current = reserves.get(key) ?? { supplied: 0n, debt: 0n, token: mapped.token }
    current[mapped.side] += actual
    reserves.set(key, current)
  }

  const aggregateByHolderMarket = new Map<string, LatestMoneyMarketAggregate>()
  for (const aggregate of aggregates) {
    const holder = aggregate.holder.toLowerCase()
    const poolAddress = aggregate.poolAddress.toLowerCase()
    const key = `${holder}|${poolAddress}`
    if (aggregateByHolderMarket.has(key)) throw new Error(`duplicate money-market aggregate ${key}`)
    aggregateByHolderMarket.set(key, { ...aggregate, holder, poolAddress })
    holderMarkets.add(key)
  }

  const claims: MoneyMarketAccountValueClaim[] = []
  const sortedHolderMarkets = [...holderMarkets].sort()
  for (const holderMarket of sortedHolderMarkets) {
    const separator = holderMarket.lastIndexOf('|')
    const holder = holderMarket.slice(0, separator)
    const poolAddress = holderMarket.slice(separator + 1)
    const accountId = evmAccountIdFromAddress(holder)
    if (!accountId) throw new Error(`invalid money-market holder ${holder}`)
    const aggregate = aggregateByHolderMarket.get(holderMarket)
    const marketKey = aggregate?.marketKey ?? tokens.find(token => token.poolProxy.toLowerCase() === poolAddress)?.marketKey
    if (!marketKey) throw new Error(`unknown money-market pool ${poolAddress}`)
    claims.push({
      accountId, holder, poolAddress, marketKey, reservePresent: false, assetId: 0,
      supplied: 0n, debt: 0n,
      totalCollateralBase: aggregate?.totalCollateralBase ?? 0n,
      totalDebtBase: aggregate?.totalDebtBase ?? 0n,
      availableBorrowsBase: aggregate?.availableBorrowsBase ?? 0n,
      liquidationThreshold: aggregate?.liquidationThreshold ?? 0,
      ltv: aggregate?.ltv ?? 0n, healthFactor: aggregate?.healthFactor ?? 0n,
      blockHeight: aggregate?.blockHeight ?? 0,
      blockTimestamp: aggregate?.blockTimestamp ?? '1970-01-01 00:00:00',
    })
    const prefix = `${holderMarket}|`
    for (const [key, reserve] of [...reserves.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))) {
      const assetId = Number(key.slice(prefix.length))
      claims.push({
        accountId, holder, poolAddress, marketKey, reservePresent: true, assetId,
        supplied: reserve.supplied, debt: reserve.debt,
        totalCollateralBase: 0n, totalDebtBase: 0n, availableBorrowsBase: 0n,
        liquidationThreshold: 0, ltv: 0n, healthFactor: 0n,
        blockHeight: 0, blockTimestamp: '1970-01-01 00:00:00',
      })
    }
  }
  return claims
}

// Position snapshots can be emitted several times in one block. Event-derived
// observations order by their event index; a periodic full-block observation is
// state after all events and therefore wins the same-block tie. Ingest time only
// resolves a replay of the same stable observation identity.
function moneyMarketPositionOrderSql(prefix = ''): string {
  const observation = `${prefix}observation_id`
  return `tuple(${prefix}block_height,
    if(startsWith(${observation}, 'money-market-periodic:'), toUInt32(4294967295),
      toUInt32OrZero(arrayElement(splitByChar(':', ${observation}), 3))),
    ${observation}, ${prefix}ingested_at)`
}

async function reconstructAllActiveMoneyMarketScaled(
  contracts: string[],
  anchorBlock: number,
): Promise<MoneyMarketScaledHolding[]> {
  const normalized = [...new Set(contracts.map(contract => contract.toLowerCase()))]
  if (!normalized.length || !anchorBlock) return []
  const result = await client.query({
    query: `SELECT holder,contract,toString(sum(anchor)+sum(delta)) AS scaled
      FROM (
        SELECT lower(holder) AS holder,lower(contract_address) AS contract,
          toInt256(argMax(scaled_balance,updated_at)) AS anchor,toInt256(0) AS delta
        FROM price_data.atoken_scaled_anchor FINAL
        WHERE holder!='' AND lower(contract_address) IN {contracts:Array(String)}
        GROUP BY holder,contract
        UNION ALL
        SELECT holder,contract_address AS contract,toInt256(0) AS anchor,
          sum(scaled_delta) AS delta
        FROM price_data.atoken_scaled_deltas FINAL
        WHERE block_height>{anchorBlock:UInt32} AND contract_address IN {contracts:Array(String)}
        GROUP BY holder,contract
      )
      GROUP BY holder,contract HAVING sum(anchor)+sum(delta)>0`,
    query_params: { contracts: normalized, anchorBlock }, format: 'JSONEachRow',
  })
  return (await result.json<{ holder: string; contract: string; scaled: string }>()).map(row => ({
    holder: row.holder, contract: row.contract, scaled: BigInt(row.scaled),
  }))
}

async function loadAllLatestMoneyMarketAggregates(): Promise<LatestMoneyMarketAggregate[]> {
  const order = moneyMarketPositionOrderSql()
  const result = await client.query({
    query: `SELECT lower(user_address) AS holder,lower(pool_address) AS pool,
        toString(argMax(toUInt256OrZero(total_collateral_base),${order})) AS collateral,
        toString(argMax(toUInt256OrZero(total_debt_base),${order})) AS debt,
        toString(argMax(toUInt256OrZero(available_borrows_base),${order})) AS available_borrows,
        toUInt32(argMax(toUInt256OrZero(current_liquidation_threshold),${order})) AS liquidation_threshold,
        toString(argMax(toUInt256OrZero(ltv),${order})) AS ltv,
        toString(argMax(toUInt256OrZero(health_factor),${order})) AS health_factor,
        argMax(block_height,${order}) AS latest_block,
        toString(argMax(block_timestamp,${order})) AS latest_timestamp
      FROM price_data.raw_money_market_positions
      WHERE user_address!='' AND lower(pool_address) IN (${configuredMmPoolsSql()})
      GROUP BY holder,pool
      HAVING toUInt256OrZero(collateral)>0 OR toUInt256OrZero(debt)>0`,
    format: 'JSONEachRow',
  })
  return (await result.json<{ holder: string; pool: string; collateral: string; debt: string; available_borrows: string; liquidation_threshold: number; ltv: string; health_factor: string; latest_block: number; latest_timestamp: string }>()).map(row => {
    const market = MM_MARKET_BY_POOL.get(row.pool)
    if (!market) throw new Error(`unknown configured money-market pool ${row.pool}`)
    return {
      holder: row.holder, poolAddress: row.pool, marketKey: market.key,
      totalCollateralBase: BigInt(row.collateral || '0'), totalDebtBase: BigInt(row.debt || '0'),
      availableBorrowsBase: BigInt(row.available_borrows || '0'),
      liquidationThreshold: Number(row.liquidation_threshold || 0),
      ltv: BigInt(row.ltv || '0'), healthFactor: BigInt(row.health_factor || '0'),
      blockHeight: Number(row.latest_block || 0), blockTimestamp: row.latest_timestamp,
    }
  })
}

const MONEY_MARKET_ACCOUNT_VALUES_REFRESH_MS = 5 * 60_000
let moneyMarketAccountValuesRefreshTimer: ReturnType<typeof setInterval> | null = null
let moneyMarketAccountValuesRefreshInflight: Promise<void> | null = null

export async function moneyMarketAccountValueSnapshotReady(): Promise<boolean> {
  try {
    const result = await client.query({
      query: `WITH current AS (
          SELECT argMax(snapshot_id,computed_at) AS snapshot_id,
            argMax(claim_count,computed_at) AS claim_count
          FROM price_data.money_market_account_value_snapshot_state
          WHERE snapshot_key='current'
        )
        SELECT current.snapshot_id AS snapshot_id,current.claim_count AS claim_count,
          count(c.account_id) AS stored_count,
          uniqExact((c.account_id,c.pool_address,c.reserve_present,c.asset_id)) AS unique_count
        FROM current
        LEFT JOIN price_data.money_market_account_value_snapshots c ON c.snapshot_id=current.snapshot_id
        GROUP BY current.snapshot_id,current.claim_count`,
      format: 'JSONEachRow',
    })
    const row = (await result.json<{ snapshot_id: string; claim_count: number; stored_count: string; unique_count: string }>())[0]
    return Boolean(row?.snapshot_id)
      && Number(row.claim_count) === Number(row.stored_count)
      && Number(row.stored_count) === Number(row.unique_count)
  } catch { return false }
}

async function refreshMoneyMarketAccountValuesUncached(): Promise<void> {
  const [anchorBlock, tokens, indices, aggregates] = await Promise.all([
    aTokenAnchorBlock(), getMmReserveTokens(), reserveIndicesNow(), loadAllLatestMoneyMarketAggregates(),
  ])
  if (!anchorBlock || !tokens.length) throw new Error('money-market anchor or reserve map missing')
  const holdings = await reconstructAllActiveMoneyMarketScaled(tokens.flatMap(token => [token.aToken, token.vDebt]), anchorBlock)
  const claims = buildMoneyMarketAccountValueClaims(holdings, tokens, indices, aggregates)
  if (!claims.length) throw new Error('money-market account value generation is empty')

  const snapshotId = String(Date.now())
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const checksum = createHash('sha256')
  for (const claim of claims) {
    checksum.update(`${claim.accountId}|${claim.poolAddress}|${claim.reservePresent ? 1 : 0}|${claim.assetId}|${claim.supplied}|${claim.debt}|${claim.totalCollateralBase}|${claim.totalDebtBase}|${claim.availableBorrowsBase}|${claim.liquidationThreshold}|${claim.ltv}|${claim.healthFactor}|${claim.blockHeight}|${claim.blockTimestamp}\n`)
  }
  const batchSize = 1_000
  for (let offset = 0; offset < claims.length; offset += batchSize) {
    await client.insert({
      table: 'price_data.money_market_account_value_snapshots',
      values: claims.slice(offset,offset + batchSize).map(claim => ({
        snapshot_id: snapshotId, account_id: claim.accountId, holder: claim.holder,
        pool_address: claim.poolAddress, market_key: claim.marketKey,
        reserve_present: claim.reservePresent ? 1 : 0, asset_id: claim.assetId,
        supplied: claim.supplied.toString(), debt: claim.debt.toString(),
        total_collateral_base: claim.totalCollateralBase.toString(),
        total_debt_base: claim.totalDebtBase.toString(), available_borrows_base: claim.availableBorrowsBase.toString(),
        liquidation_threshold: claim.liquidationThreshold, ltv: claim.ltv.toString(),
        health_factor: claim.healthFactor.toString(), block_height: claim.blockHeight,
        block_timestamp: claim.blockTimestamp,
        computed_at: now,
      })),
      format: 'JSONEachRow',
    })
  }
  const verify = await client.query({
    query: `SELECT count() AS c,uniqExact((account_id,pool_address,reserve_present,asset_id)) AS u
      FROM price_data.money_market_account_value_snapshots WHERE snapshot_id={snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  const counts = (await verify.json<{ c: string; u: string }>())[0]
  if (Number(counts?.c) !== claims.length || Number(counts?.u) !== claims.length) {
    throw new Error(`incomplete money-market account value generation ${counts?.c ?? 0}/${claims.length}`)
  }
  // Prices and raw principal publish as one account-value generation. General
  // Explorer prices may continue refreshing every 30 seconds, but account list
  // and detail stay pinned together until the next bounded five-minute rebuild.
  const nextAccountValuePrices = new Map(await loadFreshPrices())
  await client.insert({
    table: 'price_data.money_market_account_value_snapshot_state',
    values: [{
      snapshot_key: 'current', snapshot_id: snapshotId,
      source_holding_count: holdings.length, source_position_count: aggregates.length,
      claim_count: claims.length, source_checksum: checksum.digest('hex'), computed_at: now,
    }],
    format: 'JSONEachRow',
  })
  accountValuePriceMap = nextAccountValuePrices
  accountValueGenerationEpoch++
  if (!(await moneyMarketAccountValueSnapshotReady())) throw new Error('published money-market account value generation failed parity check')
  setMoneyMarketAccountValuesReady()

  const parts = await client.query({
    query: `SELECT DISTINCT partition FROM system.parts
      WHERE database='price_data' AND table='money_market_account_value_snapshots'
        AND active AND partition!={snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  for (const row of await parts.json<{ partition: string }>()) {
    await client.command({
      query: `ALTER TABLE price_data.money_market_account_value_snapshots DROP PARTITION {partition:String}`,
      query_params: { partition: row.partition },
    })
  }

  // v1/v2 payloads use aggregate-oracle MM value and can no longer serve once
  // both exact LP and reserve-principal generations are available.
  if (omnipoolAccountClaimsReady) {
    const legacy = await client.query({
      query: `SELECT count() AS c FROM price_data.account_directory_snapshots
        WHERE startsWith(snapshot_key,'v1:') OR startsWith(snapshot_key,'v2:')`,
      format: 'JSONEachRow',
    })
    if (Number((await legacy.json<{ c: string }>())[0]?.c ?? 0)>0) {
      await client.command({
        query: `ALTER TABLE price_data.account_directory_snapshots
          DELETE WHERE startsWith(snapshot_key,'v1:') OR startsWith(snapshot_key,'v2:')`,
        clickhouse_settings: { mutations_sync: '1' },
      })
    }
  }
}

export function refreshMoneyMarketAccountValues(): Promise<void> {
  if (moneyMarketAccountValuesRefreshInflight) return moneyMarketAccountValuesRefreshInflight
  const request = refreshMoneyMarketAccountValuesUncached().finally(() => {
    if (moneyMarketAccountValuesRefreshInflight===request) moneyMarketAccountValuesRefreshInflight=null
  })
  moneyMarketAccountValuesRefreshInflight=request
  return request
}

export function startMoneyMarketAccountValuesRefresh(): void {
  if (moneyMarketAccountValuesRefreshTimer) return
  moneyMarketAccountValuesRefreshTimer=setInterval(() => {
    void refreshMoneyMarketAccountValues().catch(error => console.error('[accounts] money-market value refresh failed',error))
  },MONEY_MARKET_ACCOUNT_VALUES_REFRESH_MS)
  moneyMarketAccountValuesRefreshTimer.unref()
}

function usdBase8(value: number): string {
  return Number.isFinite(value) && value > 0 ? BigInt(Math.round(value * 1e8)).toString() : '0'
}

function maxBase8(a: string, b: string): string {
  try {
    return BigInt(b || '0') > BigInt(a || '0') ? b : a
  } catch {
    return a || '0'
  }
}

function reserveUsdTotal(reserves: MmReserve[], prices: Map<number, PriceInfo>, side: 'supplied' | 'debt'): number {
  return reserves.reduce((sum, r) => {
    const raw = side === 'supplied' ? r.supplied : r.debt
    if (raw === '0' || r.assetId < 0) return sum
    const cachedUsd = side === 'supplied' ? r.suppliedUsd : r.debtUsd
    return sum + (cachedUsd ?? usdValue(prices, r.assetId, raw, r.decimals) ?? 0)
  }, 0)
}

// Aave's aggregate collateral value uses its oracle even when the explorer has
// no standalone price for the reserve (currently stHDX). If exactly one supplied
// reserve is unpriced, the aggregate's unexplained remainder is that row's value;
// surfacing it avoids a misleading dash without inventing a cross-asset split.
export function valueSingleUnpricedSupply(reserves: MmReserve[], collateralBase: string): MmReserve[] {
  const supplied = reserves.filter(reserve => reserve.supplied !== '0')
  const unpriced = reserves.filter(reserve => reserve.supplied !== '0' && reserve.suppliedUsd == null)
  // The aggregate excludes non-collateral supply. Without per-user collateral
  // flags we can infer the remainder only when this is the sole supplied asset.
  if (supplied.length !== 1 || unpriced.length !== 1) return reserves
  const aggregateUsd = Number(collateralBase || '0') / 1e8
  const pricedUsd = reserves.reduce((sum, reserve) => sum + (reserve.suppliedUsd ?? 0), 0)
  const remainder = aggregateUsd - pricedUsd
  if (!(remainder > 0) || !Number.isFinite(remainder)) return reserves
  return reserves.map(reserve => reserve === unpriced[0] ? { ...reserve, suppliedUsd: remainder } : reserve)
}

function attachMmReserves(pos: MoneyMarketPosition, reserves: MmReserve[], prices: Map<number, PriceInfo>): MoneyMarketPosition {
  // Reserve balances capture all supplied aTokens, including assets that are not
  // enabled as collateral. Keep that display total separate: overwriting Aave's
  // eligible collateral would understate current LTV and liquidation risk.
  const valuedReserves = valueSingleUnpricedSupply(reserves, pos.totalCollateralBase)
  const suppliedBase = usdBase8(reserveUsdTotal(valuedReserves, prices, 'supplied'))
  const debtBase = usdBase8(reserveUsdTotal(valuedReserves, prices, 'debt'))
  return {
    ...pos,
    totalSuppliedBase: maxBase8(pos.totalSuppliedBase ?? pos.totalCollateralBase, suppliedBase),
    totalDebtBase: maxBase8(pos.totalDebtBase, debtBase),
    reserves: valuedReserves,
  }
}

function moneyMarketFromReserves(marketKey: string, reserves: MmReserve[], prices: Map<number, PriceInfo>): MoneyMarketPosition {
  const market = MM_MARKET_BY_KEY.get(marketKey)
  const suppliedBase = usdBase8(reserveUsdTotal(reserves, prices, 'supplied'))
  const debtBase = usdBase8(reserveUsdTotal(reserves, prices, 'debt'))
  return {
    ...(market ? moneyMarketFields(market) : {
      marketKey, market: marketKey, role: 'supplemental' as const, defiSimSupported: false, stakingBacked: false,
    }),
    blockHeight: 0, timestamp: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    totalCollateralBase: '0', totalSuppliedBase: suppliedBase, totalDebtBase: debtBase, availableBorrowsBase: '0',
    liquidationThreshold: '0', ltv: '0', healthFactor: debtBase !== '0' ? 'unknown' : 'inf',
    reserves,
  }
}

// The H160 that holds an account's money-market position: the explicit EVM address
// for EVM accounts, else the first-20-bytes of the AccountId (Hydration's default
// AccountId→EVM mapping). Mirrors the derivation in getAddress.
function mmH160ForAccount(accountId: string): string | null {
  const evm = evmFromAccountId(accountId)
  if (evm) return evm
  return ACCOUNT_RE.test(accountId) ? '0x' + accountId.slice(2, 42) : null
}

// Reverse of evmFromAccountId: an EVM H160 → the truncated AccountId32 form
// (0x45544800 + h160 + zeros) the chain uses for EVM accounts. accountRef then
// renders this as the H160 again. Money-market events index users by H160, so
// this is how a supplier's address surfaces as a displayable account.
function accountIdFromH160(h160: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(h160)) return null
  return '0x45544800' + h160.slice(2).toLowerCase() + '0000000000000000'
}

// aToken holders (money-market suppliers, from indexed data)
// aTokens (aPRIME 1043, aDOT 1001, …) are Aave scaled-balance receipts held EVM-side;
// they never hit substrate Tokens.Accounts. Per-holder balances are reconstructed from
// the anchor + indexed Mint/Burn/BalanceTransfer deltas (reconstructHolderScaled) and
// scaled by the reserve's current liquidityIndex — no per-request RPC. Module/pallet
// accounts are excluded from the displayed list. Returns HolderRow[] ranked by balance.
async function getATokenHolders(aTokenAssetId: number, limit: number): Promise<HolderRow[]> {
  const underlyingId = ATOKEN_UNDERLYING_ID[aTokenAssetId]
  if (underlyingId == null) return []
  return cached(`explorer:atoken-holders:${aTokenAssetId}:${limit}`, 30000, async () => {
    const b0 = await aTokenAnchorBlock()
    if (!b0) return []  // anchor not established yet → pending (never a wrong event-only sum)
    const reserve = (await getATokenReserves()).find(entry => entry.assetId === aTokenAssetId)
    if (!reserve) return []
    const scaled = await reconstructHolderScaled(reserve.token.aToken, b0)
    const held = scaled
      .filter(s => !s.holder.startsWith('0x6d6f646c'))   // exclude module/pallet accounts from the list
      .map(s => ({ h160: s.holder, bal: (s.scaled * reserve.liquidityIndex) / ATOKEN_RAY }))
      .filter(h => h.bal > 0n)
    return groupATokenHolderRows(held, accountRef, accountIdFromH160).slice(0, limit)
  })
}

interface HolderBalanceClaim { accountId: string; bal: bigint; lastBlock: number; memberKey?: string }

// Keep the on-chain custody row for any share balance that cannot be assigned
// to reconstructed aToken holders. This is deliberately a subtraction, not a
// fallback estimate: attributed claims replace the same custody balance, while
// an incomplete historical holder anchor remains visible under its real
// Supply & Borrow account instead of silently disappearing from total supply.
export function unattributedCustodyBalance(custody: bigint, attributed: bigint): bigint {
  return custody > attributed ? custody - attributed : 0n
}

// Combine wallet and receipt-token claims by their canonical displayed account,
// then collapse tagged members exactly once. This is the shared beneficial-owner
// grouping used when a displayed Giga asset spans direct, pool-share, and aToken
// storage locations.
export function groupHolderBalanceClaims(
  claims: HolderBalanceClaim[],
  refFor: (accountId: string) => AccountRef,
): HolderRow[] {
  const singles = new Map<string, { account: AccountRef; bal: bigint; lastBlock: number }>()
  const tagGroups = new Map<string, {
    tag: NonNullable<AccountRef['tag']>
    bal: bigint
    lastBlock: number
    members: Set<string>
  }>()
  for (const claim of claims) {
    if (claim.bal <= 0n) continue
    const account = refFor(claim.accountId)
    if (account.tag) {
      const group = tagGroups.get(account.tag.id) ?? {
        tag: account.tag, bal: 0n, lastBlock: 0, members: new Set<string>(),
      }
      group.bal += claim.bal
      group.lastBlock = Math.max(group.lastBlock, claim.lastBlock)
      group.members.add(claim.memberKey ?? account.accountId)
      tagGroups.set(account.tag.id, group)
      continue
    }
    const current = singles.get(account.accountId)
    if (current) {
      current.bal += claim.bal
      current.lastBlock = Math.max(current.lastBlock, claim.lastBlock)
    } else {
      singles.set(account.accountId, { account, bal: claim.bal, lastBlock: claim.lastBlock })
    }
  }
  const rows: (Omit<HolderRow, 'rank'> & { bal: bigint })[] = [
    ...[...singles.values()].map(row => ({
      account: row.account, tag: null, balance: row.bal.toString(), lastBlock: row.lastBlock, bal: row.bal,
    })),
    ...[...tagGroups.values()].map(group => ({
      account: null,
      tag: {
        tagId: group.tag.id, name: group.tag.name, color: group.tag.color,
        icon: group.tag.icon, memberCount: group.members.size,
      },
      balance: group.bal.toString(), lastBlock: group.lastBlock, bal: group.bal,
    })),
  ]
  return rows
    .sort((left, right) => left.bal < right.bal ? 1 : left.bal > right.bal ? -1 : 0)
    .map(({ bal: _bal, ...row }, index) => ({ ...row, rank: index + 1 }))
}

async function getFoldedDisplayAssetHolders(displayAssetId: number, shareAssetIds: number[]): Promise<HolderRow[]> {
  return cached(`explorer:folded-display-holders:${displayAssetId}`, 30000, async () => {
    const normalizedShareIds = [...new Set(shareAssetIds.filter(id => SHARE_TOKEN_UNDERLYING_ID[id] === displayAssetId))]
    if (!normalizedShareIds.length) return []
    const sourceIds = [displayAssetId, ...normalizedShareIds]
    const [tokens, indices, b0] = await Promise.all([getMmReserveTokens(), reserveIndicesNow(), aTokenAnchorBlock()])
    const shareSet = new Set(normalizedShareIds)
    const reserveTokens = tokens.filter(token => {
      const reserveId = assetIdFromMmAddress(token.asset)
      const market = MM_MARKET_BY_KEY.get(token.marketKey)
      return reserveId != null && shareSet.has(reserveId) && !market?.stakingBacked &&
        (indices.get(`${token.poolProxy.toLowerCase()}:${token.asset.toLowerCase()}`)?.liq ?? 0n) > 0n
    })

    const directPromise = client.query({
      query: `SELECT account_id,asset_id,toString(latest_bal) AS balance,last_block FROM (
                SELECT account_id,asset_id,
                  toUInt256OrZero(argMaxMerge(total_state)) AS latest_bal,
                  maxMerge(last_block_state) AS last_block
                FROM price_data.account_asset_latest_balances
                WHERE asset_id IN ({assetIds:Array(String)})
                GROUP BY account_id,asset_id
              ) WHERE latest_bal > 0`,
      query_params: { assetIds: sourceIds.map(String) }, format: 'JSONEachRow',
    })
    const reconstructedPromise = b0 > 0
      ? Promise.all(reserveTokens.map(async token => ({
          token,
          holders: await reconstructHolderScaled(token.aToken, b0),
        })))
      : Promise.resolve([])
    const [directRes, reconstructed] = await Promise.all([directPromise, reconstructedPromise])

    // The aToken contract is the on-chain custodian of supplied pool shares. Its
    // direct Tokens balance is replaced only to the extent that the indexed
    // holder anchor + deltas can assign that balance to beneficial owners.
    const tokenByCustody = new Map<string, MmReserveToken>()
    for (const token of reserveTokens) {
      const reserveId = assetIdFromMmAddress(token.asset)
      const custody = accountIdFromH160(token.aToken)
      if (reserveId == null || !custody) continue
      tokenByCustody.set(`${reserveId}:${custody.toLowerCase()}`, token)
    }

    const claims: HolderBalanceClaim[] = []
    const custodyByContract = new Map<string, HolderBalanceClaim>()
    for (const row of await directRes.json<{ account_id: string; asset_id: string; balance: string; last_block: number }>()) {
      const sourceId = Number(row.asset_id)
      const raw = rescaleRaw(row.balance, asset(sourceId).decimals, asset(displayAssetId).decimals)
      const bal = BigInt(raw || '0')
      if (bal <= 0n) continue
      const custodyToken = tokenByCustody.get(`${sourceId}:${row.account_id.toLowerCase()}`)
      if (custodyToken) {
        custodyByContract.set(custodyToken.aToken.toLowerCase(), {
          accountId: row.account_id, bal, lastBlock: Number(row.last_block),
        })
      } else {
        claims.push({ accountId: row.account_id, bal, lastBlock: Number(row.last_block) })
      }
    }
    for (const { token, holders } of reconstructed) {
      const reserveId = assetIdFromMmAddress(token.asset)
      if (reserveId == null) continue
      const liquidityIndex = indices.get(`${token.poolProxy.toLowerCase()}:${token.asset.toLowerCase()}`)?.liq ?? 0n
      let attributed = 0n
      for (const holder of holders) {
        const accountId = accountIdFromH160(holder.holder)
        if (!accountId) continue
        const actual = holder.scaled > 0n ? (holder.scaled * liquidityIndex) / ATOKEN_RAY : 0n
        const raw = rescaleRaw(actual.toString(), asset(reserveId).decimals, asset(displayAssetId).decimals)
        const bal = BigInt(raw || '0')
        if (bal > 0n) {
          attributed += bal
          claims.push({ accountId, bal, lastBlock: 0 })
        }
      }
      const custody = custodyByContract.get(token.aToken.toLowerCase())
      if (custody) {
        const residual = unattributedCustodyBalance(custody.bal, attributed)
        if (residual > 0n) claims.push({ ...custody, bal: residual })
        custodyByContract.delete(token.aToken.toLowerCase())
      }
    }
    // If the pinned holder anchor is not established yet, retain the entire
    // real custody balance. An unavailable reconstruction must never turn a
    // known on-chain holder into zero.
    claims.push(...custodyByContract.values())
    return groupHolderBalanceClaims(claims, accountRef)
  })
}

// Turn per-H160 aToken balances into display rows. Holders resolving (via
// accountRef → resolveDisplayAccountId) to a TAGGED account collapse into one
// tag group row — matching the substrate-side holders query, where e.g. all
// stableswap pools fold into a single "Stableswap Pool" row. Untagged holders
// stay individual. Rows are ranked by balance after grouping.
export function groupATokenHolderRows(
  held: { h160: string; bal: bigint }[],
  refFor: (accountId: string) => AccountRef,
  toAccountId: (h160: string) => string | null,
): HolderRow[] {
  const claims: HolderBalanceClaim[] = []
  for (const holder of held) {
    const accountId = toAccountId(holder.h160)
    if (accountId) claims.push({ accountId, bal: holder.bal, lastBlock: 0, memberKey: holder.h160 })
  }
  return groupHolderBalanceClaims(claims, refFor)
}

// Rank a health factor for "riskiest first" sorting: lower = more at risk; 'inf'
// (pure suppliers / no debt) sorts last.
function hfRank(hf: string): number {
  return hf === 'inf' ? Infinity : Number(hf) / 1e18
}

// Aggregate live money-market positions across a set of H160 addresses (the members
// of a tag) into ONE position PER MARKET. Within a market, sums collateral/debt/
// available across members, collateral-weights LTV/liquidation-threshold, recomputes
// a combined health factor, and merges per-asset reserves. Markets stay SEPARATE
// (isolated pools have independent health factors). Returns [] when no member holds
// any position. Reuses the same per-H160 indexed reads the account view uses.
async function aggregateMoneyMarket(members: { h160: string; simAccount: string }[]): Promise<MoneyMarketPosition[]> {
  const byH160 = new Map<string, string>()
  for (const member of members) {
    if (/^0x[0-9a-fA-F]{40}$/.test(member.h160) && ACCOUNT_RE.test(member.simAccount)) {
      if (!byH160.has(member.h160.toLowerCase())) byH160.set(member.h160.toLowerCase(), member.simAccount)
    }
  }
  if (!byH160.size) return []
  const perMember = await Promise.all([...byH160].map(async ([h, simAccount]) => ({ h, simAccount, positions: await getMoneyMarketPositions(h), reserves: await getMoneyMarketReserves(h) })))
  interface Acc {
    key: string; label: string; role: 'primary' | 'supplemental'; defiSimSupported: boolean; stakingBacked: boolean
    collateral: bigint; supplied: bigint; debt: bigint; avail: bigint; liqWeighted: bigint; ltvWeighted: bigint
    lastBlock: number; ts: string; simAccount?: string; simRank: number; worstHealthFactor: string; reserves: Map<number, MmReserve>
  }
  const acc = new Map<string, Acc>()
  for (const { simAccount, positions, reserves } of perMember) {
    for (const pos of positions) {
      let a = acc.get(pos.marketKey)
      if (!a) {
        a = {
          key: pos.marketKey, label: pos.market, role: pos.role, defiSimSupported: pos.defiSimSupported,
          stakingBacked: pos.stakingBacked ?? false, collateral: 0n, supplied: 0n, debt: 0n, avail: 0n,
          liqWeighted: 0n, ltvWeighted: 0n, lastBlock: 0, ts: '', simRank: Infinity,
          worstHealthFactor: 'inf', reserves: new Map(),
        }
        acc.set(pos.marketKey, a)
      }
      const c = BigInt(pos.totalCollateralBase || '0')
      a.collateral += c; a.supplied += BigInt((pos.totalSuppliedBase ?? pos.totalCollateralBase) || '0'); a.debt += BigInt(pos.totalDebtBase || '0'); a.avail += BigInt(pos.availableBorrowsBase || '0')
      a.liqWeighted += c * BigInt(pos.liquidationThreshold || '0')   // basis-point ratios — collateral-weighted
      a.ltvWeighted += c * BigInt(pos.ltv || '0')
      if (pos.blockHeight > a.lastBlock) a.lastBlock = pos.blockHeight
      if (!a.ts) a.ts = pos.timestamp
      const rank = hfRank(pos.healthFactor)
      if (rank < a.simRank || (a.simAccount == null && (c > 0n || BigInt(pos.totalDebtBase || '0') > 0n))) {
        a.simAccount = defiSimTargetForAccountId(simAccount)
        a.simRank = rank
        a.worstHealthFactor = pos.healthFactor
      }
    }
    for (const r of reserves) {
      const a = acc.get(r.marketKey ?? 'core'); if (!a) continue
      const ex = a.reserves.get(r.assetId)
      if (ex) {
        ex.supplied = (BigInt(ex.supplied) + BigInt(r.supplied)).toString()
        ex.debt = (BigInt(ex.debt) + BigInt(r.debt)).toString()
        ex.suppliedUsd = ex.suppliedUsd == null && r.suppliedUsd == null ? null : (ex.suppliedUsd ?? 0) + (r.suppliedUsd ?? 0)
        ex.debtUsd = ex.debtUsd == null && r.debtUsd == null ? null : (ex.debtUsd ?? 0) + (r.debtUsd ?? 0)
        ex.collateral = ex.collateral || r.collateral
      } else a.reserves.set(r.assetId, { ...r })
    }
  }
  const out: MoneyMarketPosition[] = []
  for (const a of acc.values()) {
    const liqThr = a.collateral > 0n ? (a.liqWeighted / a.collateral).toString() : '0'
    const ltv = a.collateral > 0n ? (a.ltvWeighted / a.collateral).toString() : '0'
    const mergedReserves = valueSingleUnpricedSupply(
      [...a.reserves.values()].sort((x, y) => (y.suppliedUsd ?? y.debtUsd ?? 0) - (x.suppliedUsd ?? x.debtUsd ?? 0)),
      a.collateral.toString(),
    )
    const reserveSuppliedBase = usdBase8(mergedReserves.reduce((sum, reserve) => sum + (reserve.suppliedUsd ?? 0), 0))
    out.push({
      marketKey: a.key, market: a.label, role: a.role, defiSimSupported: a.defiSimSupported, stakingBacked: a.stakingBacked,
      blockHeight: a.lastBlock, timestamp: a.ts || new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
      totalCollateralBase: a.collateral.toString(), totalSuppliedBase: maxBase8(a.supplied.toString(), reserveSuppliedBase), totalDebtBase: a.debt.toString(), availableBorrowsBase: a.avail.toString(),
      liquidationThreshold: liqThr, ltv, healthFactor: a.worstHealthFactor,
      ...(a.simAccount ? { simAccount: a.simAccount } : {}),
      reserves: mergedReserves,
    })
  }
  return orderMoneyMarkets(out)
}

// Fold supplied aToken collateral into the wallet balances list (it IS the
// account's aToken holding, e.g. aDOT, which never hits substrate balances).
// Shared by the account and tag views so both surface MM collateral identically.
// Returns the USD value actually folded into balances so the caller can detect a
// shortfall (per-reserve reconstruction unavailable) and still count collateral.
function applyMmCollateralToBalances(balances: AddressBalance[], moneyMarket: MoneyMarketPosition | null, prices: Map<number, PriceInfo>): number {
  let foldedUsd = 0
  for (const r of moneyMarket?.reserves ?? []) {
    if (r.supplied === '0' || r.assetId < 0) continue
    const valueUsd = usdValue(prices, r.assetId, r.supplied, r.decimals)
    foldedUsd += valueUsd ?? 0
    const existing = balances.find(b => b.asset.assetId === r.assetId)
    if (existing) { existing.total = r.supplied; existing.free = r.supplied; existing.reserved = '0'; existing.valueUsd = valueUsd }
    else balances.push({ asset: asset(r.assetId), total: r.supplied, free: r.supplied, reserved: '0', lastBlock: moneyMarket?.blockHeight ?? 0, valueUsd })
  }
  balances.sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
  return foldedUsd
}

// The collateral USD that must be added to a portfolio total ON TOP of the spot
// balances. Per-reserve reconstruction can be unavailable even when an aggregate
// snapshot exists; in that case no aToken balance gets folded into `balances`,
// so portfolioUsd would omit the
// collateral entirely and the header (portfolioUsd − debt) goes deeply negative
// for a borrower (cf. #14). The aggregate totalCollateralBase is already USD
// (base-8), so when the folded reserve value falls short of it, count the
// remainder. We never DOUBLE-count: if reserves folded the full collateral in,
// the shortfall is ~0.
function mmCollateralShortfallUsd(moneyMarket: MoneyMarketPosition | null, foldedUsd: number): number {
  if (!moneyMarket) return 0
  const aggCollateralUsd = Number(moneyMarket.totalCollateralBase || '0') / 1e8
  if (!Number.isFinite(aggCollateralUsd) || aggCollateralUsd <= 0) return 0
  return Math.max(0, aggCollateralUsd - foldedUsd)
}

// Omnipool LP positions (NFT-based, read from indexed state)
// Omnipool liquidity is held as position NFTs, not fungible Tokens.Accounts
// balances, so it never appears in the balances query. Maintained aggregate
// tables provide current ownership and position state without per-request RPC.
// hubAmount: the position's H2O (LRNA hub) leg, present for Omnipool positions
// whose withdraw value includes a hub component (already folded into valueUsd).
export interface LpPosition { positionId: string; asset: AssetRef; amount: string; hubAmount?: string; shares: string; valueUsd: number | null; venue: string }
export interface DecodedPosition { assetId: number; amount: bigint; shares: bigint; priceNum: bigint; priceDen: bigint }

// Omnipool state (per-asset reserve/hub/shares) for LP withdraw value
// Reads the latest per-block stableswap/omnipool snapshot (raw_block_snapshots →
// omnipool.assets[]). Used by the omnipool remove-liquidity math below.
export interface OmnipoolAssetState { reserve: bigint; hub: bigint; shares: bigint }
let omniState = new Map<number, OmnipoolAssetState>()
let omniStateAt = 0
async function loadOmnipoolState(): Promise<Map<number, OmnipoolAssetState>> {
  if (omniState.size && Date.now() - omniStateAt < 30_000) return omniState
  try {
    const res = await client.query({
      query: `SELECT JSONExtractRaw(payload_json, 'omnipool') AS o
              FROM price_data.raw_block_snapshots
              WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots)
              LIMIT 1`,
      format: 'JSONEachRow',
    })
    const row = (await res.json<{ o: string }>())[0]
    const assets = (safeJson(row?.o) as { assets?: { asset_id: number; reserve: string; hub_reserve: string; shares: string }[] } | null)?.assets ?? []
    const m = new Map<number, OmnipoolAssetState>()
    for (const a of assets) m.set(a.asset_id, { reserve: BigInt(a.reserve), hub: BigInt(a.hub_reserve), shares: BigInt(a.shares) })
    if (m.size) { omniState = m; omniStateAt = Date.now() }
  } catch { /* keep last good */ }
  return omniState
}
// Omnipool remove-liquidity (full position) → (asset out, hub/LRNA out), mirroring
// the node's calculate_remove_liquidity_state_changes (withdrawalFee = 0). Verified
// bit-exact against the official indexer's per-position liquidityAmount.
const OMNI_FIXED = 10n ** 18n
export function omnipoolRemoveLiquidity(st: OmnipoolAssetState, pos: DecodedPosition): { liquidity: bigint; hub: bigint } {
  const { reserve: R, hub: Q, shares: S } = st
  if (S <= 0n || pos.priceDen === 0n) return { liquidity: 0n, hub: 0n }
  const price = pos.priceNum * OMNI_FIXED / pos.priceDen
  const pxr = (price * R) / OMNI_FIXED + 1n
  const lt = Q * OMNI_FIXED < price * R
  const gt = Q * OMNI_FIXED > price * R
  const deltaB = lt ? ((pxr - Q) * pos.shares) / (pxr + Q) + 1n : 0n
  const deltaShares = pos.shares - deltaB
  const liquidity = (R * deltaShares) / S
  const hub = gt ? ((Q * (Q - pxr)) / (Q + pxr) * deltaShares) / S : 0n
  return { liquidity, hub }
}
const LRNA_ASSET_ID = 1   // hub asset (H2O / LRNA), 12 decimals
// Value a decoded omnipool position (asset leg + LRNA/hub leg) in USD.
function valueOmnipoolPosition(pos: DecodedPosition, st: OmnipoolAssetState, prices: Map<number, PriceInfo>): { amount: bigint; hub: bigint; valueUsd: number | null } {
  const { liquidity, hub } = omnipoolRemoveLiquidity(st, pos)
  const a = asset(pos.assetId)
  const assetUsd = usdValue(prices, pos.assetId, liquidity.toString(), a.decimals)
  const lrnaPx = prices.get(LRNA_ASSET_ID)?.price
  const hubUsd = lrnaPx != null ? Number(hub) / 10 ** (asset(LRNA_ASSET_ID).decimals) * lrnaPx : 0
  const valueUsd = assetUsd == null ? null : assetUsd + hubUsd
  return { amount: liquidity, hub, valueUsd }
}

// Raw withdraw legs for the positions economically owned at a single historical chart
// bucket. Dedupes by positionId so a position is valued exactly once regardless of whether
// it is held bare or farmed; skips positions with no pool state (never fabricates a zero
// leg) or non-positive shares. Returns raw integer legs — callers apply the bucket's
// event-time price. Shared by the historical value path (see valueOmnipoolPrincipalHistory).
export interface HistoricalOwnedPosition { positionId: string; assetId: number; state: DecodedPosition; pool: OmnipoolAssetState | undefined }
export function omnipoolLegsForBucket(positions: HistoricalOwnedPosition[]): { positionId: string; assetId: number; liquidity: bigint; hub: bigint }[] {
  const out: { positionId: string; assetId: number; liquidity: bigint; hub: bigint }[] = []
  const seen = new Set<string>()
  for (const { positionId, assetId, state, pool } of positions) {
    if (seen.has(positionId)) continue
    seen.add(positionId)
    if (!pool || state.shares <= 0n) continue
    const { liquidity, hub } = omnipoolRemoveLiquidity(pool, state)
    out.push({ positionId, assetId, liquidity, hub })
  }
  return out
}

// XYK LP redeemable reserve legs for `shares` of a pool with raw reserves `reserveA/B` and
// `totalShares` outstanding — amountX = floor(reserveX * shares / totalShares). Integer/
// bigint throughout (values exceed 2^53); callers convert to USD only after this. Shared by
// direct wallet LP balances and collection-5389 farm-deposit principal (Phase 2, XYK).
export function xykShareLegs(shares: bigint, reserveA: bigint, reserveB: bigint, totalShares: bigint): { amountA: bigint; amountB: bigint } {
  if (totalShares <= 0n || shares <= 0n) return { amountA: 0n, amountB: 0n }
  return { amountA: (reserveA * shares) / totalShares, amountB: (reserveB * shares) / totalShares }
}

// Current open omnipool positions owned by a set of accounts, reconstructed from
// indexed events (no per-request RPC): NFT ownership from Uniques.Issued/Transferred/
// Burned (bare = collection 1337; farm deposits = collection 2584 → positionId via
// OmnipoolLiquidityMining.SharesDeposited/Redeposited), position state (assetId, shares,
// amount, price) from the latest Omnipool.PositionCreated/PositionUpdated. `raw_events`
// is complete from genesis, so current state is exact. Event `price` is FixedU128
// (= priceNum/priceDen · 1e18), so priceDen = OMNI_FIXED reproduces the storage rational.
interface DecodedLpPosition { positionId: string; dec: DecodedPosition; venue: 'Omnipool' | 'Omnipool Farm' }
async function reconstructOmnipoolPositions(accounts: string[]): Promise<DecodedLpPosition[]> {
  const accs = [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  if (!accs.length) return []
  return cached(`explorer:lp-recon:${accountValueGenerationEpoch}:${accs.sort().join(',')}`, 15000, async () => {
    // Fast lookup on the maintained aggregate tables (schema 042): nft_owner_latest
    // (current NFT owner), omnipool_position_latest (latest position state),
    // farm_deposit_latest (deposit → position). Empty '' owner = burned/withdrawn.
    const res = await client.query({
      query: `
        WITH
        own AS (SELECT collection, item, argMaxMerge(owner) AS owner FROM price_data.nft_owner_latest GROUP BY collection, item),
        posn AS (SELECT position_id, argMaxMerge(asset_id) AS asset_id, argMaxMerge(shares) AS shares, argMaxMerge(amount) AS amount, argMaxMerge(price) AS price FROM price_data.omnipool_position_latest GROUP BY position_id),
        dep AS (SELECT deposit_id, argMaxMerge(position_id) AS position_id FROM price_data.farm_deposit_latest GROUP BY deposit_id)
        SELECT 'Omnipool' AS venue, own.item AS positionId, posn.asset_id AS assetId, posn.shares AS shares, posn.amount AS amount, posn.price AS price
        FROM own INNER JOIN posn ON own.item = posn.position_id
        WHERE own.collection = '1337' AND own.owner IN {accs:Array(String)}
        UNION ALL
        SELECT 'Omnipool Farm' AS venue, dep.position_id AS positionId, posn.asset_id, posn.shares, posn.amount, posn.price
        FROM own INNER JOIN dep ON own.item = dep.deposit_id INNER JOIN posn ON dep.position_id = posn.position_id
        WHERE own.collection = '2584' AND own.owner IN {accs:Array(String)}`,
      query_params: { accs }, format: 'JSONEachRow',
    })
    const rows = await res.json<{ venue: 'Omnipool' | 'Omnipool Farm'; positionId: string; assetId: number; shares: string; amount: string; price: string }>()
    return rows.map(r => ({
      positionId: r.positionId, venue: r.venue,
      dec: { assetId: r.assetId, amount: BigInt(r.amount || '0'), shares: BigInt(r.shares || '0'), priceNum: BigInt(r.price || '0'), priceDen: OMNI_FIXED } as DecodedPosition,
    }))
  })
}

export interface OwnedDecodedLpPosition extends DecodedLpPosition { accountId: string }
export interface OmnipoolAccountClaim {
  positionId: string
  accountId: string
  assetId: number
  amount: bigint
  hubAmount: bigint
  venue: 'Omnipool' | 'Omnipool Farm'
}

// One row per economically owned position. An active farm has both a collection
// 1337 NFT held by the LM pallet and a collection 2584 deposit NFT held by the
// user; exclude that custody NFT and keep only the deposit owner so a position
// can never be counted as both bare and farmed.
async function reconstructAllOmnipoolPositions(): Promise<OwnedDecodedLpPosition[]> {
  const res = await client.query({
    query: `
      WITH
      own AS (
        SELECT collection, item, argMaxMerge(owner) AS owner
        FROM price_data.nft_owner_latest GROUP BY collection, item
      ),
      posn AS (
        SELECT position_id, argMaxMerge(asset_id) AS asset_id,
          argMaxMerge(shares) AS shares, argMaxMerge(amount) AS amount,
          argMaxMerge(price) AS price
        FROM price_data.omnipool_position_latest GROUP BY position_id
      ),
      dep AS (
        SELECT deposit_id, argMaxMerge(position_id) AS position_id
        FROM price_data.farm_deposit_latest GROUP BY deposit_id
      ),
      farm AS (
        SELECT dep.position_id AS position_id, own.owner AS owner
        FROM own INNER JOIN dep ON own.item = dep.deposit_id
        WHERE own.collection = '2584' AND own.owner != ''
      )
      SELECT 'Omnipool' AS venue, own.owner AS accountId, own.item AS positionId,
        posn.asset_id AS assetId, posn.shares AS shares, posn.amount AS amount,
        posn.price AS price
      FROM own
      INNER JOIN posn ON own.item = posn.position_id
      LEFT JOIN farm ON farm.position_id = own.item
      WHERE own.collection = '1337' AND own.owner != '' AND farm.position_id = ''
      UNION ALL
      SELECT 'Omnipool Farm' AS venue, farm.owner AS accountId,
        farm.position_id AS positionId, posn.asset_id AS assetId,
        posn.shares AS shares, posn.amount AS amount, posn.price AS price
      FROM farm INNER JOIN posn ON farm.position_id = posn.position_id`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{
    venue: 'Omnipool' | 'Omnipool Farm'; accountId: string; positionId: string
    assetId: number; shares: string; amount: string; price: string
  }>()
  return rows.map(row => ({
    positionId: row.positionId,
    // Resolve EVM pots/bindings while building the background generation. Doing
    // this here avoids another request-time pass over raw_account_aliases.
    accountId: resolveDisplayAccountId(row.accountId.toLowerCase()),
    venue: row.venue,
    dec: {
      assetId: row.assetId,
      amount: BigInt(row.amount || '0'),
      shares: BigInt(row.shares || '0'),
      priceNum: BigInt(row.price || '0'),
      priceDen: OMNI_FIXED,
    },
  }))
}

// Shared exact claim builder for the detail page's withdrawal semantics and the
// directory snapshot. Missing pool state or duplicate position identities abort
// publication rather than silently undervaluing/double-counting the directory.
export function buildOmnipoolAccountClaims(
  positions: OwnedDecodedLpPosition[],
  state: Map<number, OmnipoolAssetState>,
): OmnipoolAccountClaim[] {
  const seen = new Set<string>()
  return positions.map(position => {
    if (seen.has(position.positionId)) throw new Error(`duplicate current Omnipool position ${position.positionId}`)
    seen.add(position.positionId)
    const assetState = state.get(position.dec.assetId)
    if (!assetState) throw new Error(`missing current Omnipool state for asset ${position.dec.assetId}`)
    const { liquidity, hub } = omnipoolRemoveLiquidity(assetState, position.dec)
    return {
      positionId: position.positionId,
      accountId: position.accountId,
      assetId: position.dec.assetId,
      amount: liquidity,
      hubAmount: hub,
      venue: position.venue,
    }
  })
}

const OMNIPOOL_ACCOUNT_CLAIMS_REFRESH_MS = 5 * 60_000
let omnipoolAccountClaimsRefreshTimer: ReturnType<typeof setInterval> | null = null
let omnipoolAccountClaimsRefreshInflight: Promise<void> | null = null

export async function omnipoolAccountClaimsSnapshotReady(): Promise<boolean> {
  try {
    const result = await client.query({
      query: `
        WITH current AS (
          SELECT argMax(snapshot_id, computed_at) AS snapshot_id,
            argMax(source_position_count, computed_at) AS source_count,
            argMax(claim_count, computed_at) AS claim_count
          FROM price_data.omnipool_account_claim_snapshot_state
          WHERE snapshot_key = 'current'
        )
        SELECT current.snapshot_id AS snapshot_id, current.source_count AS source_count,
          current.claim_count AS claim_count, count(c.position_id) AS stored_count,
          uniqExact(c.position_id) AS unique_count
        FROM current
        LEFT JOIN price_data.omnipool_account_claim_snapshots c
          ON c.snapshot_id = current.snapshot_id
        GROUP BY current.snapshot_id, current.source_count, current.claim_count`,
      format: 'JSONEachRow',
    })
    const row = (await result.json<{
      snapshot_id: string; source_count: number; claim_count: number
      stored_count: string; unique_count: string
    }>())[0]
    return Boolean(row?.snapshot_id)
      && Number(row.source_count) === Number(row.claim_count)
      && Number(row.claim_count) === Number(row.stored_count)
      && Number(row.stored_count) === Number(row.unique_count)
  } catch { return false }
}

async function refreshOmnipoolAccountClaimsUncached(): Promise<void> {
  const [positions, state] = await Promise.all([
    reconstructAllOmnipoolPositions(),
    loadOmnipoolState(),
  ])
  const claims = buildOmnipoolAccountClaims(positions, state)
  if (claims.length !== positions.length) throw new Error('Omnipool claim/source count mismatch')

  const snapshotId = String(Date.now())
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const checksum = createHash('sha256')
  for (const position of [...positions].sort((a, b) => a.positionId.localeCompare(b.positionId))) {
    checksum.update(`${position.positionId}|${position.accountId}|${position.venue}|${position.dec.assetId}|${position.dec.shares}|${position.dec.amount}|${position.dec.priceNum}\n`)
  }

  // Bounded batches make a failed refresh cheap to retry. The state marker is
  // deliberately written last, so partial generations are never request-visible.
  const batchSize = 1_000
  for (let offset = 0; offset < claims.length; offset += batchSize) {
    await client.insert({
      table: 'price_data.omnipool_account_claim_snapshots',
      values: claims.slice(offset, offset + batchSize).map(claim => ({
        snapshot_id: snapshotId,
        position_id: claim.positionId,
        account_id: claim.accountId,
        asset_id: claim.assetId,
        amount: claim.amount.toString(),
        hub_amount: claim.hubAmount.toString(),
        venue: claim.venue,
        computed_at: now,
      })),
      format: 'JSONEachRow',
    })
  }

  const verify = await client.query({
    query: `SELECT count() AS c, uniqExact(position_id) AS u
      FROM price_data.omnipool_account_claim_snapshots
      WHERE snapshot_id = {snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  const counts = (await verify.json<{ c: string; u: string }>())[0]
  if (Number(counts?.c) !== claims.length || Number(counts?.u) !== claims.length) {
    throw new Error(`incomplete Omnipool claim generation ${counts?.c ?? 0}/${claims.length}`)
  }

  await client.insert({
    table: 'price_data.omnipool_account_claim_snapshot_state',
    values: [{
      snapshot_key: 'current', snapshot_id: snapshotId,
      source_position_count: positions.length, claim_count: claims.length,
      source_checksum: checksum.digest('hex'), computed_at: now,
    }],
    format: 'JSONEachRow',
  })
  if (!(await omnipoolAccountClaimsSnapshotReady())) throw new Error('published Omnipool claim generation failed parity check')
  setOmnipoolAccountClaimsReady()
  accountValueGenerationEpoch++

  // A completed generation is self-contained. Drop every superseded/orphaned
  // partition so retries and regular refreshes leave no unused snapshot data.
  const parts = await client.query({
    query: `SELECT DISTINCT partition FROM system.parts
      WHERE database = 'price_data' AND table = 'omnipool_account_claim_snapshots'
        AND active AND partition != {snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  for (const row of await parts.json<{ partition: string }>()) {
    await client.command({
      query: `ALTER TABLE price_data.omnipool_account_claim_snapshots DROP PARTITION {partition:String}`,
      query_params: { partition: row.partition },
    })
  }

  // v1 directory payloads were computed without Omnipool claims. Remove them
  // only after v2's complete claim generation is published; the count guard
  // keeps periodic refreshes from creating empty mutations.
  const legacy = await client.query({
    query: `SELECT count() AS c FROM price_data.account_directory_snapshots
      WHERE startsWith(snapshot_key, 'v1:')`,
    format: 'JSONEachRow',
  })
  if (Number((await legacy.json<{ c: string }>())[0]?.c ?? 0) > 0) {
    await client.command({
      query: `ALTER TABLE price_data.account_directory_snapshots
        DELETE WHERE startsWith(snapshot_key, 'v1:')`,
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
}

export function refreshOmnipoolAccountClaims(): Promise<void> {
  if (omnipoolAccountClaimsRefreshInflight) return omnipoolAccountClaimsRefreshInflight
  const request = refreshOmnipoolAccountClaimsUncached().finally(() => {
    if (omnipoolAccountClaimsRefreshInflight === request) omnipoolAccountClaimsRefreshInflight = null
  })
  omnipoolAccountClaimsRefreshInflight = request
  return request
}

export function startOmnipoolAccountClaimsRefresh(): void {
  if (omnipoolAccountClaimsRefreshTimer) return
  omnipoolAccountClaimsRefreshTimer = setInterval(() => {
    void refreshOmnipoolAccountClaims().catch(error => console.error('[accounts] Omnipool claim refresh failed', error))
  }, OMNIPOOL_ACCOUNT_CLAIMS_REFRESH_MS)
  omnipoolAccountClaimsRefreshTimer.unref()
}

// Bare Omnipool LP positions (NFTs the account itself owns — collection 1337).
// Farmed positions live under the LM pallet, so they never appear here and are
// surfaced separately by getFarmingPositions (no double-count). Valued at the
// current withdraw value (asset + hub legs).
async function getOmnipoolPositions(accounts: string[]): Promise<LpPosition[]> {
  if (!accounts.length) return []
  const [recon, prices, st] = await Promise.all([reconstructOmnipoolPositions(accounts), ensureAccountValuePrices(), loadOmnipoolState()])
  const out: LpPosition[] = []
  for (const { positionId, dec } of recon.filter(r => r.venue === 'Omnipool')) {
    const state = st.get(dec.assetId); if (!state) continue
    const { amount, hub, valueUsd } = valueOmnipoolPosition(dec, state, prices)
    out.push({ positionId, asset: asset(dec.assetId), amount: amount.toString(), hubAmount: hub > 0n ? hub.toString() : undefined, shares: dec.shares.toString(), valueUsd, venue: 'Omnipool' })
  }
  return out.sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
}

// Omnipool liquidity-mining farm deposits (collection 2584). Each deposit NFT maps
// to an underlying omnipool position; value = that position's withdraw value, exactly
// like a bare position. (XYK farms, collection 5389, are negligible and not yet valued.)
async function getFarmingPositions(accounts: string[]): Promise<LpPosition[]> {
  if (!accounts.length) return []
  const [recon, prices, st] = await Promise.all([reconstructOmnipoolPositions(accounts), ensureAccountValuePrices(), loadOmnipoolState()])
  const out: LpPosition[] = []
  for (const { positionId, dec } of recon.filter(r => r.venue === 'Omnipool Farm')) {
    const state = st.get(dec.assetId); if (!state) continue
    const { amount, hub, valueUsd } = valueOmnipoolPosition(dec, state, prices)
    out.push({ positionId, asset: asset(dec.assetId), amount: amount.toString(), hubAmount: hub > 0n ? hub.toString() : undefined, shares: dec.shares.toString(), valueUsd, venue: 'Omnipool Farm' })
  }
  return out.sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
}

// Current XYK pool state (reserves from the latest snapshot, total supply from the latest
// reconstructed step point) for the given LP tokens, to value XYK LP at current NAV. Mirrors
// loadOmnipoolState but for the fungible XYK share tokens.
interface XykCurrentPool { assetA: number; assetB: number; reserveA: bigint; reserveB: bigint; totalShares: bigint }
async function loadXykCurrentState(lpAssetIds: number[]): Promise<Map<number, XykCurrentPool>> {
  const out = new Map<number, XykCurrentPool>()
  if (!lpAssetIds.length) return out
  const regRes = await client.query({ query: `SELECT lp_asset_id, pool_account, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id IN {lps:Array(Int32)}`, query_params: { lps: lpAssetIds }, format: 'JSONEachRow' })
  const reg = await regRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number }>()
  if (!reg.length) return out
  const pools = [...new Set(reg.map(r => r.pool_account))]
  const resvRes = await client.query({
    query: `SELECT JSONExtractString(p,'pool_account') AS pool,
              toInt32(JSONExtractInt(p,'asset_a')) AS aa, toInt32(JSONExtractInt(p,'asset_b')) AS ab,
              JSONExtractString(p,'reserve_a') AS ra, JSONExtractString(p,'reserve_b') AS rb
            FROM price_data.raw_block_snapshots
            ARRAY JOIN JSONExtractArrayRaw(JSONExtractRaw(payload_json,'xyk'),'pools') AS p
            WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots) AND JSONExtractString(p,'pool_account') IN {pools:Array(String)}`,
    query_params: { pools }, format: 'JSONEachRow',
  })
  const reserveByPool = new Map<string, { aa: number; ab: number; ra: bigint; rb: bigint }>()
  for (const r of await resvRes.json<{ pool: string; aa: number; ab: number; ra: string; rb: string }>()) reserveByPool.set(r.pool, { aa: r.aa, ab: r.ab, ra: BigInt(r.ra || '0'), rb: BigInt(r.rb || '0') })
  const tsRes = await client.query({ query: `SELECT lp_asset_id, argMax(total_shares_raw, block_height) AS total FROM price_data.xyk_lp_total_shares_history WHERE lp_asset_id IN {lps:Array(Int32)} GROUP BY lp_asset_id`, query_params: { lps: lpAssetIds }, format: 'JSONEachRow' })
  const totalByLp = new Map<number, bigint>()
  for (const r of await tsRes.json<{ lp_asset_id: number; total: string }>()) totalByLp.set(r.lp_asset_id, BigInt(r.total || '0'))
  for (const r of reg) {
    const rv = reserveByPool.get(r.pool_account); const ts = totalByLp.get(r.lp_asset_id)
    if (rv && ts && ts > 0n) {
      // Pair reserves with the snapshot's own asset order, which can differ from the
      // registry's PoolCreated order (see loadXykPrincipalHistory); registry fallback for
      // legacy snapshot rows without asset ids.
      const [assetA, assetB] = rv.aa > 0 && rv.ab > 0 ? [rv.aa, rv.ab] : [r.asset_a, r.asset_b]
      out.set(r.lp_asset_id, { assetA, assetB, reserveA: rv.ra, reserveB: rv.rb, totalShares: ts })
    }
  }
  return out
}

// Current XYK LP positions (direct wallet shareToken balances + open collection-5389 farm
// deposits) valued at pool NAV, so the account's headline value and the history's pinned
// final point include XYK. Direct LP token balances contribute NAV here, not their (null)
// token price in `balances` — no double count.
async function getXykPositions(accounts: string[], balances: AddressBalance[]): Promise<LpPosition[]> {
  const accs = [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  if (!accs.length) return []
  const farmedByLp = new Map<number, bigint>()
  const fRes = await client.query({ query: `SELECT lp_asset_id, toString(sum(toInt256(principal_shares_raw))) AS shares FROM price_data.xyk_farm_principal_intervals FINAL WHERE account_id IN {accs:Array(String)} AND valid_to_block = 0 GROUP BY lp_asset_id`, query_params: { accs }, format: 'JSONEachRow' })
  for (const r of await fRes.json<{ lp_asset_id: number; shares: string }>()) farmedByLp.set(r.lp_asset_id, BigInt(r.shares || '0'))
  const directByLp = new Map<number, bigint>()
  for (const b of balances) directByLp.set(b.asset.assetId, (directByLp.get(b.asset.assetId) ?? 0n) + BigInt(b.total || '0'))
  const candidates = [...new Set([...directByLp.keys(), ...farmedByLp.keys()])]
  const [state, prices] = await Promise.all([loadXykCurrentState(candidates), ensureAccountValuePrices()])
  const out: LpPosition[] = []
  for (const [lp, st] of state) {
    for (const [shares, venue] of [[directByLp.get(lp) ?? 0n, 'XYK'], [farmedByLp.get(lp) ?? 0n, 'XYK Farm']] as const) {
      if (shares <= 0n) continue
      const { amountA, amountB } = xykShareLegs(shares, st.reserveA, st.reserveB, st.totalShares)
      const usdA = usdValue(prices, st.assetA, amountA.toString(), asset(st.assetA).decimals)
      const usdB = usdValue(prices, st.assetB, amountB.toString(), asset(st.assetB).decimals)
      const valueUsd = usdA == null || usdB == null ? null : usdA + usdB
      out.push({ positionId: `xyk:${lp}:${venue === 'XYK Farm' ? 'farm' : 'direct'}`, asset: asset(lp), amount: amountA.toString(), shares: shares.toString(), valueUsd, venue })
    }
  }
  return out.sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
}

// Historical Omnipool principal for the value-history chart: for every position the account
// economically owned at each bucket (bare or farmed), the raw withdraw legs from its TRUE
// per-block state — not current shares, never request-time snapshot JSON. Account-bounded:
// ownership intervals by account, position state by referenced positions, pool state by
// referenced assets. Callers apply the bucket's event-time price to the raw legs.
// See the value-history path in getAccountHistory.
export interface OmnipoolHistoryLeg { assetId: number; liquidity: bigint; hub: bigint }
export interface OmnipoolPrincipalHistory { legsByBucket: OmnipoolHistoryLeg[][]; assetIds: number[]; fromBucket: number | null }
export async function loadOmnipoolPrincipalHistory(accounts: string[], minb: number, bucket: number, n: number): Promise<OmnipoolPrincipalHistory> {
  const empty: OmnipoolPrincipalHistory = { legsByBucket: Array.from({ length: n + 1 }, () => []), assetIds: [], fromBucket: null }
  const accs = [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  if (!accs.length) return empty
  const maxb = minb + bucket * n
  const bucketEndBlock = (b: number) => Math.min(maxb, minb + (b + 1) * bucket - 1)

  // 1) Ownership intervals overlapping the range (account-bounded).
  const ivRes = await client.query({
    query: `SELECT position_id, valid_from_block, valid_to_block
            FROM price_data.omnipool_position_owner_intervals FINAL
            WHERE account_id IN {accs:Array(String)}
              AND valid_from_block <= ${maxb}
              AND (valid_to_block = 0 OR valid_to_block >= ${minb})`,
    query_params: { accs }, format: 'JSONEachRow',
  })
  const intervals = await ivRes.json<{ position_id: string; valid_from_block: number; valid_to_block: number }>()
  if (!intervals.length) return empty
  const positionIds = [...new Set(intervals.map(i => i.position_id))]

  // 2) Position state events for those positions (position-bounded); forward-fill the
  //    latest active state to each bucket end, dropping the position once destroyed.
  const stRes = await client.query({
    query: `SELECT position_id, block_height, event_kind, asset_id, amount_raw, shares_raw, price_raw, active
            FROM price_data.omnipool_position_state_events FINAL
            WHERE position_id IN {pids:Array(String)}
            ORDER BY position_id, block_height, event_index`,
    query_params: { pids: positionIds }, format: 'JSONEachRow',
  })
  const stRows = await stRes.json<{ position_id: string; block_height: number; event_kind: string; asset_id: number; amount_raw: string; shares_raw: string; price_raw: string; active: number }>()
  const eventsByPosition = new Map<string, typeof stRows>()
  for (const r of stRows) { if (!eventsByPosition.has(r.position_id)) eventsByPosition.set(r.position_id, []); eventsByPosition.get(r.position_id)!.push(r) }
  const stateByPosition = new Map<string, (DecodedPosition | null)[]>()
  const assetByPosition = new Map<string, number>()
  for (const pid of positionIds) {
    const evs = eventsByPosition.get(pid) ?? []
    const series: (DecodedPosition | null)[] = new Array(n + 1).fill(null)
    let cursor = 0
    let last: DecodedPosition | null = null
    for (let b = 0; b <= n; b++) {
      const be = bucketEndBlock(b)
      while (cursor < evs.length && evs[cursor].block_height <= be) {
        const e = evs[cursor]
        if (e.event_kind === 'destroyed' || e.active === 0) last = null
        else { last = { assetId: e.asset_id, amount: BigInt(e.amount_raw || '0'), shares: BigInt(e.shares_raw || '0'), priceNum: BigInt(e.price_raw || '0'), priceDen: OMNI_FIXED }; assetByPosition.set(pid, e.asset_id) }
        cursor++
      }
      series[b] = last
    }
    stateByPosition.set(pid, series)
  }

  // 3) Pool state per (asset, bucket): the latest snapshot at/before each bucket end,
  //    forward-filled (b = -1 carries the pre-range state). Asset-bounded.
  const assetIds = [...new Set([...assetByPosition.values()])]
  const poolByAssetBucket = new Map<number, (OmnipoolAssetState | undefined)[]>()
  if (assetIds.length) {
    const poolRes = await client.query({
      query: `SELECT asset_id,
                toInt32(greatest(-1, least(${n}, intDiv(toInt64(block_height) - ${minb}, ${bucket})))) AS b,
                argMax(reserve_raw, block_height) AS reserve,
                argMax(hub_reserve_raw, block_height) AS hub_reserve,
                argMax(shares_raw, block_height) AS shares
              FROM price_data.omnipool_pool_state_history
              WHERE asset_id IN {aids:Array(Int32)} AND block_height <= ${maxb}
              GROUP BY asset_id, b ORDER BY asset_id, b`,
      query_params: { aids: assetIds }, format: 'JSONEachRow',
    })
    const poolRows = await poolRes.json<{ asset_id: number; b: number; reserve: string; hub_reserve: string; shares: string }>()
    const byAsset = new Map<number, Map<number, OmnipoolAssetState>>()
    for (const r of poolRows) {
      if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, new Map())
      byAsset.get(r.asset_id)!.set(r.b, { reserve: BigInt(r.reserve || '0'), hub: BigInt(r.hub_reserve || '0'), shares: BigInt(r.shares || '0') })
    }
    for (const aid of assetIds) {
      const perBucket = byAsset.get(aid) ?? new Map<number, OmnipoolAssetState>()
      const series: (OmnipoolAssetState | undefined)[] = new Array(n + 1).fill(undefined)
      let last: OmnipoolAssetState | undefined = perBucket.get(-1)
      for (let b = 0; b <= n; b++) { if (perBucket.has(b)) last = perBucket.get(b); series[b] = last }
      poolByAssetBucket.set(aid, series)
    }
  }

  // 4) Per bucket: positions active at the bucket end (dedup by positionId), raw legs.
  const legsByBucket: OmnipoolHistoryLeg[][] = Array.from({ length: n + 1 }, () => [])
  let fromBucket: number | null = null
  for (let b = 0; b <= n; b++) {
    const be = bucketEndBlock(b)
    const owned: HistoricalOwnedPosition[] = []
    for (const iv of intervals) {
      if (iv.valid_from_block <= be && (iv.valid_to_block === 0 || iv.valid_to_block > be)) {
        const state = stateByPosition.get(iv.position_id)?.[b] ?? null
        if (!state) continue
        owned.push({ positionId: iv.position_id, assetId: state.assetId, state, pool: poolByAssetBucket.get(state.assetId)?.[b] })
      }
    }
    const legs = omnipoolLegsForBucket(owned)
    if (legs.length && fromBucket === null) fromBucket = b
    legsByBucket[b] = legs.map(l => ({ assetId: l.assetId, liquidity: l.liquidity, hub: l.hub }))
  }
  return { legsByBucket, assetIds, fromBucket }
}

// Historical XYK principal for the value-history chart (Phase 2). For the account's LP holdings
// — direct wallet shareToken balances AND collection-5389 farm-deposit principal — this loads
// the per-bucket pool state needed to value each at NAV (reserves × shares / total supply).
// Total supply is the reconstructed step function; reserves are the sampled snapshot. All
// account/pool/asset-bounded. Callers combine direct + farmed shares and apply xykShareLegs.
export interface XykBucketState { assetA: number; assetB: number; reserveA: bigint; reserveB: bigint; totalShares: bigint }
export interface XykPrincipalHistory {
  lpAssetIds: Set<number>
  underlyingAssetIds: number[]
  stateByLp: Map<number, (XykBucketState | undefined)[]>
  farmSharesByLp: Map<number, bigint[]>
}
export async function loadXykPrincipalHistory(accounts: string[], candidateAssetIds: number[], minb: number, bucket: number, n: number): Promise<XykPrincipalHistory> {
  const empty: XykPrincipalHistory = { lpAssetIds: new Set(), underlyingAssetIds: [], stateByLp: new Map(), farmSharesByLp: new Map() }
  const accs = [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  const maxb = minb + bucket * n
  const bucketEndBlock = (b: number) => Math.min(maxb, minb + (b + 1) * bucket - 1)

  // 1) Farm principal intervals → per (lp, bucket) summed active principal.
  const farmSharesByLp = new Map<number, bigint[]>()
  const farmedLps = new Set<number>()
  if (accs.length) {
    const fRes = await client.query({
      query: `SELECT lp_asset_id, principal_shares_raw, valid_from_block, valid_to_block
              FROM price_data.xyk_farm_principal_intervals FINAL
              WHERE account_id IN {accs:Array(String)} AND valid_from_block <= ${maxb} AND (valid_to_block = 0 OR valid_to_block >= ${minb})`,
      query_params: { accs }, format: 'JSONEachRow',
    })
    for (const r of await fRes.json<{ lp_asset_id: number; principal_shares_raw: string; valid_from_block: number; valid_to_block: number }>()) {
      farmedLps.add(r.lp_asset_id)
      if (!farmSharesByLp.has(r.lp_asset_id)) farmSharesByLp.set(r.lp_asset_id, new Array(n + 1).fill(0n))
      const arr = farmSharesByLp.get(r.lp_asset_id)!
      const principal = BigInt(r.principal_shares_raw || '0')
      for (let b = 0; b <= n; b++) { const be = bucketEndBlock(b); if (r.valid_from_block <= be && (r.valid_to_block === 0 || r.valid_to_block > be)) arr[b] += principal }
    }
  }

  // 2) Which candidate assets (+ farmed lps) are XYK LP tokens? → registry mapping.
  const lpCandidates = [...new Set([...candidateAssetIds, ...farmedLps])]
  if (!lpCandidates.length) return empty
  const rRes = await client.query({
    query: `SELECT lp_asset_id, pool_account, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id IN {lps:Array(Int32)}`,
    query_params: { lps: lpCandidates }, format: 'JSONEachRow',
  })
  const regRows = await rRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number }>()
  if (!regRows.length) return empty
  const lpAssetIds = new Set(regRows.map(r => r.lp_asset_id))
  const poolByLp = new Map(regRows.map(r => [r.lp_asset_id, r]))
  const pools = [...new Set(regRows.map(r => r.pool_account))]

  // 3) Reserves per (pool, bucket) — sampled, forward-filled (b=-1 carry-in). Carry the
  // snapshot's own asset order (aa/ab), taken from the SAME latest row as the reserves
  // (all argMax by block_height): it can differ from — and even flips across blocks
  // within — the registry's PoolCreated order, so reserves must be paired by it (step 5).
  const reserveByPoolBucket = new Map<string, ({ aa: number; ab: number; ra: bigint; rb: bigint } | undefined)[]>()
  {
    const resvRes = await client.query({
      query: `SELECT pool_account,
                toInt32(greatest(-1, least(${n}, intDiv(toInt64(block_height) - ${minb}, ${bucket})))) AS b,
                argMax(asset_a, block_height) AS aa, argMax(asset_b, block_height) AS ab,
                argMax(reserve_a_raw, block_height) AS ra, argMax(reserve_b_raw, block_height) AS rb
              FROM price_data.xyk_pool_reserve_history WHERE pool_account IN {pools:Array(String)} AND block_height <= ${maxb}
              GROUP BY pool_account, b ORDER BY pool_account, b`,
      query_params: { pools }, format: 'JSONEachRow',
    })
    const byPool = new Map<string, Map<number, { aa: number; ab: number; ra: bigint; rb: bigint }>>()
    for (const r of await resvRes.json<{ pool_account: string; b: number; aa: number; ab: number; ra: string; rb: string }>()) {
      if (!byPool.has(r.pool_account)) byPool.set(r.pool_account, new Map())
      byPool.get(r.pool_account)!.set(r.b, { aa: r.aa, ab: r.ab, ra: BigInt(r.ra || '0'), rb: BigInt(r.rb || '0') })
    }
    for (const pool of pools) {
      const per = byPool.get(pool) ?? new Map<number, { aa: number; ab: number; ra: bigint; rb: bigint }>()
      const arr: ({ aa: number; ab: number; ra: bigint; rb: bigint } | undefined)[] = new Array(n + 1).fill(undefined)
      let last = per.get(-1)
      for (let b = 0; b <= n; b++) { if (per.has(b)) last = per.get(b); arr[b] = last }
      reserveByPoolBucket.set(pool, arr)
    }
  }

  // 4) Total shares per (lp, bucket) — reconstructed step function, forward-filled.
  const totalByLpBucket = new Map<number, (bigint | undefined)[]>()
  {
    const tRes = await client.query({
      query: `SELECT lp_asset_id,
                toInt32(greatest(-1, least(${n}, intDiv(toInt64(block_height) - ${minb}, ${bucket})))) AS b,
                argMax(total_shares_raw, block_height) AS total
              FROM price_data.xyk_lp_total_shares_history WHERE lp_asset_id IN {lps:Array(Int32)} AND block_height <= ${maxb}
              GROUP BY lp_asset_id, b ORDER BY lp_asset_id, b`,
      query_params: { lps: [...lpAssetIds] }, format: 'JSONEachRow',
    })
    const byLp = new Map<number, Map<number, bigint>>()
    for (const r of await tRes.json<{ lp_asset_id: number; b: number; total: string }>()) {
      if (!byLp.has(r.lp_asset_id)) byLp.set(r.lp_asset_id, new Map())
      byLp.get(r.lp_asset_id)!.set(r.b, BigInt(r.total || '0'))
    }
    for (const lp of lpAssetIds) {
      const per = byLp.get(lp) ?? new Map<number, bigint>()
      const arr: (bigint | undefined)[] = new Array(n + 1).fill(undefined)
      let last = per.get(-1)
      for (let b = 0; b <= n; b++) { if (per.has(b)) last = per.get(b); arr[b] = last }
      totalByLpBucket.set(lp, arr)
    }
  }

  // 5) Assemble per-lp per-bucket state (only where reserves + positive total supply exist).
  const stateByLp = new Map<number, (XykBucketState | undefined)[]>()
  for (const lp of lpAssetIds) {
    const reg = poolByLp.get(lp)!
    const reserves = reserveByPoolBucket.get(reg.pool_account)
    const totals = totalByLpBucket.get(lp)
    const arr: (XykBucketState | undefined)[] = new Array(n + 1).fill(undefined)
    for (let b = 0; b <= n; b++) {
      const rv = reserves?.[b]; const ts = totals?.[b]
      if (rv && ts && ts > 0n) {
        // Pair each reserve with the asset it belongs to via the snapshot's own
        // (asset_a↔reserve_a) order; fall back to the registry order only for legacy
        // rows that predate the snapshot asset columns.
        const [assetA, assetB] = rv.aa > 0 && rv.ab > 0 ? [rv.aa, rv.ab] : [reg.asset_a, reg.asset_b]
        arr[b] = { assetA, assetB, reserveA: rv.ra, reserveB: rv.rb, totalShares: ts }
      }
    }
    stateByLp.set(lp, arr)
  }
  const underlyingAssetIds = [...new Set(regRows.flatMap(r => [r.asset_a, r.asset_b]))]
  return { lpAssetIds, underlyingAssetIds, stateByLp, farmSharesByLp }
}

// active DCA schedules (reconstructed from indexed events, no RPC)
// A DCA schedule is active if it has a DCA.Scheduled event and is not since
// Completed/Terminated. DCA.Scheduled carries the full order (assetIn/Out, per-trade
// amount, totalAmount, period); progress is summed from DCA.TradeExecuted and the
// next slot from DCA.ExecutionPlanned. totalAmount "0" = open-ended (no remaining).
export interface ActiveDca {
  id: number; assetIn: AssetRef; assetOut: AssetRef; direction: string
  amountPerTrade: string; totalAmount: string; filledAmount: string; remainingAmount: string | null
  executionsDone: number; period: number; nextExecutionBlock: number | null
  valueUsd: number | null; scheduleBlock: number; scheduleIndex: number | null
}

interface DcaScheduleLink { block: number; idx: number | null }
async function getDcaScheduleLinks(ids: Array<string | number>): Promise<Map<string, DcaScheduleLink>> {
  const list = sqlUIntList(ids)
  const out = new Map<string, DcaScheduleLink>()
  if (!list) return out
  const res = await client.query({
    query: `
      SELECT toString(id) AS id,
        argMax(block_height, block_height) AS block,
        argMax(extrinsic_index, block_height) AS idx
      FROM price_data.dca_schedules
      WHERE id IN (${list})
      GROUP BY id`,
    format: 'JSONEachRow',
  })
  for (const r of await res.json<{ id: string; block: number; idx: number | null }>()) out.set(r.id, { block: r.block, idx: r.idx })
  return out
}

async function getActiveDcas(accounts: string[]): Promise<ActiveDca[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  return cached(`explorer:dca-active:${[...accounts].sort().join(',')}`, 15000, async () => {
    const prices = await ensurePrices()
    const schedRes = await client.query({
      query: `SELECT id, block_height AS sblock, extrinsic_index AS sidx,
                asset_in, asset_out, direction, amount_per AS amt_per,
                total_amount AS total, period
              FROM price_data.dca_schedules
              WHERE who IN (${list})
                AND id NOT IN (
                  SELECT id FROM price_data.dca_events WHERE event_name IN ('DCA.Completed','DCA.Terminated')
                )
              ORDER BY block_height DESC`,
      format: 'JSONEachRow',
    })
    const scheds = await schedRes.json<{ id: number; sblock: number; sidx: number | null; asset_in: number; asset_out: number; direction: string; amt_per: string; total: string; period: number }>()
    if (!scheds.length) return []
    const ids = scheds.map(s => s.id).join(',')
    const [exRes, planRes] = await Promise.all([
      client.query({ query: `SELECT id, count() AS n, toString(sum(toUInt256OrZero(amount_in))) AS filled FROM price_data.dca_events WHERE event_name='DCA.TradeExecuted' AND id IN (${ids}) GROUP BY id`, format: 'JSONEachRow' }),
      client.query({ query: `SELECT id, max(planned_block) AS nb FROM price_data.dca_events WHERE event_name='DCA.ExecutionPlanned' AND id IN (${ids}) GROUP BY id`, format: 'JSONEachRow' }),
    ])
    const exMap = new Map<number, { n: number; filled: string }>()
    for (const e of await exRes.json<{ id: number; n: number; filled: string }>()) exMap.set(e.id, { n: e.n, filled: e.filled })
    const planMap = new Map<number, number>()
    for (const p of await planRes.json<{ id: number; nb: number }>()) planMap.set(p.id, p.nb)
    return scheds.map(s => {
      const filled = exMap.get(s.id)?.filled ?? '0'
      let remaining: string | null = null
      try { if (s.total !== '0') remaining = (BigInt(s.total) - BigInt(filled)).toString() } catch { /* keep null */ }
      const aIn = asset(s.asset_in), aOut = asset(s.asset_out)
      // For a Buy order the per-trade amount is the OUTPUT (e.g. "buy 80 USDC"); for
      // a Sell order it's the INPUT ("sell 85 aDOT"). Value it with the matching asset.
      const perAsset = s.direction === 'Buy' ? aOut : aIn
      return {
        id: s.id, assetIn: aIn, assetOut: aOut, direction: s.direction,
        amountPerTrade: s.amt_per, totalAmount: s.total, filledAmount: filled, remainingAmount: remaining,
        executionsDone: exMap.get(s.id)?.n ?? 0, period: s.period, nextExecutionBlock: planMap.get(s.id) ?? null,
        valueUsd: usdValue(prices, perAsset.assetId, s.amt_per, perAsset.decimals),
        scheduleBlock: s.sblock, scheduleIndex: s.sidx,
      }
    })
  })
}

// extrinsic by block-index (design routes #/extrinsic/h-i)
export async function getExtrinsicAt(height: number, index: number): Promise<ExtrinsicDetail | null> {
  return cached(`explorer:extrinsic-at:${height}:${index}`, 10000, async () => {
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, version, coalesce(signer, effective_signer) AS signer, success, call_name, fee, tip, call_args_json, error_json
              FROM price_data.raw_extrinsics WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} LIMIT 1`,
      query_params: { h: height, i: index }, format: 'JSONEachRow',
    })
    const row = (await res.json<ExtrinsicDetailRow>())[0]
    return row ? hydrateExtrinsicDetail(row) : null
  })
}

// single event (block_height + event_index)
export interface EventDetail {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
  phase: string
  extrinsic: ExtrinsicSummary | null
}
export async function getEventAt(height: number, index: number): Promise<EventDetail | null> {
  return cached(`explorer:event-at:${height}:${index}`, 10000, async () => {
    const res = await client.query({
      query: `SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND event_index = {i:UInt32} LIMIT 1`,
      query_params: { h: height, i: index }, format: 'JSONEachRow',
    })
    const e = (await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; args_json: string }>())[0]
    if (!e) return null
    // Phase: an event tied to an extrinsic is in ApplyExtrinsic, otherwise it is
    // an Initialization/Finalization (system) event.
    const phase = e.extrinsic_index != null ? `ApplyExtrinsic(${e.extrinsic_index})` : 'Finalization'
    const extrinsic = e.extrinsic_index != null ? await getExtrinsicSummaryAt(e.block_height, e.extrinsic_index) : null
    return {
      blockHeight: e.block_height, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index, timestamp: e.ts,
      name: e.event_name, args: safeJson(e.args_json), decoded: e.event_name === 'EVM.Log', phase, extrinsic,
    }
  })
}

// Lightweight extrinsic summary (no event list) for embedding in an event detail.
async function getExtrinsicSummaryAt(height: number, index: number): Promise<ExtrinsicSummary | null> {
  const res = await client.query({
    query: `SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, signer, success, call_name, fee
            FROM price_data.raw_extrinsics WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} LIMIT 1`,
    query_params: { h: height, i: index }, format: 'JSONEachRow',
  })
  const row = (await res.json<ExtrinsicSummaryRow>())[0]
  return row ? extrinsicSummary(row) : null
}

// assets registry with prices + total value on Hydration
export type ExplorerAssetType = 'Native' | 'Derivative' | 'Token'
export interface AssetListItem extends AssetRef { price: number | null; change24h: number | null; type: ExplorerAssetType; amountUsd: number | null; holderCount?: number }

function explorerAssetType(asset: AssetRef): ExplorerAssetType {
  if (asset.assetId === 0) return 'Native'
  return ATOKEN_UNDERLYING_ID[asset.assetId] != null || asset.symbol.startsWith('v') || asset.symbol === 'GDOT'
    ? 'Derivative'
    : 'Token'
}

// Total raw balance per asset across all indexed accounts. Mirrors holder-list
// balance semantics: use the current latest balance only. Older non-zero
// observations are historical and must not resurrect current zero-balance holders.
// ERC-20-backed assets also include their separate ERC-20 wallet table.
async function getAssetTotals(): Promise<Map<number, bigint>> {
  return cached('explorer:asset-totals', 60000, async () => {
    const res = await client.query({
      query: `
        SELECT asset_id, toString(sum(bal)) AS raw FROM (
          SELECT account_id, asset_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
          FROM price_data.account_asset_latest_balances
          GROUP BY account_id, asset_id
          UNION ALL
          -- ERC-20-side holdings (HOLLAR) — separate pot, see erc20WalletService.
          SELECT account_id, asset_id, toUInt256OrZero(argMax(total, updated_at)) AS bal
          FROM price_data.erc20_wallet_balances
          GROUP BY account_id, asset_id
        ) GROUP BY asset_id`,
      format: 'JSONEachRow',
    })
    const m = new Map<number, bigint>()
    for (const r of await res.json<{ asset_id: string; raw: string }>()) m.set(parseInt(r.asset_id, 10), BigInt(r.raw || '0'))
    for (const [assetId, raw] of await getATokenTotalSupplies()) m.set(assetId, raw)
    // Pool-share assets are hidden from the directory and displayed as their Giga
    // underlying. Move—not duplicate—their held total onto that visible id. The
    // raw total already includes the aToken custody row exactly once.
    for (const [shareIdText, displayId] of Object.entries(SHARE_TOKEN_UNDERLYING_ID)) {
      const shareId = Number(shareIdText)
      const shareRaw = m.get(shareId) ?? 0n
      if (shareRaw <= 0n) continue
      const normalized = BigInt(rescaleRaw(shareRaw.toString(), asset(shareId).decimals, asset(displayId).decimals))
      m.set(displayId, (m.get(displayId) ?? 0n) + normalized)
    }
    return m
  })
}

export async function getAssetHolderCounts(): Promise<Map<number, number>> {
  return cached('explorer:asset-holder-counts', 60000, async () => {
    const res = await client.query({
      query: `
        SELECT asset_id, count() AS n FROM (
          SELECT account_id, asset_id, sum(bal) AS total_bal FROM (
            SELECT account_id, asset_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
            FROM price_data.account_asset_latest_balances
            GROUP BY account_id, asset_id
            UNION ALL
            SELECT account_id, asset_id, toUInt256OrZero(argMax(total, updated_at)) AS bal
            FROM price_data.erc20_wallet_balances
            GROUP BY account_id, asset_id
          )
          GROUP BY account_id, asset_id
          HAVING total_bal > 0
        )
        GROUP BY asset_id`,
      format: 'JSONEachRow',
    })
    const m = new Map<number, number>()
    for (const r of await res.json<{ asset_id: string; n: string | number }>()) m.set(parseInt(r.asset_id, 10), Number(r.n))
    const knownATokenIds = Object.keys(ATOKEN_UNDERLYING_ID).map(Number)
    try {
      const b0 = await aTokenAnchorBlock()
      if (!b0) return mergeATokenHolderCounts(m, knownATokenIds, [], new Map())
      const reserves = await getATokenReserves()
      const contracts = reserves.map(entry => entry.token.aToken)
      const countCacheKey = [...contracts].map(contract => contract.toLowerCase()).sort().join(',')
      const reconstructed = await cached(
        `explorer:atoken-holder-counts:${b0}:${countCacheKey}`,
        300000,
        () => reconstructATokenHolderCounts(client, contracts, b0),
      )
      return mergeATokenHolderCounts(
        m,
        knownATokenIds,
        reserves.map(entry => ({ assetId: entry.assetId, contract: entry.token.aToken })),
        reconstructed,
      )
    } catch (error) {
      console.error('[Explorer] aToken holder-count reconstruction failed:', error)
      return mergeATokenHolderCounts(m, knownATokenIds, [], new Map())
    }
  })
}

export function mergeATokenHolderCounts(
  base: Map<number, number>,
  knownATokenIds: Iterable<number>,
  active: ReadonlyArray<{ assetId: number; contract: string }>,
  countsByContract: ReadonlyMap<string, number>,
): Map<number, number> {
  const merged = new Map(base)
  for (const assetId of knownATokenIds) merged.delete(assetId)
  for (const { assetId, contract } of active) {
    merged.set(assetId, countsByContract.get(contract.toLowerCase()) ?? 0)
  }
  return merged
}

async function getATokenTotalSupplies(): Promise<Map<number, bigint>> {
  return cached('explorer:atoken-total-supplies', 30000, async () => {
    const out = new Map<number, bigint>()
    const b0 = await aTokenAnchorBlock()
    if (!b0) return out
    const entries = await getATokenReserves()
    const scaledByContract = await reconstructTotalScaled(entries.map(entry => entry.token.aToken), b0)
    for (const { assetId, token, liquidityIndex } of entries) {
      const scaledTotal = scaledByContract.get(token.aToken.toLowerCase()) ?? 0n
      if (scaledTotal <= 0n) continue
      out.set(assetId, (out.get(assetId) ?? 0n) + (scaledTotal * liquidityIndex) / ATOKEN_RAY)
    }
    return out
  })
}

// 7-day daily price samples per asset (oldest→newest) for the assets-list
// sparkline + 7D change. One bounded query over the last ~7 days of blocks —
// no FINAL on the 485M-row prices table (cf. the perf rule).
async function getWeeklyPriceSamples(): Promise<Map<number, number[]>> {
  return cached('explorer:price-samples-7d', 60000, async () => {
    const m = new Map<number, number[]>()
    try {
      const head = await latestPriceBlock()
      if (!head) return m
      const weekStart = Math.max(0, head - 100_800)
      const res = await client.query({
        query: `
          SELECT asset_id, toUInt16(intDiv(toInt64({head:UInt32}) - toInt64(block_height), 2400)) AS bucket,
            toFloat64(argMax(usd_price, block_height)) AS px
          FROM price_data.prices
          WHERE block_height > {weekStart:UInt32} AND block_height <= {head:UInt32} AND usd_price > 0
          GROUP BY asset_id, bucket
          ORDER BY asset_id, bucket DESC`,
        query_params: { head, weekStart },
        format: 'JSONEachRow',
      })
      for (const r of await res.json<{ asset_id: number; bucket: number; px: number }>()) {
        const arr = m.get(r.asset_id) ?? []
        arr.push(r.px) // already ordered oldest (high days_ago) → newest
        m.set(r.asset_id, arr)
      }
      // aTokens borrow the (transitively resolved) underlying's sparkline + 7D.
      for (const aToken of Object.keys(PRICE_ALIAS_ID)) {
        const u = m.get(priceAssetId(Number(aToken)))
        if (u && !m.has(Number(aToken))) m.set(Number(aToken), u)
      }
    } catch { /* prices may be unavailable */ }
    return m
  })
}

export async function getAssets(): Promise<AssetListItem[]> {
  return cached('explorer:assets-list', 30000, async () => {
    const [prices, totals, holderCounts, samples] = await Promise.all([ensurePrices(), getAssetTotals(), getAssetHolderCounts(), getWeeklyPriceSamples()])
    return allExplorerAssets()
      .filter(a => !a.symbol.includes('-Pool') && !a.symbol.startsWith('Asset') && a.symbol.trim() !== '')
      .map(a => {
        // Derivatives (bonds, aTokens) carry no price feed of their own — fall back
        // to the asset they're priced through (a bond redeems 1:1 for its underlying).
        const p = prices.get(a.assetId) ?? prices.get(priceAssetId(a.assetId))
        const type = explorerAssetType(a)
        const raw = totals.get(a.assetId) ?? 0n
        const amountUsd = p ? (Number(raw) / 10 ** a.decimals) * p.price : null
        const holderCount = holderCounts.get(a.assetId)
        const spark = samples.get(a.assetId)
        const change7d = spark && spark.length >= 2 && spark[0] > 0 ? (spark[spark.length - 1] - spark[0]) / spark[0] : null
        return { ...a, price: p?.price ?? null, change24h: p?.change24h ?? null, change7d, type, amountUsd, holderCount, sparkline: spark }
      })
      // Default ordering: total value held on Hydration, descending.
      .sort((x, y) => (y.amountUsd ?? 0) - (x.amountUsd ?? 0) || (y.price ?? 0) - (x.price ?? 0))
  })
}


// events
export interface EventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
}
interface EventSourceRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  event_name: string
  args_json: string
}

function eventRow(row: EventSourceRow): EventRow {
  return {
    blockHeight: row.block_height,
    eventIndex: row.event_index,
    extrinsicIndex: row.extrinsic_index,
    timestamp: row.ts,
    name: row.event_name,
    args: safeJson(row.args_json),
    decoded: row.event_name === 'EVM.Log',
  }
}

function uniqueEventRows(rows: EventSourceRow[]): EventRow[] {
  const seen = new Set<string>()
  return rows.flatMap(row => {
    const key = `${row.block_height}:${row.event_index}`
    if (seen.has(key)) return []
    seen.add(key)
    return [eventRow(row)]
  })
}
export async function getRecentEvents(limit: number, from?: string, to?: string, offset = 0, filters: EventListFilters = {}): Promise<EventRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:events:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const eventFilter = filters.event?.trim() ? textNameFilter('event_name', 'eventName') : ''
    const rows = await withFeedWindow(tw, limit, offset + limit, async (bound) => {
      const res = await client.query({
        query: `
          SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
          FROM price_data.raw_events
          WHERE ${bound}
            ${eventFilter}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset, ...textNameParams('eventName', filters.event) }, format: 'JSONEachRow',
      })
      return res.json<EventSourceRow>()
    })
    return uniqueEventRows(rows)
  })
}

// trades (swaps)
export interface TradeRow {
  dcaScheduleId?: number
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  who: AccountRef | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  venue: string
  dca: boolean
  // The extrinsic a trade should link to (own extrinsic, or the DCA schedule for
  // DCA executions which have no per-execution extrinsic). Null → link to block.
  linkBlock: number | null
  linkIndex: number | null
}
interface RawSwapEventRow {
  block_height: number
  ts: string
  event_index: number
  extrinsic_index: number | null
  event_name: string
  who: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
}

function groupSwapRows(rows: RawSwapEventRow[]): { groups: Map<string, RawSwapEventRow[]>; order: string[] } {
  const groups = new Map<string, RawSwapEventRow[]>()
  const order: string[] = []
  for (const row of rows) {
    const key = row.extrinsic_index != null ? `${row.block_height}:x${row.extrinsic_index}` : `${row.block_height}:e${row.event_index}`
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(row)
  }
  return { groups, order }
}
const SWAP_EVENTS = ['Router.Executed', 'Router.RouteExecuted', 'Omnipool.SellExecuted', 'Omnipool.BuyExecuted', 'Stableswap.SellExecuted', 'Stableswap.BuyExecuted', 'XYK.SellExecuted', 'XYK.BuyExecuted', 'LBP.SellExecuted', 'LBP.BuyExecuted']
// The router's net-trade summary was emitted as Router.RouteExecuted before the
// pallet renamed it to Router.Executed (block ~4,542,080); both carry the same
// {assetIn, assetOut, amountIn, amountOut} args and an empty `who`.
const ROUTER_NET_EVENTS_SQL = `'Router.Executed','Router.RouteExecuted'`
function isRouterNet(eventName: string): boolean {
  return eventName === 'Router.Executed' || eventName === 'Router.RouteExecuted'
}
// The route-executor pallet account ("modlrouterex"). Per-hop AMM events of a routed
// swap are emitted with who=routerex; they're internal legs, not standalone trades —
// the net is captured by the accompanying Router.Executed (who=''). Exclude these hops
// so a multi-hop swap shows as ONE net trade, not one per leg.
const ROUTER_PALLET_ACCT = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
const NOT_ROUTER_HOP = `AND JSONExtractString(args_json,'who') != '${ROUTER_PALLET_ACCT}'`
// DCA keeper-fee legs: a DCA execution swaps the owner's reserved funds directly
// (outside the router) to pay its per-execution fee, emitting an AMM *Executed
// with who=<owner> and no extrinsic. The user's real trade is the paired
// Router.Executed net summary, so these owner-attributed pallet-internal legs are
// internal plumbing that must not surface as standalone "Swap" rows. The three
// pallet-internal swap kinds are disjoint on (extrinsic_index, who): a signed
// user swap has an extrinsic; a router hop / pool leg has a 0x6d6f646c pallet
// `who`; the DCA net trade is Router.Executed with an empty `who`. Only the
// fee leg is pallet-internal AND attributed to a real account — so that triple
// uniquely identifies it. Kept as a pure fn so the SQL filter and the emit-time
// guard share one definition (and it's unit-testable).
export function isDcaFeeLegSwap(extrinsicIndex: number | null, who: string): boolean {
  return extrinsicIndex == null && who !== '' && !who.startsWith('0x6d6f646c')
}
const NOT_DCA_FEE_LEG = `AND NOT (extrinsic_index IS NULL AND JSONExtractString(args_json,'who') != '' AND JSONExtractString(args_json,'who') NOT LIKE '0x6d6f646c%')`
// Before the router event rename (block 4,542,080) the AMM legs of a DCA
// execution ran with the owner's account — including module pots (treasury
// buyback DCAs), which the who-based fee-leg triple can't catch. In that era a
// DCA execution always emits the Router.RouteExecuted net summary, so hide
// unsigned non-net hops in blocks where a DCA trade actually executed; pot
// hook swaps in DCA-free blocks keep surfacing as their own trades.
const ROUTER_NET_RENAME_BLOCK = 4_542_080
const NOT_LEGACY_DCA_HOP = `AND NOT (extrinsic_index IS NULL AND block_height < ${ROUTER_NET_RENAME_BLOCK} AND event_name NOT IN (${ROUTER_NET_EVENTS_SQL}) AND block_height IN (SELECT block_height FROM price_data.dca_events WHERE event_name = 'DCA.TradeExecuted' AND block_height < ${ROUTER_NET_RENAME_BLOCK}))`
const HOLLAR_ASSET_ID = 222
function positiveAccountVolumes(rows: Array<{ account_id: string; volume_usd: number }>): Map<string, number> {
  const volumes = new Map<string, number>()
  for (const row of rows) {
    if (row.volume_usd > 0) volumes.set(row.account_id, Number(row.volume_usd))
  }
  return volumes
}

async function tradingVolumeByAccount(accounts: string[]): Promise<Map<string, number>> {
  const safe = [...new Set(accounts.map(a => a.toLowerCase()).filter(a => ACCOUNT_RE.test(a)))]
  if (!safe.length) return new Map()
  const list = sqlAccountList(safe)
  const src = accountVolumeSource()
  const res = await client.query({
    query: `
      SELECT account AS account_id, toFloat64(sum(${src.col})) AS volume_usd
      FROM ${src.table}
      WHERE account IN (${list})
      GROUP BY account_id`,
    format: 'JSONEachRow',
  })
  return positiveAccountVolumes(await res.json<{ account_id: string; volume_usd: number }>())
}
// Liquidations are globally rare (a few thousand events), so the collateral is
// always valued at its block-time price — cheap even for the unfiltered
// accounts-list sort.
function liquidationVolumeCtes(accountFilter = ''): string {
  const accountExpr = `lower(ifNull(account_id, ''))`
  const accountWhere = accountFilter ? `AND ${accountExpr} IN (${accountFilter})` : ''
  const assetExpr = mmAssetIdSql('asset_address')
  return `
            liquidation_legs AS (
              SELECT
                ${accountExpr} AS account_id,
                ${assetExpr} AS asset_id,
                block_timestamp AS block_time,
                JSONExtractString(decoded_args_json, 'liquidatedCollateralAmount') AS amount
              FROM price_data.raw_money_market_events
              WHERE event_name = 'LiquidationCall'
                AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})
                AND ${mmAssetKnownSql('asset_address')}
                AND ${accountExpr} != ''
                ${accountWhere}
            ),
            ${historicalVolumeSql('liquidation_legs', 'liquidation_volume_raw')}`
}
async function liquidationVolumeByAccount(accounts: string[]): Promise<Map<string, number>> {
  const safe = [...new Set(accounts.map(a => a.toLowerCase()).filter(a => ACCOUNT_RE.test(a)))]
  if (!safe.length) return new Map()
  const list = sqlAccountList(safe)
  const res = await client.query({
    query: `
      WITH
        ${liquidationVolumeCtes(list)}
      SELECT account_id, toFloat64(sum(volume_usd)) AS volume_usd
      FROM liquidation_volume_raw
      GROUP BY account_id`,
    format: 'JSONEachRow',
  })
  return positiveAccountVolumes(await res.json<{ account_id: string; volume_usd: number }>())
}
// One trade per extrinsic (or per event for pallet-internal swaps), summarizing
// all hops/legs. A routed swap emits Router.Executed (net in→out) plus per-hop
// AMM events and many transfer legs (pool/fee/referral) — we keep just the net
// trade and attribute it to the extrinsic signer (or the AMM `who` when unsigned).
async function getRecentTrades(limit: number, from?: string, to?: string, offset = 0, filters: ValueListFilters = {}): Promise<TradeRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:trades:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
    const tokenIds = assetIdsForToken(filters.token)
    const useAssetSwapReadModel = tokenIds != null
    const swapTable = useAssetSwapReadModel ? 'asset_swap_activity' : 'swap_activity'
    const tokenFilter = tokenIds == null ? '' : tokenIds.length
      ? `AND asset_id IN (${tokenIds.join(',')})`
      : 'AND 0'
    const tokenRefsFilter = ''
    const assetOutExpr = 'asset_out'
    const amountOutExpr = 'amount_out'
    const postUsdFilter = filters.min != null && filters.unit !== 'token'
    const amountFilter = eventValueFilterSql(assetOutExpr, amountOutExpr, 'block_timestamp',
      postUsdFilter ? { ...filters, min: undefined, unit: undefined } : filters, prices, 'trade_price')
    const notRouterHop = `AND who != '${ROUTER_PALLET_ACCT}'`
    const notDcaFeeLeg = `AND NOT (extrinsic_index IS NULL AND who != '' AND who NOT LIKE '0x6d6f646c%') ${NOT_LEGACY_DCA_HOP}`
    const want = offset + limit
    const scanLimit = Math.max(want * 8, 200)
    const fetchRaw = async (bound: string, pageLimit: number): Promise<RawSwapEventRow[]> => {
      const res = await client.query({
        query: `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who AS who,
            asset_in AS asset_in,
            asset_out AS asset_out,
            amount_in AS amount_in,
            amount_out AS amount_out
          FROM price_data.${swapTable}
          ${amountFilter.joinSql}
          WHERE ${bound} AND event_name IN (${names}) ${notRouterHop} ${notDcaFeeLeg}
            ${tokenRefsFilter}
            ${tokenFilter}
            ${amountFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32}`,
        query_params: { limit: pageLimit }, format: 'JSONEachRow',
      })
      return res.json<RawSwapEventRow>()
    }
    const buildRows = async (rows: RawSwapEventRow[], maxRows?: number): Promise<TradeRow[]> => {
      if (!rows.length) return []
      // DCA: executions are unsigned (block hooks) and the AMM `who` is a pallet
      // account. DCA.TradeExecuted carries the real owner + schedule id (match on
      // block+amountIn); DCA.Scheduled maps id → its scheduling extrinsic for links.
      const dcaBlocks = [...new Set(rows.map(r => r.block_height))]
      const dcaRows: { block_height: number; event_index: number; who: string; id: string; amount_in: string }[] = []
      for (let start = 0; start < dcaBlocks.length; start += 2_000) {
        const dcaRes = await client.query({
          query: `SELECT block_height, event_index, who, toString(id) AS id, amount_in
                  FROM price_data.dca_events
                  WHERE event_name='DCA.TradeExecuted' AND block_height IN {dcaBlocks:Array(UInt32)}`,
          query_params: { dcaBlocks: dcaBlocks.slice(start, start + 2_000) },
          format: 'JSONEachRow',
        })
        dcaRows.push(...await dcaRes.json<{ block_height: number; event_index: number; who: string; id: string; amount_in: string }>())
      }
      // Same-block executions with the same per-trade amount are common (popular
      // round DCA sizes), so (block, amountIn) alone collides across schedules.
      // Keep every candidate and claim by adjacency: DCA.TradeExecuted follows
      // its swap's events, so the swap claims the nearest candidate after its
      // own event index and consumes it — two swaps can never share one.
      const dcaByAmount = new Map<string, { who: string; id: string; event_index: number }[]>()
      for (const d of dcaRows) {
        const k = `${d.block_height}:${d.amount_in}`
        const list = dcaByAmount.get(k) ?? []
        list.push({ who: d.who, id: d.id, event_index: Number(d.event_index) })
        dcaByAmount.set(k, list)
      }
      for (const list of dcaByAmount.values()) list.sort((a, b) => a.event_index - b.event_index)
      const claimDca = (block: number, amountIn: string, eventIndex: number) => {
        const list = dcaByAmount.get(`${block}:${amountIn}`)
        if (!list?.length) return undefined
        let idx = list.findIndex(d => d.event_index > eventIndex)
        if (idx === -1) idx = list.length - 1
        return list.splice(idx, 1)[0]
      }
      const dcaIds = [...new Set(dcaRows.map(d => d.id))].filter(Boolean)
      const schedById = await getDcaScheduleLinks(dcaIds)

      // Group by extrinsic (signed) or by event (pallet-internal); within a group
      // prefer Router.Executed (the net summary) over individual AMM hop events.
      const { groups, order } = groupSwapRows(rows)
      const pairs = rows.map(r => [r.block_height, r.extrinsic_index] as [number, number | null])
      const [signers, liqExt] = await Promise.all([signersFor(pairs), liquidationExtrinsics(pairs)])
      const out: TradeRow[] = []
      for (const key of order) {
        if (maxRows != null && out.length >= maxRows) break
        const g = groups.get(key)!
        const rep = g.find(r => isRouterNet(r.event_name)) ?? g[0]
        if (isDcaFeeLegSwap(rep.extrinsic_index, rep.who)) continue
        if (rep.extrinsic_index != null && liqExt.has(`${rep.block_height}:${rep.extrinsic_index}`)) continue
        const venue = rep.event_name.split('.')[0]
        const signer = rep.extrinsic_index != null ? signers.get(`${rep.block_height}:${rep.extrinsic_index}`) : undefined
        const dcaHit = rep.extrinsic_index == null ? claimDca(rep.block_height, rep.amount_in, rep.event_index) : undefined
        const sched = dcaHit ? schedById.get(dcaHit.id) : undefined
        const actor = signer ?? dcaHit?.who ?? (rep.who && ACCOUNT_RE.test(rep.who) ? rep.who : null)
        const aOut = asset(rep.asset_out)
        out.push({
          blockHeight: rep.block_height, timestamp: rep.ts, eventIndex: rep.event_index, extrinsicIndex: rep.extrinsic_index,
          who: actor ? accountRef(actor) : null,
          assetIn: asset(rep.asset_in), assetOut: aOut, amountIn: rep.amount_in, amountOut: rep.amount_out,
          valueUsd: usdValue(prices, aOut.assetId, rep.amount_out, aOut.decimals),
          venue: venue === 'Router' ? 'Router' : venue, dca: !!dcaHit,
          dcaScheduleId: dcaHit ? Number(dcaHit.id) || undefined : undefined,
          linkBlock: sched ? sched.block : rep.extrinsic_index != null ? rep.block_height : null,
          linkIndex: sched ? sched.idx : rep.extrinsic_index,
        })
      }
      await applyHistoricalUsd(out, tradeHistPick)
      return out
    }
    if (postUsdFilter) {
      let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
      const deep = await fetchFilteredDeep(tw, want, async (bound, pageLimit) => {
        let raw = await fetchRaw(bound, pageLimit)
        pageState = {
          scanned: raw.length,
          cursor: raw.length ? { blockHeight: raw.at(-1)!.block_height, eventIndex: raw.at(-1)!.event_index } : null,
        }
        // A cursor page may split the swap events of its last extrinsic. Complete
        // that boundary block and advance past the whole block so grouping stays
        // identical to the unpaged feed.
        if (raw.length >= pageLimit) {
          const boundary = raw.at(-1)!.block_height
          const boundaryRows = await fetchRaw(`(${tw ?? '1'}) AND block_height = ${boundary}`, 25_000)
          const byEvent = new Map(raw.map(row => [`${row.block_height}:${row.event_index}`, row]))
          for (const row of boundaryRows) byEvent.set(`${row.block_height}:${row.event_index}`, row)
          raw = [...byEvent.values()].sort((a, b) => b.block_height - a.block_height || b.event_index - a.event_index)
          pageState.cursor = { blockHeight: boundary, eventIndex: 0 }
        }
        return buildRows(raw)
      }, row => rowMeetsExactUsdMinimum(row, filters.min!),
      row => row.blockHeight, row => row.eventIndex,
      row => `${row.blockHeight}:${row.extrinsicIndex == null ? `e${row.eventIndex}` : `x${row.extrinsicIndex}`}`,
      { pageSize: 25_000, pageState: () => pageState })
      return deep.slice(offset, offset + limit)
    }
    const rows = await withFeedWindow(tw, scanLimit, scanLimit, bound => fetchRaw(bound, scanLimit))
    const out = await buildRows(rows, want)
    if (out.length < want && rows.length >= scanLimit) throw activityQueryTooBroad()
    return out.slice(offset, offset + limit)
  })
}

// trade detail
// One user trade = the swap events of one extrinsic: a routed swap has a
// Router.Executed net summary plus per-hop AMM events; a direct AMM call has a
// single *Executed event. The call args carry the route and the slippage limit.

export interface SwapAmounts { assetIn: number; assetOut: number; amountIn: string; amountOut: string }
// XYK events name their amounts amount/salePrice (sell) and amount/buyPrice
// (buy); everything else uses amountIn/amountOut.
export function swapEventAmounts(name: string, args: Record<string, unknown>): SwapAmounts {
  const s = (v: unknown) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
  const n = (v: unknown) => Number(v ?? NaN)
  const base = { assetIn: n(args.assetIn), assetOut: n(args.assetOut) }
  if (name === 'XYK.SellExecuted' || name === 'LBP.SellExecuted') return { ...base, amountIn: s(args.amount), amountOut: s(args.salePrice) }
  if (name === 'XYK.BuyExecuted' || name === 'LBP.BuyExecuted') return { ...base, amountIn: s(args.buyPrice), amountOut: s(args.amount) }
  return { ...base, amountIn: s(args.amountIn), amountOut: s(args.amountOut) }
}

export interface TradeLimitSpec { kind: 'minReceived' | 'maxPaid'; amount: string; assetId: number }
// The slippage-protection limit of a swap call. XYK's `maxLimit` arg is the
// min-received on sell and the max-paid on buy (pallet quirk).
export function parseTradeLimit(callName: string, args: Record<string, unknown>): TradeLimitSpec | null {
  const s = (v: unknown) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
  const n = (v: unknown) => typeof v === 'number' ? v : null
  const minReceived = (amount: string | null) => amount != null && n(args.assetOut) != null ? { kind: 'minReceived' as const, amount, assetId: n(args.assetOut)! } : null
  const maxPaid = (amount: string | null) => amount != null && n(args.assetIn) != null ? { kind: 'maxPaid' as const, amount, assetId: n(args.assetIn)! } : null
  switch (callName) {
    case 'Router.sell': case 'Router.sell_all': return minReceived(s(args.minAmountOut))
    case 'Router.buy': return maxPaid(s(args.maxAmountIn))
    case 'Omnipool.sell': case 'Stableswap.sell': return minReceived(s(args.minBuyAmount))
    case 'Omnipool.buy': case 'Stableswap.buy': return maxPaid(s(args.maxSellAmount))
    case 'XYK.sell': return minReceived(s(args.maxLimit) ?? s(args.minBought))
    case 'XYK.buy': return maxPaid(s(args.maxLimit) ?? s(args.maxSold))
    default: return null
  }
}

// Route hops from a Router call's args ([] for direct AMM calls / wrapped calls).
export function parseRouteHops(args: Record<string, unknown>): { pool: string; poolId: number | null; assetIn: number; assetOut: number }[] {
  const route = Array.isArray(args.route) ? args.route as Record<string, unknown>[] : []
  return route.map(h => {
    const pool = h.pool as Record<string, unknown> | string | undefined
    const kind = typeof pool === 'object' && pool ? String(pool.__kind ?? 'Pool') : typeof pool === 'string' ? pool : 'Pool'
    const poolId = typeof pool === 'object' && pool && typeof pool.value === 'number' ? pool.value as number : null
    return { pool: kind, poolId, assetIn: Number(h.assetIn), assetOut: Number(h.assetOut) }
  }).filter(h => Number.isFinite(h.assetIn) && Number.isFinite(h.assetOut))
}

// Headroom between the executed amount and the protection limit, in percent:
// how far above the min-received floor / under the max-paid ceiling the trade
// landed. Null when no meaningful limit was set (0 = unprotected).
export function limitMarginPct(kind: 'minReceived' | 'maxPaid', limitAmount: string, executed: string): number | null {
  const lim = Number(limitAmount), ex = Number(executed)
  if (!(lim > 0) || !(ex > 0)) return null
  return kind === 'minReceived' ? (ex - lim) / lim * 100 : (lim - ex) / lim * 100
}

export interface TradeHop {
  pool: string
  poolId: number | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string | null   // executed amounts when the hop emitted an event
  amountOut: string | null  // (Aave wrap hops don't)
  fee: { amount: string; asset: AssetRef } | null
}
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
  executionPrice: number | null   // assetOut per 1 assetIn
  limit: { kind: 'minReceived' | 'maxPaid'; amount: string; asset: AssetRef; marginPct: number | null } | null
  extrinsicFee: string | null
  route: TradeHop[]
  dca: boolean
}

function tradeHopFee(name: string, args: Record<string, unknown>, outId: number): TradeHop['fee'] {
  const sv = (v: unknown) => (typeof v === 'string' && v !== '0') ? v : null
  if (name.startsWith('XYK.') || name.startsWith('LBP.')) {
    const amt = sv(args.feeAmount); const fa = Number(args.feeAsset)
    return amt && Number.isFinite(fa) ? { amount: amt, asset: asset(fa) } : null
  }
  const amt = name.startsWith('Omnipool.') ? sv(args.assetFeeAmount) : sv(args.fee)
  return amt ? { amount: amt, asset: asset(outId) } : null
}

function syntheticRoutePool(assetInId: number, assetOutId: number): string {
  if (ATOKEN_UNDERLYING_ID[assetInId] === assetOutId || ATOKEN_UNDERLYING_ID[assetOutId] === assetInId) return 'Aave'
  if (assetInId === HOLLAR_ASSET_ID || assetOutId === HOLLAR_ASSET_ID) return 'Hollar'
  return 'Router'
}

function swapEventToHop(e: { name: string; args: Record<string, unknown> }): TradeHop {
  const a = swapEventAmounts(e.name, e.args)
  return {
    pool: e.name.split('.')[0],
    poolId: typeof e.args.poolId === 'number' ? e.args.poolId : null,
    assetIn: asset(a.assetIn),
    assetOut: asset(a.assetOut),
    amountIn: a.amountIn || null,
    amountOut: a.amountOut || null,
    fee: tradeHopFee(e.name, e.args, a.assetOut),
  }
}

async function inferredRouterRoute(height: number, eventIndex: number, netAmts: SwapAmounts): Promise<TradeHop[]> {
  const names = SWAP_EVENTS.filter(n => !isRouterNet(n)).map(n => `'${n}'`).join(',')
  const res = await client.query({
    query: `
      WITH (
        SELECT ifNull(max(event_index), -1) AS idx
        FROM price_data.raw_events
        WHERE block_height = {h:UInt32} AND event_index < {e:UInt32} AND event_name IN (${ROUTER_NET_EVENTS_SQL})
      ) AS prev_router
      SELECT event_index, event_name, args_json
      FROM price_data.raw_events
      WHERE block_height = {h:UInt32}
        AND event_index > prev_router
        AND event_index < {e:UInt32}
        AND event_name IN (${names})
        AND JSONExtractString(args_json, 'who') = '${ROUTER_PALLET_ACCT}'
      ORDER BY event_index ASC`,
    query_params: { h: height, e: eventIndex }, format: 'JSONEachRow',
  })
  const rows = await res.json<{ event_index: number; event_name: string; args_json: string }>()
  const route = rows.map(r => swapEventToHop({ name: r.event_name, args: (safeJson(r.args_json) ?? {}) as Record<string, unknown> }))
  if (!route.length) {
    return [{
      pool: 'Router',
      poolId: null,
      assetIn: asset(netAmts.assetIn),
      assetOut: asset(netAmts.assetOut),
      amountIn: netAmts.amountIn || null,
      amountOut: netAmts.amountOut || null,
      fee: null,
    }]
  }
  const first = route[0]
  if (first.assetIn.assetId !== netAmts.assetIn) {
    route.unshift({
      pool: syntheticRoutePool(netAmts.assetIn, first.assetIn.assetId),
      poolId: null,
      assetIn: asset(netAmts.assetIn),
      assetOut: first.assetIn,
      amountIn: netAmts.amountIn || null,
      amountOut: first.amountIn,
      fee: null,
    })
  }
  const last = route[route.length - 1]
  if (last.assetOut.assetId !== netAmts.assetOut) {
    route.push({
      pool: syntheticRoutePool(last.assetOut.assetId, netAmts.assetOut),
      poolId: null,
      assetIn: last.assetOut,
      assetOut: asset(netAmts.assetOut),
      amountIn: last.amountOut,
      amountOut: netAmts.amountOut || null,
      fee: null,
    })
  }
  return route
}

export async function getTradeDetail(height: number, index: number): Promise<TradeDetail | null> {
  return cached(`explorer:trade:${height}:${index}`, 60_000, async () => {
    const prices = await ensurePrices()
    const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
    const [evRes, extRes] = await Promise.all([
      client.query({
        query: `SELECT event_index, event_name, args_json, toString(block_timestamp) AS ts
                FROM price_data.raw_events
                WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} AND event_name IN (${names})
                ORDER BY event_index`,
        query_params: { h: height, i: index }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT toString(block_timestamp) AS ts, extrinsic_hash, success, signer, effective_signer, fee, call_name, call_args_json
                FROM price_data.raw_extrinsics
                WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} LIMIT 1`,
        query_params: { h: height, i: index }, format: 'JSONEachRow',
      }),
    ])
    const evRows = await evRes.json<{ event_index: number; event_name: string; args_json: string; ts: string }>()
    if (!evRows.length) return null
    const evs = evRows.map(r => ({ idx: r.event_index, name: r.event_name, ts: r.ts, args: (safeJson(r.args_json) ?? {}) as Record<string, unknown> }))
    const ext = (await extRes.json<{ ts: string; extrinsic_hash: string; success: number | boolean; signer: string | null; effective_signer: string | null; fee: string | null; call_name: string; call_args_json: string }>())[0]
    const callName = ext?.call_name ?? ''
    const callArgs = (safeJson(ext?.call_args_json ?? '') ?? {}) as Record<string, unknown>

    // Net trade: the Router.Executed summary when routed, else the first event
    // that isn't a router-internal hop.
    const routerNet = evs.find(e => isRouterNet(e.name))
    const nonHop = evs.filter(e => !isRouterNet(e.name) && String(e.args.who ?? '') !== ROUTER_PALLET_ACCT)
    const net = routerNet ?? nonHop[0] ?? evs[0]
    const netAmts = swapEventAmounts(net.name, net.args)
    const direction: 'Sell' | 'Buy' = net.name.includes('Buy') ? 'Buy'
      : isRouterNet(net.name) && /\.buy$/.test(callName) ? 'Buy' : 'Sell'

    const hopEvents = evs.filter(e => !isRouterNet(e.name))
    const routeSpecs = parseRouteHops(callArgs)
    const route: TradeHop[] = routeSpecs.length
      ? routeSpecs.map(spec => {
          // Match the executed event for this hop by its asset pair; Aave wrap
          // hops emit no event and keep null amounts (1:1 wraps).
          const ev = hopEvents.find(e => { const a = swapEventAmounts(e.name, e.args); return a.assetIn === spec.assetIn && a.assetOut === spec.assetOut })
          const a = ev ? swapEventAmounts(ev.name, ev.args) : null
          return { pool: spec.pool, poolId: spec.poolId, assetIn: asset(spec.assetIn), assetOut: asset(spec.assetOut), amountIn: a?.amountIn || null, amountOut: a?.amountOut || null, fee: ev ? tradeHopFee(ev.name, ev.args, spec.assetOut) : null }
        })
      : hopEvents.map(swapEventToHop)

    const limitSpec = parseTradeLimit(callName, callArgs)
    const limit = limitSpec ? {
      kind: limitSpec.kind, amount: limitSpec.amount, asset: asset(limitSpec.assetId),
      marginPct: limitMarginPct(limitSpec.kind, limitSpec.amount, limitSpec.kind === 'maxPaid' ? netAmts.amountIn : netAmts.amountOut),
    } : null

    const aIn = asset(netAmts.assetIn), aOut = asset(netAmts.assetOut)
    const inNum = Number(netAmts.amountIn) / 10 ** aIn.decimals
    const outNum = Number(netAmts.amountOut) / 10 ** aOut.decimals
    const netWho = String(net.args.who ?? '')
    const actorId = ext?.effective_signer || ext?.signer || (ACCOUNT_RE.test(netWho) && netWho !== ROUTER_PALLET_ACCT ? netWho : null)
    const detail: TradeDetail = {
      blockHeight: height, timestamp: ext?.ts ?? net.ts, extrinsicIndex: index, eventIndex: net.idx,
      hash: ext?.extrinsic_hash ?? null,
      success: ext ? !!ext.success : true,
      who: actorId ? accountRef(actorId) : null,
      venue: routerNet ? 'Router' : net.name.split('.')[0],
      direction,
      assetIn: aIn, assetOut: aOut, amountIn: netAmts.amountIn, amountOut: netAmts.amountOut,
      valueUsd: usdValue(prices, aOut.assetId, netAmts.amountOut, aOut.decimals),
      executionPrice: inNum > 0 && outNum > 0 ? outNum / inNum : null,
      limit,
      extrinsicFee: ext?.fee ?? null,
      route,
      dca: callName.startsWith('DCA.'),
    }
    await applyHistoricalUsd([detail], d => ({ assetId: d.assetOut.assetId, decimals: d.assetOut.decimals, raw: d.amountOut, ts: d.timestamp }))
    return detail
  })
}

export async function getTradeDetailByEvent(height: number, eventIndex: number): Promise<TradeDetail | null> {
  return cached(`explorer:trade-event:${height}:${eventIndex}`, 60_000, async () => {
    const prices = await ensurePrices()
    const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
    const evRes = await client.query({
      query: `SELECT event_index, extrinsic_index, event_name, args_json, toString(block_timestamp) AS ts
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND event_index = {e:UInt32} AND event_name IN (${names})
              LIMIT 1`,
      query_params: { h: height, e: eventIndex }, format: 'JSONEachRow',
    })
    const ev = (await evRes.json<{ event_index: number; extrinsic_index: number | null; event_name: string; args_json: string; ts: string }>())[0]
    if (!ev) return null
    if (ev.extrinsic_index != null) return getTradeDetail(height, ev.extrinsic_index)

    const args = (safeJson(ev.args_json) ?? {}) as Record<string, unknown>
    const netAmts = swapEventAmounts(ev.event_name, args)
    const aIn = asset(netAmts.assetIn), aOut = asset(netAmts.assetOut)
    const inNum = Number(netAmts.amountIn) / 10 ** aIn.decimals
    const outNum = Number(netAmts.amountOut) / 10 ** aOut.decimals
    const direction: 'Sell' | 'Buy' = ev.event_name.includes('Buy') ? 'Buy' : 'Sell'
    const netWho = String(args.who ?? '')

    const dcaRes = await client.query({
      query: `SELECT who, amount_in, event_index
              FROM price_data.dca_events
              WHERE block_height = {h:UInt32} AND event_name = 'DCA.TradeExecuted'
              LIMIT 1000`,
      query_params: { h: height }, format: 'JSONEachRow',
    })
    // Same-amount executions can share a block; DCA.TradeExecuted follows its
    // swap's events, so prefer the nearest matching row after this event.
    const dcaCandidates = (await dcaRes.json<{ who: string; amount_in: string; event_index: number }>())
      .filter(d => d.amount_in === netAmts.amountIn)
      .sort((a, b) => Number(a.event_index) - Number(b.event_index))
    const dca = dcaCandidates.find(d => Number(d.event_index) > eventIndex) ?? dcaCandidates.at(-1)
    const actorId = dca?.who || (ACCOUNT_RE.test(netWho) && netWho !== ROUTER_PALLET_ACCT ? netWho : null)

    const route: TradeHop[] = isRouterNet(ev.event_name)
      ? await inferredRouterRoute(height, eventIndex, netAmts)
      : [swapEventToHop({ name: ev.event_name, args })]

    const detail: TradeDetail = {
      blockHeight: height, timestamp: ev.ts, extrinsicIndex: null, eventIndex,
      hash: null,
      success: true,
      who: actorId ? accountRef(actorId) : null,
      venue: ev.event_name.split('.')[0],
      direction,
      assetIn: aIn, assetOut: aOut, amountIn: netAmts.amountIn, amountOut: netAmts.amountOut,
      valueUsd: usdValue(prices, aOut.assetId, netAmts.amountOut, aOut.decimals),
      executionPrice: inNum > 0 && outNum > 0 ? outNum / inNum : null,
      limit: null,
      extrinsicFee: null,
      route,
      dca: !!dca,
    }
    await applyHistoricalUsd([detail], d => ({ assetId: d.assetOut.assetId, decimals: d.assetOut.decimals, raw: d.amountOut, ts: d.timestamp }))
    return detail
  })
}

// Map (block_height, extrinsic_index) → signer account_id for a set of rows.
// Used to attribute pallet-internal events (trades) to the real transaction author.
async function signersFor(pairs: [number, number | null][]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = [...new Set(pairs.filter(([, i]) => i != null).map(([h, i]) => `${h}:${i}`))]
  if (!keys.length) return out
  for (let start = 0; start < keys.length; start += 5_000) {
    const tuples = keys.slice(start, start + 5_000).map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index, coalesce(signer, effective_signer) AS signer FROM price_data.raw_extrinsics WHERE (block_height, extrinsic_index) IN (${tuples}) AND coalesce(signer, effective_signer) IS NOT NULL AND coalesce(signer, effective_signer) != ''`,
      format: 'JSONEachRow',
    })
    for (const r of await res.json<{ block_height: number; extrinsic_index: number; signer: string }>()) out.set(`${r.block_height}:${r.extrinsic_index}`, r.signer)
  }
  return out
}

// The subset of (block, extrinsic) pairs whose extrinsic emitted a
// Liquidation.Liquidated event. A liquidation repays the debt by swapping the
// seized collateral via the router (emitting a Router.Executed that the trade
// builders would otherwise surface as a standalone trade attributed to the
// liquidator). The liquidation is already represented by its LiquidationCall (mm)
// row, so callers skip these extrinsics when building trade rows. Bounded by the
// caller's pairs (small IN list), like signersFor.
async function liquidationExtrinsics(pairs: [number, number | null][]): Promise<Set<string>> {
  const out = new Set<string>()
  const keys = [...new Set(pairs.filter(([, i]) => i != null).map(([h, i]) => `${h}:${i}`))]
  if (!keys.length) return out
  for (let start = 0; start < keys.length; start += 5_000) {
    const tuples = keys.slice(start, start + 5_000).map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
    const res = await client.query({
      query: `SELECT DISTINCT block_height, extrinsic_index FROM price_data.raw_events
              WHERE (block_height, extrinsic_index) IN (${tuples}) AND event_name = 'Liquidation.Liquidated'`,
      format: 'JSONEachRow',
    })
    for (const r of await res.json<{ block_height: number; extrinsic_index: number }>()) out.add(`${r.block_height}:${r.extrinsic_index}`)
  }
  return out
}

// The subset of (block, extrinsic) pairs whose call is a genuine token-transfer
// call. Used to keep only real donations to the treasury pot on a transfer feed:
// a transfer *to* py/trsry emitted by any other call (a batch/swap fee, a
// Referrals.register_code deposit, an XCM inherent's fee) is a fee/deposit, not a
// user transfer.
async function transferCallExtrinsics(pairs: [number, number | null][]): Promise<Set<string>> {
  const out = new Set<string>()
  const keys = [...new Set(pairs.filter(([, i]) => i != null).map(([h, i]) => `${h}:${i}`))]
  if (!keys.length) return out
  const callList = [...TRANSFER_CALL_NAMES].map(c => `'${c}'`).join(',')
  for (let start = 0; start < keys.length; start += 5_000) {
    const tuples = keys.slice(start, start + 5_000).map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index FROM price_data.raw_extrinsics
              WHERE (block_height, extrinsic_index) IN (${tuples}) AND call_name IN (${callList})`,
      format: 'JSONEachRow',
    })
    for (const r of await res.json<{ block_height: number; extrinsic_index: number }>()) out.add(`${r.block_height}:${r.extrinsic_index}`)
  }
  return out
}

// Map (block_height, event_index) → extrinsic_index, so balance-observation
// activity rows can link to their originating extrinsic (h-i) rather than the block.
async function extrinsicIndexFor(pairs: [number, number | null][]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const keys = [...new Set(pairs.filter(([, e]) => e != null).map(([h, e]) => `${h}:${e}`))]
  if (!keys.length) return out
  const tuples = keys.map(k => { const [h, e] = k.split(':'); return `(${h},${e})` }).join(',')
  const res = await client.query({
    query: `SELECT block_height, event_index, extrinsic_index FROM price_data.raw_events WHERE (block_height, event_index) IN (${tuples}) AND extrinsic_index IS NOT NULL`,
    format: 'JSONEachRow',
  })
  for (const r of await res.json<{ block_height: number; event_index: number; extrinsic_index: number }>()) out.set(`${r.block_height}:${r.event_index}`, r.extrinsic_index)
  return out
}

// unified activity
export interface ActivityRow {
  type: 'transfer' | 'trade' | 'xcm' | 'liquidity' | 'mm' | 'dca' | 'staking' | 'vote' | 'otc'
  blockHeight: number
  timestamp: string
  eventIndex?: number | null
  extrinsicIndex: number | null
  who: AccountRef | null
  to: AccountRef | null
  asset: AssetRef | null
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  amount: string | null
  amountIn: string | null
  amountOut: string | null
  valueUsd: number | null
  liqAction?: 'Add' | 'Remove' | 'Create' | 'Claim'   // Create = pool creation; Claim = LM reward claim
  mmAction?: string          // money-market: Supply/Borrow/Repay/Withdraw/LiquidationCall
  mmMarketKey?: string       // absent for legacy/unknown pools; `core` is primary
  mmMarket?: string          // display label; UI only calls out supplemental markets
  stakingAction?: string
  votePallet?: string
  voteAction?: string
  voteRef?: string | null
  voteSide?: string
  voteConviction?: string | null
  destChain?: string         // xcm outbound: destination chain name
  destParachainId?: number | null
  destAccount?: {
    kind: 'AccountId32' | 'AccountKey20'; address: string; raw: string; subscanUrl: string | null
    emoji?: string; emojiName?: string; emojiUrl?: string
    tag?: { id: string; name: string; color: string; icon: string } | null
    identity?: { display: string; verified: boolean } | null
  }
  xcmDir?: 'in' | 'out'      // xcm: transfer direction relative to Hydration
  fromChain?: string         // xcm inbound: origin chain name
  fromParachainId?: number | null
  // Source account of an inbound transfer, resolved from the Ocelloids
  // crosschain index (best-effort — absent for old rows or when the API is
  // unavailable). Same shape/semantics as destAccount.
  fromAccount?: ActivityRow['destAccount']
  messageId?: string | null  // xcm inbound: message topic id (MessageQueue.Processed)
  // Origin-chain extrinsic of an inbound transfer (explorer deep link) —
  // resolved with fromAccount from the crosschain journey index.
  fromTxUrl?: string | null
  dca?: boolean
  dcaStatus?: 'failed'
  dcaError?: string
  // The owning DCA schedule (links execution rows to the schedule page).
  dcaScheduleId?: number
  // Explicit link target (DCA executions link to the schedule extrinsic).
  linkBlock?: number | null
  linkIndex?: number | null
  otcAction?: 'Place' | 'Pull' | 'Fill'
  otcOrderId?: number
  otcPartial?: boolean            // fill came from OTC.PartiallyFilled
  otcPartiallyFillable?: boolean  // Placed order property
  otcFee?: string                 // fills; denominated in assetOut
}

function moneyMarketActivityFields(poolAddress: string | null | undefined): Pick<ActivityRow, 'mmMarketKey' | 'mmMarket'> {
  const market = poolAddress ? MM_MARKET_BY_POOL.get(poolAddress.toLowerCase()) : undefined
  return market ? { mmMarketKey: market.key, mmMarket: market.label } : {}
}

export function activityRowMatchesFilters(row: ActivityRow, filters: ValueListFilters): boolean {
  const tokenIds = assetIdsForToken(filters.token)
  if (tokenIds != null) {
    const rowIds = [row.asset?.assetId, row.assetIn?.assetId, row.assetOut?.assetId].filter((id): id is number => id != null)
    if (!rowIds.some(id => tokenIds.includes(id))) return false
  }
  if (filters.min != null) {
    if (filters.unit === 'token') {
      const picks = [
        row.amount != null && row.asset ? { amt: row.amount, a: row.asset } : null,
        row.amountOut != null && row.assetOut ? { amt: row.amountOut, a: row.assetOut } : null,
        row.amountIn != null && row.assetIn ? { amt: row.amountIn, a: row.assetIn } : null,
      ].filter((pick): pick is { amt: string; a: AssetRef } => pick != null && /^\d+$/.test(pick.amt))
      const relevant = tokenIds == null ? picks.slice(0, 1) : picks.filter(pick => tokenIds.includes(pick.a.assetId))
      return relevant.some(pick => {
        const threshold = minimumRawAmountForValue(filters.min!, 1, pick.a.decimals)
        return threshold != null && BigInt(pick.amt) >= threshold
      })
    }
    if (!rowMeetsExactUsdMinimum(row, filters.min)) return false
  }
  return true
}

export interface LiquidityAmountCandidate {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  event_name: string
  who: string
  asset_id: number
  amount: string
}

export interface LiquidityTransferLeg {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  asset_id: number
  from_account: string
  to_account: string
  amount: string
}

// Omnipool/Stableswap liquidity events carry only shares (sharesRemoved / shares),
// never the underlying token amount — that lives on the paired pool↔who transfer
// leg. Recover it by matching each amount-less row to a leg with the same asset +
// account and the nearest preceding event index, consuming each leg once.
//
// Legs are matched within the same DISPATCH SCOPE: signed user actions scope to
// their extrinsic, while scheduler/hook-dispatched events (an Omnipool asset being
// offboarded force-removes every position from a runtime hook) carry no extrinsic
// and scope to the block's out-of-extrinsic legs. Isolating the scopes stops a
// signed same-block transfer from being mistaken for an offboarding leg.
export function matchLiquidityAmounts(missing: LiquidityAmountCandidate[], legs: LiquidityTransferLeg[]): void {
  const scopeOf = (ext: number | null | undefined): string => ext == null ? 'blk' : String(ext)
  const byTo = new Map<string, { event_index: number; amount: string; used: boolean }[]>()
  // Pool creation legs run who→pool (the opposite direction of a removal's
  // pool→who), so they're additionally indexed by the SENDER.
  const byFrom = new Map<string, { event_index: number; amount: string; used: boolean }[]>()
  const push = (map: Map<string, { event_index: number; amount: string; used: boolean }[]>, key: string, entry: { event_index: number; amount: string; used: boolean }): void => {
    const list = map.get(key) ?? []
    list.push(entry)
    map.set(key, list)
  }
  for (const t of legs) {
    if (!t.amount) continue
    const entry = { event_index: t.event_index, amount: t.amount, used: false }
    const scope = scopeOf(t.extrinsic_index)
    push(byTo, `${t.block_height}:${scope}:${t.asset_id}:${t.to_account.toLowerCase()}`, entry)
    push(byFrom, `${t.block_height}:${scope}:${t.asset_id}:${t.from_account.toLowerCase()}`, entry)
  }
  for (const list of byTo.values()) list.sort((a, b) => a.event_index - b.event_index)
  for (const list of byFrom.values()) list.sort((a, b) => a.event_index - b.event_index)
  for (const row of missing) {
    if (row.amount || !row.who || row.asset_id == null) continue
    const scope = scopeOf(row.extrinsic_index)
    const lookup = row.event_name === 'XYK.PoolCreated' ? byFrom : byTo
    const transfers = lookup.get(`${row.block_height}:${scope}:${row.asset_id}:${row.who.toLowerCase()}`)
    if (!transfers?.length) continue
    const before = transfers
      .filter(t => !t.used && t.event_index < row.event_index)
      .at(-1)
    const match = before ?? transfers.find(t => !t.used)
    if (!match) continue
    match.used = true
    row.amount = match.amount
  }
}

async function fillMissingLiquidityAmounts(rows: LiquidityAmountCandidate[]): Promise<void> {
  const missing = rows.filter(r => !r.amount && r.who && r.asset_id != null)
  if (!missing.length) return
  // Signed actions carry an extrinsic index; offboarding-style force-removals are
  // dispatched from a runtime hook and carry none. Fetch the transfer legs for
  // each: the touched extrinsics, plus the whole block's out-of-extrinsic legs.
  const extKeys = [...new Set(missing.filter(r => r.extrinsic_index != null).map(r => `${r.block_height}:${r.extrinsic_index}`))]
  const nullExtBlocks = [...new Set(missing.filter(r => r.extrinsic_index == null).map(r => r.block_height))]
  const columns = `block_height, event_index, extrinsic_index, asset_id, from_account, to_account, amount`
  const legs: LiquidityTransferLeg[] = []
  // Chunked: a deep-walk page can carry tens of thousands of fill candidates,
  // and one unchunked IN-list lookup would blow the client's result-row cap.
  for (let i = 0; i < extKeys.length; i += 5000) {
    const tuples = extKeys.slice(i, i + 5000).map(k => { const [h, j] = k.split(':'); return `(${h},${j})` }).join(',')
    const res = await client.query({
      query: `SELECT ${columns} FROM price_data.transfer_activity_by_time WHERE (block_height, extrinsic_index) IN (${tuples})`,
      format: 'JSONEachRow',
    })
    legs.push(...await res.json<LiquidityTransferLeg>())
  }
  for (let i = 0; i < nullExtBlocks.length; i += 5000) {
    const blocks = nullExtBlocks.slice(i, i + 5000).join(',')
    const res = await client.query({
      query: `SELECT ${columns} FROM price_data.transfer_activity_by_time WHERE block_height IN (${blocks}) AND extrinsic_index IS NULL`,
      format: 'JSONEachRow',
    })
    legs.push(...await res.json<LiquidityTransferLeg>())
  }
  matchLiquidityAmounts(missing, legs)
}

// Liquidity provision/removal/creation events for Activity. The
// action filter pushes down to event names — pool creations are rare, so a
// post-filter over a recency window would mostly return empty pages.
async function getRecentLiquidity(limit: number, from?: string, to?: string, offset = 0, filters: ValueListFilters = {}, action?: string): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const liqEvents = action === 'Create' ? LIQUIDITY_EVENTS.filter(n => n.endsWith('PoolCreated'))
    : action === 'Claim' ? LIQUIDITY_EVENTS.filter(n => n.endsWith('RewardClaimed'))
    : action === 'Add' ? LIQUIDITY_EVENTS.filter(n => n.endsWith('Added'))
    : action === 'Remove' ? LIQUIDITY_EVENTS.filter(n => n.endsWith('Removed'))
    : LIQUIDITY_EVENTS
  return cached(`explorer:liquidity:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}:${action ?? ''}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const assetExpr = 'asset_id'
    const amountExpr = 'amount'
    // Match against every asset the event references (Omnipool assetId, XYK
    // assetA/assetB, Stableswap nested assets[]), not just the representative
    // assetExpr used for the displayed asset_id — else a HOLLAR filter drops most
    // of its Stableswap/XYK liquidity rows.
    const tokenFilter = tokenIds == null ? '' : tokenIds.length ? `AND hasAny(asset_refs, [${tokenIds.join(',')}])` : 'AND 0'
    const tokenRefsFilter = ''
    // Token-unit thresholds are integer predicates and remain safe to push down.
    // USD thresholds are deliberately candidate-first: an ASOF price join ahead
    // of LIMIT scanned the entire compact liquidity history on every cold page.
    // Bounded candidates are valued at their exact event timestamps below and
    // the deep walker widens until it has a complete qualifying page.
    let amountFilter: EventValueFilterSql = { joinSql: '', predicateSql: '' }
    if (filters.min != null && filters.unit === 'token') {
      // XYK adds carry only amountA/amountB — the display amount is filled from
      // the matching transfer leg (≈ amountA), so amountA stands in here.
      const preAmountExpr = `multiIf(${amountExpr} != '', ${amountExpr}, amount_a)`
      const directFilter = eventValueFilterSql(assetExpr, preAmountExpr, 'block_timestamp', filters, prices, 'liquidity_price')
      const valueOk = directFilter.predicateSql.replace(/^AND\s+/, '')
      amountFilter = {
        joinSql: directFilter.joinSql,
        predicateSql: `AND (${valueOk} OR ${preAmountExpr} = '' OR event_name = 'XYK.PoolCreated')`,
      }
    }
    const postFilter = filters.min != null
    const want = offset + limit
    const fetchPage = async (bound: string, pageLimit: number, pageOffset: number): Promise<ActivityRow[]> => {
      const res = await client.query({
        query: `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who AS who,
            ${assetExpr} AS asset_id,
            ${amountExpr} AS amount,
            asset_b AS asset_b,
            pool_account AS pool_acc
          FROM price_data.liquidity_activity
          ${amountFilter.joinSql}
          WHERE ${bound}
            AND event_name IN (${sqlEventNameList(liqEvents)})
            ${tokenRefsFilter}
            AND who NOT LIKE '0x6d6f646c%'
            ${tokenFilter}
            ${amountFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      const raw = await res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; who: string; asset_id: number; amount: string; asset_b: number; pool_acc: string }>()
      await fillMissingLiquidityAmounts(raw)
      const seen = new Set<string>()
      const out: ActivityRow[] = []
      const createCands: { row: ActivityRow; pool: string; assetB: number }[] = []
      for (const r of raw) {
        const key = `${r.block_height}:${r.event_index}`
        if (seen.has(key)) continue
        seen.add(key)
        const a = asset(r.asset_id)
        const row: ActivityRow = {
          type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
          liqAction: liqActionFor(r.event_name),
        }
        if (r.event_name === 'XYK.PoolCreated') createCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
        out.push(row)
      }
      await enrichPoolCreations(createCands)
      await applyHistoricalUsd(out, activityHistPick)
      return out
    }
    if (postFilter) {
      // Token stays SQL-side only (it matches nested pool assets the built row
      // may not carry) — the post-match re-checks just the value threshold.
      const minOnly: ValueListFilters = { min: filters.min, unit: filters.unit }
      const rows = await fetchFilteredDeep(tw, want, (bound, pageLimit) => fetchPage(bound, pageLimit, 0),
        r => activityRowMatchesFilters(r, minOnly), r => r.blockHeight, r => r.eventIndex ?? -1, r => `${r.blockHeight}:${r.eventIndex}`)
      return rows.slice(offset, offset + limit)
    }
    return withFeedWindow(tw, limit, offset + limit, (bound) => fetchPage(bound, limit, offset))
  })
}
interface XcmNetworkMeta { name: string; subscan?: string; ss58?: number }
const RELAY_XCM_NETWORK: XcmNetworkMeta = { name: 'Polkadot', subscan: 'https://polkadot.subscan.io', ss58: 0 }
// Destination parachain metadata for networks observed in Hydration XCM traffic.
const PARACHAIN_META: Record<number, XcmNetworkMeta> = {
  1000: { name: 'AssetHub', subscan: 'https://assethub-polkadot.subscan.io', ss58: 0 },
  2000: { name: 'Acala', subscan: 'https://acala.subscan.io', ss58: 10 },
  2004: { name: 'Moonbeam', subscan: 'https://moonbeam.subscan.io' },
  2006: { name: 'Astar', subscan: 'https://astar.subscan.io', ss58: 5 },
  2008: { name: 'Crust' },
  2012: { name: 'Parallel', subscan: 'https://parallel.subscan.io' },
  2026: { name: 'Nodle', subscan: 'https://nodle.subscan.io', ss58: 37 },
  2030: { name: 'Bifrost', subscan: 'https://bifrost.subscan.io', ss58: 6 },
  2031: { name: 'Centrifuge', subscan: 'https://centrifuge.subscan.io', ss58: 36 },
  2032: { name: 'Interlay', subscan: 'https://interlay.subscan.io', ss58: 2032 },
  2034: { name: 'Hydration', subscan: 'https://hydration.subscan.io', ss58: 63 },
  2035: { name: 'Phala', subscan: 'https://phala.subscan.io', ss58: 30 },
  2037: { name: 'Unique', subscan: 'https://unique.subscan.io' },
  2043: { name: 'NeuroWeb', subscan: 'https://origintrail.subscan.io' },
  2046: { name: 'Darwinia', subscan: 'https://darwinia.subscan.io' },
  2051: { name: 'Ajuna', subscan: 'https://ajuna.subscan.io' },
  2086: { name: 'KILT', subscan: 'https://kilt.subscan.io', ss58: 38 },
  2092: { name: 'Zeitgeist', subscan: 'https://zeitgeist.subscan.io', ss58: 73 },
  2094: { name: 'Pendulum', subscan: 'https://pendulum.subscan.io', ss58: 56 },
  2101: { name: 'Subsocial' },
  3345: { name: 'Energy Web X', subscan: 'https://energywebx.subscan.io' },
  3369: { name: 'Mythos', subscan: 'https://mythos.subscan.io' },
  3370: { name: 'Laos' },
}
function junctionValue<T = unknown>(j: unknown, key: string): T | undefined {
  const o = j as Record<string, unknown> | undefined
  const v = o?.[key] ?? (o?.value as Record<string, unknown> | undefined)?.[key]
  return v as T | undefined
}
function hexString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const h = v.toLowerCase()
  return /^0x[0-9a-f]+$/.test(h) ? h : null
}
// Bare H160 (an AccountKey20 junction's raw key) → the canonical AccountId32
// join key tags/identity/bindings are keyed by: reserved module/sibling/para
// truncations resolve to their real substrate account; genuine EVM accounts
// get the same ETH-prefixed truncated form Hydration's own EVM accounts use
// (see evmAccountForm/evmFromAccountId), so resolveDisplayAccountId can find a
// bound substrate owner for it exactly as it would for a local account.
function h160AccountId(h160: string): string {
  return reservedH160AccountId(h160.slice(2)) ?? `0x45544800${h160.slice(2)}0000000000000000`
}
// Display ref for an account on ANOTHER chain. Displayed address is ALWAYS the
// Polkadot form (prefix 0) for AccountId32 — one identity per pubkey across
// chains, matching how local accounts are shown — and the bare H160 for
// AccountKey20. The subscan deep-link still uses the chain's own SS58
// encoding. The icon and any Hydration tag/identity are resolved exactly like
// a local account's (same pubkey → same emoji/tag/identity), via the same
// resolveDisplayAccountId → tagForAccount/identityForAccount pipeline accountRef uses.
function externalAccountRef(raw: unknown, meta: XcmNetworkMeta | undefined): ActivityRow['destAccount'] {
  const h = hexString(raw)
  if (!h) return undefined
  if (h.length === 66) {
    let address = h
    let chainAddress = h
    try {
      address = encodeAddress(hexToU8a(h), 0)
      chainAddress = encodeAddress(hexToU8a(h), meta?.ss58 ?? 0)
    } catch { /* keep raw account id */ }
    const resolved = resolveDisplayAccountId(h)
    const icon = accountIcon(resolved)
    const t = tagForAccount(resolved)
    const id = identityForAccount(resolved)
    return {
      kind: 'AccountId32', raw: h, address, subscanUrl: meta?.subscan ? `${meta.subscan}/account/${encodeURIComponent(chainAddress)}` : null,
      emoji: icon.emoji, emojiName: icon.emojiName, emojiUrl: icon.emojiUrl,
      tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon } : null,
      identity: id ? { display: id.display, verified: id.verified } : null,
    }
  }
  if (h.length === 42) {
    const resolved = resolveDisplayAccountId(h160AccountId(h))
    const icon = accountIcon(resolved)
    const t = tagForAccount(resolved)
    const id = identityForAccount(resolved)
    return {
      kind: 'AccountKey20', raw: h, address: h, subscanUrl: meta?.subscan ? `${meta.subscan}/account/${encodeURIComponent(h)}` : null,
      emoji: icon.emoji, emojiName: icon.emojiName, emojiUrl: icon.emojiUrl,
      tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon } : null,
      identity: id ? { display: id.display, verified: id.verified } : null,
    }
  }
  return undefined
}
function xcmDestination(args: { dest?: { parents?: number; interior?: { value?: unknown } } }): Pick<ActivityRow, 'destChain' | 'destParachainId' | 'destAccount'> {
  const di = args.dest?.interior?.value
  const junctions = Array.isArray(di) ? di as Record<string, unknown>[] : []
  const pc = junctions.find(x => x.__kind === 'Parachain')
  const paraId = junctionValue<number>(pc, 'value') ?? null
  const meta = paraId != null ? (PARACHAIN_META[paraId] ?? { name: `Parachain ${paraId}` }) : args.dest?.parents === 1 ? RELAY_XCM_NETWORK : undefined
  const account32 = junctions.find(x => x.__kind === 'AccountId32')
  const account20 = junctions.find(x => x.__kind === 'AccountKey20')
  const destAccount = externalAccountRef(junctionValue(account32, 'id') ?? junctionValue(account20, 'key'), meta)
  return { destChain: meta?.name, destParachainId: paraId, destAccount }
}
// A multilocation interior's junction list — X1 is a single object in XCM v3,
// an array in v4; Here has no value.
function xcmJunctions(interior: unknown): Record<string, unknown>[] {
  const v = (interior as { value?: unknown } | undefined)?.value
  return Array.isArray(v) ? v as Record<string, unknown>[] : v && typeof v === 'object' ? [v as Record<string, unknown>] : []
}

// One outbound XCM transfer event, shape-normalized. XTokens.TransferredAssets
// (legacy) carries sender/assets/dest directly; PolkadotXcm.Sent (pallet_xcm,
// the dominant path) nests the sender in the origin junction and the amounts
// inside the message instructions.
// Amounts are RAW candidates — the caller maps each to a substrate asset by
// matching the same-extrinsic Currencies.Withdrawn, which also discards fee
// legs and chain-internal noise. Null = not a user-sent transfer.
export function parseOutboundXcm(argsRaw: unknown): { sender: string; amounts: string[]; dest: Pick<ActivityRow, 'destChain' | 'destParachainId' | 'destAccount'> } | null {
  const args = argsRaw as {
    sender?: string
    assets?: { fun?: { value?: string } }[]
    dest?: { parents?: number; interior?: { value?: unknown } }
    origin?: { interior?: unknown }
    destination?: { parents?: number; interior?: { value?: unknown } }
    message?: { __kind?: string; value?: unknown; assets?: unknown }[]
  } | null
  if (!args || typeof args !== 'object') return null

  if (typeof args.sender === 'string') {
    const amounts: string[] = []
    for (const leg of Array.isArray(args.assets) ? args.assets : []) {
      const amount = leg?.fun?.value
      if (amount && !amounts.includes(amount)) amounts.push(amount)
    }
    return { sender: args.sender, amounts, dest: xcmDestination(args) }
  }

  if (args.origin && Array.isArray(args.message)) {
    const oj = xcmJunctions(args.origin.interior)
    const acc32 = oj.find(j => j.__kind === 'AccountId32')
    const acc20 = oj.find(j => j.__kind === 'AccountKey20')
    // EVM-origin senders (AccountKey20) map to their truncated-account form —
    // the id their activity is indexed under everywhere else.
    const senderId = typeof acc32?.id === 'string' ? acc32.id
      : typeof acc20?.key === 'string' && /^0x[0-9a-fA-F]{40}$/.test(acc20.key)
        ? '0x45544800' + acc20.key.slice(2).toLowerCase() + '0000000000000000'
        : null
    if (!senderId) return null
    const amounts: string[] = []
    const feeAmounts = new Set<string>()
    for (const ins of args.message) {
      // BuyExecution names the asset consumed as the XCM execution fee (it is
      // withdrawn by WithdrawAsset too, so it would otherwise become a candidate).
      if (ins.__kind === 'BuyExecution') {
        const fee = (ins as { fees?: { fun?: { value?: string } } }).fees?.fun?.value
        if (typeof fee === 'string') feeAmounts.add(fee)
        continue
      }
      // Asset-carrying instructions only.
      const legs = ins.__kind === 'WithdrawAsset' || ins.__kind === 'ReserveAssetDeposited' ? ins.value
        : ins.__kind === 'TransferReserveAsset' ? ins.assets
        : null
      for (const leg of Array.isArray(legs) ? legs as { fun?: { value?: string } }[] : []) {
        const amount = leg?.fun?.value
        if (amount && !amounts.includes(amount)) amounts.push(amount)
      }
    }
    // Drop a fee-only leg: when the message withdraws more than one asset and one
    // of them is exactly the BuyExecution fee, that asset is plumbing (e.g. DOT
    // withdrawn only to pay for bridging USDC), not a transfer — so it must not
    // appear as its own cross-chain activity. A single-asset message keeps its
    // asset (it both transfers and pays its own fee).
    const transferAmounts = amounts.length > 1 ? amounts.filter(a => !feeAmounts.has(a)) : amounts
    const dest = xcmDestination({ dest: args.destination })
    // Sent's destination names only the chain; the beneficiary account lives in
    // the message's DepositAsset instruction.
    if (!dest.destAccount) {
      const dep = args.message.find(i => i.__kind === 'DepositAsset') as { beneficiary?: { interior?: unknown } } | undefined
      const bj = xcmJunctions(dep?.beneficiary?.interior)
      const b32 = bj.find(j => j.__kind === 'AccountId32')
      const b20 = bj.find(j => j.__kind === 'AccountKey20')
      const meta = dest.destParachainId != null ? PARACHAIN_META[dest.destParachainId] : dest.destChain === RELAY_XCM_NETWORK.name ? RELAY_XCM_NETWORK : undefined
      const id = typeof b32?.id === 'string' ? b32.id : typeof b20?.key === 'string' ? b20.key : undefined
      dest.destAccount = externalAccountRef(id, meta)
    }
    return { sender: senderId, amounts: transferAmounts.length ? transferAmounts : amounts, dest }
  }

  return null
}

function outboundXcmRow(
  event: { block_height: number; ts: string; event_index: number; extrinsic_index: number | null },
  sender: string,
  assetId: number,
  amount: string,
  destination: Pick<ActivityRow, 'destChain' | 'destParachainId' | 'destAccount'>,
  prices: Map<number, PriceInfo>,
): ActivityRow {
  const transferAsset = asset(assetId)
  return {
    type: 'xcm',
    blockHeight: event.block_height,
    timestamp: event.ts,
    eventIndex: event.event_index,
    extrinsicIndex: event.extrinsic_index,
    who: accountRef(sender),
    to: null,
    asset: transferAsset,
    assetIn: null,
    assetOut: null,
    amount,
    amountIn: null,
    amountOut: null,
    valueUsd: usdValue(prices, transferAsset.assetId, amount, transferAsset.decimals),
    xcmDir: 'out',
    ...destination,
    linkBlock: event.block_height,
    linkIndex: event.extrinsic_index,
  }
}

// Outbound cross-chain (XCM) transfers as activity rows. `XTokens.TransferredAssets`
// carries sender + dest parachain + per-asset amounts; the substrate asset_id is
// recovered by matching each leg amount to the same-extrinsic Currencies.Withdrawn
// (the multilocation's GeneralIndex is the destination chain's index, not ours).
// Inbound XCM is covered separately by getRecentXcmIn. When `accounts` is given
// the feed is scoped to that sender (account/tag page).
async function getRecentXcm(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:xcm-activity:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const senderFilter = acctList ? `AND sender IN (${acctList})` : ''
    const want = offset + limit
    let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
    const fetchPage = async (pageBound: string, pageLimit: number): Promise<ActivityRow[]> => {
      const senderRefsFilter = acctList
        ? `AND ${accountActivityRefsSql(acctList, `event_name IN ('XTokens.TransferredAssets','PolkadotXcm.Sent')`, pageBound, pageLimit)}`
        : ''
      const res = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, extrinsic_index, event_index, name, args_json
                FROM price_data.raw_xcm_activity
                WHERE ${pageBound} ${senderRefsFilter} AND source_kind='event'
                  AND name IN ('XTokens.TransferredAssets','PolkadotXcm.Sent')
                  AND event_index IS NOT NULL ${senderFilter}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
        query_params: { limit: pageLimit }, format: 'JSONEachRow',
      })
      const evs = await res.json<{ block_height: number; ts: string; extrinsic_index: number | null; event_index: number; name: string; args_json: string }>()
      const last = evs.at(-1)
      pageState = { scanned: evs.length, cursor: last ? { blockHeight: last.block_height, eventIndex: last.event_index } : null }
      if (!evs.length) return []
      const blocks = [...new Set(evs.map(event => event.block_height))].join(',')
      const [wRes, legacyRes] = await Promise.all([
        client.query({
          query: `SELECT block_height, extrinsic_index,
                    asset_id AS cid,
                    amount AS amount
                  FROM ${xcmEventActivityTable()}
                  WHERE event_name='Currencies.Withdrawn' AND block_height IN (${blocks})
                    ${assetIdFilterSql('asset_id', tokenIds)}`,
          format: 'JSONEachRow',
        }),
        client.query({
          query: `SELECT DISTINCT block_height, extrinsic_index
                  FROM price_data.raw_xcm_activity
                  WHERE block_height IN (${blocks}) AND source_kind='event'
                    AND name='XTokens.TransferredAssets'`,
          format: 'JSONEachRow',
        }),
      ])
      const wmap = new Map<string, number>()
      for (const withdrawal of await wRes.json<{ block_height: number; extrinsic_index: number | null; cid: number; amount: string }>()) {
        wmap.set(`${withdrawal.block_height}:${withdrawal.extrinsic_index}:${withdrawal.amount}`, withdrawal.cid)
      }
      // The rare extrinsic emitting both events yields one row set: the legacy
      // event wins and the pallet_xcm mirror is suppressed.
      const xtokensExts = new Set((await legacyRes.json<{ block_height: number; extrinsic_index: number | null }>())
        .map(event => `${event.block_height}:${event.extrinsic_index}`))
      const out: ActivityRow[] = []
      for (const event of evs) {
        if (event.name === 'PolkadotXcm.Sent' && xtokensExts.has(`${event.block_height}:${event.extrinsic_index}`)) continue
        const parsed = parseOutboundXcm(safeJson(event.args_json))
        if (!parsed) continue
        for (const amount of parsed.amounts) {
          const assetId = wmap.get(`${event.block_height}:${event.extrinsic_index}:${amount}`)
          if (assetId == null) continue
          out.push(outboundXcmRow(event, parsed.sender, assetId, amount, parsed.dest, prices))
        }
      }
      await applyHistoricalUsd(out, activityHistPick)
      return out
    }
    const rows = await fetchFilteredDeep(
      tw,
      want,
      fetchPage,
      row => activityRowMatchesFilters(row, filters),
      row => row.blockHeight,
      row => row.eventIndex ?? -1,
      row => `${row.blockHeight}:${row.eventIndex}:${row.asset?.assetId ?? -1}:${row.amount ?? ''}`,
      { pageState: () => pageState },
    )
    return rows.slice(offset, offset + limit)
  })
}

// Origin network of an inbound XCM message (MessageQueue.Processed `origin`).
function xcmOrigin(args: { origin?: { __kind?: string; value?: number } }): Pick<ActivityRow, 'fromChain' | 'fromParachainId'> {
  const o = args.origin
  if (o?.__kind === 'Parent') return { fromChain: RELAY_XCM_NETWORK.name, fromParachainId: null }
  if (o?.__kind === 'Sibling' && typeof o.value === 'number') {
    return { fromChain: (PARACHAIN_META[o.value] ?? { name: `Parachain ${o.value}` }).name, fromParachainId: o.value }
  }
  return {}
}

// Inbound XCM detection. An incoming message executes outside any extrinsic and
// ends with a MessageQueue.Processed event naming the origin chain. The
// beneficiary credit is the run of deposit events directly before that barrier:
// walk back while events stay in the deposit family, keep non-module/
// non-sovereign recipients, and fold the Currencies/Tokens/Balances mirror
// duplicates into one row per (who, currency, amount). A remote-execution
// message (Transact/swap) cuts the walk at its first non-deposit event, so only
// what the message actually credited to a user account surfaces.
const XCM_IN_DEPOSIT_EVENTS = ['Currencies.Deposited', 'Tokens.Deposited', 'Balances.Deposit']
const XCM_IN_WALK_EVENTS = [...XCM_IN_DEPOSIT_EVENTS, 'Balances.Issued', 'Balances.Endowed', 'Tokens.Endowed', 'Balances.Minted', 'System.NewAccount']
const RESERVED_ACCOUNT_RE = /^0x(6d6f646c|7369626c|70617261)/ // modl / sibl / para prefixes
const sqlEventNameList = (names: string[]): string => names.map(n => `'${n}'`).join(',')

// Decode the inbound-XCM beneficiary credits of the given blocks (see above).
// `whoIn` restricts rows to those raw beneficiary account ids (account/tag page).
async function xcmInRowsForBlocks(blocks: number[], prices: Map<number, PriceInfo>, whoIn?: Set<string>): Promise<ActivityRow[]> {
  const list = sqlUIntList(blocks)
  if (!list) return []
  const [barRes, famRes] = await Promise.all([
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, args_json
              FROM ${xcmEventActivityTable()}
              WHERE block_height IN (${list}) AND event_name = 'MessageQueue.Processed' AND extrinsic_index IS NULL
              ORDER BY block_height DESC, event_index DESC`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT block_height, event_index, event_name, args_json
              FROM ${xcmEventActivityTable()}
              WHERE block_height IN (${list}) AND event_name IN (${sqlEventNameList(XCM_IN_WALK_EVENTS)}) AND extrinsic_index IS NULL`,
      format: 'JSONEachRow',
    }),
  ])
  const barriers = await barRes.json<{ block_height: number; ts: string; event_index: number; args_json: string }>()
  const byBlock = new Map<number, Map<number, { event_name: string; args_json: string }>>()
  for (const e of await famRes.json<{ block_height: number; event_index: number; event_name: string; args_json: string }>()) {
    const m = byBlock.get(e.block_height) ?? new Map<number, { event_name: string; args_json: string }>()
    m.set(e.event_index, e)
    byBlock.set(e.block_height, m)
  }
  const rows: ActivityRow[] = []
  for (const b of barriers) {
    const bargs = safeJson(b.args_json) as { success?: boolean; id?: string; origin?: { __kind?: string; value?: number } } | null
    if (!bargs || bargs.success === false) continue
    const from = xcmOrigin(bargs)
    const messageId = typeof bargs.id === 'string' && bargs.id.startsWith('0x') ? bargs.id : null
    const evs = byBlock.get(b.block_height)
    const seen = new Set<string>()
    for (let idx = b.event_index - 1; evs?.has(idx); idx--) {
      const e = evs.get(idx)!
      if (!XCM_IN_DEPOSIT_EVENTS.includes(e.event_name)) continue
      const args = (safeJson(e.args_json) ?? {}) as { currencyId?: number; who?: string; amount?: string }
      const cid = e.event_name === 'Balances.Deposit' ? 0 : Number(args.currencyId ?? 0)
      const { who, amount } = args
      if (!who || !amount || amount === '0' || RESERVED_ACCOUNT_RE.test(who)) continue
      if (whoIn && !whoIn.has(who)) continue
      const key = `${who}:${cid}:${amount}`
      if (seen.has(key)) continue
      seen.add(key)
      const a = asset(cid)
      rows.push({
        type: 'xcm', blockHeight: b.block_height, timestamp: b.ts, eventIndex: idx, extrinsicIndex: null,
        who: accountRef(who), to: null, asset: a, assetIn: null, assetOut: null,
        amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
        xcmDir: 'in', ...from, messageId,
      })
    }
  }
  return rows.sort((x, y) => y.blockHeight - x.blockHeight || (y.eventIndex ?? 0) - (x.eventIndex ?? 0))
}

// Remote-initiated OUTBOUND transfers: an inbound message (no local extrinsic,
// no PolkadotXcm.Sent) that withdraws from a local account and parks the funds
// in the initiating chain's sovereign — e.g. HOLLAR pulled to AssetHub from
// the AssetHub side. Detected as hook-context Currencies.Withdrawn rows
// attributed to the next successful MessageQueue.Processed in the block; the
// message origin is where the funds went. Fee withdrawals of the same message
// surface as their own (small) rows — factual parts of the remote operation.
async function xcmOutRemoteRowsForBlocks(blocks: number[], prices: Map<number, PriceInfo>, whoIn?: Set<string>): Promise<ActivityRow[]> {
  const list = sqlUIntList(blocks)
  if (!list) return []
  const [barRes, wdRes] = await Promise.all([
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, args_json
              FROM ${xcmEventActivityTable()}
              WHERE block_height IN (${list}) AND event_name = 'MessageQueue.Processed' AND extrinsic_index IS NULL
              ORDER BY block_height DESC, event_index ASC`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT block_height, event_index, args_json
              FROM ${xcmEventActivityTable()}
              WHERE block_height IN (${list}) AND event_name = 'Currencies.Withdrawn' AND extrinsic_index IS NULL`,
      format: 'JSONEachRow',
    }),
  ])
  const barriersByBlock = new Map<number, { ts: string; event_index: number; args_json: string }[]>()
  for (const b of await barRes.json<{ block_height: number; ts: string; event_index: number; args_json: string }>()) {
    const l = barriersByBlock.get(b.block_height) ?? []
    l.push(b)
    barriersByBlock.set(b.block_height, l)
  }
  const rows: ActivityRow[] = []
  const seen = new Set<string>()
  for (const w of await wdRes.json<{ block_height: number; event_index: number; args_json: string }>()) {
    const args = (safeJson(w.args_json) ?? {}) as { currencyId?: number; who?: string; amount?: string }
    const { who, amount } = args
    if (!who || !amount || amount === '0' || RESERVED_ACCOUNT_RE.test(who)) continue
    if (whoIn && !whoIn.has(who)) continue
    const barrier = (barriersByBlock.get(w.block_height) ?? []).find(b => b.event_index > w.event_index)
    if (!barrier) continue
    const bargs = safeJson(barrier.args_json) as { success?: boolean; id?: string; origin?: { __kind?: string; value?: number } } | null
    if (!bargs || bargs.success === false) continue
    const cid = Number(args.currencyId ?? 0)
    const key = `${w.block_height}:${barrier.event_index}:${who}:${cid}:${amount}`
    if (seen.has(key)) continue
    seen.add(key)
    const origin = xcmOrigin(bargs)
    const a = asset(cid)
    rows.push({
      type: 'xcm', blockHeight: w.block_height, timestamp: barrier.ts, eventIndex: w.event_index, extrinsicIndex: null,
      who: accountRef(who), to: null, asset: a, assetIn: null, assetOut: null,
      amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
      xcmDir: 'out', destChain: origin.fromChain, destParachainId: origin.fromParachainId ?? null,
      messageId: typeof bargs.id === 'string' && bargs.id.startsWith('0x') ? bargs.id : null,
    })
  }
  return rows.sort((x, y) => y.blockHeight - x.blockHeight || (y.eventIndex ?? 0) - (x.eventIndex ?? 0))
}

async function fetchDecodedXcmDeep(
  base: string,
  want: number,
  fetchBlocks: (bound: string, limit: number) => Promise<{ block_height: number }[]>,
  decode: (blocks: number[]) => Promise<ActivityRow[]>,
  matches: (row: ActivityRow) => boolean,
): Promise<ActivityRow[]> {
  const out: ActivityRow[] = []
  let cursor: number | null = null
  const initialPageSize = Math.min(Math.max(want * 2, 500), 5_000)
  for (let page = 0; ; page++) {
    const bound = cursor == null ? base : `(${base}) AND block_height < ${cursor}`
    const pageSize = Math.min(initialPageSize * 2 ** Math.min(page, 16), 5_000)
    const candidates = await fetchBlocks(bound, pageSize)
    const blocks = [...new Set(candidates.map(row => Number(row.block_height)).filter(Number.isSafeInteger))]
    const rows: ActivityRow[] = []
    for (let start = 0; start < blocks.length; start += 1_000) rows.push(...await decode(blocks.slice(start, start + 1_000)))
    await applyHistoricalUsd(rows, activityHistPick)
    out.push(...rows.filter(matches))
    if (out.length >= want || candidates.length < pageSize) break
    const next = blocks.length ? Math.min(...blocks) : null
    if (next == null || (cursor != null && next >= cursor)) break
    cursor = next
  }
  return out.sort((left, right) =>
    right.blockHeight - left.blockHeight || (right.eventIndex ?? 0) - (left.eventIndex ?? 0))
}

async function getRecentXcmOutRemote(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:xcmoutr-activity:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    if (acctList === "''") return []
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const want = offset + limit
    const tokenIds = assetIdsForToken(filters.token)
    const candidateAsset = 'asset_id'
    const candidateAmount = 'amount'
    const candidateWho = 'who'
    const candidateValue = eventValueFilterSql(candidateAsset, candidateAmount, 'block_timestamp', filters, prices, 'xcm_remote_price')
    const candidateToken = assetIdFilterSql(candidateAsset, tokenIds)
    const fetchBlocks = acctList
      ? async (pageBound: string, pageLimit: number) => {
        const refsFilter = `AND ${accountActivityRefsSql(acctList, `event_name = 'Currencies.Withdrawn'`, pageBound, pageLimit)}`
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound} ${refsFilter}
                    AND event_name = 'Currencies.Withdrawn' AND extrinsic_index IS NULL
                    AND ${candidateWho} IN (${acctList})
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
      : async (pageBound: string, pageLimit: number) => {
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound}
                    AND event_name = 'Currencies.Withdrawn' AND extrinsic_index IS NULL
                    AND NOT match(${candidateWho}, '${RESERVED_ACCOUNT_RE.source}')
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
    const whoIn = accounts && accounts.length ? new Set(accounts) : undefined
    const rows = await fetchDecodedXcmDeep(
      bound,
      want,
      fetchBlocks,
      blocks => xcmOutRemoteRowsForBlocks(blocks, prices, whoIn),
      row => activityRowMatchesFilters(row, filters),
    )
    return rows.slice(offset, offset + limit)
  })
}

// Inbound cross-chain (XCM) transfers as activity rows: what processed inbound
// messages credited to user accounts. When `accounts` is given the feed is
// scoped to those beneficiaries (account/tag page).
async function getRecentXcmIn(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:xcmin-activity:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    if (acctList === "''") return []
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const want = offset + limit
    const tokenIds = assetIdsForToken(filters.token)
    const candidateAsset = 'asset_id'
    const candidateAmount = 'amount'
    const candidateWho = 'who'
    const candidateValue = eventValueFilterSql(candidateAsset, candidateAmount, 'block_timestamp', filters, prices, 'xcm_in_price')
    const candidateToken = assetIdFilterSql(candidateAsset, tokenIds)
    // Candidate blocks: account-scoped from the account's own hook-context deposit
    // events (activity-index pruned), global from the newest processed messages.
    const fetchBlocks = acctList
      ? async (pageBound: string, pageLimit: number) => {
        const refsFilter = `AND ${accountActivityRefsSql(acctList, `event_name IN (${sqlEventNameList(XCM_IN_DEPOSIT_EVENTS)})`, pageBound, pageLimit)}`
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound} ${refsFilter}
                    AND event_name IN (${sqlEventNameList(XCM_IN_DEPOSIT_EVENTS)}) AND extrinsic_index IS NULL
                    AND ${candidateWho} IN (${acctList})
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
      : async (pageBound: string, pageLimit: number) => {
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound}
                    AND event_name IN (${sqlEventNameList(XCM_IN_DEPOSIT_EVENTS)}) AND extrinsic_index IS NULL
                    AND NOT match(${candidateWho}, '${RESERVED_ACCOUNT_RE.source}')
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
    const whoIn = accounts && accounts.length ? new Set(accounts) : undefined
    const rows = await fetchDecodedXcmDeep(
      bound,
      want,
      fetchBlocks,
      blocks => xcmInRowsForBlocks(blocks, prices, whoIn),
      row => activityRowMatchesFilters(row, filters),
    )
    return rows.slice(offset, offset + limit)
  })
}

// Parachains whose native accounts are AccountKey20 (EVM) — a 32-byte source
// account reported for them cannot be a real account there, so no pill.
const EVM_PARACHAINS = new Set([2004, 3369]) // Moonbeam, Mythos

// Chain badge + account pill for one END of a journey (either side). A journey
// may pass through intermediate hops (Solana → Wormhole → Moonbeam → Hydration,
// Ethereum → Snowbridge → AssetHub → Hydration): our chain only sees the
// adjacent hop, while the real counterparty account lives on the journey's own
// end chain — so the badge and the account ENCODING follow that chain (SS58
// for substrate, H160 for EVM, base58 for Solana). Returns null for unknown
// consensus systems (row keeps its local hop display).
function externalChainRef(urnStr: string, account: string): { chain: string; paraId: number | null; account?: ActivityRow['destAccount'] } | null {
  const urn = /^urn:ocn:([a-z0-9-]+):(\d+)$/.exec(urnStr)
  if (!urn) return null
  const [, consensus, chainId] = urn
  const h = hexString(account)
  if (consensus === 'polkadot') {
    const paraId = Number(chainId)
    if (paraId === 0) return { chain: RELAY_XCM_NETWORK.name, paraId: null, account: externalAccountRef(account, RELAY_XCM_NETWORK) }
    const meta = PARACHAIN_META[paraId] ?? { name: `Parachain ${paraId}` }
    const acct = externalAccountRef(account, meta)
    return { chain: meta.name, paraId, account: acct && EVM_PARACHAINS.has(paraId) && acct.kind !== 'AccountKey20' ? undefined : acct }
  }
  if (consensus === 'solana') {
    let acct: ActivityRow['destAccount']
    if (h?.length === 66) {
      let address = h
      try { address = base58Encode(hexToU8a(h)) } catch { /* keep hex */ }
      const resolved = resolveDisplayAccountId(h)
      const icon = accountIcon(resolved)
      const t = tagForAccount(resolved)
      const id = identityForAccount(resolved)
      acct = {
        kind: 'AccountId32', raw: h, address, subscanUrl: `https://solscan.io/account/${encodeURIComponent(address)}`,
        emoji: icon.emoji, emojiName: icon.emojiName, emojiUrl: icon.emojiUrl,
        tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon } : null,
        identity: id ? { display: id.display, verified: id.verified } : null,
      }
    }
    return { chain: 'Solana', paraId: null, account: acct }
  }
  if (consensus === 'ethereum') {
    let acct: ActivityRow['destAccount']
    if (h?.length === 42) {
      const resolved = resolveDisplayAccountId(h160AccountId(h))
      const icon = accountIcon(resolved)
      const t = tagForAccount(resolved)
      const id = identityForAccount(resolved)
      acct = {
        kind: 'AccountKey20', raw: h, address: h, subscanUrl: `https://etherscan.io/address/${encodeURIComponent(h)}`,
        emoji: icon.emoji, emojiName: icon.emojiName, emojiUrl: icon.emojiUrl,
        tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon } : null,
        identity: id ? { display: id.display, verified: id.verified } : null,
      }
    }
    return { chain: 'Ethereum', paraId: null, account: acct }
  }
  return null
}

function activityRowTimestampMs(r: ActivityRow): number {
  return Date.parse(r.timestamp.replace(' ', 'T') + (r.timestamp.endsWith('Z') ? '' : 'Z')) || Date.now()
}

// Attach the source of inbound XCM rows (Ocelloids journey lookup by message
// topic id — see xcmJourneyService). Unmatched rows keep their hop-chain badge
// without a source pill.
// Explorer deep link for the journey's origin transaction: Subscan for
// substrate chains, the native explorer for other consensus systems.
export function originTxExplorerUrl(urnStr: string, txHash: string | null): string | null {
  if (!txHash || !/^0x[0-9a-fA-F]+$/.test(txHash)) return null
  const urn = /^urn:ocn:([a-z0-9-]+):(\d+)$/.exec(urnStr)
  if (!urn) return null
  const [, consensus, chainId] = urn
  if (consensus === 'polkadot') {
    const paraId = Number(chainId)
    const meta = paraId === 0 ? RELAY_XCM_NETWORK : PARACHAIN_META[paraId]
    return meta?.subscan ? `${meta.subscan}/extrinsic/${txHash}` : null
  }
  if (consensus === 'ethereum') return `https://etherscan.io/tx/${txHash}`
  if (consensus === 'solana') return `https://solscan.io/tx/${txHash}`
  return null
}

async function applyXcmInSources(rows: ActivityRow[]): Promise<void> {
  const inRows = rows.filter(r => r.type === 'xcm' && r.xcmDir === 'in' && r.messageId && !r.fromAccount)
  if (!inRows.length) return
  const sources = await xcmJourneySourcesFor(inRows.map(r => ({ messageId: r.messageId!, timestampMs: activityRowTimestampMs(r) })))
  for (const r of inRows) {
    const src = sources.get(r.messageId!)
    if (!src) continue
    const origin = externalChainRef(src.origin, src.from)
    if (!origin) continue
    r.fromChain = origin.chain
    r.fromParachainId = origin.paraId
    r.fromAccount = origin.account
    r.fromTxUrl = originTxExplorerUrl(src.origin, src.originTx)
  }
}

// Remote-initiated outbound rows (HOLLAR-class): the transfer was initiated FROM
// the destination chain, so there's no local extrinsic and applyXcmOutDests
// (extrinsic-hash keyed) can't reach them — but they carry the triggering
// inbound message's id, whose journey resolves the counterparty account AND
// origin extrinsic on that chain (same lookup as inbound sources). Without this
// the row shows only a bare destination chain: no account pill, no Subscan link.
async function applyXcmOutRemoteSources(rows: ActivityRow[]): Promise<void> {
  const remoteRows = rows.filter(r => r.type === 'xcm' && r.xcmDir === 'out' && r.extrinsicIndex == null && r.messageId && !r.destAccount)
  if (!remoteRows.length) return
  const sources = await xcmJourneySourcesFor(remoteRows.map(r => ({ messageId: r.messageId!, timestampMs: activityRowTimestampMs(r) })))
  for (const r of remoteRows) {
    const src = sources.get(r.messageId!)
    if (!src) continue
    const other = externalChainRef(src.origin, src.from)
    if (other) {
      r.destChain = other.chain
      r.destParachainId = other.paraId
      if (other.account) r.destAccount = other.account
    }
    r.fromTxUrl = originTxExplorerUrl(src.origin, src.originTx)
  }
}

// Upgrade outbound rows whose transfer continues PAST the first hop: the
// XTokens dest junction only names the hop + forwarding account (a Wormhole
// transfer to Solana looks like a Moonbeam transfer to the bridge contract),
// while the journey knows the real destination. Matched by our own extrinsic
// hash (= the journey's origin tx). Same-hop journeys and ambiguous matches
// (an extrinsic batching several journeys) keep the local junction data,
// which names the beneficiary authoritatively.
async function applyXcmOutDests(rows: ActivityRow[]): Promise<void> {
  const outRows = rows.filter(r => r.type === 'xcm' && r.xcmDir === 'out' && r.extrinsicIndex != null)
  if (!outRows.length) return
  const pairs = [...new Set(outRows.map(r => `${r.blockHeight}:${r.extrinsicIndex}`))]
  const tuples = pairs.map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
  const res = await client.query({
    query: `SELECT block_height, extrinsic_index, extrinsic_hash FROM price_data.raw_extrinsics WHERE (block_height, extrinsic_index) IN (${tuples})`,
    format: 'JSONEachRow',
  })
  const hashByPair = new Map<string, string>()
  for (const e of await res.json<{ block_height: number; extrinsic_index: number; extrinsic_hash: string }>()) {
    if (e.extrinsic_hash) hashByPair.set(`${e.block_height}:${e.extrinsic_index}`, e.extrinsic_hash.toLowerCase())
  }
  const keys = outRows
    .map(r => ({ txHash: hashByPair.get(`${r.blockHeight}:${r.extrinsicIndex}`) ?? '', timestampMs: activityRowTimestampMs(r) }))
    .filter(k => k.txHash)
  if (!keys.length) return
  const journeys = await xcmJourneysByOriginTx(keys)
  for (const r of outRows) {
    const hash = hashByPair.get(`${r.blockHeight}:${r.extrinsicIndex}`)
    const list = hash ? journeys.get(hash) : undefined
    if (!list || list.length !== 1) continue
    const dest = externalChainRef(list[0].destination, list[0].to)
    if (!dest || dest.paraId === 2034 || (dest.paraId != null && dest.paraId === r.destParachainId)) continue
    r.destChain = dest.chain
    r.destParachainId = dest.paraId
    r.destAccount = dest.account
  }
}

// Remote-side enrichment of a final PAGE of activity rows — at most a page worth
// of lookups per request; both passes share the journey cache.
async function applyXcmJourneys(rows: ActivityRow[]): Promise<void> {
  await applyXcmInSources(rows)
  await applyXcmOutRemoteSources(rows)
  await applyXcmOutDests(rows)
}

// Global money-market transactions (supply/borrow/repay/withdraw/liquidation) by
// real users (the routerex pallet's swap-internal MM ops are excluded).
const MONEY_MARKET_EVENT_NAMES = ['Supply', 'Borrow', 'Repay', 'Withdraw', 'LiquidationCall'] as const
function moneyMarketEventNames(action?: string): readonly string[] {
  if (!action) return MONEY_MARKET_EVENT_NAMES
  return MONEY_MARKET_EVENT_NAMES.includes(action as typeof MONEY_MARKET_EVENT_NAMES[number]) ? [action] : []
}

async function getRecentMoneyMarket(limit: number, from?: string, to?: string, offset = 0, filters: ValueListFilters = {}, action?: string): Promise<ActivityRow[]> {
  const eventNames = moneyMarketEventNames(action)
  if (!eventNames.length) return []
  const tw = timeWindow(from, to)
  return cached(`explorer:mm-activity:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}:${action ?? ''}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const reserveFilter = tokenIds == null ? '' : tokenIds.length
      ? `AND asset_address IN (${[...new Set(tokenIds.flatMap(mmReserveAddressForAsset))].map(a => `'${a}'`).join(',')})`
      : 'AND 0'
    // Min pushes down exactly: mmAssetIdSql maps the reserve address to the
    // same asset id the row builder resolves, so SQL value == row valueUsd and
    // no recency-window post-filter is needed — filters see full history via
    // the withFeedWindow fallback.
    const mmAmountExpr = `if(event_name='LiquidationCall', JSONExtractString(decoded_args_json,'liquidatedCollateralAmount'), amount)`
    const amountFilter = eventValueFilterSql(mmAssetIdSql('asset_address'), mmAmountExpr, 'block_timestamp', filters, prices, 'mm_price')
    const mmEv = await withFeedWindow(tw, limit, offset + limit, async (bound) => {
      const res = await client.query({
        query: `SELECT block_height, event_index, toString(block_timestamp) AS ts, event_name, account_id, asset_address, pool_address,
                  ${mmAmountExpr} AS amount
                FROM price_data.raw_money_market_events
                ${amountFilter.joinSql}
                WHERE ${bound} AND event_name IN (${eventNames.map(n => `'${n}'`).join(',')})
                  AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})
                  AND user_address NOT LIKE '0x6d6f646c%'
                  ${reserveFilter}
                  ${amountFilter.predicateSql}
                ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset }, format: 'JSONEachRow',
      })
      return res.json<{ block_height: number; event_index: number; ts: string; event_name: string; account_id: string | null; asset_address: string; pool_address: string | null; amount: string }>()
    })
    // Resolve the substrate extrinsic behind each EVM-side MM event so rows link/hover.
    const mmExt = await extrinsicIndexFor(mmEv.map(r => [r.block_height, r.event_index] as [number, number | null]))
    const out: ActivityRow[] = []
    for (const r of mmEv) {
      const aid = assetIdFromMmAddress(r.asset_address)
      const a = aid != null ? asset(aid) : null
      const xi = mmExt.get(`${r.block_height}:${r.event_index}`) ?? null
      out.push({
        type: 'mm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: xi,
        who: r.account_id ? accountRef(r.account_id) : null, to: null, asset: a, assetIn: null, assetOut: null,
        amount: r.amount, amountIn: null, amountOut: null,
        valueUsd: a ? usdValue(prices, a.assetId, r.amount, a.decimals) : null,
        mmAction: r.event_name, ...moneyMarketActivityFields(r.pool_address), linkBlock: r.block_height, linkIndex: xi,
      })
    }
    await applyHistoricalUsd(out, activityHistPick)
    return out
  })
}

const STAKING_EVENT_NAMES = [
  'CollatorRewards.CollatorRewarded',
  'GigaHdx.Staked',
  'GigaHdx.Unstaked',
  'GigaHdx.UnstakeCancelled',
  'GigaHdx.MigratedFromLegacy',
  'GigaHdxRewards.RewardsClaimed',
  'Staking.PositionCreated',
  'Staking.StakeAdded',
  'Staking.Unstaked',
  'Staking.ForceUnstaked',
  'Staking.RewardsClaimed',
]
interface RawStakingActivityEvent {
  block_height: number
  extrinsic_index: number | null
  event_name: string
  args_json: string
}
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : ''
}
function argInt(args: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const n = Number(args[key])
    if (Number.isInteger(n)) return n
  }
  return 0
}
function stakingActivityKey(row: RawStakingActivityEvent): string | null {
  if (row.extrinsic_index == null) return null
  const args = (safeJson(row.args_json) ?? {}) as Record<string, unknown>
  const who = argStr(args, 'who').toLowerCase()
  return who ? `${row.block_height}:${row.extrinsic_index}:${who}` : null
}
export function suppressGigaCompanionEvents<T extends RawStakingActivityEvent>(rows: T[]): T[] {
  const migrationKeys = new Set<string>()
  const rewardKeys = new Set<string>()
  for (const row of rows) {
    const key = stakingActivityKey(row)
    if (!key) continue
    if (row.event_name === 'GigaHdx.MigratedFromLegacy') migrationKeys.add(key)
    if (row.event_name === 'GigaHdxRewards.RewardsClaimed') rewardKeys.add(key)
  }
  if (!migrationKeys.size && !rewardKeys.size) return rows
  return rows.filter(row => {
    if (row.event_name !== 'GigaHdx.Staked' && row.event_name !== 'Staking.ForceUnstaked') return true
    const key = stakingActivityKey(row)
    if (!key) return true
    if (row.event_name === 'GigaHdx.Staked' && rewardKeys.has(key)) return false
    return !migrationKeys.has(key)
  })
}
function stakingAmountAndAsset(eventName: string, args: Record<string, unknown>, preferredAssetId?: number): { amount: string; assetId: number; action: string } | null {
  const wantStHdx = preferredAssetId === 670
  if (eventName === 'CollatorRewards.CollatorRewarded') {
    const assetId = Number(args.currency ?? 0)
    return preferredAssetId != null && preferredAssetId !== assetId ? null : { assetId, amount: argStr(args, 'amount'), action: 'Collator payout' }
  }
  if (preferredAssetId != null && preferredAssetId !== 0 && preferredAssetId !== 670) return null
  if (eventName === 'GigaHdx.Staked') return { assetId: wantStHdx ? 670 : 0, amount: wantStHdx ? argStr(args, 'gigahdx') : argStr(args, 'amount'), action: 'Giga stake' }
  if (eventName === 'GigaHdx.Unstaked') return { assetId: wantStHdx ? 670 : 0, amount: wantStHdx ? argStr(args, 'gigahdxAmount') : argStr(args, 'payout'), action: 'Giga unstake' }
  if (eventName === 'GigaHdx.UnstakeCancelled') return { assetId: wantStHdx ? 670 : 0, amount: wantStHdx ? argStr(args, 'gigahdx') : argStr(args, 'amount'), action: 'Unstake cancelled' }
  if (eventName === 'GigaHdx.MigratedFromLegacy') return { assetId: wantStHdx ? 670 : 0, amount: wantStHdx ? argStr(args, 'gigahdxReceived') : argStr(args, 'hdxUnlocked'), action: 'Giga migration' }
  if (eventName === 'GigaHdxRewards.RewardsClaimed') return { assetId: wantStHdx ? 670 : 0, amount: wantStHdx ? argStr(args, 'gigahdxReceived') : argStr(args, 'totalHdx'), action: 'Giga reward' }
  if (preferredAssetId != null && preferredAssetId !== 0) return null
  if (eventName === 'Staking.PositionCreated') return { assetId: 0, amount: argStr(args, 'stake') || argStr(args, 'amount'), action: 'Stake' }
  if (eventName === 'Staking.StakeAdded') return { assetId: 0, amount: argStr(args, 'amount') || argStr(args, 'stake'), action: 'Add stake' }
  if (eventName === 'Staking.Unstaked') return { assetId: 0, amount: argStr(args, 'amount') || argStr(args, 'stake'), action: 'Unstake' }
  if (eventName === 'Staking.ForceUnstaked') return { assetId: 0, amount: argStr(args, 'paidRewards') || argStr(args, 'stake'), action: 'Force unstake' }
  if (eventName === 'Staking.RewardsClaimed') return { assetId: 0, amount: argStr(args, 'paidRewards'), action: 'Staking reward' }
  return null
}

// Per-event → ActivityRow construction shared by the extrinsic-scoped
// (getExtrinsicActivity), windowed-feed (getRecentStaking) and block-hook
// (getBlockHookActivity) staking builders, so all three read
// STAKING_EVENT_NAMES/stakingAmountAndAsset identically. `who`/`assetId`/`amount`
// are returned alongside the row so callers can build their own dedup keys.
function stakingRowFromEvent(
  e: { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string },
  prices: Map<number, PriceInfo>,
  opts: { preferredAssetId?: number; signerFallback?: string | null } = {},
): { row: ActivityRow; who: string; assetId: number; amount: string } | null {
  const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
  const who = argStr(args, 'who')
  const parts = stakingAmountAndAsset(e.event_name, args, opts.preferredAssetId)
  if (!parts?.amount || parts.amount === '0') return null
  const a = asset(parts.assetId)
  const row: ActivityRow = {
    type: 'staking', blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
    who: who && ACCOUNT_RE.test(who) ? accountRef(who) : opts.signerFallback ? accountRef(opts.signerFallback) : null,
    to: null, asset: a, assetIn: null, assetOut: null,
    amount: parts.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, parts.amount, a.decimals),
    stakingAction: parts.action, linkBlock: e.block_height, linkIndex: e.extrinsic_index,
  }
  return { row, who, assetId: parts.assetId, amount: parts.amount }
}

// Staking action label (as shown/filtered in the UI) → source event name.
const STAKING_ACTION_EVENTS: Record<string, string[]> = {
  'Stake': ['Staking.PositionCreated'],
  'Add stake': ['Staking.StakeAdded'],
  'Unstake': ['Staking.Unstaked'],
  'Force unstake': ['Staking.ForceUnstaked'],
  'Staking reward': ['Staking.RewardsClaimed'],
  'Giga stake': ['GigaHdx.Staked'],
  'Giga unstake': ['GigaHdx.Unstaked'],
  'Unstake cancelled': ['GigaHdx.UnstakeCancelled'],
  'Giga migration': ['GigaHdx.MigratedFromLegacy'],
  'Giga reward': ['GigaHdxRewards.RewardsClaimed'],
  'Collator payout': ['CollatorRewards.CollatorRewarded'],
}
async function getRecentStaking(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}, assetId?: number, action?: string): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:staking-activity:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${assetId ?? ''}:${filterKey(filters)}:${action ?? ''}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const tokenIds = assetIdsForToken(filters.token)
    // Staking activity can only represent HDX or stHDX. Avoid walking the full
    // staking history for every unrelated token in the merged activity feed.
    if (tokenIds != null && !tokenIds.some(id => id === 0 || id === 670)) return []
    const preferredAssetId = assetId ?? (tokenIds?.length === 1 && tokenIds[0] === 670 ? 670 : undefined)
    const postFilter = assetId != null || tokenIds != null || filters.min != null || action != null
    const want = offset + limit
    const scanLimit = postFilter ? Math.max(want * 8, limit + 250) : limit
    const scanOffset = postFilter ? 0 : offset
    const selectedNames = action && STAKING_ACTION_EVENTS[action]
      ? STAKING_ACTION_EVENTS[action]
      : preferredAssetId === 670
        ? ['GigaHdx.Staked', 'GigaHdx.Unstaked', 'GigaHdx.UnstakeCancelled', 'GigaHdx.MigratedFromLegacy', 'GigaHdxRewards.RewardsClaimed']
        : STAKING_EVENT_NAMES
    // A subordinate-only filter still needs its possible parent events as
    // classification context. They are removed again after hierarchy folding,
    // so filtering for "Giga stake" does not resurrect reward/migration plumbing.
    const contextNames = action === 'Giga stake'
      ? ['GigaHdxRewards.RewardsClaimed', 'GigaHdx.MigratedFromLegacy']
      : action === 'Force unstake' ? ['GigaHdx.MigratedFromLegacy'] : []
    const sourceNames = [...new Set([...selectedNames, ...contextNames])]
    const names = sourceNames.map(n => `'${n}'`).join(',')
    // Account-scoped: prune via the activity index; global: recency window.
    const accountRefsFilter = acctList && !postFilter
      ? `AND ${accountActivityRefsSql(acctList, `event_name IN (${names})`, bound, scanOffset + scanLimit)}`
      : ''
    const accountFilter = acctList
      ? `AND who IN (${acctList})`
      : ''
    const gigaAssetId = preferredAssetId === 670 ? 670 : 0
    const stakingAssetExpr = `multiIf(event_name='CollatorRewards.CollatorRewarded', greatest(0, JSONExtractInt(args_json,'currency')), event_name LIKE 'GigaHdx%', ${gigaAssetId}, 0)`
    const stakingAmountExpr = `multiIf(
      event_name='CollatorRewards.CollatorRewarded', JSONExtractString(args_json,'amount'),
      event_name='GigaHdx.Staked', JSONExtractString(args_json,'${gigaAssetId === 670 ? 'gigahdx' : 'amount'}'),
      event_name='GigaHdx.Unstaked', JSONExtractString(args_json,'${gigaAssetId === 670 ? 'gigahdxAmount' : 'payout'}'),
      event_name='GigaHdx.UnstakeCancelled', JSONExtractString(args_json,'${gigaAssetId === 670 ? 'gigahdx' : 'amount'}'),
      event_name='GigaHdx.MigratedFromLegacy', JSONExtractString(args_json,'${gigaAssetId === 670 ? 'gigahdxReceived' : 'hdxUnlocked'}'),
      event_name='GigaHdxRewards.RewardsClaimed', JSONExtractString(args_json,'${gigaAssetId === 670 ? 'gigahdxReceived' : 'totalHdx'}'),
      event_name='Staking.PositionCreated', if(JSONHas(args_json,'stake'), JSONExtractString(args_json,'stake'), JSONExtractString(args_json,'amount')),
      event_name IN ('Staking.StakeAdded','Staking.Unstaked'), if(JSONHas(args_json,'amount'), JSONExtractString(args_json,'amount'), JSONExtractString(args_json,'stake')),
      event_name='Staking.ForceUnstaked', if(JSONHas(args_json,'paidRewards'), JSONExtractString(args_json,'paidRewards'), JSONExtractString(args_json,'stake')),
      event_name='Staking.RewardsClaimed', JSONExtractString(args_json,'paidRewards'), '')`
    const stakingValueFilter = eventValueFilterSql(stakingAssetExpr, stakingAmountExpr, 'block_timestamp', filters, prices, 'staking_price')
    const runStaking = async (b: string, pageLimit: number, pageOffset: number) => {
      const res = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, args_json
                FROM price_data.staking_activity FINAL
                ${stakingValueFilter.joinSql}
                WHERE ${b} ${accountRefsFilter} AND event_name IN (${names}) ${accountFilter}
                ${stakingValueFilter.predicateSql}
                ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      return res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }>()
    }
    const buildRows = (raw: { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }[]) => {
      const out: { row: ActivityRow; key: string }[] = []
      const seen = new Set<string>()
      for (const r of suppressGigaCompanionEvents(raw)) {
        const built = stakingRowFromEvent(r, prices, { preferredAssetId })
        if (!built) continue
        if (action != null && built.row.stakingAction !== action) continue
        const key = `${r.block_height}:${r.extrinsic_index ?? 'e'}:${r.event_name}:${built.who}:${built.assetId}:${built.amount}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ row: built.row, key })
      }
      return out
    }
    if (postFilter) {
      // Staking values are only computable from built rows (per-event amount
      // fields, HDX-vs-stHDX perspective) — walk full history in pages until
      // enough filtered rows exist instead of post-filtering a recency window.
      let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
      const deep = await fetchFilteredDeep(tw, want, async (b, pageLimit) => {
        const raw = await runStaking(b, pageLimit, 0)
        const last = raw.at(-1)
        pageState = {
          scanned: raw.length,
          cursor: last ? { blockHeight: last.block_height, eventIndex: last.event_index } : null,
        }
        const built = buildRows(raw)
        await applyHistoricalUsd(built.map(p => p.row), activityHistPick)
        return built
      },
        p => activityRowMatchesFilters(p.row, filters), p => p.row.blockHeight, p => p.row.eventIndex ?? -1, p => p.key,
        { pageState: () => pageState })
      return deep.map(p => p.row).slice(offset, offset + limit)
    }
    const rawStaking = acctList ? await runStaking(bound, scanLimit, scanOffset) : await withFeedWindow(tw, scanLimit, scanOffset + scanLimit, (b) => runStaking(b, scanLimit, scanOffset))
    const built = buildRows(rawStaking).map(p => p.row)
    await applyHistoricalUsd(built, activityHistPick)
    const filtered = built.filter(r => activityRowMatchesFilters(r, filters))
    return postFilter ? filtered.slice(offset, offset + limit) : filtered
  })
}

// OTC (place / pull / fill)
// OTC.Placed/Cancelled carry no `who` — the actor is the extrinsic signer
// (batched via signersFor, the same attribution pattern trades use for their
// pallet-internal swap events). OTC.Filled/PartiallyFilled carry `who`
// directly (the taker) but no asset legs of their own — those are resolved
// from the order's Placed event via ONE batched by-orderId lookup (mirrors
// getDcaScheduleLinks). Unlike an AMM swap (pool-internal Withdrawn/Deposited,
// no user-to-user Transfer), a Fill settles genuinely peer-to-peer — real
// Tokens.Transfer/Currencies.Transferred legs between taker and maker — so
// extrinsic-scoped builders below also suppress those legs from the Transfers
// category, else every fill would double as spurious transfer rows.
const OTC_EVENT_NAMES = ['OTC.Placed', 'OTC.Cancelled', 'OTC.Filled', 'OTC.PartiallyFilled']
const OTC_ACTION_EVENTS: Record<string, string[]> = {
  Place: ['OTC.Placed'],
  Pull: ['OTC.Cancelled'],
  Fill: ['OTC.Filled', 'OTC.PartiallyFilled'],
}
// OTC folded under the Trade chip/type: the UI's action dropdown sends the
// hyphenated `otc-place`/`otc-pull`/`otc-fill` values (alongside trade's own
// `swap`/`dca`) for both `type=trade` and (API nicety) `type=otc`. Resolve
// either form down to the raw otcAction label used by OTC_ACTION_EVENTS/row.otcAction.
const OTC_ACTION_ALIASES: Record<string, string> = { 'otc-place': 'Place', 'otc-pull': 'Pull', 'otc-fill': 'Fill' }
function resolveOtcAction(action?: string): string | undefined {
  if (!action) return undefined
  return OTC_ACTION_ALIASES[action] ?? action
}
interface OtcPlacedLeg { assetIn: number; assetOut: number; amountIn: string; amountOut: string; partiallyFillable: boolean }
// Batched orderId → Placed-event legs, shared by Cancelled (Pull) and
// Filled/PartiallyFilled (Fill) row construction — neither carries asset
// identity itself, only the order's original Placed event does. Missing ids
// (e.g. a Fill whose Placed row predates the indexed window) are simply
// absent from the returned map; callers render the row without legs.
async function getOtcPlacedLegsByOrderId(orderIds: Array<string | number>): Promise<Map<string, OtcPlacedLeg>> {
  const list = sqlUIntList(orderIds)
  const out = new Map<string, OtcPlacedLeg>()
  if (!list) return out
  const res = await client.query({
    query: `SELECT args_json FROM ${otcActivityTable()} WHERE event_name = 'OTC.Placed' AND JSONExtractUInt(args_json,'orderId') IN (${list})`,
    format: 'JSONEachRow',
  })
  for (const r of await res.json<{ args_json: string }>()) {
    const args = (safeJson(r.args_json) ?? {}) as Record<string, unknown>
    const orderId = argStr(args, 'orderId')
    if (!orderId) continue
    out.set(orderId, {
      assetIn: argInt(args, 'assetIn'), assetOut: argInt(args, 'assetOut'),
      amountIn: argStr(args, 'amountIn'), amountOut: argStr(args, 'amountOut'),
      partiallyFillable: args.partiallyFillable === true,
    })
  }
  return out
}

// Per-event → ActivityRow construction shared by every OTC surface (main feed,
// getExtrinsicActivity, getBlockHookActivity, account/asset activities — mirrors
// stakingRowFromEvent's factoring). `signerFallback` supplies `who` for
// Place/Cancelled (no `who` arg on those events, and no signer for the rare
// hook-context rows); Fill/PartiallyFilled read `who` from args instead.
function otcRowFromEvent(
  e: { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string },
  prices: Map<number, PriceInfo>,
  placedById: Map<string, OtcPlacedLeg>,
  opts: { signerFallback?: string | null } = {},
): ActivityRow | null {
  const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
  const orderId = argInt(args, 'orderId')
  const base = {
    type: 'otc' as const, blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
    to: null, asset: null, amount: null, otcOrderId: orderId,
    linkBlock: e.block_height, linkIndex: e.extrinsic_index,
  }
  const signerWho = opts.signerFallback && ACCOUNT_RE.test(opts.signerFallback) ? accountRef(opts.signerFallback) : null

  if (e.event_name === 'OTC.Placed') {
    // Actor pays (locks) the order's assetOut and receives its assetIn —
    // display flips the order's own perspective to the actor-pays→receives
    // convention every other trade-like row uses.
    const aIn = asset(argInt(args, 'assetOut'))
    const aOut = asset(argInt(args, 'assetIn'))
    const amountIn = argStr(args, 'amountOut')
    const amountOut = argStr(args, 'amountIn')
    return {
      ...base, who: signerWho, assetIn: aIn, assetOut: aOut, amountIn, amountOut,
      valueUsd: usdValue(prices, aOut.assetId, amountOut, aOut.decimals) ?? usdValue(prices, aIn.assetId, amountIn, aIn.decimals),
      otcAction: 'Place', otcPartiallyFillable: args.partiallyFillable === true,
    }
  }

  if (e.event_name === 'OTC.Cancelled') {
    const placed = placedById.get(String(orderId))
    // Same maker-perspective flip as Place (this is the order being pulled).
    const aIn = placed ? asset(placed.assetOut) : null
    const aOut = placed ? asset(placed.assetIn) : null
    const amountIn = placed ? placed.amountOut : null
    const amountOut = placed ? placed.amountIn : null
    return {
      ...base, who: signerWho, assetIn: aIn, assetOut: aOut, amountIn, amountOut,
      valueUsd: aOut && amountOut != null
        ? (usdValue(prices, aOut.assetId, amountOut, aOut.decimals) ?? (aIn && amountIn != null ? usdValue(prices, aIn.assetId, amountIn, aIn.decimals) : null))
        : null,
      otcAction: 'Pull',
    }
  }

  // OTC.Filled / OTC.PartiallyFilled — asset identity comes from the order
  // (assetIn/assetOut have no field on these events); amounts are the taker's
  // own amountIn/amountOut, straight from the event (not flipped).
  const placed = placedById.get(String(orderId))
  const who = argStr(args, 'who')
  const aIn = placed ? asset(placed.assetIn) : null
  const aOut = placed ? asset(placed.assetOut) : null
  const amountIn = argStr(args, 'amountIn')
  const amountOut = argStr(args, 'amountOut')
  return {
    ...base, who: who && ACCOUNT_RE.test(who) ? accountRef(who) : null, assetIn: aIn, assetOut: aOut, amountIn, amountOut,
    valueUsd: aOut ? (usdValue(prices, aOut.assetId, amountOut, aOut.decimals) ?? (aIn ? usdValue(prices, aIn.assetId, amountIn, aIn.decimals) : null)) : null,
    otcAction: 'Fill', otcPartial: e.event_name === 'OTC.PartiallyFilled', otcFee: argStr(args, 'fee'),
  }
}

interface RawOtcActivityEvent { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }
// Windowed OTC feed — mirrors getRecentMoneyMarket/getRecentStaking's shape
// (action→event-name filter, feed-window scan, batched enrichment, post-filter).
async function getRecentOtc(limit: number, from?: string, to?: string, offset = 0, filters: ValueListFilters = {}, action?: string, accounts?: string[]): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const accountSet = accounts?.length ? new Set(accounts.map(account => account.toLowerCase())) : null
  return cached(`explorer:otc-activity:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}:${action ?? ''}:${accounts?.join(',') ?? ''}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const postFilter = tokenIds != null || filters.min != null || accountSet != null
    const want = offset + limit
    const resolvedAction = resolveOtcAction(action)
    const names = (resolvedAction && OTC_ACTION_EVENTS[resolvedAction] ? OTC_ACTION_EVENTS[resolvedAction] : OTC_EVENT_NAMES).map(n => `'${n}'`).join(',')
    const fetchPage = async (bound: string, pageLimit: number, pageOffset: number): Promise<ActivityRow[]> => {
      // An account OTC feed used to start at every OTC event, then resolve
      // signers and discard almost all rows in JS. Filled events expose `who`
      // and are already in account_activity; Placed/Cancelled are owned by the
      // signing extrinsic. Combine those two account-first reference sets before
      // reading raw event payloads, preserving the exact later row builder.
      const accountRefs = accountSet
        ? `AND ((e.block_height, e.event_index) IN (
              SELECT block_height, event_index FROM price_data.account_activity
              WHERE account IN (${sqlAccountList(accounts!)}) AND ${bound}
                AND event_name IN (${names})
              GROUP BY block_height, event_index
            ) OR (e.block_height, e.extrinsic_index) IN (
              SELECT block_height, extrinsic_index FROM price_data.raw_extrinsics
              WHERE signer IN (${sqlAccountList(accounts!)}) OR effective_signer IN (${sqlAccountList(accounts!)})
            ))`
        : ''
      const res = await client.query({
        query: `SELECT e.block_height, toString(e.block_timestamp) AS ts, e.event_index, e.extrinsic_index, e.event_name, e.args_json
                FROM (
                  SELECT block_height, block_timestamp, event_index, extrinsic_index, event_name, args_json
                  FROM ${otcActivityTable()}
                  WHERE ${bound}
                ) AS e
                WHERE e.event_name IN (${names})
                ${accountRefs}
                ORDER BY e.block_height DESC, e.event_index DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      const rawOtc = await res.json<RawOtcActivityEvent>()
      if (!rawOtc.length) return []
      const lookupIds = rawOtc.filter(r => r.event_name !== 'OTC.Placed')
        .map(r => argInt((safeJson(r.args_json) ?? {}) as Record<string, unknown>, 'orderId'))
      const [placedById, signers] = await Promise.all([
        getOtcPlacedLegsByOrderId(lookupIds),
        signersFor(rawOtc.filter(r => r.event_name === 'OTC.Placed' || r.event_name === 'OTC.Cancelled').map(r => [r.block_height, r.extrinsic_index] as [number, number | null])),
      ])
      const out: ActivityRow[] = []
      for (const r of rawOtc) {
        const signer = r.extrinsic_index != null ? signers.get(`${r.block_height}:${r.extrinsic_index}`) ?? null : null
        const row = otcRowFromEvent(r, prices, placedById, { signerFallback: signer })
        if (row) out.push(row)
      }
      await applyHistoricalUsd(out, activityHistPick)
      return out
    }
    if (postFilter) {
      // Token/min need the order's Placed legs (joined after fetch) — walk full
      // history in pages until enough filtered rows exist.
      const deep = await fetchFilteredDeep(tw, want, (bound, pageLimit) => fetchPage(bound, pageLimit, 0),
        r => activityRowMatchesFilters(r, filters) && (accountSet == null || (r.who != null && accountSet.has(r.who.accountId.toLowerCase()))),
        r => r.blockHeight, r => r.eventIndex ?? -1, r => `${r.blockHeight}:${r.eventIndex}`)
      return deep.slice(offset, offset + limit)
    }
    return withFeedWindow(tw, limit, offset + limit, (bound) => fetchPage(bound, limit, offset))
  })
}

export interface VoteRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  account: AccountRef | null
  pallet: string
  action: string
  referendum: string | null
  side: string
  conviction: string | null
  amount: string | null
  asset: AssetRef
  valueUsd: number | null
}
const CONVICTION = ['None', 'Locked1x', 'Locked2x', 'Locked3x', 'Locked4x', 'Locked5x', 'Locked6x']
function decodeStandardVote(v: unknown): { side: string; conviction: string | null } {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return { side: 'Vote', conviction: null }
  return { side: n >= 128 ? 'Aye' : 'Nay', conviction: CONVICTION[n & 0x7f] ?? `Conviction ${n & 0x7f}` }
}
type VoteDetails = { amount: string | null; side: string; conviction: string | null }
export function voteDetails(args: Record<string, unknown>): VoteDetails {
  const vote = args.vote as Record<string, unknown> | undefined
  if (!vote) return { amount: null, side: 'Vote', conviction: null }
  if (vote.__kind === 'Split') {
    const aye = argStr(vote, 'aye'), nay = argStr(vote, 'nay')
    const amount = /^\d+$/.test(aye) && /^\d+$/.test(nay) ? String(BigInt(aye) + BigInt(nay)) : null
    return { amount, side: 'Split', conviction: null }
  }
  if (vote.__kind === 'SplitAbstain') {
    const aye = argStr(vote, 'aye'), nay = argStr(vote, 'nay'), abstain = argStr(vote, 'abstain')
    const amount = /^\d+$/.test(aye) && /^\d+$/.test(nay) && /^\d+$/.test(abstain)
      ? String(BigInt(aye) + BigInt(nay) + BigInt(abstain))
      : null
    return { amount, side: 'Split abstain', conviction: null }
  }
  const std = decodeStandardVote(vote.vote)
  return { amount: argStr(vote, 'balance') || null, ...std }
}
// Gasless app votes arrive as MultiTransactionPayment.dispatch_permit with the
// SCALE-encoded ConvictionVoting.vote call in the permit's `data` payload — the
// call tree never contains a ConvictionVoting.vote row, so the referendum index
// must be decoded from those bytes: [pallet u8, call u8, compact pollIndex,
// AccountVote]. Pallet/call indexes are Hydration runtime constants.
const CONVICTION_VOTING_PALLET_IDX = 0x24
const CONVICTION_VOTE_CALL_IDX = 0x00
// Wrapper calls whose args can carry a nested ConvictionVoting.vote.
const VOTE_WRAPPER_CALLS = ["'Proxy.proxy'", "'Proxy.proxy_announced'", "'Utility.batch'", "'Utility.batch_all'", "'Utility.force_batch'", "'Utility.as_derivative'", "'Multisig.as_multi'", "'Multisig.as_multi_threshold_1'"].join(',')
export function voteFromPermitData(dataHex: unknown): { ref: string; details: VoteDetails } | null {
  if (typeof dataHex !== 'string' || !dataHex.startsWith('0x')) return null
  const b = Buffer.from(dataHex.slice(2), 'hex')
  if (b.length < 4 || b[0] !== CONVICTION_VOTING_PALLET_IDX || b[1] !== CONVICTION_VOTE_CALL_IDX) return null
  let off = 2
  const mode = b[off] & 3
  let ref: number
  if (mode === 0) { ref = b[off] >> 2; off += 1 }
  else if (mode === 1) { ref = (b[off] | (b[off + 1] << 8)) >> 2; off += 2 }
  else if (mode === 2) { ref = (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 2; off += 4 }
  else return null
  // AccountVote::Standard { vote: u8, balance: u128 LE }; Split/SplitAbstain via
  // permit stay event-only (no referendum recoverable).
  if (b[off] !== 0x00 || b.length < off + 2 + 16) return null
  const voteByte = b[off + 1]
  let balance = 0n
  for (let i = 15; i >= 0; i--) balance = (balance << 8n) | BigInt(b[off + 2 + i])
  return { ref: String(ref), details: { amount: balance.toString(), ...decodeStandardVote(voteByte) } }
}
// ConvictionVoting.vote calls hidden inside wrapper args (Proxy.proxy,
// Utility.batch*, Multisig.as_multi, …): the decoded call tree is right there in
// the wrapper's JSON, so walk it. Used as a fallback when the nested call row
// itself is unavailable.
export function nestedVoteInfos(value: unknown, out: { ref: string; details: VoteDetails }[] = []): { ref: string; details: VoteDetails }[] {
  if (Array.isArray(value)) {
    for (const v of value) nestedVoteInfos(v, out)
    return out
  }
  if (value == null || typeof value !== 'object') return out
  const o = value as Record<string, unknown>
  if (o.__kind === 'ConvictionVoting') {
    const inner = o.value as Record<string, unknown> | undefined
    if (inner?.__kind === 'vote') {
      const ref = argStr(inner, 'pollIndex')
      if (ref) out.push({ ref, details: voteDetails(inner) })
      return out
    }
  }
  for (const v of Object.values(o)) nestedVoteInfos(v, out)
  return out
}
function mergeVoteDetails(primary: VoteDetails, fallback?: VoteDetails): VoteDetails {
  if (!fallback) return primary
  return {
    amount: primary.amount ?? fallback.amount,
    side: primary.side === 'Vote' ? fallback.side : primary.side,
    conviction: primary.conviction ?? fallback.conviction,
  }
}
function voteAmountSqlExpr(): string {
  const vote = `JSONExtractRaw(args_json,'vote')`
  const aye = `toUInt256OrZero(JSONExtractString(${vote},'aye'))`
  const nay = `toUInt256OrZero(JSONExtractString(${vote},'nay'))`
  const abstain = `toUInt256OrZero(JSONExtractString(${vote},'abstain'))`
  return `multiIf(
    JSONExtractString(${vote},'__kind') = 'Split', toString(${aye} + ${nay}),
    JSONExtractString(${vote},'__kind') = 'SplitAbstain', toString(${aye} + ${nay} + ${abstain}),
    JSONExtractString(${vote},'balance')
  )`
}
function voteRowMatchesFilters(row: VoteRow, filters: VoteListFilters): boolean {
  if (filters.referendum && row.referendum !== filters.referendum) return false
  if (filters.conviction && (row.conviction ?? '').toLowerCase() !== filters.conviction.toLowerCase()) return false
  return true
}
async function getRecentVotes(limit: number, from?: string, to?: string, offset = 0, filters: VoteListFilters = {}, accounts?: string[], valueFilters: ValueListFilters = {}): Promise<VoteRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:votes:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}:${filterKey(valueFilters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const eventFilter = "AND event_name IN ('ConvictionVoting.Voted','Democracy.Voted')"
    const tokenIds = assetIdsForToken(valueFilters.token)
    if (tokenIds != null && !tokenIds.includes(0)) return []
    const amountFilter = eventValueFilterSql('0', voteAmountSqlExpr(), 'block_timestamp', valueFilters, prices, 'vote_price')
    const postFilter = !!filters.referendum || !!filters.conviction
    const want = offset + limit
    const scanLimit = postFilter ? Math.max(want * 8, limit + 500) : limit
    const scanOffset = postFilter ? 0 : offset
    const accountRefsFilter = acctList && !postFilter && tokenIds == null && valueFilters.min == null
      ? `AND ${accountActivityRefsSql(acctList, `event_name IN ('ConvictionVoting.Voted','Democracy.Voted')`, bound, scanOffset + scanLimit)}`
      : ''
    const accountFilter = acctList ? `AND (JSONExtractString(args_json,'who') IN (${acctList}) OR JSONExtractString(args_json,'voter') IN (${acctList}))` : ''
    const runVotes = async (b: string, pageLimit: number, pageOffset: number) => {
      const res = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, ifNull(call_address, '') AS call_address, event_name, args_json
                FROM price_data.vote_activity FINAL
                ${amountFilter.joinSql}
                WHERE ${b} ${accountRefsFilter} ${eventFilter} ${accountFilter} ${amountFilter.predicateSql}
                ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      return res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; call_address: string; event_name: string; args_json: string }>()
    }
    const buildRows = async (events: { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; call_address: string; event_name: string; args_json: string }[]): Promise<VoteRow[]> => {
      const callTuples = [...new Set(events.filter(e => e.event_name === 'ConvictionVoting.Voted' && e.extrinsic_index != null).map(e => `(${e.block_height},${e.extrinsic_index})`))]
      const callByExact = new Map<string, { ref: string | null; details: VoteDetails }>()
      const callByExt = new Map<string, { ref: string | null; details: VoteDetails }>()
      const callsByExt = new Map<string, { ref: string | null; details: VoteDetails }[]>()
      if (callTuples.length) {
        const calls = await client.query({
          query: `SELECT block_height, extrinsic_index, call_address, call_name, args_json
                  FROM price_data.raw_calls
                  WHERE (block_height, extrinsic_index) IN (${callTuples.join(',')})
                    AND call_name IN ('ConvictionVoting.vote', 'MultiTransactionPayment.dispatch_permit', ${VOTE_WRAPPER_CALLS})`,
          format: 'JSONEachRow',
        })
        const callRows = await calls.json<{ block_height: number; extrinsic_index: number | null; call_address: string; call_name: string; args_json: string }>()
        for (const c of callRows) {
          if (c.extrinsic_index == null) continue
          const args = (safeJson(c.args_json) ?? {}) as Record<string, unknown>
          // Gasless votes: the vote call hides SCALE-encoded in the permit payload.
          const info = c.call_name === 'MultiTransactionPayment.dispatch_permit'
            ? voteFromPermitData(args.data)
            : c.call_name === 'ConvictionVoting.vote'
              ? (() => { const ref = argStr(args, 'pollIndex'); return ref ? { ref, details: voteDetails(args) } : null })()
              : null
          if (!info) continue
          const extKey = `${c.block_height}:${c.extrinsic_index}`
          callByExact.set(`${c.block_height}:${c.extrinsic_index}:${c.call_address}`, info)
          if (!callsByExt.has(extKey)) callsByExt.set(extKey, [])
          callsByExt.get(extKey)!.push(info)
        }
        // Wrapper fallback (proxy/batch/multisig args carry the decoded vote call):
        // only for extrinsics without a direct vote/permit row. This also covers
        // retained historical rows where nested calls were not indexed separately.
        for (const c of callRows) {
          if (c.extrinsic_index == null || c.call_name === 'ConvictionVoting.vote' || c.call_name === 'MultiTransactionPayment.dispatch_permit') continue
          const extKey = `${c.block_height}:${c.extrinsic_index}`
          if (callsByExt.has(extKey)) continue
          const infos = nestedVoteInfos(safeJson(c.args_json))
          if (infos.length) callsByExt.set(extKey, infos)
        }
        for (const [key, infos] of callsByExt) if (infos.length === 1) callByExt.set(key, infos[0])
      }
      const hdx = asset(0)
      const out: VoteRow[] = []
      for (const e of events) {
        const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
        const pallet = e.event_name.split('.')[0]
        const account = argStr(args, e.event_name === 'Democracy.Voted' ? 'voter' : 'who')
        const callInfo = e.extrinsic_index != null ? (callByExact.get(`${e.block_height}:${e.extrinsic_index}:${e.call_address}`) ?? callByExt.get(`${e.block_height}:${e.extrinsic_index}`)) : undefined
        const ref = e.event_name === 'Democracy.Voted'
          ? argStr(args, 'refIndex') || null
          : callInfo?.ref ?? null
        const details = mergeVoteDetails(voteDetails(args), callInfo?.details)
        const row: VoteRow = {
          blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
          account: account && ACCOUNT_RE.test(account) ? accountRef(account) : null,
          pallet, action: 'Voted', referendum: ref, side: details.side, conviction: details.conviction, amount: details.amount,
          asset: hdx, valueUsd: details.amount ? usdValue(prices, hdx.assetId, details.amount, hdx.decimals) : null,
        }
        out.push(row)
      }
      return out
    }
    if (postFilter) {
      // Referendum/conviction resolve from the joined vote CALL, not the event —
      // walk full history in pages until enough filtered rows exist instead of
      // post-filtering a recency window.
      const deep = await fetchFilteredDeep(tw, want, async (b, pageLimit) => buildRows(await runVotes(b, pageLimit, 0)),
        r => voteRowMatchesFilters(r, filters), r => r.blockHeight, r => r.eventIndex, r => `${r.blockHeight}:${r.eventIndex}`)
      return deep.slice(offset, offset + limit)
    }
    const events = acctList ? await runVotes(bound, scanLimit, scanOffset) : await withFeedWindow(tw, scanLimit, scanOffset + scanLimit, (b) => runVotes(b, scanLimit, scanOffset))
    const out = (await buildRows(events)).filter(r => voteRowMatchesFilters(r, filters))
    return postFilter ? out.slice(offset, offset + limit) : out.slice(0, limit)
  })
}

// Collective (Council / Technical Committee) votes are too sparse (~3k events
// all-time) to justify extending the vote_activity model: read raw_events
// directly — the event-name set index plus the tiny row volume keep the scan
// bounded. These events carry no conviction, balance, or referendum index; the
// proposal hash (shortened) stands in for the referendum and the row carries no
// token amount.
const COLLECTIVE_VOTE_EVENTS = ['Council.Voted', 'TechnicalCommittee.Voted']
function shortProposalHash(hash: string): string {
  return /^0x[0-9a-f]+$/i.test(hash) && hash.length > 18 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
}
async function getCollectiveVotes(accounts: string[], limit: number, from?: string, to?: string): Promise<VoteRow[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  const bound = timeWindow(from, to) ?? '1'
  const res = await client.query({
    query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, args_json
            FROM price_data.raw_events
            WHERE ${bound}
              AND event_name IN (${sqlEventNameList(COLLECTIVE_VOTE_EVENTS)})
              AND JSONExtractString(args_json,'account') IN (${list})
            ORDER BY block_height DESC, event_index DESC
            LIMIT {limit:UInt32}`,
    query_params: { limit }, format: 'JSONEachRow',
  })
  const events = await res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }>()
  const hdx = asset(0)
  // raw_events is a ReplacingMergeTree read without FINAL; dedup any re-ingested
  // rows by (block, event_index) so a re-index can't emit a duplicate vote.
  const seen = new Set<string>()
  const out: VoteRow[] = []
  for (const e of events) {
    const key = `${e.block_height}:${e.event_index}`
    if (seen.has(key)) continue
    seen.add(key)
    const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
    const account = argStr(args, 'account')
    const hash = argStr(args, 'proposalHash')
    out.push({
      blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
      account: account && ACCOUNT_RE.test(account) ? accountRef(account) : null,
      pallet: e.event_name === 'Council.Voted' ? 'Council' : 'Technical Committee',
      action: 'Voted', referendum: hash ? shortProposalHash(hash) : null,
      side: args.voted === true ? 'Aye' : args.voted === false ? 'Nay' : 'Vote',
      conviction: null, amount: null, asset: hdx, valueUsd: 0,
    })
  }
  return out
}

// Account/tag Votes tab: OpenGov + Democracy rows come from the indexed
// vote_activity path (getRecentVotes recovers referendum/conviction from the
// joined vote call), collective rows from raw_events. Each source is fetched to
// offset+limit depth, merged newest-first, and paged after the merge.
async function getScopedVotes(accounts: string[], cacheScope: string, limit: number, offset: number, from?: string, to?: string, filters: VoteListFilters = {}): Promise<VoteRow[]> {
  const window = timeWindow(from, to)
  return cached(`explorer:${cacheScope}:votes:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, window ? 30_000 : 8_000, async () => {
    const want = offset + limit
    const [gov, collective] = await Promise.all([
      getRecentVotes(want, from, to, 0, filters, accounts),
      getCollectiveVotes(accounts, want, from, to),
    ])
    return [...gov, ...collective.filter(row => voteRowMatchesFilters(row, filters))]
      .sort((a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)
      .slice(offset, offset + limit)
  })
}

// Total governance votes for an account set: conviction/democracy votes from
// the account-activity index plus the (rare) collective votes from raw_events.
// Feeds the Votes tab badge — cached like the neighbouring tab counts.
async function getScopedVotesCount(accounts: string[], cacheKey: string): Promise<number> {
  const list = sqlAccountList(accounts)
  if (list === "''") return 0
  return cached(`explorer:votes-count:${cacheKey}`, 600_000, async () => {
    const [govRes, collectiveRes] = await Promise.all([
      client.query({
        query: `SELECT uniqExact((block_height, event_index)) AS c FROM price_data.account_activity
                WHERE account IN (${list}) AND event_name IN ('ConvictionVoting.Voted','Democracy.Voted')`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT uniqExact((block_height, event_index)) AS c FROM price_data.raw_events
                WHERE event_name IN (${sqlEventNameList(COLLECTIVE_VOTE_EVENTS)})
                  AND JSONExtractString(args_json,'account') IN (${list})`,
        format: 'JSONEachRow',
      }),
    ])
    const n = (v: unknown) => Number(v ?? 0)
    return n((await govRes.json<{ c: string }>())[0]?.c) + n((await collectiveRes.json<{ c: string }>())[0]?.c)
  })
}

const isModuleAcct = (a: AccountRef | null | undefined): boolean => !!a && a.accountId.startsWith('0x6d6f646c')
function activityExtrinsicSet(rows: ActivityRow[]): Set<string> {
  return new Set(rows.filter(r => r.extrinsicIndex != null).map(r => `${r.blockHeight}:${r.extrinsicIndex}`))
}

// Keep the semantic (highest-level) activity and hide its transfer plumbing.
// Signed activity is owned by its extrinsic. Hook/finalization activity has no
// extrinsic, so require both the block and an involved account to match; this
// avoids swallowing an unrelated transfer merely because it shares a block.
//
// This deliberately works on ActivityRow rather than event names so every feed
// (global/account/tag/asset/block/detail) applies exactly the same rule after
// its source-specific rows have been constructed.
export function suppressSubordinateActivityRows<T extends ActivityRow>(rows: T[]): T[] {
  const semanticByExtrinsic = new Set<string>()
  const semanticHookAccounts = new Map<number, Set<string>>()
  for (const row of rows) {
    if (row.type === 'transfer') continue
    if (row.extrinsicIndex != null) {
      semanticByExtrinsic.add(`${row.blockHeight}:${row.extrinsicIndex}`)
      continue
    }
    const accounts = [row.who?.accountId, row.to?.accountId].filter((a): a is string => !!a).map(a => a.toLowerCase())
    if (!accounts.length) continue
    const blockAccounts = semanticHookAccounts.get(row.blockHeight) ?? new Set<string>()
    for (const account of accounts) blockAccounts.add(account)
    semanticHookAccounts.set(row.blockHeight, blockAccounts)
  }
  return rows.filter(row => {
    if (row.type !== 'transfer') return true
    if (row.extrinsicIndex != null) return !semanticByExtrinsic.has(`${row.blockHeight}:${row.extrinsicIndex}`)
    const owners = semanticHookAccounts.get(row.blockHeight)
    if (!owners) return true
    return ![row.who?.accountId, row.to?.accountId]
      .filter((a): a is string => !!a)
      .some(account => owners.has(account.toLowerCase()))
  })
}

// A dust cleanup is emitted as Tokens.Transfer immediately followed by
// Tokens.DustLost.  It is balance-accounting performed by the tokens pallet,
// not a transfer initiated by the account.  Match the exact sibling event
// (including account, asset and amount) rather than hiding every treasury leg.
async function suppressDustTransferRows<T extends ActivityRow>(rows: T[]): Promise<T[]> {
  const transfers = rows.filter(r => r.type === 'transfer' && r.eventIndex != null && r.who && r.asset && r.amount)
  if (!transfers.length) return rows
  const tuples = [...new Set(transfers.map(r => `(${r.blockHeight},${r.eventIndex! + 1})`))]
  const dustKeys = new Set<string>()
  for (let start = 0; start < tuples.length; start += 5000) {
    const res = await client.query({
      query: `SELECT block_height, event_index,
                JSONExtractString(args_json,'who') AS who,
                JSONExtractInt(args_json,'currencyId') AS asset_id,
                JSONExtractString(args_json,'amount') AS amount
              FROM price_data.raw_events
              WHERE (block_height, event_index) IN (${tuples.slice(start, start + 5000).join(',')})
                AND event_name = 'Tokens.DustLost'`,
      format: 'JSONEachRow',
    })
    for (const d of await res.json<{ block_height: number; event_index: number; who: string; asset_id: number; amount: string }>()) {
      dustKeys.add(`${d.block_height}:${d.event_index - 1}:${d.who.toLowerCase()}:${d.asset_id}:${d.amount}`)
    }
  }
  return rows.filter(r => r.type !== 'transfer' || r.eventIndex == null || !r.who || !r.asset || !r.amount
    || !dustKeys.has(`${r.blockHeight}:${r.eventIndex}:${r.who.accountId.toLowerCase()}:${r.asset.assetId}:${r.amount}`))
}

async function suppressActivityPlumbing<T extends ActivityRow>(rows: T[]): Promise<T[]> {
  return suppressDustTransferRows(suppressSubordinateActivityRows(rows))
}

// Transfer-only pages still need the same semantic ownership decision as the
// merged feed, but they must not enumerate every unrelated activity source far
// enough back to cover a sparse value filter. Resolve ownership only for the
// bounded transfer candidates. Signed rows are matched by exact
// (block,extrinsic); hook rows use the same block+account rule as
// suppressSubordinateActivityRows.
async function suppressTransferCandidates(transfers: TransferRow[]): Promise<TransferRow[]> {
  if (!transfers.length) return []
  const signedKeys = [...new Set(transfers
    .filter(row => row.extrinsicIndex != null)
    .map(row => `${row.blockHeight}:${row.extrinsicIndex}`))]
  const hookBlocks = [...new Set(transfers
    .filter(row => row.extrinsicIndex == null)
    .map(row => row.blockHeight))]
  const semanticExtrinsics = new Set<string>()
  const hookAccounts = new Map<number, Set<string>>()
  const addHookAccount = (blockHeight: number, account: string | null | undefined) => {
    if (!account || !ACCOUNT_RE.test(account)) return
    const accounts = hookAccounts.get(blockHeight) ?? new Set<string>()
    accounts.add(account.toLowerCase())
    hookAccounts.set(blockHeight, accounts)
  }

  type SemanticEvent = {
    block_height: number
    extrinsic_index: number | null
    event_name: string
    args_json: string
  }
  const semanticNames = [...new Set([
    ...SWAP_EVENTS,
    ...LIQUIDITY_EVENTS,
    ...STAKING_EVENT_NAMES,
    ...VOTE_EVENTS,
    'DCA.TradeExecuted', 'DCA.TradeFailed', 'Referrals.Claimed',
    ...OTC_EVENT_NAMES,
  ])]
  const semanticEvents: SemanticEvent[] = []
  for (let start = 0; start < signedKeys.length; start += 5_000) {
    const tuples = signedKeys.slice(start, start + 5_000)
      .map(key => { const [height, index] = key.split(':'); return `(${height},${index})` })
    const result = await client.query({
      query: `SELECT block_height, extrinsic_index, event_name, args_json
              FROM price_data.raw_events
              WHERE (block_height, extrinsic_index) IN (${tuples.join(',')})
                AND event_name IN (${sqlEventNameList(semanticNames)})
                AND NOT (event_name IN (${sqlEventNameList(SWAP_EVENTS)})
                  AND JSONExtractString(args_json,'who') = '${ROUTER_PALLET_ACCT}')
                AND NOT (event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
                  AND JSONExtractString(args_json,'who') LIKE '0x6d6f646c%')`,
      format: 'JSONEachRow',
    })
    semanticEvents.push(...await result.json<SemanticEvent>())
  }
  for (let start = 0; start < hookBlocks.length; start += 5_000) {
    const blocks = hookBlocks.slice(start, start + 5_000).join(',')
    const result = await client.query({
      query: `SELECT block_height, extrinsic_index, event_name, args_json
              FROM price_data.raw_events
              WHERE block_height IN (${blocks}) AND extrinsic_index IS NULL
                AND event_name IN (${sqlEventNameList(semanticNames)})
                AND NOT (event_name IN (${sqlEventNameList(SWAP_EVENTS)})
                  AND (JSONExtractString(args_json,'who') = '${ROUTER_PALLET_ACCT}'
                    OR (JSONExtractString(args_json,'who') != ''
                      AND JSONExtractString(args_json,'who') NOT LIKE '0x6d6f646c%')))
                AND NOT (event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
                  AND JSONExtractString(args_json,'who') LIKE '0x6d6f646c%')`,
      format: 'JSONEachRow',
    })
    semanticEvents.push(...await result.json<SemanticEvent>())
  }
  for (const event of semanticEvents) {
    const args = (safeJson(event.args_json) ?? {}) as Record<string, unknown>
    // Staking builders reject empty/zero amount events; do not let one own a
    // transfer that would otherwise remain visible.
    if (STAKING_EVENT_NAMES.includes(event.event_name)) {
      const staking = stakingAmountAndAsset(event.event_name, args)
      if (!staking?.amount || staking.amount === '0') continue
    }
    if (event.event_name === 'Referrals.Claimed') {
      const amount = BigInt(argStr(args, 'referrerRewards') || '0') + BigInt(argStr(args, 'tradeRewards') || '0')
      if (amount === 0n) continue
    }
    if (event.extrinsic_index != null) {
      semanticExtrinsics.add(`${event.block_height}:${event.extrinsic_index}`)
      continue
    }
    addHookAccount(event.block_height, argStr(args, 'who') || argStr(args, 'voter'))
  }

  // Money-market logs do not store the substrate extrinsic directly. Resolve
  // only logs in candidate blocks, then apply the same configured-pool and
  // module-user conditions as getRecentMoneyMarket.
  const candidateBlocks = [...new Set(transfers.map(row => row.blockHeight))]
  type SemanticMm = { block_height: number; event_index: number; account_id: string | null }
  const mmRows: SemanticMm[] = []
  for (let start = 0; start < candidateBlocks.length; start += 5_000) {
    const blocks = candidateBlocks.slice(start, start + 5_000).join(',')
    const result = await client.query({
      query: `SELECT block_height, event_index, account_id
              FROM price_data.raw_money_market_events
              WHERE block_height IN (${blocks})
                AND event_name IN ('Supply','Borrow','Repay','Withdraw','LiquidationCall')
                AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})
                AND user_address NOT LIKE '0x6d6f646c%'`,
      format: 'JSONEachRow',
    })
    mmRows.push(...await result.json<SemanticMm>())
  }
  const mmExtrinsics = await extrinsicIndexFor(mmRows.map(row => [row.block_height, row.event_index] as [number, number]))
  for (const row of mmRows) {
    const index = mmExtrinsics.get(`${row.block_height}:${row.event_index}`)
    if (index != null) semanticExtrinsics.add(`${row.block_height}:${index}`)
    else addHookAccount(row.block_height, row.account_id)
  }

  // XCM ownership is based on successfully decoded economic rows, not merely
  // the presence of a similarly named event. Decode the bounded candidate
  // blocks in chunks using the shared global/block builders.
  if (hookBlocks.length) {
    const prices = await ensurePrices()
    for (let start = 0; start < hookBlocks.length; start += 1_000) {
      const blocks = hookBlocks.slice(start, start + 1_000)
      const [incoming, outgoing] = await Promise.all([
        xcmInRowsForBlocks(blocks, prices),
        xcmOutRemoteRowsForBlocks(blocks, prices),
      ])
      for (const row of [...incoming, ...outgoing]) addHookAccount(row.blockHeight, row.who?.accountId)
    }
  }
  if (signedKeys.length) {
    for (let start = 0; start < signedKeys.length; start += 5_000) {
      const tuples = signedKeys.slice(start, start + 5_000)
        .map(key => { const [height, index] = key.split(':'); return `(${height},${index})` })
      const result = await client.query({
        query: `SELECT DISTINCT block_height, extrinsic_index
                FROM price_data.raw_xcm_activity
                WHERE (block_height, extrinsic_index) IN (${tuples.join(',')})
                  AND source_kind='event'
                  AND name IN ('XTokens.TransferredAssets','PolkadotXcm.Sent')`,
        format: 'JSONEachRow',
      })
      for (const row of await result.json<{ block_height: number; extrinsic_index: number | null }>()) {
        if (row.extrinsic_index != null) semanticExtrinsics.add(`${row.block_height}:${row.extrinsic_index}`)
      }
    }
  }

  // Incentive claims own their reward-pot transfer even though the semantic
  // evidence lives in the compact call model rather than an event.
  const incentiveKeys = transfers
    .filter(row => row.extrinsicIndex != null && row.from.accountId.toLowerCase() === INCENTIVES_REWARD_POT)
    .map(row => `${row.blockHeight}:${row.extrinsicIndex}`)
  for (let start = 0; start < incentiveKeys.length; start += 5_000) {
    const tuples = [...new Set(incentiveKeys.slice(start, start + 5_000))]
      .map(key => { const [height, index] = key.split(':'); return `(${height},${index})` })
    const result = await client.query({
      query: `SELECT DISTINCT block_height, extrinsic_index
              FROM price_data.incentive_claim_calls
              WHERE (block_height, extrinsic_index) IN (${tuples.join(',')})`,
      format: 'JSONEachRow',
    })
    for (const row of await result.json<{ block_height: number; extrinsic_index: number }>()) {
      semanticExtrinsics.add(`${row.block_height}:${row.extrinsic_index}`)
    }
  }

  return transfers.filter(row => {
    if (row.extrinsicIndex != null) return !semanticExtrinsics.has(`${row.blockHeight}:${row.extrinsicIndex}`)
    const owners = hookAccounts.get(row.blockHeight)
    return !owners || (!owners.has(row.from.accountId.toLowerCase()) && !owners.has(row.to.accountId.toLowerCase()))
  })
}

const INCENTIVES_REWARD_POT = '0x45544800112c208b900bcfc9ff8131d0f45769cb6c7c7d8d0000000000000000'

// Reward claims whose payout is otherwise indistinguishable from an ordinary
// transfer.  The raw event tables already contain enough historical evidence,
// so this works immediately without an indexer backfill:
//   - Referrals.Claimed owns its HDX payout;
//   - the incentives controller claim call owns each reward-asset payout.
async function getRecentRewardClaims(limit: number, from?: string, to?: string, accounts?: string[], assetIds?: number[], height?: number, extrinsicIndex?: number, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  if (assetIds != null && !assetIds.length) return []
  const prices = await ensurePrices()
  const tw = timeWindow(from, to)
  const rawBound = height != null
    ? `block_height = {height:UInt32}${extrinsicIndex != null ? ' AND extrinsic_index = {extrinsicIndex:UInt32}' : ''}`
    : (tw ?? '1')
  const accountList = accounts?.length ? sqlAccountList(accounts) : null
  const accountFilter = accountList ? `AND JSONExtractString(e.args_json,'who') IN (${accountList})` : ''
  const referralAssetFilter = assetIds != null && !assetIds.includes(0) ? 'AND 0' : ''
  const referralAmountExpr = `toString(toUInt256OrZero(JSONExtractString(e.args_json,'referrerRewards')) + toUInt256OrZero(JSONExtractString(e.args_json,'tradeRewards')))`
  const referralValueFilter = eventValueFilterSql('0', referralAmountExpr, 'e.block_timestamp', filters, prices, 'referral_claim_price')
  const referralRes = await client.query({
    query: `SELECT e.block_height, toString(e.block_timestamp) AS ts, e.event_index, e.extrinsic_index, e.args_json
            FROM (
              SELECT block_height, block_timestamp, event_index, extrinsic_index, event_name, args_json
              FROM price_data.referral_claim_activity FINAL
              WHERE ${rawBound}
            ) AS e
            ${referralValueFilter.joinSql}
            WHERE e.event_name = 'Referrals.Claimed'
              ${accountFilter} ${referralAssetFilter} ${referralValueFilter.predicateSql}
            ORDER BY e.block_height DESC, e.event_index DESC LIMIT {limit:UInt32}`,
    query_params: { limit, height: height ?? 0, extrinsicIndex: extrinsicIndex ?? 0 }, format: 'JSONEachRow',
  })
  const out: ActivityRow[] = []
  for (const r of await referralRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; args_json: string }>()) {
    const args = (safeJson(r.args_json) ?? {}) as Record<string, unknown>
    const who = argStr(args, 'who')
    const amount = (BigInt(argStr(args, 'referrerRewards') || '0') + BigInt(argStr(args, 'tradeRewards') || '0')).toString()
    const a = asset(0)
    out.push({
      type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
      who: who ? accountRef(who) : null, to: null, asset: a, assetIn: null, assetOut: null,
      amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
      liqAction: 'Claim', linkBlock: r.block_height, linkIndex: r.extrinsic_index,
    })
  }

  const transferAssetExpr = `if(e.event_name = 'Balances.Transfer', 0, ${currencyIdSql('e.args_json')})`
  const incentiveAccountFilter = accountList ? `AND JSONExtractString(e.args_json,'to') IN (${accountList})` : ''
  const incentiveAssetFilter = assetIds != null ? `AND ${transferAssetExpr} IN (${assetIds.join(',')})` : ''
  const incentiveValueFilter = eventValueFilterSql(transferAssetExpr, `JSONExtractString(e.args_json,'amount')`, 'e.block_timestamp', filters, prices, 'incentive_claim_price')
  type IncentiveTransfer = RawTransferEventRow & { call_address: string }
  const fetchIncentiveCandidates = async (candidateBound: string, pageLimit: number): Promise<IncentiveTransfer[]> => {
    const res = await client.query({
      query: `SELECT e.block_height, toString(e.block_timestamp) AS ts, e.event_index, e.extrinsic_index, e.event_name, ifNull(e.call_address,'') AS call_address,
                JSONExtractString(e.args_json,'from') AS from_acc,
                JSONExtractString(e.args_json,'to') AS to_acc,
                JSONExtractString(e.args_json,'amount') AS amount,
                ${transferAssetExpr} AS asset_id
              FROM (
                SELECT block_height, block_timestamp, event_index, extrinsic_index, event_name, call_address, args_json
                FROM price_data.incentive_reward_transfers FINAL
                WHERE ${candidateBound}
              ) AS e
              ${incentiveValueFilter.joinSql}
              WHERE e.event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')
                AND JSONExtractString(e.args_json,'from') = '${INCENTIVES_REWARD_POT}'
                ${incentiveAccountFilter} ${incentiveAssetFilter} ${incentiveValueFilter.predicateSql}
              ORDER BY e.block_height DESC, e.event_index DESC LIMIT {candidateLimit:UInt32}`,
      query_params: { candidateLimit: pageLimit, height: height ?? 0, extrinsicIndex: extrinsicIndex ?? 0 }, format: 'JSONEachRow',
    })
    return res.json<IncentiveTransfer>()
  }

  // Search the compressed call payload only after the reward-pot transfers have
  // supplied exact primary-key tuples. Sparse/old claims keep full-history
  // semantics by walking candidate pages rather than scanning raw_calls at once.
  const confirmIncentiveCandidates = async (candidates: IncentiveTransfer[]): Promise<IncentiveTransfer[]> => {
    const candidateTuples = [...new Set(candidates
      .filter(r => r.extrinsic_index != null)
      .map(r => `(${r.block_height},${r.extrinsic_index},'${r.call_address.replaceAll("'", "''")}')`))]
    const confirmedCalls = new Set<string>()
    for (let start = 0; start < candidateTuples.length; start += 5000) {
      const callRes = await client.query({
        query: `SELECT block_height, extrinsic_index, call_address
                FROM price_data.incentive_claim_calls FINAL
                PREWHERE (block_height, ifNull(extrinsic_index, 4294967295), call_address) IN (${candidateTuples.slice(start, start + 5000).join(',')})`,
        format: 'JSONEachRow',
      })
      for (const c of await callRes.json<{ block_height: number; extrinsic_index: number; call_address: string }>()) confirmedCalls.add(`${c.block_height}:${c.extrinsic_index}:${c.call_address}`)
    }
    return dedupeTransferEvents(candidates.filter(r => r.extrinsic_index != null && confirmedCalls.has(`${r.block_height}:${r.extrinsic_index}:${r.call_address}`)))
  }

  let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
  const confirmed = await fetchFilteredDeep(height != null ? rawBound : tw, limit, async (candidateBound, pageLimit) => {
    const candidates = await fetchIncentiveCandidates(candidateBound, pageLimit)
    const last = candidates.at(-1)
    pageState = {
      scanned: candidates.length,
      cursor: last ? { blockHeight: last.block_height, eventIndex: last.event_index } : null,
    }
    return confirmIncentiveCandidates(candidates)
  }, () => true, r => r.block_height, r => r.event_index,
  r => `${r.block_height}:${r.event_index}`, { pageState: () => pageState })
  const rawIncentives = confirmed.slice(0, limit)
  for (const r of rawIncentives) {
    if (!r.to_acc || !r.amount) continue
    const a = asset(r.asset_id)
    out.push({
      type: 'mm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
      who: accountRef(r.to_acc), to: null, asset: a, assetIn: null, assetOut: null,
      amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
      mmAction: 'ClaimRewards', linkBlock: r.block_height, linkIndex: r.extrinsic_index,
    })
  }
  return out.sort((a, b) => b.blockHeight - a.blockHeight || (b.eventIndex ?? 0) - (a.eventIndex ?? 0)).slice(0, limit)
}

async function getRecentDcaFailures(limit: number, from?: string, to?: string, accounts?: string[], assetIds?: number[], height?: number): Promise<ActivityRow[]> {
  if (assetIds != null && !assetIds.length) return []
  const accountFilter = accounts?.length ? `AND e.who IN (${sqlAccountList(accounts)})` : ''
  const assetFilter = assetIds != null
    ? `AND (s.asset_in IN (${assetIds.join(',')}) OR s.asset_out IN (${assetIds.join(',')}))`
    : ''
  const bound = height != null
    ? `e.block_height = {height:UInt32}`
    : (timeWindow(from, to)?.replaceAll('block_timestamp', 'e.block_timestamp') ?? '1')
  const res = await client.query({
    query: `SELECT e.block_height, toString(e.block_timestamp) AS ts, e.event_index,
              e.who, toString(e.id) AS id,
              toNullable(s.asset_in) AS asset_in, toNullable(s.asset_out) AS asset_out,
              ifNull(s.amount_per, '') AS amount_in,
              s.block_height AS schedule_block, s.extrinsic_index AS schedule_index,
              '' AS error
            FROM price_data.dca_events AS e FINAL
            LEFT JOIN price_data.dca_schedules s ON s.id = e.id
            WHERE ${bound} AND e.event_name = 'DCA.TradeFailed'
              ${accountFilter} ${assetFilter}
            ORDER BY e.block_height DESC, e.event_index DESC
            LIMIT {limit:UInt32}`,
    query_params: { limit, height: height ?? 0 }, format: 'JSONEachRow',
  })
  const rows = await res.json<{ block_height: number; ts: string; event_index: number; who: string; id: string; asset_in: number | null; asset_out: number | null; amount_in: string; schedule_block: number; schedule_index: number | null; error: string }>()
  // dca_events intentionally stays narrow; fetch error detail only for the
  // bounded page instead of JSON-decoding every historical failure in raw_events.
  const keys = rows.map(row => `(${row.block_height},${row.event_index})`)
  const errors = new Map<string, string>()
  if (keys.length) {
    const errorRes = await client.query({
      query: `SELECT block_height, event_index, JSONExtractRaw(args_json, 'error') AS error
              FROM price_data.raw_events
              WHERE (block_height, event_index) IN (${keys.join(',')}) AND event_name='DCA.TradeFailed'`,
      format: 'JSONEachRow',
    })
    for (const row of await errorRes.json<{ block_height: number; event_index: number; error: string }>()) {
      errors.set(`${row.block_height}:${row.event_index}`, row.error)
    }
  }
  return rows.map(r => ({
    type: 'trade' as const,
    blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: null,
    who: r.who && ACCOUNT_RE.test(r.who) ? accountRef(r.who) : null, to: null, asset: null,
    assetIn: r.asset_in != null ? asset(r.asset_in) : null,
    assetOut: r.asset_out != null ? asset(r.asset_out) : null,
    amount: null, amountIn: r.amount_in || null, amountOut: null, valueUsd: null,
    dca: true, dcaStatus: 'failed' as const, dcaError: errors.get(`${r.block_height}:${r.event_index}`) || undefined,
    dcaScheduleId: Number(r.id) || undefined,
    linkBlock: r.schedule_block || r.block_height, linkIndex: r.schedule_index,
  }))
}

// single-assignment activity classification
// Every on-chain activity lands in exactly ONE activity category. Precedence:
// trades/staking/mm own their extrinsics' transfer legs (dropped from
// Transfers); liquidity owns share-asset trade legs (routing into/out of a pool
// share inside an add/remove is mechanics, not a trade); module-account rows
// are protocol internals, not user activity.
const isShareAssetId = (id: number) => displayAssetId(id) !== id || asset(id).symbol.includes('-Pool')
function dropShareRoutedTrades<T extends { blockHeight: number; extrinsicIndex: number | null; assetIn: AssetRef | null; assetOut: AssetRef | null }>(trades: T[], liquidityExtrinsics: Set<string>): T[] {
  return trades.filter(t => !(t.extrinsicIndex != null && liquidityExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)
    && ((t.assetIn && isShareAssetId(t.assetIn.assetId)) || (t.assetOut && isShareAssetId(t.assetOut.assetId)))))
}
async function liquidityExtrinsicsForShareTrades(trades: TradeRow[]): Promise<Set<string>> {
  const tuples = [...new Set(trades
    .filter(t => t.extrinsicIndex != null && ((t.assetIn && isShareAssetId(t.assetIn.assetId)) || (t.assetOut && isShareAssetId(t.assetOut.assetId))))
    .map(t => `(${t.blockHeight},${t.extrinsicIndex})`))]
  if (!tuples.length) return new Set()
  const out = new Set<string>()
  for (let start = 0; start < tuples.length; start += 5_000) {
    const res = await client.query({
      query: `SELECT DISTINCT block_height, extrinsic_index
              FROM price_data.raw_events
              WHERE (block_height, extrinsic_index) IN (${tuples.slice(start, start + 5_000).join(',')})
                AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})`,
      format: 'JSONEachRow',
    })
    for (const row of await res.json<{ block_height: number; extrinsic_index: number }>()) out.add(`${row.block_height}:${row.extrinsic_index}`)
  }
  return out
}
// 'dca' is categorized under the Trade chip (rows keep their dca flag for the badge).
function normalizeActivityTypeKey(type: string): string { return type === 'dca' ? 'trade' : type }
// OTC is categorized under the Trade chip: a requested `type=trade` also matches otc
// rows (still tagged `type: 'otc'` — they keep their own badges/slugs/detail
// pages, only the categorization/filter changes). `type=otc` still selects
// only otc rows (kept working as an API nicety; the UI never sends it).
export function activityTypeMatchesFamily(rowType: ActivityRow['type'], type: string): boolean {
  return rowType === type || (type === 'trade' && rowType === 'otc')
}
// Per-category action filter (the sub-type select next to the chips).
export function activityRowMatchesAction(r: ActivityRow, action?: string): boolean {
  if (!action) return true
  switch (r.type) {
    case 'trade': return action === 'dca-failed' ? r.dcaStatus === 'failed' : action === 'dca' ? r.dca === true : action === 'swap' ? !r.dca : false
    case 'otc': return r.otcAction === resolveOtcAction(action)
    case 'mm': return r.mmAction === action
    case 'staking': return r.stakingAction === action
    case 'liquidity': return r.liqAction === action
    case 'vote': return (r.voteSide ?? '') === action
    case 'xcm': return (r.xcmDir ?? 'out') === action
    default: return true
  }
}
// Unified Activity feed. `type` selects a single category server-side (so the UI
// chips paginate correctly through that category) or 'all' for the merged feed.
export async function getRecentActivity(limit: number, from?: string, to?: string, offset = 0, type = 'all', filters: ValueListFilters = {}, action?: string): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  type = normalizeActivityTypeKey(type)
  return cached(`explorer:activity:${type}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}:${action ?? ''}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const want = offset + limit
    const classified = type === 'all' || type === 'trade' || type === 'transfer'
    // Categories assembled from multiple sources page only after merging, so
    // every source must cover the requested offset as well as the page size.
    const locallyMerged = classified || !!action || type === 'xcm' || type === 'liquidity' || type === 'mm'
    let fetchN = locallyMerged
      ? Math.max(want * 5, limit + 50)
      : Math.max(limit * 5, limit + 50)
    const toTransferRow = (t: TransferRow): ActivityRow => ({
      type: 'transfer', blockHeight: t.blockHeight, timestamp: t.timestamp, eventIndex: t.eventIndex, extrinsicIndex: t.extrinsicIndex,
      who: t.from, to: t.to, asset: t.asset, assetIn: null, assetOut: null, amount: t.amount, amountIn: null, amountOut: null, valueUsd: t.valueUsd,
    })
    const toTradeRow = (t: TradeRow): ActivityRow => ({
      type: 'trade', blockHeight: t.blockHeight, timestamp: t.timestamp, eventIndex: t.eventIndex, extrinsicIndex: t.extrinsicIndex,
      who: t.who, to: null, asset: null, assetIn: t.assetIn, assetOut: t.assetOut, amount: null, amountIn: t.amountIn, amountOut: t.amountOut, valueUsd: t.valueUsd,
      dca: t.dca, linkBlock: t.linkBlock, linkIndex: t.linkIndex,
    })
    const toVoteRow = (v: VoteRow): ActivityRow => ({
      type: 'vote', blockHeight: v.blockHeight, timestamp: v.timestamp, eventIndex: v.eventIndex, extrinsicIndex: v.extrinsicIndex,
      who: v.account, to: null, asset: v.asset, assetIn: null, assetOut: null, amount: v.amount, amountIn: null, amountOut: null, valueUsd: v.valueUsd,
      votePallet: v.pallet, voteAction: v.action, voteRef: v.referendum, voteSide: v.side, voteConviction: v.conviction,
      linkBlock: v.blockHeight, linkIndex: v.extrinsicIndex,
    })

    let rows: ActivityRow[]
    let locallyPaged = classified
    let sourceSaturated = false
    let plumbingApplied = false
    const otcOnlyAction = type === 'trade' && !!resolveOtcAction(action) && !!OTC_ACTION_EVENTS[resolveOtcAction(action)!]
    if (type === 'trade' && action === 'dca-failed') {
      // Failed executions are a self-contained indexed DCA family.  Routing this
      // action through the shared Trade classifier also paged swaps and OTC rows
      // that can never match it, turning a small failure page into a multi-source
      // full-history search.
      rows = (await getRecentDcaFailures(want, from, to, undefined, assetIdsForToken(filters.token)))
        .slice(offset, want)
      locallyPaged = false
    } else if (otcOnlyAction) {
      // OTC actions are already exact, independently pageable event families.
      // Sending them through the shared Trade classifier widens the unrelated
      // swap source forever because no swap can satisfy an otc-* action.
      rows = await getRecentOtc(limit, from, to, offset, filters, action)
      locallyPaged = false
    } else if (type === 'transfer') {
      // Pull only transfer candidates, then resolve semantic ownership by their
      // exact identities. Widening the swap/liquidity/XCM/etc. feeds alongside
      // a sparse transfer filter made a 25-row page enumerate >100k unrelated
      // rows and could never complete under the ClickHouse result guard.
      const deferredValueFilter = filters.min != null && filters.unit !== 'token'
      const sourceFilters = deferredValueFilter ? { ...filters, min: undefined, unit: undefined } : filters
      for (;;) {
        const transfers = await getRecentTransfers(fetchN, from, to, 0, true, sourceFilters)
        const classifiedTransfers = await suppressTransferCandidates(transfers)
        rows = await suppressDustTransferRows(classifiedTransfers.map(toTransferRow))
        plumbingApplied = true
        sourceSaturated = transfers.length >= fetchN
        if (deferredValueFilter && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
        const visibleRows = rows
          .filter(row => activityRowMatchesFilters(row, filters) && activityRowMatchesAction(row, action))
          .sort((left, right) => right.blockHeight - left.blockHeight || (right.eventIndex ?? -1) - (left.eventIndex ?? -1))
        const cutoff = completeActivityPageCutoff(visibleRows, want)
        const oldest = transfers.reduce<{ blockHeight: number; eventIndex: number } | null>((current, row) => {
          const candidate = { blockHeight: row.blockHeight, eventIndex: row.eventIndex }
          return current == null || candidate.blockHeight < current.blockHeight ||
            (candidate.blockHeight === current.blockHeight && candidate.eventIndex < current.eventIndex)
            ? candidate : current
        }, null)
        const complete = cutoff
          ? activitySourceCoversCutoff(transfers.length, fetchN, oldest, cutoff)
          : transfers.length < fetchN
        if (complete) break
        if (fetchN >= MAX_ACTIVITY_SOURCE_ROWS) throw activityQueryTooBroad()
        fetchN = Math.min(fetchN * 4, MAX_ACTIVITY_SOURCE_ROWS)
      }
    } else if (classified) {
      // Transfers, trades and the merged feed share ONE classification pass so a
      // row never appears in a category the merged feed assigned elsewhere.
      // The Trade-only view needs liquidity context to reject share-token router
      // legs, plus DCA/OTC rows, but it cannot display transfers, rewards, MM,
      // XCM, staking or votes. Avoid that unrelated fan-out on its hot path.
      const needsFullClassification = type !== 'trade'
      // Historical-price ASOF joins make a sparse minimum-value query scan the
      // entire raw table before LIMIT can help. Fetch recent candidates without
      // the threshold, value them in batches, and widen only sources that have
      // not yet produced a complete page of qualifying rows.
      // Asset-keyed swap reads can apply the exact event-time USD predicate
      // before LIMIT more cheaply than repeatedly widening a sparse candidate
      // window. Other activity families still defer USD filtering until their
      // bounded candidates have been classified and valued below.
      const deferredValueFilter = filters.min != null
        && filters.unit !== 'token'
        && !(type === 'trade' && filters.token)
      // A four-figure USD floor is sparse enough that the cheap unfiltered
      // probe cannot normally fill a page; go straight to bounded exact source
      // reads. Lower/default floors retain the recent probe, which usually wins.
      const directExactValueFilter = deferredValueFilter && filters.min! >= 1_000
      let sourceValueFiltered = directExactValueFilter
      let sourceFilters = sourceValueFiltered
        ? filters
        : deferredValueFilter ? { ...filters, min: undefined, unit: undefined } : filters
      type ClassifiedSourceKey = 'transfer' | 'trade' | 'dca' | 'reward' | 'liquidity' | 'mm' | 'otc' | 'xcm' | 'xcmIn' | 'xcmOutRemote' | 'staking' | 'vote'
      const classifiedSourceKeys: ClassifiedSourceKey[] = [
        'transfer', 'trade', 'dca', 'reward', 'liquidity', 'mm', 'otc',
        'xcm', 'xcmIn', 'xcmOutRemote', 'staking', 'vote',
      ]
      const exactSeedSize = activitySourceSeedSize(want)
      const exactSourceLimits = Object.fromEntries(classifiedSourceKeys.map(key => [key, sourceValueFiltered ? exactSeedSize : fetchN])) as Record<ClassifiedSourceKey, number>
      const exactSourceCache = new Map<ClassifiedSourceKey, unknown[]>()
      let exactSourceFrom = from
      const loadClassifiedSource = <T>(
        key: ClassifiedSourceKey,
        load: (sourceLimit: number, sourceFrom: string | undefined) => Promise<T[]>,
      ): Promise<T[]> => {
        if (!sourceValueFiltered) return load(fetchN, from)
        const previous = exactSourceCache.get(key)
        if (previous) return Promise.resolve(previous as T[])
        return load(exactSourceLimits[key], exactSourceFrom).then(sourceRows => {
          exactSourceCache.set(key, sourceRows)
          return sourceRows
        })
      }
      for (;;) {
        const [transfers, trades, dcaFailures, rewards, liquidity, mm, otc, xcm, xcmIn, xcmOutRemote, staking, votes] = await Promise.all([
          needsFullClassification
            ? loadClassifiedSource('transfer', (sourceLimit, sourceFrom) => getRecentTransfers(sourceLimit, sourceFrom, to, 0, true, sourceFilters))
            : Promise.resolve([]),
          loadClassifiedSource('trade', (sourceLimit, sourceFrom) => getRecentTrades(sourceLimit, sourceFrom, to, 0, sourceFilters)),
          // Failed schedules have no executed USD value and cannot survive a
          // USD minimum. Do not widen their error-payload lookup alongside a
          // sparse qualifying-swap walk (that used to reopen millions of raw
          // rows for candidates guaranteed to be filtered out).
          deferredValueFilter
            ? Promise.resolve([])
            : loadClassifiedSource('dca', (sourceLimit, sourceFrom) => getRecentDcaFailures(sourceLimit, sourceFrom, to, undefined, assetIdsForToken(filters.token))),
          needsFullClassification
            ? loadClassifiedSource('reward', (sourceLimit, sourceFrom) => getRecentRewardClaims(sourceLimit, sourceFrom, to, undefined, assetIdsForToken(filters.token)))
            : Promise.resolve([]),
          needsFullClassification
            ? loadClassifiedSource('liquidity', (sourceLimit, sourceFrom) => getRecentLiquidity(sourceLimit, sourceFrom, to, 0, sourceFilters))
            : Promise.resolve([]),
          needsFullClassification
            ? loadClassifiedSource('mm', (sourceLimit, sourceFrom) => getRecentMoneyMarket(sourceLimit, sourceFrom, to, 0, sourceFilters))
            : Promise.resolve([]),
          loadClassifiedSource('otc', (sourceLimit, sourceFrom) => getRecentOtc(sourceLimit, sourceFrom, to, 0, sourceFilters)),
          needsFullClassification
            ? loadClassifiedSource('xcm', (sourceLimit, sourceFrom) => getRecentXcm(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
            : Promise.resolve([]),
          needsFullClassification
            ? loadClassifiedSource('xcmIn', (sourceLimit, sourceFrom) => getRecentXcmIn(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
            : Promise.resolve([]),
          needsFullClassification
            ? loadClassifiedSource('xcmOutRemote', (sourceLimit, sourceFrom) => getRecentXcmOutRemote(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
            : Promise.resolve([]),
          needsFullClassification
            ? loadClassifiedSource('staking', (sourceLimit, sourceFrom) => getRecentStaking(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
            : Promise.resolve([]),
          needsFullClassification
            ? loadClassifiedSource('vote', (sourceLimit, sourceFrom) => getRecentVotes(sourceLimit, sourceFrom, to, 0, {}, undefined, sourceFilters))
            : Promise.resolve([]),
        ])
        const sourceFilteredTransfers = sourceValueFiltered
          ? await suppressTransferCandidates(transfers)
          : transfers
        const liquidityExtrinsics = needsFullClassification && !sourceValueFiltered
          ? activityExtrinsicSet(liquidity)
          : new Set([
              ...activityExtrinsicSet(liquidity),
              ...await liquidityExtrinsicsForShareTrades(trades),
            ])
        const userTrades = dropShareRoutedTrades(trades, liquidityExtrinsics)
        // Drop swap-internal transfer legs: any transfer in a trade's extrinsic, or
        // touching a pallet/pool account (hops, fees, referral pot). OTC fills
        // settle peer-to-peer (real Transfer events between taker/maker, unlike an
        // AMM swap's pool-internal Withdrawn/Deposited), so their extrinsics own
        // their transfer legs the same way trades/staking/mm do.
        const tradeExtrinsics = new Set(trades.filter(t => t.extrinsicIndex != null).map(t => `${t.blockHeight}:${t.extrinsicIndex}`))
        const stakingExtrinsics = activityExtrinsicSet(staking)
        const mmExtrinsics = activityExtrinsicSet(mm)
        const otcExtrinsics = activityExtrinsicSet(otc)
        const userTransfers = sourceFilteredTransfers.filter(t =>
          !(t.extrinsicIndex != null && tradeExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
          !(t.extrinsicIndex != null && stakingExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
          !(t.extrinsicIndex != null && mmExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
          !(t.extrinsicIndex != null && otcExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
          !isModuleAcct(t.from) && !isModuleAcct(t.to))
        // Module-account MM rows are pool-proxy internals, not user activity.
        const userMm = mm.filter(r => !isModuleAcct(r.who))
        type SourceCursor = { blockHeight: number; eventIndex: number }
        type SourcePage = { key: ClassifiedSourceKey; fetchSize: number; rawSize: number; rows: ActivityRow[]; oldest: SourceCursor | null; valueIrrelevant?: boolean }
        const oldestOf = <T extends { blockHeight: number; eventIndex?: number | null }>(source: T[]): SourceCursor | null => {
          let oldest: SourceCursor | null = null
          for (const row of source) {
            const candidate = { blockHeight: row.blockHeight, eventIndex: row.eventIndex ?? -1 }
            if (oldest == null || candidate.blockHeight < oldest.blockHeight ||
              (candidate.blockHeight === oldest.blockHeight && candidate.eventIndex < oldest.eventIndex)) oldest = candidate
          }
          return oldest
        }
        const sourceFetchSize = (key: ClassifiedSourceKey): number => sourceValueFiltered ? exactSourceLimits[key] : fetchN
        const allSources: SourcePage[] = [
          { key: 'transfer', fetchSize: sourceFetchSize('transfer'), rawSize: transfers.length, rows: userTransfers.map(toTransferRow), oldest: oldestOf(transfers) },
          { key: 'trade', fetchSize: sourceFetchSize('trade'), rawSize: trades.length, rows: userTrades.map(toTradeRow), oldest: oldestOf(trades) },
          // Failed DCA rows have no executed value and can never pass a minimum.
          { key: 'dca', fetchSize: sourceFetchSize('dca'), rawSize: dcaFailures.length, rows: dcaFailures, oldest: oldestOf(dcaFailures), valueIrrelevant: true },
          { key: 'reward', fetchSize: sourceFetchSize('reward'), rawSize: rewards.length, rows: rewards, oldest: oldestOf(rewards) },
          { key: 'liquidity', fetchSize: sourceFetchSize('liquidity'), rawSize: liquidity.length, rows: liquidity, oldest: oldestOf(liquidity) },
          { key: 'staking', fetchSize: sourceFetchSize('staking'), rawSize: staking.length, rows: staking, oldest: oldestOf(staking) },
          { key: 'vote', fetchSize: sourceFetchSize('vote'), rawSize: votes.length, rows: votes.map(toVoteRow), oldest: oldestOf(votes) },
          { key: 'mm', fetchSize: sourceFetchSize('mm'), rawSize: mm.length, rows: userMm, oldest: oldestOf(mm) },
          { key: 'otc', fetchSize: sourceFetchSize('otc'), rawSize: otc.length, rows: otc, oldest: oldestOf(otc) },
          { key: 'xcm', fetchSize: sourceFetchSize('xcm'), rawSize: xcm.length, rows: xcm, oldest: oldestOf(xcm) },
          { key: 'xcmIn', fetchSize: sourceFetchSize('xcmIn'), rawSize: xcmIn.length, rows: xcmIn, oldest: oldestOf(xcmIn) },
          { key: 'xcmOutRemote', fetchSize: sourceFetchSize('xcmOutRemote'), rawSize: xcmOutRemote.length, rows: xcmOutRemote, oldest: oldestOf(xcmOutRemote) },
        ]
        const sourcePages = type === 'trade'
          ? [allSources[1], allSources[2], allSources[8]]
          : type === 'transfer' ? [allSources[0]] : allSources
        sourceSaturated = sourcePages.some(source => source.rawSize >= source.fetchSize)
        // A transfer-only result still needs the other categories as
        // classification context. Otherwise the transfer leg of an LP action,
        // reward claim, vote, or XCM journey can reappear merely because the
        // caller selected `type=transfer`.
        const classificationPages = type === 'trade' ? sourcePages : allSources
        rows = await suppressActivityPlumbing(classificationPages.flatMap(source => source.rows))
        plumbingApplied = true
        if (type !== 'all') rows = rows.filter(r => activityTypeMatchesFamily(r.type, type))
        if (deferredValueFilter && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
        const visibleRows = rows.filter(r => activityRowMatchesFilters(r, filters) && activityRowMatchesAction(r, action))
          .sort((a, b) => b.blockHeight - a.blockHeight || (b.eventIndex ?? -1) - (a.eventIndex ?? -1))
        const cutoff = completeActivityPageCutoff(visibleRows, want)
        const coveragePages = type === 'transfer' ? allSources : sourcePages
        const incompletePages = activitySourcesNeedingMore(
          cutoff ? coveragePages : sourcePages,
          cutoff,
          deferredValueFilter,
        )
        const complete = incompletePages.length === 0
        if (complete) break
        // A low USD threshold usually completes from the first small unfiltered
        // window and avoids an ASOF join below every source LIMIT. A sparse
        // threshold is the opposite: repeatedly widening every family can cross
        // the client's 100k row guard before finding 25 qualifying rows. After
        // the first incomplete window, let each source apply its exact event-time
        // predicate and resolve transfer/share-token ownership only for those
        // bounded candidates. This retains complete-history classification while
        // avoiding an all-family raw-history walk.
        if (deferredValueFilter && !sourceValueFiltered) {
          sourceValueFiltered = true
          sourceFilters = filters
          // Start each exact source at a fraction of the merged target. The
          // common case fills the union from several activity families; sources
          // that have not crossed the resulting cutoff are deepened separately.
          fetchN = exactSeedSize
          for (const key of classifiedSourceKeys) exactSourceLimits[key] = fetchN
          exactSourceCache.clear()
          exactSourceFrom = from
          continue
        }
        if (sourceValueFiltered) {
          if (!incompletePages.length) throw activityQueryTooBroad()
          exactSourceFrom = cutoff ? activityCutoffFromDate(from, visibleRows, want) : from
          for (const source of incompletePages) {
            if (source.fetchSize >= MAX_ACTIVITY_SOURCE_ROWS) throw activityQueryTooBroad()
            exactSourceLimits[source.key] = Math.min(source.fetchSize * 4, MAX_ACTIVITY_SOURCE_ROWS)
            exactSourceCache.delete(source.key)
          }
          fetchN = Math.max(...Object.values(exactSourceLimits))
          continue
        }
        if (fetchN >= MAX_ACTIVITY_SOURCE_ROWS) throw activityQueryTooBroad()
        fetchN = Math.min(fetchN * 4, MAX_ACTIVITY_SOURCE_ROWS)
      }
    } else if (action) {
      // Sub-type filtering breaks SQL paging — fetch a window and page locally.
      locallyPaged = true
      if (type === 'liquidity') rows = [...await getRecentLiquidity(fetchN, from, to, 0, filters, action), ...(action === 'Claim' ? (await getRecentRewardClaims(fetchN, from, to, undefined, assetIdsForToken(filters.token))).filter(r => r.type === 'liquidity') : [])]
      else if (type === 'mm') rows = [...(await getRecentMoneyMarket(fetchN, from, to, 0, filters, action)).filter(r => !isModuleAcct(r.who)), ...(action === 'ClaimRewards' ? (await getRecentRewardClaims(fetchN, from, to, undefined, assetIdsForToken(filters.token))).filter(r => r.type === 'mm') : [])]
      else if (type === 'otc') rows = await getRecentOtc(fetchN, from, to, 0, filters, action)
      else if (type === 'xcm') rows = (await Promise.all([getRecentXcm(fetchN, from, to, undefined, 0, filters), getRecentXcmIn(fetchN, from, to, undefined, 0, filters), getRecentXcmOutRemote(fetchN, from, to, undefined, 0, filters)])).flat()
      else if (type === 'staking') rows = await getRecentStaking(fetchN, from, to, undefined, 0, filters, undefined, action)
      else rows = (await getRecentVotes(fetchN, from, to, 0, {}, undefined, filters)).map(toVoteRow)
    } else if (type === 'liquidity') {
      locallyPaged = true
      rows = [...await getRecentLiquidity(fetchN, from, to, 0, filters), ...(await getRecentRewardClaims(fetchN, from, to, undefined, assetIdsForToken(filters.token))).filter(r => r.type === 'liquidity')]
    } else if (type === 'mm') {
      locallyPaged = true
      rows = [...(await getRecentMoneyMarket(fetchN, from, to, 0, filters)).filter(r => !isModuleAcct(r.who)), ...(await getRecentRewardClaims(fetchN, from, to, undefined, assetIdsForToken(filters.token))).filter(r => r.type === 'mm')]
    } else if (type === 'otc') {
      rows = await getRecentOtc(limit, from, to, offset, filters)
    } else if (type === 'xcm') {
      locallyPaged = true
      rows = (await Promise.all([getRecentXcm(fetchN, from, to, undefined, 0, filters), getRecentXcmIn(fetchN, from, to, undefined, 0, filters), getRecentXcmOutRemote(fetchN, from, to, undefined, 0, filters)])).flat()
    } else if (type === 'staking') {
      rows = await getRecentStaking(limit, from, to, undefined, offset, filters)
    } else {
      rows = (await getRecentVotes(limit, from, to, offset, {}, undefined, filters)).map(toVoteRow)
    }
    if (locallyPaged && !classified) sourceSaturated = rows.length >= fetchN
    if (!plumbingApplied) rows = await suppressActivityPlumbing(rows)
    if (type !== 'all') rows = rows.filter(r => activityTypeMatchesFamily(r.type, type))
    if (filters.min != null && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
    rows = rows.filter(r => activityRowMatchesFilters(r, filters) && activityRowMatchesAction(r, action))
    rows.sort((a, b) => b.blockHeight - a.blockHeight || (b.eventIndex ?? -1) - (a.eventIndex ?? -1))
    if (locallyPaged && rows.length < want && sourceSaturated) throw activityQueryTooBroad()
    const sliceOffset = locallyPaged ? offset : 0
    const page = rows.slice(sliceOffset, sliceOffset + limit)
    await Promise.all([applyHistoricalUsd(page, activityHistPick), applyXcmJourneys(page)])
    return page
  })
}

// A DCA schedule is the canonical unit: initiation, lifecycle status, execution
// totals, and a paged execution list belong to the schedule page.
export interface DcaScheduleDetail {
  scheduleId: number
  who: AccountRef | null
  createdAt: { blockHeight: number; timestamp: string; extrinsicIndex: number | null }
  assetIn: AssetRef
  assetOut: AssetRef
  amountPer: string
  totalAmount: string
  period: number
  maxRetries: number
  status: 'active' | 'completed' | 'terminated' | 'cancelled'
  statusAt: string | null
  // Named DispatchError reason for hook (error) terminations, null when the
  // error is a metadata-indexed module error or the schedule wasn't terminated.
  statusReason: string | null
  executions: { count: number; failed: number; attempts: number; totalIn: string; totalOut: string }
  rows: ActivityRow[]
}
// Resolve a legacy per-execution DCA reference to its schedule. Extrinsic-form
// ids point at the SCHEDULING extrinsic; event-form ids carried the swap
// event's index, which sits a few events before the DCA.TradeExecuted row —
// nearest-in-block is unambiguous in practice (executions are sparse per block).
export async function getDcaScheduleIdAt(height: number, index: number, kind: 'event' | 'extrinsic'): Promise<number | null> {
  if (kind === 'extrinsic') {
    const res = await client.query({
      query: `SELECT toString(id) AS id FROM price_data.dca_schedules WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} LIMIT 1`,
      query_params: { h: height, i: index }, format: 'JSONEachRow',
    })
    const hit = (await res.json<{ id: string }>())[0]
    if (hit) return Number(hit.id)
  }
  const res = await client.query({
    query: `SELECT toString(id) AS id FROM price_data.dca_events
            WHERE block_height = {h:UInt32} AND event_name = 'DCA.TradeExecuted'
            ORDER BY abs(toInt64(event_index) - {i:Int64}) ASC LIMIT 1`,
    query_params: { h: height, i: index }, format: 'JSONEachRow',
  })
  const hit = (await res.json<{ id: string }>())[0]
  return hit ? Number(hit.id) : null
}

// A DCA.Terminated event from a signed extrinsic is the owner's own
// dca.terminate call ("cancelled"); one from a block hook is the pallet ending
// the schedule on an error ("terminated"). The previous latest-execution-event
// heuristic mislabelled error terminations that left a pending plan.
export function dcaScheduleStatus(
  terminated: boolean,
  completed: boolean,
  manualTerminate: boolean,
): DcaScheduleDetail['status'] {
  if (terminated) return manualTerminate ? 'cancelled' : 'terminated'
  return completed ? 'completed' : 'active'
}

// Human-readable termination reason for the named DispatchError kinds
// ("token frozen"). Module errors carry only a pallet index and error byte —
// naming them needs runtime metadata, so they are omitted rather than shown
// as opaque numbers.
export function dcaTerminationReason(errorJson: string | null | undefined): string | null {
  const err = (safeJson(errorJson ?? '') ?? null) as Record<string, unknown> | null
  const kind = typeof err?.__kind === 'string' ? err.__kind : null
  if (!kind || kind === 'Module') return null
  const value = err?.value as Record<string, unknown> | undefined
  const sub = typeof value?.__kind === 'string' ? value.__kind : null
  if (sub) return `${kind.toLowerCase()} ${sub.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`
  return kind === 'Other' ? 'runtime error' : kind.toLowerCase()
}

export async function getDcaSchedule(scheduleId: number, offset = 0, limit = 25): Promise<DcaScheduleDetail | null> {
  return cached(`explorer:dca-schedule:${scheduleId}:${offset}:${limit}`, 8000, async () => {
    const prices = await ensurePrices()
    const [schedRes, lifeRes, totalRes, exRes] = await Promise.all([
      client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, extrinsic_index, who, asset_in, asset_out,
                       toString(amount_per) AS amount_per, toString(total_amount) AS total_amount, period, max_retries
                FROM price_data.dca_schedules WHERE id = {sid:UInt64} ORDER BY block_height DESC LIMIT 1`,
        query_params: { sid: scheduleId }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT event_name, toString(max(block_timestamp)) AS ts,
                       argMax(block_height, block_timestamp) AS bh,
                       argMax(event_index, block_timestamp) AS ei,
                       argMax(ifNull(toInt64(extrinsic_index), -1), block_timestamp) AS xi
                FROM price_data.dca_events
                WHERE id = {sid:UInt64} AND event_name IN ('DCA.Completed','DCA.Terminated') GROUP BY event_name`,
        query_params: { sid: scheduleId }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT countIf(event_name = 'DCA.TradeExecuted') AS n,
                       countIf(event_name = 'DCA.TradeFailed') AS failed,
                       count() AS attempts,
                       toString(sumIf(toUInt256OrZero(amount_in), event_name = 'DCA.TradeExecuted')) AS tin,
                       toString(sumIf(toUInt256OrZero(amount_out), event_name = 'DCA.TradeExecuted')) AS tout
                FROM price_data.dca_events
                WHERE id = {sid:UInt64} AND event_name IN ('DCA.TradeExecuted','DCA.TradeFailed')`,
        query_params: { sid: scheduleId }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                       toString(amount_in) AS amount_in, toString(amount_out) AS amount_out
                FROM price_data.dca_events
                WHERE id = {sid:UInt64} AND event_name IN ('DCA.TradeExecuted','DCA.TradeFailed')
                ORDER BY block_height DESC, event_index DESC LIMIT {lim:UInt32} OFFSET {off:UInt32}`,
        query_params: { sid: scheduleId, lim: limit, off: offset }, format: 'JSONEachRow',
      }),
    ])
    const sched = (await schedRes.json<{ block_height: number; ts: string; extrinsic_index: number | null; who: string; asset_in: number; asset_out: number; amount_per: string; total_amount: string; period: number; max_retries: number }>())[0]
    if (!sched) return null
    const life = await lifeRes.json<{ event_name: string; ts: string; bh: number; ei: number; xi: number }>()
    const totals = (await totalRes.json<{ n: string; failed: string; attempts: string; tin: string; tout: string }>())[0]
    // Pre-router-era schedules recorded no order in the DCA.Scheduled event, so
    // dca_schedules stores assetIn=assetOut=0 — which renders as a nonsensical
    // HDX→HDX schedule. Recover the real traded pair from the first execution's
    // swap leg (same block + owner) when the stored order is empty.
    let aInId = sched.asset_in, aOutId = sched.asset_out
    if (aInId === 0 && aOutId === 0) {
      const swapRes = await client.query({
        query: `SELECT JSONExtractInt(args_json,'assetIn') AS ain, JSONExtractInt(args_json,'assetOut') AS aout
                FROM price_data.raw_events
                WHERE event_name IN ('Router.Executed','Router.RouteExecuted','Omnipool.SellExecuted','Omnipool.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted','LBP.SellExecuted','LBP.BuyExecuted')
                  AND block_height = (SELECT min(block_height) FROM price_data.dca_events WHERE id = {sid:UInt64} AND event_name = 'DCA.TradeExecuted')
                  AND JSONExtractString(args_json,'who') = {who:String}
                ORDER BY event_index ASC LIMIT 1`,
        query_params: { sid: scheduleId, who: sched.who }, format: 'JSONEachRow',
      })
      const sw = (await swapRes.json<{ ain: number; aout: number }>())[0]
      if (sw && (sw.ain || sw.aout)) { aInId = sw.ain; aOutId = sw.aout }
    }
    const aIn = asset(aInId), aOut = asset(aOutId)
    const terminated = life.find(l => l.event_name === 'DCA.Terminated')
    const completed = life.find(l => l.event_name === 'DCA.Completed')
    const executionRows = await exRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; amount_in: string; amount_out: string }>()
    const failedTuples = executionRows.filter(x => x.event_name === 'DCA.TradeFailed').map(x => `(${x.block_height},${x.event_index})`)
    const errors = new Map<string, string>()
    if (failedTuples.length) {
      const errorRes = await client.query({
        query: `SELECT block_height, event_index, JSONExtractRaw(args_json,'error') AS error
                FROM price_data.raw_events
                WHERE event_name = 'DCA.TradeFailed' AND (block_height,event_index) IN (${failedTuples.join(',')})`,
        format: 'JSONEachRow',
      })
      for (const e of await errorRes.json<{ block_height: number; event_index: number; error: string }>()) errors.set(`${e.block_height}:${e.event_index}`, e.error)
    }
    const rows: ActivityRow[] = executionRows.map(x => {
      const failed = x.event_name === 'DCA.TradeFailed'
      const amountIn = failed ? sched.amount_per : x.amount_in
      return {
        type: 'dca', blockHeight: x.block_height, timestamp: x.ts, eventIndex: x.event_index, extrinsicIndex: x.extrinsic_index,
        who: ACCOUNT_RE.test(sched.who) ? accountRef(sched.who) : null, to: null, asset: null, assetIn: aIn, assetOut: aOut,
        amount: null, amountIn, amountOut: failed ? null : x.amount_out,
        valueUsd: failed ? usdValue(prices, aIn.assetId, amountIn, aIn.decimals) : usdValue(prices, aOut.assetId, x.amount_out, aOut.decimals),
        dca: true, dcaStatus: failed ? 'failed' : undefined, dcaError: errors.get(`${x.block_height}:${x.event_index}`),
        dcaScheduleId: scheduleId, linkBlock: x.block_height, linkIndex: x.extrinsic_index,
      }
    })
    await applyHistoricalUsd(rows, activityHistPick)
    let statusReason: string | null = null
    if (terminated && Number(terminated.xi) < 0) {
      const errRes = await client.query({
        query: `SELECT JSONExtractRaw(args_json,'error') AS error FROM price_data.raw_events
                WHERE event_name = 'DCA.Terminated' AND block_height = {bh:UInt32} AND event_index = {ei:UInt32} LIMIT 1`,
        query_params: { bh: terminated.bh, ei: terminated.ei }, format: 'JSONEachRow',
      })
      statusReason = dcaTerminationReason((await errRes.json<{ error: string }>())[0]?.error)
    }
    return {
      scheduleId,
      who: ACCOUNT_RE.test(sched.who) ? accountRef(sched.who) : null,
      createdAt: { blockHeight: sched.block_height, timestamp: sched.ts, extrinsicIndex: sched.extrinsic_index },
      assetIn: aIn, assetOut: aOut,
      amountPer: sched.amount_per, totalAmount: sched.total_amount, period: sched.period, maxRetries: sched.max_retries,
      status: dcaScheduleStatus(!!terminated, !!completed, terminated != null && Number(terminated.xi) >= 0),
      statusAt: (terminated ?? completed)?.ts ?? null,
      statusReason,
      executions: {
        count: Number(totals?.n ?? 0), failed: Number(totals?.failed ?? 0), attempts: Number(totals?.attempts ?? 0),
        totalIn: totals?.tin ?? '0', totalOut: totals?.tout ?? '0',
      },
      rows,
    }
  })
}

export async function getExtrinsicActivity(height: number, index: number): Promise<ActivityRow[]> {
  return cached(`explorer:extrinsic-activity:${height}:${index}`, 10000, async () => {
    const prices = await ensurePrices()
    const evRes = await client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, ifNull(call_address, '') AS call_address, args_json
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32}
              ORDER BY event_index ASC`,
      query_params: { h: height, i: index },
      format: 'JSONEachRow',
    })
    const events = await evRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; call_address: string; args_json: string }>()
    if (!events.length) return []

    const signerMap = await signersFor([[height, index]])
    const signer = signerMap.get(`${height}:${index}`) ?? null
    const rows: ActivityRow[] = []
    const hdx = asset(0)

    const transferRows: RawTransferEventRow[] = []
    const withdrawnByAmount = new Map<string, number>()
    for (const e of events) {
      const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
      if (e.event_name === 'Balances.Transfer' || e.event_name === 'Tokens.Transfer' || e.event_name === 'Currencies.Transferred') {
        transferRows.push({
          block_height: e.block_height,
          ts: e.ts,
          event_index: e.event_index,
          extrinsic_index: e.extrinsic_index,
          event_name: e.event_name,
          from_acc: argStr(args, 'from'),
          to_acc: argStr(args, 'to'),
          amount: argStr(args, 'amount'),
          asset_id: e.event_name === 'Balances.Transfer' ? 0 : argInt(args, 'currencyId', 'currency_id', 'assetId', 'asset_id'),
        })
      }
      if (e.event_name === 'Currencies.Withdrawn') {
        withdrawnByAmount.set(argStr(args, 'amount'), argInt(args, 'currencyId', 'currency_id', 'assetId', 'asset_id'))
      }
    }

    const swapEvents = events.filter(e => SWAP_EVENTS.includes(e.event_name))
    const dcaExec = events.find(e => e.event_name === 'DCA.TradeExecuted')
    if (swapEvents.length) {
      const rep = swapEvents.find(e => isRouterNet(e.event_name)) ?? swapEvents[0]
      const args = (safeJson(rep.args_json) ?? {}) as Record<string, unknown>
      const aIn = asset(Number(args.assetIn ?? 0))
      const aOut = asset(Number(args.assetOut ?? 0))
      const dcaArgs = dcaExec ? (safeJson(dcaExec.args_json) ?? {}) as Record<string, unknown> : null
      rows.push({
        type: dcaExec ? 'dca' : 'trade',
        blockHeight: rep.block_height,
        timestamp: rep.ts,
        eventIndex: rep.event_index,
        extrinsicIndex: rep.extrinsic_index,
        who: dcaArgs && argStr(dcaArgs, 'who') ? accountRef(argStr(dcaArgs, 'who')) : signer ? accountRef(signer) : null,
        to: null,
        asset: null,
        assetIn: aIn,
        assetOut: aOut,
        amount: null,
        amountIn: argStr(dcaArgs ?? args, 'amountIn'),
        amountOut: argStr(dcaArgs ?? args, 'amountOut'),
        valueUsd: usdValue(prices, aOut.assetId, argStr(dcaArgs ?? args, 'amountOut'), aOut.decimals),
        dca: !!dcaExec,
        dcaScheduleId: dcaArgs ? Number(argStr(dcaArgs, 'id')) || undefined : undefined,
        linkBlock: rep.block_height,
        linkIndex: rep.extrinsic_index,
      })
    }

    // Outbound XCM in either shape; when an extrinsic emits both (XTokens routed
    // through pallet_xcm) the legacy event wins so the transfer isn't doubled.
    const xcmEvents = events.filter(e => e.event_name === 'XTokens.TransferredAssets' || e.event_name === 'PolkadotXcm.Sent')
    const xcmLegacyExts = new Set(xcmEvents.filter(e => e.event_name === 'XTokens.TransferredAssets').map(e => `${e.block_height}:${e.extrinsic_index}`))
    for (const e of xcmEvents) {
      if (e.event_name === 'PolkadotXcm.Sent' && xcmLegacyExts.has(`${e.block_height}:${e.extrinsic_index}`)) continue
      const parsed = parseOutboundXcm(safeJson(e.args_json))
      if (!parsed) continue
      for (const amount of parsed.amounts) {
        const cid = withdrawnByAmount.get(amount)
        if (cid == null) continue
        rows.push(outboundXcmRow(e, parsed.sender, cid, amount, parsed.dest, prices))
      }
    }

    // Manually-executed outbound XCM (PolkadotXcm.execute): the message leaves
    // via XcmpQueue.XcmpMessageSent with no Sent/TransferredAssets event, so
    // the user's withdrawal events are the only trace of what left. Emit them
    // as xcm-out rows (the arbitrary program isn't parsed — destination stays
    // unknown). Skipped when the extrinsic already produced trade/xcm rows.
    if (events.some(e => e.event_name === 'XcmpQueue.XcmpMessageSent') && !rows.some(r => r.type === 'xcm' || r.type === 'trade')) {
      const seenWd = new Set<string>()
      for (const e of events) {
        if (e.event_name !== 'Currencies.Withdrawn') continue
        const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
        const who = argStr(args, 'who')
        const amount = argStr(args, 'amount')
        const cid = argInt(args, 'currencyId', 'currency_id')
        if (!who || !amount || amount === '0' || RESERVED_ACCOUNT_RE.test(who)) continue
        const key = `${who}:${cid}:${amount}`
        if (seenWd.has(key)) continue
        seenWd.add(key)
        const a = asset(cid)
        rows.push({
          type: 'xcm', blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
          who: accountRef(who), to: null, asset: a, assetIn: null, assetOut: null,
          amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
          xcmDir: 'out', linkBlock: e.block_height, linkIndex: e.extrinsic_index,
        })
      }
    }

    const liqRows = events
      .filter(e => ['Omnipool.LiquidityAdded', 'Omnipool.LiquidityRemoved', 'Stableswap.LiquidityAdded', 'Stableswap.LiquidityRemoved', 'XYK.LiquidityAdded', 'XYK.LiquidityRemoved', 'XYK.PoolCreated', 'OmnipoolLiquidityMining.RewardClaimed', 'XYKLiquidityMining.RewardClaimed'].includes(e.event_name))
      .map(e => {
        const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
        return {
          block_height: e.block_height,
          extrinsic_index: e.extrinsic_index,
          event_name: e.event_name,
          who: argStr(args, 'who'),
          asset_id: Number(args.rewardCurrency ?? args.assetId ?? args.poolId ?? args.assetA ?? args.asset_id ?? 0),
          asset_b: Number(args.assetB ?? 0),
          pool_acc: argStr(args, 'pool'),
          amount: argStr(args, 'claimed') || argStr(args, 'amount') || argStr(args, 'shares'),
          ts: e.ts,
          event_index: e.event_index,
        }
      })
    await fillMissingLiquidityAmounts(liqRows)
    const createCands: { row: ActivityRow; pool: string; assetB: number }[] = []
    for (const r of liqRows) {
      const a = asset(r.asset_id)
      const row: ActivityRow = {
        type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
        who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
        amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
        liqAction: liqActionFor(r.event_name),
        linkBlock: r.block_height, linkIndex: r.extrinsic_index,
      }
      if (r.event_name === 'XYK.PoolCreated') createCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
      rows.push(row)
    }
    // Pool creations render both seed legs + their combined block-time value.
    await enrichPoolCreations(createCands)

    const stakingEvents = suppressGigaCompanionEvents(events.filter(e => STAKING_EVENT_NAMES.includes(e.event_name)))
    for (const e of stakingEvents) {
      const built = stakingRowFromEvent(e, prices, { signerFallback: signer })
      if (built) rows.push(built.row)
    }

    const voteEvents = events.filter(e => e.event_name === 'ConvictionVoting.Voted' || e.event_name === 'Democracy.Voted')
    const convictionCalls = new Map<string, { ref: string | null; details: VoteDetails }>()
    const convictionCallInfos: { ref: string | null; details: VoteDetails }[] = []
    if (voteEvents.some(e => e.event_name === 'ConvictionVoting.Voted')) {
      const calls = await client.query({
        query: `SELECT call_address, call_name, args_json
                FROM price_data.raw_calls
                WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32}
                  AND call_name IN ('ConvictionVoting.vote', 'MultiTransactionPayment.dispatch_permit', ${VOTE_WRAPPER_CALLS})`,
        query_params: { h: height, i: index },
        format: 'JSONEachRow',
      })
      const callRows = await calls.json<{ call_address: string; call_name: string; args_json: string }>()
      for (const c of callRows) {
        const args = (safeJson(c.args_json) ?? {}) as Record<string, unknown>
        // Gasless votes: the vote call hides SCALE-encoded in the permit payload.
        const info = c.call_name === 'MultiTransactionPayment.dispatch_permit'
          ? voteFromPermitData(args.data)
          : c.call_name === 'ConvictionVoting.vote'
            ? (() => { const ref = argStr(args, 'pollIndex'); return ref ? { ref, details: voteDetails(args) } : null })()
            : null
        if (!info) continue
        convictionCalls.set(c.call_address, info)
        convictionCallInfos.push(info)
      }
      // Wrapper fallback for votes whose nested call row is unavailable.
      if (!convictionCallInfos.length) {
        for (const c of callRows) {
          if (c.call_name === 'ConvictionVoting.vote' || c.call_name === 'MultiTransactionPayment.dispatch_permit') continue
          convictionCallInfos.push(...nestedVoteInfos(safeJson(c.args_json)))
        }
      }
    }
    for (const e of voteEvents) {
      const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
      const account = argStr(args, e.event_name === 'Democracy.Voted' ? 'voter' : 'who')
      const onlyCall = convictionCallInfos.length === 1 ? convictionCallInfos[0] : undefined
      const callInfo = e.event_name === 'ConvictionVoting.Voted' ? (convictionCalls.get(e.call_address) ?? onlyCall) : undefined
      const details = mergeVoteDetails(voteDetails(args), callInfo?.details)
      rows.push({
        type: 'vote', blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
        who: account && ACCOUNT_RE.test(account) ? accountRef(account) : null, to: null,
        asset: hdx, assetIn: null, assetOut: null, amount: details.amount, amountIn: null, amountOut: null,
        valueUsd: details.amount ? usdValue(prices, hdx.assetId, details.amount, hdx.decimals) : null,
        votePallet: e.event_name.split('.')[0], voteAction: 'Voted',
        voteRef: e.event_name === 'Democracy.Voted' ? argStr(args, 'refIndex') || null : callInfo?.ref ?? null,
        voteSide: details.side, voteConviction: details.conviction,
        linkBlock: e.block_height, linkIndex: e.extrinsic_index,
      })
    }

    const eventIndices = events.map(e => e.event_index).join(',')
    if (eventIndices) {
      const mmRes = await client.query({
        query: `SELECT block_height, event_index, toString(block_timestamp) AS ts, event_name, account_id, asset_address, pool_address,
                  if(event_name='LiquidationCall', JSONExtractString(decoded_args_json,'liquidatedCollateralAmount'), amount) AS amount
                FROM price_data.raw_money_market_events
                WHERE block_height = {h:UInt32}
                  AND event_index IN (${eventIndices})
                  AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})
                  AND event_name IN ('Supply','Borrow','Repay','Withdraw','LiquidationCall')`,
        query_params: { h: height },
        format: 'JSONEachRow',
      })
      for (const r of await mmRes.json<{ block_height: number; event_index: number; ts: string; event_name: string; account_id: string | null; asset_address: string; pool_address: string | null; amount: string }>()) {
        const aid = assetIdFromMmAddress(r.asset_address)
        const a = aid != null ? asset(aid) : null
        rows.push({
          type: 'mm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: index,
          who: r.account_id ? accountRef(r.account_id) : null, to: null, asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null,
          valueUsd: a ? usdValue(prices, a.assetId, r.amount, a.decimals) : null,
          mmAction: r.event_name, ...moneyMarketActivityFields(r.pool_address), linkBlock: r.block_height, linkIndex: index,
        })
      }
    }

    // OTC place/pull/fill. No separate hook variant is needed here —
    // getBlockHookActivity covers the historical hook-context Placed/Cancelled
    // events (extrinsic_index NULL); Filled/PartiallyFilled always carry an
    // extrinsic_index, so every fill is covered by this per-extrinsic path.
    const otcEvents = events.filter(e => OTC_EVENT_NAMES.includes(e.event_name))
    if (otcEvents.length) {
      const lookupIds = otcEvents.filter(e => e.event_name !== 'OTC.Placed')
        .map(e => argInt((safeJson(e.args_json) ?? {}) as Record<string, unknown>, 'orderId'))
      const placedById = await getOtcPlacedLegsByOrderId(lookupIds)
      for (const e of otcEvents) {
        const row = otcRowFromEvent(e, prices, placedById, { signerFallback: signer })
        if (row) rows.push(row)
      }
    }
    // A Fill settles peer-to-peer (real Transfer legs between taker and maker),
    // unlike an AMM swap's pool-internal Withdrawn/Deposited — so its legs must
    // be dropped here too, the same way module-account legs already are, or
    // every fill would double as spurious transfer rows.
    const hasOtcFill = otcEvents.some(e => e.event_name === 'OTC.Filled' || e.event_name === 'OTC.PartiallyFilled')

    const semanticExtrinsic = rows.length > 0
    const createdPools = new Set(liqRows.filter(r => r.event_name === 'XYK.PoolCreated').map(r => r.pool_acc).filter(Boolean))
    const pools = ammPoolAccounts()
    const mmReserves = await mmReserveAccountIds()
    for (const t of dedupeTransferEvents(transferRows)) {
      if (!t.from_acc || !t.to_acc || !t.amount) continue
      const moduleLeg = /^0x(6d6f646c|7369626c|70617261|506172656e74)/.test(t.from_acc) || /^0x(6d6f646c|7369626c|70617261|506172656e74)/.test(t.to_acc)
      const poolLeg = pools.has(t.from_acc.toLowerCase()) || pools.has(t.to_acc.toLowerCase())
        || mmReserves.has(t.from_acc.toLowerCase()) || mmReserves.has(t.to_acc.toLowerCase())
      if (semanticExtrinsic && (moduleLeg || poolLeg || hasOtcFill || createdPools.has(t.to_acc) || createdPools.has(t.from_acc))) continue
      const a = asset(t.asset_id)
      rows.push({
        type: 'transfer', blockHeight: t.block_height, timestamp: t.ts, eventIndex: t.event_index, extrinsicIndex: t.extrinsic_index,
        who: accountRef(t.from_acc), to: accountRef(t.to_acc), asset: a, assetIn: null, assetOut: null,
        amount: t.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, t.amount, a.decimals),
        linkBlock: t.block_height, linkIndex: t.extrinsic_index,
      })
    }

    // A DCA-scheduling extrinsic performs no trades itself — surface the
    // executions its schedule has performed so far (newest first, capped: a
    // long-running schedule can have tens of thousands), each linking to its
    // own execution block.
    for (const e of events.filter(ev => ev.event_name === 'DCA.Scheduled')) {
      const sArgs = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
      const scheduleId = Number(sArgs.id)
      if (!Number.isFinite(scheduleId)) continue
      const order = (sArgs.order ?? {}) as Record<string, unknown>
      const aIn = asset(Number(order.assetIn ?? 0))
      const aOut = asset(Number(order.assetOut ?? 0))
      const owner = typeof sArgs.who === 'string' ? sArgs.who : signer
      const exRes = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index,
                       toString(amount_in) AS amount_in, toString(amount_out) AS amount_out
                FROM price_data.dca_events
                WHERE id = {sid:UInt64} AND event_name = 'DCA.TradeExecuted'
                ORDER BY block_height DESC, event_index DESC LIMIT 50`,
        query_params: { sid: scheduleId }, format: 'JSONEachRow',
      })
      for (const x of await exRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; amount_in: string; amount_out: string }>()) {
        rows.push({
          type: 'dca', blockHeight: x.block_height, timestamp: x.ts, eventIndex: x.event_index, extrinsicIndex: x.extrinsic_index,
          who: owner ? accountRef(owner) : null, to: null, asset: null, assetIn: aIn, assetOut: aOut,
          amount: null, amountIn: x.amount_in, amountOut: x.amount_out,
          valueUsd: usdValue(prices, aOut.assetId, x.amount_out, aOut.decimals),
          dca: true, dcaScheduleId: scheduleId, linkBlock: x.block_height, linkIndex: x.extrinsic_index,
        })
      }
    }

    rows.push(...await getRecentRewardClaims(100, undefined, undefined, undefined, undefined, height, index))

    const seen = new Set<string>()
    const deduped = await suppressActivityPlumbing(rows.filter(r => {
      const key = `${r.type}:${r.blockHeight}:${r.extrinsicIndex ?? ''}:${r.asset?.assetId ?? r.assetIn?.assetId ?? ''}:${r.who?.accountId ?? ''}:${r.to?.accountId ?? ''}:${r.amount ?? r.amountIn ?? ''}:${r.amountOut ?? ''}:${r.voteRef ?? ''}:${r.mmAction ?? r.stakingAction ?? r.liqAction ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).filter((r, _i, all) => {
      // Consolidate liquidity-routed mechanics: when this extrinsic carries a
      // liquidity add/remove, the share-asset swap legs and the pool proxy's
      // money-market churn are that action's plumbing, not separate activities.
      if (!all.some(x => x.type === 'liquidity')) return true
      if (r.type === 'trade' && ((r.assetIn && isShareAssetId(r.assetIn.assetId)) || (r.assetOut && isShareAssetId(r.assetOut.assetId)))) return false
      if (r.type === 'mm' && isModuleAcct(r.who)) return false
      return true
    }))
    await Promise.all([applyHistoricalUsd(deduped, activityHistPick), applyXcmJourneys(deduped)])
    return deduped
  })
}

export async function getBlockActivity(height: number): Promise<ActivityRow[]> {
  return cached(`explorer:block-activity:${height}`, 10000, async () => {
    const extRes = await client.query({
      query: `SELECT DISTINCT extrinsic_index
              FROM price_data.raw_extrinsics
              WHERE block_height = {h:UInt32}
              ORDER BY extrinsic_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    })
    const extIndices = (await extRes.json<{ extrinsic_index: number }>())
      .map(r => r.extrinsic_index)
      .filter(i => Number.isInteger(i))

    const [extRows, hookRows, dcaFailureRows] = await Promise.all([
      Promise.all(extIndices.map(i => getExtrinsicActivity(height, i))).then(parts => parts.flat()),
      getBlockHookActivity(height),
      getRecentDcaFailures(100, undefined, undefined, undefined, undefined, height),
    ])

    const seen = new Set<string>()
    const merged = (await suppressActivityPlumbing([...extRows, ...hookRows, ...dcaFailureRows]
      .filter(r => {
        const key = `${r.type}:${r.blockHeight}:${r.extrinsicIndex ?? ''}:${r.eventIndex ?? ''}:${r.asset?.assetId ?? r.assetIn?.assetId ?? ''}:${r.assetOut?.assetId ?? ''}:${r.who?.accountId ?? ''}:${r.to?.accountId ?? ''}:${r.amount ?? r.amountIn ?? ''}:${r.amountOut ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })))
      .sort((a, b) => {
        const ax = a.extrinsicIndex ?? Number.MAX_SAFE_INTEGER
        const bx = b.extrinsicIndex ?? Number.MAX_SAFE_INTEGER
        if (ax !== bx) return ax - bx
        return (a.eventIndex ?? 0) - (b.eventIndex ?? 0)
      })
    await Promise.all([applyHistoricalUsd(merged, activityHistPick), applyXcmJourneys(merged)])
    return merged
  })
}

async function getBlockHookActivity(height: number): Promise<ActivityRow[]> {
  const prices = await ensurePrices()
  const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
  const transferPlumbing = [...ammPoolAccounts(), ...(await mmReserveAccountIds())]
  const transferPlumbingList = transferPlumbing.length ? transferPlumbing.map(a => `'${a}'`).join(',') : "''"
  const [swapRes, dcaRes, xcmInRows, xcmOutRemoteRows, stakingRes, transferRes, liquidityRes, mmRes, otcRes] = await Promise.all([
    client.query({
      query: `SELECT event_index, event_name, args_json, toString(block_timestamp) AS ts
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32}
                AND extrinsic_index IS NULL
                AND event_name IN (${names})
                ${NOT_ROUTER_HOP}
                ${NOT_DCA_FEE_LEG}
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT event_index, toString(id) AS id, who, amount_in, amount_out, toString(block_timestamp) AS ts
              FROM price_data.dca_events
              WHERE block_height = {h:UInt32} AND event_name = 'DCA.TradeExecuted'
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    xcmInRowsForBlocks([height], prices),
    xcmOutRemoteRowsForBlocks([height], prices),
    // Extrinsic-less staking (e.g. CollatorRewards.CollatorRewarded, paid from
    // on_initialize with no extrinsic) — same event list/suppression as
    // getRecentStaking (source of truth for staking's row shape/filters).
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, args_json
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index IS NULL AND event_name IN (${sqlEventNameList(STAKING_EVENT_NAMES)})
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    // Extrinsic-less transfers (hook-driven treasury/vesting/reward payouts and
    // user↔user moves). Classified with the shared non-plumbing leg filter — NOT
    // a blanket module exclusion — so genuine pallet-pot payouts stay visible and
    // resolve on their detail page, mirroring the account feed. Cross-event-name
    // de-dup (a single transfer often emits both Currencies.Transferred and a
    // Tokens.Transfer/Balances.Transfer) is handled afterwards by the shared
    // dedupeTransferEvents helper.
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                JSONExtractString(args_json, 'from') AS from_acc,
                JSONExtractString(args_json, 'to') AS to_acc,
                JSONExtractString(args_json, 'amount') AS amount,
                ${transferAssetIdSql()} AS asset_id
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index IS NULL
                AND event_name IN (${sqlEventNameList(TRANSFER_EVENTS)})
                ${nonPlumbingTransferLegSql("JSONExtractString(args_json,'from')", "JSONExtractString(args_json,'to')", transferPlumbingList)}
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    // Extrinsic-less liquidity (Stableswap/Omnipool add/remove triggered by a
    // hook, e.g. protocol-owned liquidity rebalances) — same event list +
    // module-account exclusion as getRecentLiquidity (source of truth).
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                JSONExtractString(args_json, 'who') AS who,
                multiIf(JSONHas(args_json,'rewardCurrency'), JSONExtractInt(args_json,'rewardCurrency'),
                  JSONHas(args_json,'assetId'), JSONExtractInt(args_json,'assetId'),
                  JSONHas(args_json,'poolId'), JSONExtractInt(args_json,'poolId'),
                  JSONHas(args_json,'assetA'), JSONExtractInt(args_json,'assetA'),
                  JSONExtractInt(args_json,'asset_id')) AS asset_id,
                multiIf(JSONHas(args_json,'claimed'), JSONExtractString(args_json,'claimed'), JSONHas(args_json,'amount'), JSONExtractString(args_json,'amount'), JSONExtractString(args_json,'shares')) AS amount
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index IS NULL
                AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
                AND JSONExtractString(args_json,'who') NOT LIKE '0x6d6f646c%'
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    // Money-market events for the block — same event list, configured-pool
    // allow-list and user-address exclusion as getRecentMoneyMarket (source of
    // truth). Scoped to the block only (no extrinsic_index column on this
    // table); rows whose substrate extrinsic DOES resolve are dropped below
    // since getExtrinsicActivity already covers them.
    client.query({
      query: `SELECT block_height, event_index, toString(block_timestamp) AS ts, event_name, account_id, asset_address, pool_address,
                if(event_name='LiquidationCall', JSONExtractString(decoded_args_json,'liquidatedCollateralAmount'), amount) AS amount
              FROM price_data.raw_money_market_events
              WHERE block_height = {h:UInt32}
                AND event_name IN ('Supply','Borrow','Repay','Withdraw','LiquidationCall')
                AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})
                AND user_address NOT LIKE '0x6d6f646c%'
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    // Extrinsic-less OTC place/pull (30 historical Placed + 1 Cancelled hook
    // events) — Filled/PartiallyFilled always carry an extrinsic_index so
    // they're fully covered by getExtrinsicActivity instead.
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, args_json
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index IS NULL AND event_name IN (${sqlEventNameList(OTC_EVENT_NAMES)})
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
  ])
  const swaps = await swapRes.json<{ event_index: number; event_name: string; args_json: string; ts: string }>()
  const dcas = await dcaRes.json<{ event_index: number; id: string; who: string; amount_in: string; amount_out: string; ts: string }>()
  const schedById = await getDcaScheduleLinks(dcas.map(d => d.id))
  const usedSwap = new Set<number>()
  const rows: ActivityRow[] = []

  const swapCandidates = swaps.map(s => {
    const args = (safeJson(s.args_json) ?? {}) as Record<string, unknown>
    return { row: s, args, amounts: swapEventAmounts(s.event_name, args) }
  })
  for (const d of dcas) {
    const match = swapCandidates.find(s => !usedSwap.has(s.row.event_index) && s.amounts.amountIn === d.amount_in && (!d.amount_out || s.amounts.amountOut === d.amount_out))
      ?? swapCandidates.find(s => !usedSwap.has(s.row.event_index) && s.amounts.amountIn === d.amount_in)
    if (match) usedSwap.add(match.row.event_index)
    const aIn = match ? asset(match.amounts.assetIn) : null
    const aOut = match ? asset(match.amounts.assetOut) : null
    const sched = schedById.get(d.id)
    rows.push({
      type: 'trade',
      blockHeight: height,
      timestamp: d.ts,
      eventIndex: match?.row.event_index ?? d.event_index,
      extrinsicIndex: null,
      who: d.who && ACCOUNT_RE.test(d.who) ? accountRef(d.who) : null,
      to: null,
      asset: null,
      assetIn: aIn,
      assetOut: aOut,
      amount: null,
      amountIn: d.amount_in,
      amountOut: d.amount_out,
      valueUsd: aOut ? usdValue(prices, aOut.assetId, d.amount_out, aOut.decimals) : null,
      dca: true,
      dcaScheduleId: Number(d.id) || undefined,
      linkBlock: sched?.block ?? height,
      linkIndex: sched?.idx ?? null,
    })
  }

  for (const s of swapCandidates) {
    if (usedSwap.has(s.row.event_index)) continue
    const aOut = asset(s.amounts.assetOut)
    const who = argStr(s.args, 'who')
    // Drop DCA keeper-fee legs: an owner-attributed pallet-internal swap that
    // didn't match a DCA.TradeExecuted above is the fee leg, not a user trade.
    if (isDcaFeeLegSwap(null, who)) continue
    rows.push({
      type: 'trade',
      blockHeight: height,
      timestamp: s.row.ts,
      eventIndex: s.row.event_index,
      extrinsicIndex: null,
      who: who && ACCOUNT_RE.test(who) && who !== ROUTER_PALLET_ACCT ? accountRef(who) : null,
      to: null,
      asset: null,
      assetIn: asset(s.amounts.assetIn),
      assetOut: aOut,
      amount: null,
      amountIn: s.amounts.amountIn,
      amountOut: s.amounts.amountOut,
      valueUsd: usdValue(prices, aOut.assetId, s.amounts.amountOut, aOut.decimals),
      linkBlock: height,
      linkIndex: null,
    })
  }

  rows.push(...xcmInRows)
  rows.push(...xcmOutRemoteRows)

  // Extrinsic-less staking — mirrors getRecentStaking's construction via the
  // shared stakingRowFromEvent helper.
  const stakingEvents = suppressGigaCompanionEvents(
    await stakingRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }>())
  const seenStaking = new Set<string>()
  for (const r of stakingEvents) {
    const built = stakingRowFromEvent(r, prices)
    if (!built) continue
    const key = `${r.block_height}:e:${r.event_name}:${built.who}:${built.assetId}:${built.amount}`
    if (seenStaking.has(key)) continue
    seenStaking.add(key)
    rows.push(built.row)
  }

  // Extrinsic-less transfers — same shape as toTransferRow in getRecentActivity,
  // collapsed across event names by the shared dedupeTransferEvents helper (the
  // same one getExtrinsicActivity uses for its per-extrinsic transfer legs).
  const transferEvents = dedupeTransferEvents(
    await transferRes.json<RawTransferEventRow>())
  for (const t of transferEvents) {
    if (!t.from_acc || !t.to_acc || !t.amount) continue
    const a = asset(t.asset_id)
    rows.push({
      type: 'transfer', blockHeight: t.block_height, timestamp: t.ts, eventIndex: t.event_index, extrinsicIndex: t.extrinsic_index,
      who: accountRef(t.from_acc), to: accountRef(t.to_acc), asset: a, assetIn: null, assetOut: null,
      amount: t.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, t.amount, a.decimals),
    })
  }

  // Extrinsic-less liquidity — mirrors getRecentLiquidity's construction
  // (including its fillMissingLiquidityAmounts backfill, a no-op here since it
  // only applies to extrinsic-scoped rows).
  const liqRows = await liquidityRes.json<LiquidityAmountCandidate & { ts: string }>()
  await fillMissingLiquidityAmounts(liqRows)
  const seenLiquidity = new Set<string>()
  for (const r of liqRows) {
    const key = `${r.block_height}:${r.event_index}`
    if (seenLiquidity.has(key)) continue
    seenLiquidity.add(key)
    const a = asset(r.asset_id)
    rows.push({
      type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
      who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
      amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
      liqAction: liqActionFor(r.event_name),
    })
  }

  // Money-market events with no resolvable substrate extrinsic — mirrors
  // getRecentMoneyMarket's construction (including the userMm module-account
  // filter getRecentActivity applies on top for the 'mm' category); rows whose
  // extrinsic DOES resolve are covered by getExtrinsicActivity already.
  const mmEv = await mmRes.json<{ block_height: number; event_index: number; ts: string; event_name: string; account_id: string | null; asset_address: string; pool_address: string | null; amount: string }>()
  const mmExt = await extrinsicIndexFor(mmEv.map(r => [r.block_height, r.event_index] as [number, number | null]))
  for (const r of mmEv) {
    if (mmExt.has(`${r.block_height}:${r.event_index}`)) continue
    const aid = assetIdFromMmAddress(r.asset_address)
    const a = aid != null ? asset(aid) : null
    const who = r.account_id ? accountRef(r.account_id) : null
    if (isModuleAcct(who)) continue
    rows.push({
      type: 'mm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: null,
      who, to: null, asset: a, assetIn: null, assetOut: null,
      amount: r.amount, amountIn: null, amountOut: null,
      valueUsd: a ? usdValue(prices, a.assetId, r.amount, a.decimals) : null,
      mmAction: r.event_name, ...moneyMarketActivityFields(r.pool_address), linkBlock: r.block_height, linkIndex: null,
    })
  }

  // Extrinsic-less OTC place/pull — same construction as getRecentOtc's
  // hook-context handling (who=null; no signer to resolve).
  const otcHookEvents = await otcRes.json<RawOtcActivityEvent>()
  if (otcHookEvents.length) {
    const lookupIds = otcHookEvents.filter(e => e.event_name !== 'OTC.Placed')
      .map(e => argInt((safeJson(e.args_json) ?? {}) as Record<string, unknown>, 'orderId'))
    const placedById = await getOtcPlacedLegsByOrderId(lookupIds)
    for (const e of otcHookEvents) {
      const row = otcRowFromEvent(e, prices, placedById, {})
      if (row) rows.push(row)
    }
  }

  return rows
}

// asset-scoped activity (asset detail page)
// A per-asset activity feed built SERVER-SIDE so it works regardless of how
// recent the asset's activity is. Each category is filtered by the asset at the SQL level
// (asset_id = id for transfers/liquidity/xcm/mm; assetIn = id OR assetOut = id
// for trades) over the full block range, then merged and sliced. The `type` chip
// selects a single category server-side so rare types aren't starved by the slice.
// Literal assetId match only — no aToken/share-token expansion.
export async function getAssetActivity(assetId: number, type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:asset-activity:${assetId}:${type}:${limit}:${offset}:${action ?? ''}:${filterKey(filters)}:${from ?? ''}:${to ?? ''}`, tw ? 30000 : 8000, async () => {
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const want = offset + limit
    // Sources either push value predicates below LIMIT or cursor-walk enriched
    // rows. This count is therefore pagination/classification capacity, never
    // probabilistic headroom for a post-filter.
    const fetchN = Math.max(want * 5, 1000)
    // Event-time USD filters are exact post-filters over bounded, asset-indexed
    // candidates. Pushing the ASOF price join below each source LIMIT makes a
    // cold asset page value its complete source history before it can stop.
    // Token-unit thresholds remain safe and selective in the source query.
    const queryFilters = filters.min != null && filters.unit !== 'token'
      ? { ...filters, min: undefined, unit: undefined }
      : filters
    const fixedAssetFilters: ValueListFilters = { ...queryFilters, token: undefined }

    // Transfers: filter by asset and user-facing accounts in SQL before limiting,
    // otherwise busy module/pool activity can fill a page and hide real transfers.
    type = normalizeActivityTypeKey(type)
    const wantTransfers = type === 'all' || type === 'transfer'
    // Classification context: the Transfers view must exclude trade/staking/MM
    // legs, and Trades must yield share-routed legs to Liquidity — so those
    // categories are fetched whenever their exclusion sets are needed.
    const wantTrades = type === 'all' || type === 'trade' || wantTransfers
    const wantLiquidity = type === 'all' || type === 'liquidity' || wantTrades
    const wantXcm = type === 'all' || type === 'xcm' || wantTransfers
    const wantMm = type === 'all' || type === 'mm' || wantTransfers
    // otc folds under the trade chip/type — fetch it whenever trade is (wantTrades
    // already implies wantTransfers), plus its own `type=otc` request.
    const wantOtc = type === 'all' || type === 'otc' || wantTrades
    const wantStaking = type === 'all' || type === 'staking' || wantTransfers
    const wantVotes = (type === 'all' || type === 'vote' || wantTransfers) && assetId === 0

    const transfersP: Promise<ActivityRow[]> = wantTransfers ? (async () => {
      const useTransferReadModel = true
      const transferAssetExpr = useTransferReadModel ? 'asset_id' : transferAssetIdSql()
      const transferValueFilter = eventValueFilterSql('{assetId:UInt32}', useTransferReadModel ? 'amount' : `JSONExtractString(args_json,'amount')`, 'block_timestamp', queryFilters, prices, 'asset_transfer_price')
      const res = await client.query({
        query: useTransferReadModel ? `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            from_account AS from_acc, to_account AS to_acc, amount
          FROM price_data.transfer_activity
          ${transferValueFilter.joinSql}
          WHERE ${bound} AND asset_id = {assetId:UInt32}
            AND from_account NOT LIKE '0x6d6f646c%'
            AND to_account NOT LIKE '0x6d6f646c%'
            ${transferValueFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {n:UInt32}` : `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            JSONExtractString(args_json,'from') AS from_acc,
            JSONExtractString(args_json,'to') AS to_acc,
            JSONExtractString(args_json,'amount') AS amount
          FROM price_data.raw_events
          ${transferValueFilter.joinSql}
          WHERE ${bound}
            AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')
            AND ${transferAssetExpr} = {assetId:UInt32}
            AND JSONExtractString(args_json,'from') NOT LIKE '0x6d6f646c%'
            AND JSONExtractString(args_json,'to') NOT LIKE '0x6d6f646c%'
            ${transferValueFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {n:UInt32}`,
        query_params: { n: fetchN, assetId }, format: 'JSONEachRow',
      })
      const rows = dedupeTransferEvents((await res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; from_acc: string; to_acc: string; amount: string }>())
        .map(r => ({ ...r, asset_id: assetId })))
      const a = asset(assetId)
      const seen = new Set<string>()
      const out: ActivityRow[] = []
      for (const r of rows) {
        const key = `${r.block_height}:${r.event_index}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          type: 'transfer', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: accountRef(r.from_acc), to: accountRef(r.to_acc), asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
          linkBlock: r.block_height, linkIndex: r.extrinsic_index,
        })
      }
      return out
    })() : Promise.resolve([])

    const dcaFailuresP = wantTrades
      ? getRecentDcaFailures(fetchN, from, to, undefined, [assetId])
      : Promise.resolve([])

    // Trades: swaps where the asset is either leg. Group per extrinsic (signed) or
    // per event (pallet-internal), preferring Router.Executed (the net summary).
    const tradesP: Promise<ActivityRow[]> = wantTrades ? (async () => {
      const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
      const useAssetSwapReadModel = true
      const tradeValueFilter = eventValueFilterSql(useAssetSwapReadModel ? 'asset_out' : `JSONExtractInt(args_json,'assetOut')`, useAssetSwapReadModel ? 'amount_out' : `JSONExtractString(args_json,'amountOut')`, 'block_timestamp', fixedAssetFilters, prices, 'asset_trade_price')
      const res = await client.query({
        query: useAssetSwapReadModel ? `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who, asset_in, asset_out, amount_in, amount_out
          FROM price_data.asset_swap_activity
          ${tradeValueFilter.joinSql}
          WHERE ${bound} AND asset_id = {assetId:UInt32}
            AND who != '${ROUTER_PALLET_ACCT}'
            AND NOT (extrinsic_index IS NULL AND who != '' AND who NOT LIKE '0x6d6f646c%') ${NOT_LEGACY_DCA_HOP}
            ${tradeValueFilter.predicateSql}
          ORDER BY block_height DESC, extrinsic_index DESC, event_name IN (${ROUTER_NET_EVENTS_SQL}) DESC, event_index DESC
          LIMIT 1 BY block_height, ifNull(toString(extrinsic_index), concat('event:', toString(event_index)))
          LIMIT {n:UInt32}` : `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            JSONExtractString(args_json,'who') AS who,
            JSONExtractInt(args_json,'assetIn') AS asset_in,
            JSONExtractInt(args_json,'assetOut') AS asset_out,
            JSONExtractString(args_json,'amountIn') AS amount_in,
            JSONExtractString(args_json,'amountOut') AS amount_out
          FROM price_data.raw_events
          ${tradeValueFilter.joinSql}
          WHERE ${bound}
            AND event_name IN (${names}) ${NOT_ROUTER_HOP} ${NOT_DCA_FEE_LEG}
            AND (JSONExtractInt(args_json,'assetIn') = ${assetId} OR JSONExtractInt(args_json,'assetOut') = ${assetId})
            ${tradeValueFilter.predicateSql}
          ORDER BY block_height DESC, extrinsic_index DESC, event_name IN (${ROUTER_NET_EVENTS_SQL}) DESC, event_index DESC
          LIMIT 1 BY block_height, ifNull(toString(extrinsic_index), concat('event:', toString(event_index)))
          LIMIT {n:UInt32}`,
        query_params: { n: fetchN, assetId }, format: 'JSONEachRow',
      })
      const rows = await res.json<RawSwapEventRow>()
      if (!rows.length) return []
      // DCA owner attribution (executions are unsigned block hooks).
      const dcaRes = await client.query({
        query: `SELECT block_height, who, amount_in
                FROM price_data.dca_events
                WHERE event_name='DCA.TradeExecuted' AND block_height IN (${[...new Set(rows.map(r => r.block_height))].join(',') || '0'})`,
        format: 'JSONEachRow',
      })
      const dcaByAmount = new Map<string, string>()
      for (const d of await dcaRes.json<{ block_height: number; who: string; amount_in: string }>()) dcaByAmount.set(`${d.block_height}:${d.amount_in}`, d.who)
      const pairs = rows.map(r => [r.block_height, r.extrinsic_index] as [number, number | null])
      const [signers, liqExt] = await Promise.all([signersFor(pairs), liquidationExtrinsics(pairs)])
      const { groups, order } = groupSwapRows(rows)
      const out: ActivityRow[] = []
      for (const key of order) {
        const g = groups.get(key)!
        // Prefer the Router.Executed net summary, but only if it touches the asset
        // (a multi-hop route's net legs may not include it even when a hop does).
        const rep = g.find(r => isRouterNet(r.event_name) && (r.asset_in === assetId || r.asset_out === assetId)) ?? g[0]
        // Drop DCA keeper-fee legs (SQL already excludes them; defensive net so a
        // fee leg never surfaces as a phantom "Swap" next to its "DCA" row).
        if (isDcaFeeLegSwap(rep.extrinsic_index, rep.who)) continue
        // Skip a liquidation's internal swap — it's surfaced as the mm row instead.
        if (rep.extrinsic_index != null && liqExt.has(`${rep.block_height}:${rep.extrinsic_index}`)) continue
        const signer = rep.extrinsic_index != null ? signers.get(`${rep.block_height}:${rep.extrinsic_index}`) : undefined
        const dcaWho = rep.extrinsic_index == null ? dcaByAmount.get(`${rep.block_height}:${rep.amount_in}`) : undefined
        const actor = signer ?? dcaWho ?? (rep.who && ACCOUNT_RE.test(rep.who) ? rep.who : null)
        const aOut = asset(rep.asset_out)
        out.push({
          type: 'trade', blockHeight: rep.block_height, timestamp: rep.ts, eventIndex: rep.event_index, extrinsicIndex: rep.extrinsic_index,
          who: actor ? accountRef(actor) : null, to: null, asset: null, assetIn: asset(rep.asset_in), assetOut: aOut,
          amount: null, amountIn: rep.amount_in, amountOut: rep.amount_out,
          valueUsd: usdValue(prices, aOut.assetId, rep.amount_out, aOut.decimals),
          dca: !!dcaWho, linkBlock: rep.extrinsic_index != null ? rep.block_height : null, linkIndex: rep.extrinsic_index,
        })
      }
      return out
    })() : Promise.resolve([])

    // Liquidity: add/remove where the provided/pool asset matches.
    const liquidityP: Promise<ActivityRow[]> = wantLiquidity ? (async () => {
      const fetchPage = async (pageBound: string, pageLimit: number): Promise<ActivityRow[]> => {
        const res = await client.query({
          query: `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who AS who,
            amount AS amount,
            asset_b AS asset_b,
            pool_account AS pool_acc
          FROM price_data.liquidity_activity
          WHERE ${pageBound}
            AND event_name IN ('Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed')
            AND who NOT LIKE '0x6d6f646c%'
            AND has(asset_refs, {assetId:UInt32})
          ORDER BY block_height DESC, event_index DESC
          LIMIT {n:UInt32}`,
          query_params: { n: pageLimit, assetId }, format: 'JSONEachRow',
        })
        const rows = (await res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; who: string; amount: string; asset_b: number; pool_acc: string }>())
          .map(r => ({ ...r, asset_id: assetId }))
        await fillMissingLiquidityAmounts(rows)
        const a = asset(assetId)
        const seen = new Set<string>()
        const out: ActivityRow[] = []
        const createCands: { row: ActivityRow; pool: string; assetB: number }[] = []
        for (const r of rows) {
          const key = `${r.block_height}:${r.event_index}`
          if (seen.has(key)) continue
          seen.add(key)
          const row: ActivityRow = {
            type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
            who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
            amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
            liqAction: liqActionFor(r.event_name),
            linkBlock: r.block_height, linkIndex: r.extrinsic_index,
          }
          // Enrich only from the assetA side — this builder pins asset_id to the
          // page's asset, so on the assetB page both legs would collapse into B.
          if (r.event_name === 'XYK.PoolCreated' && r.asset_b !== assetId) createCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
          out.push(row)
        }
        await enrichPoolCreations(createCands)
        await applyHistoricalUsd(out, activityHistPick)
        return out
      }
      if (fixedAssetFilters.min != null) {
        return fetchFilteredDeep(tw, want, fetchPage,
          row => activityRowMatchesFilters(row, fixedAssetFilters),
          row => row.blockHeight, row => row.eventIndex ?? -1,
          row => `${row.blockHeight}:${row.eventIndex}`)
      }
      return fetchPage(bound, fetchN)
    })() : Promise.resolve([])

    // XCM outbound: transfers whose recovered substrate currencyId matches the asset.
    // Start from the asset's matching withdrawals, then decode the same-extrinsic
    // outbound event (either shape) so low-volume assets page through their full
    // XCM history. An extrinsic emitting both events joins twice but collapses in
    // the block:ext:amount:sender dedup below.
    const xcmP: Promise<ActivityRow[]> = wantXcm ? (async () => {
      const cidExpr = 'w.asset_id'
      const withdrawalAmountExpr = 'w.amount'
      const xcmValueFilter = eventValueFilterSql('{assetId:UInt32}', withdrawalAmountExpr, 'w.block_timestamp', fixedAssetFilters, prices, 'asset_xcm_price')
      const res = await client.query({
        query: `
          SELECT w.block_height, toString(w.block_timestamp) AS ts, w.extrinsic_index,
            x.event_index, x.args_json AS x_args, ${withdrawalAmountExpr} AS amount
          FROM ${xcmEventActivityTable('w')}
          INNER JOIN ${xcmEventActivityTable('x')}
            ON x.block_height = w.block_height
           AND x.extrinsic_index = w.extrinsic_index
           AND x.event_name IN ('XTokens.TransferredAssets','PolkadotXcm.Sent')
          ${xcmValueFilter.joinSql}
          WHERE ${tw ? tw.replaceAll('block_timestamp', 'w.block_timestamp') : '1'}
            AND w.event_name = 'Currencies.Withdrawn'
            AND ${cidExpr} = {assetId:UInt32}
            AND position(x.args_json, concat('"value":"', JSONExtractString(w.args_json,'amount'), '"')) > 0
            ${xcmValueFilter.predicateSql}
          ORDER BY w.block_height DESC, x.event_index DESC
          LIMIT {n:UInt32}`,
        query_params: { n: fetchN, assetId }, format: 'JSONEachRow',
      })
      const rows = await res.json<{ block_height: number; ts: string; extrinsic_index: number | null; event_index: number; x_args: string; amount: string }>()
      const a = asset(assetId)
      const seen = new Set<string>()
      const out: ActivityRow[] = []
      for (const r of rows) {
        const parsed = parseOutboundXcm(safeJson(r.x_args))
        if (!parsed || !parsed.amounts.includes(r.amount)) continue
        const key = `${r.block_height}:${r.extrinsic_index}:${r.amount}:${parsed.sender}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          type: 'xcm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: accountRef(parsed.sender), to: null, asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
          xcmDir: 'out', ...parsed.dest, linkBlock: r.block_height, linkIndex: r.extrinsic_index,
        })
      }
      return out
    })() : Promise.resolve([])

    // XCM inbound: hook-context deposits of this asset seed the candidate blocks;
    // the barrier walk-back keeps only genuine inbound-message credits.
    const xcmInP: Promise<ActivityRow[]> = wantXcm ? (async () => {
      const depositAmountExpr = 'amount'
      const xcmInValueFilter = eventValueFilterSql('{assetId:UInt32}', depositAmountExpr, 'block_timestamp', fixedAssetFilters, prices, 'asset_xcm_in_price')
      return fetchDecodedXcmDeep(
        bound,
        fetchN,
        async (pageBound, pageLimit) => {
          const res = await client.query({
            query: `SELECT DISTINCT block_height FROM ${xcmEventActivityTable()}
                    ${xcmInValueFilter.joinSql}
                    WHERE ${pageBound}
                      AND event_name IN ('Currencies.Deposited','Tokens.Deposited') AND extrinsic_index IS NULL
                      AND asset_id = {assetId:UInt32}
                      AND NOT match(who, '${RESERVED_ACCOUNT_RE.source}')
                      ${xcmInValueFilter.predicateSql}
                    ORDER BY block_height DESC LIMIT {n:UInt32}`,
            query_params: { n: pageLimit, assetId }, format: 'JSONEachRow',
          })
          return res.json<{ block_height: number }>()
        },
        async blocks => (await xcmInRowsForBlocks(blocks, prices)).filter(row => row.asset?.assetId === assetId),
        row => activityRowMatchesFilters(row, fixedAssetFilters),
      )
    })() : Promise.resolve([])

    // Remote-origin messages can withdraw assets from Hydration without a local
    // extrinsic. Include the same decoded rows used by global, block and account
    // activity so an economic action does not disappear on the asset surface.
    const xcmOutRemoteP: Promise<ActivityRow[]> = wantXcm
      ? getRecentXcmOutRemote(fetchN, from, to, undefined, 0, { ...fixedAssetFilters, token: String(assetId) })
        .then(rows => rows.filter(row => row.asset?.assetId === assetId))
      : Promise.resolve([])

    // Money market: supply/borrow/repay/withdraw/liquidation on the asset's reserve.
    // For an aToken (aPRIME 1043) the reserve is the UNDERLYING asset (PRIME 43) —
    // the MM activity for the aToken IS the supply/withdraw flow on that reserve.
    // Filter by the reserve's ERC20 address in SQL so low-volume reserves aren't
    // starved by a global recency window.
    const mmReserveId = ATOKEN_UNDERLYING_ID[assetId] ?? assetId
    const mmP: Promise<ActivityRow[]> = wantMm ? (async () => {
      const reserveAddrs = mmReserveAddressForAsset(mmReserveId)
      const mmValueFilter = eventValueFilterSql('{assetId:UInt32}', `if(event_name='LiquidationCall', JSONExtractString(decoded_args_json,'liquidatedCollateralAmount'), amount)`, 'block_timestamp', fixedAssetFilters, prices, 'asset_mm_price')
      const res = await client.query({
        query: `SELECT block_height, event_index, toString(block_timestamp) AS ts, event_name, account_id, asset_address, pool_address,
                  if(event_name='LiquidationCall', JSONExtractString(decoded_args_json,'liquidatedCollateralAmount'), amount) AS amount
                FROM price_data.raw_money_market_events
                ${mmValueFilter.joinSql}
                WHERE ${bound}
                  AND event_name IN ('Supply','Borrow','Repay','Withdraw','LiquidationCall')
                  AND user_address NOT LIKE '0x6d6f646c%'
                  AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})
                  AND lower(ifNull(asset_address, '')) IN ({reserves:Array(String)})
                  ${mmValueFilter.predicateSql}
                ORDER BY block_height DESC, event_index DESC LIMIT {n:UInt32}`,
        query_params: { n: fetchN, assetId, reserves: reserveAddrs }, format: 'JSONEachRow',
      })
      const mmEv = await res.json<{ block_height: number; event_index: number; ts: string; event_name: string; account_id: string | null; asset_address: string; pool_address: string | null; amount: string }>()
      const mmExt = await extrinsicIndexFor(mmEv.map(r => [r.block_height, r.event_index] as [number, number | null]))
      const out: ActivityRow[] = []
      // Display the queried asset (the aToken itself, or the plain reserve asset).
      const a = asset(assetId)
      for (const r of mmEv) {
        const xi = mmExt.get(`${r.block_height}:${r.event_index}`) ?? null
        out.push({
          type: 'mm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: xi,
          who: r.account_id ? accountRef(r.account_id) : null, to: null, asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
          mmAction: r.event_name, ...moneyMarketActivityFields(r.pool_address), linkBlock: r.block_height, linkIndex: xi,
        })
      }
      return out
    })() : Promise.resolve([])

    // OTC lifecycle rows inherit their legs from Placed. Restrict all event
    // kinds by the matching order ids in SQL, then cursor-walk for thresholds
    // that can only be decided after the order enrichment.
    const otcP: Promise<ActivityRow[]> = wantOtc ? (async () => {
      const fetchPage = async (pageBound: string, pageLimit: number): Promise<ActivityRow[]> => {
        const res = await client.query({
          query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, args_json
                  FROM ${otcActivityTable()}
                  WHERE ${pageBound}
                    AND event_name IN (${sqlEventNameList(OTC_EVENT_NAMES)})
                    AND JSONExtractUInt(args_json,'orderId') IN (
                      SELECT JSONExtractUInt(args_json,'orderId')
                      FROM ${otcActivityTable()}
                      WHERE event_name = 'OTC.Placed'
                        AND (JSONExtractInt(args_json,'assetIn') = {assetId:UInt32}
                          OR JSONExtractInt(args_json,'assetOut') = {assetId:UInt32})
                    )
                  ORDER BY block_height DESC, event_index DESC LIMIT {n:UInt32}`,
          query_params: { assetId, n: pageLimit }, format: 'JSONEachRow',
        })
        const rows = await res.json<RawOtcActivityEvent>()
        const orderIds = rows.map(r => argInt((safeJson(r.args_json) ?? {}) as Record<string, unknown>, 'orderId'))
        const [placedById, signers] = await Promise.all([
          getOtcPlacedLegsByOrderId(orderIds),
          signersFor(rows.filter(r => r.event_name === 'OTC.Placed' || r.event_name === 'OTC.Cancelled').map(r => [r.block_height, r.extrinsic_index] as [number, number | null])),
        ])
        const out: ActivityRow[] = []
        for (const r of rows) {
          const signer = r.extrinsic_index != null ? signers.get(`${r.block_height}:${r.extrinsic_index}`) ?? null : null
          const row = otcRowFromEvent(r, prices, placedById, { signerFallback: signer })
          if (row) out.push(row)
        }
        await applyHistoricalUsd(out, activityHistPick)
        return out
      }
      if (fixedAssetFilters.min != null) {
        return fetchFilteredDeep(tw, want, fetchPage,
          row => activityRowMatchesFilters(row, fixedAssetFilters),
          row => row.blockHeight, row => row.eventIndex ?? -1,
          row => `${row.blockHeight}:${row.eventIndex}`)
      }
      return fetchPage(bound, fetchN)
    })() : Promise.resolve([])

    const stakingP: Promise<ActivityRow[]> = wantStaking ? getRecentStaking(fetchN, from, to, undefined, 0, queryFilters, assetId) : Promise.resolve([])
    const rewardsP: Promise<ActivityRow[]> = (type === 'all' || type === 'transfer' || type === 'liquidity' || type === 'mm')
      ? getRecentRewardClaims(fetchN, from, to, undefined, [assetId], undefined, undefined, fixedAssetFilters)
      : Promise.resolve([])
    const votesP: Promise<ActivityRow[]> = wantVotes ? getRecentVotes(fetchN, from, to, 0, {}, undefined, queryFilters).then(rows => rows.map(v => ({
      type: 'vote' as const,
      blockHeight: v.blockHeight,
      timestamp: v.timestamp,
      eventIndex: v.eventIndex,
      extrinsicIndex: v.extrinsicIndex,
      who: v.account,
      to: null,
      asset: v.asset,
      assetIn: null,
      assetOut: null,
      amount: v.amount,
      amountIn: null,
      amountOut: null,
      valueUsd: v.valueUsd,
      votePallet: v.pallet,
      voteAction: v.action,
      voteRef: v.referendum,
      voteSide: v.side,
      voteConviction: v.conviction,
      linkBlock: v.blockHeight,
      linkIndex: v.extrinsicIndex,
    }))) : Promise.resolve([])

    const [transfers, trades, dcaFailures, rewards, liquidity, xcm, xcmIn, xcmOutRemote, mm, otc, staking, votes] = await Promise.all([transfersP, tradesP, dcaFailuresP, rewardsP, liquidityP, xcmP, xcmInP, xcmOutRemoteP, mmP, otcP, stakingP, votesP])
    // Drop transfer legs of the asset's own trades (hops/fee legs share the extrinsic).
    const tradeExtrinsics = new Set(trades.filter(t => t.extrinsicIndex != null).map(t => `${t.blockHeight}:${t.extrinsicIndex}`))
    const stakingExtrinsics = activityExtrinsicSet(staking)
    const mmExtrinsics = activityExtrinsicSet(mm)
    const otcExtrinsics = activityExtrinsicSet(otc)
    const userTransfers = transfers.filter(t =>
      !(t.extrinsicIndex != null && tradeExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
      !(t.extrinsicIndex != null && stakingExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
      !(t.extrinsicIndex != null && mmExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
      !(t.extrinsicIndex != null && otcExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)))
    const userTrades = dropShareRoutedTrades(trades, activityExtrinsicSet(liquidity))
    const userMm = mm.filter(r => !isModuleAcct(r.who))
    let rows = await suppressActivityPlumbing([...userTransfers, ...userTrades, ...dcaFailures, ...rewards, ...liquidity, ...staking, ...votes, ...xcm, ...xcmIn, ...xcmOutRemote, ...userMm, ...otc])
    if (type !== 'all') rows = rows.filter(r => activityTypeMatchesFamily(r.type, type))
    rows = rows.filter(r => activityRowMatchesAction(r, action))
    // The token key is meaningless here (the asset IS fixed); min applies the
    // same way the account/global feeds filter by row value.
    if (filters.min != null && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
    rows = rows.filter(r => activityRowMatchesFilters(r, { ...filters, token: undefined }))
    rows.sort((a, b) => b.blockHeight - a.blockHeight || (b.extrinsicIndex ?? 0) - (a.extrinsicIndex ?? 0))
    const saturationSources = type === 'all' ? [transfers, trades, dcaFailures, rewards, liquidity, staking, votes, xcm, xcmIn, xcmOutRemote, mm, otc]
      : type === 'transfer' ? [transfers]
        : type === 'trade' ? [trades, dcaFailures, otc]
          : type === 'liquidity' ? [liquidity, rewards]
            : type === 'mm' ? [mm, rewards]
              : type === 'otc' ? [otc]
                : type === 'xcm' ? [xcm, xcmIn, xcmOutRemote]
                  : type === 'staking' ? [staking]
                    : [votes]
    if (rows.length < want && saturationSources.some(source => source.length >= fetchN)) throw activityQueryTooBroad()
    const page = rows.slice(offset, offset + limit)
    await applyXcmJourneys(page)
    return page
  })
}

// Account balance + portfolio history. Balances and prices are bucketed by the
// same block-range buckets (≈180 across the indexed window) so the portfolio is
// valued with period prices, and each asset gets a downsampled balance series.
export interface AssetBalancePoint { ts: string; blockHeight: number; balance: number }
export interface AssetBalanceHistory { asset: AssetRef; current: number; points: AssetBalancePoint[]; availableFrom?: string }

interface HistoryBalanceRow { account_id: string; asset_id: string; b: number; bal: string }
export interface ScaledBalanceBucket { b: number; value: string }

// Reconstruct end-of-bucket aToken balances without losing integer precision.
// The anchor is authoritative at anchorBucket; each later scaled-principal delta
// is applied before multiplying by that bucket's latest liquidity index.
export function reconstructATokenBalanceBuckets(
  anchorBucket: number,
  lastBucket: number,
  anchorScaled: string,
  deltas: ScaledBalanceBucket[],
  indices: ScaledBalanceBucket[],
): ScaledBalanceBucket[] {
  const deltaByBucket = new Map<number, bigint>()
  for (const row of deltas) deltaByBucket.set(row.b, (deltaByBucket.get(row.b) ?? 0n) + BigInt(row.value || '0'))
  const indexByBucket = new Map<number, bigint>()
  for (const row of indices) indexByBucket.set(row.b, BigInt(row.value || '0'))

  let scaled = BigInt(anchorScaled || '0')
  let liquidityIndex = 0n
  const out: ScaledBalanceBucket[] = []
  for (let b = Math.max(0, anchorBucket); b <= lastBucket; b++) {
    scaled += deltaByBucket.get(b) ?? 0n
    const nextIndex = indexByBucket.get(b)
    if (nextIndex != null && nextIndex > 0n) liquidityIndex = nextIndex
    if (liquidityIndex <= 0n) continue
    const actual = scaled > 0n ? (scaled * liquidityIndex) / ATOKEN_RAY : 0n
    out.push({ b, value: actual.toString() })
  }
  return out
}

function historyH160(accountId: string): string | null {
  const id = accountId.toLowerCase()
  return evmFromAccountId(id)?.toLowerCase() ?? (/^0x[0-9a-f]{64}$/.test(id) ? `0x${id.slice(2, 42)}` : null)
}

// Add supplied money-market collateral to the per-asset history only. Portfolio
// value continues to use the indexed per-market collateral/debt snapshots below,
// avoiding a double count while making the balance tabs agree with live balances.
async function appendMoneyMarketBalanceRows(
  accounts: string[],
  minBlock: number,
  bucketSize: number,
  lastBucket: number,
  rows: HistoryBalanceRow[],
): Promise<Map<string, number>> {
  const availableFromBucket = new Map<string, number>()
  const holders = [...new Set(accounts.map(historyH160).filter(Boolean) as string[])]
  if (!holders.length) return availableFromBucket
  const anchorBlock = await aTokenAnchorBlock()
  if (!anchorBlock) return availableFromBucket

  const tokens = (await getMmReserveTokens()).filter(token => {
    const market = MM_MARKET_BY_KEY.get(token.marketKey)
    // The staking-backed market's supplied stHDX is already represented by the
    // locked HDX wallet curve, matching getAddress's current-balance semantics.
    return !market?.stakingBacked && assetIdFromMmAddress(token.asset) != null
  })
  const contracts = [...new Set(tokens.map(token => token.aToken.toLowerCase()))]
  if (!contracts.length) return availableFromBucket
  const anchorBucket = Math.max(0, Math.min(lastBucket, Math.floor((Math.max(anchorBlock, minBlock) - minBlock) / bucketSize)))

  const [anchorRes, deltaRes] = await Promise.all([
    client.query({
      query: `SELECT lower(holder) AS holder, lower(contract_address) AS contract,
                toString(scaled_balance) AS scaled
              FROM price_data.atoken_scaled_anchor FINAL
              WHERE holder IN ({holders:Array(String)})
                AND contract_address IN ({contracts:Array(String)})
                AND anchor_block = {anchorBlock:UInt32}`,
      query_params: { holders, contracts, anchorBlock }, format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT holder, contract_address AS contract,
                toUInt32(least(intDiv(greatest(block_height, {minBlock:UInt32}) - {minBlock:UInt32}, {bucketSize:UInt32}), {lastBucket:UInt32})) AS b,
                toString(sum(scaled_delta)) AS delta
              FROM price_data.atoken_scaled_deltas FINAL
              WHERE holder IN ({holders:Array(String)})
                AND contract_address IN ({contracts:Array(String)})
                AND block_height > {anchorBlock:UInt32}
              GROUP BY holder, contract, b ORDER BY holder, contract, b`,
      query_params: { holders, contracts, anchorBlock, minBlock, bucketSize, lastBucket }, format: 'JSONEachRow',
    }),
  ])
  const anchors = await anchorRes.json<{ holder: string; contract: string; scaled: string }>()
  const deltaRows = await deltaRes.json<{ holder: string; contract: string; b: number; delta: string }>()
  const state = new Map<string, { holder: string; contract: string; anchor: string; deltas: ScaledBalanceBucket[] }>()
  for (const row of anchors) {
    if (BigInt(row.scaled || '0') === 0n) continue
    const key = `${row.holder}:${row.contract}`
    state.set(key, { holder: row.holder, contract: row.contract, anchor: row.scaled, deltas: [] })
  }
  for (const row of deltaRows) {
    const key = `${row.holder}:${row.contract}`
    const entry = state.get(key) ?? { holder: row.holder, contract: row.contract, anchor: '0', deltas: [] }
    entry.deltas.push({ b: Number(row.b), value: row.delta })
    state.set(key, entry)
  }
  if (!state.size) return availableFromBucket

  const tokenByContract = new Map(tokens.map(token => [token.aToken.toLowerCase(), token]))
  const usedTokens = [...new Set([...state.values()].map(entry => tokenByContract.get(entry.contract)).filter(Boolean) as MmReserveToken[])]
  const pools = [...new Set(usedTokens.map(token => token.poolProxy.toLowerCase()))]
  const reserves = [...new Set(usedTokens.map(token => token.asset.toLowerCase()))]
  const indexCut = Math.max(anchorBlock, minBlock)
  const indexRes = await client.query({
    query: `SELECT pool_address AS pool, reserve_address AS reserve,
              toUInt32(least(intDiv(greatest(block_height, {indexCut:UInt32}, {minBlock:UInt32}) - {minBlock:UInt32}, {bucketSize:UInt32}), {lastBucket:UInt32})) AS b,
              toString(argMax(liquidity_index, tuple(block_height,event_index,ingested_at))) AS liquidity_index
            FROM price_data.money_market_reserve_indices FINAL
            WHERE pool_address IN ({pools:Array(String)}) AND reserve_address IN ({reserves:Array(String)})
            GROUP BY pool, reserve, b ORDER BY pool, reserve, b`,
    query_params: { pools, reserves, indexCut, minBlock, bucketSize, lastBucket }, format: 'JSONEachRow',
  })
  const indicesByReserve = new Map<string, ScaledBalanceBucket[]>()
  for (const row of await indexRes.json<{ pool: string; reserve: string; b: number; liquidity_index: string }>()) {
    const key = `${row.pool}:${row.reserve}`
    const series = indicesByReserve.get(key) ?? []
    series.push({ b: Number(row.b), value: row.liquidity_index })
    indicesByReserve.set(key, series)
  }

  for (const entry of state.values()) {
    const token = tokenByContract.get(entry.contract)
    if (!token) continue
    const reserveId = assetIdFromMmAddress(token.asset)
    if (reserveId == null) continue
    const receiptId = UNDERLYING_TO_ATOKEN_ID[reserveId] ?? reserveId
    const displayId = displayAssetId(receiptId)
    const indexSeries = indicesByReserve.get(`${token.poolProxy.toLowerCase()}:${token.asset.toLowerCase()}`)
    if (!indexSeries?.length) continue
    availableFromBucket.set(String(displayId), anchorBucket)
    for (const point of reconstructATokenBalanceBuckets(anchorBucket, lastBucket, entry.anchor, entry.deltas, indexSeries)) {
      rows.push({
        account_id: `${entry.holder}#mm:${entry.contract}`,
        asset_id: String(displayId),
        b: point.b,
        bal: rescaleRaw(point.value, asset(reserveId).decimals, asset(displayId).decimals),
      })
    }
  }
  return availableFromBucket
}

// MM positions are re-snapshotted periodically by the raw indexer (every N
// blocks, every borrower — not just on the borrower's own MM events), so the
// stored net is dense and the series forward-fills only across a short gap before
// the caller pins the final point to the live net worth.
async function getAccountHistory(accounts: string[]): Promise<{ portfolioSeries: number[]; portfolioDates: string[]; portfolioBlocks: number[]; balanceHistory: AssetBalanceHistory[] }> {
  const list = sqlAccountList(accounts)
  if (list === "''") return { portfolioSeries: [], portfolioDates: [], portfolioBlocks: [], balanceHistory: [] }
  // Single ordinary accounts are already selective in the account-first exact
  // history and avoid the merge overhead of the hourly model. Multi-member tags
  // and dense structural accounts are the shapes for which hourly compaction is
  // materially smaller.
  const useAccountBalanceHourly =
    (accounts.length > 4 || accounts.some(account => /^0x(6d6f646c|7369626c|70617261)/.test(account)))
  const prices = await ensurePrices()
  const rangeRes = await client.query({
    query: useAccountBalanceHourly
      ? `SELECT minMerge(first_block_state) AS minb, maxMerge(last_block_state) AS maxb,
          toUnixTimestamp(minMerge(first_timestamp_state)) AS mint,
          toUnixTimestamp(maxMerge(last_timestamp_state)) AS maxt
        FROM price_data.account_balance_hourly WHERE account_id IN (${list})`
      : `SELECT min(block_height) AS minb, max(block_height) AS maxb,
          toUnixTimestamp(min(block_timestamp)) AS mint, toUnixTimestamp(max(block_timestamp)) AS maxt
        FROM price_data.account_balance_history
        WHERE account_id IN (${list})`,
    format: 'JSONEachRow',
  })
  const rng = (await rangeRes.json<{ minb: number; maxb: number; mint: number; maxt: number }>())[0]
  if (!rng || !rng.maxb || rng.maxb <= rng.minb) return { portfolioSeries: [], portfolioDates: [], portfolioBlocks: [], balanceHistory: [] }
  const N = 180
  const BUCKET = Math.max(1, Math.floor((rng.maxb - rng.minb) / N))
  // Real end-of-bucket timestamps from the blocks table. Block time changed from
  // 12s to 6s over the chain's life, so interpolating between the range endpoints
  // mislabels mid-range buckets by months (block 7.19M: real 2025-03, interpolated
  // 2024-09) — wrong hover dates and wrong perf windows. Interpolation remains
  // only as the fallback for buckets with no indexed block.
  const tsRes = await client.query({
    query: `SELECT toUInt32(least(intDiv(block_height - ${rng.minb}, ${BUCKET}), ${N})) AS b, toString(max(block_timestamp)) AS ts
            FROM price_data.blocks WHERE block_height >= ${rng.minb} AND block_height <= ${rng.maxb}
            GROUP BY b`,
    format: 'JSONEachRow',
  })
  const tsByBucket = new Map<number, string>()
  for (const r of await tsRes.json<{ b: number; ts: string }>()) tsByBucket.set(r.b, r.ts)
  const tsInterpolated = (b: number) => { const frac = N > 0 ? b / N : 0; const sec = rng.mint + frac * (rng.maxt - rng.mint); return new Date(sec * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') }
  const tsAt = (b: number) => tsByBucket.get(b) ?? tsInterpolated(b)

  // An hourly close is sufficient unless a dynamic block bucket boundary splits
  // that hour. Fetch the exact block span of only those boundary hours; the
  // balance query below unions their raw observations with hourly closes, so the
  // winner of every original block bucket remains bit-for-bit identical.
  let boundaryBalancePredicate = '0'
  if (useAccountBalanceHourly) {
    const boundaryHeights = Array.from({ length: N }, (_, i) => rng.minb + (i + 1) * BUCKET)
      .filter(height => height <= rng.maxb)
    if (boundaryHeights.length) {
      const boundaryRes = await client.query({
        query: `WITH boundary_hours AS (
            SELECT DISTINCT toStartOfHour(block_timestamp) AS hour FROM price_data.blocks
            WHERE block_height IN (${boundaryHeights.join(',')})
          )
          SELECT min(block_height) AS first,max(block_height) AS last
          FROM price_data.blocks WHERE toStartOfHour(block_timestamp) IN boundary_hours
          GROUP BY toStartOfHour(block_timestamp) ORDER BY first`,
        format: 'JSONEachRow',
      })
      const ranges = await boundaryRes.json<{ first: number; last: number }>()
      if (ranges.length) boundaryBalancePredicate = ranges
        .map(range => `(block_height>=${range.first} AND block_height<=${range.last})`)
        .join(' OR ')
    }
  }

  // Bucket per (account, asset): for a multi-account tag each account's balance
  // must be forward-filled INDEPENDENTLY and only THEN summed per bucket. A single
  // argMax(total) across the whole account list would pick just one account's
  // total per bucket (the one observed latest in that bucket) and drop the others,
  // making the combined series sawtooth as the "winning" account flips bucket to
  // bucket. (For the single-account case this collapses to the original behaviour.)
  const balRes = await client.query({
    query: useAccountBalanceHourly
      ? `SELECT account_id, asset_id,
          toUInt32(least(intDiv(candidate_block - ${rng.minb}, ${BUCKET}), ${N})) AS b,
          toString(argMax(balance, candidate_block)) AS bal
        FROM (
          SELECT account_id, asset_id, interval_start,
            argMaxMerge(balance_state) AS balance,
            argMaxMerge(block_state) AS candidate_block
          FROM price_data.account_balance_hourly
          WHERE account_id IN (${list})
          GROUP BY account_id, asset_id, interval_start
          UNION ALL
          SELECT account_id,asset_id,toDateTime(0) AS interval_start,
            toString(argMax(toUInt256OrZero(total),tuple(block_height,observation_id,ingested_at))) AS balance,
            argMax(block_height,tuple(block_height,observation_id,ingested_at)) AS candidate_block
          FROM price_data.account_balance_history
          WHERE account_id IN (${list}) AND (${boundaryBalancePredicate})
          GROUP BY account_id,asset_id,
            toUInt32(least(intDiv(block_height - ${rng.minb}, ${BUCKET}), ${N}))
        )
        GROUP BY account_id, asset_id, b ORDER BY asset_id, account_id, b`
      : `SELECT account_id, asset_id, toUInt32(least(intDiv(block_height - ${rng.minb}, ${BUCKET}), ${N})) AS b,
          toString(argMax(toUInt256OrZero(total), tuple(block_height, observation_id, ingested_at))) AS bal
        FROM price_data.account_balance_history
        WHERE account_id IN (${list})
        GROUP BY account_id, asset_id, b ORDER BY asset_id, account_id, b`,
    format: 'JSONEachRow',
  })
  // Fold pool-share series into their underlying main asset (2-Pool-GDOT → GDOT),
  // same per-account display rule as foldShareBalances, so no "-Pool" history chart
  // appears and the underlying's series carries the combined balance.
  const balRows: HistoryBalanceRow[] = (await balRes.json<{ account_id: string; asset_id: string; b: number; bal: string }>())
    .map(r => {
      const did = displayAssetId(Number(r.asset_id))
      // Share token and underlying can differ in decimals (2-Pool-PRIME 18 vs PRIME 6);
      // normalise the raw balance to the display asset's scale so the folded series and
      // portfolio value aren't off by 10^Δ (downactivity divides by the display decimals).
      return { ...r, asset_id: String(did), bal: rescaleRaw(r.bal, asset(r.asset_id).decimals, asset(did).decimals) }
    })
  // ERC-20-backed holdings (HOLLAR): balances live in contract storage and never
  // hit raw_balance_observations, so without this the portfolio series shows the
  // value only in the live-pinned final point — a cliff on tag/account charts.
  // Reconstruct per-account cumulative bucket balances from the indexed Transfer
  // logs (verified to reproduce balanceOf exactly) and feed them through the same
  // fold/price/forward-fill pipeline as observed balances.
  for (const ea of ERC20_WALLET_ASSETS) {
    const h160For = new Map<string, string>()
    for (const a of accounts) {
      const h160 = historyH160(a)
      if (h160) h160For.set(h160, a)
    }
    const logRes = await client.query({
      query: `
        SELECT holder AS w,
          toUInt32(least(intDiv(greatest(block_height, ${rng.minb}) - ${rng.minb}, ${BUCKET}), ${N})) AS b,
          toString(sum(balance_delta)) AS net
        FROM price_data.erc20_transfer_deltas FINAL
        WHERE contract_address = {c:String} AND holder IN ({ws:Array(String)})
        GROUP BY w, b ORDER BY w, b`,
      query_params: { c: ea.contract, ws: [...h160For.keys()] }, format: 'JSONEachRow',
    }).catch(() => null)
    if (!logRes) continue
    let cumBy = ''
    let cum = 0n
    for (const r of await logRes.json<{ w: string; b: number; net: string }>()) {
      if (r.w !== cumBy) { cumBy = r.w; cum = 0n }
      cum += BigInt(r.net)
      const accountId = h160For.get(r.w)
      // '#erc20' pseudo-account: the contract pot forward-fills independently of
      // the account's (possibly zero-balance) Tokens-side observations of the
      // same asset and the two sum per bucket like any two tag members.
      if (accountId) balRows.push({ account_id: `${accountId}#erc20`, asset_id: String(ea.assetId), b: r.b, bal: (cum < 0n ? 0n : cum).toString() })
    }
  }
  const mmAvailableFromBucket = await appendMoneyMarketBalanceRows(accounts, rng.minb, BUCKET, N, balRows)
  const assetIds = [...new Set(balRows.map(r => r.asset_id))]
  if (!assetIds.length) return { portfolioSeries: [], portfolioDates: [], portfolioBlocks: [], balanceHistory: [] }
  // Open omnipool LP positions (bare + farmed) for the period LP-value reconstruction
  // below, plus the per-bucket pool state to value them. Fetched here so the position
  // assets + LRNA(1) can be added to the historical price query.
  // True historical Omnipool principal (per-block state + ownership intervals), used
  // instead of the current-shares approximation once its models are complete for the
  // full history. Loaded before the price query so the assets of historically-owned
  // (incl. since-closed) positions are priced, and before openPositions so the
  // fallback reconstruction query is skipped entirely when the new path is active.
  const omniHist = await loadOmnipoolPrincipalHistory(accounts, rng.minb, BUCKET, N)
  const omniAssetIds = omniHist ? omniHist.assetIds : []
  // Historical XYK LP principal (direct wallet shareToken balances + collection-5389 farm
  // deposits) valued at pool NAV. Loaded before the price query so both pool assets are priced.
  const xykHist = await loadXykPrincipalHistory(accounts, assetIds.map(Number), rng.minb, BUCKET, N)
  // aTokens have no price feed of their own — query the underlying reserve's
  // historical prices for them (priceAssetId maps aPRIME→PRIME, etc.).
  const priceIdFor = new Map(assetIds.map(id => [id, String(priceAssetId(Number(id)))]))
  const lpPriceIds = omniAssetIds.length ? [...new Set(omniAssetIds.map(id => String(priceAssetId(id))))].concat(String(LRNA_ASSET_ID)) : []
  const xykPriceIds = xykHist ? xykHist.underlyingAssetIds.map(id => String(priceAssetId(id))) : []
  const priceIds = [...new Set([...priceIdFor.values(), ...lpPriceIds, ...xykPriceIds])]
  // The daily close states are a replay-safe compact projection of prices. The
  // raw table contains a row for every asset at every indexed block; grouping it
  // here used to read hundreds of millions of rows for a single account/tag
  // history.  Use only candles which have fully closed by the bucket timestamp,
  // so a chart point can never see a future price.  This differs by at most one
  // UTC day from the latest raw observation and retains historical (never current)
  // valuation for every bucket.
  const pxRes = await client.query({
    query: `SELECT toString(asset_id) AS asset_id, toString(interval_start) AS ts,
              toFloat64(argMaxMerge(close_state)) AS px
            FROM price_data.ohlc_1d
            WHERE asset_id IN (${priceIds.join(',')})
              AND interval_start >= toStartOfDay({priceStart:DateTime})
              AND interval_start <= toStartOfDay({priceEnd:DateTime})
            GROUP BY asset_id, interval_start ORDER BY asset_id, interval_start`,
    query_params: { priceStart: tsAt(0), priceEnd: tsAt(N) },
    format: 'JSONEachRow',
  })
  const pxRows = await pxRes.json<{ asset_id: string; ts: string; px: number }>()
  const pxByPriceId = new Map<string, Map<number, number>>()
  const dailyByPriceId = new Map<string, { closedAt: number; px: number }[]>()
  const utcMillis = (ts: string) => Date.parse(`${ts.replace(' ', 'T')}Z`)
  for (const r of pxRows) {
    if (!dailyByPriceId.has(r.asset_id)) dailyByPriceId.set(r.asset_id, [])
    dailyByPriceId.get(r.asset_id)!.push({ closedAt: utcMillis(r.ts) + 86_400_000, px: Number(r.px) })
  }
  for (const id of priceIds) {
    const candles = dailyByPriceId.get(id) ?? []
    const byBucket = new Map<number, number>()
    let cursor = 0
    let lastPrice: number | undefined
    for (let b = 0; b <= N; b++) {
      const bucketEnd = utcMillis(tsAt(b))
      while (cursor < candles.length && candles[cursor].closedAt <= bucketEnd) {
        lastPrice = candles[cursor].px
        cursor++
      }
      if (lastPrice != null && lastPrice > 0) byBucket.set(b, lastPrice)
    }
    pxByPriceId.set(id, byBucket)
  }
  // Key the per-bucket price series back by the original (possibly aToken) id.
  const pxByAsset = new Map<string, Map<number, number>>()
  for (const id of assetIds) pxByAsset.set(id, pxByPriceId.get(priceIdFor.get(id)!) ?? new Map())
  // The prices table doesn't reach as far back as the balance range (the feed
  // started after the account's first observation), so leading buckets have no
  // historical price. Back-fill from the earliest known historical price, then
  // carry it forward across interior gaps. Assets with no historical price stay
  // unvalued instead of borrowing a current price.
  const earliestPxByAsset = new Map<string, number>()
  for (const id of assetIds) {
    const m = pxByAsset.get(id)!
    let earliest = 0
    for (let b = 0; b <= N; b++) if (m.has(b)) { earliest = m.get(b)!; break }
    earliestPxByAsset.set(id, earliest)
  }
  // Per (asset, account) bucketed balances — forward-filled per account, summed
  // across accounts per bucket (see balRes comment).
  const balByAcctAsset = new Map<string, Map<string, Map<number, string>>>()
  for (const r of balRows) {
    if (!balByAcctAsset.has(r.asset_id)) balByAcctAsset.set(r.asset_id, new Map())
    const byAcct = balByAcctAsset.get(r.asset_id)!
    if (!byAcct.has(r.account_id)) byAcct.set(r.account_id, new Map())
    const m = byAcct.get(r.account_id)!
    // Two folded ids (a share token + its underlying) can land in the same bucket
    // for one account — sum rather than overwrite so neither balance is dropped.
    m.set(r.b, m.has(r.b) ? (BigInt(m.get(r.b)!) + BigInt(r.bal)).toString() : r.bal)
  }

  // Per asset: forward-fill each account's balance, sum across accounts per bucket,
  // value with the period (back-/forward-filled historical) price, add to portfolio.
  const portfolio = new Array(N + 1).fill(0)
  const balanceHistory: AssetBalanceHistory[] = []
  for (const id of assetIds) {
    const a = asset(id)
    const byAcct = balByAcctAsset.get(id) ?? new Map<string, Map<number, string>>()
    const pxMap = pxByAsset.get(id) ?? new Map<number, number>()
    const earliestPx = earliestPxByAsset.get(id) ?? 0
    // XYK LP token: its balance is decomposed to underlying NAV below, so it must not also
    // contribute a token price to portfolio value (no double count). Still charted for display.
    const suppressPortfolioValue = xykHist?.lpAssetIds.has(Number(id)) ?? false
    // Combined (summed) forward-filled balance per bucket, and a flag for whether
    // ANY account had an observation in that bucket (drives the downsampled points).
    const combined = new Array(N + 1).fill(0)
    const portfolioCombined = new Array(N + 1).fill(0)
    const observedBucket = new Array(N + 1).fill(false)
    for (const [accountId, balMap] of byAcct) {
      let lastBal = 0
      for (let b = 0; b <= N; b++) {
        if (balMap.has(b)) { lastBal = Number(balMap.get(b)) / 10 ** a.decimals; observedBucket[b] = true }
        combined[b] += lastBal
        // Supplied MM reserves are already present in the aggregate collateral
        // snapshots added below; these pseudo-accounts are display-history only.
        if (!accountId.includes('#mm:')) portfolioCombined[b] += lastBal
      }
    }
    let lastPx = earliestPx
    const points: AssetBalancePoint[] = []
    for (let b = 0; b <= N; b++) {
      if (pxMap.has(b)) lastPx = pxMap.get(b)!
      if (!suppressPortfolioValue) portfolio[b] += portfolioCombined[b] * (lastPx || 0)
      // Plot every observed bucket, plus the final bucket so the line is forward-
      // filled to "now" (the balance persists after its last change). This also
      // gives sparsely-observed assets a 2nd point, so they render a real line.
      if (observedBucket[b] || b === N) points.push({ ts: tsAt(b), blockHeight: rng.minb + b * BUCKET, balance: combined[b] })
    }
    // Collapse to one point per calendar day (keep the day's last observation),
    // matching the portfolio series' downsampleDaily so a short window (fewer days
    // than buckets) never plots multiple points on the same date.
    if (points.length) {
      const dailyPoints = downsampleDailyPoints(points)
      if (hasNonZeroVisibleBalance(dailyPoints)) balanceHistory.push({
        asset: a,
        current: combined[N],
        points: dailyPoints,
        ...(mmAvailableFromBucket.has(id) ? { availableFrom: tsAt(mmAvailableFromBucket.get(id)!) } : {}),
      })
    }
  }

  // XYK LP principal on the historical curve, valued at pool NAV: combine the account's
  // direct wallet shareToken balance and its collection-5389 farm-deposit principal per
  // bucket, decompose to underlying reserve legs (integer), value at the bucket's closed
  // price. Replaces the (null) direct-token contribution suppressed above — no double count.
  if (xykHist && xykHist.lpAssetIds.size) {
    const earliestPrice = (m: Map<number, number> | undefined) => { if (m) for (let b = 0; b <= N; b++) if (m.has(b)) return m.get(b)!; return 0 }
    for (const lp of xykHist.lpAssetIds) {
      const state = xykHist.stateByLp.get(lp)
      if (!state) continue
      const farm = xykHist.farmSharesByLp.get(lp) ?? new Array<bigint>(N + 1).fill(0n)
      // Direct wallet shares per bucket: forward-fill the raw shareToken balance across the
      // account's own (non-MM-pseudo) balance series, summed.
      const directRaw = new Array<bigint>(N + 1).fill(0n)
      for (const [accountId, balMap] of balByAcctAsset.get(String(lp)) ?? new Map<string, Map<number, string>>()) {
        if (accountId.includes('#mm:')) continue
        let last = 0n
        for (let b = 0; b <= N; b++) { const v = balMap.get(b); if (v !== undefined) last = BigInt(v); directRaw[b] += last }
      }
      for (let b = 0; b <= N; b++) {
        const st = state[b]
        if (!st) continue
        const shares = directRaw[b] + farm[b]
        if (shares <= 0n) continue
        const { amountA, amountB } = xykShareLegs(shares, st.reserveA, st.reserveB, st.totalShares)
        const pxA = pxByPriceId.get(String(priceAssetId(st.assetA)))
        const pxB = pxByPriceId.get(String(priceAssetId(st.assetB)))
        const priceA = pxA?.get(b) ?? earliestPrice(pxA)
        const priceB = pxB?.get(b) ?? earliestPrice(pxB)
        portfolio[b] += (Number(amountA) / 10 ** asset(st.assetA).decimals) * priceA + (Number(amountB) / 10 ** asset(st.assetB).decimals) * priceB
      }
    }
  }

  // Money-market net worth folded into the portfolio. Each isolated pool is
  // forward-filled independently. Staking-backed collateral (GIGAHDX) is not
  // added here because its locked HDX already lives in the wallet curve; its
  // debt is still deducted.
  // getUserAccountData totals are already indexed per (user, block) in base currency
  // (1e8 = USD); bucket + forward-fill the same way (positions are only written on MM
  // events, so the last known position carries forward until the next event).
  // Bucket per account (not collapsed across the list): each account's MM net must
  // be forward-filled independently then summed, same as balances — otherwise the
  // combined tag series sawtooths.
  const mmRes = await client.query({
    query: `SELECT account_id, lower(pool_address) AS pool,
              toUInt32(least(intDiv(block_height - ${rng.minb}, ${BUCKET}), ${N})) AS b,
              argMax(toFloat64(total_collateral_base), ${moneyMarketPositionOrderSql()}) / 1e8 AS collat,
              argMax(toFloat64(total_debt_base), ${moneyMarketPositionOrderSql()}) / 1e8 AS debt
            FROM price_data.raw_money_market_positions
            WHERE account_id IN (${list}) AND block_height >= ${rng.minb} AND block_height <= ${rng.maxb}
              AND lower(pool_address) IN (${configuredMmPoolsSql()})
            GROUP BY account_id, pool, b ORDER BY account_id, pool, b`,
    format: 'JSONEachRow',
  })
  const mmRows = await mmRes.json<{ account_id: string; pool: string; b: number; collat: number; debt: number }>()
  {
    const mmByPosition = new Map<string, Map<number, { collat: number; debt: number }>>()
    for (const r of mmRows) {
      const key = `${r.account_id}:${r.pool}`
      if (!mmByPosition.has(key)) mmByPosition.set(key, new Map())
      mmByPosition.get(key)!.set(r.b, { collat: r.collat, debt: r.debt })
    }
    // Carry-in per account: last position established before the window opens.
    const carryRes = await client.query({
      query: `SELECT account_id, lower(pool_address) AS pool,
                argMax(toFloat64(total_collateral_base), ${moneyMarketPositionOrderSql()}) / 1e8 AS collat,
                argMax(toFloat64(total_debt_base), ${moneyMarketPositionOrderSql()}) / 1e8 AS debt
              FROM price_data.raw_money_market_positions
              WHERE account_id IN (${list}) AND block_height < ${rng.minb}
                AND lower(pool_address) IN (${configuredMmPoolsSql()})
              GROUP BY account_id, pool`,
      format: 'JSONEachRow',
    })
    const carryByPosition = new Map<string, { pool: string; collat: number; debt: number }>()
    for (const r of await carryRes.json<{ account_id: string; pool: string; collat: number; debt: number }>()) {
      carryByPosition.set(`${r.account_id}:${r.pool}`, { pool: r.pool, collat: r.collat, debt: r.debt })
    }
    // Combined MM net per bucket (sum of per-account, per-market forward-fills).
    const mmNet = new Array<number>(N + 1).fill(0)
    const positionKeys = new Set([...mmByPosition.keys(), ...carryByPosition.keys()])
    const countedPools = new Set(MM_MARKETS.filter(m => !m.stakingBacked).map(m => m.poolProxy))
    for (const key of positionKeys) {
      const byBucket = mmByPosition.get(key) ?? new Map<number, { collat: number; debt: number }>()
      const carry = carryByPosition.get(key)
      const pool = carry?.pool ?? key.slice(key.lastIndexOf(':') + 1)
      let lastCollat = carry?.collat ?? 0, lastDebt = carry?.debt ?? 0
      for (let b = 0; b <= N; b++) {
        const v = byBucket.get(b)
        if (v) { lastCollat = v.collat; lastDebt = v.debt }
        mmNet[b] += (countedPools.has(pool) ? lastCollat : 0) - lastDebt
      }
    }
    // Forward-fill the combined MM net to the end (the position persists between
    // snapshots); the caller pins the final point to the live net worth, so the
    // only un-sampled span is the short tail since the last periodic snapshot.
    for (let b = 0; b <= N; b++) portfolio[b] += mmNet[b]
  }

  // Omnipool LP principal on the historical curve, valued at WITHDRAW value (asset +
  // LRNA/hub legs) per bucket from true per-block position state, ownership intervals,
  // and compact pool state — never current shares or request-time snapshot JSON. When
  // loadOmnipoolPrincipalHistory returns null, Omnipool value is omitted rather than
  // approximated (explicit incompleteness).
  if (omniHist) {
    const lrnaPx = pxByPriceId.get(String(LRNA_ASSET_ID))
    const lrnaDec = asset(LRNA_ASSET_ID).decimals
    const earliest = (m: Map<number, number> | undefined) => { if (m) for (let b = 0; b <= N; b++) if (m.has(b)) return m.get(b)!; return 0 }
    const fallbackLrna = earliest(lrnaPx)
    const earliestByPrice = new Map<string, number>()
    const earliestFor = (priceId: string) => { const c = earliestByPrice.get(priceId); if (c !== undefined) return c; const e = earliest(pxByPriceId.get(priceId)); earliestByPrice.set(priceId, e); return e }
    for (let b = 0; b <= N; b++) {
      const lrna = lrnaPx?.get(b) ?? fallbackLrna
      for (const leg of omniHist.legsByBucket[b]) {
        const priceId = String(priceAssetId(leg.assetId))
        const px = pxByPriceId.get(priceId)
        const price = px?.get(b) ?? earliestFor(priceId)
        const aDec = asset(leg.assetId).decimals
        portfolio[b] += (Number(leg.liquidity) / 10 ** aDec) * price + (Number(leg.hub) / 10 ** lrnaDec) * lrna
      }
    }
  }

  // Drop leading zero buckets, keep a clean series.
  let start = 0; while (start < portfolio.length - 1 && portfolio[start] === 0) start++
  const alignedBalanceHistory = alignBalanceHistoryDailyPoints(balanceHistory)
  alignedBalanceHistory.sort((x, y) => (y.current * (prices.get(y.asset.assetId)?.price ?? 0)) - (x.current * (prices.get(x.asset.assetId)?.price ?? 0)))
  const rawSeries = portfolio.slice(start).map(v => +v.toFixed(2))
  const rawDates = Array.from({ length: portfolio.length - start }, (_, k) => tsAt(start + k))
  // End-of-bucket block per point: bucket b covers [minb + b·BUCKET, minb + (b+1)·BUCKET)
  // (the final bucket absorbs the tail to maxb), so the events a point-to-point
  // delta reflects live in the half-open block span between the two end blocks.
  const rawBlocks = Array.from({ length: portfolio.length - start }, (_, k) => {
    const b = start + k
    return b >= N ? rng.maxb : rng.minb + (b + 1) * BUCKET - 1
  })
  // Collapse to one point per calendar day (keep the latest of each day) so the
  // chart never shows the same date on adjacent points when the window spans
  // fewer days than buckets. Long windows (≫70 days) are unaffected.
  const { series: portfolioSeries, dates: portfolioDates, blocks: portfolioBlocks } = downsampleDaily(rawSeries, rawDates, rawBlocks)
  // Return every asset that has a historical balance (sorted by current value),
  // not just the top N — the per-asset chip list should be complete.
  return { portfolioSeries, portfolioDates, portfolioBlocks, balanceHistory: alignedBalanceHistory }
}

// One point per calendar day (the last bucket of each day), preserving order.
function downsampleDaily(series: number[], dates: string[], blocks: number[]): { series: number[]; dates: string[]; blocks: number[] } {
  const outS: number[] = [], outD: string[] = [], outB: number[] = []
  for (let i = 0; i < series.length; i++) {
    const day = (dates[i] ?? '').slice(0, 10)
    if (outD.length && outD[outD.length - 1].slice(0, 10) === day) {
      outS[outS.length - 1] = series[i]; outD[outD.length - 1] = dates[i]; outB[outB.length - 1] = blocks[i]
    } else {
      outS.push(series[i]); outD.push(dates[i]); outB.push(blocks[i])
    }
  }
  return { series: outS, dates: outD, blocks: outB }
}

// One bucketed value-series reconstruction per scope (`addr:<id>` / `tag:<id>`),
// shared by the value-history chart and the value-event jump detection so the
// heavy per-asset walk runs once per TTL, not once per consumer.
function getAccountHistoryShared(accounts: string[], scopeKey: string): Promise<Awaited<ReturnType<typeof getAccountHistory>>> {
  return cached(`explorer:account-history:${accountValueGenerationEpoch}:${scopeKey}`, 120_000, () => getAccountHistory(accounts))
}

// Per-asset analogue of downsampleDaily: one balance point per calendar day (the
// day's last observation), preserving order, so the per-asset balance chart matches
// the portfolio series' one-point-per-day cadence.
function downsampleDailyPoints(points: AssetBalancePoint[]): AssetBalancePoint[] {
  const out: AssetBalancePoint[] = []
  for (const p of points) {
    const day = p.ts.slice(0, 10)
    if (out.length && out[out.length - 1].ts.slice(0, 10) === day) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

export function hasNonZeroVisibleBalance(points: AssetBalancePoint[]): boolean {
  return points.some(p => Number.isFinite(p.balance) && p.balance > 0)
}

export function alignBalanceHistoryDailyPoints(history: AssetBalanceHistory[]): AssetBalanceHistory[] {
  const visible = history.filter(h => hasNonZeroVisibleBalance(h.points))
  if (!visible.length) return []

  const axisByDay = new Map<string, AssetBalancePoint>()
  for (const h of visible) {
    for (const p of h.points) {
      const day = p.ts.slice(0, 10)
      const existing = axisByDay.get(day)
      if (!existing || p.ts > existing.ts) axisByDay.set(day, p)
    }
  }

  const axis = [...axisByDay.values()].sort((a, b) => a.ts.localeCompare(b.ts))
  let start = 0
  while (
    start < axis.length - 1 &&
    !visible.some(h => h.points.some(p => p.ts.slice(0, 10) === axis[start].ts.slice(0, 10) && Number.isFinite(p.balance) && p.balance > 0))
  ) {
    start++
  }
  const trimmedAxis = axis.slice(start)

  return visible.map(h => {
    const byDay = new Map<string, AssetBalancePoint>()
    for (const p of h.points) byDay.set(p.ts.slice(0, 10), p)

    let lastBalance = 0
    const points = trimmedAxis.map(axisPoint => {
      const p = byDay.get(axisPoint.ts.slice(0, 10))
      if (p) lastBalance = p.balance
      return {
        ts: axisPoint.ts,
        blockHeight: axisPoint.blockHeight,
        balance: lastBalance,
      }
    })

    return { ...h, points }
  }).filter(h => hasNonZeroVisibleBalance(h.points))
}

// Account-scoped activity: the account's own trades (summarized per extrinsic) +
// genuine transfers (from balance observations, excluding swap legs / pool
// counterparties). Used on the account & tag pages instead of raw per-asset
// balance-change rows.
async function getAccountActivity(accounts: string[], limit: number, type = 'all', offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[]> {
  type = normalizeActivityTypeKey(type)
  const tw = timeWindow(from, to)
  const bound = tw ?? '1'
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  const related = new Set(accounts.map(a => a.toLowerCase()))
  const prices = await ensurePrices()
  const tokenIds = assetIdsForToken(filters.token)
  // Joining hourly prices below each source's LIMIT forces ClickHouse to value
  // the entire account history. Pull bounded account-first candidates first;
  // applyHistoricalUsd then records the same exact Decimal/BigInt value used by
  // activityRowMatchesFilters.
  const queryFilters = filters.min != null && filters.unit !== 'token'
    ? { ...filters, min: undefined, unit: undefined }
    : filters
  // When a single category is requested we paginate within it, so fetch enough
  // rows to cover the requested page (offset+limit) plus headroom for de-dup.
  const want = offset + limit
  const catFetch = Math.max(want * 5, 1000)
  const wantTransfers = type === 'all' || type === 'transfer'
  // Classification context: Transfers excludes trade/staking/MM legs, Trades
  // yields share-routed legs to Liquidity — fetch what the exclusions need.
  const wantTrades = type === 'all' || type === 'trade' || wantTransfers
  const wantDca = type === 'all' || type === 'trade' || wantTransfers
  const wantLiquidity = type === 'all' || type === 'liquidity' || wantTrades
  const wantMm = type === 'all' || type === 'mm' || wantTransfers
  // otc folds under the trade chip/type — fetch it whenever trade is (wantTrades
  // already implies wantTransfers), plus its own `type=otc` request.
  const wantOtc = type === 'all' || type === 'otc' || wantTrades
  const wantXcm = type === 'all' || type === 'xcm' || wantTransfers
  const wantStaking = type === 'all' || type === 'staking' || wantTransfers
  const wantVotes = type === 'all' || type === 'vote' || wantTransfers
  // 1. The account's signed swaps. Signer scope and value predicates are joined
  // before LIMIT so a rare token/value match cannot sit beyond a signer window.
  // Extrinsics that actually emitted a swap — their transfer legs (hops/fee) are
  // swap noise and get dropped from the transfer feed. Built from the swap events
  // below, NOT from every signed extrinsic: a plain Balances.transfer_allow_death
  // signed by the account (incl. member→member within a tag) is a genuine transfer
  // and must NOT be filtered out.
  const tradeExt = new Set<string>()
  const trades: ActivityRow[] = []
  if (wantTrades || wantTransfers) {
    const swapTokenFilter = tokenIds == null ? '' : tokenIds.length
      ? `AND (asset_in IN (${tokenIds.join(',')}) OR asset_out IN (${tokenIds.join(',')}))`
      : 'AND 0'
    const swapAssetExpr = 'asset_out'
    const swapAmountExpr = 'amount_out'
    const swapTimeExpr = 'block_timestamp'
    const swapAmountFilter = eventValueFilterSql(swapAssetExpr, swapAmountExpr, swapTimeExpr, queryFilters, prices, 'account_trade_price')
    const swapRes = await client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
          asset_in, asset_out, amount_in, amount_out, signer
          FROM price_data.account_swap_activity FINAL
          ${swapAmountFilter.joinSql}
          WHERE ${bound} AND account IN (${list})
          ${swapTokenFilter}
          ${swapAmountFilter.predicateSql}
          ORDER BY block_height DESC, extrinsic_index DESC, event_name IN (${ROUTER_NET_EVENTS_SQL}) DESC, event_index DESC
          LIMIT 1 BY block_height, extrinsic_index
          LIMIT {n:UInt32}`,
      query_params: { n: catFetch }, format: 'JSONEachRow',
    })
    const swapRows = await swapRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number; event_name: string; asset_in: number; asset_out: number; amount_in: string; amount_out: string; signer: string }>()
    const liqExt = await liquidationExtrinsics(swapRows.map(r => [r.block_height, r.extrinsic_index] as [number, number | null]))
    const signerByExt = new Map(swapRows.map(e => [`${e.block_height}:${e.extrinsic_index}`, e.signer]))
    const groups = new Map<string, typeof swapRows>()
    const order: string[] = []
    for (const r of swapRows) { const k = `${r.block_height}:${r.extrinsic_index}`; if (!groups.has(k)) { groups.set(k, []); order.push(k) } groups.get(k)!.push(r) }
    for (const k of order) {
      // Mark the extrinsic as a swap (so its transfer legs are dropped as noise),
      // but don't emit a trade row for a liquidation's internal collateral→debt
      // swap — the liquidation shows as its mm row, not a user trade.
      tradeExt.add(k)
      if (liqExt.has(k)) continue
      if (!wantTrades) continue
      const g = groups.get(k)!
      const rep = g.find(r => isRouterNet(r.event_name)) ?? g[0]
      const who = signerByExt.get(k)
      const aOut = asset(rep.asset_out)
      const row: ActivityRow = {
        type: 'trade', blockHeight: rep.block_height, timestamp: rep.ts, eventIndex: rep.event_index, extrinsicIndex: rep.extrinsic_index,
        who: who ? accountRef(who) : null, to: null, asset: null, assetIn: asset(rep.asset_in), assetOut: aOut,
        amount: null, amountIn: rep.amount_in, amountOut: rep.amount_out,
        valueUsd: usdValue(prices, aOut.assetId, rep.amount_out, aOut.decimals),
        linkBlock: rep.block_height, linkIndex: rep.extrinsic_index,
      }
      trades.push(row)
    }
  }

  const otc = wantOtc ? await getRecentOtc(catFetch, from, to, 0, queryFilters, type === 'otc' ? action : undefined, accounts) : []
  const otcExt = activityExtrinsicSet(otc)

  // 2. Genuine user↔user transfers, queried directly from the transfer events
  // (account-keyed on `from`/`to`). Deriving these from raw_balance_observations
  // was wrong for active accounts: the observation feed is dominated by fee/swap
  // legs (transfers to/from `0x6d6f646c…` module accounts — treasury, routerex,
  // omnipool), so a recency LIMIT on it never reached the rare genuine transfers
  // on highly active accounts. Filtering pallet/pool/fee legs and trade legs in SQL,
  // keyed on the account, surfaces them regardless of how active the account is.
  // Balances.Transfer is the native asset (id 0); Tokens/Currencies carry currencyId.
  const transfers: ActivityRow[] = []
  let transferSourceSaturated = false
  const accCond = [...related].filter(a => ACCOUNT_RE.test(a))
  if (wantTransfers && accCond.length) {
    const accList = accCond.map(a => `'${a}'`).join(',')
    const transferAssetExpr = transferAssetIdSql()
    const transferTokenFilter = assetIdFilterSql(transferAssetExpr, tokenIds)
    const transferAmountFilter = eventValueFilterSql(transferAssetExpr, `JSONExtractString(args_json,'amount')`, 'block_timestamp', queryFilters, prices, 'account_transfer_price')
    // Prune to the account's own (block, event) refs before the JSON conditions
    // — turns the per-account full scan of raw_events into a point-range read.
    // Module transfers stay in the refs: pot legs are filtered per-pot below
    // (a treasury donation IS the account's transfer; only swap/fee plumbing
    // pots are dropped).
    const useTransferReadModel = tokenIds == null && queryFilters.min == null
    const transferRefsFilter = !useTransferReadModel && tokenIds == null && queryFilters.min == null
      ? `AND ${accountActivityRefsSql(accList, `event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')`, bound, catFetch * 3)}`
      : ''
    // Supply/withdraw/borrow/repay move tokens between the user and a money-
    // market contract; those extrinsics already activity as `mm` rows, so their
    // transfer legs would duplicate them. Excluded by counterparty — UNLESS the
    // viewed account IS a reserve contract, whose page is exactly those legs.
    const mmAccounts = await mmReserveAccountIds()
    const viewingMmContract = accCond.some(a => mmAccounts.has(a))
    const mmList = [...mmAccounts].map(a => `'${a}'`).join(',')
    const mmLegFilter = !viewingMmContract && mmList
      ? `AND JSONExtractString(args_json,'from') NOT IN (${mmList}) AND JSONExtractString(args_json,'to') NOT IN (${mmList})`
      : ''
    const transferReadModelMmLegFilter = !viewingMmContract && mmList
      ? `AND from_account NOT IN (${mmList}) AND to_account NOT IN (${mmList})`
      : ''
    const poolAccs = ammPoolAccounts()
    const viewingPool = accCond.some(a => poolAccs.has(a))
    const poolLegFilter = !viewingPool && poolAccs.size
      ? `AND JSONExtractString(args_json,'from') NOT IN (${[...poolAccs].map(a => `'${a}'`).join(',')}) AND JSONExtractString(args_json,'to') NOT IN (${[...poolAccs].map(a => `'${a}'`).join(',')})`
      : ''
    const transferReadModelPoolLegFilter = !viewingPool && poolAccs.size
      ? `AND from_account NOT IN (${[...poolAccs].map(a => `'${a}'`).join(',')}) AND to_account NOT IN (${[...poolAccs].map(a => `'${a}'`).join(',')})`
      : ''
    // The noisy-pot legs are plumbing on a NORMAL account's page, but when the
    // viewed account IS one of those pots (fee processor, omnipool, router) they
    // ARE its activity — otherwise every row is dropped and the page is empty
    // while the tab count is large. Mirror the viewingPool/viewingMmContract
    // exception and skip the noisy-pot exclusion in that case.
    const viewingNoisyPot = accCond.some(a => NOISY_TRANSFER_POTS.includes(a))
    const rawNoisyPotFilter = viewingNoisyPot ? '' :
      `AND JSONExtractString(args_json,'from') NOT IN (${noisyPotList()}) AND JSONExtractString(args_json,'to') NOT IN (${noisyPotList()})`
    const readModelNoisyPotFilter = viewingNoisyPot ? '' :
      `AND from_account NOT IN (${noisyPotList()}) AND to_account NOT IN (${noisyPotList()})`
    const trRes = await client.query({
      query: useTransferReadModel
        ? `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                from_account AS from_acc, to_account AS to_acc, amount, asset_id
              FROM price_data.account_transfer_activity
              WHERE account IN (${accList}) AND ${bound}
                AND (from_account IN (${accList}) OR to_account IN (${accList}))
                ${readModelNoisyPotFilter}
                AND NOT match(from_account, '^0x(7369626c|70617261|506172656e74)')
                AND NOT match(to_account, '^0x(7369626c|70617261|506172656e74)')
                ${transferReadModelPoolLegFilter}
                ${transferReadModelMmLegFilter}
              ORDER BY block_height DESC, event_index DESC LIMIT {n:UInt32}`
        : `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                JSONExtractString(args_json,'from') AS from_acc,
                JSONExtractString(args_json,'to') AS to_acc,
                JSONExtractString(args_json,'amount') AS amount,
                ${transferAssetExpr} AS asset_id
              FROM price_data.raw_events
              ${transferAmountFilter.joinSql}
              WHERE ${bound}
                ${transferRefsFilter}
                AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')
                AND (JSONExtractString(args_json,'from') IN (${accList}) OR JSONExtractString(args_json,'to') IN (${accList}))
                ${rawNoisyPotFilter}
                AND NOT match(JSONExtractString(args_json,'from'), '^0x(7369626c|70617261|506172656e74)')
                AND NOT match(JSONExtractString(args_json,'to'), '^0x(7369626c|70617261|506172656e74)')
                ${poolLegFilter}
                ${mmLegFilter}
                ${transferTokenFilter}
                ${transferAmountFilter.predicateSql}
              ORDER BY block_height DESC, event_index DESC
              LIMIT {n:UInt32}`,
      query_params: { n: catFetch }, format: 'JSONEachRow',
    })
    const rawTransferRows = await trRes.json<RawTransferEventRow>()
    transferSourceSaturated = accountTransferWindowSaturated(rawTransferRows.length, catFetch, false)
    // The activity-index prefilter is intentionally wider than the requested
    // semantic page. If all of those refs were plumbing, the filtered raw read
    // can underfill even though older account transfer refs remain; preserve
    // that saturation signal so the caller fails explicitly instead of
    // declaring a false end of history.
    if (!transferSourceSaturated && transferRefsFilter) {
      const moreRefs = await client.query({
        query: `SELECT 1 FROM (
                  SELECT block_height, event_index
                  FROM price_data.account_activity
                  WHERE account IN (${accList}) AND ${bound}
                    AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')
                  GROUP BY block_height, event_index
                  ORDER BY block_height DESC, event_index DESC
                  LIMIT 1 OFFSET {skip:UInt32}
                )`,
        query_params: { skip: catFetch * 3 }, format: 'JSONEachRow',
      })
      transferSourceSaturated = accountTransferWindowSaturated(
        rawTransferRows.length,
        catFetch,
        (await moreRefs.json<Record<string, number>>()).length > 0,
      )
    }
    // Transfers *to* the treasury pot are fees/deposits unless the originating
    // extrinsic is itself a token-transfer call — surface only genuine donations
    // (payouts *from* the treasury are unaffected). Skipped when the viewed
    // account IS the treasury, whose page is exactly those legs.
    const viewingTreasury = accCond.includes(TREASURY_POT)
    const treasuryTransferOk = viewingTreasury ? new Set<string>()
      : await transferCallExtrinsics(rawTransferRows.filter(r => r.to_acc === TREASURY_POT).map(r => [r.block_height, r.extrinsic_index] as [number, number | null]))
    const seenTr = new Set<string>()
    for (const r of dedupeTransferEvents(rawTransferRows)) {
      const key = `${r.block_height}:${r.event_index}`
      if (seenTr.has(key)) continue
      seenTr.add(key)
      // Drop transfers that are a leg of one of our own signed trades or OTC
      // fills (swap/settlement noise).
      if (r.extrinsic_index != null && (tradeExt.has(`${r.block_height}:${r.extrinsic_index}`) || otcExt.has(`${r.block_height}:${r.extrinsic_index}`))) continue
      // A transfer to the treasury that is not itself a transfer call is a
      // fee/deposit (register_code, an XCM inherent, a non-swap batch fee), not a
      // user transfer.
      if (!viewingTreasury && r.to_acc === TREASURY_POT
        && !(r.extrinsic_index != null && treasuryTransferOk.has(`${r.block_height}:${r.extrinsic_index}`))) continue
      const a = asset(r.asset_id)
      transfers.push({
        type: 'transfer', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
        who: r.from_acc ? accountRef(r.from_acc) : null,
        to: r.to_acc ? accountRef(r.to_acc) : null, asset: a, assetIn: null, assetOut: null,
        amount: r.amount, amountIn: null, amountOut: null,
        valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
        linkBlock: r.block_height, linkIndex: r.extrinsic_index,
      })
    }
  }

  // 3. DCA executions where this account is the owner. DCA trades run in unsigned
  // block hooks, so they never show up as the account's signed extrinsics (step 1)
  // — the owner is carried by DCA.TradeExecuted {who,id,amountIn,amountOut}. Resolve
  // the traded assets from the swap leg in the same block (match amountIn) and link
  // to the DCA.Scheduled extrinsic. Mirrors the global activity's DCA handling.
  const dcaTrades: ActivityRow[] = wantDca
    ? await getRecentDcaFailures(catFetch, from, to, accounts, tokenIds)
    : []
  if (wantDca) {
    const dcaTokenFilter = tokenIds == null ? '' : tokenIds.length
      ? `AND (s.asset_in IN (${tokenIds.join(',')}) OR s.asset_out IN (${tokenIds.join(',')}))`
      : 'AND 0'
    const dcaValueFilter = eventValueFilterSql('s.asset_out', 'e.amount_out', 'e.block_timestamp', queryFilters, prices, 'account_dca_price')
    const dcaExecRes = await client.query({
      query: `SELECT e.block_height, toString(e.block_timestamp) AS ts, e.who AS who,
                toString(e.id) AS id, e.amount_in, e.amount_out
              FROM price_data.dca_events e
              ANY LEFT JOIN price_data.dca_schedules s ON s.id = e.id
              ${dcaValueFilter.joinSql}
              WHERE ${bound.replaceAll('block_height', 'e.block_height').replaceAll('block_timestamp', 'e.block_timestamp')}
                AND e.event_name='DCA.TradeExecuted' AND e.who IN (${list})
                ${dcaTokenFilter} ${dcaValueFilter.predicateSql}
              ORDER BY e.block_height DESC LIMIT {n:UInt32}`,
      query_params: { n: catFetch },
      format: 'JSONEachRow',
    })
    const dcaExecs = await dcaExecRes.json<{ block_height: number; ts: string; who: string; id: string; amount_in: string; amount_out: string }>()
    if (dcaExecs.length) {
    const blocks = [...new Set(dcaExecs.map(d => d.block_height))].join(',')
    const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
    const [swapRes, schedById] = await Promise.all([
      client.query({
        query: `SELECT block_height, event_index, event_name, JSONExtractInt(args_json,'assetIn') AS asset_in, JSONExtractInt(args_json,'assetOut') AS asset_out,
                  JSONExtractString(args_json,'amountIn') AS amount_in
                FROM price_data.raw_events WHERE block_height IN (${blocks}) AND event_name IN (${names})`,
        format: 'JSONEachRow',
      }),
      getDcaScheduleLinks(dcaExecs.map(d => d.id)),
    ])
    // Match the swap leg by block+amountIn (prefer Router.Executed — the net summary).
    const swapByKey = new Map<string, { event_index: number; asset_in: number; asset_out: number }>()
    for (const s of await swapRes.json<{ block_height: number; event_index: number; event_name: string; asset_in: number; asset_out: number; amount_in: string }>()) {
      const k = `${s.block_height}:${s.amount_in}`
      if (!swapByKey.has(k) || isRouterNet(s.event_name)) swapByKey.set(k, { event_index: s.event_index, asset_in: s.asset_in, asset_out: s.asset_out })
    }
    for (const d of dcaExecs) {
      const sw = swapByKey.get(`${d.block_height}:${d.amount_in}`)
      const aIn = sw ? asset(sw.asset_in) : null
      const aOut = sw ? asset(sw.asset_out) : null
      const sched = schedById.get(d.id)
      const row: ActivityRow = {
        type: 'trade', blockHeight: d.block_height, timestamp: d.ts, eventIndex: sw?.event_index ?? null, extrinsicIndex: null,
        who: accountRef(d.who), to: null, asset: null, assetIn: aIn, assetOut: aOut,
        amount: null, amountIn: d.amount_in, amountOut: d.amount_out,
        valueUsd: aOut ? usdValue(prices, aOut.assetId, d.amount_out, aOut.decimals) : null,
        dca: true, dcaScheduleId: Number(d.id) || undefined, linkBlock: sched?.block ?? d.block_height, linkIndex: sched?.idx ?? null,
      }
      dcaTrades.push(row)
    }
    }
  }

  // 4. Liquidity provision/removal by this account (Omnipool / Stableswap / XYK).
  // Filtering by who=account excludes the routerex pallet's swap-internal pool ops,
  // leaving only genuine user LP actions. Omnipool carries the provided asset; for
  // Stableswap/XYK we key the row on the pool's share asset (poolId / assetA).
  const liq: ActivityRow[] = []
  // Extrinsics with liquidity events: their transfer legs (pool deposits/
  // withdrawals, pool seeding, ED fee) are represented by the liquidity row —
  // not standalone transfers. Pool accounts are blake2-derived, so no prefix
  // rule catches them; keying on the extrinsic does.
  const liqCreateExt = new Set<string>()
  if (wantLiquidity) {
    const liquidityAssetExpr = 'asset_id'
    // Row inclusion matches every asset the event references (XYK assetB, Stableswap
    // nested assets[]), even though the displayed asset_id stays the representative
    // liquidityAssetExpr — else this account's HOLLAR Stableswap LP rows drop out.
    const liquidityTokenFilter = tokenIds == null ? '' : tokenIds.length ? `AND hasAny(asset_refs, [${tokenIds.join(',')}])` : 'AND 0'
    const fetchLiquidityPage = async (pageBound: string, pageLimit: number): Promise<ActivityRow[]> => {
      const liqRes = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                who AS who,
                ${liquidityAssetExpr} AS asset_id,
                amount AS amount,
                asset_b AS asset_b,
                pool_account AS pool_acc
              FROM price_data.liquidity_activity
              WHERE ${pageBound}
                AND event_name IN ('Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed')
                AND who IN (${list})
                ${liquidityTokenFilter}
              ORDER BY block_height DESC, event_index DESC LIMIT {n:UInt32}`,
        query_params: { n: pageLimit },
        format: 'JSONEachRow',
      })
      const liqRows = await liqRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; who: string; asset_id: number; amount: string; asset_b: number; pool_acc: string }>()
      await fillMissingLiquidityAmounts(liqRows)
      const built: ActivityRow[] = []
      const liqCreateCands: { row: ActivityRow; pool: string; assetB: number }[] = []
      for (const r of liqRows) {
        const a = asset(r.asset_id)
        const row: ActivityRow = {
          type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: r.who ? accountRef(r.who) : accounts[0] ? accountRef(accounts[0]) : null, to: null, asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
          liqAction: liqActionFor(r.event_name),
          linkBlock: r.block_height, linkIndex: r.extrinsic_index,
        }
        if (r.event_name === 'XYK.PoolCreated') liqCreateCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
        built.push(row)
      }
      await enrichPoolCreations(liqCreateCands)
      await applyHistoricalUsd(built, activityHistPick)
      return built
    }
    const liqRows = queryFilters.min != null
      ? await fetchFilteredDeep(tw, want, fetchLiquidityPage,
        row => activityRowMatchesFilters(row, { min: queryFilters.min, unit: queryFilters.unit }),
        row => row.blockHeight, row => row.eventIndex ?? -1,
        row => `${row.blockHeight}:${row.eventIndex}`)
      : await fetchLiquidityPage(bound, catFetch)
    for (const row of liqRows) {
      if (row.extrinsicIndex != null) liqCreateExt.add(`${row.blockHeight}:${row.extrinsicIndex}`)
      liq.push(row)
    }
  }

  // 5. Money-market transactions (supply / borrow / repay / withdraw / liquidation).
  // These are EVM-side, indexed under the account's truncated-H160 form.
  const mmTx: ActivityRow[] = []
  const evmForms = [...new Set(accounts.map(evmAccountForm).filter(Boolean) as string[])]
  const mmEventNames = moneyMarketEventNames(type === 'mm' ? action : undefined)
  if (wantMm && evmForms.length && mmEventNames.length) {
    const mmList = evmForms.map(a => `'${a}'`).join(',')
    const reserveFilter = tokenIds == null ? '' : tokenIds.length
      ? `AND asset_address IN (${[...new Set(tokenIds.flatMap(mmReserveAddressForAsset))].map(a => `'${a}'`).join(',')})`
      : 'AND 0'
    const mmAssetExpr = mmAssetIdSql('asset_address')
    const mmAmountExpr = `if(event_name='LiquidationCall', liquidated_collateral_amount, amount)`
    const mmValueFilter = eventValueFilterSql(mmAssetExpr, mmAmountExpr, 'block_timestamp', queryFilters, prices, 'account_mm_price')
    const mmTxRes = await client.query({
      query: `SELECT block_height, event_index, toString(block_timestamp) AS ts, event_name, account_id, asset_address, pool_address,
                ${mmAmountExpr} AS amount
              FROM price_data.account_money_market_activity FINAL
              ${mmValueFilter.joinSql}
              WHERE ${bound} AND account_id IN (${mmList}) AND event_name IN (${mmEventNames.map(n => `'${n}'`).join(',')})
                AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})
                ${reserveFilter}
                ${mmValueFilter.predicateSql}
              ORDER BY block_height DESC LIMIT {n:UInt32}`,
      query_params: { n: catFetch },
      format: 'JSONEachRow',
    })
    const mmEv = await mmTxRes.json<{ block_height: number; event_index: number; ts: string; event_name: string; account_id: string | null; asset_address: string; pool_address: string | null; amount: string }>()
    // MM events are EVM logs (Ethereum.transact); resolve the substrate extrinsic
    // that emitted them so the row links/hovers to its extrinsic like the others.
    const mmExt = await extrinsicIndexFor(mmEv.map(r => [r.block_height, r.event_index] as [number, number | null]))
    for (const r of mmEv) {
      const aid = assetIdFromMmAddress(r.asset_address)
      const a = aid != null ? asset(aid) : null
      const xi = mmExt.get(`${r.block_height}:${r.event_index}`) ?? null
      const row: ActivityRow = {
        type: 'mm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: xi,
        who: r.account_id ? accountRef(r.account_id) : accounts[0] ? accountRef(accounts[0]) : null, to: null, asset: a, assetIn: null, assetOut: null,
        amount: r.amount, amountIn: null, amountOut: null,
        valueUsd: a ? usdValue(prices, a.assetId, r.amount, a.decimals) : null,
        mmAction: r.event_name, ...moneyMarketActivityFields(r.pool_address), linkBlock: r.block_height, linkIndex: xi,
      }
      mmTx.push(row)
    }
  }

  // 6. Cross-chain (XCM) transfers sent (outbound) or received (inbound) by this account.
  const xcm = wantXcm
    ? (await Promise.all([getRecentXcm(catFetch, from, to, accounts, 0, queryFilters), getRecentXcmIn(catFetch, from, to, accounts, 0, queryFilters), getRecentXcmOutRemote(catFetch, from, to, accounts, 0, queryFilters)])).flat()
    : []
  const staking = wantStaking ? await getRecentStaking(catFetch, from, to, accounts, 0, queryFilters, undefined, action) : []
  const voteRows: ActivityRow[] = wantVotes ? (await getRecentVotes(catFetch, from, to, 0, {}, accounts, queryFilters)).map(v => ({
    type: 'vote', blockHeight: v.blockHeight, timestamp: v.timestamp, eventIndex: v.eventIndex, extrinsicIndex: v.extrinsicIndex,
    who: v.account, to: null, asset: v.asset, assetIn: null, assetOut: null, amount: v.amount, amountIn: null, amountOut: null, valueUsd: v.valueUsd,
    votePallet: v.pallet, voteAction: v.action, voteRef: v.referendum, voteSide: v.side, voteConviction: v.conviction,
    linkBlock: v.blockHeight, linkIndex: v.extrinsicIndex,
  })) : []
  const rewards = (type === 'all' || type === 'transfer' || type === 'liquidity' || type === 'mm')
    ? await getRecentRewardClaims(catFetch, from, to, accounts, tokenIds, undefined, undefined, queryFilters)
    : []
  if (filters.min != null && filters.unit !== 'token') {
    await applyHistoricalUsd([...trades, ...transfers, ...dcaTrades, ...rewards, ...liq, ...voteRows, ...mmTx, ...otc], activityHistPick)
  }

  // The assembled feed carries each row's category in `type` ('dca' is a kind of
  // trade — see toTradeRow). When a single category is requested, filter to it so
  // rare types (e.g. dca, mm) aren't starved out by the slice below.
  const stakingExtrinsics = activityExtrinsicSet(staking)
  const mmExtrinsics = activityExtrinsicSet(mmTx)
  const scopedTransfers = transfers.filter(t =>
    !(t.extrinsicIndex != null && stakingExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
    !(t.extrinsicIndex != null && mmExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
    !(t.extrinsicIndex != null && liqCreateExt.has(`${t.blockHeight}:${t.extrinsicIndex}`)))
  const userTrades = dropShareRoutedTrades(trades, activityExtrinsicSet(liq))
  const userMm = mmTx.filter(r => !isModuleAcct(r.who))
  let merged = await suppressActivityPlumbing([...userTrades, ...scopedTransfers, ...dcaTrades, ...rewards, ...liq, ...staking, ...voteRows, ...userMm, ...otc, ...xcm])
  if (type && type !== 'all') merged = merged.filter(r => activityTypeMatchesFamily(r.type, type))
  merged = merged.filter(r => activityRowMatchesFilters(r, filters) && activityRowMatchesAction(r, action))
  const saturationSources = type === 'all' ? [trades, dcaTrades, rewards, liq, staking, voteRows, mmTx, otc, xcm]
    : type === 'trade' ? [trades, dcaTrades, otc]
      : type === 'liquidity' ? [liq, rewards]
        : type === 'mm' ? [mmTx, rewards]
          : type === 'otc' ? [otc]
            : type === 'xcm' ? [xcm]
              : type === 'staking' ? [staking]
                : type === 'vote' ? [voteRows]
                  : []
  const sourceSaturated = ((type === 'all' || type === 'transfer') && transferSourceSaturated)
    || saturationSources.some(source => source.length >= catFetch)
  if (merged.length < want && sourceSaturated) throw activityQueryTooBroad()
  const page = merged.sort((a, b) => b.blockHeight - a.blockHeight).slice(offset, offset + limit)
  await Promise.all([applyHistoricalUsd(page, activityHistPick), applyXcmJourneys(page)])
  return page
}

// Tail pages of an account feed: rows counted from the account's OLDEST
// activity (tailOffset 0 = the very first rows). Forward pagination cannot
// reach them — every source fetches a bounded newest-first window. Instead of
// teaching all nine sources to sort ascending, bound the normal builder to an
// early date window: find the day by which the account had accumulated enough
// activity (indexed ASC read on account_activity), fetch that window whole,
// and slice from its oldest end. The estimate is a proxy (raw activity rows ≠
// activity rows, value filters drop more), so the window widens adaptively.
async function getAccountActivityTail(accounts: string[], limit: number, type: string, tailOffset: number, action: string | undefined, filters: ValueListFilters): Promise<ActivityRow[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  const need = tailOffset + limit
  let fetchLimit = Math.max(need * 4, 3000)
  // Widen the window step by step: raw activity rows over-estimate activity rows
  // (classification and value filters drop some), so a tight first window can
  // underfill. Dense boundary days increase the semantic fetch until it is no
  // longer saturated; sparse histories keep widening until the full history is
  // reached. No depth is treated as an artificial end of history.
  for (let mult = 8; ; mult *= 4) {
    const cutRes = await client.query({
      query: `SELECT toString(toDate(block_timestamp)) AS d FROM (
                SELECT block_timestamp FROM price_data.account_activity
                WHERE account IN (${list})
                ORDER BY block_height ASC
                LIMIT 1 OFFSET {skip:UInt32}
              )`,
      query_params: { skip: Math.min(need * mult, 4_294_967_295) }, format: 'JSONEachRow',
    })
    // No row that deep → the whole (small) account history is the window.
    const cutoff = (await cutRes.json<{ d: string }>())[0]?.d
    if (fetchLimit * 5 > MAX_ACTIVITY_SOURCE_ROWS) throw activityQueryTooBroad()
    const rows = await getAccountActivity(accounts, fetchLimit, type, 0, action, filters, undefined, cutoff)
    if (rows.length >= fetchLimit) {
      fetchLimit *= 2
      continue
    }
    if (rows.length >= need || cutoff == null) {
      // Window fully fetched (newest-first) — the requested rows sit at its end.
      const endExclusive = rows.length - tailOffset
      return endExclusive > 0 ? rows.slice(Math.max(0, endExclusive - limit), endExclusive) : []
    }
  }
}

async function getScopedAccountActivity(
  accounts: string[],
  cacheScope: string,
  type: string,
  limit: number,
  offset: number,
  action: string | undefined,
  filters: ValueListFilters,
  from?: string,
  to?: string,
  tail?: number,
): Promise<ActivityRow[]> {
  if (tail != null && !from && !to) {
    return cached(`explorer:${cacheScope}:activity-tail:${type}:${limit}:${tail}:${action ?? ''}:${filterKey(filters)}`, 30_000,
      () => getAccountActivityTail(accounts, limit, type, tail, action, filters))
  }
  const window = timeWindow(from, to)
  return cached(`explorer:${cacheScope}:activity:${type}:${limit}:${offset}:${action ?? ''}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, window ? 30_000 : 8_000,
    () => getAccountActivity(accounts, limit, type, offset, action, filters, from, to))
}

// Account detail feeds resolve the address to the same related-account set used
// by getAddress. Unknown addresses return null so routes can distinguish them
// from recognized accounts with no activity.
export async function getAddressActivity(addressInput: string, type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string, tail?: number): Promise<ActivityRow[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getScopedAccountActivity(resolved.related, `account:${resolved.norm.accountId}`, type, limit, offset, action, filters, from, to, tail)
}

// The account's signed extrinsics (paginated). Same shape as getRecentExtrinsics
// but scoped to the related-account set as the signer.
export async function getAddressExtrinsics(addressInput: string, limit = 25, offset = 0, filters: ExtrinsicListFilters = {}, from?: string, to?: string): Promise<ExtrinsicSummary[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountExtrinsics(resolved.related, limit, offset, `addr-extrinsics:${resolved.norm.accountId}`, filters, from, to)
}

// Every governance vote cast by the account (OpenGov + Democracy + collectives),
// scoped to the same related-account set as the other detail feeds.
export async function getAddressVotes(addressInput: string, limit = 25, offset = 0, from?: string, to?: string, filters: VoteListFilters = {}): Promise<VoteRow[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getScopedVotes(resolved.related, `account:${resolved.norm.accountId}`, limit, offset, from, to, filters)
}

// Tab counts for an account/tag detail page: total signed extrinsics and total
// events mentioning any related account. The events count is a full args scan
// (~2.5s), so it is served from its own lazily-fetched endpoint under a long
// cache rather than blocking the page payload.

// Distinct on-behalf extrinsics (proxy targets ∪ multisig operation anchors)
// for a related-account set. Cheap: both projections are account-first and
// tiny. Cached on its own so the tag snapshot read path (which serves counts
// from a table that predates this field) can attach it without a recompute.
async function onBehalfExtrinsicCount(accounts: string[], cacheKey: string): Promise<number> {
  const list = sqlAccountList(accounts)
  if (list === "''") return 0
  return cached(`explorer:onbehalf-count:${cacheKey}`, 600_000, async () => {
    const res = await client.query({
      query: `
        SELECT count() AS c FROM (
          SELECT block_height, extrinsic_index FROM price_data.proxy_call_activity WHERE real_account IN (${list})
          UNION DISTINCT
          SELECT anchor_block_height AS block_height, anchor_extrinsic_index AS extrinsic_index
          FROM price_data.multisig_operation_activity WHERE multisig IN (${list})
        )`,
      format: 'JSONEachRow',
    })
    return Number((await res.json<{ c: string }>())[0]?.c ?? 0)
  })
}

export interface TabCounts { extrinsics: number; extrinsicsOnBehalf: number; events: number; activity: number; votes: number }
async function getAccountTabCounts(accounts: string[], cacheKey: string): Promise<TabCounts> {
  const list = sqlAccountList(accounts)
  if (list === "''") return { extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, activity: 0, votes: 0 }
  return cached(`explorer:tab-counts:${cacheKey}`, 600_000, async () => {
    const mmList = sqlAccountList([...new Set(accounts.map(evmAccountForm).filter(Boolean) as string[])])
    const indexedHits = `
      SELECT block_height, event_index, extrinsic_index, event_name, is_module_transfer
      FROM price_data.account_activity
      WHERE account IN (${list})`
    // Collapse both replayed rows and events referenced through multiple tag
    // members by stable event identity. This preserves exact counts without
    // FINAL, whose partition-wide merge made the two-member Treasury count read
    // 32M rows / 2.55 GiB for six seconds.
    const activityHits = `SELECT block_height, event_index, extrinsic_index, event_name, is_module_transfer
         FROM (${indexedHits})
         GROUP BY block_height, event_index, extrinsic_index, event_name, is_module_transfer`
    const [extRes, onBehalf, overlapRes, evRes, mmRes, xcmRes, dcaRes, otcRes, votes] = await Promise.all([
      client.query({
        query: `SELECT count() AS c FROM price_data.raw_extrinsics WHERE signer IN (${list}) OR effective_signer IN (${list})`,
        format: 'JSONEachRow',
      }),
      onBehalfExtrinsicCount(accounts, cacheKey),
      // Signed ∩ on-behalf overlap (e.g. self-proxy): the merged list shows
      // such an extrinsic once, so the total subtracts it. PK-pruned by the
      // small on-behalf anchor set.
      client.query({
        query: `
          SELECT count() AS c FROM price_data.raw_extrinsics
          WHERE (block_height, extrinsic_index) IN (
              SELECT block_height, extrinsic_index FROM price_data.proxy_call_activity WHERE real_account IN (${list})
              UNION DISTINCT
              SELECT anchor_block_height, anchor_extrinsic_index FROM price_data.multisig_operation_activity WHERE multisig IN (${list}))
            AND (signer IN (${list}) OR effective_signer IN (${list}))`,
        format: 'JSONEachRow',
      }),
      // Aggregate the hit activity once into per-event flags, then compute the tab
      // counts without expanding separate reference sets.
      client.query({
        query: `
          SELECT
            sum(event_count) AS events,
            countIf(has_trade) AS trades,
            sum(if(has_trade OR has_staking, 0, transfer_count)) AS transfers,
            sum(liq_count) AS liq,
            sum(staking_count) AS staking,
            sum(vote_count) AS votes,
            sum(xcm_in_count) AS xcm_in
          FROM (
            SELECT
              block_height,
              extrinsic_index,
              count() AS event_count,
              max(event_name IN (${SWAP_EVENTS.map(n => `'${n}'`).join(',')})) AS has_trade,
              max(event_name LIKE 'Staking.%' OR event_name LIKE 'GigaHdx%') AS has_staking,
              countIf(event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred') AND NOT is_module_transfer) AS transfer_count,
              countIf(event_name IN ('Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed')) AS liq_count,
              countIf(event_name LIKE 'Staking.%' OR event_name LIKE 'GigaHdx.%') AS staking_count,
              countIf(event_name IN ('ConvictionVoting.Voted','Democracy.Voted')) AS vote_count,
              -- Inbound XCM credits: hook-context Currencies.Deposited only;
              -- token/balance mirrors are excluded so a credit is counted once.
              countIf(event_name = 'Currencies.Deposited' AND extrinsic_index IS NULL) AS xcm_in_count
            FROM (${activityHits})
            GROUP BY block_height, extrinsic_index
          )`,
        format: 'JSONEachRow',
        // Mega structural accounts (router/referral/treasury pots) have tens of
        // millions of activity rows — spill the aggregation to disk instead of
        // hitting the memory ceiling. Exactness matters here: these counts drive
        // pager last-page jumps. Single-threaded, the biggest of these (~28M rows,
        // the referral pot) ran ~20s and tripped the client's execution ceiling
        // under concurrent directory load; four threads bring it to ~5s / ~1.8 GiB
        // — a brief, bounded burst on a cache miss (10-min TTL), not a hot loop,
        // so it no longer times out while still leaving cores for live requests.
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000', max_threads: 4 },
      }),
      client.query({ query: `SELECT count() AS c FROM price_data.account_money_market_activity FINAL WHERE account_id IN (${mmList}) AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})`, format: 'JSONEachRow' }),
      client.query({ query: `SELECT count() AS c FROM price_data.raw_xcm_activity WHERE sender IN (${list}) OR recipient IN (${list})`, format: 'JSONEachRow' }),
      client.query({ query: `SELECT count() AS c FROM price_data.dca_events WHERE event_name = 'DCA.TradeExecuted' AND who IN (${list})`, format: 'JSONEachRow' }),
      // OTC: Filled/PartiallyFilled carry `who` (the taker) directly; Placed/Cancelled
      // don't, so they're matched via the account's own signed extrinsics instead
      // (same signer-join precedent the activity builders use for those two events).
      client.query({
        query: `SELECT count() AS c FROM price_data.raw_events
                WHERE event_name IN (${sqlEventNameList(OTC_EVENT_NAMES)})
                  AND (JSONExtractString(args_json,'who') IN (${list})
                    OR (block_height, extrinsic_index) IN (SELECT block_height, extrinsic_index FROM price_data.raw_extrinsics WHERE signer IN (${list}) OR effective_signer IN (${list})))`,
        format: 'JSONEachRow',
      }),
      // Votes-tab badge: conviction/democracy plus the collective votes the
      // activity index does not carry (its own 10-min cache is shared with the
      // tag snapshot path).
      getScopedVotesCount(accounts, cacheKey),
    ])
    const ev = (await evRes.json<Record<string, string>>())[0] ?? {}
    const n = (v: unknown) => Number(v ?? 0)
    const activity = n(ev.trades) + n(ev.transfers) + n(ev.liq) + n(ev.staking) + n(ev.votes) + n(ev.xcm_in)
      + n((await mmRes.json<{ c: string }>())[0]?.c) + n((await xcmRes.json<{ c: string }>())[0]?.c) + n((await dcaRes.json<{ c: string }>())[0]?.c)
      + n((await otcRes.json<{ c: string }>())[0]?.c)
    const overlap = n((await overlapRes.json<{ c: string }>())[0]?.c)
    return {
      extrinsics: n((await extRes.json<{ c: string }>())[0]?.c) + onBehalf - overlap,
      extrinsicsOnBehalf: onBehalf,
      events: n(ev.events),
      activity,
      votes,
    }
  })
}
export async function getAddressTabCounts(addressInput: string): Promise<TabCounts | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountTabCounts(resolved.related, `addr:${resolved.norm.accountId}`)
}
const TAG_COUNT_REFRESH_MS = 10 * 60_000
const tagCountRefreshes = new Map<string, Promise<TabCounts>>()
const hotTagCounts = new Set<string>()
async function refreshTagTabCounts(tagId: string, members: string[], membershipKey: string): Promise<TabCounts> {
  const existing = tagCountRefreshes.get(tagId)
  if (existing) return existing
  const refresh = (async () => {
    const counts = await getAccountTabCounts(members, `tag:${tagId}:${membershipKey}`)
    // The snapshot table predates the votes badge and stays schema-stable; the
    // votes count is recomputed cheaply (and cached) on the read path instead.
    const { votes: _votes, extrinsicsOnBehalf: _onBehalf, ...persisted } = counts
    await client.insert({
      table: 'price_data.tag_activity_counts',
      values: [{ tag_id: tagId, membership_key: membershipKey, ...persisted, computed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }],
      format: 'JSONEachRow',
    })
    return counts
  })().finally(() => {
    if (tagCountRefreshes.get(tagId) === refresh) tagCountRefreshes.delete(tagId)
  })
  tagCountRefreshes.set(tagId, refresh)
  return refresh
}
export async function getTagTabCounts(tagId: string): Promise<TabCounts | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  hotTagCounts.add(tagId)
  const membershipKey = [...members].map(member => member.toLowerCase()).sort().join(',')
  const result = await client.query({
    query: `SELECT membership_key, extrinsics, events, activity,
              dateDiff('second', computed_at, now()) AS age
            FROM price_data.tag_activity_counts FINAL
            WHERE tag_id = {tagId:String}
            LIMIT 1`,
    query_params: { tagId }, format: 'JSONEachRow',
  })
  const snapshot = (await result.json<{ membership_key: string; extrinsics: string; events: string; activity: string; age: number }>())[0]
  if (snapshot?.membership_key === membershipKey) {
    // Never attach a full-history refresh to the request that discovers an aged
    // snapshot. The ten-minute prewarmer owns refresh scheduling; this endpoint
    // always returns the last complete snapshot immediately. A request-triggered
    // refresh used to contend with the activity feed on the same cold page even
    // though the counts response itself had already completed. Votes aren't in
    // the snapshot table — they're recomputed via their own cheap cached query.
    const votes = await getScopedVotesCount(members, `tag:${tagId}:${membershipKey}`)
    const extrinsicsOnBehalf = await onBehalfExtrinsicCount(members, `tag:${tagId}:${membershipKey}`)
    return { extrinsics: Number(snapshot.extrinsics), extrinsicsOnBehalf, events: Number(snapshot.events), activity: Number(snapshot.activity), votes }
  }
  return refreshTagTabCounts(tagId, members, membershipKey)
}
export async function getTagActivityCountAtMin(tagId: string, minUsd: number): Promise<number | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getAccountActivityCountAtMin(members, `tag:${tagId}`, minUsd)
}

// value-filtered activity count (last-page jumps under the smol filter)
// How many activity rows survive a `min` USD value filter — the count behind the
// pager's last-page jump while smol-hiding (or a custom $-minimum) is active.
// Runs on account_activity_v3, which carries each event's value-relevant
// (asset_id, UInt256 amount, block_timestamp) tuple. The same hourly event-time
// close and exact UInt256 threshold used by feed queries is applied here.
  // Returns null when a category needs enrichment/classification that this
  // compact index cannot reproduce exactly.
async function getAccountActivityCountAtMin(accounts: string[], cacheKey: string, minUsd: number): Promise<number | null> {
  const list = sqlAccountList(accounts)
  if (list === "''") return 0
  return cached(`explorer:tab-counts-min:${cacheKey}:${minUsd}`, 600_000, async () => {
    const prices = await ensurePrices()
    const minFilter: ValueListFilters = { min: minUsd, unit: 'usd' }
    const activityValue = eventValueFilterSql('a.asset_id', 'a.amount', 'a.block_timestamp', minFilter, prices, 'activity_price', { amountIsUInt256: true, hasAmountExpr: 'a.has_amount' })
    const valueOk = activityValue.predicateSql.replace(/^AND\s+/, '')
    const mmList = sqlAccountList([...new Set(accounts.map(evmAccountForm).filter(Boolean) as string[])])
    const swapNames = SWAP_EVENTS.map(n => `'${n}'`).join(',')
    // Related-account sets can expose the same event through multiple keys —
    // dedup exactly like getAccountTabCounts. Same-key rows carry the same
    // amount, so any(value_ok) is deterministic.
    const hits = accounts.length > 1
      ? `SELECT block_height, event_index, extrinsic_index, event_name, is_module_transfer, any(value_ok) AS value_ok
         FROM (SELECT a.block_height, a.event_index, a.extrinsic_index, a.event_name, a.is_module_transfer, ${valueOk} AS value_ok
               FROM price_data.account_activity_v3 AS a FINAL
               ${activityValue.joinSql}
               WHERE a.account IN (${list}))
         GROUP BY block_height, event_index, extrinsic_index, event_name, is_module_transfer`
      : `SELECT a.block_height, a.event_index, a.extrinsic_index, a.event_name, a.is_module_transfer, ${valueOk} AS value_ok
         FROM price_data.account_activity_v3 AS a FINAL
         ${activityValue.joinSql}
         WHERE a.account IN (${list})`
    const [liqRes, mmRes, xcmRes, dcaRes, otcRes] = await Promise.all([
      client.query({
        query: `SELECT count() AS c FROM price_data.account_activity_v3 FINAL
                WHERE account IN (${list})
                  AND event_name IN ('Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed')`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT count() AS c FROM price_data.account_money_market_activity FINAL
                WHERE account_id IN (${mmList}) AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})`,
        format: 'JSONEachRow',
      }),
      client.query({ query: `SELECT count() AS c FROM price_data.raw_xcm_activity WHERE sender IN (${list}) OR recipient IN (${list})`, format: 'JSONEachRow' }),
      client.query({
        query: `SELECT count() AS c FROM price_data.dca_events
                WHERE event_name IN ('DCA.TradeExecuted','DCA.TradeFailed') AND who IN (${list})`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT count() AS c FROM price_data.raw_events
                WHERE event_name IN (${sqlEventNameList(OTC_EVENT_NAMES)})
                  AND (JSONExtractString(args_json,'who') IN (${list})
                    OR (block_height, extrinsic_index) IN (SELECT block_height, extrinsic_index FROM price_data.raw_extrinsics WHERE signer IN (${list}) OR effective_signer IN (${list})))`,
        format: 'JSONEachRow',
      }),
    ])
    const n = (v: unknown) => Number(v ?? 0)
    const ambiguityCounts = await Promise.all([liqRes, mmRes, xcmRes, dcaRes, otcRes].map(async result => n((await result.json<{ c: string }>())[0]?.c)))
    if (ambiguityCounts.some(count => count > 0)) return null

    const evRes = await client.query({
        query: `
          SELECT
            countIf(has_passing_trade) AS trades,
            sum(if(has_trade OR has_staking, 0, transfer_ok)) AS transfers,
            sum(liq_ok) AS liq,
            sum(staking_ok) AS staking,
            sum(vote_ok) AS votes,
            sum(xcm_in_ok) AS xcm_in
          FROM (
            SELECT
              block_height,
              extrinsic_index,
              max(event_name IN (${swapNames})) AS has_trade,
              max((event_name IN (${swapNames})) AND value_ok) AS has_passing_trade,
              max(event_name LIKE 'Staking.%' OR event_name LIKE 'GigaHdx%') AS has_staking,
              countIf(event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred') AND NOT is_module_transfer AND value_ok) AS transfer_ok,
              countIf(event_name IN ('Omnipool.LiquidityAdded','Omnipool.LiquidityRemoved','Stableswap.LiquidityAdded','Stableswap.LiquidityRemoved','XYK.LiquidityAdded','XYK.LiquidityRemoved','XYK.PoolCreated','OmnipoolLiquidityMining.RewardClaimed','XYKLiquidityMining.RewardClaimed') AND value_ok) AS liq_ok,
              countIf((event_name LIKE 'Staking.%' OR event_name LIKE 'GigaHdx.%') AND value_ok) AS staking_ok,
              countIf(event_name IN ('ConvictionVoting.Voted','Democracy.Voted') AND value_ok) AS vote_ok,
              countIf(event_name = 'Currencies.Deposited' AND extrinsic_index IS NULL AND value_ok) AS xcm_in_ok
            FROM (${hits})
            GROUP BY block_height, extrinsic_index
          )`,
        format: 'JSONEachRow',
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000' },
      })
    const ev = (await evRes.json<Record<string, string>>())[0] ?? {}
    return n(ev.trades) + n(ev.transfers) + n(ev.liq) + n(ev.staking) + n(ev.votes) + n(ev.xcm_in)
  })
}
export async function getAddressActivityCountAtMin(addressInput: string, minUsd: number): Promise<number | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountActivityCountAtMin(resolved.related, `addr:${resolved.norm.accountId}`, minUsd)
}

// value-event markers (the "Value" chart's flagged big events)
// The largest value-changing events across the account set's history — user
// transfers (in/out), swaps, liquidity moves, cross-chain (XCM) flows and
// money-market liquidations, each valued at its block-time hourly close, never
// the current price — PLUS one marker per big jump of the value line itself,
// so every large move the chart draws carries an annotation of its most likely
// cause (or an explicit 'price' marker when nothing discrete explains it). A
// DCA schedule's many block-hook executions collapse into one marker for the
// whole schedule (summed value, linked to /dca/:id) instead of flooding the chart.
export interface ValueEvent {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  kind: 'transfer-in' | 'transfer-out' | 'swap' | 'liquidity' | 'liquidation' | 'dca' | 'cross-chain' | 'price' | 'other'
  // 'price' markers carry the SIGNED bucket delta (no discrete event to value).
  valueUsd: number
  // null only for 'price' markers — a market move has no single asset.
  asset: AssetRef | null
  counterparty: AccountRef | null
  // Cross-chain flow direction (inbound credit vs outbound send).
  direction?: 'in' | 'out'
  // false when a cross-chain marker's (block,eventIndex) has no matching row in
  // the XCM activity feed (reserved-account credits, non-contiguous walk-backs):
  // the marker still annotates the jump but renders WITHOUT a dead detail link.
  linkable?: boolean
  // A 'dca' marker summarizes a whole schedule: id links to /dca/:id, trades is
  // the execution count behind valueUsd; block/event point at the peak execution.
  dcaScheduleId?: number
  dcaTrades?: number
  // Traded pair for swap/DCA markers (resolved for the chosen markers only);
  // `asset` stays the value-bearing leg the marker was scored on.
  assetIn?: AssetRef | null
  assetOut?: AssetRef | null
  // Raw token amount in `asset` decimals — only on markers whose USD value is
  // exactly one event's leg (summed markers would pair a total with one leg).
  amount?: string
}

const VALUE_EVENT_TRANSFER_NAMES = ['Balances.Transfer', 'Tokens.Transfer', 'Currencies.Transferred']
const VALUE_EVENT_LIQUIDITY_NAMES = [
  'Omnipool.LiquidityAdded', 'Omnipool.LiquidityRemoved',
  'Stableswap.LiquidityAdded', 'Stableswap.LiquidityRemoved',
  'XYK.LiquidityAdded', 'XYK.LiquidityRemoved',
]
// Cross-chain movements are indexed as deposit/withdraw events, not transfers:
// an inbound XCM credit is a hook-context Currencies/Tokens.Deposited in a
// MessageQueue.Processed block; an outbound send is the Currencies/Tokens.
// Withdrawn of an XTokens/PolkadotXcm extrinsic (user-sent) or a hook-context
// one in a barrier block (remote-initiated pull).
const VALUE_EVENT_XCM_IN_NAMES = ['Currencies.Deposited', 'Tokens.Deposited']
const VALUE_EVENT_XCM_OUT_NAMES = ['Currencies.Withdrawn', 'Tokens.Withdrawn']
const VALUE_EVENT_DEFAULT_LIMIT = 12
// A liquidation is a high-signal event even when a routine transfer moved more
// value, so guarantee the top few always surface rather than letting a whale's
// larger transfers crowd every liquidation out of the value-ranked budget.
const VALUE_EVENT_LIQUIDATION_SLOTS = 3
// DCA schedules are a shipped, first-class marker (one flag per schedule, linked
// to /dca/:id). Like liquidations, reserve slots for the largest ones so the
// jump-driven price/cross-chain markers can't crowd every schedule off the chart.
const VALUE_EVENT_DCA_SLOTS = 3
// Jump detection: a point-to-point move of the reconstructed value series is
// "big" when it clears both an absolute floor and a fraction of the series'
// peak — dust accounts don't spam markers, whale noise doesn't drown them. The
// same threshold gates the value-fill so a flat account never surfaces its dust.
const VALUE_JUMP_MIN_USD = 1_000
const VALUE_JUMP_PEAK_FRACTION = 0.05
// A jump is "explained" by its window's dominant cause when that cause's summed
// USD reaches this fraction of |Δ|; below it the marker degrades to an honest
// 'price' annotation instead of blaming an incidental small event. Calibrated
// on real accounts: a drip-style LP unwind sums to ~40% of its bucket's drop.
const VALUE_JUMP_EXPLAIN_FRACTION = 0.3
// Top candidate rows fetched per jump window. Per-kind sums saturate well below
// this for real accounts; it bounds the read on whale windows.
const VALUE_JUMP_WINDOW_ROWS = 40

// Threshold below which a value-line move (or a fill event) is not "significant"
// for this account: an absolute floor OR a fraction of the series' peak.
function valueJumpThreshold(series: number[]): number {
  let peak = 0
  for (const v of series) peak = Math.max(peak, Math.abs(v))
  return Math.max(VALUE_JUMP_MIN_USD, peak * VALUE_JUMP_PEAK_FRACTION)
}

// The value line's biggest point-to-point moves: |Δ| over the threshold, ranked
// by |Δ|, capped at the marker budget. Each jump's block window is the half-open
// span between its two points' end-of-bucket blocks — exactly the blocks whose
// events the delta reflects. The FINAL segment is skipped: the chart pins its
// last point to live net worth (getAddressHistory/getTag overwrite it), so a
// delta computed here against the un-pinned cached series could disagree with
// the drawn line.
interface ValueJumpWindow { delta: number; startBlock: number; endBlock: number; timestamp: string }
function selectValueJumps(
  history: { portfolioSeries: number[]; portfolioDates: string[]; portfolioBlocks: number[] } | null,
  from: string | undefined,
  to: string | undefined,
  maxJumps: number,
): ValueJumpWindow[] {
  if (!history) return []
  const { portfolioSeries: series, portfolioDates: dates, portfolioBlocks: blocks } = history
  if (series.length < 2 || blocks.length !== series.length) return []
  const threshold = valueJumpThreshold(series)
  const jumps: ValueJumpWindow[] = []
  // i < length-1: the last delta lands on the pinned point — don't flag it.
  for (let i = 1; i < series.length - 1; i++) {
    const delta = series[i] - series[i - 1]
    if (Math.abs(delta) < threshold || !(blocks[i] > blocks[i - 1])) continue
    const day = (dates[i] ?? '').slice(0, 10)
    if ((from && day < from) || (to && day > to)) continue
    jumps.push({ delta, startBlock: blocks[i - 1], endBlock: blocks[i], timestamp: dates[i] })
  }
  jumps.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return jumps.slice(0, maxJumps)
}

// SQL: per-asset raw→token scale (10^decimals) for exact-index value ranking.
function assetDecimalsPowSql(assetIdExpr: string): string {
  const assets = allExplorerAssets()
  const ids = assets.map(a => a.assetId).join(',')
  const decimals = assets.map(a => a.decimals).join(',')
  return `pow(10, transform(toUInt32(${assetIdExpr}), [${ids || '0'}], [${decimals || '12'}], 12))`
}

function valueEventKind(eventName: string): ValueEvent['kind'] {
  if (SWAP_EVENTS.includes(eventName)) return 'swap'
  if (VALUE_EVENT_LIQUIDITY_NAMES.includes(eventName)) return 'liquidity'
  if (/Liquidat/.test(eventName)) return 'liquidation'
  return 'other'
}

interface ValueEventCandidateRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  event_name: string
  ts: string
  asset_id: number
  amount: string
  value_usd: number
}

// Value-chart markers for an explicit account set, bounded to the optional day
// window (default: the full indexed range, matching the value-history chart's
// span). Two selection passes share one candidate machinery:
//  - the globally largest-USD events (transfers, swaps, liquidity, collapsed
//    DCA schedules, liquidations), each valued at its block-time hourly close;
//  - one marker per big JUMP of the reconstructed value series itself, so a
//    large move never renders unannotated: each jump's block window is scored
//    per cause (transfer / cross-chain / liquidity / DCA / liquidation / swap)
//    and the dominant one wins, or an explicit 'price' marker when no discrete
//    activity plausibly explains the move.
// All event reads are bounded account_activity_v3 scans (sort key leads with
// account) valued via the ASOF hourly-close join the value filters use, plus
// one LiquidationCall read of the MM read model — liquidations are EVM-side
// and never hit the substrate event index.
async function getAccountValueEvents(accounts: string[], cacheKey: string, from?: string, to?: string, limit = VALUE_EVENT_DEFAULT_LIMIT, historyAccounts: string[] = accounts): Promise<ValueEvent[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  return cached(`explorer:value-events:${cacheKey}:${from ?? ''}:${to ?? ''}:${limit}`, 600_000, async () => {
    const bound = timeWindow(from, to) ?? '1'
    // The value series the chart draws (cache shared with getAddressHistory/
    // getTag): its biggest deltas are the jumps that must end up annotated.
    const history = await getAccountHistoryShared(historyAccounts, cacheKey).catch(() => null)
    const jumps = selectValueJumps(history, from, to, limit)
    const windows = [...jumps].sort((x, y) => x.startBlock - y.startBlock)
    const windowId = new Map(windows.map((w, i) => [w, i + 1]))
    const windowCondFor = (col: string) => windows.map(w => `(${col} > ${w.startBlock} AND ${col} <= ${w.endBlock})`).join(' OR ') || '0'
    // Fetch well past the requested markers: mirror legs (~half the transfer
    // candidates), pool/MM-leg counterparties and same-extrinsic swap echoes are
    // dropped below and must not leave the chart short.
    const fetch = limit * 4
    const closes = historicalClosesRelationSql()
    const namedEvents = [...SWAP_EVENTS, ...VALUE_EVENT_LIQUIDITY_NAMES].map(n => `'${n}'`).join(',')
    const transferNames = VALUE_EVENT_TRANSFER_NAMES.map(n => `'${n}'`).join(',')
    const xcmInNames = VALUE_EVENT_XCM_IN_NAMES.map(n => `'${n}'`).join(',')
    const xcmOutNames = VALUE_EVENT_XCM_OUT_NAMES.map(n => `'${n}'`).join(',')
    // Cross-chain gates, bounded to the jump windows: inbound credits and
    // remote-initiated pulls execute in hook context inside a MessageQueue.
    // Processed block; user-sent outbound withdrawals live in an XTokens/
    // pallet-xcm extrinsic (see VALUE_EVENT_XCM_* above).
    const xcmSentEventNames = `'XTokens.TransferredAssets','PolkadotXcm.Sent'`
    const xcmBarrierBlocksSql = `SELECT block_height FROM ${xcmEventActivityTable()}
                    WHERE event_name = 'MessageQueue.Processed' AND extrinsic_index IS NULL AND (${windowCondFor('block_height')})`
    const xcmSentPairsSql = `SELECT block_height, assumeNotNull(extrinsic_index) FROM price_data.raw_xcm_activity
                    WHERE source_kind = 'event' AND name IN (${xcmSentEventNames})
                      AND extrinsic_index IS NOT NULL AND (${windowCondFor('block_height')})`
    const mmList = sqlAccountList([...new Set(accounts.map(evmAccountForm).filter(Boolean) as string[])])
    const mmAssetExpr = mmAssetIdSql('m.asset_address')
    // A DCA schedule executes as many small block-hook trades; each would rank as
    // its own swap (+ mirrored liquidity leg) and a long-running schedule floods
    // the chart with identical markers. Its executions collapse into ONE 'dca'
    // marker instead: the blocks holding a DCA.TradeExecuted for a scoped account
    // are excluded from the per-event candidates below (extrinsic-null only, so a
    // signed swap the account happens to make in the same block still surfaces).
    const dcaExecsSql = `SELECT id, block_height, event_index, block_timestamp, who, amount_out FROM price_data.dca_events
                    WHERE event_name = 'DCA.TradeExecuted' AND who IN (${list}) AND ${bound}`
    const [eventRes, liqRes, dcaRes, windowRes, xcmSentRes, dcaWindowRes] = await Promise.all([
      client.query({
        query: `
          SELECT block_height, event_index, any(extrinsic_index) AS extrinsic_index, any(event_name) AS event_name,
                 any(ts) AS ts, any(asset_id) AS asset_id, any(amount) AS amount, any(value_usd) AS value_usd
          FROM (
            SELECT a.block_height AS block_height, a.event_index AS event_index, a.extrinsic_index AS extrinsic_index,
                   a.event_name AS event_name, toString(a.block_timestamp) AS ts,
                   a.asset_id AS asset_id, toString(a.amount) AS amount,
                   toFloat64(a.amount) / ${assetDecimalsPowSql('a.asset_id')} * value_price.close AS value_usd
            FROM price_data.account_activity_v3 AS a FINAL
            ASOF LEFT JOIN ${closes} value_price
              ON value_price.asof_join_key = toUInt8(isNotNull(a.block_timestamp))
             AND value_price.asset_id = ${priceAliasIdSql('a.asset_id')}
             AND value_price.price_time <= a.block_timestamp
            WHERE a.account IN (${list}) AND ${bound}
              AND a.has_amount = 1
              AND (a.event_name IN (${namedEvents})
                OR (a.event_name IN (${transferNames}) AND NOT a.is_module_transfer))
              AND NOT (a.extrinsic_index IS NULL
                AND a.event_name IN (${namedEvents})
                AND a.block_height IN (SELECT block_height FROM (${dcaExecsSql})))
          )
          GROUP BY block_height, event_index
          HAVING value_usd > 0
          ORDER BY value_usd DESC
          LIMIT {fetch:UInt32}`,
        query_params: { fetch }, format: 'JSONEachRow',
        // Whale/structural accounts carry millions of indexed rows; spill the
        // event-identity dedup to disk instead of hitting the memory ceiling.
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000' },
      }),
      mmList === "''" ? Promise.resolve(null) : client.query({
        query: `
          SELECT block_height, event_index, any(ts) AS ts, any(asset_id) AS asset_id, any(value_usd) AS value_usd
          FROM (
            SELECT m.block_height AS block_height, m.event_index AS event_index, toString(m.block_timestamp) AS ts,
                   ${mmAssetExpr} AS asset_id,
                   toFloat64OrZero(m.liquidated_collateral_amount) / ${assetDecimalsPowSql(mmAssetExpr)} * liq_price.close AS value_usd
            FROM price_data.account_money_market_activity AS m FINAL
            ASOF LEFT JOIN ${closes} liq_price
              ON liq_price.asof_join_key = toUInt8(isNotNull(m.block_timestamp))
             AND liq_price.asset_id = ${priceAliasIdSql(mmAssetExpr)}
             AND liq_price.price_time <= m.block_timestamp
            WHERE m.account_id IN (${mmList}) AND ${bound}
              AND m.event_name = 'LiquidationCall'
              AND lower(ifNull(m.pool_address, '')) IN (${configuredMmPoolsSql()})
          )
          GROUP BY block_height, event_index
          ORDER BY value_usd DESC
          LIMIT {fetch:UInt32}`,
        query_params: { fetch }, format: 'JSONEachRow',
      }),
      // One row per DCA schedule: total = SUM of its executions' USD value at the
      // same ASOF hourly close the swap markers use, marker at the single
      // highest-value execution. Two eras value differently: OLD-format
      // executions index their AMM events under the OWNER's account (and their
      // dca_schedules row carries no asset/direction), so they're valued from
      // that swap leg — max per block, since Router.Executed and its hop events
      // describe one trade. NEW-format executions route through the router pallet
      // account (nothing valued lands under the owner), but their dca_schedules
      // row reliably carries asset_out — those value dca_events.amount_out at
      // asset_out's close, gated on direction != '' so an old unknown-asset
      // schedule can never be mis-valued as asset 0 (HDX).
      client.query({
        query: `
          SELECT schedule_id, sum(exec_value) AS total_value_usd, count() AS trades,
                 argMax(block_height, exec_value) AS block_height, argMax(event_index, exec_value) AS event_index,
                 argMax(ts, exec_value) AS ts, argMax(asset_id, exec_value) AS asset_id
          FROM (
            SELECT d.schedule_id AS schedule_id, d.block_height AS block_height,
                   if(max(s.value_usd) > 0, max(s.value_usd), any(d.event_value)) AS exec_value,
                   if(max(s.value_usd) > 0, argMax(s.event_index, s.value_usd), any(d.event_index)) AS event_index,
                   if(max(s.value_usd) > 0, argMax(s.asset_id, s.value_usd), any(d.sched_asset_out)) AS asset_id,
                   any(d.ts) AS ts
            FROM (
              SELECT toUInt32(d0.id) AS schedule_id, d0.block_height AS block_height, d0.event_index AS event_index,
                     toString(d0.block_timestamp) AS ts, d0.who AS who, sched.asset_out AS sched_asset_out,
                     if(sched.direction != '',
                        toFloat64OrZero(d0.amount_out) / ${assetDecimalsPowSql('sched.asset_out')} * out_price.close, 0) AS event_value
              FROM (${dcaExecsSql}) AS d0
              LEFT JOIN (SELECT id, asset_out, direction FROM price_data.dca_schedules FINAL WHERE who IN (${list})) AS sched
                ON sched.id = d0.id
              ASOF LEFT JOIN ${closes} out_price
                ON out_price.asof_join_key = toUInt8(isNotNull(d0.block_timestamp))
               AND out_price.asset_id = ${priceAliasIdSql('sched.asset_out')}
               AND out_price.price_time <= d0.block_timestamp
            ) AS d
            LEFT JOIN (
              SELECT a.block_height AS block_height, a.account AS account, a.event_index AS event_index,
                     a.asset_id AS asset_id,
                     toFloat64(a.amount) / ${assetDecimalsPowSql('a.asset_id')} * value_price.close AS value_usd
              FROM price_data.account_activity_v3 AS a FINAL
              ASOF LEFT JOIN ${closes} value_price
                ON value_price.asof_join_key = toUInt8(isNotNull(a.block_timestamp))
               AND value_price.asset_id = ${priceAliasIdSql('a.asset_id')}
               AND value_price.price_time <= a.block_timestamp
              WHERE a.account IN (${list}) AND ${bound}
                AND a.has_amount = 1 AND a.extrinsic_index IS NULL
                AND a.event_name IN (${SWAP_EVENTS.map(n => `'${n}'`).join(',')})
            ) AS s ON s.block_height = d.block_height AND s.account = d.who
            GROUP BY schedule_id, block_height
          )
          GROUP BY schedule_id
          HAVING total_value_usd > 0
          ORDER BY total_value_usd DESC
          LIMIT {fetch:UInt32}`,
        query_params: { fetch }, format: 'JSONEachRow',
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000' },
      }),
      // Per-jump-window candidates: the same families the global pass ranks,
      // EXTENDED with the cross-chain deposit/withdraw events (gated to real
      // XCM contexts) and WITHOUT the DCA-block exclusion — hook executions are
      // classified (and collapsed) per schedule in the scoring below. Top rows
      // per window; the per-cause sums drive the jump attribution.
      !windows.length ? Promise.resolve(null) : client.query({
        query: `
          SELECT w, block_height, event_index, any(extrinsic_index) AS extrinsic_index, any(event_name) AS event_name,
                 any(ts) AS ts, any(asset_id) AS asset_id, any(amount) AS amount, any(value_usd) AS value_usd
          FROM (
            SELECT multiIf(${windows.map((w, i) => `a.block_height <= ${w.endBlock}, ${i + 1}`).join(', ')}, 0) AS w,
                   a.block_height AS block_height, a.event_index AS event_index, a.extrinsic_index AS extrinsic_index,
                   a.event_name AS event_name, toString(a.block_timestamp) AS ts,
                   a.asset_id AS asset_id, toString(a.amount) AS amount,
                   toFloat64(a.amount) / ${assetDecimalsPowSql('a.asset_id')} * value_price.close AS value_usd
            FROM price_data.account_activity_v3 AS a FINAL
            ASOF LEFT JOIN ${closes} value_price
              ON value_price.asof_join_key = toUInt8(isNotNull(a.block_timestamp))
             AND value_price.asset_id = ${priceAliasIdSql('a.asset_id')}
             AND value_price.price_time <= a.block_timestamp
            WHERE a.account IN (${list}) AND (${windowCondFor('a.block_height')})
              AND a.has_amount = 1
              AND (a.event_name IN (${namedEvents})
                OR (a.event_name IN (${transferNames}) AND NOT a.is_module_transfer)
                OR (a.event_name IN (${xcmInNames}) AND a.extrinsic_index IS NULL AND a.block_height IN (${xcmBarrierBlocksSql}))
                OR (a.event_name IN (${xcmOutNames}) AND ((a.extrinsic_index IS NULL AND a.block_height IN (${xcmBarrierBlocksSql}))
                  OR (a.extrinsic_index IS NOT NULL AND (a.block_height, assumeNotNull(a.extrinsic_index)) IN (${xcmSentPairsSql})))))
          )
          GROUP BY w, block_height, event_index
          HAVING value_usd > 0
          ORDER BY w, value_usd DESC
          LIMIT ${VALUE_JUMP_WINDOW_ROWS} BY w`,
        format: 'JSONEachRow',
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000' },
      }),
      // Sent-event refs of the windows' outbound XCM extrinsics: a cross-chain
      // marker links to the XCM activity row, which the feed keys by this event.
      !windows.length ? Promise.resolve(null) : client.query({
        query: `SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index,
                       assumeNotNull(event_index) AS event_index, name
                FROM price_data.raw_xcm_activity
                WHERE source_kind = 'event' AND name IN (${xcmSentEventNames})
                  AND extrinsic_index IS NOT NULL AND event_index IS NOT NULL AND (${windowCondFor('block_height')})`,
        format: 'JSONEachRow',
      }),
      // Which windows' blocks are DCA executions, and of which schedule — the
      // scoring collapses their hook swaps under the schedule, not 'swap'.
      !windows.length ? Promise.resolve(null) : client.query({
        query: `SELECT toUInt32(id) AS schedule_id, block_height FROM price_data.dca_events
                WHERE event_name = 'DCA.TradeExecuted' AND who IN (${list}) AND (${windowCondFor('block_height')})
                GROUP BY schedule_id, block_height`,
        format: 'JSONEachRow',
      }),
    ])
    const rows = await eventRes.json<ValueEventCandidateRow>()
    const liqRows = liqRes ? await liqRes.json<{ block_height: number; event_index: number; ts: string; asset_id: number; value_usd: number }>() : []
    const dcaRows = await dcaRes.json<{ schedule_id: number; total_value_usd: number; trades: number; block_height: number; event_index: number; ts: string; asset_id: number }>()
    const windowRows = windowRes ? await windowRes.json<ValueEventCandidateRow & { w: number }>() : []
    const xcmSentRows = xcmSentRes ? await xcmSentRes.json<{ block_height: number; extrinsic_index: number; event_index: number; name: string }>() : []
    const dcaWindowRows = dcaWindowRes ? await dcaWindowRes.json<{ schedule_id: number; block_height: number }>() : []

    // Transfer direction + counterparty from the transfer read model (the v3
    // index carries no from/to): a bounded point lookup for at most `fetch`
    // plus the window candidates' refs.
    const transferRows = rows.filter(r => VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name))
    const windowTransferRows = windowRows.filter(r => VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name))
    const legByRef = new Map<string, { from: string; to: string }>()
    if (transferRows.length || windowTransferRows.length) {
      const tuples = [...new Set([...transferRows, ...windowTransferRows].map(r => `(${r.block_height},${r.event_index})`))].join(',')
      const legRes = await client.query({
        query: `SELECT block_height, event_index, any(from_account) AS from_account, any(to_account) AS to_account
                FROM price_data.account_transfer_activity
                WHERE account IN (${list}) AND (block_height, event_index) IN (${tuples})
                GROUP BY block_height, event_index`,
        format: 'JSONEachRow',
      })
      for (const r of await legRes.json<{ block_height: number; event_index: number; from_account: string; to_account: string }>()) {
        legByRef.set(`${r.block_height}:${r.event_index}`, { from: r.from_account.toLowerCase(), to: r.to_account.toLowerCase() })
      }
    }
    const scoped = new Set(accounts.map(a => a.toLowerCase()))
    // Pool + money-market contracts (all markets): a transfer whose counterparty
    // is one of these is a swap/LP/MM leg represented elsewhere, never a user
    // transfer marker (and never a cross-chain one).
    const plumbing = new Set([...ammPoolAccounts(), ...(await mmReserveAccountIds()), ...(await mmContractAccountIds())])
    // The same movement is often indexed twice (Currencies.Transferred mirrors
    // Tokens.Transfer): keep the highest-priority mirror per movement identity —
    // the dedupeTransferEvents rule, applied post-lookup since identity needs
    // from/to. Global and window candidates keep separate maps: a mirror that
    // only cleared one fetch's value cut must not suppress the other's row.
    const mirrorKey = (r: ValueEventCandidateRow, leg: { from: string; to: string }) =>
      `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${leg.from}|${leg.to}|${r.amount}`
    const buildMirrorPriority = (candidates: ValueEventCandidateRow[]) => {
      const priority = new Map<string, number>()
      for (const r of candidates) {
        const leg = legByRef.get(`${r.block_height}:${r.event_index}`)
        if (!leg) continue
        const key = mirrorKey(r, leg)
        const p = transferEventPriority(r.event_name)
        if (p > (priority.get(key) ?? 0)) priority.set(key, p)
      }
      return priority
    }
    const mirrorPriority = buildMirrorPriority(transferRows)
    // Direction/counterparty resolution shared by the global markers and the
    // window scoring: null = drop (mirror echo, internal shuffle, plumbing leg),
    // 'other' = real transfer whose legs the read model missed.
    const resolveTransfer = (r: ValueEventCandidateRow, priority: Map<string, number>): { kind: 'transfer-in' | 'transfer-out'; counterparty: string } | 'other' | null => {
      const leg = legByRef.get(`${r.block_height}:${r.event_index}`)
      // Read-model miss: still a real transfer, direction just unknown.
      if (!leg) return 'other'
      if (transferEventPriority(r.event_name) !== priority.get(mirrorKey(r, leg))) return null
      const fromIn = scoped.has(leg.from), toIn = scoped.has(leg.to)
      // Internal shuffles between the scoped accounts change no value; a pool/
      // MM-contract COUNTERPARTY marks a swap or MM leg represented elsewhere
      // (the viewed set itself may be such an account — its legs are its
      // activity, the feed's viewingPool exception).
      if (fromIn && toIn) return null
      const counterparty = toIn ? leg.from : leg.to
      if (plumbing.has(counterparty)) return null
      return { kind: toIn ? 'transfer-in' : 'transfer-out', counterparty }
    }

    const out: ValueEvent[] = []
    const seenSwapExtrinsics = new Set<string>()
    for (const r of rows) {
      const base = {
        blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
        extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index),
        timestamp: r.ts, valueUsd: +Number(r.value_usd).toFixed(2), asset: asset(r.asset_id),
        ...(r.amount && r.amount !== '0' ? { amount: r.amount } : {}),
      }
      if (VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name)) {
        const resolved = resolveTransfer(r, mirrorPriority)
        if (!resolved) continue
        if (resolved === 'other') { out.push({ ...base, kind: 'other', counterparty: null }); continue }
        out.push({ ...base, kind: resolved.kind, counterparty: accountRef(resolved.counterparty) })
        continue
      }
      const kind = valueEventKind(r.event_name)
      if (kind === 'swap' && r.extrinsic_index != null) {
        // Router.Executed and the pool's own *Executed describe one trade; rows
        // arrive value-sorted, so the largest leg per extrinsic wins.
        const key = `${r.block_height}:${r.extrinsic_index}`
        if (seenSwapExtrinsics.has(key)) continue
        seenSwapExtrinsics.add(key)
      }
      out.push({ ...base, kind, counterparty: null })
    }
    // One collapsed marker per DCA schedule (summed value, /dca/:id link, at the
    // peak execution). Reserved slots below guarantee the largest surface.
    for (const r of dcaRows) {
      out.push({
        blockHeight: Number(r.block_height), eventIndex: Number(r.event_index), extrinsicIndex: null,
        timestamp: r.ts, kind: 'dca', valueUsd: +Number(r.total_value_usd).toFixed(2),
        asset: asset(r.asset_id), counterparty: null,
        dcaScheduleId: Number(r.schedule_id), dcaTrades: Number(r.trades),
      })
    }
    // Share-token collateral (2-Pool-*) has no historical NAV, valuing those
    // seizures at 0. Fall back to the DEBT side (debtToCover at the debt
    // asset's close) — for GigaHDX liquidations that's HOLLAR, which prices.
    const unpricedLiq = liqRows.filter(r => !(Number(r.value_usd) > 0))
    const liqDebtValue = new Map<string, { assetId: number; valueUsd: number }>()
    if (unpricedLiq.length) {
      const tuples = unpricedLiq.map(r => `(${r.block_height},${r.event_index})`).join(',')
      const debtRes = await client.query({
        query: `SELECT block_height, event_index, any(decoded_args_json) AS args
                FROM price_data.raw_money_market_events
                WHERE (block_height, event_index) IN (${tuples}) AND event_name = 'LiquidationCall'
                GROUP BY block_height, event_index`,
        format: 'JSONEachRow',
      })
      const debtLegs = (await debtRes.json<{ block_height: number; event_index: number; args: string }>())
        .flatMap(r => {
          const args = (safeJson(r.args) ?? {}) as Record<string, unknown>
          const assetId = assetIdFromMmAddress(typeof args.debtAsset === 'string' ? args.debtAsset : '')
          const raw = typeof args.debtToCover === 'string' ? args.debtToCover : ''
          const row = unpricedLiq.find(l => l.block_height === r.block_height && l.event_index === r.event_index)
          return assetId != null && raw && row ? [{ key: `${r.block_height}:${r.event_index}`, assetId, raw, ts: row.ts }] : []
        })
      const closes = await historicalCloses(debtLegs.map(leg => ({ assetId: leg.assetId, ts: leg.ts })))
      for (const leg of debtLegs) {
        const close = closes.get(historicalPriceKey(leg.assetId, leg.ts))
        if (!close) continue
        const value = Number(leg.raw) / 10 ** asset(leg.assetId).decimals * Number(close)
        if (Number.isFinite(value) && value > 0) liqDebtValue.set(leg.key, { assetId: leg.assetId, valueUsd: value })
      }
    }
    const liqEvents: ValueEvent[] = []
    for (const r of liqRows) {
      const priced = Number(r.value_usd) > 0
      const fallback = priced ? undefined : liqDebtValue.get(`${r.block_height}:${r.event_index}`)
      const valueUsd = priced ? Number(r.value_usd) : fallback?.valueUsd ?? 0
      if (!(valueUsd > 0)) continue
      liqEvents.push({
        blockHeight: Number(r.block_height), eventIndex: Number(r.event_index), extrinsicIndex: null,
        timestamp: r.ts, kind: 'liquidation', valueUsd: +valueUsd.toFixed(2),
        asset: asset(fallback ? fallback.assetId : r.asset_id), counterparty: null,
      })
    }
    out.push(...liqEvents)

    // Jump attribution: score every window candidate under its cause (mirror-
    // deduped, echo-collapsed), then give each selected jump ONE marker — the
    // direction-consistent cause with the largest summed USD when it plausibly
    // explains |Δ|, an explicit 'price' marker otherwise.
    const jumpMarkers: ValueEvent[] = []
    if (jumps.length) {
      const isXcmCandidate = (name: string) => VALUE_EVENT_XCM_IN_NAMES.includes(name) || VALUE_EVENT_XCM_OUT_NAMES.includes(name)
      const xcmDirOf = (name: string): 'in' | 'out' => VALUE_EVENT_XCM_IN_NAMES.includes(name) ? 'in' : 'out'
      // Currencies.* mirrors Tokens.* for the same movement — Currencies wins,
      // and its event index matches the row the XCM activity feed keeps.
      const xcmMirrorKey = (r: ValueEventCandidateRow) => `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${r.amount}|${xcmDirOf(r.event_name)}`
      const xcmEventPriority = (name: string) => name.startsWith('Currencies.') ? 2 : 1
      const windowMirrorPriority = buildMirrorPriority(windowTransferRows)
      const xcmPriority = new Map<string, number>()
      for (const r of windowRows) {
        if (!isXcmCandidate(r.event_name)) continue
        const key = xcmMirrorKey(r)
        const p = xcmEventPriority(r.event_name)
        if (p > (xcmPriority.get(key) ?? 0)) xcmPriority.set(key, p)
      }
      const dcaScheduleByBlock = new Map<number, number>()
      for (const r of dcaWindowRows) dcaScheduleByBlock.set(Number(r.block_height), Number(r.schedule_id))
      // Outbound markers point at the XTokens/pallet-xcm Sent event — the row
      // the activity feed keeps (the legacy event wins over its mirror), so the
      // marker's link resolves; the withdrawal is just its funding leg.
      const xcmSentByExtrinsic = new Map<string, { eventIndex: number; name: string }>()
      for (const r of xcmSentRows) {
        const key = `${r.block_height}:${r.extrinsic_index}`
        const cur = xcmSentByExtrinsic.get(key)
        if (!cur || (cur.name !== 'XTokens.TransferredAssets' && r.name === 'XTokens.TransferredAssets')) {
          xcmSentByExtrinsic.set(key, { eventIndex: Number(r.event_index), name: r.name })
        }
      }

      interface JumpCause { score: number; best: ValueEvent | null; bestValue: number; hits: number }
      const causes = new Map<string, JumpCause>() // `${w}:<class>` / `${w}:dca:<scheduleId>`
      const bump = (key: string, value: number, event: ValueEvent, mode: 'sum' | 'max') => {
        const cur = causes.get(key) ?? { score: 0, best: null, bestValue: 0, hits: 0 }
        cur.score = mode === 'sum' ? cur.score + value : Math.max(cur.score, value)
        cur.hits += 1
        if (value > cur.bestValue) { cur.best = event; cur.bestValue = value }
        causes.set(key, cur)
      }
      const seenWindowSwaps = new Set<string>()
      const seenDcaBlocks = new Set<string>()
      // Value-descending so per-trade/per-execution dedup keeps the largest leg.
      const sortedWindowRows = [...windowRows].sort((x, y) => Number(y.value_usd) - Number(x.value_usd))
      for (const r of sortedWindowRows) {
        const w = Number(r.w)
        if (!w) continue
        const value = Number(r.value_usd)
        const base: ValueEvent = {
          blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
          extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index),
          timestamp: r.ts, kind: 'other', valueUsd: +value.toFixed(2), asset: asset(r.asset_id), counterparty: null,
          ...(r.amount && r.amount !== '0' ? { amount: r.amount } : {}),
        }
        if (VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name)) {
          const resolved = resolveTransfer(r, windowMirrorPriority)
          if (!resolved || resolved === 'other') continue
          bump(`${w}:${resolved.kind}`, value, { ...base, kind: resolved.kind, counterparty: accountRef(resolved.counterparty) }, 'sum')
          continue
        }
        if (isXcmCandidate(r.event_name)) {
          if (xcmEventPriority(r.event_name) !== xcmPriority.get(xcmMirrorKey(r))) continue
          const direction = xcmDirOf(r.event_name)
          const sent = direction === 'out' && r.extrinsic_index != null
            ? xcmSentByExtrinsic.get(`${r.block_height}:${r.extrinsic_index}`) : undefined
          bump(`${w}:cross-chain-${direction}`, value,
            { ...base, ...(sent ? { eventIndex: sent.eventIndex } : {}), kind: 'cross-chain', direction }, 'sum')
          continue
        }
        if (SWAP_EVENTS.includes(r.event_name)) {
          const scheduleId = r.extrinsic_index == null ? dcaScheduleByBlock.get(Number(r.block_height)) : undefined
          if (scheduleId != null) {
            // DCA executions sum under their schedule — tracked so a schedule-
            // driven jump doesn't get a bogus 'price' marker, but they surface
            // through the DCA reservation (below), never as a jump marker.
            const blockKey = `${w}:${r.block_height}`
            if (seenDcaBlocks.has(blockKey)) continue
            seenDcaBlocks.add(blockKey)
            bump(`${w}:dca:${scheduleId}`, value, { ...base, kind: 'dca', dcaScheduleId: scheduleId }, 'sum')
            continue
          }
          // A swap between priced assets is value-neutral churn and must never
          // "explain" a jump. Only a swap INTO an unpriced asset (a share token,
          // valued off the wallet curve) actually moves the reconstructed line.
          if (!isUnpricedAsset(Number(r.asset_id))) continue
          const tradeKey = `${w}:${r.block_height}:${r.extrinsic_index ?? `e${r.event_index}`}`
          if (seenWindowSwaps.has(tradeKey)) continue
          seenWindowSwaps.add(tradeKey)
          bump(`${w}:swap`, value, { ...base, kind: 'swap' }, 'max')
          continue
        }
        // Liquidity add/remove — direction-agnostic: LP flows are value shuffles
        // whose reconstructed line can move either way (drip unwinds, principal
        // entering/leaving the LP-valued curve).
        bump(`${w}:liquidity`, value, { ...base, kind: 'liquidity' }, 'sum')
      }
      for (const e of liqEvents) {
        const i = windows.findIndex(win => e.blockHeight > win.startBlock && e.blockHeight <= win.endBlock)
        if (i >= 0) bump(`${i + 1}:liquidation`, e.valueUsd, e, 'sum')
      }

      for (const jump of jumps) {
        const w = windowId.get(jump)!
        // Direction-consistent causes only: an inflow can't explain a drop.
        const allowed = jump.delta > 0
          ? [`${w}:transfer-in`, `${w}:cross-chain-in`, `${w}:liquidity`, `${w}:swap`]
          : [`${w}:transfer-out`, `${w}:cross-chain-out`, `${w}:liquidity`, `${w}:liquidation`, `${w}:swap`]
        // DCA is a candidate cause only to WIN (and thereby suppress a 'price'
        // marker) — a schedule that dominates the window annotates it via the
        // reservation, not a duplicate jump marker.
        const candidateKeys = [...allowed, ...[...causes.keys()].filter(k => k.startsWith(`${w}:dca:`))]
        let winner: { key: string; cause: JumpCause } | null = null
        for (const key of candidateKeys) {
          const cause = causes.get(key)
          if (cause && (!winner || cause.score > winner.cause.score)) winner = { key, cause }
        }
        const explained = winner != null && winner.cause.score >= Math.abs(jump.delta) * VALUE_JUMP_EXPLAIN_FRACTION
        if (explained && winner!.key.startsWith(`${w}:dca:`)) {
          // Schedule covers this jump via its reserved /dca/:id marker — no
          // extra marker here.
          continue
        }
        if (explained && winner!.cause.best) {
          // A multi-event cause sums its USD but `amount` belongs to one leg —
          // drop it rather than pair a window total with a single leg's tokens.
          const best = winner!.cause.best
          jumpMarkers.push(winner!.cause.hits === 1 ? best : { ...best, amount: undefined })
        } else {
          // Nothing discrete accounts for the move — an honest market-move
          // marker carrying the signed delta, pinned to the jump's own point.
          jumpMarkers.push({
            blockHeight: jump.endBlock, eventIndex: 0, extrinsicIndex: null, timestamp: jump.timestamp,
            kind: 'price', valueUsd: +jump.delta.toFixed(2), asset: null, counterparty: null,
          })
        }
      }

      // Cross-chain link verification: an inbound credit / remote-initiated
      // outbound pull marker links to /cross-chain/<block>-e<idx>, which
      // ActivityDetail resolves against the XCM feed's reconstruction
      // (xcmInRowsForBlocks / xcmOutRemoteRowsForBlocks) — NOT the raw deposit/
      // withdraw event. That reconstruction skips reserved accounts, walks back
      // contiguously from the barrier, and mirror-dedups, so the raw event index
      // often has no feed row (deterministic for treasury/sovereign tags). Verify
      // each such marker against the actual feed rows; keep the link only on a
      // match (re-pointing the index to the feed's), else render it unlinked.
      const inBlocks = [...new Set(jumpMarkers.filter(m => m.kind === 'cross-chain' && m.direction === 'in').map(m => m.blockHeight))]
      const outBlocks = [...new Set(jumpMarkers.filter(m => m.kind === 'cross-chain' && m.direction === 'out' && m.extrinsicIndex == null).map(m => m.blockHeight))]
      if (inBlocks.length || outBlocks.length) {
        const prices = await ensurePrices()
        const whoIn = new Set(accounts)
        const [inRows, outRows] = await Promise.all([
          inBlocks.length ? xcmInRowsForBlocks(inBlocks, prices, whoIn) : Promise.resolve([]),
          outBlocks.length ? xcmOutRemoteRowsForBlocks(outBlocks, prices, whoIn) : Promise.resolve([]),
        ])
        // Feed row index keyed by block+asset (one credit per asset per block in
        // practice); re-point the marker to that index so the detail link resolves.
        const feedIndex = new Map<string, number>()
        for (const r of [...inRows, ...outRows]) {
          if (r.eventIndex != null && r.asset) feedIndex.set(`${r.blockHeight}:${r.asset.assetId}`, r.eventIndex)
        }
        for (const m of jumpMarkers) {
          if (m.kind !== 'cross-chain') continue
          if (m.direction === 'out' && m.extrinsicIndex != null) continue // user-sent path already resolves
          const idx = m.asset ? feedIndex.get(`${m.blockHeight}:${m.asset.assetId}`) : undefined
          if (idx != null) m.eventIndex = idx
          else m.linkable = false
        }
      }
    }

    out.sort((x, y) => y.valueUsd - x.valueUsd)
    // Selection order: reserve the largest liquidations and DCA schedules (both
    // shipped, high-signal markers that raw jumps must not crowd out), then one
    // marker per big jump (largest |Δ| first — annotating distinct moves beats
    // raw event size), then a value-fill of the remaining budget. The fill is
    // GATED to the account's own significance threshold, so a flat account never
    // surfaces its dust; a jump that IS a top event dedups by identity, and a
    // DCA schedule never renders twice.
    const fillThreshold = history ? valueJumpThreshold(history.portfolioSeries) : VALUE_JUMP_MIN_USD
    const reservedLiq = out.filter(e => e.kind === 'liquidation').slice(0, VALUE_EVENT_LIQUIDATION_SLOTS)
    const reservedDca = out.filter(e => e.kind === 'dca').slice(0, VALUE_EVENT_DCA_SLOTS)
    const chosen: ValueEvent[] = []
    const usedRefs = new Set<string>()
    const usedSchedules = new Set<number>()
    const take = (e: ValueEvent) => {
      if (chosen.length >= limit) return
      // DCA markers dedup by SCHEDULE, not by (block,event): paired buy/sell
      // schedules argMax to the same peak swap leg, so they legitimately share a
      // ref — collapsing on it would drop a distinct schedule.
      if (e.kind === 'dca' && e.dcaScheduleId != null) {
        if (usedSchedules.has(e.dcaScheduleId)) return
        usedSchedules.add(e.dcaScheduleId)
        chosen.push(e)
        return
      }
      const ref = `${e.blockHeight}:${e.eventIndex}`
      if (usedRefs.has(ref)) return
      usedRefs.add(ref)
      chosen.push(e)
    }
    for (const e of reservedLiq) take(e)
    for (const e of reservedDca) take(e)
    for (const e of jumpMarkers) take(e)
    // Value-fill: only genuinely significant events (≥ this account's jump
    // threshold). 'price'/'cross-chain' jump markers already annotate the moves;
    // this backfills large discrete events that weren't themselves a jump.
    for (const e of out) if (e.valueUsd >= fillThreshold) take(e)

    // Pair enrichment for the few chosen markers: a swap hover should say which
    // asset traded for which, a DCA hover its schedule's pair. Swap markers were
    // scored on one leg row; re-read the trade's rows and prefer the router net
    // summary so multi-hop routes show the true end-to-end pair.
    const swapMarkers = chosen.filter(e => e.kind === 'swap')
    if (swapMarkers.length) {
      const blocks = [...new Set(swapMarkers.map(e => e.blockHeight))]
      const res = await client.query({
        query: `SELECT block_height, event_index, extrinsic_index, event_name, asset_in, asset_out
                FROM price_data.swap_activity WHERE block_height IN (${blocks.join(',')})`,
        format: 'JSONEachRow',
      })
      const rows = await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; event_name: string; asset_in: number; asset_out: number }>()
      for (const e of swapMarkers) {
        const inTrade = rows.filter(r => Number(r.block_height) === e.blockHeight && (e.extrinsicIndex != null
          ? r.extrinsic_index != null && Number(r.extrinsic_index) === e.extrinsicIndex
          : Number(r.event_index) === e.eventIndex))
        const rep = inTrade.find(r => isRouterNet(r.event_name))
          ?? inTrade.find(r => Number(r.event_index) === e.eventIndex)
          ?? inTrade[0]
        if (rep) { e.assetIn = asset(Number(rep.asset_in)); e.assetOut = asset(Number(rep.asset_out)) }
      }
    }
    const dcaMarkers = chosen.filter(e => e.kind === 'dca' && e.dcaScheduleId != null)
    if (dcaMarkers.length) {
      const res = await client.query({
        query: `SELECT id, any(asset_in) AS asset_in, any(asset_out) AS asset_out
                FROM price_data.dca_schedules WHERE id IN (${dcaMarkers.map(e => e.dcaScheduleId).join(',')})
                GROUP BY id`,
        format: 'JSONEachRow',
      })
      const byId = new Map((await res.json<{ id: string; asset_in: number; asset_out: number }>())
        .map(r => [Number(r.id), r]))
      for (const e of dcaMarkers) {
        const s = byId.get(e.dcaScheduleId!)
        // Legacy schedules created before the order landed in the event store
        // asset_in = asset_out = 0 — no honest pair to show.
        if (s && !(Number(s.asset_in) === 0 && Number(s.asset_out) === 0)) {
          e.assetIn = asset(Number(s.asset_in))
          e.assetOut = asset(Number(s.asset_out))
        }
      }
    }

    // Chronological order for rendering.
    return chosen.sort((x, y) => x.blockHeight - y.blockHeight || x.eventIndex - y.eventIndex)
  })
}

export async function getAddressValueEvents(addressInput: string, from?: string, to?: string): Promise<ValueEvent[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountValueEvents(resolved.related, `addr:${resolved.norm.accountId}`, from, to)
}

export async function getTagValueEvents(tagId: string, from?: string, to?: string): Promise<ValueEvent[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  // Jump detection reads the SAME series getTag charts: members plus their
  // truncated-EVM twins (and the same shared cache key). Attribute jumps over
  // that twin-inclusive set too, so money-market/aToken flows that sit under a
  // twin are matched to their jump instead of falling back to a bogus `price`
  // marker — mirrors the address path passing its twin-inclusive `related` set.
  const historyAccounts = [...new Set([...members, ...members.map(evmAccountForm).filter(Boolean) as string[]])]
  return getAccountValueEvents(historyAccounts, `tag:${tagId}`, from, to, VALUE_EVENT_DEFAULT_LIMIT, historyAccounts)
}

// The account's extrinsics feed: extrinsics it SIGNED, plus extrinsics
// executed ON ITS BEHALF — Proxy.proxy calls whose `real` is the account
// (proxy_call_activity) and multisig operations of a multisig it is
// (multisig_operation_activity), one row per operation at its anchor
// extrinsic. Branches are unioned, deduplicated per extrinsic (on-behalf
// wins so the badge survives self-proxy), sorted, then sliced — pagination
// stays deterministic over the full filtered ordering. `call`/`result`
// filters match the DISPLAYED call name / result (the inner call for
// on-behalf rows); pending operations match neither result value.
async function getAccountExtrinsics(accounts: string[], limit = 25, offset = 0, cacheKey?: string, filters: ExtrinsicListFilters = {}, from?: string, to?: string): Promise<ExtrinsicSummary[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  const tw = timeWindow(from, to)
  const bound = tw ?? '1'
  return cached(`explorer:${cacheKey ?? `acct-extrinsics:${[...accounts].sort().join(',')}`}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : 8000, async () => {
    const hasCallFilter = Boolean(filters.call?.trim())
    const displayCallFilter = hasCallFilter ? textNameFilter('display_call_name', 'callName') : ''
    const displayResultFilter = filters.result === 'success' ? 'AND display_success = 1'
      : filters.result === 'failed' ? 'AND display_success = 0' : ''
    const summaryCols = `x.block_height AS block_height, x.extrinsic_index AS extrinsic_index, x.extrinsic_hash AS extrinsic_hash,
             toString(x.block_timestamp) AS ts, coalesce(x.signer, x.effective_signer) AS signer, x.success AS success,
             x.call_name AS call_name, x.fee AS fee`
    const branches: string[] = []
    if (!filters.origin || filters.origin === 'signed') {
      branches.push(`
        SELECT ${summaryCols},
               x.call_name AS display_call_name, toNullable(x.success) AS display_success,
               'signed' AS origin_kind, '' AS ms_state, toUInt16(0) AS ms_threshold, toUInt16(0) AS ms_signatories,
               toUInt16(0) AS ms_approvals, '' AS ms_call_hash
        FROM price_data.raw_extrinsics AS x
        WHERE ${bound} AND (x.signer IN (${list}) OR x.effective_signer IN (${list}))
          ${displayCallFilter} ${displayResultFilter}
        ORDER BY x.block_height DESC, x.extrinsic_index DESC
        LIMIT {branchLimit:UInt32}`)
    }
    if (!filters.origin || filters.origin === 'proxy') {
      branches.push(`
        SELECT ${summaryCols},
               if(p.inner_call_name != '', p.inner_call_name, p.proxy_call_name) AS display_call_name,
               coalesce(p.inner_success, x.success) AS display_success,
               'proxy' AS origin_kind, '' AS ms_state, toUInt16(0) AS ms_threshold, toUInt16(0) AS ms_signatories,
               toUInt16(0) AS ms_approvals, '' AS ms_call_hash
        FROM price_data.raw_extrinsics AS x
        INNER JOIN (
          SELECT block_height, extrinsic_index, call_address, proxy_call_name, inner_call_name, inner_success
          FROM price_data.proxy_call_activity
          WHERE real_account IN (${list})
        ) AS p ON p.block_height = x.block_height AND p.extrinsic_index = x.extrinsic_index
        WHERE (x.block_height, x.extrinsic_index) IN (
            SELECT block_height, extrinsic_index FROM price_data.proxy_call_activity WHERE real_account IN (${list}))
          AND ${bound} ${displayCallFilter} ${displayResultFilter}
        ORDER BY x.block_height DESC, x.extrinsic_index DESC, p.call_address
        LIMIT 1 BY x.block_height, x.extrinsic_index
        LIMIT {branchLimit:UInt32}`)
    }
    if (!filters.origin || filters.origin === 'multisig') {
      branches.push(`
        SELECT ${summaryCols},
               if(m.inner_call_name != '', m.inner_call_name, x.call_name) AS display_call_name,
               if(m.state = 'pending', NULL, m.inner_success) AS display_success,
               'multisig' AS origin_kind, toString(m.state) AS ms_state, m.threshold AS ms_threshold,
               m.signatories AS ms_signatories, m.approvals AS ms_approvals,
               if(m.inner_call_name = '', m.call_hash, '') AS ms_call_hash
        FROM price_data.raw_extrinsics AS x
        INNER JOIN (
          SELECT multisig, call_hash, state, threshold, signatories, approvals,
                 anchor_block_height, anchor_extrinsic_index, inner_call_name, inner_success
          FROM price_data.multisig_operation_activity
          WHERE multisig IN (${list})
        ) AS m ON m.anchor_block_height = x.block_height AND m.anchor_extrinsic_index = x.extrinsic_index
        WHERE (x.block_height, x.extrinsic_index) IN (
            SELECT anchor_block_height, anchor_extrinsic_index FROM price_data.multisig_operation_activity WHERE multisig IN (${list}))
          AND ${bound} ${displayCallFilter} ${displayResultFilter}
        ORDER BY x.block_height DESC, x.extrinsic_index DESC, m.call_hash
        LIMIT 1 BY x.block_height, x.extrinsic_index
        LIMIT {branchLimit:UInt32}`)
    }
    const res = await client.query({
      query: `
        SELECT * FROM (${branches.join(' UNION ALL ')})
        ORDER BY block_height DESC, extrinsic_index DESC, origin_kind = 'signed' ASC, origin_kind ASC
        LIMIT 1 BY block_height, extrinsic_index
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { limit, offset, branchLimit: offset + limit, ...textNameParams('callName', filters.call) },
      format: 'JSONEachRow',
    })
    const rows = await res.json<ExtrinsicSummaryRow>()
    return uniqueExtrinsicSummaries(rows)
  })
}

// Events that mention the account. Each account_id appears in args_json as its
// lowercase 0x-less hex (e.g. Balances.Transfer {from,to}); positionCaseInsensitive
// finds any leg referencing one of the related accounts. Bounded by recency
// (ORDER BY block_height DESC) + LIMIT/OFFSET. Same shape as getRecentEvents.
export async function getAddressEvents(addressInput: string, limit = 25, offset = 0, filters: EventListFilters = {}, from?: string, to?: string): Promise<EventRow[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountEvents(resolved.related, limit, offset, `addr-events:${resolved.norm.accountId}`, filters, from, to)
}

// Events mentioning any account in an explicit set (related-account set, or a
// tag's members). Shared by getAddressEvents and the tag events endpoint.
async function getAccountEvents(accounts: string[], limit = 25, offset = 0, cacheKey?: string, filters: EventListFilters = {}, from?: string, to?: string): Promise<EventRow[]> {
  const hexes = accounts.filter(a => ACCOUNT_RE.test(a)).map(a => a.slice(2).toLowerCase())
  if (!hexes.length) return []
  const tw = timeWindow(from, to)
  const bound = tw ?? '1'
  return cached(`explorer:${cacheKey ?? `acct-events:${[...accounts].sort().join(',')}`}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : 8000, async () => {
    const eventFilter = filters.event?.trim() ? textNameFilter('event_name', 'eventName') : ''
    const list = sqlAccountList(accounts)
    let rows: EventSourceRow[]
    if (list !== "''") {
      // Page over (block, event) references through the account-activity index,
      // then fetch only those rows from raw_events.
      const refsRes = await client.query({
        query: `
          SELECT block_height, event_index
          FROM price_data.account_activity
          WHERE ${bound} AND account IN (${list})
            ${eventFilter}
          GROUP BY block_height, event_index
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset, ...textNameParams('eventName', filters.event) }, format: 'JSONEachRow',
      })
      const refs = await refsRes.json<{ block_height: number; event_index: number }>()
      if (!refs.length) return []
      const res = await client.query({
        query: `
          SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
          FROM price_data.raw_events
          WHERE (block_height, event_index) IN (${refs.map(r => `(${r.block_height},${r.event_index})`).join(',')})
          ORDER BY block_height DESC, event_index DESC`,
        format: 'JSONEachRow',
      })
      rows = await res.json<EventSourceRow>()
    } else {
      const cond = hexes.map(h => `positionCaseInsensitive(args_json, '${h}') > 0`).join(' OR ')
      const res = await client.query({
        query: `
          SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
          FROM price_data.raw_events
          WHERE ${bound}
            AND (${cond})
            ${eventFilter}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset, ...textNameParams('eventName', filters.event) }, format: 'JSONEachRow',
      })
      rows = await res.json<EventSourceRow>()
    }
    return uniqueEventRows(rows)
  })
}

// money market directory
export interface MoneyMarketRow {
  account: AccountRef
  supplyUsd: number
  debtUsd: number
  netWorthUsd: number
  healthFactor: string
  blockHeight: number
}
export async function getMoneyMarket(limit: number): Promise<{ totalSupplyUsd: number; totalDebtUsd: number; positions: MoneyMarketRow[] }> {
  return cached(`explorer:money-market:${limit}`, 15000, async () => {
    // This legacy directory contract is intentionally PRIMARY-only: its single
    // health factor and DefiSim semantics cannot represent isolated markets. The
    // account/tag payloads expose supplemental positions contextually instead.
    const res = await client.query({
      query: `
        WITH primary_positions AS (
          SELECT account_id,
            argMax(total_collateral_base, ${moneyMarketPositionOrderSql()}) AS col,
            argMax(total_debt_base, ${moneyMarketPositionOrderSql()}) AS debt,
            argMax(health_factor, ${moneyMarketPositionOrderSql()}) AS hf,
            max(block_height) AS lb
          FROM price_data.raw_money_market_positions
          WHERE account_id != '' AND lower(pool_address) = '${CORE_MM_MARKET.poolProxy}'
          GROUP BY account_id
        )
        SELECT account_id,
          col, debt, hf, lb,
          toString(sum(toUInt256OrZero(col)) OVER ()) AS total_col,
          toString(sum(toUInt256OrZero(debt)) OVER ()) AS total_debt
        FROM primary_positions
        WHERE toUInt256OrZero(col) > 0 OR toUInt256OrZero(debt) > 0
        ORDER BY if(toUInt256OrZero(debt) > 0, toUInt256OrZero(hf), toUInt256('${MAX_UINT256}')) ASC
        LIMIT {limit:UInt32}`,
      query_params: { limit }, format: 'JSONEachRow',
    })
    const rows = await res.json<{ account_id: string; col: string; debt: string; hf: string; lb: number; total_col: string; total_debt: string }>()
    const positions: MoneyMarketRow[] = rows.map(r => {
      const supplyUsd = Number(r.col) / 1e8
      const debtUsd = Number(r.debt) / 1e8
      return {
        account: accountRef(r.account_id), supplyUsd, debtUsd, netWorthUsd: supplyUsd - debtUsd,
        healthFactor: r.hf === MAX_UINT256 ? 'inf' : r.hf, blockHeight: r.lb,
      }
    })
    return {
      totalSupplyUsd: Number(rows[0]?.total_col ?? 0) / 1e8,
      totalDebtUsd: Number(rows[0]?.total_debt ?? 0) / 1e8,
      positions,
    }
  })
}

// asset detail
export interface AssetDetail {
  asset: AssetListItem
  holderCount: number
  totalUsd: number
  priceSeries: number[]
  priceDates: string[]
}
export async function getAssetDetail(assetId: number): Promise<AssetDetail> {
  return cached(`explorer:asset:${assetId}`, 30000, async () => {
    const prices = await ensurePrices()
    const a = assetDescriptor(assetId)
    const p = prices.get(assetId)
    const type = explorerAssetType(a)

    // The full holder list is paginated via /explorer/holders; here we only need
    // the holder count and total held USD (a one-row page carries both via the
    // window aggregates), so the asset-detail payload stays small.
    const hsummary = await getHolders(assetId, 1, 0)
    // `amountUsd` is the total USD held of this asset — the same value the asset
    // list surfaces — so reuse the holder summary's total here.
    const assetItem: AssetListItem = { ...a, price: p?.price ?? null, change24h: p?.change24h ?? null, type, amountUsd: hsummary.totalUsd }

    // Full available daily closes from the proven OHLC view. The UI receives the
    // dates too so performance chips can be shown only when the relevant window
    // exists for this asset.
    let priceSeries: number[] = []
    let priceDates: string[] = []
    try {
      const end = new Date()
      const start = new Date(0)
      const fmt = (d: Date) => d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
      const pxRes = await client.query({
        query: `SELECT toString(interval_start) AS ts, toFloat64(close) AS px
                FROM price_data.ohlc_1d_query(asset_id={id:UInt32}, start_time={s:DateTime}, end_time={e:DateTime})
                WHERE close > 0
                ORDER BY interval_start`,
        query_params: { id: priceAssetId(assetId), s: fmt(start), e: fmt(end) }, format: 'JSONEachRow',
      })
      for (const r of await pxRes.json<{ ts: string; px: number }>()) {
        if (!(r.px > 0)) continue
        priceDates.push(r.ts)
        priceSeries.push(r.px)
      }
    } catch { /* asset may have no OHLC */ }

    return { asset: assetItem, holderCount: hsummary.total, totalUsd: hsummary.totalUsd, priceSeries, priceDates }
  })
}

// all accounts ranked by portfolio (tag-grouped)
export interface TopAccountRow {
  account: AccountRef | null
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  portfolioUsd: number
  lastBlock: number
  healthFactor?: string | null
  identity?: string | null
  suppliedUsd: number | null
  borrowedUsd: number | null
  // Account holding the group's worst-HF position (DefiSim link target for tags).
  simAccount?: string | null
  supplementalMarket?: { marketKey: string; market: string; borrowedUsd: number; healthFactor?: string | null }
  // 1Y wallet-value sparkline (SPARK_WEEKS weekly points, zero-padded so every
  // row spans the same trailing year) + activity counter. Optional — the page
  // still renders if the enrichment pass fails.
  sparkline?: number[]
  activityCount?: number
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  // Up to 4 largest holdings (> $10, highest USD first) for the icon cluster
  // shown after the row's value. Tag rows aggregate holdings across members.
  topAssets?: { asset: AssetRef; valueUsd: number }[]
}

// 1Y value sparkline
export const SPARK_WEEKS = 53
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// The 53 points are fixed calendar weeks: bucket 52 is the current (possibly
// partial) Monday-Sunday week and bucket 0 begins 52 Mondays earlier. UTC keeps
// the boundary identical to ClickHouse Date/toMonday regardless of API host TZ.
export function sparklineCalendarWindowStart(now: Date = new Date()): Date {
  const timestamp = now.getTime()
  if (!Number.isFinite(timestamp)) throw new RangeError('invalid sparkline date')
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const daysSinceMonday = (now.getUTCDay() + 6) % 7
  return new Date(midnightUtc - daysSinceMonday * DAY_MS - (SPARK_WEEKS - 1) * WEEK_MS)
}
// Assemble one group's weekly value series from raw parts, all pre-bucketed to
// SPARK_WEEKS trailing weeks: in-window balance observations (forward-filled per
// account+asset — summing across accounts per bucket would sawtooth, see
// getAccountHistory), an exact pre-window baseline per account+asset (dormant
// holdings show their real flat value rather than 0; accounts born inside the
// window keep leading zeros), and weekly close prices per asset (forward-filled,
// with the earliest indexed close covering the leading buckets).
export function buildValueSparkline(
  obs: { account_id: string; asset_id: string; b: number; bal: string }[],
  baseline: Map<string, string>,                       // `${account}|${asset}` → raw balance at window start
  pricesByAsset: Record<string, Map<number, number>>,  // asset_id → bucket → weekly close
  decimals: Map<string, number>,                       // asset_id → decimals
): number[] | null {
  const byKey = new Map<string, Map<number, string>>()
  for (const [k, bal] of baseline) byKey.set(k, new Map([[-1, bal]]))
  for (const r of obs) {
    const k = `${r.account_id}|${r.asset_id}`
    if (!byKey.has(k)) byKey.set(k, new Map())
    byKey.get(k)!.set(r.b, r.bal)
  }
  const series: number[] = new Array(SPARK_WEEKS).fill(0)
  for (const [k, balMap] of byKey) {
    const assetId = k.slice(k.indexOf('|') + 1)
    const dec = decimals.get(assetId) ?? 12
    const pxMap = pricesByAsset[assetId] ?? new Map<number, number>()
    if (pxMap.size === 0 && [...balMap.values()].some(value => BigInt(value) !== 0n)) return null
    let earliest = 0
    for (let b = 0; b < SPARK_WEEKS; b++) { const p = pxMap.get(b); if (p != null) { earliest = p; break } }
    let bal: string | null = balMap.get(-1) ?? null
    let px = earliest
    for (let b = 0; b < SPARK_WEEKS; b++) {
      if (balMap.has(b)) bal = balMap.get(b)!
      const p = pxMap.get(b)
      if (p != null) px = p
      if (bal != null && px > 0) series[b] += (Number(bal) / 10 ** dec) * px
    }
  }
  return series.map(v => +v.toFixed(2))
}
export type AccountSort = 'value' | 'supplied' | 'borrowed' | 'health' | 'identity' | 'activity' | 'volume' | 'liquidation'
export interface AccountsPage { rows: TopAccountRow[]; total: number }
const ACCOUNT_DIRECTORY_SNAPSHOT_MAX_AGE_SECONDS = 10 * 60

async function loadAccountDirectorySnapshot(snapshotKey: string): Promise<AccountsPage | null> {
  const res = await client.query({
    query: `SELECT payload_json,dateDiff('second',computed_at,now()) AS age,
        ${omnipoolAccountClaimsReady
          ? `computed_at >= (SELECT max(computed_at)
              FROM price_data.omnipool_account_claim_snapshot_state FINAL
              WHERE snapshot_key = 'current')`
          : '1'} AS covers_claims,
        ${moneyMarketAccountValuesReady
          ? `computed_at >= (SELECT max(computed_at)
              FROM price_data.money_market_account_value_snapshot_state FINAL
              WHERE snapshot_key = 'current')`
          : '1'} AS covers_money_market
      FROM price_data.account_directory_snapshots FINAL
      WHERE snapshot_key={snapshotKey:String} LIMIT 1`,
    query_params: { snapshotKey }, format: 'JSONEachRow',
  })
  const row = (await res.json<{ payload_json: string; age: number; covers_claims: number; covers_money_market: number }>())[0]
  if (!row || Number(row.age) > ACCOUNT_DIRECTORY_SNAPSHOT_MAX_AGE_SECONDS || Number(row.covers_claims) !== 1 || Number(row.covers_money_market) !== 1) return null
  try {
    const page = JSON.parse(row.payload_json) as AccountsPage
    return Array.isArray(page?.rows) && Number.isSafeInteger(page.total) ? page : null
  } catch { return null }
}

function accountDirectoryModelVersion(): string {
  if (omnipoolAccountClaimsReady && moneyMarketAccountValuesReady) return 'v3'
  return omnipoolAccountClaimsReady ? 'v2' : 'v1'
}

async function persistAccountDirectorySnapshot(snapshotKey: string, page: AccountsPage): Promise<void> {
  await client.insert({
    table: 'price_data.account_directory_snapshots',
    values: [{
      snapshot_key: snapshotKey,
      payload_json: JSON.stringify(page),
      computed_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    }],
    format: 'JSONEachRow',
  })
}

// ORDER BY clause per sort mode. Rows with no displayed value for the chosen
// column sort last; ties fall back to portfolio value.
const ACCOUNT_SORT_SQL: Record<AccountSort, string> = {
  value: 'isNull(usd_total) ASC, usd_total DESC',
  supplied: 'if(mm_col <= 0, 1, 0) ASC, mm_col DESC, usd_total DESC',
  borrowed: 'if(mm_debt <= 0, 1, 0) ASC, mm_debt DESC, usd_total DESC',
  // Riskiest first: real debt positions before pure suppliers/no-position rows,
  // then by ascending health factor (smaller is closer to liquidation).
  health: 'if(mm_debt <= 0, 1, 0) ASC, mm_hf_num ASC, usd_total DESC',
  // Named accounts (tag or on-chain identity) first, alphabetically; the unnamed
  // rest by value.
  identity: 'if(has_identity = 0, 1, 0) ASC, lowerUTF8(disp_name) ASC, usd_total DESC',
  activity: 'activity_count DESC, usd_total DESC',
  volume: 'trading_volume_usd DESC, usd_total DESC',
  liquidation: 'if(liquidation_volume_usd <= 0, 1, 0) ASC, liquidation_volume_usd DESC, usd_total DESC',
}

// Total number of account rows (single accounts + tagged groups, tag members
// collapsed into one). Offset-independent, so it's cached on its own key and
// reused across pages.
async function getAccountsTotal(): Promise<number> {
  const modelVersion = accountDirectoryModelVersion()
  return cachedSwr(`explorer:accounts-total:${accountValueGenerationEpoch}:${modelVersion}`, 60_000, 30 * 60_000, async () => {
    const res = await client.query({
      query: `
        WITH tags AS (SELECT account_id, any(label_id) AS lid
                        FROM price_data.account_tags FINAL WHERE deleted = 0 GROUP BY account_id)
        SELECT uniqExact(if(t.lid = '', o.account_id, t.lid)) AS total
        FROM (
          SELECT account_id FROM price_data.account_asset_latest_balances GROUP BY account_id
          ${omnipoolAccountClaimsReady ? `UNION ALL
          SELECT account_id FROM price_data.omnipool_account_claim_snapshots
          WHERE snapshot_id = (
            SELECT argMax(snapshot_id, computed_at)
            FROM price_data.omnipool_account_claim_snapshot_state
            WHERE snapshot_key = 'current'
          ) GROUP BY account_id` : ''}
        ) o
        LEFT JOIN tags t ON t.account_id = o.account_id`,
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ total: string }>()
    return Number(rows[0]?.total ?? 0)
  })
}

// Paginated directory of every account that has a balance observation (seeded
// to the full chain by the snapshot-balances bootstrap). Sorting, money-market
// enrichment, and identity-presence are all resolved server-side so a single
// page can be ordered correctly against the whole set.
export async function getAccounts(offset: number, limit: number, sort: AccountSort = 'value'): Promise<AccountsPage> {
  // Whole-directory ranking: every refresh re-aggregates all balances (+ MM
  // positions, and full-history volume CTEs for some sorts) just to render one
  // page — seconds of ClickHouse time. Serve stale-while-revalidating so only a
  // truly cold first hit ever waits; the prewarmer below keeps the default view
  // from ever being cold.
  const modelVersion = accountDirectoryModelVersion()
  return cachedSwr(`explorer:accounts:${accountValueGenerationEpoch}:${modelVersion}:${sort}:${offset}:${limit}`, 60_000, 30 * 60_000, async () => {
    const snapshotKey = `${modelVersion}:${sort}:${offset}:${limit}`
    const snapshot = await loadAccountDirectorySnapshot(snapshotKey).catch(() => null)
    if (snapshot) return snapshot
    const prices = await ensureAccountValuePrices()
    const { idsSql, unitsSql } = priceTransformArrays(prices)
    const orderBy = ACCOUNT_SORT_SQL[sort] ?? ACCOUNT_SORT_SQL.value
    const includeActivitySort = sort === 'activity'
    const includeVolumeSort = sort === 'volume'
    const includeLiquidationSort = sort === 'liquidation'
    const activityCte = includeActivitySort ? `,
            activity AS (
              SELECT if(t.lid = '', a.account_id, t.lid) AS gkey,
                toUInt64(uniqMerge(a.activity_state)) AS activity
              FROM (
                SELECT
                  coalesce(b.owner, if(
                    substring(w.account_id, 3, 8) = '45544800' AND substring(w.account_id, 11, 8) IN ('6d6f646c', '7369626c', '70617261'),
                    concat('0x', substring(w.account_id, 11, 40), '000000000000000000000000'),
                    w.account_id)) AS account_id,
                  w.activity_state
                FROM price_data.account_balance_weekly w
                LEFT JOIN bind b ON b.eth_id = w.account_id
                WHERE w.account_id != ''
              ) a
              LEFT JOIN tags t ON t.account_id = a.account_id
              GROUP BY gkey
            )` : ''
    const activityJoin = includeActivitySort ? 'LEFT JOIN activity act ON act.gkey = g.gkey' : ''
    const activitySelect = includeActivitySort ? 'ifNull(act.activity, 0)' : 'toUInt64(0)'
    const volumeCte = includeVolumeSort ? `,
            trade_volume_raw AS (
              SELECT account AS account_id, toFloat64(sum(${accountVolumeSource().col})) AS volume_usd
              FROM ${accountVolumeSource().table}
              WHERE match(account, '^0x[0-9a-f]{64}$')
              GROUP BY account_id
            ),
            trade_volume AS (
              SELECT if(t.lid = '', v.account_id, t.lid) AS gkey, sum(v.volume_usd) AS volume_usd
              FROM (
                SELECT
                  coalesce(b.owner, if(
                    substring(vr.account_id, 3, 8) = '45544800' AND substring(vr.account_id, 11, 8) IN ('6d6f646c', '7369626c', '70617261'),
                    concat('0x', substring(vr.account_id, 11, 40), '000000000000000000000000'),
                    vr.account_id)) AS account_id,
                  sum(vr.volume_usd) AS volume_usd
                FROM trade_volume_raw vr
                LEFT JOIN bind b ON b.eth_id = vr.account_id
                GROUP BY account_id
              ) v
              LEFT JOIN tags t ON t.account_id = v.account_id
              GROUP BY gkey
            )` : ''
    const volumeJoin = includeVolumeSort ? 'LEFT JOIN trade_volume tv ON tv.gkey = g.gkey' : ''
    const volumeSelect = includeVolumeSort ? 'ifNull(tv.volume_usd, 0.)' : '0.'
    const liquidationCte = includeLiquidationSort ? `,
            ${liquidationVolumeCtes()},
            liquidation_volume AS (
              SELECT if(t.lid = '', v.account_id, t.lid) AS gkey, sum(v.volume_usd) AS volume_usd
              FROM (
                SELECT
                  coalesce(b.owner, if(
                    substring(vr.account_id, 3, 8) = '45544800' AND substring(vr.account_id, 11, 8) IN ('6d6f646c', '7369626c', '70617261'),
                    concat('0x', substring(vr.account_id, 11, 40), '000000000000000000000000'),
                    vr.account_id)) AS account_id,
                  sum(vr.volume_usd) AS volume_usd
                FROM liquidation_volume_raw vr
                LEFT JOIN bind b ON b.eth_id = vr.account_id
                GROUP BY account_id
              ) v
              LEFT JOIN tags t ON t.account_id = v.account_id
              GROUP BY gkey
            )` : ''
    const liquidationJoin = includeLiquidationSort ? 'LEFT JOIN liquidation_volume lv ON lv.gkey = g.gkey' : ''
    const liquidationSelect = includeLiquidationSort ? 'ifNull(lv.volume_usd, 0.)' : '0.'
    const lpClaimsCte = omnipoolAccountClaimsReady ? `,
            lp_claims AS (
              SELECT s.account_id, s.asset_id, s.amount, s.hub_amount
              FROM price_data.omnipool_account_claim_snapshots s
              WHERE s.snapshot_id = (
                SELECT argMax(snapshot_id, computed_at)
                FROM price_data.omnipool_account_claim_snapshot_state
                WHERE snapshot_key = 'current'
              )
            )` : ''
    const lpActors = omnipoolAccountClaimsReady ? `
                UNION ALL
                -- Position-only accounts must remain in the directory even when
                -- they currently have no fungible wallet balance.
                SELECT account_id, '0' AS asset_id, toUInt256(0) AS bal, toUInt32(0) AS lb
                FROM lp_claims GROUP BY account_id` : ''
    const lpGroupedCte = omnipoolAccountClaimsReady ? `,
            lp_grouped AS (
              SELECT if(t.lid = '', p.account_id, t.lid) AS gkey,
                sum(toFloat64(p.amount) * transform(toString(p.asset_id), ${idsSql}, ${unitsSql}, 0.)
                  + toFloat64(p.hub_amount) * transform('1', ${idsSql}, ${unitsSql}, 0.)) AS usd
              FROM lp_claims p LEFT JOIN tags t ON t.account_id = p.account_id
              GROUP BY gkey
            )` : ''
    const lpJoin = omnipoolAccountClaimsReady ? 'LEFT JOIN lp_grouped lp ON lp.gkey = g.gkey' : ''
    const lpValue = omnipoolAccountClaimsReady ? 'ifNull(lp.usd, 0)' : '0.'
    const mmLatestCte = moneyMarketAccountValuesReady ? `mm_latest AS (
              SELECT account_id,lower(pool_address) AS pool_address,
                greatest(max(toFloat64(total_collateral_base)),
                  sumIf(toFloat64(supplied) * transform(toString(asset_id), ${idsSql}, ${unitsSql}, 0.) * 1e8, reserve_present=1)) AS col,
                greatest(max(toFloat64(total_debt_base)),
                  sumIf(toFloat64(debt) * transform(toString(asset_id), ${idsSql}, ${unitsSql}, 0.) * 1e8, reserve_present=1)) AS debt,
                max(toFloat64(total_collateral_base)) AS risk_col,
                max(toFloat64(total_debt_base)) AS risk_debt,
                max(toFloat64(liquidation_threshold)) AS liqthr
              FROM price_data.money_market_account_value_snapshots
              WHERE snapshot_id=(
                SELECT argMax(snapshot_id,computed_at)
                FROM price_data.money_market_account_value_snapshot_state
                WHERE snapshot_key='current'
              )
              GROUP BY account_id,pool_address
              HAVING col>0 OR debt>0
            )` : `mm_latest AS (
              SELECT account_id,lower(pool_address) AS pool_address,
                argMax(toFloat64OrZero(total_collateral_base),${moneyMarketPositionOrderSql()}) AS col,
                argMax(toFloat64OrZero(total_debt_base),${moneyMarketPositionOrderSql()}) AS debt,
                col AS risk_col,debt AS risk_debt,
                argMax(toFloat64OrZero(current_liquidation_threshold),${moneyMarketPositionOrderSql()}) AS liqthr
              FROM price_data.raw_money_market_positions
              WHERE account_id!='' AND lower(pool_address) IN (${configuredMmPoolsSql()})
              GROUP BY account_id,pool_address
              HAVING col>0 OR debt>0
            )`

    const [res, total] = await Promise.all([
      client.query({
        query: `
          WITH
            tags AS (SELECT account_id, any(label_id) AS lid, any(label_name) AS lname, any(color) AS c, any(icon) AS ic
                       FROM price_data.account_tags FINAL WHERE deleted = 0 GROUP BY account_id),
            -- H160 → bound substrate owner (EVMAccounts.Bound; the bound H160 is
            -- the owner's first 20 bytes, so the ETH-prefixed row is the same
            -- entity's EVM-side pot).
            bind AS (
              ${bindCteSql()}
            )
            ${lpClaimsCte},
            latest AS (
              -- ETH-prefixed rows that stand for a real account are remapped onto
              -- it before grouping: module/sovereign truncations ('modl', 'sibl',
              -- 'para' — full id = the 20 bytes + zero padding) and bound H160s.
              -- Only genuine, unbound EVM accounts keep the ETH-prefixed key.
              SELECT
                coalesce(b.owner, if(
                  substring(l.account_id, 3, 8) = '45544800' AND substring(l.account_id, 11, 8) IN ('6d6f646c', '7369626c', '70617261'),
                  concat('0x', substring(l.account_id, 11, 40), '000000000000000000000000'),
                  l.account_id)) AS account_id,
                l.asset_id AS asset_id, l.bal AS bal, l.lb AS lb
              FROM (
                SELECT
                  account_id,
                  asset_id,
                  toUInt256OrZero(argMaxMerge(total_state)) AS bal,
                  maxMerge(last_block_state) AS lb
                FROM price_data.account_asset_latest_balances
                GROUP BY account_id, asset_id
                UNION ALL
                -- ERC-20-side holdings (HOLLAR): separate pot from the Tokens
                -- balances above (refreshed by erc20WalletService); the group
                -- sum below folds both pots into the account's value.
                SELECT account_id, asset_id, toUInt256OrZero(argMax(total, updated_at)) AS bal, 0 AS lb
                FROM price_data.erc20_wallet_balances
                GROUP BY account_id, asset_id
                HAVING bal > 0
                ${lpActors}
              ) l
              LEFT JOIN bind b ON b.eth_id = l.account_id
            ),
            -- One latest row per configured isolated market. With complete
            -- reserve-principal coverage this is a tiny published generation;
            -- the raw aggregate remains the correctness-first upgrade fallback.
            ${mmLatestCte},
            ident AS (SELECT lower(account_id) AS account_id, any(display) AS display FROM price_data.account_identities FINAL GROUP BY account_id),
            grouped AS (
              SELECT
                if(t.lid = '', latest.account_id, t.lid) AS gkey,
                t.lid AS label_id, any(t.lname) AS lname, any(t.c) AS color, any(t.ic) AS icon,
                uniqExact(latest.account_id) AS members, any(latest.account_id) AS sample, max(latest.lb) AS last_block,
                sum(toFloat64(latest.bal) * transform(latest.asset_id, ${idsSql}, ${unitsSql}, 0.)) AS usd,
                -- Per-asset USD merged across the group's members → top-holding icons.
                -- Fast single-query approximation from the wallet balance tables; the
                -- detail pages' hover card additionally folds in money-market
                -- collateral (aTokens) and EVM-side ERC-20 that only a forward
                -- per-account read can attribute, so the two can differ for those.
                sumMap([latest.asset_id], [toFloat64(latest.bal) * transform(latest.asset_id, ${idsSql}, ${unitsSql}, 0.)]) AS asset_usd_map
              FROM latest LEFT JOIN tags t ON t.account_id = latest.account_id
              GROUP BY gkey, label_id
            )
            ${lpGroupedCte},
            actors AS (SELECT DISTINCT account_id FROM latest),
            -- One pass over the tiny latest-position set computes three separate
            -- concerns: PRIMARY-only columns/risk/DefiSim, all-market net value,
            -- and a compact supplemental-exposure badge.
            mm_grouped AS (
              SELECT
                if(t.lid = '', a.account_id, t.lid) AS gkey,
                sumIf(toFloat64(m.col), m.pool_address = '${CORE_MM_MARKET.poolProxy}') AS col,
                sumIf(toFloat64(m.debt), m.pool_address = '${CORE_MM_MARKET.poolProxy}') AS debt,
                sumIf(toFloat64(m.risk_debt), m.pool_address = '${CORE_MM_MARKET.poolProxy}') AS risk_debt,
                minIf(toFloat64(m.risk_col) * toFloat64(m.liqthr) / 10000. / toFloat64(m.risk_debt),
                  m.pool_address = '${CORE_MM_MARKET.poolProxy}' AND toFloat64(m.risk_debt) > 0) AS worst_hf,
                argMinIf(a.account_id, toFloat64(m.risk_col) * toFloat64(m.liqthr) / 10000. / toFloat64(m.risk_debt),
                  m.pool_address = '${CORE_MM_MARKET.poolProxy}' AND toFloat64(m.risk_debt) > 0) AS worst_acct,
                sum(if(m.pool_address IN (${countedMmPoolsSql()}), toFloat64(m.col), 0.)) - sum(toFloat64(m.debt)) AS value_delta,
                countIf(m.pool_address IN (${supplementalMmPoolsSql()})) AS supplemental_positions,
                sumIf(toFloat64(m.debt), m.pool_address IN (${supplementalMmPoolsSql()})) AS supplemental_debt,
                minIf(toFloat64(m.risk_col) * toFloat64(m.liqthr) / 10000. / toFloat64(m.risk_debt),
                  m.pool_address IN (${supplementalMmPoolsSql()}) AND toFloat64(m.risk_debt) > 0) AS supplemental_worst_hf
              FROM actors a
              LEFT JOIN tags t ON t.account_id = a.account_id
              INNER JOIN mm_latest m ON lower(m.account_id) = if(
                substring(lower(a.account_id), 3, 8) = '45544800' AND substring(lower(a.account_id), 51, 16) = '0000000000000000',
                lower(a.account_id),
                concat('0x45544800', substring(lower(a.account_id), 3, 40), '0000000000000000'))
              GROUP BY gkey
            )
            ${activityCte}
            ${volumeCte}
            ${liquidationCte}
          SELECT
            -- Alias the wallet value explicitly: the lp_grouped join (v3) also exposes a
            -- usd column, so a bare g.usd serialises as the qualified name g.usd in
            -- JSONEachRow -- raw[i].usd then read undefined and the sparkline final-bucket
            -- pin silently became 0 (every sparkline cliffed to zero at the end).
            g.label_id, g.lname, g.color, g.icon, g.members, g.sample, g.last_block, g.usd AS usd,
            ifNull(mg.col, 0) AS mm_col, ifNull(mg.debt, 0) AS mm_debt, mg.worst_acct AS mm_worst_acct,
            if(ifNull(mg.col, 0) > 0 OR ifNull(mg.debt, 0) > 0, 1, 0) AS mm_present,
            ifNull(mg.supplemental_positions, 0) AS supplemental_present,
            ifNull(mg.supplemental_debt, 0) AS supplemental_debt,
            multiIf(ifNull(mg.supplemental_debt, 0) > 0, toString(toUInt256(mg.supplemental_worst_hf * 1e18)), '') AS supplemental_hf,
            -- 1e18-scaled WORST per-position health factor (string); MAX_UINT256 for a
            -- pure supplier so the UI renders "No debt". mm_hf_num is the numeric key
            -- the health sort orders by (riskiest position first).
            multiIf(ifNull(mg.risk_debt, 0) > 0, toString(toUInt256(mg.worst_hf * 1e18)),
                    ifNull(mg.col, 0) > 0, '${MAX_UINT256}', '') AS mm_hf,
            multiIf(ifNull(mg.risk_debt, 0) > 0, mg.worst_hf * 1e18, ifNull(mg.col, 0) > 0, 1e30, 1e31) AS mm_hf_num,
            g.usd + ${lpValue} + ifNull(mg.value_delta, 0) / 1e8 AS usd_total,
            if(g.label_id != '' OR ident.account_id != '', 1, 0) AS has_identity,
            multiIf(g.label_id != '', g.lname, ident.display != '', ident.display, '') AS disp_name,
            ${activitySelect} AS activity_count,
            ${volumeSelect} AS trading_volume_usd,
            ${liquidationSelect} AS liquidation_volume_usd,
            -- (asset_id, usd) for the 4 largest holdings, highest first: worth > $10
            -- AND ≥ 10% of the group's total held value (arraySum of the map).
            arraySlice(
              arrayReverseSort(x -> tupleElement(x, 2),
                arrayFilter(x -> tupleElement(x, 2) > 10. AND tupleElement(x, 2) >= 0.10 * arraySum(tupleElement(g.asset_usd_map, 2)),
                  arrayZip(tupleElement(g.asset_usd_map, 1), tupleElement(g.asset_usd_map, 2)))),
              1, 4) AS top_assets
          FROM grouped g
          LEFT JOIN mm_grouped mg ON mg.gkey = g.gkey
          ${lpJoin}
          LEFT JOIN ident ON g.label_id = '' AND lower(g.sample) = ident.account_id
          ${activityJoin}
          ${volumeJoin}
          ${liquidationJoin}
          ORDER BY ${orderBy}
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset }, format: 'JSONEachRow',
      }),
      getAccountsTotal(),
    ])

    const raw = await res.json<{
      label_id: string; lname: string; color: string; icon: string; members: string; sample: string
      last_block: number; usd: number; usd_total: number; mm_col: number; mm_debt: number; mm_present: number; mm_hf: string; mm_worst_acct: string | null
      supplemental_present: number; supplemental_debt: number; supplemental_hf: string
      has_identity: number; activity_count: number; trading_volume_usd: number; liquidation_volume_usd: number
      top_assets: [string, number][]
    }>()

    const rows: TopAccountRow[] = raw.map(r => {
      const isTag = r.label_id !== ''
      // Set when the group (tag members summed, or the lone account) holds a position.
      const hasMm = r.mm_present === 1
      return {
        account: isTag ? null : accountRef(r.sample),
        tag: isTag ? { tagId: r.label_id, name: r.lname, color: r.color, icon: tagIcon(r.label_id, r.icon), memberCount: Number(r.members) } : null,
        portfolioUsd: r.usd_total, lastBlock: r.last_block,
        healthFactor: hasMm ? (r.mm_hf === MAX_UINT256 ? 'inf' : r.mm_hf) : null,
        // Prefer the on-chain identity display name for single-account rows; tag
        // groups keep their tag label.
        identity: isTag ? r.lname : (identityForAccount(r.sample)?.display ?? null),
        suppliedUsd: hasMm ? Number(r.mm_col) / 1e8 : null,
        borrowedUsd: hasMm ? Number(r.mm_debt) / 1e8 : null,
        // Account holding the group's worst-HF position — the DefiSim deep-link
        // target for tag rows (they have no single address of their own).
        simAccount: hasMm && r.mm_worst_acct ? defiSimTargetForAccountId(r.mm_worst_acct) : null,
        ...(r.supplemental_present > 0 ? {
          supplementalMarket: {
            marketKey: GIGAHDX_MM_MARKET.key,
            market: GIGAHDX_MM_MARKET.label,
            borrowedUsd: Number(r.supplemental_debt) / 1e8,
            healthFactor: r.supplemental_hf ? r.supplemental_hf : null,
          },
        } : {}),
        activityCount: r.activity_count > 0 ? Number(r.activity_count) : undefined,
        tradingVolumeUsd: r.trading_volume_usd > 0 ? Number(r.trading_volume_usd) : undefined,
        liquidationVolumeUsd: r.liquidation_volume_usd > 0 ? Number(r.liquidation_volume_usd) : undefined,
        topAssets: r.top_assets?.length ? r.top_assets.map(([id, valueUsd]) => ({ asset: asset(id), valueUsd })) : undefined,
      }
    })

    // Sparkline + counter enrichment is best-effort — a failure (RPC down, table
    // missing) must never take the directory itself down.
    try {
      await enrichAccountRows(raw, rows)
    } catch (err) {
      console.error('[accounts] row enrichment failed:', err)
    }

    // Overwrite the wallet-only sparkline with the full-portfolio series the detail
    // page shows (parity). Best-effort — on failure the wallet-only fallback stands.
    try {
      await enrichAccountSparklines(raw, rows)
    } catch (err) {
      console.error('[accounts] sparkline parity enrichment failed:', err)
    }

    // Top-holding icons: refine the fast SQL wallet approximation into the exact set
    // the hover card shows, folding in money-market collateral (aTokens) and EVM-side
    // ERC-20 via the same assembly the detail pages use. Best-effort — on failure the
    // SQL approximation from the main query stands.
    try {
      await enrichTopAssets(raw, rows, prices)
    } catch (err) {
      console.error('[accounts] top-asset enrichment failed:', err)
    }

    const page = { rows, total }
    await persistAccountDirectorySnapshot(snapshotKey, page).catch(err => console.error('[accounts] snapshot persist failed:', err))
    return page
  })
}

// Refine each row's top-holding icons to match the detail pages exactly. The main
// query only sees wallet balances; the hover card additionally folds in supplied
// money-market collateral (aTokens, reconstructed) and EVM-side ERC-20. This reuses
// the detail path's own assembly (valueAccountBalances → foldShareBalances →
// applyMmCollateralToBalances → mergeErc20Balances → topHeldTokens) per row so the
// list and hover cannot diverge, while batching the one expensive input (the aToken
// raw_evm_logs scan) across the whole page.
async function enrichTopAssets(
  raw: { label_id: string; sample: string }[],
  rows: TopAccountRow[],
  prices: Map<number, PriceInfo>,
): Promise<void> {
  // Account set per row (tag → members, else the single sample) plus each account's
  // ETH-prefixed twin, where its EVM-side wallet balances live.
  const rowAccounts: string[][] = raw.map(r => {
    const members = r.label_id !== '' ? (getTagRecord(r.label_id)?.members ?? []) : [r.sample]
    const base = members.filter(m => ACCOUNT_RE.test(m))
    const set = new Set<string>(base)
    for (const m of base) { const twin = evmAccountForm(m); if (twin) set.add(twin) }
    return [...set]
  })
  const h160Of = (acc: string) => '0x' + acc.slice(2, 42).toLowerCase()
  const rowH160s: string[][] = rowAccounts.map(accs => [...new Set(accs.map(h160Of))])
  // Reconstruct supplied collateral only for rows flagged with a money-market
  // position (aTokens exist only for configured MM pools). Each holder means a
  // full raw_evm_logs scan, so scanning only real MM holders keeps this ~3× faster
  // than scanning the whole page; non-MM rows keep the SQL wallet approximation.
  const mmHolders = new Set<string>()
  rows.forEach((row, i) => {
    if (row.suppliedUsd != null || row.borrowedUsd != null) for (const h of rowH160s[i]) mmHolders.add(h)
  })
  const reservesByHolder = await mmReservesByHolder([...mmHolders])

  const CONCURRENCY = 8
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const i = next++
      const accounts = rowAccounts[i]
      if (!accounts.length) continue
      try {
        const [walletRows, erc20] = await Promise.all([
          queryAggregatedBalances(sqlAccountList(accounts)),
          erc20WalletHoldingsForAccounts(rowH160s[i]),
        ])
        let balances = foldShareBalances(valueAccountBalances(walletRows, prices))
        // Merge the row's holders' supplied collateral, summing a reserve shared by a
        // tag's members; staking-backed markets (GIGAHDX) are excluded — their
        // collateral is already-counted locked HDX (mirrors getAddress).
        const merged = new Map<number, MmReserve>()
        for (const h of rowH160s[i]) {
          for (const rsv of reservesByHolder.get(h) ?? []) {
            if ((rsv.marketKey ?? 'core') === GIGAHDX_MM_MARKET.key || rsv.supplied === '0') continue
            const cur = merged.get(rsv.assetId)
            if (cur) cur.supplied = (BigInt(cur.supplied) + BigInt(rsv.supplied)).toString()
            else merged.set(rsv.assetId, { ...rsv })
          }
        }
        if (merged.size) {
          applyMmCollateralToBalances(balances, { reserves: [...merged.values()], blockHeight: 0 } as MoneyMarketPosition, prices)
          balances = foldShareBalances(balances)
        }
        balances = mergeErc20Balances(balances, erc20, prices)
        // Authoritative set overwrites the SQL approximation; empty clears it (no
        // holding ≥ 10% of value).
        const top = topHeldTokens(balances)
        rows[i].topAssets = top.length ? top : undefined
      } catch { /* keep the SQL approximation for this row */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))
}

// Per-row enrichment for the accounts directory: the 1Y value sparkline and the
// activity counter, batched per page. Once the resumable historical aggregate is
// complete, this reads weekly states; during deployment/backfill it retains the
// equivalent raw-observation query as a correctness-first fallback.
async function enrichAccountRows(
  raw: { label_id: string; sample: string; usd: number }[],
  rows: TopAccountRow[],
): Promise<void> {
  // Account set per row: tag rows expand to their members; each substrate account
  // also contributes its ETH-prefixed twin (its EVM-side pot, where MM/HOLLAR
  // activity lives). Pallet/sovereign accounts (modl/sibl/para) are excluded from
  // the raw-observation history scan: the omnipool pallet alone owns ~60M balance
  // events. Their sparkline remains absent unless a complete historical source is
  // available; current balances are never projected backward.
  const isModuleAccount = (a: string) => /^0x(6d6f646c|7369626c|70617261)/.test(a)
  const rowMembers: string[][] = raw.map(r => {
    const members = r.label_id !== '' ? (getTagRecord(r.label_id)?.members ?? []) : [r.sample]
    return members.filter(m => ACCOUNT_RE.test(m))
  })
  const rowHistorySubstrate: string[][] = rowMembers.map(members => members.filter(m => !isModuleAccount(m)))
  const rowModuleAccounts: string[][] = rowMembers.map(members => members.filter(isModuleAccount))
  const rowAccounts: string[][] = rowHistorySubstrate.map(members => {
    const set = new Set<string>(members)
    for (const m of members) { const twin = evmAccountForm(m); if (twin) set.add(twin) }
    return [...set]
  })
  const all = [...new Set(rowAccounts.flat())]
  const moduleAccounts = [...new Set(rowModuleAccounts.flat())]
  if (!all.length && !moduleAccounts.length) return
  const list = all.length ? sqlAccountList(all) : "''"

  const winStart = sparklineCalendarWindowStart().toISOString().slice(0, 10)

  // The weekly-state query merges all pre-window states into bucket -1, whose
  // argMax is the exact baseline, and returns the all-time distinct event count
  // as synthetic asset_id='' rows. The fallback uses the same output shape via
  // grouping sets, so the assembly below is independent of readiness.
  let allObs: { account_id: string; asset_id: string; b: number; bal: string; n_ev: number }[] = []
  if (all.length) {
    const obsRes = await client.query({
      query: `SELECT
              account_id,
              asset_id,
              toInt32(greatest(dateDiff('week', {ws:Date}, week_start), -1)) AS b,
              argMaxMerge(balance_state) AS bal,
              toUInt32(0) AS n_ev
            FROM price_data.account_balance_weekly
            WHERE account_id IN (${list})
              AND week_start < addWeeks({ws:Date}, ${SPARK_WEEKS})
            GROUP BY account_id, asset_id, b
            UNION ALL
            SELECT
              account_id,
              '' AS asset_id,
              toInt32(0) AS b,
              '' AS bal,
              toUInt32(uniqMerge(activity_state)) AS n_ev
            FROM price_data.account_balance_weekly
            WHERE account_id IN (${list})
            GROUP BY account_id`,
      query_params: { ws: winStart },
      format: 'JSONEachRow',
    })
    allObs = await obsRes.json<{ account_id: string; asset_id: string; b: number; bal: string; n_ev: number }>()
  }
  const obsRows = allObs.filter(r => r.asset_id !== '' && r.b >= 0)
  const baseRows = allObs.filter(r => r.asset_id !== '' && r.b === -1)
  const actByAcc = new Map(allObs.filter(r => r.asset_id === '').map(r => [r.account_id, r.n_ev]))

  let moduleBalanceRows: { account_id: string; asset_id: string; bal: string }[] = []
  if (moduleAccounts.length) {
    const moduleLookup = [...new Set(moduleAccounts.flatMap(a => {
      const twin = evmAccountForm(a)
      return twin ? [a, twin] : [a]
    }))]
    const moduleList = sqlAccountList(moduleLookup)
    const moduleRes = await client.query({
      query: `SELECT account_id, asset_id, toString(sum(bal_u256)) AS bal
              FROM (
                SELECT
                  if(substring(account_id, 3, 8) = '45544800' AND substring(account_id, 11, 8) IN ('6d6f646c', '7369626c', '70617261'),
                    concat('0x', substring(account_id, 11, 40), '000000000000000000000000'),
                    account_id) AS account_id,
                  asset_id,
                  toUInt256OrZero(argMaxMerge(total_state)) AS bal_u256
                FROM price_data.account_asset_latest_balances
                WHERE account_id IN (${moduleList})
                GROUP BY account_id, asset_id
              )
              GROUP BY account_id, asset_id
              HAVING sum(bal_u256) > 0`,
      format: 'JSONEachRow',
    })
    moduleBalanceRows = await moduleRes.json<{ account_id: string; asset_id: string; bal: string }>()
  }

  // Weekly closes for every involved asset, keyed back by the original id
  // (aTokens/pool shares priced via their underlying). ERC-20 ids are folded in
  // unconditionally so their weekly closes are available for the HOLLAR history
  // contribution below (their balances live off-ledger, so they're never in the
  // observation/latest-balance rows).
  const assetIds = [...new Set([...obsRows, ...baseRows].map(r => r.asset_id).concat(moduleBalanceRows.map(r => r.asset_id)).concat(ERC20_WALLET_ASSET_IDS.map(String)))]
  const priceIdFor = new Map(assetIds.map(id => [id, String(priceAssetId(Number(id)))]))
  const priceIds = sqlUIntList([...priceIdFor.values()])
  const pricesByPriceId = new Map<string, Map<number, number>>()
  if (priceIds) {
    const pxRes = await client.query({
      query: `SELECT toString(asset_id) AS asset_id,
                toUInt32(greatest(least(dateDiff('week', {ws:Date}, toDate(interval_start)), ${SPARK_WEEKS - 1}), 0)) AS b,
                toFloat64(argMaxMerge(close_state)) AS close
              FROM price_data.ohlc_1w
              WHERE interval_start >= toDateTime({ws:Date}) - INTERVAL 7 DAY
                AND interval_start < addWeeks(toDateTime({ws:Date}), ${SPARK_WEEKS})
                AND asset_id IN (${priceIds})
              GROUP BY asset_id, interval_start
              ORDER BY asset_id, interval_start`,
      query_params: { ws: winStart }, format: 'JSONEachRow',
    })
    for (const r of await pxRes.json<{ asset_id: string; b: number; close: number }>()) {
      if (!(r.close > 0)) continue
      if (!pricesByPriceId.has(r.asset_id)) pricesByPriceId.set(r.asset_id, new Map())
      pricesByPriceId.get(r.asset_id)!.set(r.b, r.close)   // later interval wins within a bucket
    }
  }
  const pricesByAsset: Record<string, Map<number, number>> = {}
  const decimalsById = new Map<string, number>()
  for (const id of assetIds) {
    pricesByAsset[id] = pricesByPriceId.get(priceIdFor.get(id)!) ?? new Map()
    decimalsById.set(id, asset(id).decimals)
  }

  // ERC-20-backed HOLLAR history for the sparkline. Contract-storage balances
  // never hit raw_balance_observations / account_asset_latest_balances, so the
  // EVM-twin sparklines would otherwise miss their contract-storage history.
  // Rebuild weekly cumulative balances from indexed Transfer logs into a
  // per-account weekly USD series added before the current-value pin.
  const erc20SparkByAccount = new Map<string, number[]>()
  {
    const h160ForAccount = (acc: string): string | null => {
      const id = acc.toLowerCase()
      if (/^0x(6d6f646c|7369626c|70617261)/.test(id)) return '0x' + id.slice(2, 42)
      return evmFromAccountId(id)?.toLowerCase() ?? null
    }
    const accountsByH160 = new Map<string, string[]>()
    for (const acc of [...all, ...moduleAccounts]) {
      const h = h160ForAccount(acc)
      if (!h) continue
      ;(accountsByH160.get(h) ?? accountsByH160.set(h, []).get(h)!).push(acc)
    }
    const h160s = [...accountsByH160.keys()]
    for (const ea of h160s.length ? ERC20_WALLET_ASSETS : []) {
      const dec = asset(ea.assetId).decimals
      const pxMap = pricesByAsset[String(ea.assetId)] ?? new Map<number, number>()
      let earliest = 0
      for (let b = 0; b < SPARK_WEEKS; b++) { const p = pxMap.get(b); if (p != null) { earliest = p; break } }
      const logRes = await client.query({
        query: `SELECT holder AS w,
                toInt32(greatest(least(dateDiff('week', {ws:Date}, toDate(block_timestamp)), ${SPARK_WEEKS - 1}), -1)) AS b,
                toString(sum(balance_delta)) AS net
              FROM price_data.erc20_transfer_deltas FINAL
              WHERE contract_address = {c:String} AND holder IN ({ws2:Array(String)})
              GROUP BY w, b ORDER BY w, b`,
        query_params: { c: ea.contract, ws: winStart, ws2: h160s }, format: 'JSONEachRow',
      }).catch(() => null)
      if (!logRes) continue
      const netByH160 = new Map<string, Map<number, bigint>>()
      for (const r of await logRes.json<{ w: string; b: number; net: string }>()) {
        if (!netByH160.has(r.w)) netByH160.set(r.w, new Map())
        const m = netByH160.get(r.w)!
        m.set(r.b, (m.get(r.b) ?? 0n) + BigInt(r.net))
      }
      for (const [h, byB] of netByH160) {
        // Cumulate across buckets (bucket -1 = all pre-window transfers = baseline).
        let cum = byB.get(-1) ?? 0n
        let px = earliest
        const series = new Array(SPARK_WEEKS).fill(0)
        for (let b = 0; b < SPARK_WEEKS; b++) {
          cum += byB.get(b) ?? 0n
          const p = pxMap.get(b); if (p != null) px = p
          if (px > 0 && cum > 0n) series[b] = (Number(cum) / 10 ** dec) * px
        }
        for (const acc of accountsByH160.get(h) ?? []) {
          const prev = erc20SparkByAccount.get(acc)
          if (prev) for (let b = 0; b < SPARK_WEEKS; b++) prev[b] += series[b]
          else erc20SparkByAccount.set(acc, series.slice())
        }
      }
    }
  }

  const obsByAccount = new Map<string, { account_id: string; asset_id: string; b: number; bal: string }[]>()
  for (const r of obsRows) (obsByAccount.get(r.account_id) ?? obsByAccount.set(r.account_id, []).get(r.account_id)!).push(r)
  const baseByAccount = new Map<string, { asset_id: string; bal: string }[]>()
  for (const r of baseRows) (baseByAccount.get(r.account_id) ?? baseByAccount.set(r.account_id, []).get(r.account_id)!).push(r)
  const moduleBalancesByAccount = new Map<string, { account_id: string; asset_id: string; bal: string }[]>()
  for (const r of moduleBalanceRows) (moduleBalancesByAccount.get(r.account_id) ?? moduleBalancesByAccount.set(r.account_id, []).get(r.account_id)!).push(r)
  const [volumeByAccount, liquidationByAccount] = await Promise.all([
    tradingVolumeByAccount(all),
    liquidationVolumeByAccount(all),
  ])

  rows.forEach((row, i) => {
    const accs = rowAccounts[i]
    const moduleAccs = rowModuleAccounts[i]
    const obs = accs.flatMap(a => obsByAccount.get(a) ?? [])
    const baseline = new Map<string, string>()
    for (const a of accs) for (const b of baseByAccount.get(a) ?? []) baseline.set(`${a}|${b.asset_id}`, b.bal)
    let spark = accs.length ? buildValueSparkline(obs, baseline, pricesByAsset, decimalsById) : null
    const moduleBalances = moduleAccs.flatMap(a => moduleBalancesByAccount.get(a) ?? [])
    // Module/sovereign accounts can have millions of observations. Their current
    // balance is not a historical balance series, so omit the sparkline unless a
    // complete indexed reconstruction is available.
    if (moduleBalances.length) spark = null
    // Add ERC-20 (HOLLAR) history before the pin, over every account key the row
    // covers (substrate + twins + module/sovereign forms) — the final bucket is
    // overwritten by the authoritative pin below, so no double count there.
    for (const a of [...accs, ...moduleAccs]) {
      const e = erc20SparkByAccount.get(a)
      if (e && spark) spark = spark.map((v, b) => +(v + e[b]).toFixed(2))
    }
    // Pin the final bucket to the page query's authoritative current wallet value
    // (same rule as the detail chart): snapshot-seeded accounts can lack organic
    // observation history, and weekly closes drift from spot.
    if (spark) {
      spark[SPARK_WEEKS - 1] = +Number(raw[i].usd ?? 0).toFixed(2)
      row.sparkline = spark
    }
    if (accs.length) row.activityCount = accs.reduce((s, a) => s + (actByAcc.get(a) ?? 0), 0)
    if (accs.length) {
      const volume = accs.reduce((s, a) => s + (volumeByAccount.get(a) ?? 0), 0)
      if (volume > 0) row.tradingVolumeUsd = volume
      const liquidationVolume = accs.reduce((s, a) => s + (liquidationByAccount.get(a) ?? 0), 0)
      if (liquidationVolume > 0) row.liquidationVolumeUsd = liquidationVolume
    }
  })
}

// Resample a full-history value series (portfolioSeries + its ascending dates) onto
// the accounts-list sparkline's fixed trailing-year grid: SPARK_WEEKS weekly buckets
// ending at the current (partial) week, forward-filled. Buckets before the account's
// first data are 0 — young accounts are LEFT-PADDED to a full year; data older than a
// year is clamped in (bucket 0 carries the value as of ~1Y ago). Every row's sparkline
// therefore spans the same 1Y window and start positions are comparable across rows.
export function resampleValueSeriesToTrailingYear(values: number[], dates: string[], now: Date = new Date()): number[] {
  const winStartMs = sparklineCalendarWindowStart(now).getTime()
  const pts: { t: number; v: number }[] = []
  for (let i = 0; i < dates.length && i < values.length; i++) {
    const t = Date.parse(dates[i].replace(' ', 'T') + 'Z')
    if (Number.isFinite(t)) pts.push({ t, v: values[i] })
  }
  const out = new Array<number>(SPARK_WEEKS).fill(0)
  let cursor = 0, last = 0, seen = false
  for (let b = 0; b < SPARK_WEEKS; b++) {
    const bucketEnd = winStartMs + (b + 1) * WEEK_MS - 1
    while (cursor < pts.length && pts[cursor].t <= bucketEnd) { last = pts[cursor].v; seen = true; cursor++ }
    out[b] = seen ? +last.toFixed(2) : 0
  }
  return out
}

// Full-portfolio sparkline for the accounts directory. Reuses the detail page's own
// getAccountHistory so the row sparkline and the account/tag value-history chart are
// computed by the SAME code path (wallet + HOLLAR + money-market net worth +
// Omnipool/XYK LP principal, historical closes) and therefore cannot diverge — the
// earlier wallet-only weekly approximation understated LP/MM-heavy accounts by ~2-3×.
// Overwrites the wallet-only series enrichAccountRows produced, which stays as the
// fallback when the history reconstruction yields nothing (a row never regresses to
// blank). Module/sovereign accounts are excluded — reconstructing their millions of
// pallet observations per directory refresh is far too heavy — so they keep no list
// sparkline (their detail pages still chart in full), matching prior behaviour.
async function enrichAccountSparklines(
  raw: { label_id: string; sample: string; usd_total: number }[],
  rows: TopAccountRow[],
): Promise<void> {
  const isModuleAccount = (a: string) => /^0x(6d6f646c|7369626c|70617261)/.test(a)
  // Row account set = substrate members (module/sovereign dropped) + their EVM twins,
  // i.e. the same relatedAccountIds the detail page feeds getAccountHistory.
  const rowAccounts: string[][] = raw.map(r => {
    const members = r.label_id !== '' ? (getTagRecord(r.label_id)?.members ?? []) : [r.sample]
    const base = members.filter(m => ACCOUNT_RE.test(m) && !isModuleAccount(m))
    const set = new Set<string>(base)
    for (const m of base) { const twin = evmAccountForm(m); if (twin) set.add(twin) }
    return [...set]
  })
  // Each row is an independent multi-query getAccountHistory; bound the fan-out the
  // same way enrichTopAssets does so one page can't stampede ClickHouse.
  const CONCURRENCY = 8
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const i = next++
      const accounts = rowAccounts[i]
      if (!accounts.length) continue   // module-only/tagless → keep enrichAccountRows' fallback
      try {
        const { portfolioSeries, portfolioDates } = await getAccountHistory(accounts)
        if (portfolioSeries.length > 1) {
          // Resample the full-history series onto the fixed trailing-year grid: every
          // row's sparkline spans the same 1Y window, left-padded with 0 for younger
          // accounts so start positions are comparable across rows.
          const series = resampleValueSeriesToTrailingYear(portfolioSeries, portfolioDates)
          // Pin the final bucket to the row's authoritative current value (the Value
          // column; already nets debt) — the same rule getAddressHistory applies.
          series[SPARK_WEEKS - 1] = +Number(raw[i].usd_total ?? 0).toFixed(2)
          rows[i].sparkline = series
        }
      } catch { /* keep the wallet-only fallback from enrichAccountRows */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))
}

// tag detail — combined portfolio of all members
export interface TagDetail {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  members: AccountRef[]
  balances: AddressBalance[]
  // Up to 4 largest combined holdings (see AddressDetail.topAssets).
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd?: number
  liquidationVolumeUsd?: number
  moneyMarket: MoneyMarketPosition[]
  liquidityPositions?: LpPosition[]
  activeDcas?: ActiveDca[]
  portfolioSeries: number[]
  portfolioDates: string[]
  balanceHistory: AssetBalanceHistory[]
}

// Resolve a tag's canonical member account-id set (validated AccountId32 hexes).
// Shared by getTag and the tag activity/extrinsics/events endpoints so they all
// scope to the same accounts.
function tagMembers(tagId: string): string[] | null {
  const tag = getTagRecord(tagId)
  if (!tag || !tag.members.length) return null
  return tag.members.filter(m => ACCOUNT_RE.test(m))
}

const TAG_DETAIL_SNAPSHOT_MAX_AGE_SECONDS = 2 * 60
const TAG_DETAIL_REQUEST_MAX_AGE_SECONDS = 10 * 60
const hotTagDetails = new Set<string>(['treasury', 'money-market'])

async function loadTagDetailSnapshot(tagId: string, membershipKey: string): Promise<TagDetail | null> {
  const res = await client.query({
    query: `SELECT membership_key,payload_json,dateDiff('second',computed_at,now()) AS age,
      ${omnipoolAccountClaimsReady ? `computed_at>=(SELECT max(computed_at) FROM price_data.omnipool_account_claim_snapshot_state FINAL WHERE snapshot_key='current')` : '1'} AS covers_claims,
      ${moneyMarketAccountValuesReady ? `computed_at>=(SELECT max(computed_at) FROM price_data.money_market_account_value_snapshot_state FINAL WHERE snapshot_key='current')` : '1'} AS covers_money_market
      FROM price_data.tag_detail_snapshots FINAL WHERE tag_id={tagId:String} LIMIT 1`,
    query_params: { tagId }, format: 'JSONEachRow',
  })
  const row = (await res.json<{ membership_key: string; payload_json: string; age: number; covers_claims: number; covers_money_market: number }>())[0]
  if (!row || row.membership_key !== membershipKey || Number(row.age) > TAG_DETAIL_REQUEST_MAX_AGE_SECONDS || Number(row.covers_claims)!==1 || Number(row.covers_money_market)!==1) return null
  try {
    const detail = JSON.parse(row.payload_json) as TagDetail
    return detail?.tagId === tagId && Array.isArray(detail.members) ? detail : null
  } catch { return null }
}

async function persistTagDetailSnapshot(tagId: string, membershipKey: string, detail: TagDetail): Promise<void> {
  await client.insert({
    table: 'price_data.tag_detail_snapshots',
    values: [{
      tag_id: tagId,
      membership_key: membershipKey,
      payload_json: JSON.stringify(detail),
      computed_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    }],
    format: 'JSONEachRow',
  })
}

export async function getTag(tagId: string, opts: { summary?: boolean; refresh?: boolean } = {}): Promise<TagDetail | null> {
  const tag = getTagRecord(tagId)
  if (!tag || !tag.members.length) return null
  // `summary` (hover card) skips the portfolio-history reconstruction — which for a
  // large tag walks every member's transfer log and dominates the response — plus LP
  // and DCA, none of which the card shows. The detail page still gets the full object.
  const summary = opts.summary === true
  const refresh = opts.refresh === true
  const membershipKey = [...tag.members].map(member => member.toLowerCase()).sort().join(',')
  if (!summary) hotTagDetails.add(tagId)
  return cached(`explorer:tag:${accountValueGenerationEpoch}:${tagId}${summary ? ':summary' : refresh ? ':refresh' : ''}`, 8000, async () => {
    if (!summary && !refresh) {
      const snapshot = await loadTagDetailSnapshot(tagId, membershipKey).catch(() => null)
      if (snapshot) return snapshot
    }
    const list = sqlAccountList(tag.members)
    const [balanceRows, lockBreakdowns, prices] = await Promise.all([
      queryAggregatedBalances(list),
      summary ? Promise.resolve(new Map<number, AssetLockBreakdown>()) : queryLockBreakdownsSafe(list),
      ensureAccountValuePrices(),
    ])
    const rawBalances = valueAccountBalances(balanceRows, prices)
    // Wallet-held pool shares double as LP display rows (see stableswapLpPositions).
    const stableLp = stableswapLpPositions(rawBalances)
    let balances: AddressBalance[] = foldShareBalances(rawBalances)

    // The same rich on-chain data the account view returns, for the union of members:
    // live money-market (per-member H160 reads combined), Omnipool LP positions, and
    // active DCA orders. Money-market collateral is folded into the wallet balances
    // exactly as on the account page.
    const mmMembers = tag.members.flatMap(simAccount => {
      const h160 = mmH160ForAccount(simAccount)
      return h160 ? [{ h160, simAccount }] : []
    })
    const tagHistoryAccounts = [...new Set([
      ...tag.members,
      ...tag.members.map(evmAccountForm).filter(Boolean) as string[],
    ])]
    let moneyMarket = await aggregateMoneyMarket(mmMembers)
    // LP stays (it feeds the displayed value); only the heavy portfolio-history walk
    // and DCA — neither shown on the card — are skipped in summary.
    const [history, bareLp, farmLp, xykLp, activeDcas] = await Promise.all([
      summary
        ? Promise.resolve({ portfolioSeries: [] as number[], portfolioDates: [] as string[], balanceHistory: [] as AssetBalanceHistory[] })
        : getAccountHistoryShared(tagHistoryAccounts, `tag:${tagId}`),
      getOmnipoolPositions(tag.members),
      getFarmingPositions(tag.members),
      getXykPositions(tag.members, balances),
      summary ? Promise.resolve([]) : getActiveDcas(tag.members),
    ])
    const lpPositions = [...bareLp, ...farmLp, ...xykLp].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
    // Staking-backed markets (GIGAHDX): collateral is the already-counted locked HDX,
    // so don't fold it into balances/portfolio (see getAddress). Debt still counts.
    const countedMm = moneyMarket.filter(p => !p.stakingBacked)
    const foldedMmUsd = countedMm.reduce((s, p) => s + applyMmCollateralToBalances(balances, p, prices), 0)
    balances = foldShareBalances(balances) // fold MM collateral rows too (see getAddress)
    balances = mergeErc20Balances(
      balances,
      await erc20WalletHoldingsForAccounts(mmMembers.map(member => member.h160)),
      prices,
    )
    // Attach the lock/reserve components once the display rows are final.
    balances = attachLockBreakdowns(balances, lockBreakdowns)
    // Fold each market's borrow-position display too (2-Pool-GETH → GETH), after the line above.
    moneyMarket = moneyMarket.map(p => p.reserves?.length ? { ...p, reserves: foldShareReserves(p.reserves) } : p)
    const lpUsd = lpPositions.reduce((s, p) => s + (p.valueUsd ?? 0), 0)
    const collateralShortfall = countedMm.reduce((s, p) => s + mmCollateralShortfallUsd(p, 0), 0)
    const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0) + lpUsd + Math.max(0, collateralShortfall - foldedMmUsd)
    // Pin the history's last point to the current net worth (see getAddress) so the
    // chart ends at the displayed figure rather than a stale stored-MM bucket.
    const debtUsd = moneyMarket.reduce((s, p) => s + Number(p.totalDebtBase) / 1e8, 0)
    const portfolioSeries = history.portfolioSeries.slice()
    if (portfolioSeries.length) portfolioSeries[portfolioSeries.length - 1] = +(portfolioUsd - debtUsd).toFixed(2)
    const volumeAccounts = [...new Set([...tag.members, ...tag.members.map(evmAccountForm).filter(Boolean) as string[]])]
    const [tradingVolumeUsd, liquidationVolumeUsd] = await Promise.all([
      tradingVolumeByAccount(volumeAccounts).then(m => [...m.values()].reduce((s, v) => s + v, 0)),
      liquidationVolumeByAccount(volumeAccounts).then(m => [...m.values()].reduce((s, v) => s + v, 0)),
    ])
    const detail: TagDetail = {
      tagId: tag.tagId, name: tag.name, color: tag.color, note: tag.note, icon: tag.icon,
      members: tag.members.map(accountRef), balances, topAssets: topHeldTokens(balances), portfolioUsd,
      ...(tradingVolumeUsd > 0 ? { tradingVolumeUsd } : {}),
      ...(liquidationVolumeUsd > 0 ? { liquidationVolumeUsd } : {}),
      moneyMarket, liquidityPositions: [...lpPositions, ...stableLp].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0)), activeDcas,
      portfolioSeries, portfolioDates: history.portfolioDates,
      // Holdings without indexed historical observations remain absent rather
      // than being projected backward from their current balance.
      balanceHistory: summary ? [] : history.balanceHistory,
    }
    if (!summary) await persistTagDetailSnapshot(tagId, membershipKey, detail)
      .catch(error => console.error('[tag-detail] snapshot persist failed', error))
    return detail
  })
}

// Tag feeds use the same account-set implementations as account detail feeds.
export async function getTagActivity(tagId: string, type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string, tail?: number): Promise<ActivityRow[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getScopedAccountActivity(members, `tag:${tagId}`, type, limit, offset, action, filters, from, to, tail)
}
export async function getTagExtrinsics(tagId: string, limit = 25, offset = 0, filters: ExtrinsicListFilters = {}, from?: string, to?: string): Promise<ExtrinsicSummary[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getAccountExtrinsics(members, limit, offset, `tag-extrinsics:${tagId}`, filters, from, to)
}
export async function getTagEvents(tagId: string, limit = 25, offset = 0, filters: EventListFilters = {}, from?: string, to?: string): Promise<EventRow[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getAccountEvents(members, limit, offset, `tag-events:${tagId}`, filters, from, to)
}
export async function getTagVotes(tagId: string, limit = 25, offset = 0, from?: string, to?: string, filters: VoteListFilters = {}): Promise<VoteRow[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getScopedVotes(members, `tag:${tagId}`, limit, offset, from, to, filters)
}

// daily activity (bar charts)
// Daily activity histogram, parameterized so the chart above a list mirrors the
// list's own tab + filters (activity type, action, token; vote conviction). The
// counts are event-level per category — the merged activity's cross-category
// exclusions and $-value filters aren't replicated here (a coarse histogram).
export interface DailyFilters { type?: string; action?: string; token?: string }
const TRANSFER_EVENTS = ['Balances.Transfer', 'Tokens.Transfer', 'Currencies.Transferred']
const LIQUIDITY_EVENTS = ['Omnipool.LiquidityAdded', 'Omnipool.LiquidityRemoved', 'Stableswap.LiquidityAdded', 'Stableswap.LiquidityRemoved', 'XYK.LiquidityAdded', 'XYK.LiquidityRemoved', 'XYK.PoolCreated', 'OmnipoolLiquidityMining.RewardClaimed', 'XYKLiquidityMining.RewardClaimed']
const VOTE_EVENTS = ['ConvictionVoting.Voted', 'Democracy.Voted']
const sqlNames = (names: readonly string[]) => names.map(n => `'${n}'`).join(',')

export async function getDailyActivity(scope: string, filters: DailyFilters = {}): Promise<{ date: string; value: number }[]> {
  const type = normalizeActivityTypeKey(filters.type ?? 'all')
  const key = `${scope}:${type}:${filters.action ?? ''}:${filters.token ?? ''}`
  return cached(`explorer:daily:${key}`, 300000, async () => {
    const since = `block_timestamp > now() - INTERVAL 90 DAY`
    const daily = (table: string, where: string, uniq = '(block_height, event_index)') =>
      `SELECT toString(toDate(block_timestamp)) AS d, toUInt64(uniqExact(${uniq})) AS v FROM price_data.${table} WHERE ${since}${where ? ` AND ${where}` : ''} GROUP BY d ORDER BY d`
    // Token filter — mirror the activity table's per-category asset-id predicates so
    // the bars adjust to the selected token on every tab. The asset id lives in a
    // different arg field per category (currencyId for transfers, assetIn/assetOut
    // for swaps, assetId/poolId/assetA for liquidity, a reserve contract address for
    // money-market). Staking/voting are HDX-denominated (staking position id 670),
    // so a non-HDX token yields no rows. The xcm (raw_xcm_activity.assets_json is
    // empty) and DCA (dca_events carries no asset id) daily sources have no asset id
    // to filter on — those two remain unfiltered by token (documented limitation).
    const tokenIds = assetIdsForToken(filters.token)
    const ids = tokenIds?.join(',')
    const sp = (s: string) => (s ? ` ${s}` : '')
    const transferTok = assetIdFilterSql(transferAssetIdSql(), tokenIds)
    const liqTok = liquidityTokenFilterSql(tokenIds)
    const tradeTok = tokenIds == null ? '' : !tokenIds.length ? 'AND 0'
      : `AND (toUInt32(JSONExtractInt(args_json,'assetIn')) IN (${ids}) OR toUInt32(JSONExtractInt(args_json,'assetOut')) IN (${ids}))`
    const stakingTok = tokenIds == null ? '' : (tokenIds.includes(0) || tokenIds.includes(670)) ? '' : 'AND 0'
    const voteTok = tokenIds == null ? '' : tokenIds.includes(0) ? '' : 'AND 0'
    const mmAddrs = tokenIds ? [...new Set(tokenIds.flatMap(mmReserveAddressForAsset))] : []
    const mmTok = tokenIds == null ? '' : mmAddrs.length ? `AND asset_address IN (${mmAddrs.map(a => `'${a}'`).join(',')})` : 'AND 0'
    let query: string
    if (scope === 'activity' && type !== 'mm' && type !== 'xcm') {
      let names: readonly string[]
      let ignoreToken = false
      if (type === 'transfer') names = TRANSFER_EVENTS
      else if (type === 'trade') {
        const otcAction = resolveOtcAction(filters.action)
        if (filters.action === 'dca-failed') { names = ['DCA.TradeFailed']; ignoreToken = true }
        else if (filters.action === 'dca') { names = ['DCA.TradeExecuted', 'DCA.TradeFailed']; ignoreToken = true }
        else if (otcAction && OTC_ACTION_EVENTS[otcAction]) { names = OTC_ACTION_EVENTS[otcAction]; ignoreToken = true }
        else if (filters.action === 'swap') names = SWAP_EVENTS
        else names = [...SWAP_EVENTS, ...OTC_EVENT_NAMES, 'DCA.TradeFailed']
      } else if (type === 'liquidity') {
        if (filters.action === 'Claim') names = [...LIQUIDITY_EVENTS.filter(n => n.endsWith('RewardClaimed')), 'Referrals.Claimed']
        else if (filters.action === 'Add') names = LIQUIDITY_EVENTS.filter(n => n.endsWith('Added'))
        else if (filters.action === 'Remove') names = LIQUIDITY_EVENTS.filter(n => n.endsWith('Removed'))
        else if (filters.action === 'Create') names = LIQUIDITY_EVENTS.filter(n => n.endsWith('PoolCreated'))
        else names = LIQUIDITY_EVENTS
      } else if (type === 'staking') {
        names = filters.action && STAKING_ACTION_EVENTS[filters.action] ? STAKING_ACTION_EVENTS[filters.action] : STAKING_EVENT_NAMES
      } else if (type === 'vote') names = VOTE_EVENTS
      else if (type === 'otc') {
        const otcAction = resolveOtcAction(filters.action)
        names = otcAction && OTC_ACTION_EVENTS[otcAction] ? OTC_ACTION_EVENTS[otcAction] : OTC_EVENT_NAMES
        ignoreToken = true
      } else {
        names = [...TRANSFER_EVENTS, ...SWAP_EVENTS, ...LIQUIDITY_EVENTS, ...VOTE_EVENTS, ...STAKING_EVENT_NAMES, ...OTC_EVENT_NAMES]
      }
      const assetFilter = ignoreToken || tokenIds == null ? '' : !tokenIds.length
        ? 'AND 0'
        : `AND hasAny(asset_refs, [${tokenIds.join(',')}])`
      query = `SELECT toString(day) AS d, toUInt64(uniqExact(tuple(block_height, activity_index))) AS v
               FROM price_data.activity_histogram_events
               WHERE day > today() - 90 AND event_name IN (${sqlNames(names)}) ${assetFilter}
               GROUP BY day ORDER BY day`
    } else if (scope === 'events' || scope === 'extrinsics')
      query = `SELECT toString(day) AS d, toUInt64(groupBitmapMerge(identity_state)) AS v
               FROM price_data.daily_chain_identity_counts_v2
               WHERE kind='${scope}' AND day > today() - 90
               GROUP BY day ORDER BY day`
    else {
      // activity — per selected type; 'all' approximates the merged feed.
      if (type === 'transfer')
        query = daily('raw_events', `event_name IN (${sqlNames(TRANSFER_EVENTS)})${sp(transferTok)}`)
      else if (type === 'trade') {
        // otc folds under Trade: no sub-action selected merges swap+otc counts
        // (mirrors the activity's row merge); an otc sub-action narrows to just
        // that otc event set, excluding plain swap/dca — same as the activity's
        // activityRowMatchesAction.
        const otcAction = resolveOtcAction(filters.action)
        if (filters.action === 'dca-failed')
          query = daily('raw_events', `event_name = 'DCA.TradeFailed'`)
        else if (filters.action === 'dca')
          query = daily('raw_events', `event_name IN ('DCA.TradeExecuted','DCA.TradeFailed')`)   // schedule join needed for token filtering → token filter N/A
        else if (otcAction && OTC_ACTION_EVENTS[otcAction])
          // Asset identity for non-Placed otc events lives on the order's Placed
          // event, not the event itself — token filtering N/A here (see the otc
          // branch below), same documented limitation.
          query = daily('raw_events', `event_name IN (${sqlNames(OTC_ACTION_EVENTS[otcAction])})`)
        else if (filters.action === 'swap')
          query = daily('raw_events', `event_name IN (${sqlNames(SWAP_EVENTS)})${sp(tradeTok)}`, '(block_height, extrinsic_index)')
        else
          query = daily(
            'raw_events',
            `event_name IN (${sqlNames([...SWAP_EVENTS, ...OTC_EVENT_NAMES, 'DCA.TradeFailed'])})${sp(tradeTok)}`,
            `(block_height, if(event_name IN (${sqlNames(SWAP_EVENTS)}), ifNull(extrinsic_index, event_index), event_index))`,
          )
      } else if (type === 'liquidity') {
        if (filters.action === 'Claim') {
          const claimTok = tokenIds == null ? '' : !tokenIds.length ? ' AND 0'
            : ` AND ((event_name = 'Referrals.Claimed' AND 0 IN (${ids})) OR (event_name != 'Referrals.Claimed' AND ${liquidityAssetMatchExpr(ids!)}))`
          query = daily('raw_events', `event_name IN (${sqlNames([...LIQUIDITY_EVENTS.filter(n => n.endsWith('RewardClaimed')), 'Referrals.Claimed'])})${claimTok}`)
        } else {
          const act = filters.action === 'Add' ? ` AND event_name LIKE '%Added'` : filters.action === 'Remove' ? ` AND event_name LIKE '%Removed'` : filters.action === 'Create' ? ` AND event_name LIKE '%PoolCreated'` : ''
          query = daily('raw_events', `event_name IN (${sqlNames(LIQUIDITY_EVENTS)})${act}${sp(liqTok)}`)
        }
      } else if (type === 'staking') {
        const names = filters.action && STAKING_ACTION_EVENTS[filters.action] ? STAKING_ACTION_EVENTS[filters.action] : STAKING_EVENT_NAMES
        query = daily('raw_events', `event_name IN (${sqlNames(names)})${sp(stakingTok)}`)
      } else if (type === 'vote') {
        const side = filters.action === 'Aye' ? ` AND JSONExtractInt(args_json, 'vote', 'vote') >= 128`
          : filters.action === 'Nay' ? ` AND JSONExtractInt(args_json, 'vote', 'vote') < 128 AND JSONExtractString(args_json, 'vote', '__kind') = 'Standard'` : ''
        query = daily('raw_events', `event_name IN (${sqlNames(VOTE_EVENTS)})${side}${sp(voteTok)}`)
      } else if (type === 'mm') {
        if (filters.action === 'ClaimRewards') {
          // Reward claims already have a replay-safe sparse transfer model. The
          // former histogram reopened 35.8M recent raw events (7.9 GiB) merely
          // to find this one pot's Currencies.Transferred rows.
          query = daily('incentive_reward_transfers FINAL',
            `event_name = 'Currencies.Transferred' AND JSONExtractString(args_json,'from') = '${INCENTIVES_REWARD_POT}'${sp(transferTok)}`)
        } else {
          const actionNames = moneyMarketEventNames(filters.action)
          const act = actionNames.length ? ` AND event_name IN (${sqlNames(actionNames)})` : ' AND 0'
          query = daily('raw_money_market_events', `user_address NOT LIKE '0x6d6f646c%' AND lower(ifNull(pool_address, '')) IN (${configuredMmPoolsSql()})${act}${sp(mmTok)}`)
        }
      } else if (type === 'otc') {
        // Asset identity for Cancelled/Filled/PartiallyFilled lives on the order's
        // Placed event, not the event itself, so — like xcm/dca above — token
        // filtering isn't supported here (documented limitation; a coarse histogram).
        // Accepts both the raw otcAction label (Place/Pull/Fill) and the
        // hyphenated otc-place/otc-pull/otc-fill values used under type=trade.
        const otcAction = resolveOtcAction(filters.action)
        const names = otcAction && OTC_ACTION_EVENTS[otcAction] ? OTC_ACTION_EVENTS[otcAction] : OTC_EVENT_NAMES
        query = daily('raw_events', `event_name IN (${sqlNames(names)})`)
      } else if (type === 'xcm')
        query = daily('raw_xcm_activity', '', '(block_height, source_index)')   // assets_json empty → token filter N/A
      else {
        // 'all' — union of raw_events categories; OR each category's own token
        // predicate so the count mirrors the merged activity for the selected token.
        const allEvents = sqlNames([...TRANSFER_EVENTS, ...SWAP_EVENTS, ...LIQUIDITY_EVENTS, ...VOTE_EVENTS, ...STAKING_EVENT_NAMES, ...OTC_EVENT_NAMES])
        let where = `event_name IN (${allEvents})`
        if (tokenIds != null) {
          if (!tokenIds.length) where += ' AND 0'
          else {
            const parts = [
              `(event_name IN (${sqlNames(TRANSFER_EVENTS)}) AND toUInt32(${transferAssetIdSql()}) IN (${ids}))`,
              `(event_name IN (${sqlNames(SWAP_EVENTS)}) AND (toUInt32(JSONExtractInt(args_json,'assetIn')) IN (${ids}) OR toUInt32(JSONExtractInt(args_json,'assetOut')) IN (${ids})))`,
              `(event_name IN (${sqlNames(LIQUIDITY_EVENTS)}) AND ${liquidityAssetMatchExpr(tokenIds.join(','))})`,
              // Placed carries its own assetIn/assetOut; Cancelled/Filled/PartiallyFilled
              // don't (see the 'otc' branch above), so only Placed is token-filterable here.
              `(event_name = 'OTC.Placed' AND (toUInt32(JSONExtractInt(args_json,'assetIn')) IN (${ids}) OR toUInt32(JSONExtractInt(args_json,'assetOut')) IN (${ids})))`,
            ]
            if (tokenIds.includes(0) || tokenIds.includes(670)) parts.push(`(event_name IN (${sqlNames(STAKING_EVENT_NAMES)}))`)
            if (tokenIds.includes(0)) parts.push(`(event_name IN (${sqlNames(VOTE_EVENTS)}))`)
            where += ` AND (${parts.join(' OR ')})`
          }
        }
        query = daily('raw_events', where)
      }
    }
    const res = await client.query({ query, format: 'JSONEachRow' })
    const byDay = new Map((await res.json<{ d: string; v: string }>()).map(r => [r.d, Number(r.v)]))
    // Emit a continuous 90-day axis — sparse categories (e.g. liquidations)
    // would otherwise compress the timeline to only their active days.
    const day = 86_400_000
    const today = Math.floor(Date.now() / day) * day
    return Array.from({ length: 90 }, (_, i) => {
      const date = new Date(today - (89 - i) * day).toISOString().slice(0, 10)
      return { date, value: byDay.get(date) ?? 0 }
    })
  })
}

// Total row counts per list (for pagination page-counts / Last button).
export async function getListCounts(): Promise<{ blocks: number; extrinsics: number; events: number; transfers: number }> {
  return cached('explorer:counts', 60000, async () => {
    const q = async (sql: string) => Number((await (await client.query({ query: sql, format: 'JSONEachRow' })).json<{ c: string }>())[0]?.c ?? 0)
    const [blocks, extrinsics, events, transfers] = await Promise.all([
      q(`SELECT toString(count()) AS c FROM price_data.raw_blocks`),
      q(`SELECT toString(count()) AS c FROM price_data.raw_extrinsics WHERE coalesce(signer, effective_signer) IS NOT NULL`),
      q(`SELECT toString(count()) AS c FROM price_data.raw_events`),
      q(`SELECT toString(count()) AS c FROM price_data.raw_events WHERE event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')`),
    ])
    return { blocks, extrinsics, events, transfers }
  })
}

// Daily active vs new accounts (last 30 days) for the Accounts chart.
export async function getDailyAccounts(): Promise<{ date: string; active: number; new: number }[]> {
  return cached('explorer:daily-accounts', 300000, async () => {
    const since = `block_timestamp > now() - INTERVAL 30 DAY`
    const [activeRes, newRes] = await Promise.all([
      client.query({ query: `SELECT toString(toDate(block_timestamp)) AS d, toUInt64(uniqExact(coalesce(signer, effective_signer))) AS v FROM price_data.raw_extrinsics WHERE ${since} AND coalesce(signer, effective_signer) IS NOT NULL GROUP BY d ORDER BY d`, format: 'JSONEachRow' }),
      client.query({ query: `SELECT toString(toDate(first)) AS d, toUInt64(count()) AS v FROM (SELECT coalesce(signer, effective_signer) AS account_id, min(block_timestamp) AS first FROM price_data.raw_extrinsics WHERE coalesce(signer, effective_signer) IS NOT NULL GROUP BY account_id) WHERE ${'first'} > now() - INTERVAL 30 DAY GROUP BY d ORDER BY d`, format: 'JSONEachRow' }),
    ])
    const active = new Map((await activeRes.json<{ d: string; v: string }>()).map(r => [r.d, Number(r.v)]))
    const neu = new Map((await newRes.json<{ d: string; v: string }>()).map(r => [r.d, Number(r.v)]))
    const dates = [...new Set([...active.keys(), ...neu.keys()])].sort()
    return dates.map(d => ({ date: d, active: active.get(d) ?? 0, new: neu.get(d) ?? 0 }))
  })
}

// search
export interface SearchResult {
  type: 'block' | 'extrinsic' | 'address' | 'asset' | 'tag'
  value: string
  label?: string
  desc?: string   // asset-type: the descriptive name (e.g. DOT → "Polkadot")
  asset?: AssetRef
  // Address-type enrichment so the search dropdown can render the account pill
  // (emoji + identity name) directly, without a follow-up address fetch.
  emoji?: string
  emojiName?: string
  emojiUrl?: string
  identity?: AccountIdentity | null
  // Tag-type enrichment so the dropdown can render the tag's icon/color glyph
  // (e.g. the Kraken logo) in front of the entry.
  icon?: string
  color?: string
}

// Two in-memory account indexes, both built from the ~100k accounts the explorer
// knows (balance holders ∪ extrinsic signers), refreshed periodically:
//   • suffix → accountIds — each account's DISPLAYED-address last-3 chars (the
//     colored "code" on the pill), so the search box resolves e.g. "x7K" → 15393Vq…Ax7K.
//   • emoji glyph → accountIds — the avatar each account renders, so a search for
//     the spelled-out name ("Mushroom" → 🍄) finds those accounts.
// Both source rows are ordered by activity so the per-bucket caps keep the most
// prominent accounts (emoji names are shared by hundreds; the dropdown shows a few).
let acctSuffixIndex = new Map<string, string[]>()
let acctEmojiIndex = new Map<string, string[]>()
let accountSuffixRefreshTimer: ReturnType<typeof setInterval> | null = null
let accountSuffixInflight: Promise<void> | null = null
let accountsPrewarmTimer: ReturnType<typeof setInterval> | null = null
let accountsPrewarmInflight: Promise<void> | null = null
let tagCountsPrewarmTimer: ReturnType<typeof setInterval> | null = null
let tagCountsPrewarmInflight: Promise<void> | null = null
let tagDetailsPrewarmTimer: ReturnType<typeof setInterval> | null = null
let tagDetailsPrewarmInflight: Promise<void> | null = null

async function loadAccountSuffixIndexUncached(): Promise<void> {
  try {
    const res = await client.query({
      query: `SELECT account_id FROM (
                SELECT account_id, sum(activity) AS activity FROM (
                  SELECT account_id, count() AS activity
                  FROM price_data.account_asset_latest_balances
                  GROUP BY account_id
                  UNION ALL
                  SELECT coalesce(signer, effective_signer) AS account_id, count() AS activity
                  FROM price_data.raw_extrinsics
                  WHERE coalesce(signer, effective_signer) != ''
                  GROUP BY account_id
                ) WHERE account_id != '' GROUP BY account_id ORDER BY activity DESC
              )
              LIMIT 250000`,
      format: 'JSONEachRow',
      clickhouse_settings: { max_result_rows: '250000' },
    })
    const suf = new Map<string, string[]>()
    const emo = new Map<string, string[]>()
    for (const r of await res.json<{ account_id: string }>()) {
      const id = r.account_id
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) continue
      const disp = evmFromAccountId(id) ?? polkadotAddress(id) // EVM 0x… or Polkadot SS58, matching the pill
      if (!disp || disp.length < 3) continue
      const s = disp.slice(-3).toLowerCase()
      const sArr = suf.get(s)
      if (sArr) { if (sArr.length < 25) sArr.push(id) } else suf.set(s, [id])
      // Index by the rendered glyph, but skip accounts showing a custom image
      // (Discord avatar): their fallback emoji isn't what's displayed, so a name
      // match on it would be misleading.
      const ic = accountIcon(id)
      if (!ic.emojiUrl) {
        const eArr = emo.get(ic.emoji)
        if (eArr) { if (eArr.length < 25) eArr.push(id) } else emo.set(ic.emoji, [id])
      }
    }
    acctSuffixIndex = suf
    acctEmojiIndex = emo
  } catch (e) { console.error('[suffix-index] load failed', e) }
}

export function loadAccountSuffixIndex(): Promise<void> {
  if (accountSuffixInflight) return accountSuffixInflight
  const request = loadAccountSuffixIndexUncached().finally(() => {
    if (accountSuffixInflight === request) accountSuffixInflight = null
  })
  accountSuffixInflight = request
  return request
}

export function startAccountSuffixRefresh(): void {
  if (accountSuffixRefreshTimer) return
  accountSuffixRefreshTimer = setInterval(() => { void loadAccountSuffixIndex().catch(() => {}) }, 5 * 60_000)
  accountSuffixRefreshTimer.unref()
}
async function prewarmAccountDirectoryUncached(): Promise<void> {
  const sorts: AccountSort[] = ['value', 'supplied', 'borrowed', 'health', 'identity', 'activity', 'volume', 'liquidation']
  for (const sort of sorts) await getAccounts(0, 50, sort)
  await getAccounts(50, 50, 'value')
}

function prewarmAccountDirectory(): Promise<void> {
  if (accountsPrewarmInflight) return accountsPrewarmInflight
  const request = prewarmAccountDirectoryUncached().finally(() => {
    if (accountsPrewarmInflight === request) accountsPrewarmInflight = null
  })
  accountsPrewarmInflight = request
  return request
}

// Persist every public sort plus page two in a bounded sequential background
// pass. Process restarts and browser-cold loads then read one tiny snapshot;
// stale-while-revalidate keeps the previous page available during refresh.
export function startAccountsPrewarm(): void {
  if (accountsPrewarmTimer) return
  void prewarmAccountDirectory().catch(() => {})
  accountsPrewarmTimer = setInterval(() => { void prewarmAccountDirectory().catch(() => {}) }, 5 * 60_000)
  accountsPrewarmTimer.unref()
}

async function prewarmTagTabCountsUncached(): Promise<void> {
  // Sequential by tag: the exact aggregation can be large for structural tags,
  // and concurrent full-history unions would contend with live ingestion.
  for (const tag of allTags()) {
    const membershipKey = [...tag.members].map(member => member.toLowerCase()).sort().join(',')
    const result = await client.query({
      query: `SELECT membership_key, dateDiff('second', computed_at, now()) AS age
              FROM price_data.tag_activity_counts FINAL
              WHERE tag_id = {tagId:String} LIMIT 1`,
      query_params: { tagId: tag.tagId }, format: 'JSONEachRow',
    })
    const snapshot = (await result.json<{ membership_key: string; age: number }>())[0]
    const membershipMatches = snapshot?.membership_key === membershipKey
    // Establish complete coverage for every reproducible tag once. Thereafter
    // only tags actually requested by this API process need ten-minute refresh;
    // rescanning every structural tag forever would create continuous load.
    if (membershipMatches && (!hotTagCounts.has(tag.tagId) || Number(snapshot.age) < TAG_COUNT_REFRESH_MS / 1000)) continue
    await refreshTagTabCounts(tag.tagId, tag.members, membershipKey)
  }
}

function prewarmTagTabCounts(): Promise<void> {
  if (tagCountsPrewarmInflight) return tagCountsPrewarmInflight
  const request = prewarmTagTabCountsUncached().finally(() => {
    if (tagCountsPrewarmInflight === request) tagCountsPrewarmInflight = null
  })
  tagCountsPrewarmInflight = request
  return request
}

export function startTagCountsPrewarm(): void {
  if (tagCountsPrewarmTimer) return
  void prewarmTagTabCounts().catch(error => console.error('[tag-counts] prewarm failed', error))
  tagCountsPrewarmTimer = setInterval(() => { void prewarmTagTabCounts().catch(error => console.error('[tag-counts] refresh failed', error)) }, TAG_COUNT_REFRESH_MS)
  tagCountsPrewarmTimer.unref()
  const prewarmDetails = (): Promise<void> => {
    if (tagDetailsPrewarmInflight) return tagDetailsPrewarmInflight
    const request = (async () => {
      // A distinct cache key keeps foreground requests on the last complete
      // snapshot instead of joining this exact, multi-second reconstruction.
      for (const tagId of hotTagDetails) await getTag(tagId, { refresh: true })
    })().finally(() => {
      if (tagDetailsPrewarmInflight === request) tagDetailsPrewarmInflight = null
    })
    tagDetailsPrewarmInflight = request
    return request
  }
  void prewarmDetails().catch(error => console.error('[tag-detail] prewarm failed', error))
  tagDetailsPrewarmTimer = setInterval(() => { void prewarmDetails().catch(error => console.error('[tag-detail] refresh failed', error)) }, TAG_DETAIL_SNAPSHOT_MAX_AGE_SECONDS * 1000)
  tagDetailsPrewarmTimer.unref()
}

export function stopExplorerBackgroundTasks(): void {
  if (evmBindingsRefreshTimer) clearInterval(evmBindingsRefreshTimer)
  if (accountSuffixRefreshTimer) clearInterval(accountSuffixRefreshTimer)
  if (accountsPrewarmTimer) clearInterval(accountsPrewarmTimer)
  if (tagCountsPrewarmTimer) clearInterval(tagCountsPrewarmTimer)
  if (tagDetailsPrewarmTimer) clearInterval(tagDetailsPrewarmTimer)
  if (omnipoolAccountClaimsRefreshTimer) clearInterval(omnipoolAccountClaimsRefreshTimer)
  if (moneyMarketAccountValuesRefreshTimer) clearInterval(moneyMarketAccountValuesRefreshTimer)
  evmBindingsRefreshTimer = null
  accountSuffixRefreshTimer = null
  accountsPrewarmTimer = null
  tagCountsPrewarmTimer = null
  tagDetailsPrewarmTimer = null
  omnipoolAccountClaimsRefreshTimer = null
  moneyMarketAccountValuesRefreshTimer = null
}

function accountsBySuffix(suffix: string): string[] {
  return acctSuffixIndex.get(suffix.toLowerCase()) ?? []
}
function accountsByEmoji(emoji: string): string[] {
  return acctEmojiIndex.get(emoji) ?? []
}

// Cap on account (address-type) results across all fuzzy matchers (identity name,
// emoji name, 3-letter code). Matters most for emoji-name searches like "fish",
// where hundreds of accounts share a glyph — the per-glyph index already keeps the
// most-active accounts first, so this just controls how many of them the dropdown
// surfaces. Kept modest so the dropdown stays scannable.
const MAX_ACCOUNT_RESULTS = 15

export async function search(q: string): Promise<SearchResult[]> {
  const query = q.trim()
  if (!query) return []
  // Single-flight cache: many users typing the same prefixes (and each user's
  // keystroke debounce) would otherwise hit ClickHouse per request.
  return cached(`explorer:search:${query.toLowerCase()}`, 10000, () => searchUncached(query))
}

async function searchUncached(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = []

  if (/^\d+$/.test(query)) {
    const h = Number(query)
    const res = await client.query({ query: `SELECT count() AS c FROM price_data.raw_blocks WHERE block_height = {h:UInt32}`, query_params: { h }, format: 'JSONEachRow' })
    if (Number((await res.json<{ c: string }>())[0]?.c ?? 0) > 0) results.push({ type: 'block', value: query })
  }

  // extrinsic id "height-index"
  const extId = /^(\d+)-(\d+)$/.exec(query)
  if (extId) {
    const res = await client.query({
      query: `SELECT count() AS c FROM price_data.raw_extrinsics WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32}`,
      query_params: { h: Number(extId[1]), i: Number(extId[2]) },
      format: 'JSONEachRow',
    })
    if (Number((await res.json<{ c: string }>())[0]?.c ?? 0) > 0) results.push({ type: 'extrinsic', value: query })
  }

  const is64Hex = /^0x[0-9a-fA-F]{64}$/.test(query)
  let hashHit = false
  if (is64Hex) {
    const lc = query.toLowerCase()
    const [blockRes, extRes] = await Promise.all([
      client.query({ query: `SELECT block_height FROM price_data.raw_blocks WHERE block_hash = {h:String} LIMIT 1`, query_params: { h: lc }, format: 'JSONEachRow' }),
      client.query({ query: `SELECT extrinsic_hash FROM price_data.raw_extrinsics WHERE extrinsic_hash = {h:String} LIMIT 1`, query_params: { h: lc }, format: 'JSONEachRow' }),
    ])
    const blockHit = (await blockRes.json<{ block_height: number }>())[0]
    if (blockHit) { results.push({ type: 'block', value: String(blockHit.block_height) }); hashHit = true }
    if ((await extRes.json<{ extrinsic_hash: string }>())[0]) { results.push({ type: 'extrinsic', value: lc }); hashHit = true }
  }

  // A 64-hex value is ambiguous (could be an AccountId32 or a block/extrinsic hash);
  // only offer it as an account when it didn't resolve to a known hash.
  const seenAccounts = new Set<string>()
  const norm = await canonicalizeAddress(query)
  if (norm?.accountId && (!is64Hex || !hashHit)) {
    const id = identityForAccount(norm.accountId)
    const ic = accountIcon(norm.accountId)
    results.push({
      type: 'address', value: norm.accountId, label: norm.evmAddress ?? polkadotAddress(norm.accountId) ?? norm.ss58 ?? undefined,
      emoji: ic.emoji, emojiName: ic.emojiName, emojiUrl: ic.emojiUrl, identity: id,
    })
    seenAccounts.add(norm.accountId.toLowerCase())
  }

  // Combined "3-letter code + emoji name" query (either order: "pmo pig",
  // "pig pmo") — intersect the suffix bucket with the account's rendered glyph.
  // High-precision (usually pinpoints one account), so it ranks first among the
  // fuzzy account matchers. Custom-avatar accounts are skipped like in the
  // emoji-name branch: their fallback emoji isn't what the pill displays.
  for (const combo of parseSuffixEmojiQuery(query)) {
    for (const id of accountsBySuffix(combo.suffix)) {
      if (seenAccounts.has(id.toLowerCase())) continue
      const ic = accountIcon(id)
      if (ic.emojiUrl || !(combo.glyphs.includes(ic.emoji) || combo.glyphs.includes(ic.emoji.replace(/️/g, '')))) continue
      if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
      seenAccounts.add(id.toLowerCase())
      results.push({
        type: 'address', value: id, label: evmFromAccountId(id) ?? polkadotAddress(id) ?? undefined,
        emoji: ic.emoji, emojiName: ic.emojiName ?? emojiNameFor(ic.emoji) ?? undefined, identity: identityForAccount(id),
      })
    }
  }

  // Asset symbol/name match — always run and surfaced high, so an account whose
  // identity contains the query (e.g. "HDXKobi") never hides the asset itself
  // (e.g. HDX). Ranked: exact symbol, then symbol prefix, then symbol substring,
  // then name substring; shortest symbol wins ties.
  if (/[A-Za-z]/.test(query)) {
    const ql = query.toLowerCase()
    const ranked = allExplorerAssets()
      .map(a => {
        const sym = a.symbol.toLowerCase(), name = (a.name ?? '').toLowerCase()
        const rank = sym === ql ? 0 : sym.startsWith(ql) ? 1 : sym.includes(ql) ? 2 : name.includes(ql) ? 3 : -1
        return { a, rank }
      })
      .filter(x => x.rank >= 0)
      .sort((x, y) => x.rank - y.rank || x.a.symbol.length - y.a.symbol.length)
      .slice(0, 6)
    for (const { a } of ranked) results.push({ type: 'asset', value: String(a.assetId), label: a.symbol, desc: a.name ?? undefined, asset: a })
  }

  // Identity name — case-insensitive substring on Identity.IdentityOf display
  // (e.g. "kraken", "stakernode"). Returns the matching accounts as address
  // results, deduped against a direct address match above.
  if (/[A-Za-z]/.test(query)) {
    for (const m of searchIdentitiesByDisplay(query, 5)) {
      if (seenAccounts.has(m.accountId.toLowerCase())) continue
      seenAccounts.add(m.accountId.toLowerCase())
      const mic = accountIcon(m.accountId)
      results.push({
        type: 'address', value: m.accountId, label: evmFromAccountId(m.accountId) ?? polkadotAddress(m.accountId) ?? undefined,
        emoji: mic.emoji, emojiName: mic.emojiName, emojiUrl: mic.emojiUrl, identity: m.identity,
      })
    }
  }

  // Emoji name — the spelled-out avatar each account shows (e.g. "Mushroom" → 🍄,
  // "Fox" → 🦊, "Shark" → 🦈). Resolve the name to its glyph(s), then surface the
  // most-active accounts that render with that emoji (from the emoji index).
  if (/[A-Za-z]/.test(query)) {
    for (const glyph of emojisMatchingName(query)) {
      if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
      for (const id of accountsByEmoji(glyph)) {
        if (seenAccounts.has(id.toLowerCase())) continue
        if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
        seenAccounts.add(id.toLowerCase())
        const ic = accountIcon(id)
        results.push({
          type: 'address', value: id, label: evmFromAccountId(id) ?? polkadotAddress(id) ?? undefined,
          emoji: ic.emoji, emojiName: ic.emojiName ?? emojiNameFor(ic.emoji) ?? undefined, identity: identityForAccount(id),
        })
      }
    }
  }

  // Account "3-letter code" — the colored last-3 chars shown on each account pill
  // (e.g. "x7K" → 15393Vq…Ax7K). Match short base58/hex-ish tokens against the
  // display-suffix index; exact-case matches first.
  if (/^[0-9A-Za-z]{2,6}$/.test(query)) {
    const matches = accountsBySuffix(query).slice()
    matches.sort((a, b) => {
      const da = evmFromAccountId(a) ?? polkadotAddress(a), db = evmFromAccountId(b) ?? polkadotAddress(b)
      const ea = da?.endsWith(query) ? 0 : 1, eb = db?.endsWith(query) ? 0 : 1
      return ea - eb
    })
    for (const id of matches) {
      if (seenAccounts.has(id.toLowerCase())) continue
      if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
      seenAccounts.add(id.toLowerCase())
      const ic = accountIcon(id)
      results.push({
        type: 'address', value: id, label: evmFromAccountId(id) ?? polkadotAddress(id) ?? undefined,
        emoji: ic.emoji, emojiName: ic.emojiName, emojiUrl: ic.emojiUrl, identity: identityForAccount(id),
      })
    }
  }

  // Tag name — substring match, e.g. "kraken".
  if (/[A-Za-z]/.test(query)) {
    const { allTags } = await import('./tagService.ts')
    const ql = query.toLowerCase()
    for (const t of allTags()) {
      if (t.name.toLowerCase().includes(ql)) results.push({ type: 'tag', value: t.tagId, label: t.name, icon: t.icon, color: t.color })
    }
  }

  return results
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return s }
}
