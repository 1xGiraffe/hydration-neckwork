import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { allExplorerAssets } from '../../services/explorerAssets.ts'
import { xykPoolMeta } from './poolVolumes.ts'
import { publicStatus } from './status.ts'

// The DexScreener DEX-adapter surface: /dexscreener/{latest-block,asset,pair,events}.
//
// Unlike /v1, the shapes here are NOT ours. They are fixed by DexScreener's
// adapter specification, pinned field-for-field against the previous Hydration
// adapter's own interface declaration (galacticcouncil/hydration-data-feeds,
// apps/hydration-data-lake-adapter/src/modules/consumers/dexscreener/v1/
// dexscreener.interfaces.ts) and cross-checked live against
// https://adapters.kril.hydration.cloud/dexscreener/…, so a consumer can swap the
// base URL. Three consequences follow, and they are deliberate deviations from
// the /v1 wire conventions in
// docs/superpowers/specs/2026-08-12-public-rest-api-design.md:
//
//  * Amounts are DECIMAL-ADJUSTED strings ("20", "3.435069126996"), not raw
//    integer strings. DexScreener's parser expects token units. The arithmetic
//    behind them is still integer-only — a raw u128 amount never passes through a
//    JavaScript number.
//  * Timestamps are unix SECONDS as JSON numbers, not ISO-8601 strings.
//  * An asset id is the registry id as a decimal string, EXCEPT for an
//    ERC-20-registered asset, which is named by its contract address — see
//    `pairIdForms`. Pair ids are opaque strings whose scheme is the previous
//    adapter's, byte for byte (see `pairId`).
//
// Fields of the adapter spec this API does NOT serve are listed at their
// producer below, each with the reason. None of them is faked.

/** DexScreener's per-chain DEX identifier. One value for the whole protocol, as the previous adapter published. */
export const DEX_KEY = 'hydration'

/** The Omnipool pallet account ("modlomnipool"), used as the Omnipool's pair-id pool component. */
export const OMNIPOOL_ACCOUNT = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'

/** LRNA, the Omnipool hub asset. Every Omnipool fill has exactly one hub side (verified: 0 of 118,820 fills without one). */
export const HUB_ASSET_ID = 1

/**
 * The venues served as DexScreener pairs. `pool_swap_legs` also carries `aave`
 * (17.1% of fills), `otc` and `hsm`, and they are deliberately excluded:
 *
 *  * `aave` fills are money-market aToken mint/redeem legs, always 1:1 with the
 *    underlying. They are not a pool, have no reserve model, and reporting them
 *    would publish deposits as DEX volume at a constant price of 1.
 *  * `otc` is keyed per ORDER, so every order would be its own pair — unbounded
 *    pair cardinality for a bilateral trade, not a pool.
 *  * `hsm` is the HOLLAR stability facility, a protocol operation rather than a
 *    tradeable pool.
 *  * `lbp` holds no rows today, but the legacy pre-Broadcast projection declares
 *    it and will populate it at backfill. It is a bootstrapping auction with a
 *    time-varying weight curve, not a constant pool, and it has no reserve model
 *    here — so it stays out by the same rule rather than appearing by default.
 *
 * A route that hops through one of those still reports its Omnipool/stableswap/XYK
 * legs; only the excluded venue's own leg is absent.
 */
export const DEX_VENUES = ['omnipool', 'stableswap', 'xyk'] as const
export type DexVenue = (typeof DEX_VENUES)[number]

/**
 * The widest `events` window. Measured over blocks 13,570,000–13,580,000 the
 * chain produces ~0.81 fills per block, so 10,000 blocks is ~8,000 events — one
 * response DexScreener can page through by moving the window, and a bounded read
 * whatever the range's density.
 */
export const MAX_BLOCK_SPAN = 10_000

/**
 * The most events one window may answer with. Reaching it is a 400 asking for a
 * narrower range, never a silent truncation: DexScreener advances its cursor past
 * a window it believes it received in full, so a dropped tail would be lost
 * permanently rather than retried.
 */
export const MAX_EVENTS = 50_000

/**
 * The largest accepted block number. `block_height` is a UInt32 on chain and the
 * event queries bind it as `{fromBlock:UInt32}`, and ClickHouse wraps an
 * out-of-range parameter MOD 2^32 in silence rather than erroring — 4,294,967,300
 * binds as block 4, so an overflowing cursor would get a 200 describing an
 * entirely different window. The bound is enforced at the edge, the same way
 * MAX_ASSET_ID is in schemas/common.ts.
 */
export const MAX_BLOCK_NUMBER = 4_294_967_295

/** The registry's own id ceiling, mirroring `MAX_ASSET_ID` in schemas/common.ts. */
const MAX_ASSET_ID = 4_294_967_295

/**
 * The pool state histories are sampled on a 600-block grid (verified: every
 * sampled height is a multiple of 600 — `block_height % 600 = 0` in the three MVs
 * at clickhouse/schema/003_materialized_views.sql), so a fill's reserves are the
 * nearest sample AT OR BEFORE its block, at most 600 blocks old in normal
 * operation. Two grid steps is the staleness bound; past it the `reserves` field
 * is omitted.
 *
 * The bound is load-bearing, not defensive. `omnipool_pool_state_history` keeps a
 * delisted asset's final row forever, so an unbounded nearest-at-or-before lookup
 * would value a recent fill at reserves a year old and present them as current.
 *
 * WHY THIS BOUND IS COUNTED IN BLOCKS AND MUST STAY THAT WAY. It looks like the
 * family of hardcoded 6 s constants that silently re-scope a window when the chain
 * moves to 2 s blocks, and it is the opposite: the GRID it bounds is itself
 * block-counted, so "two grid steps" is 1,200 blocks at any cadence and the
 * relationship the bound expresses is cadence-independent. Restating it as a wall
 * clock interval is what would break it — 2 h is two grid steps at 6 s but SIX at
 * 2 s, so the field would start publishing reserves six samples old.
 *
 * The accuracy argument points the same way. The error in a published reserve is
 * how much the pool moved between the sample and the fill, and pool movement
 * tracks FILLS, not seconds; at 2 s blocks an hour carries three times the fills,
 * so a wall-clock bound would let the published number drift three times as far
 * while a block-counted one holds its accuracy. In wall clock this bound is
 * ≈2 h at 6 s and ≈40 min at 2 s: it tightens with the cadence, which is the safe
 * direction (a sample is dropped, never published stale).
 */
export const RESERVE_GRID_BLOCKS = 600
/** Grid steps a sample may be behind the fill before `reserves` is omitted. */
export const RESERVE_MAX_STALE_GRID_STEPS = 2
export const RESERVE_MAX_STALE_BLOCKS = RESERVE_MAX_STALE_GRID_STEPS * RESERVE_GRID_BLOCKS

/** Decimal places `priceNative` carries, matching the previous adapter's output exactly. */
const PRICE_DECIMALS = 20

// ---------------------------------------------------------------------------
// Pure amount arithmetic
// ---------------------------------------------------------------------------

/**
 * A raw on-chain integer amount as a decimal string in token units.
 *
 * BigInt throughout: an 18-decimal amount passes 2^64 routinely, and the
 * 25-digit stableswap share issuances this serves are past a double's 2^53 of
 * exact integers, so any float step would silently round the value.
 */
export function formatUnits(raw: string, decimals: number): string {
  const input = (raw ?? '').trim()
  if (!input) return '0'
  if (!/^-?\d+$/.test(input)) throw new RangeError(`not a raw integer amount: ${raw}`)
  const negative = input.startsWith('-')
  const digits = negative ? input.slice(1) : input
  if (decimals <= 0) return `${negative && digits !== '0' ? '-' : ''}${BigInt(digits)}`
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '')
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  const sign = negative && (whole !== '0' || fraction) ? '-' : ''
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * The pair's native price: how much asset1 one unit of asset0 buys, in token
 * units, from the fill's own two amounts.
 *
 * Rounded HALF-UP at 20 decimals — the previous adapter's exact behaviour,
 * confirmed against two of its live responses (an Omnipool fill reporting
 * 5.82229913302798264081 and a stableswap fill reporting 0.98906875559651910522,
 * both reproduced to the last digit by this function). The division itself is
 * exact integer arithmetic; the single rounding happens here, at the wire.
 */
export function priceNative(amount0Raw: string, decimals0: number, amount1Raw: string, decimals1: number): string {
  const denominator = BigInt(amount0Raw || '0') * 10n ** BigInt(decimals1)
  // A fill with nothing on the asset0 side has no price rather than an infinite
  // one; it cannot happen for a real swap, and reporting 0 keeps the field's type.
  if (denominator === 0n) return '0'
  const numerator = BigInt(amount1Raw || '0') * 10n ** BigInt(decimals0) * 10n ** BigInt(PRICE_DECIMALS)
  const scaled = (2n * numerator + denominator) / (2n * denominator)
  return formatUnits(scaled.toString(), PRICE_DECIMALS)
}

// ---------------------------------------------------------------------------
// Identifier forms
// ---------------------------------------------------------------------------

/**
 * The two indexed lookups that make this surface's identifiers the previous
 * adapter's, so DexScreener's existing per-pair history carries over a base-URL
 * swap instead of every pair being seen as new.
 *
 * Both are derived from indexed chain data, not from a curated list, and both are
 * small (26 ERC-20 assets, 17 stableswap pools) and shared through one cache
 * entry, so pair identity costs no per-request query in steady state.
 */
export interface PairIdForms {
  /** Registry asset id → its ERC-20 contract address, for ERC-20-registered assets only. */
  contractByAssetId: Map<number, string>
  /** The inverse, so a request may name an asset either way. */
  assetIdByContract: Map<string, number>
  /** Stableswap pool id → the pool's on-chain account. */
  accountByPoolId: Map<number, string>
  /** The inverse, so a pair id's pool component resolves back to a pool. */
  poolIdByAccount: Map<string, number>
}

/**
 * Every ERC-20-registered asset's contract address, from the asset registry's own
 * events — the same "newest AssetRegistry event per asset is exact current state"
 * read securityService.ts uses, and affordable for the same reason: `raw_events`
 * carries a `set(200)` skipping index on `event_name`, so the ~2,300 registry rows
 * among 308M are reached by reading 31.6M rows / 1.03 GiB in 0.082–0.109 s
 * (measured over five runs). That cost is paid once per 300 s cache refresh and does
 * not scale with the request, but it is a real read, not a point lookup.
 *
 * An asset qualifies on TWO conditions, and both are load-bearing:
 *
 *  * its newest `assetType` is `Erc20` — this is what makes it a contract-backed
 *    token rather than a Tokens-pallet balance;
 *  * its newest location is `parents = 0`, interior `X1`, a single `AccountKey20`
 *    — a LOCAL contract. Foreign assets carry AccountKey20 junctions too (asset 43
 *    names a Moonbeam contract under `parents = 1`, asset 46 an Ethereum one under
 *    `parents = 2`), and publishing one of those as this chain's asset id would
 *    name a token on another chain.
 *
 * The `X1` payload is read BOTH ways because the XCM version changed underneath it:
 * older events carry the junction as an object, newer ones as a one-element array.
 * Reading only the object form silently loses the newer half — measured, that is 10
 * of the 26 ERC-20 assets, including four that trade daily (BIL, aSOL, aEURC, GSOL).
 *
 * NOT the ERC-20 precompile (`0x…01` + the id as a big-endian u32, the arithmetic
 * form `moneyMarketEvents.precompileAddress` builds). That address is where the
 * money market files a reserve; the address that NAMES the asset here is the
 * deployed contract, and the two are unrelated values. HOLLAR is the clearest case:
 * its precompile would be `0x…010000_00de` while it is really
 * `0x531a654d1696ed52e7275a8cede955e82620f99a`.
 *
 * The final join is a LEFT JOIN keeping EVERY `Erc20` asset, with an empty contract
 * where the location conditions do not hold, so an asset whose location this query
 * cannot read is visible as a row rather than absent. That is the tripwire: silently
 * dropping one re-keys its pairs to the registry id, which reads to an aggregator as
 * a brand-new pair rather than as an error. `pairIdForms` names the empty ones in a
 * warning; it is silent today (26 of 26 resolve).
 */
export const ERC20_CONTRACTS_SQL = `-- pub:ds:erc20-contracts
WITH types AS (
  SELECT toUInt32(JSONExtractUInt(args_json, 'assetId')) AS asset_id,
         argMax(JSONExtractString(args_json, 'assetType', '__kind'), (block_height, event_index)) AS asset_type
  FROM price_data.raw_events
  WHERE event_name IN ('AssetRegistry.Registered', 'AssetRegistry.Updated')
  GROUP BY asset_id
),
locations AS (
  SELECT toUInt32(JSONExtractUInt(args_json, 'assetId')) AS asset_id,
         argMax(JSONExtractUInt(args_json, 'location', 'parents'), (block_height, event_index)) AS parents,
         argMax(JSONExtractString(args_json, 'location', 'interior', '__kind'), (block_height, event_index)) AS interior_kind,
         argMax(if(empty(JSONExtractString(args_json, 'location', 'interior', 'value', '__kind')),
                   JSONExtractString(args_json, 'location', 'interior', 'value', 1, '__kind'),
                   JSONExtractString(args_json, 'location', 'interior', 'value', '__kind')),
                (block_height, event_index)) AS junction_kind,
         argMax(lower(if(empty(JSONExtractString(args_json, 'location', 'interior', 'value', 'key')),
                         JSONExtractString(args_json, 'location', 'interior', 'value', 1, 'key'),
                         JSONExtractString(args_json, 'location', 'interior', 'value', 'key'))),
                (block_height, event_index)) AS contract
  FROM price_data.raw_events
  WHERE event_name = 'AssetRegistry.LocationSet'
  GROUP BY asset_id
)
SELECT t.asset_id AS asset_id,
       if(l.parents = 0 AND l.interior_kind = 'X1' AND l.junction_kind = 'AccountKey20'
            AND match(l.contract, '^0x[0-9a-f]{40}$'),
          l.contract, '') AS contract
FROM types t
LEFT JOIN locations l ON l.asset_id = t.asset_id
WHERE t.asset_type = 'Erc20'`

/**
 * Each stableswap pool's on-chain account, which is the pool component of its pair
 * ids.
 *
 * The account is a hash of the pool's assets, not anything derivable from the pool
 * id, so it has to come from indexed data — and `pool_swap_legs` does not carry it:
 * its `pool_key` is the stableswap pool ID (the `fillerType` value), because that is
 * what every other public surface keys a stableswap pool by. The account is in the
 * `Broadcast.Swapped*` event's own `filler` field, which the projection drops for
 * this venue.
 *
 * So the read is two bounded steps rather than a scan: `pool_swap_legs` names each
 * pool's newest block (17 rows off the venue-leading primary key), and `raw_events`
 * is then read only at those ~17 block heights, which the (block_height, event_index)
 * primary key prunes to 10.88M rows / 148.63 MiB in 0.026–0.030 s (measured over five
 * runs — granule-rounded across the table's month partitions, so bounded and
 * request-independent rather than a handful of rows). A pool that has traded has a
 * fill at its own newest block by construction, so every pool is covered; measured,
 * 0 of 17 pools last traded in the legacy pre-`Broadcast` era where no `filler`
 * exists.
 */
export const STABLESWAP_ACCOUNTS_SQL = `-- pub:ds:stableswap-accounts
WITH pools AS (
  SELECT pool_key, max(block_height) AS at_block
  FROM price_data.pool_swap_legs
  WHERE venue = 'stableswap'
  GROUP BY pool_key
)
SELECT toUInt32(JSONExtractUInt(args_json, 'fillerType', 'value')) AS pool_id,
       argMax(JSONExtractString(args_json, 'filler'), (block_height, event_index)) AS pool_account
FROM price_data.raw_events
WHERE block_height IN (SELECT at_block FROM pools)
  AND event_name IN ('Broadcast.Swapped', 'Broadcast.Swapped2', 'Broadcast.Swapped3')
  AND JSONExtractString(args_json, 'fillerType', '__kind') = 'Stableswap'
GROUP BY pool_id`

const POOL_ACCOUNT_RE = /^0x[0-9a-f]{64}$/
const CONTRACT_RE = /^0x[0-9a-f]{40}$/
const DECIMAL_RE = /^\d+$/

/**
 * The identifier maps have a failure mode that is invisible in the response: an
 * entity whose canonical form cannot be derived silently falls back to its numeric
 * id, and a pair id that changes shape reads to an aggregator as a NEW pair rather
 * than as an error — so its price history restarts instead of a request failing.
 *
 * Two guards, both silent while everything resolves:
 *
 *  * every entity the source says exists but whose form could not be read is named
 *    in a throttled warning (the read is behind a 300 s cache, but a warn per miss
 *    per refresh would still be one line every five minutes forever);
 *  * a read that returns entities and resolves NONE of them throws, so `cached`
 *    stores nothing and the next request retries. Caching an empty map would re-key
 *    every affected pair for a full TTL. An empty SOURCE is different and is
 *    cached normally: a database with no ERC-20 asset and no stableswap pool has an
 *    empty map correctly.
 */
const warnedForms = new Map<string, number>()

function resolvedOrThrow<T>(kind: string, total: number, resolved: Map<T, string>, missing: T[]): void {
  if (missing.length) {
    const now = Date.now()
    const key = `${kind}:${missing.join(',')}`
    if (now - (warnedForms.get(key) ?? 0) >= WARN_INTERVAL_MS) {
      warnedForms.set(key, now)
      console.warn(`[public-api] dexscreener: ${missing.length} of ${total} ${kind} have no derivable `
        + `canonical form (${missing.join(', ')}) — their pair ids fall back to the numeric id, which an `
        + 'aggregator reads as a new pair')
    }
  }
  if (total > 0 && resolved.size === 0) {
    throw new Error(`[public-api] dexscreener: ${total} ${kind} exist but none resolved to a canonical form; `
      + 'refusing to cache an empty identifier map, which would re-key every affected pair')
  }
}

export function pairIdForms(client: ClickHouseClient): Promise<PairIdForms> {
  return cached('pub:ds:pair-id-forms', 300_000, async () => {
    const [erc20Res, poolRes] = await Promise.all([
      client.query({ query: ERC20_CONTRACTS_SQL, format: 'JSONEachRow' }),
      client.query({ query: STABLESWAP_ACCOUNTS_SQL, format: 'JSONEachRow' }),
    ])
    const contractByAssetId = new Map<number, string>()
    const assetIdByContract = new Map<string, number>()
    const unlocated: number[] = []
    const erc20Rows = await erc20Res.json<{ asset_id: number | string; contract: string }>()
    for (const row of erc20Rows) {
      const assetId = Number(row.asset_id)
      const contract = String(row.contract ?? '').toLowerCase()
      if (!CONTRACT_RE.test(contract)) {
        unlocated.push(assetId)
        continue
      }
      contractByAssetId.set(assetId, contract)
      assetIdByContract.set(contract, assetId)
    }
    resolvedOrThrow('ERC-20 asset(s)', erc20Rows.length, contractByAssetId, unlocated.sort((a, b) => a - b))
    const accountByPoolId = new Map<number, string>()
    const poolIdByAccount = new Map<string, number>()
    const unaccounted: number[] = []
    // The same guard on the same failure shape: a stableswap pool whose `filler`
    // cannot be read falls back to its pool id, which is a different pair id.
    const poolRows = await poolRes.json<{ pool_id: number | string; pool_account: string }>()
    for (const row of poolRows) {
      const poolId = Number(row.pool_id)
      const account = String(row.pool_account ?? '').toLowerCase()
      if (!POOL_ACCOUNT_RE.test(account)) {
        unaccounted.push(poolId)
        continue
      }
      accountByPoolId.set(poolId, account)
      poolIdByAccount.set(account, poolId)
    }
    resolvedOrThrow('stableswap pool(s)', poolRows.length, accountByPoolId, unaccounted.sort((a, b) => a - b))
    return { contractByAssetId, assetIdByContract, accountByPoolId, poolIdByAccount }
  })
}

/** The wire form of an asset id: its ERC-20 contract when it has one, else the decimal registry id. */
export function wireAssetId(forms: PairIdForms, assetId: number): string {
  return forms.contractByAssetId.get(assetId) ?? String(assetId)
}

/**
 * The registry id a request's asset reference names, or null when it names a
 * contract this chain does not carry. Both forms are accepted, though only the
 * contract form is what `/events` publishes for an ERC-20 asset — the previous
 * adapter 500s on the registry id, so accepting it is a strict superset.
 */
export function resolveAssetRef(forms: PairIdForms, ref: string): number | null {
  const token = (ref ?? '').trim()
  if (DECIMAL_RE.test(token)) {
    const assetId = Number(token)
    return Number.isSafeInteger(assetId) && assetId <= MAX_ASSET_ID ? assetId : null
  }
  const lower = token.toLowerCase()
  return CONTRACT_RE.test(lower) ? forms.assetIdByContract.get(lower) ?? null : null
}

/**
 * The pair's two sides in the order the id names them.
 *
 * Sorted by the id's own VALUE read as an integer: a registry id is its own
 * number, a contract address its 160-bit value — so every plain registry id sorts
 * before every contract, which is what the previous adapter's ordering does. It is
 * NOT lexicographic over the id strings ("0x11a8…" would then sort before "4200",
 * and it does not) and it is NOT numeric over the registry ids either (aUSDC's
 * 1003 sorts before HOLLAR's 222 because `0x2ec4…` < `0x531a…`).
 *
 * The ordering is load-bearing, not cosmetic: it decides which side is asset0, and
 * therefore whether `priceNative` is a price or its reciprocal. Reproduced against
 * the previous adapter on all 24 pairs of a live 400-block window, including the
 * three whose sides it swaps relative to a numeric-by-registry-id sort.
 *
 * The class flag comes first explicitly rather than relying on a contract's value
 * exceeding a u32: a location that happened to name a low address would otherwise
 * change a pair's orientation.
 */
function sideSortKey(forms: PairIdForms, assetId: number): [number, bigint] {
  const contract = forms.contractByAssetId.get(assetId)
  return contract ? [1, BigInt(contract)] : [0, BigInt(assetId)]
}

export function orderPairSides(forms: PairIdForms, a: number, b: number): [number, number] {
  const [ka, kb] = [sideSortKey(forms, a), sideSortKey(forms, b)]
  const aFirst = ka[0] !== kb[0] ? ka[0] < kb[0] : ka[1] <= kb[1]
  return aFirst ? [a, b] : [b, a]
}

/**
 * A pair's id, in the previous adapter's scheme so DexScreener's existing history
 * keys carry over. Three venue shapes, each verified byte-for-byte against that
 * adapter's live responses:
 *
 *  * XYK — the pool ACCOUNT alone. An XYK pool has exactly one registered pair, so
 *    the assets carry no information the account does not.
 *  * Omnipool — `<omnipool pallet account>-<asset0>-<asset1>`. Every asset trades
 *    against the LRNA hub and only against it.
 *  * Stableswap — `<pool account>-<asset0>-<asset1>`, the pool's on-chain account
 *    rather than its pool id. A pool whose account is not derivable falls back to
 *    the pool id, which keeps the id well-formed and unique rather than dropping
 *    the pair; measured, 17 of 17 pools resolve.
 *
 * The sides are ordered by `orderPairSides`, so one pair has exactly one id
 * whichever way a fill traded it.
 */
export function pairId(forms: PairIdForms, venue: DexVenue, poolKey: string, a: number, b: number): string {
  if (venue === 'xyk') return poolKey
  const [asset0, asset1] = orderPairSides(forms, a, b)
  const pool = venue === 'omnipool' ? OMNIPOOL_ACCOUNT : forms.accountByPoolId.get(Number(poolKey)) ?? poolKey
  return `${pool}-${wireAssetId(forms, asset0)}-${wireAssetId(forms, asset1)}`
}

/** A pair id's syntax, before anything is resolved against the pools that exist. */
export interface PairIdShape {
  /** The pool component: a 32-byte account, or a decimal stableswap pool id. */
  pool: string
  /** The asset components in the id's own order, empty for the bare XYK form. */
  assets: string[]
}

/**
 * A pair id's SHAPE, which is the caller-error test: a malformed id is a 400 while
 * a well-formed id naming a pool that does not hold the pair is a 404, and the two
 * must not collapse or a consumer cannot tell a broken cursor from a delisted pair.
 * Resolution — which venue, which assets — needs the indexed forms and happens in
 * `dexScreenerPair`.
 *
 * Two legacy shapes are accepted beyond what `/events` publishes, because accepting
 * more input than you emit costs nothing: a stableswap pool named by its decimal
 * pool id, and an XYK pool named with its assets appended. The response always
 * reports the canonical id, so a consumer that follows it converges.
 */
export function parsePairIdShape(id: string): PairIdShape | null {
  const parts = (id ?? '').trim().toLowerCase().split('-')
  const [pool, ...assets] = parts
  const poolOk = POOL_ACCOUNT_RE.test(pool) || DECIMAL_RE.test(pool)
  if (!poolOk) return null
  // A bare pool id is only the XYK form, which is an account. A decimal alone
  // names no pair.
  if (assets.length === 0) return POOL_ACCOUNT_RE.test(pool) ? { pool, assets } : null
  if (assets.length !== 2) return null
  if (!assets.every(token => DECIMAL_RE.test(token) || CONTRACT_RE.test(token))) return null
  if (assets[0] === assets[1]) return null
  return { pool, assets }
}

// ---------------------------------------------------------------------------
// latest-block
// ---------------------------------------------------------------------------

export interface DexScreenerBlock {
  blockNumber: number
  blockTimestamp: number
}

/**
 * The indexed head, from the same source /v1/status reports (`price_data.blocks`),
 * so the two surfaces never disagree about how far this API has read. DexScreener
 * only asks for windows below this height, so publishing the raw pipeline's
 * checkpoint instead would make it skip blocks the read models have not projected.
 */
export async function latestBlock(client: ClickHouseClient): Promise<DexScreenerBlock> {
  const status = await publicStatus(client)
  return {
    blockNumber: status.blockHeight,
    blockTimestamp: Math.floor(Date.parse(status.blockTimestamp) / 1000),
  }
}

// ---------------------------------------------------------------------------
// asset
// ---------------------------------------------------------------------------

export interface DexScreenerAsset {
  id: string
  name: string
  symbol: string
  metadata: { decimals: string }
}

/**
 * A registry asset in the adapter's shape.
 *
 * Four optional spec fields are absent because nothing indexed here can produce
 * them honestly, and a plausible guess in a market-data feed is worse than a gap:
 *
 *  * `totalSupply` / `circulatingSupply` — there is no per-asset issuance model in
 *    this database. Summing balances would miss aToken and share-token custody
 *    (see the account surfaces' three-source composition) and would be a
 *    whole-table scan per request besides.
 *  * `coinGeckoId` / `coinMarketCapId` — external catalogue identifiers, not chain
 *    state; the registry does not carry them.
 *  * `metadata.assetType` — `price_data.assets` has no asset-type column, and
 *    inferring Token/External/Erc20/StableSwap/Bond from decimals or id ranges
 *    would be a guess presented as registry state.
 *
 * `assetDescriptor` is deliberately not used: it synthesises an entry for an
 * unknown id, and this endpoint must 404 instead of inventing a token.
 *
 * `id` is the CANONICAL wire form — the contract address for an ERC-20 asset —
 * whichever form the request named the asset by, so the id a consumer reads back is
 * always the one `/events` and `/pair` publish.
 */
export function dexScreenerAsset(assetId: number, forms: PairIdForms): DexScreenerAsset | null {
  const asset = allExplorerAssets().find(a => a.assetId === assetId)
  if (!asset) return null
  return {
    id: wireAssetId(forms, asset.assetId),
    // The registry stores `name` as null when it equals the symbol; the adapter
    // spec requires a name, so the symbol stands in rather than an empty string.
    name: asset.name ?? asset.symbol,
    symbol: asset.symbol,
    metadata: { decimals: String(asset.decimals) },
  }
}

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

export interface DexScreenerPair {
  id: string
  dexKey: typeof DEX_KEY
  asset0Id: string
  asset1Id: string
}

interface PoolUniverse {
  /** Assets the Omnipool has ever held. Each pairs against the hub, and only against it. */
  omnipoolAssets: Set<number>
  /** Stableswap pool id → its underlying assets. The pool's own share token pairs against each of them too. */
  stableswapPools: Map<number, number[]>
}

const OMNIPOOL_ASSETS_SQL = `-- pub:ds:omnipool-assets
SELECT DISTINCT toUInt32(asset_id) AS asset_id
FROM price_data.omnipool_pool_state_history
WHERE asset_id >= 0`

const STABLESWAP_POOLS_SQL = `-- pub:ds:stableswap-pools
SELECT pool_id, argMax(asset_ids, block_height) AS asset_ids
FROM price_data.stableswap_pool_state_history
GROUP BY pool_id`

/**
 * Which pools exist and which assets they hold, so `pair` can answer 404 for a
 * well-formed id nobody trades instead of echoing whatever it was handed.
 *
 * Both reads are small (17 stableswap pools, ~50 Omnipool assets) and shared by
 * every caller through one cache entry, so pair resolution costs no per-request
 * query in steady state.
 */
export function poolUniverse(client: ClickHouseClient): Promise<PoolUniverse> {
  return cached('pub:ds:pool-universe', 300_000, async () => {
    const [omniRes, stableRes] = await Promise.all([
      client.query({ query: OMNIPOOL_ASSETS_SQL, format: 'JSONEachRow' }),
      client.query({ query: STABLESWAP_POOLS_SQL, format: 'JSONEachRow' }),
    ])
    const omnipoolAssets = new Set((await omniRes.json<{ asset_id: number | string }>()).map(r => Number(r.asset_id)))
    const stableswapPools = new Map<number, number[]>()
    for (const row of await stableRes.json<{ pool_id: number | string; asset_ids: Array<number | string> }>()) {
      stableswapPools.set(Number(row.pool_id), (row.asset_ids ?? []).map(Number))
    }
    return { omnipoolAssets, stableswapPools }
  })
}

/**
 * Resolves a pair id against the pools that actually exist, per venue:
 *
 *  * Omnipool — every asset trades against the hub and only against the hub, so
 *    one side must be LRNA and the other an Omnipool asset. A direct A→B swap is
 *    two fills (A→hub, hub→B) on two pairs, which is also why per-pair volume here
 *    is not double-counted.
 *  * Stableswap — a side is either one of the pool's underlying assets or the
 *    pool's own share token (asset id = pool id). 29% of stableswap fills trade the
 *    share token, because the Omnipool holds shares and a route reaches an
 *    underlying by withdrawing from the pool in one asset.
 *  * XYK — the pool account's registered pair, newest incarnation (a destroyed
 *    account can be recreated with a different pair).
 *
 * The pool component names the venue: the Omnipool pallet account is a literal, a
 * known stableswap pool account (or a bare decimal pool id, the legacy form) is
 * stableswap, any other 32-byte account is an XYK pool. Stableswap and XYK pool
 * components are both accounts now, so the two are told apart by the indexed pool
 * sets rather than by shape.
 *
 * `createdAt*`, `creator`, `feeBps` and `pool` are optional spec fields left
 * unserved: pool creation is not projected into a per-pair model, the Omnipool's
 * fee is a dynamic per-asset value rather than a constant, and a pool's full pair
 * list would need a scan of every fill it has ever hosted.
 */
export async function dexScreenerPair(client: ClickHouseClient, id: string): Promise<DexScreenerPair | null> {
  const shape = parsePairIdShape(id)
  if (!shape) return null
  const [forms, xyk] = await Promise.all([pairIdForms(client), xykPoolMeta(client)])
  const { poolIdByAccount } = forms

  const venue: DexVenue | null = shape.pool === OMNIPOOL_ACCOUNT ? 'omnipool'
    : poolIdByAccount.has(shape.pool) || DECIMAL_RE.test(shape.pool) ? 'stableswap'
      : xyk.has(shape.pool) ? 'xyk'
        : null
  if (!venue) return null
  const poolKey = venue === 'stableswap'
    ? String(poolIdByAccount.get(shape.pool) ?? Number(shape.pool))
    : shape.pool

  // An XYK pair id carries no assets — the pool has exactly one registered pair,
  // which is where they come from. Any other venue must name both.
  let sides: [number, number] | null = null
  if (shape.assets.length === 2) {
    const resolved = shape.assets.map(token => resolveAssetRef(forms, token))
    if (resolved.some(assetId => assetId == null)) return null
    sides = [resolved[0] as number, resolved[1] as number]
  } else {
    const meta = xyk.get(shape.pool)
    if (meta?.assetA == null || meta.assetB == null) return null
    sides = [Number(meta.assetA), Number(meta.assetB)]
  }

  const [asset0Id, asset1Id] = orderPairSides(forms, sides[0], sides[1])
  // Kept consistent with `/dexscreener/asset` and with the event stream: an XYK
  // pool can be registered against an asset the registry does not carry, and
  // answering 200 here for a pair whose asset would 404 there — and which never
  // appears in `/events` — would hand a consumer a pair it cannot resolve.
  if (!assetResolvable(asset0Id) || !assetResolvable(asset1Id)) return null
  const known = await holdsPair(client, venue, poolKey, asset0Id, asset1Id)
  if (!known) return null
  // The CANONICAL id, not the requested one: a consumer that follows the id it
  // reads back converges on the form `/events` publishes, whichever legacy shape it
  // asked with.
  return {
    id: pairId(forms, venue, poolKey, asset0Id, asset1Id),
    dexKey: DEX_KEY,
    asset0Id: wireAssetId(forms, asset0Id),
    asset1Id: wireAssetId(forms, asset1Id),
  }
}

async function holdsPair(client: ClickHouseClient, venue: DexVenue, poolId: string, a0: number, a1: number): Promise<boolean> {
  if (venue === 'omnipool') {
    const { omnipoolAssets } = await poolUniverse(client)
    if (a0 !== HUB_ASSET_ID && a1 !== HUB_ASSET_ID) return false
    const other = a0 === HUB_ASSET_ID ? a1 : a0
    return omnipoolAssets.has(other)
  }
  if (venue === 'stableswap') {
    const { stableswapPools } = await poolUniverse(client)
    const pool = Number(poolId)
    const assets = stableswapPools.get(pool)
    if (!assets) return false
    const member = (id: number) => id === pool || assets.includes(id)
    return member(a0) && member(a1)
  }
  const meta = (await xykPoolMeta(client)).get(poolId)
  if (!meta) return false
  const registered = [meta.assetA, meta.assetB].map(v => (v == null ? null : Number(v)))
  return registered.includes(a0) && registered.includes(a1)
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export interface DexScreenerSwapEvent {
  block: DexScreenerBlock
  eventType: 'swap'
  txnId: string
  txnIndex: number
  eventIndex: number
  maker: string
  pairId: string
  priceNative: string
  asset0In?: string
  asset1In?: string
  asset0Out?: string
  asset1Out?: string
  reserves?: { asset0: string; asset1: string }
}

/**
 * The `join`/`exit` event types of the adapter spec are NOT served. A join or
 * exit event requires `amount0` AND `amount1` — both sides of the pair — and the
 * blocker is THIS INDEX's projection, not the chain. Two different causes, and
 * only the second is inherent (raw args inspected at blocks > 13,400,000):
 *
 *  * A PROJECTION gap, recoverable without any chain work. The chain carries both
 *    sides and `liquidity_activity`'s column list drops them:
 *    `Stableswap.LiquidityAdded` emits `assets:[{assetId,amount}]` and
 *    `Stableswap.LiquidityRemoved` emits `amounts:[{assetId,amount}]` — the whole
 *    per-asset array — but the MV in clickhouse/schema/003_materialized_views.sql
 *    projects a single scalar `amount`, so the array is lost at insert time.
 *    `XYK.LiquidityAdded` emits BOTH `amountA` and `amountB`; the MV keeps only
 *    `amount_a`.
 *  * A genuine SOURCE gap, where the event itself never carries a side:
 *    `Omnipool.LiquidityAdded` names only the asset amount (the hub side is minted
 *    internally), `Omnipool.LiquidityRemoved` names `sharesRemoved` and a fee but
 *    no asset amount at all, and `XYK.LiquidityRemoved` names only `shares`.
 *
 * So stableswap and XYK joins become servable by widening the projection —
 * schema work, deliberately out of this task's scope — while the Omnipool's and
 * XYK exits would additionally need share-to-amount reconstruction. Serving any
 * of it means extending the projection first, never halving a total here.
 *
 * The previous Hydration adapter reaches the same end state: its own type
 * declaration collapses to `type DexScreenerEvent = DexScreenerSwapEvent`, and a
 * 400-block probe of its live `events` endpoint returned 1,583 events, all swaps.
 */
export type DexScreenerEvent = DexScreenerSwapEvent

interface FillRow {
  pool_key: string
  block_height: number | string
  event_index: number | string
  block_ts: number | string
  swapper: string
  op_key: string
  extrinsic_index: number | string | null
  in_asset: number | string
  in_amount: string
  out_asset: number | string
  out_amount: string
  reserve_block: number | string
}

interface OmnipoolFillRow extends FillRow { reserve_raw: string; hub_reserve_raw: string }
interface StableswapFillRow extends FillRow { asset_ids: Array<number | string>; reserves_raw: string[]; total_issuance_raw: string }
interface XykFillRow extends FillRow { asset_a: number | string; asset_b: number | string; reserve_a_raw: string; reserve_b_raw: string }

/**
 * One row per swap FILL of a venue, folded from its legs.
 *
 * `pool_swap_legs` is ReplacingMergeTree(ingested_at), so re-indexing a block
 * inserts a second copy of every leg. The inner GROUP BY is the table's own
 * ORDER BY with the venue the WHERE already fixed removed — the replacement key —
 * collapsed with argMax before a single amount is summed. Folding first and
 * deduplicating later would report a replayed block's fills twice, which for a
 * price feed means a duplicated trade at a duplicated price.
 *
 * The HAVING drops a fill whose in or out side is not exactly one asset. A pair
 * event has one asset per side by definition, and no such fill has ever been
 * observed (every fill measured over 100k blocks has exactly two distinct
 * in/out assets); dropping one is how an unexpected shape stays out of the feed
 * instead of being reported with an arbitrarily chosen side.
 */
function fillsCteSql(venue: DexVenue): string {
  return `legs AS (
    SELECT pool_key, block_height, event_index, leg_kind, leg_index,
           argMax(asset_id, ingested_at) AS asset_id,
           argMax(amount, ingested_at) AS amount,
           argMax(swapper, ingested_at) AS swapper,
           argMax(op_key, ingested_at) AS op_key,
           argMax(extrinsic_index, ingested_at) AS extrinsic_index,
           min(block_timestamp) AS block_time
    FROM price_data.pool_swap_legs
    WHERE venue = '${venue}'
      AND block_height >= {fromBlock:UInt32} AND block_height <= {toBlock:UInt32}
      AND leg_kind IN ('in', 'out')
    GROUP BY pool_key, block_height, event_index, leg_kind, leg_index
  ),
  fills AS (
    SELECT pool_key, block_height, event_index,
           any(swapper) AS swapper,
           any(op_key) AS op_key,
           any(extrinsic_index) AS extrinsic_index,
           toUInt32(toUnixTimestamp(min(block_time))) AS block_ts,
           anyIf(asset_id, leg_kind = 'in') AS in_asset,
           toString(sumIf(toUInt256(amount), leg_kind = 'in')) AS in_amount,
           anyIf(asset_id, leg_kind = 'out') AS out_asset,
           toString(sumIf(toUInt256(amount), leg_kind = 'out')) AS out_amount
    FROM legs
    GROUP BY pool_key, block_height, event_index
    HAVING uniqExactIf(asset_id, leg_kind = 'in') = 1 AND uniqExactIf(asset_id, leg_kind = 'out') = 1
  )`
}

/**
 * Reserves at the fill's block, as an ASOF join onto the venue's 600-block state
 * grid. The history scan is bounded BELOW by `reserveFrom` (the request's own
 * range less one staleness window), which is what keeps the join a bounded read
 * and, for a delisted asset whose final row sits far below the window, produces
 * no match at all rather than a year-old sample.
 *
 * Each history table is a ReplacingMergeTree too, so its rows are collapsed on
 * (key, block_height) with argMax before the join, exactly as the leg scan is.
 * `reserve_block = 0` means the ASOF found nothing; the reader treats that and an
 * over-stale sample identically, by omitting `reserves`.
 */
const OMNIPOOL_EVENTS_SQL = `-- pub:ds:events:omnipool
WITH ${fillsCteSql('omnipool')},
hub_fills AS (
  SELECT *, if(in_asset = ${HUB_ASSET_ID}, out_asset, in_asset) AS other_asset
  FROM fills
  WHERE in_asset = ${HUB_ASSET_ID} OR out_asset = ${HUB_ASSET_ID}
)
SELECT f.pool_key AS pool_key, f.block_height AS block_height, f.event_index AS event_index,
       f.block_ts AS block_ts, f.swapper AS swapper, f.op_key AS op_key,
       f.extrinsic_index AS extrinsic_index,
       f.in_asset AS in_asset, f.in_amount AS in_amount,
       f.out_asset AS out_asset, f.out_amount AS out_amount,
       h.block_height AS reserve_block, h.reserve_raw AS reserve_raw, h.hub_reserve_raw AS hub_reserve_raw
FROM hub_fills f
ASOF LEFT JOIN (
  SELECT toUInt32(asset_id) AS asset_id, block_height,
         argMax(reserve_raw, ingested_at) AS reserve_raw,
         argMax(hub_reserve_raw, ingested_at) AS hub_reserve_raw
  FROM price_data.omnipool_pool_state_history
  WHERE asset_id >= 0
    AND block_height >= {reserveFrom:UInt32} AND block_height <= {toBlock:UInt32}
  GROUP BY asset_id, block_height
) h ON h.asset_id = f.other_asset AND h.block_height <= f.block_height
ORDER BY f.block_height, f.event_index
LIMIT ${MAX_EVENTS + 1}`

const STABLESWAP_EVENTS_SQL = `-- pub:ds:events:stableswap
WITH ${fillsCteSql('stableswap')}
SELECT f.pool_key AS pool_key, f.block_height AS block_height, f.event_index AS event_index,
       f.block_ts AS block_ts, f.swapper AS swapper, f.op_key AS op_key,
       f.extrinsic_index AS extrinsic_index,
       f.in_asset AS in_asset, f.in_amount AS in_amount,
       f.out_asset AS out_asset, f.out_amount AS out_amount,
       h.block_height AS reserve_block, h.asset_ids AS asset_ids,
       h.reserves_raw AS reserves_raw, h.total_issuance_raw AS total_issuance_raw
FROM fills f
ASOF LEFT JOIN (
  SELECT pool_id, block_height,
         argMax(asset_ids, ingested_at) AS asset_ids,
         argMax(reserves_raw, ingested_at) AS reserves_raw,
         argMax(total_issuance_raw, ingested_at) AS total_issuance_raw
  FROM price_data.stableswap_pool_state_history
  WHERE block_height >= {reserveFrom:UInt32} AND block_height <= {toBlock:UInt32}
  GROUP BY pool_id, block_height
) h ON h.pool_id = toUInt32OrZero(f.pool_key) AND h.block_height <= f.block_height
ORDER BY f.block_height, f.event_index
LIMIT ${MAX_EVENTS + 1}`

const XYK_EVENTS_SQL = `-- pub:ds:events:xyk
WITH ${fillsCteSql('xyk')}
SELECT f.pool_key AS pool_key, f.block_height AS block_height, f.event_index AS event_index,
       f.block_ts AS block_ts, f.swapper AS swapper, f.op_key AS op_key,
       f.extrinsic_index AS extrinsic_index,
       f.in_asset AS in_asset, f.in_amount AS in_amount,
       f.out_asset AS out_asset, f.out_amount AS out_amount,
       h.block_height AS reserve_block, h.asset_a AS asset_a, h.asset_b AS asset_b,
       h.reserve_a_raw AS reserve_a_raw, h.reserve_b_raw AS reserve_b_raw
FROM fills f
ASOF LEFT JOIN (
  SELECT pool_account, block_height,
         argMax(asset_a, ingested_at) AS asset_a,
         argMax(asset_b, ingested_at) AS asset_b,
         argMax(reserve_a_raw, ingested_at) AS reserve_a_raw,
         argMax(reserve_b_raw, ingested_at) AS reserve_b_raw
  FROM price_data.xyk_pool_reserve_history
  WHERE block_height >= {reserveFrom:UInt32} AND block_height <= {toBlock:UInt32}
  GROUP BY pool_account, block_height
) h ON h.pool_account = f.pool_key AND h.block_height <= f.block_height
ORDER BY f.block_height, f.event_index
LIMIT ${MAX_EVENTS + 1}`

/** Thrown for a caller error; the route turns it into the 400 envelope. */
export class DexScreenerRequestError extends Error {
  readonly statusCode = 400
}

/**
 * asset id → its registry decimals, or null when the registry does not carry the
 * asset at all.
 *
 * There is deliberately NO default scale here, unlike `amountUnitSql` in
 * poolVolumes.ts. That path sums USD, where an unpriced asset contributes 0 and a
 * wrong scale is visible as a wrong total; this one publishes a PRICE, where
 * assuming 12 decimals for an 8-decimal token silently misstates it by 10,000x.
 * Callers must treat null as "cannot serve this fill".
 */
const decimalsOf = (() => {
  let snapshot: Map<number, number> | null = null
  let size = 0
  return (assetId: number): number | null => {
    const assets = allExplorerAssets()
    if (!snapshot || assets.length !== size) {
      snapshot = new Map(assets.map(a => [a.assetId, a.decimals]))
      size = assets.length
    }
    return snapshot.get(assetId) ?? null
  }
})()

/** True when the asset registry can resolve the id, so `/dexscreener/asset` would answer 200 for it. */
export function assetResolvable(assetId: number): boolean {
  return decimalsOf(assetId) != null
}

const warnedAssets = new Map<number, number>()
const WARN_INTERVAL_MS = 300_000

/**
 * Names the unresolvable assets whose fills were dropped, at most once per id per
 * five minutes — a cursor-driven consumer re-walks the same window repeatedly, so
 * an unthrottled warning would be one log line per poll for as long as the asset
 * stays unregistered.
 */
function warnSkipped(assetIds: Set<number>): void {
  const now = Date.now()
  const fresh = [...assetIds].filter(id => now - (warnedAssets.get(id) ?? 0) >= WARN_INTERVAL_MS).sort((a, b) => a - b)
  if (!fresh.length) return
  for (const id of fresh) warnedAssets.set(id, now)
  console.warn(`[public-api] dexscreener: skipping fills of ${fresh.length} asset(s) absent from the registry `
    + `(${fresh.join(', ')}) — their decimals are unknown, so their price cannot be computed`)
}

/**
 * The transaction a fill belongs to, in the order Substrate can actually answer
 * it:
 *
 *  1. the extrinsic, when the fill was dispatched by one;
 *  2. the Router operation, when a block hook dispatched it (a DCA execution or a
 *     scheduled route has no extrinsic, but its hops share a router id);
 *  3. the event itself, when neither exists.
 *
 * 68% of Hydration's swap legs have no extrinsic at all (measured over 200k
 * blocks), which is also why `txnIndex` is not the extrinsic index — see
 * `toEvent`.
 */
function txnIdFor(blockHeight: number, eventIndex: number, extrinsicIndex: number | null, opKey: string): string {
  if (extrinsicIndex != null) return `${blockHeight}-${extrinsicIndex}`
  if (opKey) return `${blockHeight}-r${opKey}`
  return `${blockHeight}-e${eventIndex}`
}

/**
 * A fill in the adapter's swap shape.
 *
 * `txnIndex` is fixed at 0 across the whole surface, and `eventIndex` carries the
 * whole order. DexScreener orders a block by (txnIndex, eventIndex), and no
 * per-block transaction index orders Hydration's stream: 68% of fills come from
 * block hooks with no extrinsic, and those hook events sort AFTER the block's
 * extrinsic events (measured: substituting 0 for the missing index puts 11,228 of
 * 178,648 consecutive fills out of order). `eventIndex` is unique and strictly
 * increasing within a block across every phase, so (0, eventIndex) is the true
 * chain order and is total. The real extrinsic, where there is one, is named in
 * `txnId`.
 *
 * This DIFFERS from the previous adapter, deliberately, and the difference is
 * visible to a consumer that sorts rather than reading the stream as emitted. Its
 * `txnIndex` is a per-ROUTE hop counter restarting at 0 inside each `txnId` group
 * (measured: 0..n-1 in 229 of 229 groups), which does not order a block across
 * routes — sorting its own output by (txnIndex, eventIndex) reorders what it
 * emitted in 60 of 100 blocks, and sorting the two feeds that way yields different
 * sequences in the same 60 of 100. Block 13,596,009 is the shape of it: that key
 * gives eventIndex 17, 38, 18, 39 there, interleaving two routes, against the
 * chain's own 17, 18, 38, 39 here. Ours is the correction.
 */
function toEvent(
  row: FillRow,
  venue: DexVenue,
  forms: PairIdForms,
  reserves: { asset0: string; asset1: string } | undefined,
): DexScreenerSwapEvent {
  const blockHeight = Number(row.block_height)
  const eventIndex = Number(row.event_index)
  const inAsset = Number(row.in_asset)
  const outAsset = Number(row.out_asset)
  const [asset0, asset1] = orderPairSides(forms, inAsset, outAsset)
  const inIsAsset0 = inAsset === asset0
  const amount0Raw = inIsAsset0 ? row.in_amount : row.out_amount
  const amount1Raw = inIsAsset0 ? row.out_amount : row.in_amount
  const decimals0 = scaleOf(asset0)
  const decimals1 = scaleOf(asset1)
  const extrinsicIndex = row.extrinsic_index == null ? null : Number(row.extrinsic_index)
  return {
    block: { blockNumber: blockHeight, blockTimestamp: Number(row.block_ts) },
    eventType: 'swap',
    txnId: txnIdFor(blockHeight, eventIndex, extrinsicIndex, row.op_key ?? ''),
    txnIndex: 0,
    eventIndex,
    maker: row.swapper,
    pairId: pairId(forms, venue, row.pool_key, asset0, asset1),
    ...(inIsAsset0
      ? { asset0In: formatUnits(amount0Raw, decimals0), asset1Out: formatUnits(amount1Raw, decimals1) }
      : { asset1In: formatUnits(amount1Raw, decimals1), asset0Out: formatUnits(amount0Raw, decimals0) }),
    priceNative: priceNative(amount0Raw, decimals0, amount1Raw, decimals1),
    ...(reserves ? { reserves } : {}),
  }
}

/**
 * The registry scale of an asset a fill has already been filtered on. Reaching the
 * throw would mean an unresolvable asset got past `servableFill`, so it is an
 * invariant, not a runtime path.
 */
function scaleOf(assetId: number): number {
  const decimals = decimalsOf(assetId)
  if (decimals == null) throw new Error(`asset ${assetId} is not in the registry; its fill should have been skipped`)
  return decimals
}

/** True when the ASOF join found a sample and it is inside the staleness bound. */
function reserveUsable(row: FillRow): boolean {
  const sampled = Number(row.reserve_block)
  if (!sampled) return false
  return Number(row.block_height) - sampled <= RESERVE_MAX_STALE_BLOCKS
}

/**
 * A pair whose reserves are both non-zero, or nothing.
 *
 * A fill proves the pool held both assets at that block, so a 0 on either side is
 * a projection artefact rather than the pool's state — and publishing it would
 * tell DexScreener the pool is empty and its liquidity worthless. The known cause
 * is `xyk_pool_reserve_history`: native HDX lives in `System.Account`, not
 * `Tokens`, so every HDX-quoted XYK pool reads 0 on its HDX side (measured over
 * blocks > 13,500,000: 1,859 of 1,859 rows with `asset_a = 0`, and 2,002 of 2,002
 * with `asset_b = 0`). Fixing the projection is separate schema work; until then
 * the field is omitted rather than wrong. The check is applied to every venue, not
 * just XYK, because a zero reserve under a fill is never right anywhere.
 */
function bothSided(reserves: { asset0: string; asset1: string }): { asset0: string; asset1: string } | undefined {
  const zero = (v: string) => !v || /^0(\.0*)?$/.test(v)
  return zero(reserves.asset0) || zero(reserves.asset1) ? undefined : reserves
}

function pairSides(row: FillRow, forms: PairIdForms): { asset0: number; asset1: number } {
  const [asset0, asset1] = orderPairSides(forms, Number(row.in_asset), Number(row.out_asset))
  return { asset0, asset1 }
}

/**
 * The Omnipool's virtual pair for asset X is (hub_reserve_X, reserve_X) — the two
 * balances its price is actually computed from. Verified against the previous
 * adapter's own responses: those two reserves give a spot price matching the
 * fill's `priceNative` to three significant figures on both cross-checked fills
 * (5.85 vs 5.82, 19.49 vs 19.50), where that adapter's published reserves are
 * inconsistent with its own prices by a factor of 4.
 */
function omnipoolReserves(row: OmnipoolFillRow, forms: PairIdForms): { asset0: string; asset1: string } | undefined {
  if (!reserveUsable(row)) return undefined
  const { asset0, asset1 } = pairSides(row, forms)
  const side = (assetId: number) => (assetId === HUB_ASSET_ID
    ? formatUnits(row.hub_reserve_raw, scaleOf(HUB_ASSET_ID))
    : formatUnits(row.reserve_raw, scaleOf(assetId)))
  return bothSided({ asset0: side(asset0), asset1: side(asset1) })
}

/**
 * A stableswap pool holds its underlying assets, and its share token's supply is
 * the counterparty of every share leg — a pool does not hold its own shares — so
 * the share side's reserve is the pool's total issuance.
 */
function stableswapReserves(row: StableswapFillRow, forms: PairIdForms): { asset0: string; asset1: string } | undefined {
  if (!reserveUsable(row)) return undefined
  const poolId = Number(row.pool_key)
  const ids = (row.asset_ids ?? []).map(Number)
  const { asset0, asset1 } = pairSides(row, forms)
  const side = (assetId: number): string | null => {
    if (assetId === poolId) return formatUnits(row.total_issuance_raw, scaleOf(assetId))
    const index = ids.indexOf(assetId)
    return index < 0 ? null : formatUnits(row.reserves_raw?.[index] ?? '0', scaleOf(assetId))
  }
  const a = side(asset0)
  const b = side(asset1)
  // A pool whose composition changed between the sample and the fill can lack a
  // side; report no reserves rather than one side against a zero.
  return a != null && b != null ? bothSided({ asset0: a, asset1: b }) : undefined
}

function xykReserves(row: XykFillRow, forms: PairIdForms): { asset0: string; asset1: string } | undefined {
  if (!reserveUsable(row)) return undefined
  const { asset0, asset1 } = pairSides(row, forms)
  const byAsset = new Map<number, string>([
    [Number(row.asset_a), row.reserve_a_raw],
    [Number(row.asset_b), row.reserve_b_raw],
  ])
  const a = byAsset.get(asset0)
  const b = byAsset.get(asset1)
  return a != null && b != null
    ? bothSided({ asset0: formatUnits(a, scaleOf(asset0)), asset1: formatUnits(b, scaleOf(asset1)) })
    : undefined
}

/**
 * Every AMM swap in a block range, as DexScreener events ordered by block then
 * event index.
 *
 * Three venue queries rather than one union: each prunes on `pool_swap_legs`'
 * leading `venue` key, each carries the reserve model its own venue needs, and
 * each is independently bounded. Nothing here is cached — the key would be one
 * entry per (fromBlock, toBlock) pair, which is unbounded cardinality for a
 * cursor-driven consumer; the route's `max-age` and the nginx micro-cache collapse
 * repeated polls of the same window instead.
 */
export async function dexScreenerEvents(client: ClickHouseClient, fromBlock: number, toBlock: number): Promise<DexScreenerEvent[]> {
  if (toBlock < fromBlock) {
    throw new DexScreenerRequestError(`toBlock (${toBlock}) must not be below fromBlock (${fromBlock})`)
  }
  if (toBlock - fromBlock + 1 > MAX_BLOCK_SPAN) {
    throw new DexScreenerRequestError(`block range must span at most ${MAX_BLOCK_SPAN} blocks; asked for ${toBlock - fromBlock + 1}`)
  }
  const query_params = { fromBlock, toBlock, reserveFrom: Math.max(0, fromBlock - RESERVE_MAX_STALE_BLOCKS) }
  const run = async <T>(query: string): Promise<T[]> => {
    const res = await client.query({ query, query_params, format: 'JSONEachRow' })
    return res.json<T>()
  }
  const [omnipool, stableswap, xyk, forms] = await Promise.all([
    run<OmnipoolFillRow>(OMNIPOOL_EVENTS_SQL),
    run<StableswapFillRow>(STABLESWAP_EVENTS_SQL),
    run<XykFillRow>(XYK_EVENTS_SQL),
    pairIdForms(client),
  ])
  // A fill touching an asset the registry cannot resolve is DROPPED, not priced
  // on an assumed scale. Chain registration is permissionless, so AssetHub
  // externals reach `pool_swap_legs` before `price_data.assets` carries them
  // (measured over a 10,000-block window: 7 such ids across 39 fills). Without
  // decimals every amount and `priceNative` on that fill would be a guess
  // published as a price, and `/dexscreener/asset` 404s the id anyway — a pair
  // whose asset cannot be looked up is not a pair this API can serve.
  const skipped = new Set<number>()
  const servable = <T extends FillRow>(row: T): boolean => {
    const missing = [Number(row.in_asset), Number(row.out_asset)].filter(id => !assetResolvable(id))
    for (const id of missing) skipped.add(id)
    return missing.length === 0
  }
  const events = [
    ...omnipool.filter(servable).map(row => toEvent(row, 'omnipool', forms, omnipoolReserves(row, forms))),
    ...stableswap.filter(servable).map(row => toEvent(row, 'stableswap', forms, stableswapReserves(row, forms))),
    ...xyk.filter(servable).map(row => toEvent(row, 'xyk', forms, xykReserves(row, forms))),
  ]
  if (skipped.size) warnSkipped(skipped)
  if (events.length > MAX_EVENTS) {
    throw new DexScreenerRequestError(
      `block range holds more than ${MAX_EVENTS} swap events; ask for a narrower range`,
    )
  }
  events.sort((a, b) => a.block.blockNumber - b.block.blockNumber || a.eventIndex - b.eventIndex)
  return events
}
