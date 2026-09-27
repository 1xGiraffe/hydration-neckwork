// A native pool's own account read as the pool — the venue — rather than as a holder.
//
// The Omnipool pallet account, a stableswap pool's account, an XYK pair's account and
// an LBP pool's account are party to every trade and liquidity action executed against
// the pool, and to nothing else. Read as an ordinary account, their page was nothing
// but the pool's own swap and deposit legs listed as transfers: plumbing every other
// surface refuses (nonPlumbingTransferLegSql drops any leg touching a pool account or
// the Omnipool pot), with the trades that caused them nowhere. Read as the venue, the
// page lists what happened IN the pool — each trade it executed, as that pool's hop
// (the Uniswap v3 pool contract's page reads the same way, see v3VenuesInScope), and
// each liquidity action on it — and its transfer legs stay the plumbing they are
// everywhere else.
//
// This module is the pure half: which scope is a venue, and the SQL naming a venue's
// rows. The reads and row builders live beside the other feeds in explorerService.

export type PoolVenue =
  | { kind: 'omnipool'; account: string }
  | { kind: 'stableswap'; account: string; poolId: number }
  | { kind: 'xyk'; account: string; assetA: number; assetB: number }
  | { kind: 'lbp'; account: string; assetA: number; assetB: number }

// An account's truncated-H160 form — the runtime's AccountId→EVM mapping, which
// resolveRelatedAccounts always folds into an account's related set.
function evmFormOf(account: string): string {
  return '0x45544800' + account.slice(2, 42) + '0000000000000000'
}

// The venue a scope reads as, or null. A scope is a venue exactly when it is ONE pool
// account, alone or with its own truncated-H160 form: a tag of many pools, or a pool
// grouped with anything else, stays an ordinary multi-account feed, since a venue's
// feed says nothing about the other members.
export function poolVenueForScope(accounts: readonly string[], venues: ReadonlyMap<string, PoolVenue>): PoolVenue | null {
  const scope = [...new Set(accounts.map(a => a.toLowerCase()))]
  const pools = scope.filter(a => venues.has(a))
  if (pools.length !== 1) return null
  const pool = pools[0]
  const alias = evmFormOf(pool)
  return scope.every(a => a === pool || a === alias) ? venues.get(pool) ?? null : null
}

// The pallet events that ARE a trade in each single-pool venue. The Omnipool is one
// pool, so its pallet's trade events are its trades; an LBP pool is named by its pair.
// Read from swap_activity rather than pool_swap_legs because a modern Omnipool trade
// is ONE pallet event but TWO Broadcast fills (in → H2O, H2O → out), and the page shows
// the trade, not its halves.
export const OMNIPOOL_TRADE_EVENTS = ['Omnipool.SellExecuted', 'Omnipool.BuyExecuted'] as const
export const LBP_TRADE_EVENTS = ['LBP.SellExecuted', 'LBP.BuyExecuted'] as const
// The liquidity events a venue's own liquidity rows come from. Farm reward claims are
// paid by the liquidity-mining pots, not the pool, so they are not the pool's.
export const OMNIPOOL_LIQUIDITY_EVENTS = ['Omnipool.LiquidityAdded', 'Omnipool.LiquidityRemoved', 'Omnipool.PositionCreated'] as const
export const STABLESWAP_VENUE_LIQUIDITY_EVENTS = ['Stableswap.LiquidityAdded', 'Stableswap.LiquidityRemoved'] as const
export const XYK_VENUE_LIQUIDITY_EVENTS = ['XYK.LiquidityAdded', 'XYK.LiquidityRemoved', 'XYK.PoolCreated', 'XYK.PoolDestroyed'] as const

// Where a venue's trades are keyed. Stableswap and XYK trades are one Broadcast fill
// each, in pool_swap_legs under (venue, pool_key) — the table's own key prefix, the
// one place their pool is recorded (a stableswap pool's routed share hops included,
// which is how a trade through the share renders on the pool's page). The single-pool
// venues read their pallet's trade events (see OMNIPOOL_TRADE_EVENTS).
export type VenueTradeSource =
  | { table: 'swap_activity'; events: readonly string[]; pair: [number, number] | null; legsVenue: string; legsPoolKey: string | null }
  | { table: 'pool_swap_legs'; legsVenue: string; legsPoolKey: string }

export function venueTradeSource(venue: PoolVenue): VenueTradeSource {
  switch (venue.kind) {
    case 'omnipool': return { table: 'swap_activity', events: OMNIPOOL_TRADE_EVENTS, pair: null, legsVenue: 'omnipool', legsPoolKey: 'omnipool' }
    case 'lbp': return { table: 'swap_activity', events: LBP_TRADE_EVENTS, pair: [venue.assetA, venue.assetB], legsVenue: 'lbp', legsPoolKey: null }
    case 'stableswap': return { table: 'pool_swap_legs', legsVenue: 'stableswap', legsPoolKey: String(venue.poolId) }
    case 'xyk': return { table: 'pool_swap_legs', legsVenue: 'xyk', legsPoolKey: venue.account }
  }
}

const quote = (value: string): string => `'${value.replace(/[^0-9A-Za-z_.:]/g, '')}'`
const uints = (values: readonly number[]): string => values.map(v => String(Math.max(0, Math.trunc(v)))).join(',')

// A token filter's SQL: undefined = no filter, [] = a token no row can reference.
function tokenSql(tokenIds: readonly number[] | undefined, predicate: (ids: string) => string): string {
  if (tokenIds == null) return ''
  return tokenIds.length ? `AND ${predicate(uints(tokenIds))}` : 'AND 0'
}

function pairSql(inExpr: string, outExpr: string, [a, b]: [number, number]): string {
  return `((${inExpr} = ${a} AND ${outExpr} = ${b}) OR (${inExpr} = ${b} AND ${outExpr} = ${a}))`
}

// The (block_height, event_index) of every trade the venue executed under `bound`,
// each once. A trade matches a token when either side is one of its ids.
export function venueTradeKeysSql(venue: PoolVenue, bound: string, tokenIds?: readonly number[]): string {
  const source = venueTradeSource(venue)
  if (source.table === 'swap_activity') {
    return `SELECT DISTINCT block_height, event_index FROM price_data.swap_activity
      WHERE ${bound} AND event_name IN (${source.events.map(quote).join(',')})
        ${source.pair ? `AND ${pairSql('asset_in', 'asset_out', source.pair)}` : ''}
        ${tokenSql(tokenIds, ids => `(asset_in IN (${ids}) OR asset_out IN (${ids}))`)}`
  }
  // Every fill has an `in` leg, so it is the fill's one row; under a token filter any
  // in/out leg of the token names the fill.
  return `SELECT DISTINCT block_height, event_index FROM price_data.pool_swap_legs
      WHERE venue = ${quote(source.legsVenue)} AND pool_key = ${quote(source.legsPoolKey)} AND ${bound}
        ${tokenIds == null ? `AND leg_kind = 'in'` : `AND leg_kind IN ('in', 'out') ${tokenSql(tokenIds, ids => `asset_id IN (${ids})`)}`}`
}

// The liquidity events a venue can carry at all (an LBP pool's own liquidity events
// are not indexed as liquidity activity, so it has none).
export function venueLiquidityEvents(venue: PoolVenue): readonly string[] {
  switch (venue.kind) {
    case 'omnipool': return OMNIPOOL_LIQUIDITY_EVENTS
    case 'stableswap': return STABLESWAP_VENUE_LIQUIDITY_EVENTS
    case 'xyk': return XYK_VENUE_LIQUIDITY_EVENTS
    case 'lbp': return []
  }
}

// Which liquidity_activity rows are the venue's own, on the table's decoded columns.
// A stableswap row's asset_id IS its pool id. An XYK pair's account is derived from
// the pair alone, so every incarnation of the pool — and only that pair's rows — is
// this account's; the lifecycle events also name the account, the pair events only
// the assets.
export function venueLiquidityPoolSql(venue: PoolVenue): string {
  switch (venue.kind) {
    case 'omnipool': return '1'
    case 'stableswap': return `asset_id = ${uints([venue.poolId])}`
    case 'xyk': return pairSql('asset_id', 'asset_b', [venue.assetA, venue.assetB])
    case 'lbp': return '0'
  }
}

// The (block_height, event_index) of every liquidity action on the venue under
// `bound`. `exclusions` carries the feed-wide classification every liquidity read
// shares (the module-actor exclusion and the router-hop rule — a routed add or remove
// through a stableswap share is a hop of a trade, which the trade source already
// shows as the share fill), so the venue's rows are exactly the ones the global feed
// renders for this pool.
export function venueLiquidityKeysSql(
  venue: PoolVenue, bound: string, events: readonly string[], tokenIds: readonly number[] | undefined,
  exclusions: { joinSql: string; predicateSql: string },
): string {
  if (!events.length) return ''
  return `SELECT DISTINCT block_height, event_index FROM price_data.liquidity_activity
      ${exclusions.joinSql}
      WHERE ${bound} AND event_name IN (${events.map(quote).join(',')})
        AND ${venueLiquidityPoolSql(venue)}
        ${exclusions.predicateSql}
        ${tokenSql(tokenIds, ids => `hasAny(asset_refs, [${ids}])`)}`
}

// One keyed stream over a venue's sources, each row tagged with the source it came
// from. The sources are disjoint by construction — a trade and a liquidity action are
// different events — so the union is the feed.
export interface VenueSourceSql { src: string; sql: (bound: string) => string }
export function venueKeysUnionSql(sources: readonly VenueSourceSql[], bound: string): string {
  const arms = sources.map(s => ({ src: s.src, sql: s.sql(bound) })).filter(a => a.sql)
  if (!arms.length) return `SELECT toUInt32(0) AS block_height, toUInt32(0) AS event_index, '' AS src WHERE 0`
  return arms.map(a => `SELECT block_height, event_index, ${quote(a.src)} AS src FROM (${a.sql})`).join('\n    UNION ALL\n    ')
}

export interface VenueKey { block_height: number; event_index: number; src: string }

// How a page's keys are read, so the location walk below is independent of SQL.
export interface VenueKeyReader {
  // Rows under a bound.
  count(bound: string): Promise<number>
  // Rows per `width`-block bucket under a bound, newest bucket first.
  buckets(bound: string, width: number): Promise<{ bucket: number; rows: number }[]>
  // The newest `limit` rows under a bound, newest first (block, then event, descending).
  read(bound: string, limit: number): Promise<VenueKey[]>
}

// A shallow page is read straight off the newest range; past this depth the ranks are
// LOCATED instead, so a deep page costs a count and one bucket's read, never a top-N
// over everything above it.
export const VENUE_DIRECT_READ_MAX = 5_000
// Bucket width for locating a deep page inside a range. The busiest venue, the
// Omnipool, averages about half a trade a block, so a bucket holds a few thousand rows.
export const VENUE_LOCATE_BUCKET_BLOCKS = 10_000

// The keys at ranks [offset, offset + limit) of the venue's feed, newest first.
//
// `ranges` are disjoint primary-key block ranges newest first (feedRangeBoundsSql, or
// a date window as its own single range), so their concatenation is the feed's order
// and every page read is a top-N under one range's granules — this ClickHouse plans
// `ORDER BY key DESC LIMIT` as a top-N over everything the WHERE admits. A range the
// page does not reach is skipped by its count, and inside the range that holds the
// page the ranks are found by bucket counts, so the only rows sorted are the page's
// own bucket's.
export async function locateVenuePage(
  reader: VenueKeyReader, ranges: readonly string[], offset: number, limit: number,
  directMax = VENUE_DIRECT_READ_MAX, width = VENUE_LOCATE_BUCKET_BLOCKS,
): Promise<VenueKey[]> {
  const out: VenueKey[] = []
  let skip = offset
  for (const range of ranges) {
    const need = limit - out.length
    if (need <= 0) break
    if (skip + need <= directMax) {
      const rows = await reader.read(range, skip + need)
      if (rows.length <= skip) { skip -= rows.length; continue }
      out.push(...rows.slice(skip, skip + need))
      skip = 0
      continue
    }
    const total = await reader.count(range)
    if (total <= skip) { skip -= total; continue }
    const buckets = (await reader.buckets(range, width)).filter(b => b.rows > 0)
    let before = 0
    let first = 0
    while (first < buckets.length - 1 && before + buckets[first].rows <= skip) before += buckets[first++].rows
    let covered = before
    let last = first
    while (last < buckets.length && covered < skip + need) covered += buckets[last++].rows
    const hi = (buckets[first].bucket + 1) * width
    const lo = buckets[Math.max(first, last - 1)].bucket * width
    const within = skip - before
    const rows = await reader.read(`(${range}) AND block_height >= ${lo} AND block_height < ${hi}`, within + need)
    out.push(...rows.slice(within, within + need))
    skip = 0
  }
  return out
}

// The feed walked newest first in pages of keys, for the filters no SQL states (a
// min-value threshold or an identity filter is decided on the built, valued row). It
// stops at `want` matches, at the end of the feed, or once `cap` candidates have been
// examined — `exhausted` says which, so a count over it can say whether it is whole.
export async function walkVenueRows<T>(
  reader: VenueKeyReader, ranges: readonly string[], want: number, cap: number, pageSize: number,
  build: (keys: VenueKey[]) => Promise<T[]>, matches: (row: T) => boolean,
): Promise<{ rows: T[]; exhausted: boolean }> {
  const rows: T[] = []
  let examined = 0
  for (const range of ranges) {
    let cursor: VenueKey | null = null
    for (;;) {
      if (rows.length >= want) return { rows, exhausted: false }
      if (examined >= cap) return { rows, exhausted: false }
      const bound: string = cursor
        ? `(${range}) AND (block_height < ${cursor.block_height} OR (block_height = ${cursor.block_height} AND event_index < ${cursor.event_index}))`
        : range
      const size = Math.min(pageSize, cap - examined)
      const keys = await reader.read(bound, size)
      examined += keys.length
      for (const row of await build(keys)) if (matches(row)) rows.push(row)
      if (keys.length < size) break
      cursor = keys[keys.length - 1]
    }
  }
  return { rows, exhausted: true }
}
