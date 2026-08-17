import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import { ATOKEN_UNDERLYING_ID, SHARE_TOKEN_UNDERLYING_ID, assetDescriptor } from '../../services/explorerAssets.ts'
import { getPoolsIndex, initPoolService, type PoolListResponse } from '../../services/poolService.ts'
import { tvlUsdString } from './platformStats.ts'
import { DECIMAL_STRINGS, amountUnitSql, legsCteSql, readAnchor, xykPoolMeta } from './poolVolumes.ts'

// The CoinGecko facade: a drop-in replacement for HydraDX-api's
// /coingecko/v1/* endpoints (spec § Phase 2 → "CoinGecko facade"). CoinGecko is
// registered against the OLD service, so the field names, the pair
// canonicalisation and the price/volume definitions below are deliberately the
// old feed's, not this API's /v1 conventions — a base-URL swap must not change
// a single value a consumer already parses.
//
// Four things ARE better than the old feed, and each is called out where it
// happens:
//
//  * Metadata comes from the indexed asset registry, not a ~100-row hardcoded
//    VALUES table that silently dropped every unlisted asset.
//  * `liquidity_in_usd` is real pool depth. The old feed hardcoded it to 0
//    because swap events carry no reserves.
//  * No 503-on-cold. The old tickers route only READ a Redis key a background
//    job pushed, so a cold cache was an outage; this one computes on demand
//    behind stale-while-revalidate.
//  * /totalsupply does no per-request RPC. Every supply below is reconstructed
//    from indexed state.
//
// Numeric fields go out as JSON NUMBERS, field for field as the old feed emits
// them (probed live: `last_price`, `base_volume`, `target_volume`,
// `liquidity_in_usd`, `high` and `low` are all numbers there, while `ticker_id`,
// `base_currency`, `target_currency` and `pool_id` are strings). CoinGecko's own
// DEX ticker spec documents the string form and accepts either, but a consumer's
// parser must survive a base-URL swap unchanged, so the incumbent's types win.
// `numeric()` is where the conversion happens and documents its one caveat.

/** The Omnipool hub asset, published under its product name H2O. */
const HUB_ASSET_ID = 1

/**
 * The money market's venue in `pool_swap_legs`. Its fills are 1:1 deposits and
 * withdrawals, not trades, and the ticker feed excludes them (buildTickersSql).
 */
const WRAP_VENUE = 'aave'

/**
 * Symbols pinned to the TARGET side of a pair, most-pinned first; every other
 * pair is ordered by ASCII symbol. This is the old feed's rule verbatim, and it
 * is what makes a ticker id stable across the two directions of one market —
 * H2O is the Omnipool's hub, so nearly every Omnipool ticker is `X_H2O`.
 */
export const TARGET_PRIORITY_SYMBOLS = ['H2O', 'GDOT', 'GETH'] as const

/**
 * Branded product tokens that must keep their OWN symbol even though the wrapper
 * maps below would resolve them to something else: GIGAHDX is the gigahdx
 * market's aToken over stHDX and BIL's underlying uBIL never trades, so naming
 * either pair after the underlying would name a token nobody quotes. Same set,
 * same reason, as OWN_ICON_ASSET_IDS in explorerAssets.ts.
 */
const SELF_SYMBOL_ASSET_IDS = new Set([67, 55])

/** Quantities and prices are carried at this many decimal places end to end. */
const QTY_SCALE = 18
const QTY_UNIT = 10n ** BigInt(QTY_SCALE)

/** Rolling window the feed reports, in hours. CoinGecko's spec fixes it at 24h. */
const WINDOW_HOURS = 24

// ---------------------------------------------------------------------------
// Decimal helpers
// ---------------------------------------------------------------------------

/**
 * A decimal string as an integer count of 10^-scale. Prices and token
 * quantities span far more than a double's 15 significant digits (a 6-decimal
 * stable trading against an 18-decimal token puts 24 digits on one side), so
 * every value on this surface stays an exact integer until it is rendered.
 */
function scaledDecimal(value: string | number | null | undefined, scale: number): bigint {
  const input = String(value ?? '').trim()
  if (!input) return 0n
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(input)
  if (!match) throw new RangeError(`not a decimal value: ${input}`)
  const fraction = (match[3] ?? '').slice(0, scale).padEnd(scale, '0')
  const magnitude = BigInt(`${match[2] || '0'}${fraction}`)
  return match[1] === '-' ? -magnitude : magnitude
}

/** An integer count of 10^-scale as a plain decimal string, trailing zeros dropped. */
function renderDecimal(value: bigint, scale: number): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const unit = 10n ** BigInt(scale)
  const whole = (magnitude / unit).toString()
  const fraction = (magnitude % unit).toString().padStart(scale, '0').replace(/0+$/, '')
  const rendered = fraction ? `${whole}.${fraction}` : whole
  return negative && magnitude > 0n ? `-${rendered}` : rendered
}

/**
 * A raw on-chain amount as whole tokens — the shape /totalsupply publishes, and
 * the same one the old endpoint's RPC read produced.
 */
export function formatUnits(raw: string, decimals: number): string {
  const digits = String(raw ?? '').trim().replace(/^\+/, '')
  if (!/^-?\d+$/.test(digits)) throw new RangeError(`not an integer amount: ${raw}`)
  return renderDecimal(BigInt(digits), decimals)
}

/** A ClickHouse Decimal column's fixed-scale text as a plain decimal string. */
export function trimDecimal(value: string): string {
  return renderDecimal(scaledDecimal(value, QTY_SCALE), QTY_SCALE)
}

/**
 * 1/price at full scale. A pair's price is computed once, in the SQL, as
 * low-asset-per-high-asset; whichever side canonicalisation makes the base then
 * reads it directly or reads its reciprocal. Half-up rounding on the last digit
 * keeps `invert(invert(x))` from drifting downwards.
 */
export function invertRatio(value: string): string {
  const scaled = scaledDecimal(value, QTY_SCALE)
  if (scaled === 0n) return '0'
  return renderDecimal((QTY_UNIT * QTY_UNIT + scaled / 2n) / scaled, QTY_SCALE)
}

// ---------------------------------------------------------------------------
// Registry-driven pair metadata
// ---------------------------------------------------------------------------

/**
 * The registry's own symbol for an asset, or null when it carries no entry.
 *
 * The absence test is assetDescriptor's own synthetic fallback (`#<id>`, the
 * shape it returns for an id the registry has never seen) rather than a set of
 * registered ids: the descriptor is a map lookup, while materialising the id set
 * would rebuild it for every one of the thousands of symbol lookups a rebuild
 * makes.
 */
export function registrySymbol(assetId: number): string | null {
  const symbol = assetDescriptor(assetId).symbol
  return symbol === `#${assetId}` ? null : symbol
}

/**
 * The symbol a ticker names an asset by: the registry symbol of the asset it
 * WRAPS, so aUSDT quotes as USDT and 2-Pool-GDOT as GDOT. This is the
 * registry-driven replacement for the old feed's hand-maintained symbol
 * remapping (aToken → reserve, GDOT-Stbl/GETH-Stbl → underlying), which had to
 * be PR'd for every listing.
 *
 * Deliberately NOT priceAssetId: that map also folds duplicate listings onto the
 * canonical priced asset (stHDX → HDX, EURC.s → EURC), which is right for
 * valuing a leg and wrong for naming a market — it would publish trades in one
 * token under another token's ticker.
 *
 * null means the asset has no registry entry at all (external XCM assets are
 * registered on chain with no symbol). The feed drops those pairs rather than
 * inventing a currency code for them.
 */
export function tickerSymbol(assetId: number): string | null {
  const own = registrySymbol(assetId)
  if (own == null) return null
  let id = assetId
  // Bounded like priceAssetId's hop limit: a share token over an aToken is two
  // hops, and the bound is what makes a mis-entered cycle terminate.
  for (let hop = 0; hop < 3; hop++) {
    if (SELF_SYMBOL_ASSET_IDS.has(id)) break
    const next = ATOKEN_UNDERLYING_ID[id] ?? SHARE_TOKEN_UNDERLYING_ID[id]
    if (next == null || next === id) break
    id = next
  }
  return registrySymbol(id) ?? own
}

/**
 * A pool's share token keeps its OWN registry symbol when the symbol it would
 * otherwise alias to is also claimed, in that same pool, by a different asset.
 *
 * Without this, a pool that trades both an underlying and its own share token emits
 * two rows under one `(ticker_id, pool_id)` key, and they are not the same market.
 * Measured on stableswap pool 146, which holds apyUSD (46) and HOLLAR (222) and also
 * trades its own 2-Pool-apyUSD share (146): `HOLLAR_apyUSD` appeared TWICE, at
 * `last_price` 1.3446656914114112 for the underlying pair (61 fills in the window)
 * and 0.9854862136771687 for the share pair (3 fills) — 36% apart, which is what
 * proves they were never one market. A share is a claim on the whole pool, so its
 * price against HOLLAR is its own; labelling it as the underlying is the same
 * mislabelling the incumbent feed made with its aToken pairs (`DOT_vDOT`), and it
 * makes the aggregator's row key ambiguous rather than merely imprecise.
 *
 * The renamed row's ORIENTATION also flips, because canonicalisation orders by ASCII
 * symbol and '2' precedes 'H': the share row publishes `2-Pool-apyUSD_HOLLAR` at the
 * reciprocal 1.0147275386721805. That is not a value change to an existing series —
 * the ticker id is new, so there is no history for it to contradict.
 *
 * SCOPED to a real collision rather than applied to every share token, and the
 * scope was decided by measurement, not taste: over the live 24-hour window the
 * collision-scoped rule changes exactly ONE published `ticker_id` (pool 146's) while
 * renaming every share token unconditionally changes ELEVEN, including `DOT_GDOT`
 * and `ETH_GETH` — the two tickers whose redefinition has already been adjudicated
 * and announced. `2-Pool-GDOT` against DOT is unambiguous as `DOT_GDOT` because
 * nothing else in pool 690 is named GDOT; pool 146 is the case that is genuinely
 * ambiguous.
 *
 * The key is (venue, pool, aliased symbol) → the distinct assets that symbol would
 * name in that pool. DISTINCT assets is the test: a share token appearing in several
 * pairs of its own pool is one asset many times over and is not a collision.
 */
export function aliasOwnersByPool(rows: TickerRow[]): Map<string, Set<number>> {
  const owners = new Map<string, Set<number>>()
  for (const row of rows) {
    for (const assetId of [Number(row.low_asset_id), Number(row.high_asset_id)]) {
      const symbol = tickerSymbol(assetId)
      if (symbol == null) continue
      const key = aliasKey(row, symbol)
      const claimed = owners.get(key)
      if (claimed) claimed.add(assetId)
      else owners.set(key, new Set([assetId]))
    }
  }
  return owners
}

// NUL joins the three parts because it cannot occur in a venue name, a pool key or a
// registry symbol. A printable separator could, and two keys running together would
// silently merge two pools' symbol ownership — which would either miss a real
// collision or invent one.
const aliasKey = (row: TickerRow, symbol: string): string =>
  `${row.venue}\u0000${row.pool_key}\u0000${symbol}`

/** The symbol a ticker names one side by, in the context of the pool it traded in. */
export function pooledTickerSymbol(row: TickerRow, assetId: number, owners: Map<string, Set<number>>): string | null {
  const aliased = tickerSymbol(assetId)
  if (aliased == null) return null
  if (SHARE_TOKEN_UNDERLYING_ID[assetId] == null) return aliased
  const claimed = owners.get(aliasKey(row, aliased))
  return (claimed?.size ?? 1) > 1 ? registrySymbol(assetId) ?? aliased : aliased
}

export interface PairSide { assetId: number; symbol: string }

/**
 * Which side of the pair is the base and which the target. Returns null when the
 * two sides carry the same symbol: that is a wrap or a rebalance between two
 * registry entries of one token, not a market, and `USDC_USDC` is not a ticker.
 */
export function orientPair(a: PairSide, b: PairSide): { base: PairSide; target: PairSide } | null {
  if (a.symbol === b.symbol) return null
  const rank = (side: PairSide): number => {
    const at = TARGET_PRIORITY_SYMBOLS.indexOf(side.symbol as typeof TARGET_PRIORITY_SYMBOLS[number])
    return at === -1 ? TARGET_PRIORITY_SYMBOLS.length : at
  }
  const [ra, rb] = [rank(a), rank(b)]
  if (ra !== rb) return ra < rb ? { base: b, target: a } : { base: a, target: b }
  return a.symbol < b.symbol ? { base: a, target: b } : { base: b, target: a }
}

/**
 * The two sides of a pair, named. The normalised symbols come first; when they
 * collide the RAW registry symbols are tried, which is what keeps a real market
 * between two registry entries of one token (the 3-Pool's aUSDT/USDT leg)
 * distinguishable instead of dropping it the way the old feed dropped every
 * same-symbol pair.
 *
 * `owners` scopes the naming to the pool: a share token whose aliased symbol is also
 * claimed by a different asset of the SAME pool keeps its own symbol, which is what
 * makes `(ticker_id, pool_id)` unique (see `aliasOwnersByPool`). That collision is
 * across two ROWS, so the same-symbol fallback above cannot see it — it fires only
 * when the two sides of one pair collide.
 */
function namePair(row: TickerRow, lowId: number, highId: number, owners: Map<string, Set<number>>): { base: PairSide; target: PairSide } | null {
  const lowSymbol = pooledTickerSymbol(row, lowId, owners)
  const highSymbol = pooledTickerSymbol(row, highId, owners)
  if (lowSymbol == null || highSymbol == null) return null
  const normalised = orientPair({ assetId: lowId, symbol: lowSymbol }, { assetId: highId, symbol: highSymbol })
  if (normalised) return normalised
  const lowRaw = registrySymbol(lowId)
  const highRaw = registrySymbol(highId)
  if (lowRaw == null || highRaw == null) return null
  return orientPair({ assetId: lowId, symbol: lowRaw }, { assetId: highId, symbol: highRaw })
}

// ---------------------------------------------------------------------------
// Tickers
// ---------------------------------------------------------------------------

/**
 * One CoinGecko DEX ticker. Field names, field order AND field types are the old
 * feed's, verbatim — the six quantitative fields are JSON numbers there and here.
 */
export interface CoinGeckoTicker {
  ticker_id: string
  base_currency: string
  target_currency: string
  last_price: number
  base_volume: number
  target_volume: number
  pool_id: string
  liquidity_in_usd: number
  high: number
  low: number
}

/**
 * A field this feed publishes as a JSON number, converted from the exact decimal
 * string every computation behind it produced.
 *
 * The whole pipeline stays exact — quantities and prices are integer counts of
 * 10^-18 through the SQL, the ratio inversion and the rendering — and the single
 * float step is here, at the wire, because that is the incumbent's type and a
 * consumer's parser has to survive a base-URL swap unchanged.
 *
 * CAVEAT, and it is the reason this conversion is one named function rather than a
 * `Number()` sprinkled at six call sites: a double carries ~15–17 significant
 * decimal digits, so a value needing more is rounded HERE and the exact string is
 * unrecoverable from the response. That is acceptable for these magnitudes and no
 * worse than the incumbent, which computes in floats throughout: prices and USD
 * depths sit far inside a double's exact range, and a token volume would have to
 * exceed ~9e15 units of its own scale to lose an integer digit. Where full
 * precision matters, `/v1` is the surface that keeps it as decimal strings.
 */
function numeric(value: string): number {
  return Number(value)
}

/** A ticker row exactly as buildTickersSql emits it. */
export type TickerRow = {
  venue: string
  pool_key: string
  low_asset_id: string | number
  high_asset_id: string | number
  low_volume: string
  high_volume: string
  last_ratio: string
  max_ratio: string
  min_ratio: string
}

/**
 * USD depth behind one pair in one pool, or null when the venue has no reserve
 * model at all (a money-market wrap, an OTC fill) or the pool is unpriced.
 */
export type LiquidityResolver = (venue: string, poolKey: string, assetIds: number[]) => number | null

/**
 * One row per (venue, pool, unordered asset pair) over the rolling window.
 *
 * Three properties drive its shape, the same three poolVolumes.ts documents:
 * `pool_swap_legs` is ReplacingMergeTree, so the leg identity is collapsed with
 * argMax BEFORE anything is summed; the window is anchored to the newest indexed
 * block rather than wall clock; and the per-fill fold stays in SQL because a
 * 24-hour window is tens of thousands of fills.
 *
 * A ticker is a per-FILL pair, not a per-trade one — the Omnipool routes every
 * swap through its hub and emits one fill per hop, so an A→B swap there is the
 * two tickers A_H2O and B_H2O. That is the market structure CoinGecko is being
 * shown, and it is what the old feed published too (its H2O pairs are exactly
 * these hub hops).
 *
 * Quantities are token units at QTY_SCALE, so the price is a pure ratio and the
 * caller never has to know either side's decimals. Both trade directions fold
 * into one row: `low_volume` is every fill's low-asset side whether it was bought
 * or sold, which is the old feed's volume convention.
 *
 * The `aave` venue is excluded. Its fills are money-market deposits and
 * withdrawals — supplying USDT mints aUSDT one for one — which emit
 * Broadcast.Swapped like a trade but have no price (always exactly 1), no
 * reserves and no counterparty. Publishing them as tickers would tell an
 * aggregator that a 281k-unit `USDT_aUSDT` market exists. The old feed included
 * them, folded invisibly into merged tickers; see the endpoint description.
 */
export function buildTickersSql(): string {
  return `-- pub:cg:tickers
WITH ${legsCteSql(`venue != '${WRAP_VENUE}'`)},
sides AS (
  SELECT venue, pool_key, block_height, event_index, leg_kind, asset_id,
         divideDecimal(sum(toDecimal256(amount, 0)), ${amountUnitSql('asset_id')}, ${QTY_SCALE}) AS qty
  FROM legs
  WHERE leg_kind != 'fee'
  GROUP BY venue, pool_key, block_height, event_index, leg_kind, asset_id
),
fill AS (
  SELECT venue, pool_key, block_height, event_index,
         groupArrayIf(asset_id, leg_kind = 'in') AS in_ids,
         groupArrayIf(qty, leg_kind = 'in') AS in_qtys,
         groupArrayIf(asset_id, leg_kind = 'out') AS out_ids,
         groupArrayIf(qty, leg_kind = 'out') AS out_qtys
  FROM sides
  GROUP BY venue, pool_key, block_height, event_index
),
paired AS (
  SELECT venue, pool_key, block_height, event_index,
         least(in_ids[1], out_ids[1]) AS low_asset_id,
         greatest(in_ids[1], out_ids[1]) AS high_asset_id,
         if(in_ids[1] < out_ids[1], in_qtys[1], out_qtys[1]) AS low_qty,
         if(in_ids[1] < out_ids[1], out_qtys[1], in_qtys[1]) AS high_qty,
         divideDecimal(low_qty, high_qty, ${QTY_SCALE}) AS ratio
  FROM fill
  -- A fill with several assets on a side is not one pair, and a zero side has no
  -- price: dividing by it throws rather than producing a ticker.
  WHERE length(in_ids) = 1 AND length(out_ids) = 1
    AND in_ids[1] != out_ids[1] AND in_qtys[1] > 0 AND out_qtys[1] > 0
)
SELECT venue, pool_key, low_asset_id, high_asset_id,
       toString(sum(low_qty)) AS low_volume,
       toString(sum(high_qty)) AS high_volume,
       toString(argMax(ratio, tuple(block_height, event_index))) AS last_ratio,
       toString(max(ratio)) AS max_ratio,
       toString(min(ratio)) AS min_ratio
FROM paired
GROUP BY venue, pool_key, low_asset_id, high_asset_id
ORDER BY venue, pool_key, low_asset_id, high_asset_id`
}

/**
 * The pool a ticker was filled in. The Omnipool is one global pool; every other
 * venue carries a key (a stableswap pool id, an XYK pool account, an aToken
 * contract account, an OTC order id), so the venue prefix keeps two pools of
 * different venues from colliding on the same id.
 *
 * This is the one field whose CONTENT differs from the old feed, which repeated
 * ticker_id here. Naming the real pool is what lets a pair appear once per pool
 * with its own liquidity, which is how CoinGecko's DEX spec models a DEX.
 */
function poolIdOf(venue: string, poolKey: string): string {
  return venue === 'omnipool' ? 'omnipool' : `${venue}:${poolKey}`
}

/**
 * The wire form of a ticker row. The SQL computed one price per pair —
 * low-asset per high-asset — so a pair whose BASE is the high asset reads the
 * reciprocal, and its high and low swap places: the dearest price one way round
 * is the cheapest the other.
 */
export function buildTickers(rows: TickerRow[], liquidity: LiquidityResolver): CoinGeckoTicker[] {
  // Computed over the whole batch before any row is named: a share token's naming
  // depends on what ELSE its pool trades, which a single row cannot see.
  const owners = aliasOwnersByPool(rows)
  const unnamed = new Set<number>()
  let unnamedPairs = 0
  const indistinguishable = new Set<string>()
  const tickers: CoinGeckoTicker[] = []
  for (const row of rows) {
    const lowId = Number(row.low_asset_id)
    const highId = Number(row.high_asset_id)
    const pair = namePair(row, lowId, highId, owners)
    if (!pair) {
      const missing = [lowId, highId].filter(id => tickerSymbol(id) == null)
      if (missing.length) {
        unnamedPairs += 1
        for (const id of missing) unnamed.add(id)
      } else {
        // Both sides resolve to one symbol AND share a raw registry symbol, so
        // the pair cannot be named at all. This is the only path that loses a
        // REAL market, so it is never silent.
        indistinguishable.add(`${lowId}/${highId}`)
      }
      continue
    }
    const baseIsLow = pair.base.assetId === lowId
    const usd = liquidity(row.venue, row.pool_key, [lowId, highId])
    tickers.push({
      ticker_id: `${pair.base.symbol}_${pair.target.symbol}`,
      base_currency: pair.base.symbol,
      target_currency: pair.target.symbol,
      last_price: numeric(baseIsLow ? trimDecimal(row.last_ratio) : invertRatio(row.last_ratio)),
      base_volume: numeric(trimDecimal(baseIsLow ? row.low_volume : row.high_volume)),
      target_volume: numeric(trimDecimal(baseIsLow ? row.high_volume : row.low_volume)),
      pool_id: poolIdOf(row.venue, row.pool_key),
      liquidity_in_usd: numeric(tvlUsdString(usd) ?? '0.00'),
      high: numeric(baseIsLow ? trimDecimal(row.max_ratio) : invertRatio(row.min_ratio)),
      low: numeric(baseIsLow ? trimDecimal(row.min_ratio) : invertRatio(row.max_ratio)),
    })
  }
  warnOnDroppedPairs(unnamedPairs, unnamed, indistinguishable)
  // Byte order, not locale order: localeCompare is collation-dependent, so the
  // same data could serialise two ways on two hosts and break the ETag.
  return tickers.sort((a, b) => compare(a.ticker_id, b.ticker_id) || compare(a.pool_id, b.pool_id))
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The two ways a pair can fail to become a ticker, both operator-visible.
 *
 * The first is the old feed's known staleness bug turned into a message: there
 * an asset missing from a hardcoded list vanished silently, here the registry
 * gap names the ids. Both the pair-group count and the asset count are reported
 * — several pools can trade the same unnamed asset, so the two differ.
 *
 * The second loses a real market and is rarer: two registry entries of one token
 * that also share a raw symbol have no distinguishable pair name.
 */
function warnOnDroppedPairs(unnamedPairs: number, unnamed: Set<number>, indistinguishable: Set<string>): void {
  if (unnamed.size) {
    console.warn(`[public-api] coingecko tickers dropped ${unnamedPairs} pair-group(s) spanning ${unnamed.size} `
      + `asset(s) with no registry symbol: ${[...unnamed].sort((a, b) => a - b).join(', ')}`)
  }
  if (indistinguishable.size) {
    console.warn(`[public-api] coingecko tickers dropped ${indistinguishable.size} pair-group(s) whose two sides `
      + `share a symbol and cannot be named: ${[...indistinguishable].sort().join(', ')}`)
  }
}

/**
 * poolService keeps its ClickHouse handle in module state, set once by whichever
 * process uses it. The public API is a separate process, so it is wired on first
 * use — the same non-clobbering guard platformStats.ts applies.
 */
let wiredClient: ClickHouseClient | null = null
function ensurePoolService(client: ClickHouseClient): void {
  if (wiredClient === client) return
  initPoolService(client)
  wiredClient = client
}

/**
 * Real `liquidity_in_usd`, the field the old feed hardcoded to 0 because swap
 * events carry no reserves. It comes from the same current-state pool model the
 * explorer's /liquidity page renders, so the public number cannot disagree with
 * the page:
 *
 *  * Omnipool — the traded asset's OWN reserve value. The Omnipool is one pool
 *    holding every listed asset, so its total would say nothing about the depth
 *    behind one pair. The hub leg is not part of the composition, so an `X_H2O`
 *    ticker reports X's reserve, which is exactly the depth of that hop.
 *  * Stableswap / XYK — the pool's whole TVL. For the two-asset pools that is
 *    the pair's depth exactly; for an N-asset pool it is the pool's depth, of
 *    which the pair is a part.
 *  * Everything else (money-market wraps, OTC, HSM) has no reserves at all and
 *    reports 0, as the old feed did for every row.
 */
function liquidityResolver(index: PoolListResponse, xykShareTokenByAccount: Map<string, string | null>): LiquidityResolver {
  const omnipool = index.pools.find(p => p.kind === 'omnipool')
  const byKind = (kind: 'stableswap' | 'xyk'): Map<string, number | null> =>
    new Map(index.pools.filter(p => p.kind === kind && p.poolId != null).map(p => [String(p.poolId), p.tvlUsd]))
  const stableswap = byKind('stableswap')
  const xyk = byKind('xyk')
  return (venue, poolKey, assetIds) => {
    if (venue === 'omnipool') {
      const legs = omnipool?.composition.filter(entry => assetIds.includes(entry.asset.assetId)) ?? []
      // An unpriced leg makes the depth unknown, not zero.
      if (!legs.length || legs.some(entry => entry.usd == null)) return null
      return legs.reduce((sum, entry) => sum + (entry.usd ?? 0), 0)
    }
    if (venue === 'stableswap') return stableswap.get(poolKey) ?? null
    if (venue === 'xyk') {
      const shareToken = xykShareTokenByAccount.get(poolKey)
      return shareToken == null ? null : xyk.get(shareToken) ?? null
    }
    return null
  }
}

/**
 * The rolling-24h ticker feed. Stale-while-revalidate at the endpoint's own
 * max-age, so a cold key computes rather than 503ing the way the old
 * job-pushed route did, and no request ever waits on a refresh.
 */
export async function coingeckoTickers(client: ClickHouseClient): Promise<CoinGeckoTicker[]> {
  return cachedSwr('pub:cg:tickers', 60_000, 300_000, async () => {
    ensurePoolService(client)
    const at = await readAnchor(client)
    if (!at) return []
    const [res, index, xyk] = await Promise.all([
      client.query({
        query: buildTickersSql(),
        query_params: { anchor: at.anchor, hours: WINDOW_HOURS },
        format: 'JSONEachRow',
        clickhouse_settings: DECIMAL_STRINGS,
      }),
      getPoolsIndex(),
      xykPoolMeta(client),
    ])
    const shareTokens = new Map([...xyk].map(([account, meta]) => [account, meta.shareTokenId]))
    return buildTickers(await res.json<TickerRow>(), liquidityResolver(index, shareTokens))
  })
}

// ---------------------------------------------------------------------------
// Total supply
// ---------------------------------------------------------------------------

/**
 * How each published supply is reconstructed from indexed state. The old
 * endpoint read every one of these live over RPC per request (an ERC-20
 * `totalSupply` eth_call, or a pre-encoded `state_getStorage` for the hub asset)
 * against a hardcoded contract address and a hardcoded decimals map.
 *
 *  * `erc20` — the ERC-20 wallet-balance snapshot summed. Verified against the
 *    old endpoint on 2026-08-12: HOLLAR matched its live `totalSupply` to the
 *    last of 24 digits. The substrate-side balances of the same asset are NOT
 *    added: they are a second view of the same token, and adding them
 *    double-counts.
 *  * `atoken` — GDOT and GETH are money-market receipt tokens whose underlying
 *    is a pool share token. An aToken's supply is the underlying deposited plus
 *    the part of it that has been BORROWED out; borrowing is disabled on both
 *    reserves (neither variable-debt contract has ever emitted a scaled delta),
 *    so the underlying held in the aToken contract's own account is the whole
 *    supply. Verified 2026-08-12 against the live `totalSupply`: both matched to
 *    the last digit.
 *
 *    That identity is CHECKED, not assumed: every read probes the reserve's
 *    variable-debt contract, and a single delta row makes the supply
 *    unresolvable rather than silently short by the borrowed amount. It is not
 *    repaired by adding the debt back, because the only model for that is the
 *    scaled anchor+delta fold, and that fold is measurably wrong on one of these
 *    two contracts today — GDOT's `atoken_scaled_anchor` carries a 15.9M-scaled
 *    row with an empty holder, so folding it reports 3.93M against a real
 *    4.18M. Trading a verified-exact number for an unverifiable one is not a
 *    fix; the warning names the reserve so the debt term can be modelled
 *    properly when it first matters.
 *  * `substrate` — total issuance as the sum of indexed Tokens balances.
 *
 * No path publishes a supply it could not read. An empty result means the
 * indexed source is missing, not that the token's supply is zero, and it fails
 * (SupplyUnresolvableError → 503) — a zero total supply on a public aggregator
 * is worse than an error.
 *
 * `assetId` is the token whose supply is published; `sourceAssetId` is the asset
 * actually read (they differ only for the aToken pair, where the underlying is
 * the thing held). Decimals come from the registry, never a constant.
 */
interface SupplySource {
  kind: 'erc20' | 'atoken' | 'substrate'
  assetId: number
  sourceAssetId: number
}

export const SUPPLY_SOURCES: Record<string, SupplySource> = {
  hollar: { kind: 'erc20', assetId: 222, sourceAssetId: 222 },
  gigadot: { kind: 'atoken', assetId: 69, sourceAssetId: 690 },
  gigaeth: { kind: 'atoken', assetId: 420, sourceAssetId: 4200 },
  h2o: { kind: 'substrate', assetId: HUB_ASSET_ID, sourceAssetId: HUB_ASSET_ID },
}

export const SUPPLY_TOKENS = Object.keys(SUPPLY_SOURCES)

/**
 * The supply exists but this model cannot state it. Never cached (the loader
 * throws, so `cachedSwr` stores nothing) and never rendered as a number: the
 * route answers 503, because a wrong supply on a public aggregator outlives the
 * outage that produced it.
 */
export class SupplyUnresolvableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupplyUnresolvableError'
  }
}

/**
 * A substrate asset's 20-byte EVM address, the form the money-market reserve map
 * keys a reserve by: fifteen zero bytes, 0x01, then the registry id as a
 * big-endian UInt32.
 */
export function reserveAddressOf(assetId: number): string {
  return `0x${'0'.repeat(31)}1${assetId.toString(16).padStart(8, '0')}`
}

/**
 * A contract's substrate account: the EVM-account convention on Hydration — the
 * 'ETH\\0' prefix, the 20-byte contract, zero padding to 32 bytes.
 */
export function evmAccountId(contract: string): string {
  return `0x45544800${contract.replace(/^0x/, '')}${'0'.repeat(16)}`
}

/**
 * Sum of the ERC-20 balance snapshot. Mirrors the fold in
 * api/src/services/hollarService.ts (hollarSupplySql), restated here rather than
 * imported because that module is outside the public API's allow-list — and
 * narrowed to the ERC-20 side alone, which is the token's real total supply.
 *
 * `holders` separates "no indexed balances at all" from a genuine zero: the
 * inner filter drops zero balances, so a real supply always has holders.
 */
const ERC20_SUPPLY_SQL = `-- pub:cg:supply:erc20
SELECT count() AS holders, toString(sum(bal)) AS total
FROM (
  SELECT account_id, toUInt256OrZero(argMax(total, updated_at)) AS bal
  FROM price_data.erc20_wallet_balances
  WHERE asset_id = {asset:String}
  GROUP BY account_id
)
WHERE bal > 0`

/** Sum of indexed substrate balances — total issuance for a Tokens asset. */
const SUBSTRATE_SUPPLY_SQL = `-- pub:cg:supply:substrate
SELECT count() AS holders, toString(sum(bal)) AS total
FROM (
  SELECT account_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
  FROM price_data.account_asset_latest_balances
  WHERE asset_id = {asset:String}
  GROUP BY account_id
)
WHERE bal > 0`

/**
 * The receipt token and the variable-debt token of one reserve. Read from the
 * indexed map rather than frozen into this file the way the old route froze its
 * contract addresses, so a redeployed contract is followed automatically.
 */
const RESERVE_MAP_SQL = `-- pub:cg:reserve-map
SELECT argMax(atoken, updated_at) AS atoken, argMax(vdebt, updated_at) AS vdebt
FROM price_data.atoken_reserve_map
WHERE asset_address = {reserve:String} AND market_key IN ('core', '')`

/**
 * The underlying held by the receipt-token contract, plus the debt probe that
 * decides whether that custody IS the supply.
 *
 * The probe is a primary-key read: `atoken_scaled_deltas_by_contract` is ORDER BY
 * (contract_address, …), so `WHERE contract_address = … LIMIT 1` touches one
 * granule and answers "has this reserve ever minted debt" for free.
 */
const ATOKEN_SUPPLY_SQL = `-- pub:cg:supply:atoken
SELECT
  (SELECT count() FROM (
     SELECT 1 FROM price_data.atoken_scaled_deltas_by_contract
     WHERE contract_address = {vdebt:String} LIMIT 1
   )) AS debt_rows,
  count() AS custody_rows,
  toString(argMaxMerge(total_state)) AS total
FROM price_data.account_asset_latest_balances
WHERE asset_id = {asset:String} AND account_id = {account:String}`

interface SupplyRow { total: string | null; holders?: string | number; custody_rows?: string | number; debt_rows?: string | number }
interface ReserveMapRow { atoken: string | null; vdebt: string | null }

/** The raw amount a source holds, or a thrown SupplyUnresolvableError. */
async function readSupplyRaw(client: ClickHouseClient, token: string, source: SupplySource): Promise<string> {
  const asset = String(source.sourceAssetId)
  if (source.kind === 'erc20' || source.kind === 'substrate') {
    const res = await client.query({
      query: source.kind === 'erc20' ? ERC20_SUPPLY_SQL : SUBSTRATE_SUPPLY_SQL,
      query_params: { asset },
      format: 'JSONEachRow',
    })
    const row = (await res.json<SupplyRow>())[0]
    if (!row || Number(row.holders ?? 0) === 0) {
      throw new SupplyUnresolvableError(`no indexed ${source.kind} balances for asset ${asset}`)
    }
    return row.total ?? '0'
  }

  const reserve = reserveAddressOf(source.sourceAssetId)
  const mapRes = await client.query({ query: RESERVE_MAP_SQL, query_params: { reserve }, format: 'JSONEachRow' })
  const map = (await mapRes.json<ReserveMapRow>())[0]
  if (!map?.atoken || !map.vdebt) {
    throw new SupplyUnresolvableError(`no money-market reserve entry for asset ${asset} (${reserve})`)
  }

  const res = await client.query({
    query: ATOKEN_SUPPLY_SQL,
    query_params: { asset, account: evmAccountId(map.atoken), vdebt: map.vdebt.toLowerCase() },
    format: 'JSONEachRow',
  })
  const row = (await res.json<SupplyRow>())[0]
  if (Number(row?.debt_rows ?? 0) > 0) {
    console.error(`[public-api] coingecko ${token}: reserve ${reserve} has minted variable debt, so the receipt `
      + 'token\'s supply is no longer the underlying its contract holds — the debt term must be modelled before '
      + 'this endpoint can answer again')
    throw new SupplyUnresolvableError(`${token} supply is not custody-backed any more (reserve ${reserve} has debt)`)
  }
  if (!row || Number(row.custody_rows ?? 0) === 0) {
    throw new SupplyUnresolvableError(`no indexed balance of asset ${asset} at receipt contract ${map.atoken}`)
  }
  return row.total ?? '0'
}

/**
 * The published supply of one token, in whole units. null for an unknown token
 * name, which the route turns into the 404 the old endpoint answers with;
 * SupplyUnresolvableError for a source this model could not read.
 */
export async function coingeckoTotalSupply(client: ClickHouseClient, token: string): Promise<string | null> {
  const source = SUPPLY_SOURCES[token]
  if (!source) return null
  return cachedSwr(`pub:cg:supply:${token}`, 300_000, 900_000, async () => {
    // The amount read is in the SOURCE asset's units. For the receipt pair that
    // is only the published token's scale because the two are 1:1; a registry
    // change that broke that would otherwise move the decimal point silently.
    const decimals = assetDescriptor(source.sourceAssetId).decimals
    const published = assetDescriptor(source.assetId).decimals
    if (decimals !== published) {
      throw new SupplyUnresolvableError(`asset ${source.assetId} has ${published} decimals but its source `
        + `asset ${source.sourceAssetId} has ${decimals} — a 1:1 supply cannot span two scales`)
    }
    return formatUnits(await readSupplyRaw(client, token, source), decimals)
  })
}
