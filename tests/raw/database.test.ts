import { describe, expect, it } from 'vitest'
import { RawDatabase, rawResumeHead } from '../../src/raw/database.ts'

class FakeRawStore {
  readonly calls: string[] = []
  buffered = { blocks: 0, rows: 0 }

  pendingBlocks(): number {
    return this.buffered.blocks
  }

  pendingRows(): number {
    return this.buffered.rows
  }

  async flushAll(): Promise<void> {
    this.calls.push('flushAll')
    this.buffered = { blocks: 0, rows: 0 }
  }

  async saveCheckpoint(pipelineId: string, blockHeight: number, blockHash: string, mode: string): Promise<void> {
    this.calls.push(`saveCheckpoint:${pipelineId}:${blockHeight}:${blockHash}:${mode}`)
  }

  async finalizeRange(pipelineId: string, fromBlock: number, toBlock: number): Promise<void> {
    this.calls.push(`finalizeRange:${pipelineId}:${fromBlock}-${toBlock}`)
  }
}

function attachStore(database: RawDatabase, store: FakeRawStore): void {
  ;(database as unknown as { store: FakeRawStore }).store = store
}

describe('RawDatabase bounded range finalization', () => {
  it('starts a genuinely empty genesis range before block zero', () => {
    expect(rawResumeHead({ height: 0, hash: '0x', replayNamespace: 'new', hasCheckpoint: false }, { fromBlock: 0, toBlock: 999 })).toEqual({
      height: -1,
      hash: '0x',
    })
  })

  it('resumes a checkpointed genesis range instead of replaying it', () => {
    expect(rawResumeHead({ height: 500, hash: '0x500', replayNamespace: 'saved', hasCheckpoint: true }, { fromBlock: 0, toBlock: 999 })).toEqual({
      height: 500,
      hash: '0x500',
    })
  })

  it('can finalize a range after a successful run that performed no transaction', async () => {
    const database = new RawDatabase('raw-backfill-10-20', { fromBlock: 10, toBlock: 20 })
    const store = new FakeRawStore()
    attachStore(database, store)

    await database.finalizeRange(10, 20)

    expect(store.calls).toEqual(['finalizeRange:raw-backfill-10-20:10-20'])
  })

  it('does not finalize the same range twice in one worker process', async () => {
    const database = new RawDatabase('raw-backfill-10-20', { fromBlock: 10, toBlock: 20 })
    const store = new FakeRawStore()
    attachStore(database, store)

    await database.transact({
      nextHead: { height: 20, hash: '0x20' },
      isOnTop: false,
    } as any, async () => {})
    await database.finalizeRange(10, 20)

    expect(store.calls).toEqual([
      'flushAll',
      'saveCheckpoint:raw-backfill-10-20:20:0x20:archive',
      'finalizeRange:raw-backfill-10-20:10-20',
    ])
  })
})

// The flush is what moves the checkpoint, so the two must never come apart: a batch
// that stays buffered must leave the checkpoint behind it, or a crash would skip
// those blocks instead of re-indexing them.
describe('RawDatabase flush accumulation', () => {
  const limits = { blocks: 3, rows: 1000, elapsedMs: 60_000 }

  function transact(database: RawDatabase, height: number, isOnTop: boolean): Promise<void> {
    return database.transact({ nextHead: { height, hash: `0x${height}` }, isOnTop } as any, async () => {})
  }

  it('flushes every batch at chain head, exactly as before', async () => {
    const database = new RawDatabase('raw-live', null, limits)
    const store = new FakeRawStore()
    attachStore(database, store)

    for (const height of [100, 101, 102]) {
      store.buffered = { blocks: 1, rows: 5 }
      await transact(database, height, true)
    }

    expect(store.calls).toEqual([
      'flushAll', 'saveCheckpoint:raw-live:100:0x100:live',
      'flushAll', 'saveCheckpoint:raw-live:101:0x101:live',
      'flushAll', 'saveCheckpoint:raw-live:102:0x102:live',
    ])
  })

  it('accumulates behind head and checkpoints only the head it actually wrote', async () => {
    const database = new RawDatabase('raw-live', null, limits)
    const store = new FakeRawStore()
    attachStore(database, store)

    store.buffered = { blocks: 1, rows: 5 }
    await transact(database, 100, false)
    store.buffered = { blocks: 2, rows: 9 }
    await transact(database, 101, false)

    expect(store.calls).toEqual([])

    store.buffered = { blocks: 3, rows: 14 }
    await transact(database, 102, false)

    expect(store.calls).toEqual(['flushAll', 'saveCheckpoint:raw-live:102:0x102:archive'])
  })

  it('flushes a single oversized batch on the row bound', async () => {
    const database = new RawDatabase('raw-live', null, limits)
    const store = new FakeRawStore()
    attachStore(database, store)

    store.buffered = { blocks: 1, rows: 1000 }
    await transact(database, 100, false)

    expect(store.calls).toEqual(['flushAll', 'saveCheckpoint:raw-live:100:0x100:archive'])
  })

  it('flushes at a range end even when nothing else has fired', async () => {
    const database = new RawDatabase('raw-backfill-10-20', { fromBlock: 10, toBlock: 20 }, limits)
    const store = new FakeRawStore()
    attachStore(database, store)

    store.buffered = { blocks: 1, rows: 5 }
    await transact(database, 20, false)

    expect(store.calls).toEqual([
      'flushAll',
      'saveCheckpoint:raw-backfill-10-20:20:0x20:archive',
      'finalizeRange:raw-backfill-10-20:10-20',
    ])
  })

  it('flushes on the wall-clock ceiling so a wrong at-head signal cannot stall it', async () => {
    const database = new RawDatabase('raw-live', null, { blocks: 1000, rows: 1e9, elapsedMs: 0 })
    const store = new FakeRawStore()
    attachStore(database, store)

    store.buffered = { blocks: 1, rows: 5 }
    await transact(database, 100, false)

    expect(store.calls).toEqual(['flushAll', 'saveCheckpoint:raw-live:100:0x100:archive'])
  })
})
