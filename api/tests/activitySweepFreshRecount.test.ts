import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { cachedFound, cachedSwr, peekCached, resetCacheForTests } from '../src/services/cache.ts'
import {
  activityBackfilledGkeys, recountActivityLeaderboardMember, scopedListTotalKey,
  type ActivityRecountDeps, type ActivitySourceMarks,
} from '../src/services/explorerService.ts'

// A backfill BELOW an account's newest block moves neither cache key a list total is
// read through: the SWR entry's generation and the held exact count's key are both the
// account's newest block. A sweep recount that went through those caches would get the
// pre-backfill total back — and store it beside the new source watermark, which would
// then never re-queue it again. The recount must be fresh, and must refresh the caches.
describe('a backfill-triggered activity recount', () => {
  const ACCOUNT = '0x' + 'ab'.repeat(32)
  const MARK = 9_000 // the account's newest block — unchanged by the backfill below it
  const HEAD = 10_000
  const key = scopedListTotalKey(`addr:${ACCOUNT}`, { tab: 'activity', type: 'all' })
  const heldKey = `${key}:count:w${MARK}`

  beforeEach(() => resetCacheForTests())

  it('counts fresh, persists the new watermark with that count, and refreshes both caches', async () => {
    // The page counted 10 rows at MARK; both caches hold that.
    await cachedFound(heldKey, 900_000, async () => ({ total: 10, complete: true, generation: MARK }))
    await cachedSwr(key, 120_000, 900_000, async () => ({ total: 10, complete: true }), MARK)
    const stored = { gkey: ACCOUNT, total: 10, complete: true, countedAt: new Date().toISOString(), rawHead: HEAD, rawKeys: 10, rawMmKeys: 0 }

    // Two rows are backfilled below MARK: the source watermark sees them …
    let sourceRows = 12
    const marks = async (): Promise<ActivitySourceMarks> => ({ activity: sourceRows, mm: 0, activityChange: '77', mmChange: '', mmFp: '' })
    expect([...activityBackfilledGkeys([stored], new Map([[ACCOUNT, await marks()]]))]).toEqual([ACCOUNT])

    // … and the cached path still answers the old total, which is the trap.
    expect((await cachedSwr(key, 120_000, 900_000, async () => ({ total: -1, complete: true }), MARK)).total).toBe(10)

    let counts = 0
    const deps: ActivityRecountDeps = {
      sourceMarks: async () => marks(),
      scope: async account => ({ gkey: account, accounts: [account], key }),
      watermark: async () => MARK,
      count: async () => { counts++; return { total: sourceRows, complete: true, generation: MARK } },
      refreshSnapshot: async () => {},
    }
    const result = await recountActivityLeaderboardMember(ACCOUNT, ACCOUNT, HEAD, deps)

    expect(counts).toBe(1)
    expect(result).toEqual({ gkey: ACCOUNT, total: { total: 12, complete: true }, source: { rawHead: HEAD, rawKeys: 12, rawMmKeys: 0, rawChange: '77', rawMmChange: '', rawMmFp: '' } })
    // The page now serves the swept number, from both caches.
    expect(peekCached(key)).toEqual({ total: 12, complete: true })
    expect(peekCached<{ total: number }>(heldKey)?.total).toBe(12)
    // And the stored entry no longer re-queues — until the source moves again.
    const recounted = { ...stored, total: 12, ...result!.source }
    expect([...activityBackfilledGkeys([recounted], new Map([[ACCOUNT, await marks()]]))]).toEqual([])
    sourceRows = 13
    expect([...activityBackfilledGkeys([recounted], new Map([[ACCOUNT, await marks()]]))]).toEqual([ACCOUNT])
  })

  it('reads the watermark before counting', async () => {
    const order: string[] = []
    const deps: ActivityRecountDeps = {
      sourceMarks: async () => { order.push('marks'); return { activity: 1, mm: 2, activityChange: '', mmChange: '', mmFp: '' } },
      scope: async account => { order.push('scope'); return { gkey: account, accounts: [account], key } },
      watermark: async () => { order.push('watermark'); return MARK },
      count: async () => { order.push('count'); return { total: 3, complete: true, generation: MARK } },
      refreshSnapshot: async () => { order.push('refresh') },
    }
    await recountActivityLeaderboardMember(ACCOUNT, ACCOUNT, HEAD, deps)
    expect(order).toEqual(['marks', 'scope', 'watermark', 'count'])
  })

  it('stores no watermark for a count that landed under another gkey, and holds no partial total', async () => {
    const deps: ActivityRecountDeps = {
      sourceMarks: async () => ({ activity: 5, mm: 0, activityChange: '', mmChange: '', mmFp: '' }),
      scope: async () => ({ gkey: 'some-tag', accounts: [ACCOUNT], key }),
      watermark: async () => MARK,
      count: async () => ({ total: 7, complete: false }),
      refreshSnapshot: async () => {},
    }
    const result = await recountActivityLeaderboardMember(ACCOUNT, ACCOUNT, HEAD, deps)
    expect(result).toEqual({ gkey: 'some-tag', total: { total: 7, complete: false } })
    expect(peekCached(key)).toEqual({ total: 7, complete: false })
    expect(peekCached(heldKey)).toBeUndefined()
  })

  // cachedSwr serves a superseded enumerated snapshot while its refresh runs, so the
  // exact count can come back built for a generation BELOW the scope's watermark. That
  // count predates the act that moved the watermark: installed, it would stand under the
  // current keys; persisted, beside the new source watermark, it would never re-queue.
  it('re-reads a superseded snapshot and installs only the count built at the watermark', async () => {
    const generations = [MARK - 5, MARK]
    const totals = [10, 12]
    const calls: string[] = []
    const deps: ActivityRecountDeps = {
      sourceMarks: async () => ({ activity: 12, mm: 0, activityChange: '', mmChange: '', mmFp: '' }),
      scope: async account => ({ gkey: account, accounts: [account], key }),
      watermark: async () => MARK,
      count: async () => { calls.push('count'); return { total: totals.shift()!, complete: true, generation: generations.shift() } },
      refreshSnapshot: async () => { calls.push('refresh') },
    }
    const result = await recountActivityLeaderboardMember(ACCOUNT, ACCOUNT, HEAD, deps)
    expect(calls).toEqual(['count', 'refresh', 'count'])
    expect(result?.total).toEqual({ total: 12, complete: true })
    expect(result?.source?.rawKeys).toBe(12)
    expect(peekCached(key)).toEqual({ total: 12, complete: true })
    expect(peekCached<{ total: number }>(heldKey)?.total).toBe(12)
  })

  it('installs and returns nothing to persist when every retry is still built below the watermark', async () => {
    // The page's caches hold the pre-act total; the stale recount must not replace it.
    await cachedSwr(key, 120_000, 900_000, async () => ({ total: 10, complete: true }), MARK - 5)
    let counts = 0
    let refreshes = 0
    const deps: ActivityRecountDeps = {
      sourceMarks: async () => ({ activity: 12, mm: 0, activityChange: '', mmChange: '', mmFp: '' }),
      scope: async account => ({ gkey: account, accounts: [account], key }),
      watermark: async () => MARK,
      count: async () => { counts++; return { total: 11, complete: true, generation: MARK - 5 } },
      refreshSnapshot: async () => { refreshes++ },
    }
    const result = await recountActivityLeaderboardMember(ACCOUNT, ACCOUNT, HEAD, deps, 2)
    expect(result).toEqual({ gkey: ACCOUNT, stale: { generation: MARK - 5, mark: MARK } })
    // Bounded: the first count plus two re-reads.
    expect(counts).toBe(3)
    expect(refreshes).toBe(2)
    expect(result?.total).toBeUndefined()
    expect(result?.source).toBeUndefined()
    expect(peekCached(key)).toEqual({ total: 10, complete: true })
    expect(peekCached(heldKey)).toBeUndefined()
  })

  it('leaves a stale recount due and unpersisted in the sweep', () => {
    const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
    const at = src.indexOf('async function refreshActivityLeaderboardUncached')
    const body = src.slice(at, src.indexOf('\n}\n', at))
    const stale = body.slice(body.indexOf('if (result?.stale) {'))
    const branch = stale.slice(0, stale.indexOf('continue') + 'continue'.length)
    // Neither the board entry nor countedNow (what persistActivityTotals writes) is touched.
    expect(branch).not.toMatch(/byGkey\.set|countedNow\.add/)
    expect(body.indexOf('if (result?.stale) {')).toBeLessThan(body.indexOf('countedNow.add(result.gkey)'))
  })
})
