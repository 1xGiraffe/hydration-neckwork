import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import {
  ANCHORED_LEG_WINDOW,
  ANCHORED_PRICE_WINDOW,
  DECIMAL_STRINGS,
  OMNIPOOL_ACCOUNT,
  PRICE_LOOKBACK_DAYS,
  amountUnitSql,
  legsCteSql,
  nettedTradeScaled,
  priceAliasSql,
  priceSourceSql,
  pricedCteSql,
  renderUsd,
  scaledUsd,
  usdString,
} from '../../services/valuation.ts'
import { iso } from '../schemas/common.ts'

// The venue-neutral money/valuation helpers live in services/valuation.ts so
// the revenue read models can share them without importing the public tree
// (which is an import leaf). Re-exported so this file stays the public
// surfaces' single import site for them.
export {
  ANCHORED_LEG_WINDOW,
  ANCHORED_PRICE_WINDOW,
  DECIMAL_STRINGS,
  OMNIPOOL_ACCOUNT,
  PRICE_LOOKBACK_DAYS,
  amountUnitSql,
  legsCteSql,
  nettedTradeScaled,
  priceAliasSql,
  priceSourceSql,
  pricedCteSql,
  renderUsd,
  scaledUsd,
  usdString,
}

// Pool volumes and fee revenue over a rolling window, from the `pool_swap_legs`
// projection (clickhouse/schema/006_public.sql). The rules implemented here are
// normative in docs/superpowers/specs/2026-08-12-public-rest-api-design.md
// § Semantics 1, 2 and 6; where this file deviates from the data lake, the spec
// section says so and the endpoint description repeats it.
//
// Three properties drive the shape of every query below:
//
//  * `pool_swap_legs` is ReplacingMergeTree(ingested_at) — re-indexing a raw range
//    inserts a second copy of each leg. Every query therefore collapses the
//    table's own ORDER BY (its leg identity) with argMax(…, ingested_at) BEFORE a
//    single amount is summed. Summing first and deduplicating later would double
//    a replayed day's volume.
//  * USD is event-time and read-time: a leg is valued at the 1h candle that had
//    already CLOSED when the fill happened (ASOF on `interval_start + 1 HOUR <=
//    block_timestamp`), the house rule from accountTradeVolume.ts. The candle of
//    the fill's own hour is a FUTURE price at the moment of the fill and is never
//    used.
//  * The window is anchored to `max(block_timestamp)` of the source, not to wall
//    clock, so an indexing lag shortens nothing and the response states the anchor
//    as `asOf`.
//
// The per-fill fold lives in SQL rather than TS on purpose: a 30-day window is
// several hundred thousand fills, and streaming them into the API process to net
// them there would make the endpoint's cost linear in trade count per request.

/** The Omnipool's hub asset. Its legs are the protocol fee, never per-asset volume. */
const LRNA_ASSET_ID = 1

/**
 * Rolling windows this surface serves.
 *
 * `all` is absent because it is an unbounded scan by definition. `1y` is absent
 * because it was MEASURED not to fit: with the api client's own caps (8 threads,
 * 4 GB, 20 s) a one-year Omnipool volume window dies at 3.76 GiB in
 * AggregatingTransform, and a one-year stableswap window takes 17 s of the 20 s
 * budget. A window that answers with a 500 half the time is not a window; when the
 * projection is backfilled and cheaper than the raw-event equivalent these were
 * measured on, re-measure before adding it back.
 */
export type VolumeWindow = '1h' | '24h' | '7d' | '30d'

export const WINDOW_HOURS: Record<VolumeWindow, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 }
export const WINDOW_DAYS: Record<VolumeWindow, number> = { '1h': 1 / 24, '24h': 1, '7d': 7, '30d': 30 }

/**
 * Windows the netted routed total is defined for. It streams one row per trade, and
 * a 7-day window measured 100 580 rows — past the client's 100 000-row cap, which
 * would throw rather than silently truncate. Platform stats asks for 24h only.
 */
export type RoutedWindow = '1h' | '24h'

/** Venues that carry a pool key rather than a single global pool. */
export type PoolVenue = 'stableswap' | 'xyk'

export interface OmnipoolVolumeItem {
  assetId: string
  volumeUsd: string
  feeUsd: string
  protocolFeeUsd: string
}

export interface PoolVolumeItem {
  poolKey: string
  volumeUsd: string
  feeUsd: string
}

export interface VolumeSummary<T> {
  asOf: string | null
  blockHeight: number | null
  /**
   * The venue's own volume, counted ONCE per fill. For the Omnipool this is NOT
   * the sum of the per-asset items: those carry both sides of every fill.
   */
  totalVolumeUsd: string
  items: T[]
}

export interface XykPoolMeta {
  shareTokenId: string | null
  assetA: string | null
  assetB: string | null
}

/**
 * A venue that traded but could not value ANY of it is a real outage (a dead price
 * feed, an asset that fell out of the alias map), and the response carries it as
 * plain zeros. Nothing else would say so, so it is logged once per cache miss.
 */
function warnIfNothingPriced(venue: string, window: string, fills: number, totalScaled: bigint): void {
  if (fills === 0 || totalScaled !== 0n) return
  console.warn(`[public-api] ${venue} ${window} volume is 0 across ${fills} priced groups — `
    + 'no leg in the window could be valued (check the price feed and the asset alias map)')
}

/**
 * The Omnipool trades every pair THROUGH the hub, and emits one fill per hop: a
 * user swap A→B is `A → LRNA` immediately followed by `LRNA → B`, sharing the
 * router operation when routed and adjacent event indices always (measured over a
 * 24-hour window: 3 721 of 3 721 hub-out fills are followed at `event_index + 1`
 * by a hub-in fill; the 1 503 unpaired hub-in fills are users spending LRNA
 * directly, which are whole swaps of their own).
 *
 * So a fill is NOT a user trade — half of them are the first leg of one. Anything
 * that counts trades once (a venue total, the netted platform total) has to fold
 * that first leg into its partner, or the Omnipool reports twice its real volume.
 * Per-ASSET volume is unaffected: each hop carries exactly one user asset, so a
 * swap contributes its value to A once and to B once, which is the intent.
 *
 * The partner is found with a WINDOW over the per-fill rows rather than a semi-join
 * back onto them. ClickHouse inlines a CTE at every reference and READS it again
 * per reference, so naming the fill set twice would re-run the whole windowed scan,
 * its deduplication and its ASOF price join a second time. Every query below is
 * therefore one linear chain: each stage is referenced exactly once.
 */
const NEXT_FILL_WINDOW = 'WINDOW nxt AS (PARTITION BY block_height ORDER BY event_index ASC ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING)'
/** True when this fill is a hub hop whose partner is the very next fill of the block. */
const IS_FIRST_HOP = 'out_hub = 1 AND next_in_hub = 1 AND next_event_index = event_index + 1'

/**
 * Per-asset Omnipool volume, asset fees and protocol (LRNA) fees, plus the venue's
 * single-counted total as one extra row (`scope = 'total'`).
 *
 * A fill's value is its OUT side, falling back to its IN side when the out asset
 * has no price. An asset's own volume is the value of ITS legs in the fill; when
 * those are unpriced it inherits the fill's value, so a fill between a priced and
 * an unpriced asset is not silently worth nothing on one side. An asset that
 * appears in a fill ONLY as a fee leg has no side and no volume — it must not
 * inherit the fill's value.
 *
 * The LRNA fee is the protocol fee. It is attributed to the fill's non-hub IN
 * asset — the asset that was sold into the hub, which is where the runtime charges
 * it — and to the OUT asset only when the fill's in-leg IS the hub.
 *
 * Fee legs are counted whatever their destination, INCLUDING burned ones: this
 * endpoint reports the fee a trade paid. The yield endpoints deliberately count
 * only non-burned legs, because those report what accrues to liquidity providers
 * (spec § Semantics 1 vs 3) — the two must not be quietly unified.
 *
 * The per-asset detail rides through the fill-level aggregation as an array and is
 * unpacked afterwards, so the leg scan, the deduplication and the price join happen
 * exactly once (see NEXT_FILL_WINDOW).
 */
export function buildOmnipoolVolumeSql(): string {
  return `-- pub:vol:omnipool
WITH ${legsCteSql("venue = 'omnipool'")},
${pricedCteSql()},
fill_asset AS (
  SELECT block_height, event_index, asset_id,
         maxIf(1, leg_kind = 'in') AS has_in,
         maxIf(1, leg_kind = 'out') AS has_out,
         sumIf(usd, leg_kind = 'in') AS leg_in_usd,
         sumIf(usd, leg_kind = 'out') AS leg_out_usd,
         sumIf(usd, leg_kind = 'fee') AS leg_fee_usd
  FROM priced
  GROUP BY block_height, event_index, asset_id
),
fill AS (
  SELECT block_height, event_index,
         sum(leg_out_usd) AS out_usd,
         sum(leg_in_usd) AS in_usd,
         if(out_usd > 0, out_usd, in_usd) AS fill_usd,
         maxIf(has_out, asset_id = ${LRNA_ASSET_ID}) AS out_hub,
         maxIf(has_in, asset_id = ${LRNA_ASSET_ID}) AS in_hub,
         anyIf(toNullable(asset_id), has_in = 1 AND asset_id != ${LRNA_ASSET_ID}) AS in_asset,
         anyIf(toNullable(asset_id), has_out = 1 AND asset_id != ${LRNA_ASSET_ID}) AS out_asset,
         sumIf(leg_fee_usd, asset_id = ${LRNA_ASSET_ID}) AS hub_fee_usd,
         groupArrayIf(tuple(asset_id, leg_in_usd + leg_out_usd, leg_fee_usd, greatest(has_in, has_out)),
                      asset_id != ${LRNA_ASSET_ID}) AS asset_parts
  FROM fill_asset
  GROUP BY block_height, event_index
),
flagged AS (
  SELECT block_height, event_index, fill_usd, out_hub, in_asset, out_asset, hub_fee_usd, asset_parts,
         any(in_hub) OVER nxt AS next_in_hub,
         any(event_index) OVER nxt AS next_event_index
  FROM fill
  ${NEXT_FILL_WINDOW}
),
emitted AS (
  SELECT arrayJoin(arrayConcat(
    arrayMap(p -> tuple('asset',
                        toNullable(tupleElement(p, 1)),
                        if(tupleElement(p, 4) = 0, toDecimal256(0, 12),
                           if(tupleElement(p, 2) > 0, tupleElement(p, 2), fill_usd)),
                        tupleElement(p, 3),
                        toDecimal256(0, 12)), asset_parts),
    [tuple('asset', coalesce(in_asset, out_asset), toDecimal256(0, 12), toDecimal256(0, 12), hub_fee_usd)],
    [tuple('total', CAST(NULL, 'Nullable(UInt32)'),
           if(${IS_FIRST_HOP}, toDecimal256(0, 12), fill_usd), toDecimal256(0, 12), toDecimal256(0, 12))]
  )) AS part
  FROM flagged
)
SELECT scope, ifNull(toString(asset_id), '') AS asset_id,
       toString(volume) AS volume_usd, toString(fee) AS fee_usd, toString(protocol_fee) AS protocol_fee_usd
FROM (
  SELECT tupleElement(part, 1) AS scope, tupleElement(part, 2) AS asset_id,
         sum(tupleElement(part, 3)) AS volume, sum(tupleElement(part, 4)) AS fee,
         sum(tupleElement(part, 5)) AS protocol_fee
  FROM emitted
  GROUP BY scope, asset_id
)
WHERE scope = 'total' OR asset_id IS NOT NULL
ORDER BY volume DESC, asset_id`
}

/**
 * Per-pool volume and fees for a keyed venue (stableswap pool id, XYK pool
 * account). One fill belongs to exactly one pool, so the venue total is the sum of
 * the rows and needs no separate scope. Fee legs include burned ones, as above.
 */
export function buildPoolVolumeSql(): string {
  return `-- pub:vol:pool
WITH ${legsCteSql('venue = {venue:String}')},
${pricedCteSql(['pool_key'])},
fill AS (
  SELECT pool_key, block_height, event_index,
         sumIf(usd, leg_kind = 'out') AS out_usd,
         sumIf(usd, leg_kind = 'in') AS in_usd,
         if(out_usd > 0, out_usd, in_usd) AS fill_usd,
         sumIf(usd, leg_kind = 'fee') AS fee_usd
  FROM priced
  GROUP BY pool_key, block_height, event_index
)
SELECT pool_key, toString(volume) AS volume_usd, toString(fee) AS fee_usd
FROM (
  SELECT pool_key, sum(fill_usd) AS volume, sum(fee_usd) AS fee
  FROM fill GROUP BY pool_key
)
ORDER BY volume DESC, pool_key`
}

/**
 * The netted-trade chain, from legs to one row per (day, trade, asset) net.
 *
 * The group is the Router operation the fill belongs to, scoped to its block. A
 * fill with no Router entry (a direct pallet swap, a block hook, or ANY fill of
 * the pre-Broadcast era, which carries no Router id at all) is its OWN trade:
 * keying those on the extrinsic would merge the independent trades a batch
 * dispatches, and pooling them under one empty key would net a third of the
 * chain's flow against itself.
 *
 * The ONE exception is the Omnipool's hub hop (see IS_FIRST_HOP): an unrouted
 * `A → LRNA` fill is not a trade, it is the first half of one, and it is keyed
 * onto its partner so the hub cancels in the net and the swap counts once. That
 * still keys per fill — it names the partner fill, never the extrinsic.
 *
 * Intermediate assets cancel inside a group because each asset's legs are netted
 * before the sides are taken, so a 3-hop route counts once, at its boundaries.
 *
 * `day` is the fill's UTC calendar day, and the four fee columns are the fill's
 * fee legs split by destination. Both ride along for the DefiLlama backfill; the
 * 24h routed total ignores them. They cost no extra rows: a trade lives inside
 * one block, so grouping by (day, trade_key) is grouping by trade_key, and the
 * per-fill fee totals are carried on the fill's FIRST net entry rather than on a
 * synthetic row of their own.
 *
 * Fee legs are never part of a side: `net_usd` counts in and out legs only, so no
 * fee can reach the volume total. That is not only a semantic choice — a
 * stableswap fee is already inside the trade's own amounts (subtracted from the
 * out side on a sell, included in the in side on a buy), so adding fee legs to
 * trade legs would count the same value twice.
 *
 * `all_aave` marks a trade whose every fill is an `aave` leg — an aToken
 * mint/redeem, which is a 1:1 money-market wrap and not a swap. Consumers that
 * publish DEX volume drop those groups with `HAVING min(all_aave) = 0` at their
 * trade-level stage; the flag rides here rather than in a leg filter because an
 * aave leg INSIDE a routed trade is a real hop of a real swap and already
 * cancels in the per-asset net, so only whole-group wraps may be removed.
 */
export function routedNettedCteSql(timePredicate?: string, priceSource?: string): string {
  const zero = 'toDecimal256(0, 12)'
  return `${legsCteSql('1', timePredicate)},
${pricedCteSql(['op_key', 'venue', 'fee_dest', 'block_time'], priceSource)},
fill_asset AS (
  SELECT block_height, event_index, asset_id,
         any(op_key) AS op_key, any(venue) AS venue, min(block_time) AS block_time,
         maxIf(1, leg_kind = 'in') AS has_in,
         maxIf(1, leg_kind = 'out') AS has_out,
         sum(multiIf(leg_kind = 'out', usd, leg_kind = 'in', -usd, ${zero})) AS net_usd,
         sumIf(usd, leg_kind = 'fee') AS fee_total,
         sumIf(usd, leg_kind = 'fee' AND fee_dest = 'account') AS fee_account,
         sumIf(usd, leg_kind = 'fee' AND fee_dest = 'burned') AS fee_burned,
         sumIf(usd, leg_kind = 'fee' AND fee_dest = '') AS fee_unknown,
         sumIf(usd, leg_kind = 'fee' AND asset_id = ${LRNA_ASSET_ID}) AS fee_hub
  FROM priced
  GROUP BY block_height, event_index, asset_id
),
fill AS (
  SELECT block_height, event_index, any(op_key) AS op_key, any(venue) AS venue,
         toDate(min(block_time), 'UTC') AS day,
         maxIf(has_out, asset_id = ${LRNA_ASSET_ID}) AS out_hub,
         maxIf(has_in, asset_id = ${LRNA_ASSET_ID}) AS in_hub,
         sum(fee_total) AS fee_total, sum(fee_account) AS fee_account, sum(fee_burned) AS fee_burned,
         sum(fee_unknown) AS fee_unknown, sum(fee_hub) AS fee_hub,
         groupArray(tuple(asset_id, net_usd)) AS nets
  FROM fill_asset
  GROUP BY block_height, event_index
),
flagged AS (
  SELECT block_height, event_index, op_key, venue, day, out_hub, nets,
         fee_total, fee_account, fee_burned, fee_unknown, fee_hub,
         any(in_hub) OVER nxt AS next_in_hub,
         any(event_index) OVER nxt AS next_event_index,
         any(venue) OVER nxt AS next_venue
  FROM fill
  ${NEXT_FILL_WINDOW}
),
keyed AS (
  SELECT day, venue = 'aave' AS is_aave,
         if(op_key != '', concat('r:', toString(block_height), ':', op_key),
            concat('f:', toString(block_height), ':',
                   toString(if(venue = 'omnipool' AND next_venue = 'omnipool' AND ${IS_FIRST_HOP},
                               event_index + 1, event_index)))) AS trade_key,
         arrayJoin(arrayMap((n, i) -> tuple(tupleElement(n, 1), tupleElement(n, 2),
                                            if(i = 1, fee_total, ${zero}),
                                            if(i = 1, fee_account, ${zero}),
                                            if(i = 1, fee_burned, ${zero}),
                                            if(i = 1, fee_unknown, ${zero}),
                                            if(i = 1, fee_hub, ${zero})),
                            nets, arrayEnumerate(nets))) AS leg
  FROM flagged
),
netted AS (
  SELECT day, trade_key, tupleElement(leg, 1) AS asset_id,
         min(is_aave) AS all_aave,
         sum(tupleElement(leg, 2)) AS net_usd,
         sum(tupleElement(leg, 3)) AS fee_total,
         sum(tupleElement(leg, 4)) AS fee_account,
         sum(tupleElement(leg, 5)) AS fee_burned,
         sum(tupleElement(leg, 6)) AS fee_unknown,
         sum(tupleElement(leg, 7)) AS fee_hub
  FROM keyed
  GROUP BY day, trade_key, asset_id
)`
}

/**
 * One row per routed trade, as the two boundary sums the netting rule compares.
 *
 * Trades whose every fill is an aToken wrap are dropped (see `all_aave`): this
 * total is published as DEX volume, and a money-market deposit is not a trade.
 */
export function buildRoutedTradesSql(): string {
  return `-- pub:vol:routed
WITH ${routedNettedCteSql()}
SELECT toString(side_in) AS in_usd, toString(side_out) AS out_usd
FROM (
  SELECT trade_key,
         sum(greatest(-net_usd, toDecimal256(0, 12))) AS side_in,
         sum(greatest(net_usd, toDecimal256(0, 12))) AS side_out
  FROM netted
  GROUP BY trade_key
  HAVING min(all_aave) = 0
)
WHERE side_in > 0 OR side_out > 0`
}

/**
 * The newest indexed LEG — the window anchor for every surface built on this
 * model.
 *
 * It must be the newest leg and never the newest BLOCK. A block is indexed before
 * the materialized view has projected its legs, so while the MV catches up the
 * blocks head runs ahead of the leg model: anchoring there would extend every
 * rolling window over hours that hold no legs yet and report the resulting
 * undercount as a full 24h. The leg head cannot outrun the legs by construction,
 * so a lag shortens nothing — it just holds the anchor still until the MV
 * arrives. (The DefiLlama backfill applies the same rule to its closed-day cut,
 * in services/defillama.ts.)
 *
 * Both reads are metadata, not scans, which is what makes the correct form also
 * the cheap one. MEASURED against the 65.4 M-leg table: 16 577 rows / 20 KiB /
 * 7 ms for the whole query. `max(block_timestamp)` alone is 159 rows / 3.73 KiB /
 * 2 ms because it is the partition key; the height is then a point read at that
 * exact timestamp (186 rows / 3 ms), which names the block of the newest leg.
 * Only a bare `max(block_height)` over the table is expensive — block_height is
 * not a leading sort key, and that single column is what once made this query
 * read all 54.9 M rows (419 MiB) per cold key.
 *
 * The one-row leg probe preserves the empty-model contract without a full count.
 */
const ANCHOR_SQL = `-- pub:vol:anchor
WITH (SELECT max(block_timestamp) FROM price_data.pool_swap_legs) AS leg_head
SELECT (SELECT count() FROM (SELECT 1 FROM price_data.pool_swap_legs LIMIT 1)) AS legs,
       toString(leg_head) AS anchor,
       (SELECT max(block_height) FROM price_data.pool_swap_legs WHERE block_timestamp = leg_head) AS block_height`

interface AnchorRow { legs: string | number; anchor: string; block_height: string | number }
export interface Anchor { anchor: string; blockHeight: number }

export async function readAnchor(client: ClickHouseClient): Promise<Anchor | null> {
  const res = await client.query({ query: ANCHOR_SQL, format: 'JSONEachRow', clickhouse_settings: DECIMAL_STRINGS })
  const [row] = await res.json<AnchorRow>()
  // An empty projection has a max() of the epoch; report "no data" instead of
  // publishing 1970 as the anchor of an empty window.
  if (!row || Number(row.legs) === 0) return null
  return { anchor: row.anchor, blockHeight: Number(row.block_height) }
}

interface OmnipoolRow { scope: string; asset_id: string; volume_usd: string; fee_usd: string; protocol_fee_usd: string }
interface PoolRow { pool_key: string; volume_usd: string; fee_usd: string }
interface RoutedRow { in_usd: string; out_usd: string }

const EMPTY = <T>(): VolumeSummary<T> => ({ asOf: null, blockHeight: null, totalVolumeUsd: renderUsd(0n), items: [] })

/** Per-asset Omnipool volume over the window. Cached with the endpoint's own freshness. */
export async function omnipoolVolumes(client: ClickHouseClient, window: VolumeWindow): Promise<VolumeSummary<OmnipoolVolumeItem>> {
  return cachedSwr(`pub:vol:omnipool:${window}`, 60_000, 300_000, async () => {
    const at = await readAnchor(client)
    if (!at) return EMPTY<OmnipoolVolumeItem>()
    const res = await client.query({
      query: buildOmnipoolVolumeSql(),
      query_params: { anchor: at.anchor, hours: WINDOW_HOURS[window] },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const rows = await res.json<OmnipoolRow>()
    const total = scaledUsd(rows.find(r => r.scope === 'total')?.volume_usd ?? '0')
    warnIfNothingPriced('omnipool', window, rows.filter(r => r.scope === 'asset').length, total)
    return {
      asOf: iso(at.anchor),
      blockHeight: at.blockHeight,
      totalVolumeUsd: renderUsd(total),
      items: rows.filter(r => r.scope === 'asset').map(r => ({
        assetId: r.asset_id,
        volumeUsd: usdString(r.volume_usd),
        feeUsd: usdString(r.fee_usd),
        protocolFeeUsd: usdString(r.protocol_fee_usd),
      })),
    }
  })
}

/** Per-pool volume for a keyed venue. The whole venue is one cache entry; callers filter. */
export async function poolVolumes(client: ClickHouseClient, venue: PoolVenue, window: VolumeWindow): Promise<VolumeSummary<PoolVolumeItem>> {
  return cachedSwr(`pub:vol:${venue}:${window}`, 60_000, 300_000, async () => {
    const at = await readAnchor(client)
    if (!at) return EMPTY<PoolVolumeItem>()
    const res = await client.query({
      query: buildPoolVolumeSql(),
      query_params: { anchor: at.anchor, hours: WINDOW_HOURS[window], venue },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const rows = await res.json<PoolRow>()
    let total = 0n
    const items = rows.map(r => {
      total += scaledUsd(r.volume_usd)
      return { poolKey: r.pool_key, volumeUsd: usdString(r.volume_usd), feeUsd: usdString(r.fee_usd) }
    })
    warnIfNothingPriced(venue, window, items.length, total)
    return { asOf: iso(at.anchor), blockHeight: at.blockHeight, totalVolumeUsd: renderUsd(total), items }
  })
}

/**
 * The platform's netted 24h flow: every routed trade counted once, at the larger
 * of its two boundary sides. Per-venue sums legitimately exceed it — a two-hop
 * route is one trade but two fills.
 *
 * One row per trade crosses the wire so the netting rule has a single tested
 * definition (nettedTradeScaled) instead of one in SQL and one in TS. That is 6 790
 * rows for a measured 24-hour window, inside the client's 100 000-row cap — which a
 * 7-day window exceeds (100 580 rows, measured), hence RoutedWindow. Widening it
 * further means moving the fold into the query.
 */
export async function routedTradesUsd(client: ClickHouseClient, window: RoutedWindow): Promise<{ asOf: string | null; blockHeight: number | null; totalUsd: string }> {
  return cachedSwr(`pub:vol:routed:${window}`, 60_000, 300_000, async () => {
    const at = await readAnchor(client)
    if (!at) return { asOf: null, blockHeight: null, totalUsd: renderUsd(0n) }
    const res = await client.query({
      query: buildRoutedTradesSql(),
      query_params: { anchor: at.anchor, hours: WINDOW_HOURS[window] },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    let total = 0n
    for (const row of await res.json<RoutedRow>()) total += nettedTradeScaled(row.in_usd, row.out_usd)
    return { asOf: iso(at.anchor), blockHeight: at.blockHeight, totalUsd: renderUsd(total) }
  })
}

interface XykRegistryRow { pool_account: string; lp_asset_id: number; asset_a: number; asset_b: number; created_block: number }

/**
 * The pair and share token behind each XYK pool account. A pair account can be
 * reused across destroy/recreate cycles, so the live incarnation is the newest
 * registry row for the account — the same rule poolService applies.
 */
export async function xykPoolMeta(client: ClickHouseClient): Promise<Map<string, XykPoolMeta>> {
  return cachedSwr('pub:vol:xyk-pools', 300_000, 900_000, async () => {
    const res = await client.query({
      query: `-- pub:vol:xyk-pools
SELECT pool_account, lp_asset_id, asset_a, asset_b, created_block
FROM price_data.xyk_pool_registry FINAL`,
      format: 'JSONEachRow',
    })
    const newest = new Map<string, XykRegistryRow>()
    for (const row of await res.json<XykRegistryRow>()) {
      const prev = newest.get(row.pool_account)
      if (!prev || row.created_block > prev.created_block) newest.set(row.pool_account, row)
    }
    // The registry's ids are Int32 and a pool recorded before its share token
    // existed carries a negative one. Those are not registry ids, so they are
    // reported as unknown rather than as an id no consumer can resolve.
    const registryId = (id: number): string | null => (Number.isInteger(id) && id >= 0 ? String(id) : null)
    return new Map([...newest].map(([account, row]) => [account, {
      shareTokenId: registryId(row.lp_asset_id),
      assetA: registryId(row.asset_a),
      assetB: registryId(row.asset_b),
    }]))
  })
}
