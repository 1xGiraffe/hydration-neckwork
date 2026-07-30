import { type ClickHouseClient } from '../db/client.js'
import { type IndexerStateRow } from '../db/schema.js'
import { toClickHouseDateTime64 } from '../db/timestamp.js'
import { escapeSqlString } from '../db/sql.js'

export interface IndexerCheckpointState {
  lastBlock: number
}

export async function getLastProcessedBlock(client: ClickHouseClient, id = 'main'): Promise<IndexerCheckpointState> {
  const result = await client.query({
    query: `SELECT last_block FROM price_data.indexer_state FINAL WHERE id = '${escapeSqlString(id)}'`,
    format: 'JSONEachRow',
  })

  const rows = await result.json<IndexerStateRow>()

  if (rows.length === 0) {
    return { lastBlock: 0 }
  }

  return { lastBlock: rows[0].last_block }
}

// ReplacingMergeTree handles deduplication based on updated_at.
export async function saveCheckpoint(client: ClickHouseClient, blockHeight: number, id = 'main'): Promise<void> {
  await client.insert({
    table: 'price_data.indexer_state',
    values: [{ id, last_block: blockHeight, updated_at: toClickHouseDateTime64() }],
    format: 'JSONEachRow',
  })
}
