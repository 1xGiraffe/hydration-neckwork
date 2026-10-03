import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCacheForTests } from '../src/services/cache.ts'
import {
  lastClosedBucketStart, pricePipelineHead, publishRouteTailHead, resetRouteTailForTests, tailInputsAt, type TailInputs,
} from '../src/services/pairPriceSource.ts'

// The route-priced live tail is keyed on the raw head, not on a timer: it is
// rebuilt once per head a request reaches, shared by every concurrent request, and
// never rebuilt while the head stands still — so a candle is route-priced up to a
// new block as soon as anyone asks after it lands, at today's cost.

let rawHead = 100
let headReads = 0
const client = {
  query: vi.fn(async ({ query }: { query: string }) => {
    if (query.includes('raw_ingestion_state')) { headReads++; return { json: async () => [{ h: rawHead }] } }
    if (query.includes('AS b, toUnixTimestamp(block_timestamp) AS t')) return { json: async () => [{ b: '15338000', t: '1791020600' }] }
    throw new Error(`unexpected query: ${query}`)
  }),
} as never

const tail = (head: number): TailInputs => ({ inputs: {} as never, from: head - 10, head })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_791_020_000_000)
  resetCacheForTests()
  resetRouteTailForTests()
  rawHead = 100
  headReads = 0
})
afterEach(() => { vi.useRealTimers() })

/** Lets the one-second head probe expire. */
const nextProbe = () => vi.setSystemTime(Date.now() + 1_100)

describe('route tail keyed on the head', () => {
  it('builds once per head and reuses it however long the head stands still', async () => {
    const build = vi.fn(async (h: number) => tail(h))
    expect((await tailInputsAt(client, 0, build))?.head).toBe(100)
    // Far past the old 6 s TTL: the head did not move, so nothing is rebuilt.
    vi.setSystemTime(Date.now() + 60_000)
    expect((await tailInputsAt(client, 0, build))?.head).toBe(100)
    expect(build).toHaveBeenCalledTimes(1)
    expect(headReads).toBe(2)
  })

  it('rebuilds as soon as the head moves, without waiting out a TTL', async () => {
    const build = vi.fn(async (h: number) => tail(h))
    await tailInputsAt(client, 0, build)
    rawHead = 103
    nextProbe()
    expect((await tailInputsAt(client, 0, build))?.head).toBe(103)
    expect(build.mock.calls.map(c => c[0])).toEqual([100, 103])
  })

  it('shares one build among concurrent requests for a head (single flight)', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const build = vi.fn(async (h: number) => { await gate; return tail(h) })
    const all = Promise.all([tailInputsAt(client, 0, build), tailInputsAt(client, 0, build), tailInputsAt(client, 0, build)])
    await Promise.resolve()
    release()
    expect((await all).map(t => t?.head)).toEqual([100, 100, 100])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('reaches a pushed head before the probe sees it, and a caller\'s floor', async () => {
    const build = vi.fn(async (h: number) => tail(h))
    await tailInputsAt(client, 0, build)
    // The SSE poller publishes the head it is about to push; the probe is still cached at 100.
    publishRouteTailHead(105)
    expect((await tailInputsAt(client, 0, build))?.head).toBe(105)
    // A caller that already clamped to a newer block (the closed-candle head) is never served an older tail.
    expect((await tailInputsAt(client, 107, build))?.head).toBe(107)
    expect(build.mock.calls.map(c => c[0])).toEqual([100, 105, 107])
  })

  it('serves a newer build to a request keyed on an older head', async () => {
    const build = vi.fn(async (h: number) => tail(h))
    await tailInputsAt(client, 110, build)
    expect((await tailInputsAt(client, 0, build))?.head).toBe(110)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('serves the last good tail when a rebuild fails', async () => {
    const build = vi.fn(async (h: number) => { if (h > 100) throw new Error('boom'); return tail(h) })
    await tailInputsAt(client, 0, build)
    rawHead = 101
    nextProbe()
    expect((await tailInputsAt(client, 0, build))?.head).toBe(100)
  })

  it('fails a cold build rather than inventing a tail', async () => {
    await expect(tailInputsAt(client, 0, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  })
})

describe('closed buckets by the finalized head', () => {
  it('the last closed bucket is the newest one that ENDED at or before the head block', () => {
    const t = Date.parse('2026-08-17T11:59:30Z') / 1000
    expect(lastClosedBucketStart(t, 300)).toBe(Date.parse('2026-08-17T11:50:00Z') / 1000)
    // A head block exactly on the boundary belongs to the next bucket: the one before it is whole.
    expect(lastClosedBucketStart(Date.parse('2026-08-17T12:00:00Z') / 1000, 300)).toBe(Date.parse('2026-08-17T11:55:00Z') / 1000)
    // The Monday-anchored weekly grid.
    expect(lastClosedBucketStart(Date.parse('2026-08-17T00:00:30Z') / 1000, 604_800, 345_600)).toBe(Date.parse('2026-08-10T00:00:00Z') / 1000)
  })

  it('reads the price pipeline head as numbers', async () => {
    expect(await pricePipelineHead(client)).toEqual({ block: 15_338_000, time: 1_791_020_600 })
  })
})
