import type { ClickHouseClient } from '../../db/client.ts'
import { liquidityLegAssetIds, matchLiquidityAmounts, missingLiquidityAmounts, type LiquidityAmountCandidate, type LiquidityTransferLeg } from '../../services/liquidityLegs.ts'

// Page-scoped recovery of the amounts a pallet liquidity event does not state.
// liquidity_activity keeps only the figure an event carries in its own asset's
// denomination: an Omnipool removal names shares, an XYK removal only shares, an
// XYK add its two amounts under amountA/amountB (the projection keeps amountA
// alone), so those rows arrive amountless and the real figure is the pool↔who
// transfer leg beside the event. One primary-key read of the page's legs from
// transfer_activity_by_time ((block_height, event_index) is its ORDER BY; ≤ the
// page's distinct blocks), in the rows' own assets only, then the explorer's own
// matcher (services/liquidityLegs.ts) pairs them by dispatch scope and adjacency —
// an XYK add or removal takes BOTH legs against one pool account, into `amount`
// (assetA's) and `amount_b` (assetB's). A row whose leg is not there stays
// amountless: null on the wire, never a guess.
export async function fillLiquidityAmounts(client: ClickHouseClient, rows: LiquidityAmountCandidate[]): Promise<void> {
  const missing = missingLiquidityAmounts(rows)
  if (!missing.length) return
  // Signed actions scope to their extrinsic; a runtime-hook dispatch (an Omnipool
  // asset being offboarded) carries no extrinsic and scopes to the block's
  // out-of-extrinsic legs.
  const signed = new Map<string, { block: number; extrinsic: number }>()
  const hookBlocks = new Set<number>()
  for (const row of missing) {
    if (row.extrinsic_index == null) hookBlocks.add(row.block_height)
    else signed.set(`${row.block_height}:${row.extrinsic_index}`, { block: row.block_height, extrinsic: row.extrinsic_index })
  }
  const pairs = [...signed.values()]
  // Every predicate in ONE clause: an explicit PREWHERE beside a separate WHERE
  // returns a per-part subset on this ClickHouse.
  const res = await client.query({
    query: `-- data:enrich:liquidity-legs
        SELECT block_height, event_index, extrinsic_index, asset_id, from_account, to_account, amount
        FROM price_data.transfer_activity_by_time
        WHERE block_height IN {blocks:Array(UInt32)}
          AND ((block_height, extrinsic_index) IN arrayZip({bs:Array(UInt32)}, {es:Array(UInt32)})
            OR (block_height IN {hs:Array(UInt32)} AND extrinsic_index IS NULL))
          AND asset_id IN {assets:Array(UInt32)}`,
    query_params: {
      blocks: [...new Set(missing.map(row => row.block_height))],
      bs: pairs.map(pair => pair.block),
      es: pairs.map(pair => pair.extrinsic),
      hs: [...hookBlocks],
      assets: liquidityLegAssetIds(missing),
    },
    format: 'JSONEachRow',
  })
  matchLiquidityAmounts(missing, await res.json<LiquidityTransferLeg>())
}
