import { type ClickHouseClient } from '../db/client.js'
import { type IndexerStateRow } from '../db/schema.js'
import { toClickHouseDateTime64 } from '../db/timestamp.js'
import { escapeSqlString } from '../db/sql.js'

export interface IndexerCheckpointState {
  lastBlock: number
  replayNamespace: string
}

function buildReplayNamespace(blockHeight: number, updatedAt: string): string {
  return `${blockHeight}@${updatedAt}`
}

export async function getLastProcessedBlock(client: ClickHouseClient, id = 'main'): Promise<IndexerCheckpointState> {
  const result = await client.query({
    query: `SELECT last_block, updated_at FROM price_data.indexer_state FINAL WHERE id = '${escapeSqlString(id)}'`,
    format: 'JSONEachRow',
  })

  const rows = await result.json<IndexerStateRow>()

  if (rows.length === 0) {
    return {
      lastBlock: 0,
      replayNamespace: buildReplayNamespace(0, '1970-01-01 00:00:00'),
    }
  }

  const updatedAt = rows[0].updated_at ?? '1970-01-01 00:00:00'

  return {
    lastBlock: rows[0].last_block,
    replayNamespace: buildReplayNamespace(rows[0].last_block, updatedAt),
  }
}

// ReplacingMergeTree handles deduplication based on updated_at.
export async function saveCheckpoint(client: ClickHouseClient, blockHeight: number, id = 'main'): Promise<string> {
  const updatedAt = toClickHouseDateTime64()
  await client.insert({
    table: 'price_data.indexer_state',
    values: [{ id, last_block: blockHeight, updated_at: updatedAt }],
    format: 'JSONEachRow',
  })

  return buildReplayNamespace(blockHeight, updatedAt)
}
