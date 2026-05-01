import type { FinalDatabase, FinalTxInfo, HashAndHeight } from '@subsquid/util-internal-processor-tools'
import type { ClickHouseStore } from '../store/clickhouseStore.js'
import { createClickHouseClient } from './client.js'
import { ClickHouseStore as Store } from '../store/clickhouseStore.js'
import { config } from '../config.js'

export class Database implements FinalDatabase<ClickHouseStore> {
  private store: ClickHouseStore | null = null

  async connect(): Promise<HashAndHeight> {
    const client = createClickHouseClient()
    this.store = new Store(client, config.BATCH_SIZE)

    const checkpoint = await this.store.getLastProcessedBlock()
    this.store.setReplayNamespace(checkpoint.replayNamespace)

    return {
      height: checkpoint.lastBlock,
      hash: '0x',
    }
  }

  async transact(info: FinalTxInfo, cb: (store: ClickHouseStore) => Promise<void>): Promise<void> {
    if (!this.store) {
      throw new Error('Database not connected')
    }

    await cb(this.store)
    await this.store.flushAll()
    await this.store.saveCheckpoint(info.nextHead.height)
  }
}
