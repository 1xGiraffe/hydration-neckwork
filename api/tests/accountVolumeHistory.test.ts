import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { makeBucketing } from '../src/services/bucketLadder.ts'
import { loadVolumeBuckets, tradingVolumeTotals, volumeBucketsSql, volumeCutHeights } from '../src/services/accountVolumeHistory.ts'

// The account/tag Volume chart buckets the header's "Trading" figure
// (price_data.account_trade_volume) on the value chart's grid. These pin the
// properties the chart's numbers rest on: the all-time total is the header's own
// helper, un-windowed buckets keep every trade (so they sum to that total), and a
// zoom window counts exactly the flow inside (fromBlock, toBlock].

const vs = vi.hoisted(() => ({ calls: [] as Array<{ tagId?: string; address?: string; listId?: string; members?: string[]; window: unknown }> }))
vi.mock('../src/services/explorerService.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/explorerService.ts')>(),
  getAddressVolumeHistory: vi.fn(async (address: string, window?: unknown) => {
    vs.calls.push({ address, window })
    return address === '1missing' ? null : { stepSec: 3600, buckets: [], totals: { d1: 0, d7: 0, d30: 0, all: 0 }, asOfBlock: 1 }
  }),
  getTagVolumeHistory: vi.fn(async (tagId: string, window?: unknown) => {
    vs.calls.push({ tagId, window })
    return tagId === 'missing' ? null : { stepSec: 3600, buckets: [], totals: { d1: 0, d7: 0, d30: 0, all: 0 }, asOfBlock: 1 }
  }),
  getListTagVolumeHistory: vi.fn(async (listId: string, tagId: string, members: string[], window?: unknown) => {
    vs.calls.push({ listId, tagId, members, window })
    return { stepSec: 3600, buckets: [], totals: { d1: 0, d7: 0, d30: 0, all: 0 }, asOfBlock: 1 }
  }),
}))
const { explorerRoutes } = await import('../src/routes/explorer.ts')
const { listTagReadRoutes } = await import('../src/routes/listTagRoutes.ts')
const LIST_TAG_MEMBERS = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`]

function fakeClient(rows: (query: string) => unknown[]): { client: ClickHouseClient; queries: string[] } {
  const queries: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      return { json: async () => rows(query) }
    },
  } as unknown as ClickHouseClient
  return { client, queries }
}

const H = 3_600
const clock = { hours: [0, H, 2 * H, 3 * H, 4 * H], heights: [100, 200, 300, 400, 500], builtAt: 0 }
const LIST = `'0x${'aa'.repeat(32)}','0x${'bb'.repeat(32)}'`

describe('tradingVolumeTotals', () => {
  it('reads all time alone for the header and the trailing windows above their cut heights for the chart', async () => {
    const { client, queries } = fakeClient(() => [{ all_usd: '1234.500000000000', d1: '1.5', d7: '10', d30: '100.25', d365: '900' }])
    const header = await tradingVolumeTotals(client, LIST)
    expect(header.all).toBe(1234.5)
    expect(queries[0]).toContain('toString(sum(volume_usd)) AS all_usd')
    expect(queries[0]).not.toContain('sumIf')
    expect(queries[0]).toContain('FROM price_data.account_trade_volume')
    expect(queries[0]).toContain(`WHERE account IN (${LIST})`)

    const chart = await tradingVolumeTotals(client, LIST, { d1: 900, d7: 700, d30: 300, d365: 50 })
    expect(chart).toEqual({ d1: 1.5, d7: 10, d30: 100.25, d365: 900, all: 1234.5 })
    // The all-time expression is the header's, byte for byte — one figure, one sum.
    expect(queries[1]).toContain('toString(sum(volume_usd)) AS all_usd')
    expect(queries[1]).toContain('sumIf(volume_usd, block_height > 900)')
    expect(queries[1]).toContain('sumIf(volume_usd, block_height > 700)')
    expect(queries[1]).toContain('sumIf(volume_usd, block_height > 300)')
    expect(queries[1]).toContain('sumIf(volume_usd, block_height > 50)) AS d365')
  })

  it('answers zero without a query for an empty set', async () => {
    const { client, queries } = fakeClient(() => [])
    expect(await tradingVolumeTotals(client, "''")).toEqual({ d1: 0, d7: 0, d30: 0, d365: 0, all: 0 })
    expect(queries).toHaveLength(0)
  })
})

describe('volumeCutHeights', () => {
  it('dates each cut from the newest indexed block, read inside a key range the chain clock brackets', async () => {
    const D = 86_400
    const hours = Array.from({ length: 31 * 24 + 1 }, (_, i) => i * H)
    const big = { hours, heights: hours.map((_, i) => (i + 1) * 100), lastTime: 31 * D, builtAt: 0 }
    const { client, queries } = fakeClient(() => [{ d1: '71900', d7: '57500', d30: '2300', d365: '0' }])
    expect(await volumeCutHeights(client, big)).toEqual({ d1: 71900, d7: 57500, d30: 2300, d365: 0 })
    const q = queries[0]
    expect(q).toContain(`block_timestamp <= toDateTime(${30 * D})`)
    expect(q).toContain(`block_timestamp <= toDateTime(${24 * D})`)
    expect(q).toContain(`block_timestamp <= toDateTime(${1 * D})`)
    // Never the whole table: every lookup carries both key bounds.
    expect(q).toContain(') AS d365')
    expect([...q.matchAll(/block_height >= \d+ AND block_height <= \d+/g)]).toHaveLength(4)
  })
})

describe('volume buckets', () => {
  const bk = makeBucketing(clock, 0, 4 * H, 100)

  it('un-windowed: no block bound, so every trade lands in some bucket', () => {
    const sql = volumeBucketsSql(LIST, bk)
    expect(sql).not.toMatch(/block_height >/)
    expect(sql).toContain(bk.ofHeight('block_height'))
    expect(sql).toContain('GROUP BY b')
  })

  it('windowed: exactly the flow inside (fromBlock, toBlock]', () => {
    const sql = volumeBucketsSql(LIST, bk, { fromBlock: 200, toBlock: 400 })
    expect(sql).toContain('AND block_height > 200 AND block_height <= 400')
  })

  it('folds rows onto the grid with each bucket dated by its start, end and end height', async () => {
    const { client } = fakeClient(() => [
      { b: 0, volume_usd: '10.5', trades: '2' },
      { b: 2, volume_usd: '0.25', trades: '1' },
      { b: 9, volume_usd: '999', trades: '9' }, // outside the grid: never drawn
    ])
    const out = await loadVolumeBuckets(client, LIST, bk)
    expect(out).toHaveLength(bk.N + 1)
    expect(out.map(b => b.volumeUsd)).toEqual([10.5, 0, 0.25, 0])
    expect(out.map(b => b.trades)).toEqual([2, 0, 1, 0])
    expect(out[0]).toMatchObject({ ts: '1970-01-01 00:00:00', endTs: '1970-01-01 01:00:00', blockHeight: bk.endHeight(0) })
    // Consecutive buckets tile time: each starts where the previous ended.
    for (let b = 1; b <= bk.N; b++) expect(out[b].ts).toBe(out[b - 1].endTs)
  })
})

describe('header figure and chart total share one helper', () => {
  const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  const body = (name: string) => {
    const at = src.indexOf(`async function ${name}(`)
    expect(at, name).toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('\n}\n', at))
  }
  it('getAddress and the tag detail sum the volume set through tradingVolumeUsdOf', () => {
    for (const fn of ['getAddress', 'buildTagDetailForMembers']) {
      expect(body(fn), fn).toContain('tradingVolumeAccountSet(')
      expect(body(fn), fn).toContain('tradingVolumeUsdOf(volumeAccounts)')
    }
    expect(body('tradingVolumeUsdOf')).toContain('tradingVolumeTotals(client, tradingVolumeList(volumeAccounts))')
    // The list tag's detail and its volume history sum the same valid-member set.
    expect(src.slice(src.indexOf('export async function getListTagDetail('), src.indexOf('\n}\n', src.indexOf('export async function getListTagDetail(')))).toContain('buildTagDetailForMembers(presentation, valid,')
    expect(body('getListTagVolumeHistory')).toContain('const valid = listTagMembers(members)')
    expect(body('getListTagVolumeHistory')).toContain('tradingVolumeAccountSet(valid)')
    expect(body('buildVolumeHistory')).toContain('const list = tradingVolumeList(volumeAccounts)')
    expect(body('buildVolumeHistory')).toContain('tradingVolumeTotals(client, list, cuts)')
  })
})

describe('volume-history routes', () => {
  const app = Fastify()
  beforeAll(async () => {
    await app.register(explorerRoutes)
    // A list-tag surface whose resolve refuses 'hidden' the way both real surfaces
    // refuse a tag the viewer may not see (a 404 that says nothing more).
    await app.register(async f => listTagReadRoutes(f, {
      base: '/test/list-tag/:tagId',
      resolve: (req, reply) => {
        if ((req.params as { tagId: string }).tagId === 'hidden') { reply.status(404).send({ error: 'Tag not found' }); return null }
        return { listId: 'L1', tagId: 'T1', tag: { name: 'n', color: '#000', icon: '', note: '', members: LIST_TAG_MEMBERS } }
      },
      valueFilters: () => ({}),
    }))
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { vs.calls.length = 0 })

  it('/explorer/tag/:tagId/volume-history: whole range, window, bad window, missing tag', async () => {
    expect((await app.inject('/explorer/tag/treasury/volume-history')).statusCode).toBe(200)
    expect(vs.calls.at(-1)).toEqual({ tagId: 'treasury', window: undefined })
    expect((await app.inject('/explorer/tag/treasury/volume-history?fromBlock=100&toBlock=200')).statusCode).toBe(200)
    expect(vs.calls.at(-1)).toEqual({ tagId: 'treasury', window: { fromBlock: 100, toBlock: 200 } })
    for (const bad of ['fromBlock=100', 'toBlock=200', 'fromBlock=200&toBlock=100', 'fromBlock=x&toBlock=2']) {
      expect((await app.inject(`/explorer/tag/treasury/volume-history?${bad}`)).statusCode, bad).toBe(400)
    }
    expect((await app.inject('/explorer/tag/missing/volume-history')).statusCode).toBe(404)
  })

  it('list tag volume-history: the resolved list tag\'s members, same window rules, refused like the detail', async () => {
    const all = await app.inject('/test/list-tag/T1/volume-history')
    expect(all.statusCode).toBe(200)
    expect(all.json()).toMatchObject({ totals: { all: 0 }, asOfBlock: 1 })
    expect(vs.calls.at(-1)).toEqual({ listId: 'L1', tagId: 'T1', members: LIST_TAG_MEMBERS, window: undefined })
    await app.inject('/test/list-tag/T1/volume-history?fromBlock=5&toBlock=9')
    expect(vs.calls.at(-1)).toEqual({ listId: 'L1', tagId: 'T1', members: LIST_TAG_MEMBERS, window: { fromBlock: 5, toBlock: 9 } })
    for (const bad of ['fromBlock=100', 'toBlock=200', 'fromBlock=9&toBlock=5']) {
      expect((await app.inject(`/test/list-tag/T1/volume-history?${bad}`)).statusCode, bad).toBe(400)
    }
    const calls = vs.calls.length
    const hidden = await app.inject('/test/list-tag/hidden/volume-history')
    const hiddenDetail = await app.inject('/test/list-tag/hidden')
    expect(hidden.statusCode).toBe(404)
    expect(hidden.body).toBe(hiddenDetail.body)
    expect(vs.calls.length).toBe(calls)
  })

  it('/explorer/address/:address/volume-history: whole range and window', async () => {
    const addr = '12VN3cXsgAjkQnbjEBRkydickdnnuAZwdUYaJWj1NJjzoq25'
    const all = await app.inject(`/explorer/address/${addr}/volume-history`)
    expect(all.statusCode).toBe(200)
    expect(all.json()).toMatchObject({ totals: { all: 0 }, asOfBlock: 1 })
    expect(vs.calls.at(-1)).toEqual({ address: addr, window: undefined })
    await app.inject(`/explorer/address/${addr}/volume-history?fromBlock=5&toBlock=9`)
    expect(vs.calls.at(-1)).toEqual({ address: addr, window: { fromBlock: 5, toBlock: 9 } })
    expect((await app.inject(`/explorer/address/${addr}/volume-history?fromBlock=9&toBlock=5`)).statusCode).toBe(400)
  })
})
