import { type ClickHouseClient } from '../db/client.js'
import { toClickHouseDateTime64 } from '../db/timestamp.js'
import { escapeSqlString } from '../db/sql.js'
import { type RawIngestionStateRow } from './types.js'

export interface RawCheckpointState {
  height: number
  hash: string
  replayNamespace: string
  hasCheckpoint: boolean
}

function buildReplayNamespace(
  pipelineId: string,
  blockHeight: number,
  blockHash: string,
  updatedAt: string,
): string {
  return `${pipelineId}@${blockHeight}@${blockHash}@${updatedAt}`
}

export async function getRawIngestionState(
  client: ClickHouseClient,
  pipelineId: string
): Promise<RawCheckpointState> {
  const result = await client.query({
    query: `
      SELECT last_block, last_hash, updated_at
      FROM price_data.raw_ingestion_state FINAL
      WHERE pipeline_id = '${escapeSqlString(pipelineId)}'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    format: 'JSONEachRow',
  })

  const rows = await result.json<Pick<RawIngestionStateRow, 'last_block' | 'last_hash' | 'updated_at'>>()
  if (rows.length === 0) {
    return {
      height: 0,
      hash: '0x',
      replayNamespace: buildReplayNamespace(pipelineId, 0, '0x', '1970-01-01 00:00:00'),
      hasCheckpoint: false,
    }
  }

  const updatedAt = rows[0].updated_at ?? '1970-01-01 00:00:00'

  return {
    height: rows[0].last_block,
    hash: rows[0].last_hash,
    replayNamespace: buildReplayNamespace(pipelineId, rows[0].last_block, rows[0].last_hash, updatedAt),
    hasCheckpoint: true,
  }
}

export async function saveRawCheckpoint(
  client: ClickHouseClient,
  pipelineId: string,
  blockHeight: number,
  blockHash: string,
  mode: string
): Promise<string> {
  const updatedAt = toClickHouseDateTime64()
  await client.insert({
    table: 'price_data.raw_ingestion_state',
    values: [{
      pipeline_id: pipelineId,
      last_block: blockHeight,
      last_hash: blockHash,
      mode,
      updated_at: updatedAt,
    }],
    format: 'JSONEachRow',
  })

  return buildReplayNamespace(pipelineId, blockHeight, blockHash, updatedAt)
}
