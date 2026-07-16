import { type ClickHouseClient } from '../db/client.js'
import { BatchAccumulator } from '../store/batch.js'
import { buildInsertDedupeToken } from '../store/dedupeToken.js'
import { integerFromEnvironment } from '../util/env.js'
import { blockHeightRange } from '../util/collections.js'
import { getRawIngestionState, saveRawCheckpoint } from './checkpoint.js'
import {
  finalizeRawRange,
  markRawRangeFailed,
  markRawRangeRunning,
} from './ranges.js'
import type {
  RawAccountAliasRow,
  RawBalanceObservationRow,
  RawBridgeEvidenceRow,
  RawBlockRow,
  RawBlockSnapshotRow,
  RawCallRow,
  RawEvmLogRow,
  RawEventRow,
  RawExtrinsicRow,
  RawMoneyMarketEventRow,
  RawMoneyMarketPositionRow,
  RawMoneyMarketReserveRow,
  RawOperationTraceRow,
  RawParserWarningRow,
  RawXcmActivityRow,
} from './types.js'

function chunkSizeForBalanceObservations(): number {
  return Math.min(integerFromEnvironment('RAW_BALANCE_INSERT_CHUNK_SIZE', 5_000), 50_000)
}

function maxBytesForBalanceObservationInsert(): number {
  return integerFromEnvironment('RAW_BALANCE_INSERT_MAX_BYTES', 64 * 1024 * 1024)
}

function jsonRowBytes(row: unknown): number {
  return Buffer.byteLength(JSON.stringify(row)) + 1
}

export class RawClickHouseStore {
  private readonly client: ClickHouseClient
  private readonly blocksBatch: BatchAccumulator<RawBlockRow>
  private readonly extrinsicsBatch: BatchAccumulator<RawExtrinsicRow>
  private readonly callsBatch: BatchAccumulator<RawCallRow>
  private readonly eventsBatch: BatchAccumulator<RawEventRow>
  private readonly snapshotsBatch: BatchAccumulator<RawBlockSnapshotRow>
  private readonly accountAliasesBatch: BatchAccumulator<RawAccountAliasRow>
  private readonly balanceObservationsBatch: BatchAccumulator<RawBalanceObservationRow>
  private readonly evmLogsBatch: BatchAccumulator<RawEvmLogRow>
  private readonly moneyMarketEventsBatch: BatchAccumulator<RawMoneyMarketEventRow>
  private readonly moneyMarketPositionsBatch: BatchAccumulator<RawMoneyMarketPositionRow>
  private readonly moneyMarketReservesBatch: BatchAccumulator<RawMoneyMarketReserveRow>
  private readonly xcmActivityBatch: BatchAccumulator<RawXcmActivityRow>
  private readonly bridgeEvidenceBatch: BatchAccumulator<RawBridgeEvidenceRow>
  private readonly operationTracesBatch: BatchAccumulator<RawOperationTraceRow>
  private readonly parserWarningsBatch: BatchAccumulator<RawParserWarningRow>
  private replayNamespace: string

  constructor(client: ClickHouseClient, flushThreshold: number = 10_000, replayNamespace: string = 'bootstrap') {
    this.client = client
    this.blocksBatch = new BatchAccumulator<RawBlockRow>(flushThreshold)
    this.extrinsicsBatch = new BatchAccumulator<RawExtrinsicRow>(flushThreshold)
    this.callsBatch = new BatchAccumulator<RawCallRow>(flushThreshold)
    this.eventsBatch = new BatchAccumulator<RawEventRow>(flushThreshold)
    this.snapshotsBatch = new BatchAccumulator<RawBlockSnapshotRow>(flushThreshold)
    this.accountAliasesBatch = new BatchAccumulator<RawAccountAliasRow>(flushThreshold)
    this.balanceObservationsBatch = new BatchAccumulator<RawBalanceObservationRow>(flushThreshold)
    this.evmLogsBatch = new BatchAccumulator<RawEvmLogRow>(flushThreshold)
    this.moneyMarketEventsBatch = new BatchAccumulator<RawMoneyMarketEventRow>(flushThreshold)
    this.moneyMarketPositionsBatch = new BatchAccumulator<RawMoneyMarketPositionRow>(flushThreshold)
    this.moneyMarketReservesBatch = new BatchAccumulator<RawMoneyMarketReserveRow>(flushThreshold)
    this.xcmActivityBatch = new BatchAccumulator<RawXcmActivityRow>(flushThreshold)
    this.bridgeEvidenceBatch = new BatchAccumulator<RawBridgeEvidenceRow>(flushThreshold)
    this.operationTracesBatch = new BatchAccumulator<RawOperationTraceRow>(flushThreshold)
    this.parserWarningsBatch = new BatchAccumulator<RawParserWarningRow>(flushThreshold)
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

  addAccountAliases(rows: RawAccountAliasRow[]): void {
    this.accountAliasesBatch.add(rows)
  }

  addBalanceObservations(rows: RawBalanceObservationRow[]): void {
    this.balanceObservationsBatch.add(rows)
  }

  addEvmLogs(rows: RawEvmLogRow[]): void {
    this.evmLogsBatch.add(rows)
  }

  addMoneyMarketEvents(rows: RawMoneyMarketEventRow[]): void {
    this.moneyMarketEventsBatch.add(rows)
  }

  addMoneyMarketPositions(rows: RawMoneyMarketPositionRow[]): void {
    this.moneyMarketPositionsBatch.add(rows)
  }

  addMoneyMarketReserves(rows: RawMoneyMarketReserveRow[]): void {
    this.moneyMarketReservesBatch.add(rows)
  }

  addXcmActivity(rows: RawXcmActivityRow[]): void {
    this.xcmActivityBatch.add(rows)
  }

  addBridgeEvidence(rows: RawBridgeEvidenceRow[]): void {
    this.bridgeEvidenceBatch.add(rows)
  }

  addOperationTraces(rows: RawOperationTraceRow[]): void {
    this.operationTracesBatch.add(rows)
  }

  addParserWarnings(rows: RawParserWarningRow[]): void {
    this.parserWarningsBatch.add(rows)
  }

  private async flushBatch<T extends { block_height: number }>(
    batch: BatchAccumulator<T>,
    table: string,
    tokenPrefix: string,
  ): Promise<void> {
    for (const rows of batch.flushChunks()) {
      const { min: minBlock, max: maxBlock } = blockHeightRange(rows)
      const token = buildInsertDedupeToken(tokenPrefix, this.replayNamespace, rows, [minBlock, maxBlock])
      await this.client.insert({
        table,
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: {
          insert_deduplication_token: token,
        },
      })
    }
  }

  async flushBlocks(): Promise<void> {
    await this.flushBatch(this.blocksBatch, 'price_data.raw_blocks', 'raw-blocks')
  }

  async flushExtrinsics(): Promise<void> {
    await this.flushBatch(this.extrinsicsBatch, 'price_data.raw_extrinsics', 'raw-extrinsics')
  }

  async flushCalls(): Promise<void> {
    await this.flushBatch(this.callsBatch, 'price_data.raw_calls', 'raw-calls')
  }

  async flushEvents(): Promise<void> {
    await this.flushBatch(this.eventsBatch, 'price_data.raw_events', 'raw-events')
  }

  async flushSnapshots(): Promise<void> {
    await this.flushBatch(this.snapshotsBatch, 'price_data.raw_block_snapshots', 'raw-snapshots')
  }

  async flushAccountAliases(): Promise<void> {
    await this.flushBatch(this.accountAliasesBatch, 'price_data.raw_account_aliases', 'raw-account-aliases')
  }

  async flushBalanceObservations(): Promise<void> {
    const rows = this.balanceObservationsBatch.flush()
    if (rows.length === 0) return

    const chunkSize = chunkSizeForBalanceObservations()
    const maxBytes = maxBytesForBalanceObservationInsert()
    const chunks: RawBalanceObservationRow[][] = []
    let chunk: RawBalanceObservationRow[] = []
    let chunkBytes = 0

    for (const row of rows) {
      const rowBytes = jsonRowBytes(row)
      if (chunk.length > 0 && (chunk.length >= chunkSize || chunkBytes + rowBytes > maxBytes)) {
        chunks.push(chunk)
        chunk = []
        chunkBytes = 0
      }
      chunk.push(row)
      chunkBytes += rowBytes
    }
    if (chunk.length > 0) chunks.push(chunk)

    const chunkCount = chunks.length
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex]
      const { min: minBlock, max: maxBlock } = blockHeightRange(chunk)
      const token = buildInsertDedupeToken(
        'raw-balance-observations',
        this.replayNamespace,
        chunk,
        [minBlock, maxBlock, rows.length, chunkIndex + 1, chunkCount],
      )

      await this.client.insert({
        table: 'price_data.raw_balance_observations',
        values: chunk,
        format: 'JSONEachRow',
        clickhouse_settings: {
          insert_deduplication_token: token,
        },
      })
    }
  }

  async flushEvmLogs(): Promise<void> {
    await this.flushBatch(this.evmLogsBatch, 'price_data.raw_evm_logs', 'raw-evm-logs')
  }

  async flushMoneyMarketEvents(): Promise<void> {
    await this.flushBatch(this.moneyMarketEventsBatch, 'price_data.raw_money_market_events', 'raw-money-market-events')
  }

  async flushMoneyMarketPositions(): Promise<void> {
    await this.flushBatch(this.moneyMarketPositionsBatch, 'price_data.raw_money_market_positions', 'raw-money-market-positions')
  }

  async flushMoneyMarketReserves(): Promise<void> {
    await this.flushBatch(this.moneyMarketReservesBatch, 'price_data.raw_money_market_reserves', 'raw-money-market-reserves')
  }

  async flushXcmActivity(): Promise<void> {
    await this.flushBatch(this.xcmActivityBatch, 'price_data.raw_xcm_activity', 'raw-xcm-activity')
  }

  async flushBridgeEvidence(): Promise<void> {
    await this.flushBatch(this.bridgeEvidenceBatch, 'price_data.raw_bridge_evidence', 'raw-bridge-evidence')
  }

  async flushOperationTraces(): Promise<void> {
    await this.flushBatch(this.operationTracesBatch, 'price_data.raw_operation_traces', 'raw-operation-traces')
  }

  async flushParserWarnings(): Promise<void> {
    await this.flushBatch(this.parserWarningsBatch, 'price_data.raw_parser_warnings', 'raw-parser-warnings')
  }

  async flushAll(): Promise<void> {
    await this.flushBlocks()
    await this.flushExtrinsics()
    await this.flushCalls()
    await this.flushEvents()
    await this.flushSnapshots()
    await this.flushAccountAliases()
    await this.flushBalanceObservations()
    await this.flushEvmLogs()
    await this.flushMoneyMarketEvents()
    await this.flushMoneyMarketPositions()
    await this.flushMoneyMarketReserves()
    await this.flushXcmActivity()
    await this.flushBridgeEvidence()
    await this.flushOperationTraces()
    await this.flushParserWarnings()
  }

  async saveCheckpoint(pipelineId: string, blockHeight: number, blockHash: string, mode: string): Promise<void> {
    this.replayNamespace = await saveRawCheckpoint(this.client, pipelineId, blockHeight, blockHash, mode)
  }

  async markRangeRunning(pipelineId: string, fromBlock: number, toBlock: number): Promise<void> {
    await markRawRangeRunning(this.client, pipelineId, fromBlock, toBlock)
  }

  async finalizeRange(pipelineId: string, fromBlock: number, toBlock: number): Promise<void> {
    await finalizeRawRange(this.client, pipelineId, fromBlock, toBlock)
  }

  async markRangeFailed(pipelineId: string, fromBlock: number, toBlock: number, error: unknown): Promise<void> {
    await markRawRangeFailed(this.client, pipelineId, fromBlock, toBlock, error)
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
