import { type ClickHouseClient } from '../db/client.js'
import { BatchAccumulator } from '../store/batch.js'
import { getRawIngestionState, saveRawCheckpoint } from './checkpoint.js'
import type {
  RawBlockRow,
  RawBlockSnapshotRow,
  RawCallRow,
  RawEventRow,
  RawExtrinsicRow,
} from './types.js'

function minMax(rows: { block_height: number }[]): { min: number; max: number } {
  let min = rows[0].block_height
  let max = rows[0].block_height

  for (let i = 1; i < rows.length; i++) {
    const height = rows[i].block_height
    if (height < min) min = height
    if (height > max) max = height
  }

  return { min, max }
}

export class RawClickHouseStore {
  private readonly client: ClickHouseClient
  private readonly blocksBatch: BatchAccumulator<RawBlockRow>
  private readonly extrinsicsBatch: BatchAccumulator<RawExtrinsicRow>
  private readonly callsBatch: BatchAccumulator<RawCallRow>
  private readonly eventsBatch: BatchAccumulator<RawEventRow>
  private readonly snapshotsBatch: BatchAccumulator<RawBlockSnapshotRow>
  private replayNamespace: string

  constructor(client: ClickHouseClient, flushThreshold: number = 10_000, replayNamespace: string = 'bootstrap') {
    this.client = client
    this.blocksBatch = new BatchAccumulator<RawBlockRow>(flushThreshold)
    this.extrinsicsBatch = new BatchAccumulator<RawExtrinsicRow>(flushThreshold)
    this.callsBatch = new BatchAccumulator<RawCallRow>(flushThreshold)
    this.eventsBatch = new BatchAccumulator<RawEventRow>(flushThreshold)
    this.snapshotsBatch = new BatchAccumulator<RawBlockSnapshotRow>(flushThreshold)
    this.replayNamespace = replayNamespace
  }

  addBlocks(rows: RawBlockRow[]): void {
    this.blocksBatch.add(rows)
  }

  addExtrinsics(rows: RawExtrinsicRow[]): void {
    this.extrinsicsBatch.add(rows)
  }

  addCalls(rows: RawCallRow[]): void {
    this.callsBatch.add(rows)
  }

  addEvents(rows: RawEventRow[]): void {
    this.eventsBatch.add(rows)
  }

  addSnapshots(rows: RawBlockSnapshotRow[]): void {
    this.snapshotsBatch.add(rows)
  }

  async flushBlocks(): Promise<void> {
    const rows = this.blocksBatch.flush()
    if (rows.length === 0) return

    const { min, max } = minMax(rows)
    await this.client.insert({
      table: 'price_data.raw_blocks',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: `raw-blocks-${this.replayNamespace}-${min}-${max}-${rows.length}`,
      },
    })
  }

  async flushExtrinsics(): Promise<void> {
    const rows = this.extrinsicsBatch.flush()
    if (rows.length === 0) return

    const { min, max } = minMax(rows)
    await this.client.insert({
      table: 'price_data.raw_extrinsics',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: `raw-extrinsics-${this.replayNamespace}-${min}-${max}-${rows.length}`,
      },
    })
  }

  async flushCalls(): Promise<void> {
    const rows = this.callsBatch.flush()
    if (rows.length === 0) return

    const { min, max } = minMax(rows)
    await this.client.insert({
      table: 'price_data.raw_calls',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: `raw-calls-${this.replayNamespace}-${min}-${max}-${rows.length}`,
      },
    })
  }

  async flushEvents(): Promise<void> {
    const rows = this.eventsBatch.flush()
    if (rows.length === 0) return

    const { min, max } = minMax(rows)
    await this.client.insert({
      table: 'price_data.raw_events',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: `raw-events-${this.replayNamespace}-${min}-${max}-${rows.length}`,
      },
    })
  }

  async flushSnapshots(): Promise<void> {
    const rows = this.snapshotsBatch.flush()
    if (rows.length === 0) return

    const { min, max } = minMax(rows)
    await this.client.insert({
      table: 'price_data.raw_block_snapshots',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: `raw-snapshots-${this.replayNamespace}-${min}-${max}-${rows.length}`,
      },
    })
  }

  async flushAll(): Promise<void> {
    await this.flushBlocks()
    await this.flushExtrinsics()
    await this.flushCalls()
    await this.flushEvents()
    await this.flushSnapshots()
  }

  async saveCheckpoint(pipelineId: string, blockHeight: number, blockHash: string, mode: string): Promise<void> {
    this.replayNamespace = await saveRawCheckpoint(this.client, pipelineId, blockHeight, blockHash, mode)
  }

  setReplayNamespace(replayNamespace: string): void {
    this.replayNamespace = replayNamespace
  }

  async getIngestionState(pipelineId: string): Promise<import('./checkpoint.js').RawCheckpointState> {
    return getRawIngestionState(this.client, pipelineId)
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
