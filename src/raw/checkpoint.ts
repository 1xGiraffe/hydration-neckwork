import { type ClickHouseClient } from '../db/client.js'
import { toClickHouseDateTime64 } from '../db/timestamp.js'
import { escapeSqlString } from '../db/sql.js'
import { type RawIngestionStateRow } from './types.js'

export interface RawCheckpointState {
  height: number
  hash: string
  hasCheckpoint: boolean
}

export async function getRawIngestionState(
  client: ClickHouseClient,
  pipelineId: string
): Promise<RawCheckpointState> {
  const result = await client.query({
    query: `
      SELECT last_block, last_hash
      FROM price_data.raw_ingestion_state FINAL
      WHERE pipeline_id = '${escapeSqlString(pipelineId)}'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    format: 'JSONEachRow',
  })

  const rows = await result.json<Pick<RawIngestionStateRow, 'last_block' | 'last_hash'>>()
  if (rows.length === 0) {
    return { height: 0, hash: '0x', hasCheckpoint: false }
  }

  return {
    height: rows[0].last_block,
    hash: rows[0].last_hash,
    hasCheckpoint: true,
  }
}

export async function saveRawCheckpoint(
  client: ClickHouseClient,
  pipelineId: string,
  blockHeight: number,
  blockHash: string,
  mode: string
): Promise<void> {
  await client.insert({
    table: 'price_data.raw_ingestion_state',
    values: [{
      pipeline_id: pipelineId,
      last_block: blockHeight,
      last_hash: blockHash,
      mode,
      updated_at: toClickHouseDateTime64(),
    }],
    format: 'JSONEachRow',
  })
}
