import { describe, expect, it, vi } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import type { PendingBlock, PendingEventRow, PendingExtrinsicRow } from '../src/services/pendingHeadService.ts'

// A detail page is routinely opened before its block reaches ClickHouse:
// raw-live follows the FINALIZED head, so a link a wallet hands out the moment
// it acted is 35-65s early. These pin the three things that made that window
// look like a broken link — a cached miss, an unanswerable 404, and data the
// pending layer already had but no lookup served.

const SWAPPER = '0x' + '11'.repeat(32)
const RECIPIENT = '0x' + '22'.repeat(32)
const PENDING_HEIGHT = 14_185_809

const swapEvent = (eventIndex: number, extrinsicIndex: number): PendingEventRow => ({
  eventIndex, extrinsicIndex, name: 'Broadcast.Swapped3', args: null,
  swap: { swapper: SWAPPER, inputs: [{ assetId: 0, amount: '1000000000000' }], outputs: [{ assetId: 10, amount: '5000000' }] },
})
const pendingExtrinsic: PendingExtrinsicRow = {
  index: 2, hash: '0x' + 'ab'.repeat(32), callName: 'Router.sell', signerId: SWAPPER,
  success: true, tip: null, version: 4, callArgs: {}, events: [swapEvent(5, 2)],
}
const pendingBlock: PendingBlock = {
  height: PENDING_HEIGHT, hash: '0xaaa', parentHash: '0xbbb', timestamp: '2026-09-04 03:54:24',
  specVersion: 440,
  extrinsics: [pendingExtrinsic],
  events: [
    swapEvent(5, 2),
    // A plain transfer in another extrinsic: the pending layer decodes more
    // than trades, and the activity lookups must serve all of it.
    { eventIndex: 9, extrinsicIndex: 3, name: 'Tokens.Transfer', args: null, transfer: { from: SWAPPER, to: RECIPIENT, assetId: 10, amount: '250000' } },
  ],
}

vi.mock('../src/services/pendingHeadService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/pendingHeadService.ts')>()
  return {
    ...actual,
    findPendingBlock: (height: number) => (height === PENDING_HEIGHT ? pendingBlock : null),
    findPendingExtrinsic: (height: number, index: number) =>
      (height === PENDING_HEIGHT && index === pendingExtrinsic.index ? { block: pendingBlock, ext: pendingExtrinsic } : null),
    findPendingExtrinsicByHash: () => null,
    findMempoolTx: () => null,
    pendingBestHeight: () => PENDING_HEIGHT,
    startPendingHeadService: () => {},
    stopPendingHeadService: () => {},
  }
})

/** A client whose answers can change between calls, like the index filling in. */
function stagedClient(stage: { rows: Record<string, unknown[]> }): { client: ClickHouseClient; queries: string[] } {
  const queries: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      const table = Object.keys(stage.rows).find(t => query.includes(t))
      return { json: async () => (table ? stage.rows[table] : []) }
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
  return { client, queries }
}

describe('a lookup whose block has not been indexed yet', () => {
  it('does not cache the miss, so the answer appears as soon as the rows land', async () => {
    const { getTradeDetail, initExplorerService } = await import('../src/services/explorerService.ts')
    const stage: { rows: Record<string, unknown[]> } = { rows: {} }
    const { client } = stagedClient(stage)
    initExplorerService(client)

    // Not in the pending layer either (a height the mock does not know), so
    // this is exactly the seam: finalized rows not there yet.
    const height = 14_100_001
    expect(await getTradeDetail(height, 2)).toBeNull()

    // The block lands. Under a cached miss the endpoint would keep answering
    // 404 for the rest of its 60s TTL — measured at 54 of those 60 seconds.
    stage.rows = {
      raw_events: [{
        event_index: 5, event_name: 'Broadcast.Swapped3', ts: '2026-09-04 03:54:24',
        args_json: JSON.stringify({ swapper: SWAPPER, inputs: [{ assetId: 0, amount: '1000000000000' }], outputs: [{ assetId: 10, amount: '5000000' }] }),
      }],
    }
    const trade = await getTradeDetail(height, 2)
    expect(trade?.blockHeight).toBe(height)
    expect(trade?.eventIndex).toBe(5)
  })

  it('describes the miss so a client can tell "not indexed yet" from a bad id', async () => {
    const { describeLookupMiss, initExplorerService } = await import('../src/services/explorerService.ts')
    const stage: { rows: Record<string, unknown[]> } = { rows: {} }
    const { client } = stagedClient(stage)
    initExplorerService(client)

    // No rows for the block: the wait is legitimate.
    const missing = await describeLookupMiss(14_100_002)
    expect(missing.blockIndexed).toBe(false)
    expect(missing.headBound).toBeGreaterThanOrEqual(PENDING_HEIGHT)

    // The block IS there (present = 1) — so a miss on it is a bad id, and the
    // client must fail fast rather than wait for something already served.
    stage.rows = { raw_events: [{ present: 1 }] }
    expect((await describeLookupMiss(14_100_003)).blockIndexed).toBe(true)
  })
})

describe('detail lookups served from the pending layer', () => {
  it('answers a swap link from the unfinalized block, marked unfinalized', async () => {
    const { getTradeDetail, initExplorerService } = await import('../src/services/explorerService.ts')
    const { client } = stagedClient({ rows: {} })
    initExplorerService(client)

    const trade = await getTradeDetail(PENDING_HEIGHT, 2)
    expect(trade).toMatchObject({
      blockHeight: PENDING_HEIGHT,
      extrinsicIndex: 2,
      eventIndex: 5,
      hash: pendingExtrinsic.hash,
      venue: 'Router',
      direction: 'Sell',
      amountIn: '1000000000000',
      amountOut: '5000000',
      // Honest incompleteness: the fee settles with the block.
      extrinsicFee: null,
      finalized: false,
    })
  })

  it('resolves the event form too, even though the two layers anchor a trade at different events', async () => {
    const { getTradeDetailByEvent, initExplorerService } = await import('../src/services/explorerService.ts')
    const { client } = stagedClient({ rows: {} })
    initExplorerService(client)

    // The pending feed's row names the first Broadcast leg (5); the finalized
    // classifier will name the Router event instead. A link taken now must open.
    expect(await getTradeDetailByEvent(PENDING_HEIGHT, 5)).toMatchObject({ extrinsicIndex: 2, finalized: false })
  })

  it('serves every pending kind through the block activity lookup, with link coordinates', async () => {
    const { getBlockActivity, initExplorerService } = await import('../src/services/explorerService.ts')
    const { client } = stagedClient({ rows: {} })
    initExplorerService(client)

    const rows = await getBlockActivity(PENDING_HEIGHT)
    expect(rows.map(r => r.type).sort()).toEqual(['trade', 'transfer'])
    for (const row of rows) {
      expect(row.finalized).toBe(false)
      // Addressable: the detail pages answer from this same layer now.
      expect(row.linkBlock).toBe(PENDING_HEIGHT)
      expect(row.linkIndex).toBe(row.extrinsicIndex)
    }
  })

  it('scopes the extrinsic activity lookup to its own extrinsic', async () => {
    const { getExtrinsicActivity, initExplorerService } = await import('../src/services/explorerService.ts')
    const { client } = stagedClient({ rows: {} })
    initExplorerService(client)

    const rows = await getExtrinsicActivity(PENDING_HEIGHT, 2)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'trade', extrinsicIndex: 2, finalized: false })
  })
})
