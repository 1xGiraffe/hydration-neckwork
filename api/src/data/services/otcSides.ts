import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { liveHeadTag } from './head.ts'

/**
 * Which account was the taker and which the maker of each OTC fill.
 *
 * `pool_swap_legs.swapper` cannot answer this. It carries the Broadcast event's
 * `swapper`, which for an OTC fill names the order's MAKER in 620 of the 796
 * fills on chain and the taker in the other 176 — while the legs the same row
 * describes are ALWAYS the taker's direction. So a fill's stored swapper is one
 * of the two counterparties, but which one is not knowable from the row.
 *
 * What resolves it is the OTC pallet's own fill event, which sits at exactly
 * `event_index - 1` and names the taker as `who`; the taker is always one of
 * {swapper, filler}, so the maker is the other. That is a cross-ROW lookup, which
 * the insert-triggered `pool_swap_legs_mv` cannot do — hence this index rather
 * than a corrected column. The rule itself is the one the indexer applies
 * (src/blocks/otcCounterparty.ts).
 *
 * The whole set is loaded at once because it is tiny and bounded by governance
 * rather than by traffic: OTC orders are placed by hand, and the entire history
 * of the chain holds 796 fills. One query, ~800 rows, so every fill on a page
 * resolves without a per-request read. Keyed on the indexed head so a fill
 * indexed a moment ago is not served from a stale index.
 */
export interface OtcFillSides {
  /** Fill identity: `${blockHeight}:${eventIndex}` of the Broadcast event. */
  key: string
  blockHeight: number
  eventIndex: number
  /** The account that hit the resting order — whose direction the legs describe. */
  taker: string
  /** The order's owner, who took the mirror of those legs. */
  maker: string
}

export interface OtcSideIndex {
  byFill: Map<string, OtcFillSides>
  /** Every fill an account took part in, on either side. */
  byAccount: Map<string, OtcFillSides[]>
}

const TTL_MS = 60_000

export function fillKey(blockHeight: number | string, eventIndex: number | string): string {
  return `${blockHeight}:${eventIndex}`
}

export async function otcSideIndex(client: ClickHouseClient): Promise<OtcSideIndex> {
  const head = await liveHeadTag(client)
  return cached(`data:otc-sides:${head}`, TTL_MS, () => load(client))
}

async function load(client: ClickHouseClient): Promise<OtcSideIndex> {
  const res = await client.query({
    query: `-- data:otc-sides
      SELECT b.block_height AS block_height, b.event_index AS event_index,
             f.taker AS taker,
             if(f.taker = b.swapper, b.filler_account, b.swapper) AS maker
      FROM (
        SELECT block_height, event_index,
               JSONExtractString(args_json, 'swapper') AS swapper,
               JSONExtractString(args_json, 'filler') AS filler_account
        FROM price_data.raw_events
        WHERE event_name IN ('Broadcast.Swapped', 'Broadcast.Swapped2', 'Broadcast.Swapped3')
          AND JSONExtractString(args_json, 'fillerType', '__kind') = 'OTC'
      ) AS b
      INNER JOIN (
        SELECT block_height, event_index + 1 AS bc_index, JSONExtractString(args_json, 'who') AS taker
        FROM price_data.raw_events
        WHERE event_name IN ('OTC.Filled', 'OTC.PartiallyFilled')
      ) AS f ON f.block_height = b.block_height AND f.bc_index = b.event_index
      -- A taker that is neither account the Broadcast names would leave the sides
      -- unresolved; measured 0 of 796, and excluded here so a reader never has to
      -- consider a half-resolved fill.
      WHERE f.taker IN (b.swapper, b.filler_account) AND maker != ''`,
    format: 'JSONEachRow',
  })
  const byFill = new Map<string, OtcFillSides>()
  const byAccount = new Map<string, OtcFillSides[]>()
  for (const row of await res.json<{ block_height: number | string; event_index: number | string; taker: string; maker: string }>()) {
    const blockHeight = Number(row.block_height)
    const eventIndex = Number(row.event_index)
    const sides: OtcFillSides = {
      key: fillKey(blockHeight, eventIndex),
      blockHeight,
      eventIndex,
      taker: row.taker.toLowerCase(),
      maker: row.maker.toLowerCase(),
    }
    byFill.set(sides.key, sides)
    for (const account of new Set([sides.taker, sides.maker])) {
      const bucket = byAccount.get(account)
      if (bucket) bucket.push(sides)
      else byAccount.set(account, [sides])
    }
  }
  return { byFill, byAccount }
}
