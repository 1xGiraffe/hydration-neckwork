import type { ClickHouseClient } from '../../db/client.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, type AccountRef } from './address.ts'
import { positionCursorSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'

// Swap-fill assembly shared by /v1/pools/{venue}/{poolKey}/trades and
// /v1/trades: pool_swap_legs re-grouped into fills. Two bounded reads per
// page — the fill identities first (grouped, cursor-paginated), then exactly
// those fills' legs — so a page never truncates a fill mid-legs and the
// ReplacingMergeTree identity is collapsed in TS before anything is grouped.
//
// Normative semantics, restated from the public spec because consumers sum
// these numbers:
//  * `fees` RESTATE value the in/out legs already carry — never add fee legs
//    to trade legs, they are a revenue breakdown, not extra flow.
//  * Era split at block 6,837,788 (the first Broadcast.Swapped): a modern
//    Omnipool trade reports its two hub hops as separate fills; a legacy fill
//    is the whole A→B swap with no hub leg, and its op_key is '' (reported
//    null) because the era carried no Router operation id.
//  * A legacy fee leg's fee_dest '' is genuinely unknowable, not "unset".

// Broadcast names a swapper it does not have with placeholders (the 0x2a2a…
// filler and the 'Parent' XCM origin marker — see swap_actor_mv). They encode
// 32 valid-looking bytes, so rendering one would assert an actor that does not
// exist; they are reported as swapper: null.
export const PLACEHOLDER_SWAPPERS = [
  '0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a',
  '0x506172656e740000000000000000000000000000000000000000000000000000',
]

export interface FillLeg { assetId: string; amount: string }
export interface FillFeeLeg extends FillLeg { feeDest: string | null; feeRecipient: AccountRef | null }

export interface SwapFill {
  blockHeight: number
  eventIndex: number
  timestamp: string
  venue: string
  poolKey: string | null
  swapper: AccountRef | null
  inputs: FillLeg[]
  outputs: FillLeg[]
  fees: FillFeeLeg[]
  opKey: string | null
  extrinsicIndex: number | null
}

export interface FillsScope { venue?: string; poolKey?: string }

export interface FillsPageOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  assetId?: number
  swapperAccountId?: string
}

interface LegRow {
  venue: string
  pool_key: string
  block_height: number
  event_index: number
  leg_index: number
  leg_kind: 'in' | 'out' | 'fee'
  asset_id: number
  amount: string
  fee_dest: string
  fee_recipient: string
  swapper: string
  op_key: string
  extrinsic_index: number | null
  ts: string
  ingested_at: string
}

function scopeSql(scope: FillsScope, params: Record<string, unknown>): string {
  const clauses: string[] = []
  if (scope.venue) { clauses.push('venue = {venue:String}'); params.venue = scope.venue }
  if (scope.poolKey != null) { clauses.push('pool_key = {poolKey:String}'); params.poolKey = scope.poolKey }
  return clauses.length ? clauses.join(' AND ') : '1 = 1'
}

export async function fillsPage(client: ClickHouseClient, scope: FillsScope, options: FillsPageOptions): Promise<{ items: Array<WithExtrinsicHash<SwapFill>>; hasMore: boolean }> {
  const dir = options.order === 'desc' ? 'DESC' : 'ASC'
  const params: Record<string, unknown> = { bound: options.limit + 1 }
  const clauses = [scopeSql(scope, params)]
  let filterSql = windowSql(options, params)
  // An asset filter matches a fill through ANY of its legs (fee legs included:
  // the fill touched the asset either way).
  if (options.assetId != null) { filterSql += ' AND asset_id = {assetId:UInt32}'; params.assetId = options.assetId }
  if (options.swapperAccountId) { filterSql += ' AND swapper = {swapper:String}'; params.swapper = options.swapperAccountId }
  filterSql += positionCursorSql(options.order, 'event_index', params, options.cursor)

  // Fill-identity discovery takes one of two shapes:
  //  * Fully scoped (venue + pool key): the scope is the table's key prefix, so
  //    a reverse read in key order finds the page's distinct (block, event)
  //    identities in ~10 ms at ANY depth (measured on the whole omnipool
  //    range) — where a GROUP BY over the same scope folds the venue's entire
  //    history (measured 276 ms) before it can take a page.
  //  * Global (/v1/trades): no key prefix exists, but the route always bounds
  //    the window (≤ 7 days), so grouping the window is cheap (measured ~7 ms
  //    for 24 h).
  const scoped = Boolean(scope.venue) && scope.poolKey != null
  let keys: { block_height: number; event_index: number }[]
  let scanTruncated = false
  if (scoped) {
    // Over-fetch legs (identities only) and take distinct fills in order. Legs
    // of one fill are adjacent in key order, so the first limit+1 distinct
    // identities are exact; a truncated LAST fill cannot corrupt the page
    // because legs are fetched separately below. One adaptive retry covers a
    // page of pathologically leggy fills.
    for (const legBound of [options.limit * 8 + 200, options.limit * 40 + 1_000]) {
      const scanRes = await client.query({
        query: `-- data:trades:fill-keys-scan
            SELECT block_height, event_index
            FROM price_data.pool_swap_legs
            WHERE ${clauses.join(' AND ')}${filterSql}
            ORDER BY block_height ${dir}, event_index ${dir}
            LIMIT {legBound:UInt32}
            SETTINGS read_in_order_use_buffering = 0`,
        query_params: { ...params, legBound },
        format: 'JSONEachRow',
      })
      const rows = await scanRes.json<{ block_height: number; event_index: number }>()
      const distinct: { block_height: number; event_index: number }[] = []
      let lastKey = ''
      for (const row of rows) {
        const key = `${row.block_height}:${row.event_index}`
        if (key === lastKey) continue
        lastKey = key
        distinct.push(row)
      }
      keys = distinct.slice(0, options.limit + 1)
      scanTruncated = rows.length >= legBound
      if (keys.length > options.limit || !scanTruncated) break
    }
  } else {
    const keysRes = await client.query({
      query: `-- data:trades:fill-keys
          SELECT block_height, event_index
          FROM price_data.pool_swap_legs
          WHERE ${clauses.join(' AND ')}${filterSql}
          GROUP BY block_height, event_index
          ORDER BY block_height ${dir}, event_index ${dir}
          LIMIT {bound:UInt32}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    keys = await keysRes.json<{ block_height: number; event_index: number }>()
  }
  const hasMore = keys!.length > options.limit || (scoped && scanTruncated)
  const pageKeys = keys!.slice(0, options.limit)
  if (pageKeys.length === 0) return { items: [], hasMore: false }

  // Two flat arrays zipped server-side: ClickHouse's parameter parser cannot
  // read an Array(Tuple(…)) literal from the client's JSON (measured live).
  const legsParams: Record<string, unknown> = {
    fillBlocks: pageKeys.map(key => Number(key.block_height)),
    fillEvents: pageKeys.map(key => Number(key.event_index)),
  }
  const legsRes = await client.query({
    query: `-- data:trades:fill-legs
        SELECT venue, pool_key, block_height, event_index, leg_index, leg_kind, asset_id, amount,
               fee_dest, fee_recipient, swapper, op_key, extrinsic_index,
               toString(block_timestamp) AS ts, ingested_at
        FROM price_data.pool_swap_legs
        WHERE ${scopeSql(scope, legsParams)} AND (block_height, event_index) IN arrayZip({fillBlocks:Array(UInt32)}, {fillEvents:Array(UInt32)})
        ORDER BY block_height, event_index, leg_kind, leg_index, ingested_at DESC`,
    query_params: legsParams,
    format: 'JSONEachRow',
  })
  const legs = await legsRes.json<LegRow>()

  // Collapse the replay identity, then group into fills in page-key order.
  const seen = new Set<string>()
  const byFill = new Map<string, LegRow[]>()
  for (const leg of legs) {
    const identity = `${leg.block_height}:${leg.event_index}:${leg.leg_kind}:${leg.leg_index}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const fillKey = `${leg.block_height}:${leg.event_index}`
    const bucket = byFill.get(fillKey)
    if (bucket) bucket.push(leg)
    else byFill.set(fillKey, [leg])
  }

  const items: SwapFill[] = []
  for (const key of pageKeys) {
    const fillLegs = byFill.get(`${key.block_height}:${key.event_index}`)
    if (!fillLegs) continue
    items.push(assembleFill(fillLegs))
  }
  return { items: await attachExtrinsicHashes(client, items), hasMore }
}

function assembleFill(legs: LegRow[]): SwapFill {
  const first = legs[0]
  const swapper = String(first.swapper ?? '').toLowerCase()
  const inputs: FillLeg[] = []
  const outputs: FillLeg[] = []
  const fees: FillFeeLeg[] = []
  for (const leg of legs) {
    const shaped = { assetId: String(leg.asset_id), amount: leg.amount }
    if (leg.leg_kind === 'in') inputs.push(shaped)
    else if (leg.leg_kind === 'out') outputs.push(shaped)
    else {
      fees.push({
        ...shaped,
        feeDest: leg.fee_dest || null,
        feeRecipient: accountRefOrNull(leg.fee_recipient),
      })
    }
  }
  return {
    blockHeight: Number(first.block_height),
    eventIndex: Number(first.event_index),
    timestamp: iso(first.ts),
    venue: first.venue,
    poolKey: first.pool_key || null,
    swapper: PLACEHOLDER_SWAPPERS.includes(swapper) ? null : accountRefOrNull(swapper),
    inputs,
    outputs,
    fees,
    opKey: first.op_key || null,
    extrinsicIndex: first.extrinsic_index == null ? null : Number(first.extrinsic_index),
  }
}
