import type {
  FinalDatabase,
  FinalTxInfo,
  HashAndHeight,
} from '@subsquid/util-internal-processor-tools'
import { config } from '../config.js'
import { createClickHouseClient } from '../db/client.js'
import { RawClickHouseStore } from './store.js'

export class RawDatabase implements FinalDatabase<RawClickHouseStore> {
  private store: RawClickHouseStore | null = null
  private readonly pipelineId: string

  constructor(pipelineId: string) {
    this.pipelineId = pipelineId
  }

  async connect(): Promise<HashAndHeight> {
    const client = createClickHouseClient()
    this.store = new RawClickHouseStore(client, config.BATCH_SIZE)

    const { height, hash, replayNamespace } = await this.store.getIngestionState(this.pipelineId)
    this.store.setReplayNamespace(replayNamespace)
    return {
      height,
      hash,
    }
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
  }
}
