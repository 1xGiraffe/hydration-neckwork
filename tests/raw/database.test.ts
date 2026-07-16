import { describe, expect, it } from 'vitest'
import { RawDatabase, rawResumeHead } from '../../src/raw/database.ts'

class FakeRawStore {
  readonly calls: string[] = []

  async flushAll(): Promise<void> {
    this.calls.push('flushAll')
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
