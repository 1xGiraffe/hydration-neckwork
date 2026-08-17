import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { ATOKEN_UNDERLYING_ID, assetDescriptor, priceAssetId } from '../../services/explorerAssets.ts'
import { iso } from '../schemas/common.ts'

// Account valuation for GET /v1/accounts/balances and
// GET /v1/accounts/:account/balance-history. Public-owned: it reads the same
// ClickHouse models the explorer's account page reads, but never imports
// explorerService (spec: "Isolation rule"), so the versioned public contract and
// the explorer's read models are free to diverge.
//
// Money is integer arithmetic end to end (AGENTS.md): raw on-chain amounts are
// BigInt, prices are parsed from their decimal string into fixed-point BigInt, and
// the only conversion to a human decimal happens in formatUsd at the wire edge.
// No JavaScript float ever touches a value.

// USD is carried internally as an integer count of 1e-12 USD. That is the exact
// scale of the price columns (Decimal(38,12)), so a price multiply is lossless and
// only the final rounding to cents discards anything.
const USD_DECIMALS = 12
const USD_UNIT = 10n ** BigInt(USD_DECIMALS)

// How stale a current price may be: the newest close within this many hours of
// the price head. A deliberate staleness bound — an asset whose feed died falls
// out of the map and contributes nothing, rather than valuing today's holdings at
// a price from months ago.
//
// Expressed in HOURS, not blocks. A block-count bound (7,200 blocks ≈ 12 h) holds
// only while a block is 6 s; at 2 s the same constant would silently become 4 h and
// drop every low-liquidity asset whose feed updates less often than that — a
// wrong valuation, not a slower one. The bound is resolved to a block height
// against `blocks` at query time (see currentPrices), so the read still prunes on
// `prices`' primary key.
const CURRENT_PRICE_WINDOW_HOURS = 12

// How far back a bucketed history looks for the candle that prices a bucket. Past
// this, the asset is treated as unpriced for that bucket (contributing 0) instead
// of inheriting an arbitrarily old close.
const PRICE_LOOKBACK_SECONDS = 30 * 24 * 3600

// getUserAccountData totals are indexed in the market's base currency, which is
// USD with 8 decimals for every configured Hydration market.
const MM_BASE_DECIMALS = 8

// The Omnipool hub asset (H2O / LRNA). Every Omnipool position withdraws an asset
// leg plus a hub leg, and the hub leg is denominated in this asset whatever the
// position's own asset is.
const LRNA_ASSET_ID = 1

// 'ETH\0' — the marker an AccountId32 carries when it stands for an H160.
const EVM_MARKER = '45544800'

// Pallet ('modl'), sibling-parachain ('sibl') and parachain ('para') accounts are
// 20 meaningful bytes plus 12 zero bytes, so an H160 carrying one of these prefixes
// is the runtime's TRUNCATION of that account and the full AccountId32 is recovered
// by zero-padding. No other H160 is padded this way: for a normal EVM address the
// zero-padded form would be an unrelated account, and claiming its balances would
// report a stranger's holdings under the caller's address.
const RESERVED_H160_PREFIXES = ['6d6f646c', '7369626c', '70617261']

/** Non-negative decimal string (or ClickHouse number) as an integer count of 10^-scale. */
export function decimalToScaled(value: string | number | null | undefined, scale: number): bigint {
  const input = String(value ?? '').trim()
  if (!input) return 0n
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(input)
  if (!match) throw new RangeError(`not a decimal: ${input}`)
  const fraction = match[3] ?? ''
  // Keep one extra digit so a value carrying more precision than `scale` rounds
  // half-up rather than silently truncating toward zero.
  const kept = fraction.slice(0, scale).padEnd(scale, '0')
  const next = fraction.charCodeAt(scale)
  const magnitude = BigInt(`${match[2] || '0'}${kept}`) + (next >= 0x35 && next <= 0x39 ? 1n : 0n)
  return match[1] === '-' ? -magnitude : magnitude
}

/** Raw on-chain amount × unit price, as an integer count of 10^-USD_DECIMALS USD. */
export function usdScaled(rawAmount: bigint, priceScaled: bigint, decimals: number): bigint {
  return (rawAmount * priceScaled) / 10n ** BigInt(decimals)
}

/** The single float-free conversion to the wire's 2-decimal USD string, half-up. */
export function formatUsd(scaled: bigint): string {
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  const cents = (magnitude * 100n + USD_UNIT / 2n) / USD_UNIT
  const whole = cents / 100n
  const fraction = (cents % 100n).toString().padStart(2, '0')
  return `${negative && cents > 0n ? '-' : ''}${whole}.${fraction}`
}

function rawAmount(value: string | number | null | undefined): bigint {
  const input = String(value ?? '').trim()
  return /^\d+$/.test(input) ? BigInt(input) : 0n
}

/**
 * The AccountId32 forms a balance model may store `account` under, derivable
 * without a lookup. A 32-byte public key is stored as itself; an H160 is stored
 * ETH-prefixed (its EVM form) and, when it is a module/sovereign truncation,
 * zero-padded back to 32 bytes. Reading only the literal H160 would report every
 * EVM wallet as empty.
 *
 * This is NOT the whole answer for a bound EVM account — see resolveAccountForms.
 */
export function storedAccountForms(account: string): string[] {
  const lower = account.toLowerCase()
  if (lower.length !== 42) return [lower]
  const body = lower.slice(2)
  const forms = [lower, `0x${EVM_MARKER}${body}${'0'.repeat(16)}`]
  if (RESERVED_H160_PREFIXES.some(prefix => body.startsWith(prefix))) forms.push(`0x${body}${'0'.repeat(24)}`)
  return forms
}

/** The H160 an address IS, or stands for, without consulting a binding. */
function h160Of(account: string): string | null {
  const lower = account.toLowerCase()
  if (lower.length === 42) return lower
  // An ETH-prefixed AccountId32 carries its H160 in bytes 4..24.
  if (lower.startsWith(`0x${EVM_MARKER}`) && lower.endsWith('0'.repeat(16))) return `0x${lower.slice(10, 50)}`
  return null
}

/**
 * The ETH-prefixed AccountId32 an account's EVM-side state is filed under, or null
 * when the address is not a 32-byte AccountId32 that has one.
 *
 * `pallet-evm-accounts` maps EVERY AccountId32 to the H160 of its FIRST 20 BYTES —
 * that mapping is unconditional runtime behaviour, not something a binding creates.
 * State keyed by an H160 is stored as `'ETH\0' || h160 || 8 zero bytes`, so the
 * money market, whose account key is 100 % that form (measured live: 19,576,579 of
 * 19,576,579 position rows and every value-snapshot row), files a substrate
 * account's supplied balances, debt and event history there and NOWHERE else.
 *
 * Reading only the binding directory misses all of it whenever the account never
 * called `bind_evm_address` — which is optional and common (measured: 744 substrate
 * accounts with money-market state and no binding row). Live symptom before this:
 * one account reported $1,192,271 against the explorer's $2,210,391, the missing
 * $1,018,120 being a single aUSDT supply; another reported a flat zero debt series
 * and an EMPTY money-market event feed. The explorer has always folded this form in
 * unconditionally (`explorerService.ts` evmAccountForm), which is precisely why the
 * two surfaces disagreed.
 *
 * Claiming it is safe: only an account whose first 20 bytes ARE that H160 truncates
 * to it, so the form names this entity and no other. Every live binding row binds
 * exactly this truncation (3,310 of 3,310), so for a bound account the form the
 * directory yields and this one are the same key — added to a Set, never appended.
 *
 * An address that IS already the truncated form gets null: prefixing it a second
 * time would name an unrelated key.
 */
export function evmTruncationForm(account: string): string | null {
  const lower = account.toLowerCase()
  if (lower.length !== 66) return null
  if (h160Of(lower)) return null
  return `0x${EVM_MARKER}${lower.slice(2, 42)}${'0'.repeat(16)}`
}

/**
 * Explicit EVM bindings, read for ONE direction only.
 *
 * `pallet-evm-accounts` is not symmetric, and the asymmetry is the whole reason this
 * read exists:
 *
 * - AccountId32 → H160 is DERIVABLE and runtime-enforced. `bind_evm_address` takes no
 *   address argument: the pallet computes `evm_address(who)` — the first 20 bytes —
 *   itself. So a binding can never name an H160 that differs from the truncation, and
 *   evmTruncationForm above is not a heuristic that a future binding could contradict.
 *   Nothing in this map is needed for that direction (measured: all 3,310 live rows
 *   bind exactly the account's own truncation).
 * - H160 → AccountId32 is NOT derivable. The pallet stores the AccountId32's TRAILING
 *   12 bytes as an account extension, and those bytes exist nowhere in the H160. That
 *   one mapping is all this directory adds: without it, asking about a bound EVM
 *   wallet's H160 finds its money-market activity (filed under the ETH-prefixed form,
 *   which IS derivable) but not the pallet balances sitting under its AccountId32.
 *
 * `bySubstrate` is therefore a convenience for the forward direction, never the
 * authority for it — see resolveAccountForms.
 *
 * The winner per address is DEFINED, not incidental. An unordered `DISTINCT` with
 * last-write-wins would let a second binding row for the same H160 decide whose
 * balances are reported, which is a stranger's money on someone else's address.
 * Two guards, both mirroring the explorer's (`explorerService.ts` ACCOUNT_RE /
 * bindCteSql): a bound account must be a well-formed 32-byte AccountId32 that is
 * NOT itself an ETH-prefixed form (that would be the EVM side masquerading as the
 * substrate side), and ties break on the lowest account_id via LIMIT 1 BY.
 *
 * Small (a few thousand rows) and slow-moving, so the whole map is held for 5 min.
 */
function evmBindings(client: ClickHouseClient): Promise<{ byEvm: Map<string, string>; bySubstrate: Map<string, string> }> {
  return cached('public:v1:accounts:evm-bindings', 300_000, async () => {
    const res = await client.query({
      query: `
          SELECT evm_address, account_id FROM (
            SELECT DISTINCT lower(evm_address) AS evm_address, lower(account_id) AS account_id
            FROM price_data.account_alias_directory
            WHERE relationship = 'explicit_binding' AND alias_type = 'substrate_account_id'
              AND evm_address != '' AND account_id != ''
              AND match(lower(account_id), '^0x[0-9a-f]{64}$')
              AND match(lower(evm_address), '^0x[0-9a-f]{40}$')
              AND NOT (startsWith(lower(account_id), '0x${EVM_MARKER}') AND endsWith(account_id, '${'0'.repeat(16)}'))
          )
          ORDER BY evm_address, account_id
          LIMIT 1 BY evm_address
        `,
      format: 'JSONEachRow',
    })
    const byEvm = new Map<string, string>()
    const bySubstrate = new Map<string, string>()
    // Rows arrive in (evm_address, account_id) order, so the reverse direction's
    // first-wins is deterministic too when one account binds several addresses.
    for (const row of await res.json<{ evm_address: string; account_id: string }>()) {
      byEvm.set(row.evm_address, row.account_id)
      if (!bySubstrate.has(row.account_id)) bySubstrate.set(row.account_id, row.evm_address)
    }
    return { byEvm, bySubstrate }
  })
}

/**
 * Per requested address, every stored account form its balances can appear under.
 *
 * One address may resolve to several forms — an EVM wallet and the AccountId32
 * bound to it are ONE account — and each form is an exact key, so every read stays
 * primary-key bounded. Two requested addresses that are halves of the same binding
 * deliberately resolve to the SAME form set and therefore report the same figures:
 * an alias is echoed back to the caller rather than silently dropped, which would be
 * indistinguishable from "this address holds nothing". Callers index responses by
 * `account`; they must not sum a batch's rows.
 *
 * Three sources of forms, and all three are needed: the derivable storage forms
 * (storedAccountForms), the runtime's unconditional AccountId32 → H160 truncation
 * (evmTruncationForm — where all money-market state lives), and the explicit
 * binding directory for the one mapping that is NOT derivable, an H160 whose
 * trailing 12 bytes the owner chose.
 *
 * The three are UNIONED with no precedence rule, and that is sound rather than lucky:
 * `bind_evm_address` computes the H160 itself (first 20 bytes), so the truncation and
 * any binding row for the same account are the same key by construction and cannot
 * disagree — there is no conflict for a precedence rule to resolve. If the pallet ever
 * gained a bind-an-arbitrary-address extrinsic, THAT is when this union would need one,
 * and `evmBindings` would become authoritative for both directions.
 */
export async function resolveAccountForms(client: ClickHouseClient, accounts: string[]): Promise<Map<string, string[]>> {
  const { byEvm, bySubstrate } = await evmBindings(client)
  const formsByAccount = new Map<string, string[]>()
  for (const account of accounts) {
    const forms = new Set(storedAccountForms(account))
    // The runtime's own AccountId32 → H160 truncation. Unconditional: a binding
    // records this mapping, it does not create it, so an account that never bound
    // its address still has its money-market state filed under this form.
    const truncated = evmTruncationForm(account)
    if (truncated) forms.add(truncated)
    const evm = h160Of(account) ?? bySubstrate.get(account.toLowerCase()) ?? null
    if (evm) {
      // Both halves of the identity, whichever half was asked about.
      forms.add(evm)
      forms.add(`0x${EVM_MARKER}${evm.slice(2)}${'0'.repeat(16)}`)
      const bound = byEvm.get(evm)
      if (bound) forms.add(bound)
    }
    formsByAccount.set(account, [...forms])
  }
  return formsByAccount
}

/** Every storage form for one requested address, with the literal as a safe fallback. */
export async function resolveSingleAccountForms(client: ClickHouseClient, account: string): Promise<string[]> {
  return (await resolveAccountForms(client, [account])).get(account) ?? [account]
}

/** The distinct stored forms across a whole batch, for one bounded IN list. */
function allForms(formsByAccount: Map<string, string[]>): string[] {
  return [...new Set([...formsByAccount.values()].flat())]
}

export interface AccountBalanceRow {
  account: string
  transferableUsd: string
  lockedUsd: string
  /** Omnipool LP claims, or null when their snapshot is stale/missing. */
  lpUsd: string | null
  /** Money-market debt, or null when the value snapshot is stale/missing. */
  debtUsd: string | null
  totalUsd: string
  blockHeight: number
}

export interface BalanceHistoryPoint {
  timestamp: string
  transferableUsd: string
  lockedUsd: string
  debtUsd: string
}

export type HistoryBucket = '1h' | '1d'

export const HISTORY_BUCKET_SECONDS: Record<HistoryBucket, number> = { '1h': 3600, '1d': 86_400 }

/** Hard cap on points per balance-history request; a wider window is a 400. */
export const HISTORY_MAX_POINTS = 1000

/** Points a balance-history request covers when `from` is omitted. */
export const HISTORY_DEFAULT_POINTS: Record<HistoryBucket, number> = { '1h': 168, '1d': 90 }

// asset id → unit price as an integer count of 10^-USD_DECIMALS USD.
export type PriceMap = Map<number, bigint>

// Shared by every caller in the 3 s window the balances route advertises, so a
// batch of 50 accounts and a burst of pickers all reuse one price read.
// Exported because the money-market reserve reader values its supplied side at
// the same current prices; two price reads on one surface would let the accounts
// pages and the platform total disagree about what an asset is worth.
export function currentPrices(client: ClickHouseClient): Promise<PriceMap> {
  return cached('public:v1:accounts:current-prices', 3_000, async () => {
    const res = await client.query({
      // Every bound is resolved as a scalar first, so the predicate `prices` sees
      // is a plain constant and prunes to its newest partitions on the primary
      // key — the block arithmetic this replaced did the same, and the point of
      // the rewrite is only WHERE the constant comes from.
      //
      // The staleness window is wall-clock but the cutoff is a block height,
      // because `prices` is keyed (asset_id, block_height) and has no usable time
      // index. `blocks` supplies the conversion in both directions and both reads
      // are cheap: the head's own timestamp is a primary-key point lookup, and the
      // cutoff is `min(block_height)` over a timestamp range that prunes `blocks`
      // to one or two month partitions (MEASURED together: 8 ms, 185 k rows).
      //
      // The window is anchored on the PRICE head's time, not on wall clock, so an
      // indexing lag holds the window still instead of shrinking it to nothing.
      // The fallback covers a head the block table has not recorded yet; a
      // `blocks` table with nothing in the range yields cutoff 0, which reads
      // everything — the same degradation the old `head > window` guard had on a
      // fresh database.
      query: `
          WITH (SELECT max(block_height) FROM price_data.prices) AS head,
               (SELECT max(block_timestamp) FROM price_data.blocks WHERE block_height = head) AS head_probe,
               if(head_probe > toDateTime(0), head_probe,
                  (SELECT max(block_timestamp) FROM price_data.blocks)) AS head_time,
               (SELECT min(block_height) FROM price_data.blocks
                WHERE block_timestamp >= head_time - INTERVAL {windowHours:UInt32} HOUR) AS cutoff
          SELECT asset_id, toString(argMax(usd_price, block_height)) AS price
          FROM price_data.prices
          WHERE block_height >= cutoff
            AND usd_price > 0
          GROUP BY asset_id
        `,
      query_params: { windowHours: CURRENT_PRICE_WINDOW_HOURS },
      format: 'JSONEachRow',
    })
    const prices: PriceMap = new Map()
    for (const row of await res.json<{ asset_id: number; price: string }>()) {
      const scaled = decimalToScaled(row.price, USD_DECIMALS)
      if (scaled > 0n) prices.set(Number(row.asset_id), scaled)
    }
    return prices
  })
}

// The price to value a held asset at: its own feed, or the feed of the asset it
// is priced through (aTokens and pool-share tokens carry no feed of their own).
export function priceFor(prices: PriceMap, assetId: number): bigint {
  return prices.get(priceAssetId(assetId)) ?? 0n
}

// Registry assets whose wallet balance lives in EVM contract storage rather than
// the Tokens pallet, so `account_asset_latest_balances` reads them as zero and
// `erc20_wallet_balances` is the authoritative pot. The shared list lives in
// services/erc20WalletService.ts, which is outside the public API's import
// allow-list, so it is restated here.
const ERC20_WALLET_ASSET_IDS = [222] // HOLLAR

/**
 * How stale a persisted current-state snapshot may be before it is ignored.
 *
 * Both snapshots this service reads — money-market account values and Omnipool
 * account claims — are republished by the indexer's coordinated refresher every few
 * minutes (observed ~4 min apart), and a failed refresh leaves the LAST generation
 * in place indefinitely — the one-way readiness failure mode. Without a bound this
 * endpoint would keep serving months-old supplied balances and LP claims as
 * current. One hour is roughly a dozen missed cycles: long enough that a slow or
 * skipped cycle never blanks a slice, short enough that a genuinely frozen
 * refresher drops out instead of quietly lying.
 */
const SNAPSHOT_MAX_AGE_SECONDS = 3600

/**
 * Money-market markets whose supplied balance must NOT be added to an account's
 * holdings, because the collateral backing them never left the wallet.
 *
 * GIGAHDX is the case: staking HDX leaves the HDX in the holder's own balance and
 * issues a receipt on top, so counting the market's supplied side as well doubles
 * the same money. Measured on a live account before this filter existed: $278,897
 * reported against the explorer's $192,567, the entire $86.3 k difference being one
 * HDX balance counted twice. The explorer encodes the same rule as
 * `stakingBacked` on its market config (`GIGAHDX_MM_MARKET`), which is outside the
 * public API's import allow-list, so the key list is restated here. Core and BIL
 * are ordinary pool supplies and are counted.
 */
const STAKING_BACKED_MARKET_KEYS = ['gigahdx']

interface SnapshotPointer {
  snapshotId: string
  ageSeconds: number
}

/**
 * SQL naming a snapshot's live generation, for a data query to pin ITSELF to.
 *
 * A data read must never name a generation from a cached pointer. The refresher
 * writes the pointer last and then DROPS every superseded partition immediately
 * (`explorerService.ts`, both snapshots), so an id cached even a few seconds ago can
 * already be a dropped partition — which returns rows for nobody and would surface
 * as "this account has no LP / no debt" rather than as an absent slice. Resolving
 * the generation inside the query closes that window: the scalar subquery is
 * evaluated first, so the predicate is still a constant and still prunes to one
 * partition.
 */
const currentGenerationSql = (table: string): string => `(
    SELECT argMax(snapshot_id, computed_at)
    FROM price_data.${table}
    WHERE snapshot_key = 'current'
  )`

/**
 * The current generation's id and age, from a snapshot's tiny pointer table (one
 * row per key). `table` is a module constant, never caller input.
 *
 * Used for the STALENESS GATE and for cache keys only — never to pin a data read
 * (see currentGenerationSql). Age is what the gate needs and it moves slowly, so a
 * minute of caching costs at most a minute of gate latency; a key naming a
 * superseded generation is merely a briefly duplicated cache entry.
 */
function snapshotPointer(client: ClickHouseClient, table: string, cacheKey: string): Promise<SnapshotPointer | null> {
  return cached(cacheKey, 60_000, async () => {
    const res = await client.query({
      query: `
          SELECT
            argMax(snapshot_id, computed_at) AS snapshot_id,
            toUInt32(greatest(0, dateDiff('second', max(computed_at), now()))) AS age_seconds
          FROM price_data.${table}
          WHERE snapshot_key = 'current'
        `,
      format: 'JSONEachRow',
    })
    const [row] = await res.json<{ snapshot_id: string; age_seconds: number }>()
    if (!row?.snapshot_id) return null
    return { snapshotId: row.snapshot_id, ageSeconds: Number(row.age_seconds) || 0 }
  })
}

/** Per (stored account form, reserve asset) raw amounts, for one snapshot slice. */
type ByFormAndAsset = Map<string, Map<number, bigint>>

interface MoneyMarketPositions {
  supplied: ByFormAndAsset
  debt: ByFormAndAsset
}

/**
 * Money-market SUPPLIED and BORROWED balances per (stored account form, reserve
 * asset), in raw units — the indexer's own persisted position reconstruction rather
 * than a second implementation of it. `reserve_present = 1` selects the per-reserve
 * rows; the `reserve_present = 0` rows carry position-level aggregates with no
 * per-asset amount and must not be summed.
 *
 * The two sides are filtered differently, on purpose. Supplied balances from a
 * staking-backed market are dropped (the collateral never left the wallet, see
 * STAKING_BACKED_MARKET_KEYS), while debt is summed across EVERY configured market:
 * an account's obligations are one number even though the markets are isolated for
 * health-factor purposes, and no market's borrowing is backed by money this
 * endpoint counts twice.
 *
 * Returns null when no usable snapshot exists, which the caller must render as
 * "the money-market slice is temporarily absent" — never as zero supplied or zero
 * debt.
 */
async function moneyMarketPositions(
  client: ClickHouseClient,
  forms: string[],
): Promise<MoneyMarketPositions | null> {
  const pointer = await snapshotPointer(
    client,
    'money_market_account_value_snapshot_state',
    'public:v1:accounts:mm-snapshot-pointer',
  )
  if (!pointer || pointer.ageSeconds > SNAPSHOT_MAX_AGE_SECONDS) return null
  const res = await client.query({
    // snapshot_id is both the partition key and the leading primary-key column, so
    // the self-pinned generation reads exactly one live partition. The pointer above
    // decides only WHETHER to read, never WHICH generation.
    query: `
        SELECT
          account_id,
          asset_id,
          toString(sumIf(supplied, market_key NOT IN ({stakingBacked:Array(String)}))) AS supplied_raw,
          toString(sum(debt)) AS debt_raw
        FROM price_data.money_market_account_value_snapshots
        WHERE snapshot_id = ${currentGenerationSql('money_market_account_value_snapshot_state')}
          AND account_id IN ({accounts:Array(String)})
          AND reserve_present = 1
          AND (supplied > 0 OR debt > 0)
        GROUP BY account_id, asset_id
      `,
    query_params: { accounts: forms, stakingBacked: STAKING_BACKED_MARKET_KEYS },
    format: 'JSONEachRow',
  })
  const positions: MoneyMarketPositions = { supplied: new Map(), debt: new Map() }
  for (const row of await res.json<{ account_id: string; asset_id: number; supplied_raw: string; debt_raw: string }>()) {
    const form = row.account_id.toLowerCase()
    const assetId = Number(row.asset_id)
    for (const [side, raw] of [['supplied', row.supplied_raw], ['debt', row.debt_raw]] as const) {
      const amount = rawAmount(raw)
      if (amount === 0n) continue
      const byAsset = positions[side].get(form) ?? new Map<number, bigint>()
      byAsset.set(assetId, amount)
      positions[side].set(form, byAsset)
    }
  }
  return positions
}

/** One account's Omnipool claim on a pool: the asset leg plus the hub (LRNA) leg. */
interface OmnipoolClaim {
  assetId: number
  amount: bigint
  hubAmount: bigint
}

/**
 * Omnipool LP claims per stored account form, in raw units — what each account's
 * positions would withdraw against current pool state, bare and farm-deposited
 * alike. This is the indexer's own persisted claim snapshot, the same generation
 * the explorer's account directory values, so the two surfaces cannot disagree by
 * reconstructing positions twice.
 *
 * The table's ORDER BY is (snapshot_id, position_id) with no account column, so an
 * account predicate cannot be a key range. The self-pinned partition predicate is
 * what bounds the read: one generation is a few thousand rows (measured: 3.5 k rows
 * / 234 KiB / 2 ms).
 *
 * The per-batch result is cached only as long as the endpoint's own advertised
 * freshness (3 s). Claims are re-valued against live pool state every ~5 min, so a
 * longer hold would serve a superseded valuation; the read is cheap enough that the
 * cache exists to collapse concurrent bursts, not to avoid the query. The
 * generation id rides in the key so a detected republish invalidates immediately.
 *
 * Returns null when no usable snapshot exists: LP is then absent, never zero.
 */
async function omnipoolClaims(client: ClickHouseClient, forms: string[]): Promise<Map<string, OmnipoolClaim[]> | null> {
  const pointer = await snapshotPointer(
    client,
    'omnipool_account_claim_snapshot_state',
    'public:v1:accounts:lp-snapshot-pointer',
  )
  if (!pointer || pointer.ageSeconds > SNAPSHOT_MAX_AGE_SECONDS) return null
  const key = createHash('sha1').update([...forms].sort().join(',')).digest('hex')
  return cached(`public:v1:accounts:lp-claims:${pointer.snapshotId}:${key}`, 3_000, async () => {
    const res = await client.query({
      // Self-pinned to the live generation, never to the cached pointer: superseded
      // partitions are dropped the moment the pointer flips.
      query: `
          SELECT
            account_id,
            asset_id,
            toString(sum(amount)) AS amount,
            toString(sum(hub_amount)) AS hub_amount
          FROM price_data.omnipool_account_claim_snapshots
          WHERE snapshot_id = ${currentGenerationSql('omnipool_account_claim_snapshot_state')}
            AND account_id IN ({accounts:Array(String)})
          GROUP BY account_id, asset_id
        `,
      query_params: { accounts: forms },
      format: 'JSONEachRow',
    })
    const claims = new Map<string, OmnipoolClaim[]>()
    for (const row of await res.json<{ account_id: string; asset_id: number; amount: string; hub_amount: string }>()) {
      const form = row.account_id.toLowerCase()
      claims.set(form, [...(claims.get(form) ?? []), {
        assetId: Number(row.asset_id),
        amount: rawAmount(row.amount),
        hubAmount: rawAmount(row.hub_amount),
      }])
    }
    return claims
  })
}

// Registry aToken ids. A pallet-side balance row for one of these is the SAME
// economic position the value snapshot reports as `supplied` on the underlying
// reserve, so it is replaced by the snapshot rather than added to it — the
// replace-never-add rule for receipt-token views (AGENTS.md). Adding both would
// double-count the reserved slice these rows carry (`free` is always 0 for them,
// since the balance lives in EVM contract storage).
const ATOKEN_IDS = new Set(Object.keys(ATOKEN_UNDERLYING_ID).map(Number))

interface LatestBalanceRow {
  account_id: string
  asset_id: string
  free: string
  reserved: string
  last_block: number
}

/**
 * Current valued holdings per account, for 1..N accounts in one pass.
 *
 * `transferableUsd` values free balances plus the ERC-20-backed wallet pot plus
 * money-market SUPPLIED balances (the aToken side, spec "Semantics" rule 7);
 * `lockedUsd` values reserved ones; `lpUsd` values Omnipool LP claims, bare and
 * farmed, including each position's hub (LRNA) leg. `totalUsd` is the sum of the
 * three — GROSS assets. `debtUsd` is reported alongside and is never netted into
 * any of them, so the Hydration account picker's figure is `totalUsd - debtUsd`.
 *
 * Both the money-market and the LP slice come from the indexer's own persisted
 * snapshots, so this endpoint and the explorer cannot disagree by computing them
 * twice. The money-market slice REPLACES the pallet-side aToken rows rather than
 * adding to them. Either slice is omitted entirely when its snapshot is stale — a
 * missing slice (null), never a zero standing in for one, and a stale LP snapshot
 * leaves LP out of `totalUsd` too.
 *
 * An account with no indexed rows is absent from the result — never a zero row. An
 * account known ONLY by its positions is included (the claim snapshot carries no
 * block height of its own, so it reports blockHeight 0).
 */
export async function queryLatestBalances(client: ClickHouseClient, accounts: string[]): Promise<AccountBalanceRow[]> {
  if (!accounts.length) return []
  // Per requested address, every storage form its balances can appear under. Two
  // addresses that are halves of one binding share a form set and so share figures.
  const formsByAccount = await resolveAccountForms(client, accounts)
  const forms = allForms(formsByAccount)

  const [substrateRes, erc20Res, prices, mm, claims] = await Promise.all([
    client.query({
      // account_id is the leading primary-key column, so an IN list of at most
      // 150 forms is a bounded set of key ranges rather than a scan.
      query: `
          SELECT
            account_id,
            asset_id,
            toString(toUInt256OrZero(ifNull(argMaxMerge(free_state), '0'))) AS free,
            toString(toUInt256OrZero(ifNull(argMaxMerge(reserved_state), '0'))) AS reserved,
            toUInt32(maxMerge(last_block_state)) AS last_block
          FROM price_data.account_asset_latest_balances
          WHERE account_id IN ({accounts:Array(String)})
          GROUP BY account_id, asset_id
        `,
      query_params: { accounts: forms },
      format: 'JSONEachRow',
    }),
    client.query({
      // (asset_id, account_id) is this table's key and BOTH halves are used, so the
      // read is a set of point lookups. `account_id` must not be wrapped in
      // lower() here: a function on a key column turns the predicate into a
      // post-read filter over every holder of the asset. The forms are already
      // lowercase (zHexAddress normalises, storedAccountForms lowercases), and the
      // column is stored lowercase.
      query: `
          SELECT account_id, asset_id, toString(argMax(toUInt256OrZero(total), updated_at)) AS total
          FROM price_data.erc20_wallet_balances
          WHERE asset_id IN ({assets:Array(String)}) AND account_id IN ({accounts:Array(String)})
          GROUP BY account_id, asset_id
        `,
      query_params: { assets: ERC20_WALLET_ASSET_IDS.map(String), accounts: forms },
      format: 'JSONEachRow',
    }),
    currentPrices(client),
    moneyMarketPositions(client, forms),
    omnipoolClaims(client, forms),
  ])

  // Indexed by stored form, so each requested address can fold in exactly the forms
  // resolveAccountForms gave it — including a form it shares with an alias.
  const substrateByForm = new Map<string, LatestBalanceRow[]>()
  for (const row of await substrateRes.json<LatestBalanceRow>()) {
    const form = row.account_id.toLowerCase()
    substrateByForm.set(form, [...(substrateByForm.get(form) ?? []), row])
  }
  const erc20ByForm = new Map<string, { asset_id: string; total: string }[]>()
  for (const row of await erc20Res.json<{ account_id: string; asset_id: string; total: string }>()) {
    const form = row.account_id.toLowerCase()
    erc20ByForm.set(form, [...(erc20ByForm.get(form) ?? []), row])
  }

  const items: AccountBalanceRow[] = []
  // Requested order, so a caller's `accounts=` list and the response line up.
  for (const account of accounts) {
    let transferable = 0n
    let locked = 0n
    let lp = 0n
    let debt = 0n
    let blockHeight = 0
    let seen = false

    for (const form of formsByAccount.get(account) ?? []) {
      for (const row of substrateByForm.get(form) ?? []) {
        seen = true
        const assetId = Number(row.asset_id)
        // Every pallet row dates the account, including one whose VALUE is
        // superseded below — otherwise an account holding only aTokens would report
        // blockHeight 0 despite having been observed.
        blockHeight = Math.max(blockHeight, Number(row.last_block) || 0)
        // An aToken's pallet row is the money-market position the snapshot reports
        // on the underlying reserve; counting both would double the reserved slice.
        // Replaced, not added — and dropped outright when the snapshot is stale,
        // since this row is not a usable substitute for it either.
        if (ATOKEN_IDS.has(assetId)) continue
        const { decimals } = assetDescriptor(assetId)
        const price = priceFor(prices, assetId)
        transferable += usdScaled(rawAmount(row.free), price, decimals)
        locked += usdScaled(rawAmount(row.reserved), price, decimals)
      }
      for (const row of erc20ByForm.get(form) ?? []) {
        seen = true
        const assetId = Number(row.asset_id)
        // The ERC-20 pot is a wallet balance: transferable, never reserved. It
        // carries no block height of its own, so blockHeight stays the newest
        // substrate observation.
        transferable += usdScaled(rawAmount(row.total), priceFor(prices, assetId), assetDescriptor(assetId).decimals)
      }
      for (const [assetId, raw] of mm?.supplied.get(form) ?? []) {
        seen = true
        // Supplied collateral is withdrawable, so it belongs with transferable
        // rather than locked (spec "Semantics" rule 7).
        transferable += usdScaled(raw, priceFor(prices, assetId), assetDescriptor(assetId).decimals)
      }
      for (const [assetId, raw] of mm?.debt.get(form) ?? []) {
        seen = true
        // Reported on its own, never netted out of any other field.
        debt += usdScaled(raw, priceFor(prices, assetId), assetDescriptor(assetId).decimals)
      }
      for (const claim of claims?.get(form) ?? []) {
        seen = true
        // A position withdraws its own asset PLUS a hub leg denominated in LRNA;
        // valuing only the asset leg would under-report an imbalanced position.
        lp += usdScaled(claim.amount, priceFor(prices, claim.assetId), assetDescriptor(claim.assetId).decimals)
        lp += usdScaled(claim.hubAmount, priceFor(prices, LRNA_ASSET_ID), assetDescriptor(LRNA_ASSET_ID).decimals)
      }
    }

    if (seen) items.push({
      account,
      transferableUsd: formatUsd(transferable),
      lockedUsd: formatUsd(locked),
      // Absent rather than zero when the claim snapshot is stale — and then absent
      // from totalUsd too, since `lp` stays 0 in that case.
      lpUsd: claims ? formatUsd(lp) : null,
      debtUsd: mm ? formatUsd(debt) : null,
      totalUsd: formatUsd(transferable + locked + lp),
      blockHeight,
    })
  }
  return items
}

// The winning observation within one (account, pool, block): the position model's
// full replacement key plus its version column. Periodic re-snapshots sort last
// within a block because they observe the state the block's events left behind.
// Duplicated from the explorer's identical ordering — shared domain SQL cannot
// cross the isolation boundary.
const POSITION_ORDER_SQL = `tuple(
  block_height,
  if(startsWith(observation_id, 'money-market-periodic:'), toUInt32(4294967295),
    toUInt32OrZero(arrayElement(splitByChar(':', observation_id), 3))),
  observation_id, ingested_at)`

// The window's own block-height bounds, as scalar subqueries a position read can
// carry inline. `account_money_market_position_history` has no timestamp column and
// is keyed (account_id, pool_address, block_height, observation_id), so a height
// range is the only predicate that prunes it — and the only thing standing between
// this read and one row per block of the account's whole life.
const WINDOW_FIRST_BLOCK_SQL = `(
    SELECT min(block_height) FROM price_data.blocks
    WHERE block_timestamp >= toDateTime({from:UInt32})
  )`
const WINDOW_LAST_BLOCK_SQL = `(
    SELECT max(block_height) FROM price_data.blocks
    WHERE block_timestamp < toDateTime({to:UInt32})
  )`

// Configured money-market pools, from the reserve map the anchor snapshotter
// maintains. Debt is summed across all of them: an account's obligations are one
// number even though the markets are isolated for health-factor purposes.
function configuredMmPools(client: ClickHouseClient): Promise<string[]> {
  return cached('public:v1:accounts:mm-pools', 300_000, async () => {
    const res = await client.query({
      query: `SELECT DISTINCT lower(pool_proxy) AS pool_proxy FROM price_data.atoken_reserve_map`,
      format: 'JSONEachRow',
    })
    return (await res.json<{ pool_proxy: string }>()).map(row => row.pool_proxy).filter(Boolean).sort()
  })
}

export interface BalanceHistoryOptions {
  fromIso: string | null
  toIso: string | null
  bucket: HistoryBucket
}

/** A requested grid, resolved against the bucket size and the last closed bucket. */
export interface HistoryGrid {
  fromSeconds: number
  toSeconds: number
  stepSeconds: number
  points: number
}

/**
 * Resolve `from`/`to` onto the bucket grid. Both ends are floored to the bucket,
 * and `to` never exceeds the most recently CLOSED bucket: every emitted point
 * describes a complete bucket valued at a candle that had closed by its end
 * (AGENTS.md), so no point is a partial in-progress figure.
 */
export function resolveHistoryGrid(options: BalanceHistoryOptions, nowMs: number = Date.now()): HistoryGrid {
  const stepSeconds = HISTORY_BUCKET_SECONDS[options.bucket]
  const floor = (seconds: number) => Math.floor(seconds / stepSeconds) * stepSeconds
  const lastClosed = floor(Math.floor(nowMs / 1000))
  const requestedTo = options.toIso ? Math.floor(Date.parse(options.toIso) / 1000) : lastClosed
  const toSeconds = Math.min(floor(requestedTo), lastClosed)
  const fromSeconds = options.fromIso
    ? floor(Math.floor(Date.parse(options.fromIso) / 1000))
    : toSeconds - HISTORY_DEFAULT_POINTS[options.bucket] * stepSeconds
  return { fromSeconds, toSeconds, stepSeconds, points: Math.floor((toSeconds - fromSeconds) / stepSeconds) }
}

/**
 * Net-worth series on a fixed grid: per-asset forward-fill of the hourly balance
 * model, valued at each bucket's closed candle, plus money-market debt.
 *
 * This series is NARROWER than GET /v1/accounts/balances, deliberately, and the
 * route description says so. It covers only what `account_balance_hourly` records —
 * pallet-side balances. Two pots are absent because no per-bucket history of them
 * exists: money-market SUPPLIED balances (the value snapshot is current-state only,
 * with no history, so applying it to a past bucket would value that bucket at
 * today's position — the future-price mistake AGENTS.md forbids) and the
 * ERC-20-backed wallet pot (`erc20_wallet_balances` is likewise a current snapshot).
 *
 * `debtUsd`, by contrast, IS reconstructible per bucket and is reported. So for a
 * leveraged account this series shows full debt against holdings that exclude the
 * collateral backing it: `transferableUsd - debtUsd` is NOT net worth, and the
 * route description states that plainly.
 *
 * `lockedUsd` is always "0.00": the historical balance models
 * (`account_balance_hourly`, `account_balance_history`) store only the TOTAL
 * balance, and the free/reserved split exists solely in `raw_balance_observations`,
 * whose block-first key makes a per-account historical read unbounded (measured:
 * 28.7 M rows / 2.02 GiB for one account). The whole pallet-side valued balance
 * therefore rides in `transferableUsd`; GET /v1/accounts/balances carries the
 * current split.
 */
export async function queryBalanceHistory(
  client: ClickHouseClient,
  account: string,
  options: BalanceHistoryOptions,
): Promise<BalanceHistoryPoint[]> {
  const grid = resolveHistoryGrid(options)
  if (grid.points < 1) return []
  const forms = await resolveSingleAccountForms(client, account)

  const [bucketedRes, seedRes, positionRes, pools] = await Promise.all([
    client.query({
      // Bucketed in SQL, not in TS. Returning one row per hour of an account's
      // whole life is O(assets x lifetime-hours) and blows the client's result cap
      // for a long-lived wallet (measured: 105.7 k rows for one bound EVM account);
      // grouping to the requested bucket here makes the result O(assets x buckets)
      // and sparse, since only buckets the account was actually observed in appear.
      //
      // An hour is assigned to the FIRST bucket whose close it precedes —
      // ceil((hour + 1h - from) / step) - 1 — which is the closed-interval rule the
      // valuation uses, applied once in SQL instead of per bucket in TS.
      query: `
          SELECT
            account_id,
            asset_id,
            toUInt32(intDiv(toUnixTimestamp(interval_start) + 3600 - {from:UInt32} + {step:UInt32} - 1, {step:UInt32}) - 1) AS bucket,
            toString(toUInt256OrZero(argMaxMerge(balance_state))) AS balance
          FROM price_data.account_balance_hourly
          WHERE account_id IN ({accounts:Array(String)})
            AND interval_start >= toDateTime({from:UInt32}) AND interval_start < toDateTime({to:UInt32})
          GROUP BY account_id, asset_id, bucket
          ORDER BY account_id, asset_id, bucket
        `,
      query_params: { accounts: forms, from: grid.fromSeconds, step: grid.stepSeconds, to: grid.toSeconds },
      format: 'JSONEachRow',
    }),
    client.query({
      // The state entering the window: the last hour observed before it, per
      // (account, asset). Without this an account that simply held a balance
      // through the whole window — never transacting inside it — would chart zero.
      // The result is one row per asset however long the history is.
      query: `
          SELECT account_id, asset_id, toString(argMax(balance, ts)) AS balance FROM (
            SELECT
              account_id,
              asset_id,
              toUnixTimestamp(interval_start) AS ts,
              toUInt256OrZero(argMaxMerge(balance_state)) AS balance
            FROM price_data.account_balance_hourly
            WHERE account_id IN ({accounts:Array(String)}) AND interval_start < toDateTime({from:UInt32})
            GROUP BY account_id, asset_id, interval_start
          )
          GROUP BY account_id, asset_id
        `,
      query_params: { accounts: forms, from: grid.fromSeconds },
      format: 'JSONEachRow',
    }),
    client.query({
      // The debt state ENTERING the window, plus whether the window contains any
      // observation at all — one row per (storage form, pool), whatever the account's
      // history.
      //
      // The read this replaced grouped by (pool_address, block_height) over that
      // whole history: the model carries one row per observed block, so a busy
      // account is hundreds of thousands of rows (measured: 412,855 for one live
      // account, 1.45 M for the heaviest) against the client's 100 k result cap, and
      // the endpoint answered 500. Nothing downstream ever needed per-block
      // resolution — the series is per BUCKET.
      //
      // account_id stays in the GROUP BY even though the series is summed across
      // forms: a requested address resolves to several forms, and collapsing two of
      // them on one pool with argMax would report one form's debt as the whole
      // obligation. Unreachable on today's data (the position model is 100 %
      // ETH-prefixed, so one identity has at most one form in it), so this is the
      // invariant being encoded rather than a live bug — same shape as
      // moneyMarketPositions, which groups by (account_id, asset_id) for this reason.
      query: `
          SELECT
            account_id,
            lower(pool_address) AS pool_address,
            toString(argMaxIf(total_debt_base, ${POSITION_ORDER_SQL},
              block_height < ${WINDOW_FIRST_BLOCK_SQL})) AS seed_debt,
            toUInt32(countIf(block_height >= ${WINDOW_FIRST_BLOCK_SQL}
              AND block_height <= ${WINDOW_LAST_BLOCK_SQL})) AS in_window
          FROM price_data.account_money_market_position_history
          WHERE account_id IN ({accounts:Array(String)})
          GROUP BY account_id, pool_address
          ORDER BY account_id, pool_address
        `,
      query_params: { accounts: forms, from: grid.fromSeconds, to: grid.toSeconds },
      format: 'JSONEachRow',
    }),
    configuredMmPools(client),
  ])

  const bucketed = await bucketedRes.json<{ account_id: string; asset_id: string; bucket: number; balance: string }>()
  const seeds = await seedRes.json<{ account_id: string; asset_id: string; balance: string }>()
  const poolSet = new Set(pools)
  // One entry per (storage form, pool) — the key the debt series is carried under, so
  // two forms of one identity contribute two levels that are summed rather than one
  // that overwrote the other.
  const positions = (await positionRes.json<{ account_id: string; pool_address: string; seed_debt: string; in_window: number }>())
    .filter(row => poolSet.has(row.pool_address))
    .map(row => ({ ...row, key: `${row.account_id.toLowerCase()}:${row.pool_address}` }))
  // Nothing indexed for this account at all: an empty series, not a grid of zeros.
  if (!bucketed.length && !seeds.length && !positions.length) return []

  const heldAssets = [...new Set([...bucketed, ...seeds].map(row => Number(row.asset_id)))]
  const priceAssets = [...new Set(heldAssets.map(priceAssetId))].sort((a, b) => a - b)

  const [candleRes, candleSeedRes, debtBucketRes] = await Promise.all([
    priceAssets.length
      ? client.query({
        // Bucketed in SQL for the same reason as the balances above: one row per
        // hourly candle over a 90-day window plus its 30-day lookback is
        // O(assets x window-hours) and overflowed the client's result cap
        // (measured: 105.7 k rows). Only the LAST closed candle in each bucket can
        // ever price it, so the rest never needed to cross the wire.
        query: `
            SELECT
              asset_id,
              toUInt32(intDiv(candle_ts + 3600 - {from:UInt32} + {step:UInt32} - 1, {step:UInt32}) - 1) AS bucket,
              toString(argMax(close, candle_ts)) AS close,
              max(candle_ts) AS ts
            FROM (
              SELECT asset_id, toUnixTimestamp(interval_start) AS candle_ts, argMaxMerge(close_state) AS close
              FROM price_data.ohlc_1h
              WHERE asset_id IN ({assets:Array(UInt32)})
                AND interval_start >= toDateTime({from:UInt32}) AND interval_start < toDateTime({to:UInt32})
              GROUP BY asset_id, interval_start
            )
            GROUP BY asset_id, bucket
            ORDER BY asset_id, bucket
          `,
        query_params: { assets: priceAssets, from: grid.fromSeconds, step: grid.stepSeconds, to: grid.toSeconds },
        format: 'JSONEachRow',
      })
      : null,
    // The price entering the window: the newest candle closed before it, bounded by
    // the staleness lookback so a dead feed cannot reach forward into the window.
    priceAssets.length
      ? client.query({
        query: `
            SELECT asset_id, toString(argMax(close, candle_ts)) AS close, max(candle_ts) AS ts FROM (
              SELECT asset_id, toUnixTimestamp(interval_start) AS candle_ts, argMaxMerge(close_state) AS close
              FROM price_data.ohlc_1h
              WHERE asset_id IN ({assets:Array(UInt32)})
                AND interval_start >= toDateTime({lookback:UInt32}) AND interval_start < toDateTime({from:UInt32})
              GROUP BY asset_id, interval_start
            )
            GROUP BY asset_id
          `,
        query_params: {
          assets: priceAssets,
          lookback: Math.max(0, grid.fromSeconds - PRICE_LOOKBACK_SECONDS),
          from: grid.fromSeconds,
        },
        format: 'JSONEachRow',
      })
      : null,
    // Debt per (storage form, pool, bucket) inside the window — one row per bucket the
    // account was actually observed in, never one per block. Read only when the summary
    // above reported an observation INSIDE the window (both ends bounded), so an old
    // window on an account that is merely still active today does not fire it, and a
    // wallet that has only carried a debt through the window costs nothing here (its
    // level rides in `seed_debt`).
    //
    // The model is keyed by block height and carries no timestamp, so a block has to be
    // mapped to its bucket through `blocks`. The expression is intDiv(ts - from, step),
    // the FLOOR form — deliberately not the balance grid's ceil form
    // (intDiv(ts + 3600 - from + step - 1, step) - 1), because the two inputs are
    // different things: an hourly balance row is a SPAN whose value is as of its close,
    // while a block is an INSTANT inside one bucket. Floor puts a block at
    // `from + b*step` in bucket b, which is exactly the boundary the walk this replaced
    // computed as `max(block_height) WHERE block_timestamp < bucketEnd`.
    //
    // `blocks` is the JOIN's right side because it is the narrow one (two integers per
    // row); the position side streams and is pruned to the window on its own key.
    positions.some(row => Number(row.in_window) > 0)
      ? client.query({
        query: `
            SELECT
              p.account_id AS account_id,
              p.pool_address AS pool_address,
              bk.bucket AS bucket,
              toString(argMax(p.total_debt_base, p.block_height)) AS total_debt_base
            FROM (
              SELECT
                account_id,
                lower(pool_address) AS pool_address,
                toUInt32(block_height) AS block_height,
                argMax(total_debt_base, ${POSITION_ORDER_SQL}) AS total_debt_base
              FROM price_data.account_money_market_position_history
              WHERE account_id IN ({accounts:Array(String)})
                AND block_height >= ${WINDOW_FIRST_BLOCK_SQL}
                AND block_height <= ${WINDOW_LAST_BLOCK_SQL}
              GROUP BY account_id, pool_address, block_height
            ) AS p
            INNER JOIN (
              SELECT
                toUInt32(block_height) AS block_height,
                toUInt32(intDiv(toInt64(toUnixTimestamp(block_timestamp)) - {from:UInt32}, {step:UInt32})) AS bucket
              FROM price_data.blocks
              WHERE block_timestamp >= toDateTime({from:UInt32}) AND block_timestamp < toDateTime({to:UInt32})
            ) AS bk USING (block_height)
            GROUP BY account_id, pool_address, bucket
            ORDER BY account_id, pool_address, bucket
          `,
        query_params: { accounts: forms, from: grid.fromSeconds, step: grid.stepSeconds, to: grid.toSeconds },
        format: 'JSONEachRow',
      })
      : null,
  ])

  // Per (price asset) the bucket at which each new close takes effect, oldest
  // first. SQL applied the closed-candle rule, so a bucket takes the newest entry
  // at or before it; `ts` rides along for the staleness check.
  const candles = new Map<number, { bucket: number; ts: number; close: bigint }[]>()
  for (const row of candleRes ? await candleRes.json<{ asset_id: number; bucket: number; ts: number; close: string }>() : []) {
    const assetId = Number(row.asset_id)
    const series = candles.get(assetId) ?? []
    series.push({ bucket: Number(row.bucket), ts: Number(row.ts), close: decimalToScaled(row.close, USD_DECIMALS) })
    candles.set(assetId, series)
  }
  for (const series of candles.values()) series.sort((a, b) => a.bucket - b.bucket)

  // The price entering bucket 0.
  const lastClose = new Map<number, bigint>()
  const lastCloseTs = new Map<number, number>()
  for (const row of candleSeedRes ? await candleSeedRes.json<{ asset_id: number; ts: number; close: string }>() : []) {
    const assetId = Number(row.asset_id)
    lastClose.set(assetId, decimalToScaled(row.close, USD_DECIMALS))
    lastCloseTs.set(assetId, Number(row.ts))
    if (!candles.has(assetId)) candles.set(assetId, [])
  }

  // Per (storage form, asset) the bucket at which each new balance takes effect,
  // oldest first. SQL has already applied the closed-interval rule, so a bucket's
  // value is simply the newest entry at or before it.
  const series = new Map<string, { bucket: number; balance: bigint }[]>()
  for (const row of bucketed) {
    const key = `${row.account_id.toLowerCase()}:${row.asset_id}`
    const points = series.get(key) ?? []
    points.push({ bucket: Number(row.bucket), balance: rawAmount(row.balance) })
    series.set(key, points)
  }
  for (const points of series.values()) points.sort((a, b) => a.bucket - b.bucket)

  // The state entering bucket 0, so an account that merely held a balance through
  // the window is charted rather than starting at zero.
  const lastBalance = new Map<string, bigint>()
  for (const row of seeds) {
    const key = `${row.account_id.toLowerCase()}:${row.asset_id}`
    lastBalance.set(key, rawAmount(row.balance))
    if (!series.has(key)) series.set(key, [])
  }

  // Base units are USD with 8 decimals; scale up to the internal USD scale by
  // integer multiplication rather than dividing by 1e8 in floating point.
  const debtScale = 10n ** BigInt(USD_DECIMALS - MM_BASE_DECIMALS)

  // Per (storage form, pool) the bucket at which each new debt level takes effect,
  // oldest first — the same shape, and the same per-form keying, as the balance series,
  // because SQL has already reduced each bucket's observations to its newest one. The
  // per-bucket total is the SUM over these series, so two forms of one identity holding
  // a position on the same pool report both debts.
  const debtByPool = new Map<string, { bucket: number; debt: bigint }[]>()
  const positionKeys = new Set(positions.map(row => row.key))
  for (const row of debtBucketRes
    ? await debtBucketRes.json<{ account_id: string; pool_address: string; bucket: number; total_debt_base: string }>()
    : []) {
    const key = `${row.account_id.toLowerCase()}:${row.pool_address.toLowerCase()}`
    // A pool outside the configured set is not this account's obligation.
    if (!positionKeys.has(key)) continue
    const points = debtByPool.get(key) ?? []
    points.push({ bucket: Number(row.bucket), debt: rawAmount(row.total_debt_base) * debtScale })
    debtByPool.set(key, points)
  }
  for (const points of debtByPool.values()) points.sort((a, b) => a.bucket - b.bucket)

  // One forward walk per series: each cursor only ever moves ahead, so the whole
  // grid is linear in (observations + points) and never re-reads a price.
  const balanceCursors = new Map<string, number>()
  const candleCursors = new Map<number, number>()
  const debtCursors = new Map<string, number>()

  // The debt entering bucket 0, so a wallet that merely carries a position through
  // the window charts its real debt instead of starting at zero.
  const lastDebt = new Map<string, bigint>()
  for (const row of positions) {
    lastDebt.set(row.key, rawAmount(row.seed_debt) * debtScale)
    if (!debtByPool.has(row.key)) debtByPool.set(row.key, [])
  }

  const items: BalanceHistoryPoint[] = []
  for (let bucket = 0; bucket < grid.points; bucket++) {
    const bucketEnd = grid.fromSeconds + (bucket + 1) * grid.stepSeconds

    // Balances: SQL assigned each observation to the first bucket whose close it
    // precedes, so everything up to and including this bucket now applies.
    for (const [key, points] of series) {
      let cursor = balanceCursors.get(key) ?? 0
      while (cursor < points.length && points[cursor].bucket <= bucket) {
        lastBalance.set(key, points[cursor].balance)
        cursor++
      }
      balanceCursors.set(key, cursor)
    }
    // Prices: same rule, so a bucket is never valued at a candle still forming.
    for (const [assetId, points] of candles) {
      let cursor = candleCursors.get(assetId) ?? 0
      while (cursor < points.length && points[cursor].bucket <= bucket) {
        lastClose.set(assetId, points[cursor].close)
        lastCloseTs.set(assetId, points[cursor].ts)
        cursor++
      }
      candleCursors.set(assetId, cursor)
    }
    // Debt: same rule as the balances — SQL assigned each observation to the bucket
    // whose block range contains it, so everything up to and including this bucket
    // now applies, and a bucket with no observation carries the previous level.
    for (const [key, points] of debtByPool) {
      let cursor = debtCursors.get(key) ?? 0
      while (cursor < points.length && points[cursor].bucket <= bucket) {
        lastDebt.set(key, points[cursor].debt)
        cursor++
      }
      debtCursors.set(key, cursor)
    }

    let valued = 0n
    for (const [key, balance] of lastBalance) {
      if (balance === 0n) continue
      const assetId = Number(key.slice(key.lastIndexOf(':') + 1))
      const priceId = priceAssetId(assetId)
      const closeTs = lastCloseTs.get(priceId)
      // Past the lookback the feed is stale, so the asset is unpriced for this
      // bucket and contributes nothing — never valued at an arbitrarily old close.
      if (closeTs == null || closeTs + PRICE_LOOKBACK_SECONDS < bucketEnd) continue
      valued += usdScaled(balance, lastClose.get(priceId) ?? 0n, assetDescriptor(assetId).decimals)
    }
    // Summed over every (storage form, pool) series: an account's obligations are one
    // number even though the markets are isolated, and one identity may hold a position
    // under more than one storage form.
    let debt = 0n
    for (const value of lastDebt.values()) debt += value

    items.push({
      timestamp: iso(bucketEnd * 1000),
      transferableUsd: formatUsd(valued),
      lockedUsd: formatUsd(0n),
      debtUsd: formatUsd(debt),
    })
  }
  return items
}
