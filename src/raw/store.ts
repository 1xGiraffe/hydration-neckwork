import { type ClickHouseClient } from '../db/client.js'
import { BatchAccumulator } from '../store/batch.js'
import { integerFromEnvironment } from '../util/env.js'
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

  constructor(client: ClickHouseClient, flushThreshold: number = 10_000) {
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

  // Inserts carry no insert-level deduplication, deliberately. Replay safety comes
  // from the destination tables: every raw table is a ReplacingMergeTree keyed on a
  // stable chain-derived identity (block height plus extrinsic/event index, trace id,
  // observation id, …), so re-inserting a range collapses to the same rows on merge
  // and reads that need exactness use FINAL over a primary-key predicate.
  // ClickHouse's `insert_deduplication_token` would do nothing here: these tables are
  // non-Replicated MergeTree family engines, where the token is only honoured if
  // `non_replicated_deduplication_window` is declared (it defaults to 0, and no table
  // sets it). It was passed on every insert for a while and was measurably inert —
  // three identical inserts with one token still produced three rows. Declaring that
  // window is the one-line change that would make it real; until then, do not re-add
  // a token and do not treat it as a safety net.
  private async flushBatch<T extends { block_height: number }>(
    batch: BatchAccumulator<T>,
    table: string,
  ): Promise<void> {
    for (const rows of batch.flushChunks()) {
      await this.client.insert({
        table,
        values: rows,
        format: 'JSONEachRow',
      })
    }
  }

  async flushBlocks(): Promise<void> {
    await this.flushBatch(this.blocksBatch, 'price_data.raw_blocks')
  }

  async flushExtrinsics(): Promise<void> {
    await this.flushBatch(this.extrinsicsBatch, 'price_data.raw_extrinsics')
  }

  async flushCalls(): Promise<void> {
    await this.flushBatch(this.callsBatch, 'price_data.raw_calls')
  }

  async flushEvents(): Promise<void> {
    await this.flushBatch(this.eventsBatch, 'price_data.raw_events')
  }

  async flushSnapshots(): Promise<void> {
    await this.flushBatch(this.snapshotsBatch, 'price_data.raw_block_snapshots')
  }

  async flushAccountAliases(): Promise<void> {
    await this.flushBatch(this.accountAliasesBatch, 'price_data.raw_account_aliases')
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

    for (const observations of chunks) {
      await this.client.insert({
        table: 'price_data.raw_balance_observations',
        values: observations,
        format: 'JSONEachRow',
      })
    }
  }

  async flushEvmLogs(): Promise<void> {
    await this.flushBatch(this.evmLogsBatch, 'price_data.raw_evm_logs')
  }

  async flushMoneyMarketEvents(): Promise<void> {
    await this.flushBatch(this.moneyMarketEventsBatch, 'price_data.raw_money_market_events')
  }

  async flushMoneyMarketPositions(): Promise<void> {
    await this.flushBatch(this.moneyMarketPositionsBatch, 'price_data.raw_money_market_positions')
  }

  async flushMoneyMarketReserves(): Promise<void> {
    await this.flushBatch(this.moneyMarketReservesBatch, 'price_data.raw_money_market_reserves')
  }

  async flushXcmActivity(): Promise<void> {
    await this.flushBatch(this.xcmActivityBatch, 'price_data.raw_xcm_activity')
  }

  async flushBridgeEvidence(): Promise<void> {
    await this.flushBatch(this.bridgeEvidenceBatch, 'price_data.raw_bridge_evidence')
  }

  async flushOperationTraces(): Promise<void> {
    await this.flushBatch(this.operationTracesBatch, 'price_data.raw_operation_traces')
  }

  async flushParserWarnings(): Promise<void> {
    await this.flushBatch(this.parserWarningsBatch, 'price_data.raw_parser_warnings')
  }

  // Buffered blocks and the largest single-table buffer, for the flush policy
  // (see flushPolicy.ts). One raw_blocks row is one block, and the row count is
  // taken as a max rather than a sum because what it bounds is one INSERT.
  pendingBlocks(): number {
    return this.blocksBatch.size
  }

  pendingRows(): number {
    return Math.max(
      this.blocksBatch.size,
      this.extrinsicsBatch.size,
      this.callsBatch.size,
      this.eventsBatch.size,
      this.snapshotsBatch.size,
      this.accountAliasesBatch.size,
      this.balanceObservationsBatch.size,
      this.evmLogsBatch.size,
      this.moneyMarketEventsBatch.size,
      this.moneyMarketPositionsBatch.size,
      this.moneyMarketReservesBatch.size,
      this.xcmActivityBatch.size,
      this.bridgeEvidenceBatch.size,
      this.operationTracesBatch.size,
      this.parserWarningsBatch.size,
    )
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
    await saveRawCheckpoint(this.client, pipelineId, blockHeight, blockHash, mode)
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

  async getIngestionState(pipelineId: string): Promise<import('./checkpoint.js').RawCheckpointState> {
    return getRawIngestionState(this.client, pipelineId)
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
