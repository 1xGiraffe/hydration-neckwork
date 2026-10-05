import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createActivityCountLane, type LaneTotal } from '../src/services/activityCountLane.ts'

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function lane(overrides: Partial<Parameters<typeof createActivityCountLane>[0]> = {}) {
  const calls: string[] = []
  const pending = new Map<string, ReturnType<typeof deferred<LaneTotal | null>>>()
  let clock = 1_000_000
  const l = createActivityCountLane({
    count: key => { calls.push(key); const d = deferred<LaneTotal | null>(); pending.set(key, d); return d.promise },
    concurrency: 2, queueMax: 3, perRequestMax: 10, freshMs: 1_000, maxAgeMs: 10_000, failMs: 3_000, entriesMax: 100,
    now: () => clock,
    ...overrides,
  })
  return { l, calls, pending, tick: (ms: number) => { clock += ms } }
}

describe('directory activity count lane', () => {
  it('never runs more than `concurrency` counts and never queues past `queueMax`', async () => {
    const { l, calls } = lane()
    const answer = await l.request(['a', 'b', 'c', 'd', 'e', 'f'], 0)
    // Two counting, three waiting, the sixth refused for now — all six pending.
    expect(calls).toEqual(['a', 'b'])
    expect(l.stats()).toMatchObject({ running: 2, queued: 3 })
    expect(answer.pending).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(answer.counts).toEqual({})
  })

  it('answers what finished inside the wait and reports the rest pending', async () => {
    const { l, pending } = lane()
    const ask = l.request(['a', 'b'], 50)
    await flush()
    pending.get('a')!.resolve({ total: 12, complete: true })
    const answer = await ask
    expect(answer.counts).toEqual({ a: { total: 12, complete: true } })
    expect(answer.pending).toEqual(['b'])
  })

  it('counts a key once while it is fresh, and serves a stale one while it recounts', async () => {
    const { l, calls, pending, tick } = lane()
    const first = l.request(['a'], 1_000)
    await flush()
    pending.get('a')!.resolve({ total: 5, complete: true })
    expect((await first).counts.a).toEqual({ total: 5, complete: true })
    tick(500)
    expect((await l.request(['a'], 1_000)).counts.a?.total).toBe(5)
    expect(calls).toEqual(['a'])
    tick(2_000)
    // Past fresh, inside maxAge: the old value comes back at once and a recount starts.
    const stale = await l.request(['a'], 1_000)
    expect(stale.counts.a?.total).toBe(5)
    expect(stale.pending).toEqual([])
    expect(calls).toEqual(['a', 'a'])
  })

  it('records an uncountable key (null) apart from a failed count, retrying a failure only after failMs', async () => {
    const errors: string[] = []
    const { l, calls, pending, tick } = lane({ freshMs: 5_000, onError: key => { errors.push(key) } })
    const ask = l.request(['a', 'b'], 1_000)
    await flush()
    pending.get('a')!.resolve(null)
    pending.get('b')!.reject(new Error('boom'))
    // A valid null is an answer; a failure is reported as failed, never as null.
    expect(await ask).toEqual({ counts: { a: null }, pending: [], failed: ['b'] })
    expect(errors).toEqual(['b'])
    expect(await l.request(['a', 'b'], 0)).toEqual({ counts: { a: null }, pending: [], failed: ['b'] })
    expect(calls).toEqual(['a', 'b'])
    // Past failMs (well inside maxAge) the failed key is counted again; the null is not.
    tick(3_500)
    const retry = await l.request(['a', 'b'], 0)
    expect(calls).toEqual(['a', 'b', 'b'])
    expect(retry.pending).toEqual(['b'])
    expect(retry.counts).toEqual({ a: null })
  })

  it('caps the keys one request enqueues and serves requests round-robin', async () => {
    const { l, calls, pending } = lane({ concurrency: 1, queueMax: 100, perRequestMax: 3 })
    // A big page asks first: only three of its keys enter the queue.
    const big = await l.request(['a1', 'a2', 'a3', 'a4', 'a5'], 0)
    expect(big.pending).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
    expect(l.stats()).toMatchObject({ running: 1, queued: 2 })
    // A second reader's keys do not wait behind the whole first page.
    await l.request(['b1', 'b2'], 0)
    const finish = async (key: string) => { pending.get(key)!.resolve({ total: 1, complete: true }); await flush() }
    await finish('a1')
    await finish('a2')
    await finish('b1')
    await finish('a3')
    // a2 was waiting before the second reader arrived; from then on the two
    // alternate, where a FIFO would have run a3 (and any more of the page)
    // before b1.
    expect(calls).toEqual(['a1', 'a2', 'b1', 'a3', 'b2'])
  })
})

describe('the directory activity lane counts through the detail pages own totals', () => {
  const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  const at = src.indexOf('const directoryActivityLane = createActivityCountLane(')
  const body = src.slice(at, src.indexOf('\n})', at))
  it('asks getAddressListTotal / getTagListTotal for the activity tab, never a proxy', () => {
    expect(at).toBeGreaterThan(-1)
    expect(body).toContain("{ tab: 'activity', type: 'all' }")
    expect(body).toContain('getAddressListTotal(key, query)')
    expect(body).toContain('getTagListTotal(key, query)')
  })
  it('never writes the swept table, so the activity sort stays the sweep ranking', () => {
    const lane = src.slice(src.indexOf('// ─── Activity totals for the rows a reader is looking at'), src.indexOf('export async function getDirectoryActivityCounts'))
    expect(lane).not.toContain('persistActivityTotals')
    expect(lane).not.toContain('account_activity_totals')
  })
})
