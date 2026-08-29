import type { ClickHouseClient } from '../../db/client.ts'

// Page-scoped extrinsic-hash enrichment: every surface that names an
// extrinsicIndex also carries the extrinsicHash, and none of the projections
// store it — so each page resolves its distinct (block, index) pairs with ONE
// primary-key IN read on raw_extrinsics ((block_height, extrinsic_index) is
// its ORDER BY; ≤100 point keys per page). The hash is identical across
// replayed row versions, so no FINAL and no version tie-break is needed.

export interface ExtrinsicPosition { blockHeight: number; extrinsicIndex: number }

// The enriched shape every event/leg item takes on its way to the wire.
export type WithExtrinsicHash<T> = T & { extrinsicHash: string | null }

export const extrinsicPairKey = (blockHeight: number, extrinsicIndex: number): string => `${blockHeight}:${extrinsicIndex}`

export async function extrinsicHashesFor(client: ClickHouseClient, positions: Array<ExtrinsicPosition | null | undefined>): Promise<Map<string, string>> {
  const wanted = new Map<string, ExtrinsicPosition>()
  for (const position of positions) {
    if (!position) continue
    wanted.set(extrinsicPairKey(position.blockHeight, position.extrinsicIndex), position)
  }
  if (wanted.size === 0) return new Map()
  const pairs = [...wanted.values()]
  const res = await client.query({
    query: `-- data:enrich:extrinsic-hashes
        SELECT block_height, extrinsic_index, lower(extrinsic_hash) AS hash
        FROM price_data.raw_extrinsics
        WHERE (block_height, extrinsic_index) IN arrayZip({bs:Array(UInt32)}, {es:Array(UInt32)})`,
    query_params: {
      bs: pairs.map(pair => pair.blockHeight),
      es: pairs.map(pair => pair.extrinsicIndex),
    },
    format: 'JSONEachRow',
  })
  const out = new Map<string, string>()
  for (const row of await res.json<{ block_height: number; extrinsic_index: number; hash: string }>()) {
    out.set(extrinsicPairKey(Number(row.block_height), Number(row.extrinsic_index)), row.hash)
  }
  return out
}

// The common application: items carrying a nullable extrinsicIndex gain a
// nullable extrinsicHash (null for block-hook rows, and — defensively — for a
// position the extrinsics table does not hold).
export async function attachExtrinsicHashes<T extends { blockHeight: number; extrinsicIndex: number | null }>(
  client: ClickHouseClient,
  items: T[],
): Promise<Array<T & { extrinsicHash: string | null }>> {
  const hashes = await extrinsicHashesFor(
    client,
    items.map(item => (item.extrinsicIndex == null ? null : { blockHeight: item.blockHeight, extrinsicIndex: item.extrinsicIndex })),
  )
  return items.map(item => ({
    ...item,
    extrinsicHash: item.extrinsicIndex == null ? null : hashes.get(extrinsicPairKey(item.blockHeight, item.extrinsicIndex)) ?? null,
  }))
}
