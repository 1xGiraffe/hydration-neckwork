import type { HotDatabase, HotDatabaseState, FinalTxInfo, HotTxInfo, HashAndHeight } from '@subsquid/util-internal-processor-tools'
import type { ClickHouseStore } from '../store/clickhouseStore.js'
import { createClickHouseClient } from './client.js'
import { ClickHouseStore as Store } from '../store/clickhouseStore.js'
import { config } from '../config.js'

export class Database implements HotDatabase<ClickHouseStore> {
  supportsHotBlocks = true as const
  private store: ClickHouseStore | null = null

  async connect(): Promise<HotDatabaseState> {
    const client = createClickHouseClient()
    this.store = new Store(client, config.BATCH_SIZE)

    const lastBlock = await this.store.getLastProcessedBlock()

    return {
      height: lastBlock,
      hash: '0x',
      top: [],
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

  // We checkpoint at finalizedHead only (not hot blocks) -- ClickHouse
  // has no rollback mechanism, so only finalized blocks are safe checkpoints.
  async transactHot(info: HotTxInfo, cb: (store: ClickHouseStore, block: HashAndHeight) => Promise<void>): Promise<void> {
    if (!this.store) {
      throw new Error('Database not connected')
    }

    for (const block of info.newBlocks) {
      await cb(this.store, block)
    }

    await this.store.flushAll()
    await this.store.saveCheckpoint(info.finalizedHead.height)
  }
}
