import { type ClickHouseClient } from '../db/client.js'
import { type IndexerStateRow } from '../db/schema.js'

export async function getLastProcessedBlock(client: ClickHouseClient): Promise<number> {
  const result = await client.query({
    query: "SELECT last_block FROM price_data.indexer_state FINAL WHERE id = 'main'",
    format: 'JSONEachRow',
  })

  const rows = await result.json<IndexerStateRow>()

  if (rows.length === 0) {
    return 0
  }

  return rows[0].last_block
}

// ReplacingMergeTree handles deduplication based on updated_at.
export async function saveCheckpoint(client: ClickHouseClient, blockHeight: number): Promise<void> {
  await client.insert({
    table: 'price_data.indexer_state',
    values: [{ id: 'main', last_block: blockHeight }],
    format: 'JSONEachRow',
  })
}
