import type {
  FinalDatabase,
  FinalTxInfo,
  HashAndHeight,
} from '@subsquid/util-internal-processor-tools'
import { config } from '../config.js'
import { createClickHouseClient } from '../db/client.js'
import { RawClickHouseStore } from './store.js'
import type { RawCheckpointState } from './checkpoint.js'

export class RawDatabase implements FinalDatabase<RawClickHouseStore> {
  private store: RawClickHouseStore | null = null
  private readonly pipelineId: string
  private readonly finalizeRangeBounds: { fromBlock: number; toBlock: number } | null
  private rangeFinalized = false

  constructor(pipelineId: string, finalizeRangeBounds: { fromBlock: number; toBlock: number } | null = null) {
    this.pipelineId = pipelineId
    this.finalizeRangeBounds = finalizeRangeBounds
  }

  async connect(): Promise<HashAndHeight> {
    const client = createClickHouseClient()
    this.store = new RawClickHouseStore(client, config.BATCH_SIZE)

    const state = await this.store.getIngestionState(this.pipelineId)
    const { replayNamespace } = state
    this.store.setReplayNamespace(replayNamespace)
    return rawResumeHead(state, this.finalizeRangeBounds)
  }

  async transact(info: FinalTxInfo, cb: (store: RawClickHouseStore) => Promise<void>): Promise<void> {
    if (this.store == null) {
      throw new Error('Raw database not connected')
    }

    await cb(this.store)
    await this.store.flushAll()
    await this.store.saveCheckpoint(
      this.pipelineId,
      info.nextHead.height,
      info.nextHead.hash,
      info.isOnTop ? 'live' : 'archive',
    )

    if (
      this.finalizeRangeBounds != null &&
      !this.rangeFinalized &&
      info.nextHead.height >= this.finalizeRangeBounds.toBlock
    ) {
      console.log(
        `[Raw] Validating finalized range ${this.finalizeRangeBounds.fromBlock}-${this.finalizeRangeBounds.toBlock}`,
      )
      await this.finalizeRange(this.finalizeRangeBounds.fromBlock, this.finalizeRangeBounds.toBlock)
      console.log(
        `[Raw] Finalized range ${this.finalizeRangeBounds.fromBlock}-${this.finalizeRangeBounds.toBlock}`,
      )
    }
  }

  async markRangeRunning(fromBlock: number, toBlock: number): Promise<void> {
    if (this.store == null) {
      throw new Error('Raw database not connected')
    }
    await this.store.markRangeRunning(this.pipelineId, fromBlock, toBlock)
  }

  async finalizeRange(fromBlock: number, toBlock: number): Promise<void> {
    if (this.rangeFinalized) {
      return
    }
    if (this.store == null) {
      throw new Error('Raw database not connected')
    }
    await this.store.finalizeRange(this.pipelineId, fromBlock, toBlock)
    this.rangeFinalized = true
  }

  isRangeFinalized(): boolean {
    return this.rangeFinalized
  }

  async getIngestionState(): Promise<RawCheckpointState> {
    if (this.store == null) {
      throw new Error('Raw database not connected')
    }
    return this.store.getIngestionState(this.pipelineId)
  }

  async markRangeFailed(fromBlock: number, toBlock: number, error: unknown): Promise<void> {
    if (this.store == null) {
      throw new Error('Raw database not connected')
    }
    await this.store.markRangeFailed(this.pipelineId, fromBlock, toBlock, error)
  }
}

export function rawResumeHead(
  state: RawCheckpointState,
  range: { fromBlock: number; toBlock: number } | null,
): HashAndHeight {
  // A genuinely new genesis range must start before block zero. Once the worker
  // has checkpointed, always resume that exact head—even when its range starts
  // at zero—so a crash cannot replay rows into insert-triggered aggregate views.
  if (range?.fromBlock === 0 && !state.hasCheckpoint) return { height: -1, hash: '0x' }
  return { height: state.height, hash: state.hash }
}
