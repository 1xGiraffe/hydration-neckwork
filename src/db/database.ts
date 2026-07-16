import type { FinalDatabase, FinalTxInfo, HashAndHeight } from '@subsquid/util-internal-processor-tools'
import type { ClickHouseStore } from '../store/clickhouseStore.js'
import { createClickHouseClient } from './client.js'
import { ClickHouseStore as Store } from '../store/clickhouseStore.js'
import { config } from '../config.js'

export interface DatabaseOptions {
  deferPublication?: boolean
  publishAtBlock?: number
  startAtGenesis?: boolean
}

export class Database implements FinalDatabase<ClickHouseStore> {
  private store: ClickHouseStore | null = null
  private readonly checkpointId: string
  private readonly deferPublication: boolean
  private readonly publishAtBlock: number | null
  private readonly startAtGenesis: boolean
  private pendingCheckpoint: number | null = null
  private deferredPublished = false

  constructor(checkpointId = 'main', options: DatabaseOptions = {}) {
    this.checkpointId = checkpointId
    this.deferPublication = options.deferPublication === true
    this.publishAtBlock = options.publishAtBlock ?? null
    this.startAtGenesis = options.startAtGenesis === true
  }

  async connect(): Promise<HashAndHeight> {
    const client = createClickHouseClient()
    this.store = new Store(client, config.BATCH_SIZE, 'bootstrap', this.checkpointId, {
      deferPublication: this.deferPublication,
    })

    const checkpoint = await this.store.getLastProcessedBlock()
    this.store.setReplayNamespace(checkpoint.replayNamespace)

    if (this.startAtGenesis) {
      return {
        height: -1,
        hash: '0x',
      }
    }

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
    if (this.deferPublication) {
      this.pendingCheckpoint = Math.max(this.pendingCheckpoint ?? 0, info.nextHead.height)
      if (
        !this.deferredPublished &&
        this.publishAtBlock != null &&
        info.nextHead.height >= this.publishAtBlock
      ) {
        await this.publishDeferred()
      }
    } else {
      await this.store.saveCheckpoint(info.nextHead.height)
    }
  }

  async publishDeferred(): Promise<void> {
    if (!this.store) {
      throw new Error('Database not connected')
    }

    if (!this.deferPublication) {
      return
    }

    await this.store.publishDeferred()
    if (this.pendingCheckpoint != null) {
      await this.store.saveCheckpoint(this.pendingCheckpoint)
    }
    this.deferredPublished = true
  }
}
