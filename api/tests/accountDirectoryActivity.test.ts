import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// The directory's Activity column and the account detail page used to count different
// things under one word: distinct balance observations (6,129,461 for the busiest trader)
// beside the classified feed's own total (1,221,974). The column now carries the feed's
// number, and it stays that number by construction — the background ranking counts each
// pool member through the very endpoint the detail page reads, rather than through a
// second expression that could drift from it.
describe('the directory activity column is the feed total', () => {
  it('counts pool members through the detail pages own counting function and scope', () => {
    const at = explorerService.indexOf('async function activityLeaderboardScope')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}', at))

    // The same scope resolution /explorer/address/:a/list-count and
    // /explorer/tag/:t/list-count use, under the same cache key, for the same tab.
    expect(body).toContain('tagListScope(tag.tagId)')
    expect(body).toContain('await addressListScope(account)')
    expect(body).toContain('scopedListTotalKey(scope.scope, ACTIVITY_LEADERBOARD_QUERY)')
    expect(explorerService).toContain(`const ACTIVITY_LEADERBOARD_QUERY: ScopedListQuery = { tab: 'activity', type: 'all' }`)
    for (const fn of ['export async function getAddressListTotal', 'export async function getTagListTotal']) {
      const f = explorerService.slice(explorerService.indexOf(fn))
      expect(f.slice(0, f.indexOf('\n}'))).toMatch(/(addressListScope|tagListScope)\(/)
    }
    // And the count is the function heldActivityTotal counts the page's total with.
    const deps = explorerService.slice(explorerService.indexOf('const ACTIVITY_RECOUNT_DEPS'))
    expect(deps.slice(0, deps.indexOf('\n}'))).toContain('countAccountActivity(accounts, ACTIVITY_LEADERBOARD_QUERY.type!, undefined, {})')
  })

  // The balance-observation count is what the column used to show. Nothing may fill the
  // cell from it again — an absent number is the honest answer for an account the
  // ranking has not counted.
  it('never fills the column from the balance-observation count', () => {
    expect(explorerService).not.toContain('uniqMerge(activity_state)')
    expect(explorerService).not.toContain('uniqMerge(a.activity_state)')
  })

  // The ordering has to come from the same values the cells show, or a descending column
  // reads out of order.
  it('orders by the counted total, exact totals before partial ones', () => {
    const sortAt = explorerService.indexOf(`activity: 'activity_count_complete DESC`)
    expect(sortAt).toBeGreaterThan(-1)
    expect(explorerService.slice(sortAt, sortAt + 120)).toContain('activity_count DESC')
  })

  // A partial total is a floor, so it can neither be presented as exact nor establish a
  // rank the pool's reference bound has not covered.
  it('ranks only the leading run whose exact totals clear every row without a total', async () => {
    const { activityRankedDepth, activityLeaderboardBound } = await import('../src/services/explorerService.ts')
    const e = (gkey: string, total: number | null, complete = true) => ({ gkey, total, complete })
    const entries = [e('a', 900), e('b', 500), e('c', 120), e('d', 2000, false)]
    expect(activityRankedDepth(entries, 100)).toBe(3)
    expect(activityRankedDepth(entries, 600)).toBe(1)
    // A partial total never establishes a rank.
    expect(activityRankedDepth([e('p', 9999, false), e('a', 900)], 1)).toBe(0)

    const board = new Map(entries.map(x => [x.gkey, x]))
    const self = (account: string) => account
    // Nothing uncounted: the single-account bound.
    expect(activityLeaderboardBound(100, [{ account: 'a', refs: 5000 }], {}, board, self)).toBe(100)
    // An uncounted tag row is bounded by its members' summed references, not by one
    // account's: four members of 200 refs each can out-rank an exact 500.
    expect(activityLeaderboardBound(250, [], { 'lbp-pools': 800, b: 1e9 }, board, self)).toBe(800)
    // An uncounted pooled member (no total) bounds by its own refs — its tag's sum when tagged.
    const withNull = new Map([...board, ['z', e('z', null, false)]])
    expect(activityLeaderboardBound(100, [{ account: 'z', refs: 700 }], {}, withNull, self)).toBe(700)
    expect(activityLeaderboardBound(100, [{ account: 'm', refs: 700 }], { t: 1500 }, board, () => 't')).toBe(1500)
    expect(activityRankedDepth(entries, activityLeaderboardBound(250, [], { 'lbp-pools': 800 }, board, self))).toBe(1)
  })

  it('keeps a valid total through a failed recount, stamped, and moves it back in the queue', async () => {
    const { failedRecountEntry } = await import('../src/services/explorerService.ts')
    const prior = { gkey: 'a', total: 42, complete: true, countedAt: '2026-10-01T00:00:00.000Z' }
    expect(failedRecountEntry(prior, 'a', '2026-10-05T00:00:00.000Z')).toEqual({ ...prior, recountFailedAt: '2026-10-05T00:00:00.000Z' })
    expect(failedRecountEntry(undefined, 'b', 'T')).toEqual({ gkey: 'b', total: null, complete: false, countedAt: 'T' })
    const sweep = explorerService.slice(explorerService.indexOf('async function refreshActivityLeaderboardUncached'))
    expect(sweep.slice(0, sweep.indexOf('\n}\n'))).toContain('activityRankedDepth(entries, bound)')
  })

  it('propagates a totals write that keeps failing instead of publishing over it', () => {
    const at = explorerService.indexOf('async function persistActivityTotals')
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).not.toContain('.catch(')
    expect(body).toContain('if (attempt >= ACTIVITY_TOTALS_PERSIST_ATTEMPTS) throw error')
  })

  // The whole point of the pool is that it is provably a superset of the true top N, and
  // that rests on a reference count bounding an account's feed total from above.
  it('takes the pool by reference count, and keeps the first count left outside it', () => {
    const at = explorerService.indexOf('async function activityLeaderboardPool')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    expect(body).toContain('price_data.account_activity_v3')
    expect(body).toContain('ORDER BY count() DESC')
    expect(body).toContain('ACTIVITY_LEADERBOARD_POOL + 1')
    expect(body).toContain('refsOutside')
  })

  // Building the ranking is minutes of work; a request must never trigger it.
  it('never rebuilds the ranking on the request path', () => {
    const at = explorerService.indexOf('async function ensureActivityLeaderboard')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}', at))

    expect(body).toContain('loadActivityLeaderboard')
    expect(body).not.toContain('refreshActivityLeaderboard')
    // And the background pass is the thing that does build it.
    expect(explorerService).toContain('await refreshActivityLeaderboard().catch(')
  })

  // A whole-history count is the most expensive read the API issues. Riding the
  // five-minute directory prewarm recounted all 250 pool members 288 times a day — every
  // one of them past its cache's two-minute fresh window on every cycle — which cost
  // ClickHouse ~19 cores and ~60 TiB an hour. The pass owns its own slow interval and
  // recounts only what has aged out.
  it('runs on its own interval, not the directory prewarm', () => {
    const at = explorerService.indexOf('async function prewarmAccountDirectoryUncached')
    expect(at).toBeGreaterThan(-1)
    expect(explorerService.slice(at, explorerService.indexOf('\n}', at))).not.toContain('refreshActivityLeaderboard')

    const start = explorerService.indexOf('export function startActivityLeaderboardRefresh')
    expect(start).toBeGreaterThan(-1)
    expect(explorerService.slice(start, explorerService.indexOf('\n}', start))).toContain('ACTIVITY_LEADERBOARD_REFRESH_MS')
  })

  it('counts only aged-out members, one at a time, with a cooldown', () => {
    const at = explorerService.indexOf('async function refreshActivityLeaderboardUncached')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    // Nothing inside its TTL is recounted, and a cycle takes at most a fixed few.
    expect(body).toContain('ACTIVITY_LEADERBOARD_ENTRY_TTL_MS')
    expect(body).toContain('ACTIVITY_LEADERBOARD_COUNTS_PER_CYCLE')
    expect(body).toContain('ACTIVITY_LEADERBOARD_COUNT_COOLDOWN_MS')
    // Sequential: each count is awaited, so the pass never has two in flight.
    expect(body).toContain('await recountActivityLeaderboardMember(gkey, member.account, cycleHead)')
  })

  // The pacing constants are only sound as a RELATIONSHIP: the counting rate has to
  // clear BOTH halves of the pool — the reference members and the demand-driven ones
  // the directory renders — within the freshness window, or entries age out faster
  // than the pass returns to them. Shipping 3 per cycle gave 144 counts per window
  // against 174 groups. Pin the arithmetic rather than the numbers, so tuning any one
  // of them has to keep it.
  it('counts fast enough to cover its whole pool inside the entry TTL', () => {
    const constant = (name: string): number => {
      const m = new RegExp(`const ${name} = ([^\n]+)`).exec(explorerService)
      expect(m, name).not.toBeNull()
      // The declarations are plain arithmetic over literals (e.g. `12 * 3_600_000`).
      return Number(new Function(`return ${m![1].replace(/;.*$/, '')}`)())
    }
    const pool = constant('ACTIVITY_LEADERBOARD_POOL') + constant('ACTIVITY_LEADERBOARD_DIRECTORY_POOL_MAX')
    const perCycle = constant('ACTIVITY_LEADERBOARD_COUNTS_PER_CYCLE')
    const cycleMs = constant('ACTIVITY_LEADERBOARD_REFRESH_MS')
    const ttlMs = constant('ACTIVITY_LEADERBOARD_ENTRY_TTL_MS')
    const cooldownMs = constant('ACTIVITY_LEADERBOARD_COUNT_COOLDOWN_MS')

    const countsPerWindow = (ttlMs / cycleMs) * perCycle
    expect(countsPerWindow, `${countsPerWindow} counts per TTL vs a ${pool}-member pool`).toBeGreaterThanOrEqual(pool)
    // And a cycle's own counting must still fit inside the cycle, cooldowns included,
    // or passes would pile up instead of idling between them.
    expect(perCycle * cooldownMs).toBeLessThan(cycleMs / 2)
  })

  // The reference pool is a whole-table group-by (26 GiB). Its membership moves over days.
  it('reuses the published reference pool until it ages out', () => {
    const at = explorerService.indexOf('async function activityLeaderboardPool')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))

    expect(body).toContain('ACTIVITY_LEADERBOARD_POOL_TTL_MS')
    expect(body).toContain('published.poolAt')
  })
})

// The demand half of the pool: whatever the directory prewarm just rendered. This is
// what makes the Activity column fill in for the pages a reader opens, rather than only
// for the chain's busiest accounts.
describe('the demand-driven half of the activity pool', () => {
  const ACC = (b: string) => '0x' + b.repeat(32)
  const A = ACC('aa'), B = ACC('bb'), C = ACC('cc')

  it('takes a rendered row\'s grouping key: a tag id, else the account', async () => {
    const { directoryRowGkeys } = await import('../src/services/explorerService.ts')
    const rows = [
      { tag: { tagId: 'money-market' }, account: null },
      { tag: null, account: { accountId: A } },
      { tag: null, account: null },                      // a bare simAccount row — no key
    ] as unknown as Parameters<typeof directoryRowGkeys>[0]
    expect(directoryRowGkeys(rows)).toEqual(['money-market', A])
  })

  it('maps each key to an account it can be counted through, skipping the reference pool', async () => {
    const { demandPoolMembers } = await import('../src/services/explorerService.ts')
    const memberOfTag = (tagId: string) => (tagId === 'money-market' ? C : null)
    const out = demandPoolMembers(['money-market', A, B], new Set([B]), memberOfTag)
    // A tag is counted through one of its members; B is already pooled; refs 0 puts
    // these behind the reference members in the due order.
    expect(out).toEqual([{ account: C, refs: 0 }, { account: A, refs: 0 }])
  })

  it('drops a key nothing can be counted through, and deduplicates', async () => {
    const { demandPoolMembers } = await import('../src/services/explorerService.ts')
    // The same tag leads several sorts, so it arrives repeatedly; an empty tag has no
    // member to count through and is skipped rather than guessed at.
    expect(demandPoolMembers(['ghost', 'ghost', A, A], new Set(), () => null))
      .toEqual([{ account: A, refs: 0 }])
  })

  it('is bounded, so a pathological page cannot grow the pool without limit', async () => {
    const { demandPoolMembers } = await import('../src/services/explorerService.ts')
    const many = Array.from({ length: 50 }, (_, i) => '0x' + String(i).padStart(64, '0'))
    expect(demandPoolMembers(many, new Set(), () => null, 10)).toHaveLength(10)
  })

  // A failed or half-finished prewarm must not narrow the pool to whatever it managed.
  it('replaces the published set whole, only when the pass rendered something', () => {
    const at = explorerService.indexOf('async function prewarmAccountDirectoryUncached')
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('if (rendered.length) directoryPoolGkeys = rendered')
    expect(body).not.toContain('directoryPoolGkeys.push')
  })
})

// A stored total whose row has left both pools is still in the swept table and still
// rendered wherever the directory shows that row, so it must keep being recounted — or
// be dropped. Carried forward untouched, one read 146 against a live 226 a month on.
describe('carried-forward activity totals', () => {
  const H = 3_600_000
  const ACC = (b: string) => '0x' + b.repeat(32)
  const P = ACC('01'), Q = ACC('02'), X = ACC('0a'), Y = ACC('0b'), Z = ACC('0c')
  const entry = (gkey: string, ageH: number) => ({ gkey, total: 1, complete: true, countedAt: String(ageH) })
  const boardOf = (...list: ReturnType<typeof entry>[]) => new Map(list.map(e => [e.gkey, e]))
  // Ages in hours stand in for timestamps; an entry that is absent has never been counted.
  const ageOf = (e: { countedAt?: string } | undefined) => (e?.countedAt == null ? Infinity : Number(e.countedAt) * H)
  const self = (account: string) => account
  const noTag = () => null

  it('recounts a stale carried entry from the budget the pools leave over, pool first', async () => {
    const { activityLeaderboardSchedule } = await import('../src/services/explorerService.ts')
    const board = boardOf(entry(P, 13), entry(Q, 1), entry(X, 20), entry(Y, 700))
    const { due, dropped } = activityLeaderboardSchedule([{ account: P, refs: 9 }, { account: Q, refs: 8 }], board, self, noTag, ageOf, 3)
    // P is a stale pool member; Q is fresh. Y (700 h) is older than X, so it goes first.
    expect(due.map(([gkey]) => gkey)).toEqual([P, Y, X])
    expect(dropped).toEqual([])
  })

  it('never lets a carried entry take a pool member\'s count', async () => {
    const { activityLeaderboardSchedule } = await import('../src/services/explorerService.ts')
    const board = boardOf(entry(P, 13), entry(Q, 13), entry(X, 20))
    const { due } = activityLeaderboardSchedule([{ account: P, refs: 9 }, { account: Q, refs: 8 }], board, self, noTag, ageOf, 2)
    expect(due.map(([gkey]) => gkey).sort()).toEqual([P, Q].sort())
  })

  it('drops a carried entry the budget cannot reach once it is past the carried bound, never a fresh one', async () => {
    const { activityLeaderboardSchedule } = await import('../src/services/explorerService.ts')
    const board = boardOf(entry(X, 700), entry(Y, 40), entry(Z, 20))
    const { due, dropped } = activityLeaderboardSchedule([], board, self, noTag, ageOf, 1)
    expect(due.map(([gkey]) => gkey)).toEqual([X])
    // Y is 40 h old (past 36 h) and was not reached; Z is stale but still inside the bound.
    expect(dropped).toEqual([Y])
  })

  it('counts a carried tag through a member, and drops a key that no longer names its own row', async () => {
    const { activityLeaderboardSchedule } = await import('../src/services/explorerService.ts')
    const board = boardOf(entry('treasury', 20), entry('ghost', 20), entry(X, 20))
    // X has since been tagged, so the directory groups it under 'treasury' now.
    const gkeyOf = (account: string) => (account === X || account === Z ? 'treasury' : account)
    const memberOfTag = (tagId: string) => (tagId === 'treasury' ? Z : null)
    const { due, dropped } = activityLeaderboardSchedule([], board, gkeyOf, memberOfTag, ageOf, 5)
    expect(due).toEqual([['treasury', { account: Z, refs: 0 }]])
    expect(dropped.sort()).toEqual(['ghost', X].sort())
  })

  // Backward ingestion under a stored count (a backfill or repair below the head it was
  // taken at) re-queues the entity at once; forward growth above that head waits its TTL.
  it('re-queues an entity whose source gained rows below its count\'s head, inside its TTL', async () => {
    const { activityBackfilledGkeys, activityLeaderboardSchedule } = await import('../src/services/explorerService.ts')
    const withMark = (gkey: string, ageH: number, rawKeys: number) => ({ ...entry(gkey, ageH), rawHead: 100, rawKeys })
    const board = boardOf(withMark(P, 1, 10), withMark(Q, 1, 10), entry(X, 1))
    const m = (activity: number, mm = 0) => ({ activity, mm, activityChange: '', mmChange: '', mmFp: '' })
    const backfilled = activityBackfilledGkeys(board.values(), new Map([[P, m(12)], [Q, m(10)], [X, m(99)]]))
    // P gained two rows at or below block 100; Q did not; X carries no watermark (counted before it existed).
    expect([...backfilled]).toEqual([P])
    const age = (e: { gkey: string; countedAt?: string } | undefined) => (e && backfilled.has(e.gkey) ? Infinity : ageOf(e))
    const { due } = activityLeaderboardSchedule([{ account: P, refs: 9 }, { account: Q, refs: 8 }], board, self, noTag, age, 5)
    expect(due.map(([gkey]) => gkey)).toEqual([P])
  })

  it('stores the watermark read before the count, and only with that fresh count', () => {
    const sweep = explorerService.slice(explorerService.indexOf('async function refreshActivityLeaderboardUncached'))
    const body = sweep.slice(0, sweep.indexOf('\n}\n'))
    expect(body).toContain('...(result.source ?? {})')
    expect(body).toContain('backfilled.has(e.gkey) ? Infinity')
    const recount = explorerService.slice(explorerService.indexOf('export async function recountActivityLeaderboardMember'))
    const recountBody = recount.slice(0, recount.indexOf('\n}\n'))
    expect(recountBody.indexOf('await deps.sourceMarks(gkey, head)')).toBeGreaterThan(-1)
    expect(recountBody.indexOf('await deps.sourceMarks(gkey, head)')).toBeLessThan(recountBody.indexOf('await deps.count(scope.accounts)'))
    // Never through the cached list total, which a below-head backfill does not supersede.
    expect(recountBody).not.toMatch(/getAddressListTotal|getTagListTotal|scopedListTotal\(|heldActivityTotal/)
    expect(recountBody).toContain('installActivityListTotal(scope.key, mark, counted)')
    const persist = explorerService.slice(explorerService.indexOf('async function persistActivityTotals'))
    const persistBody = persist.slice(0, persist.indexOf('\n}\n'))
    for (const column of ['raw_watermark:', 'raw_head:', 'raw_keys:', 'raw_mm_keys:', 'raw_change:', 'raw_mm_change:', 'raw_mm_fp:']) expect(persistBody).toContain(column)
  })

  // A ReplacingMergeTree merge collapsing replayed duplicates lowers a physical count(),
  // which would offset a backfill of the same size: the requeue compares DISTINCT
  // identities (FINAL on the sort key, per partition), never physical rows — for every
  // independently indexed source the count reads.
  it('compares deduplicated identities of every independently indexed source', () => {
    const at = explorerService.indexOf('async function activitySourceRefs')
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('FROM ${table} FINAL\n')
    expect(body).toContain('do_not_merge_across_partitions_select_final: 1')
    const tables = explorerService.slice(explorerService.indexOf('const ACTIVITY_SOURCE_TABLES'))
    const tablesBody = tables.slice(0, tables.indexOf('\n}\n'))
    expect(tablesBody).toContain(`table: 'price_data.account_activity_v3', column: 'account'`)
    expect(tablesBody).toContain(`table: 'price_data.account_money_market_activity', column: 'account_id'`)
    expect(tablesBody).toContain('accounts.map(evmAccountForm)')
  })

  it('compares only watermarks of the deduplicated measure', async () => {
    const { activityBackfilledGkeys } = await import('../src/services/explorerService.ts')
    // An entry carrying only the retired physical rawRefs is not compared at all.
    const legacy = { ...entry(P, 1), rawHead: 100, rawRefs: 10 } as unknown as Parameters<typeof activityBackfilledGkeys>[0] extends Iterable<infer E> ? E : never
    expect([...activityBackfilledGkeys([legacy], new Map([[P, { activity: 99, mm: 99, activityChange: '9', mmChange: '2026-10-05 00:00:00', mmFp: '' }]]))]).toEqual([])
  })

  // The money market is fed from its own raw ingestion (raw_money_market_events), so it
  // can be repaired while account_activity_v3 stays put.
  it('re-queues a money-market-only repair, and never offsets one source by another', async () => {
    const { activityBackfilledGkeys } = await import('../src/services/explorerService.ts')
    const at = (gkey: string, rawKeys: number, rawMmKeys?: number) => ({ ...entry(gkey, 1), rawHead: 100, rawKeys, ...(rawMmKeys == null ? {} : { rawMmKeys }) })
    const board = [at(P, 10, 5), at(Q, 10, 5), at(X, 10, 5), at(Y, 10)]
    const now = new Map([
      [P, { activity: 10, mm: 7, activityChange: '', mmChange: '', mmFp: '' }],  // mm repaired below the head, activity unchanged
      [Q, { activity: 10, mm: 5, activityChange: '', mmChange: '', mmFp: '' }],  // nothing changed
      [X, { activity: 12, mm: 3, activityChange: '', mmChange: '', mmFp: '' }],  // activity grew while mm shrank: still re-queued
      [Y, { activity: 10, mm: 50, activityChange: '', mmChange: '', mmFp: '' }], // legacy entry without an mm watermark: not compared on mm
    ])
    expect([...activityBackfilledGkeys(board, now)].sort()).toEqual([P, X].sort())
  })

  // A repair that REPLACES a row under its key (a money-market log re-decoded with a
  // corrected pool_address) leaves every identity count where it was; only the change mark
  // read over the same deduplicated rows moves.
  it('re-queues a same-key correction through the change marks, and nothing else', async () => {
    const { activityBackfilledGkeys } = await import('../src/services/explorerService.ts')
    const at = (gkey: string, extra: Record<string, unknown> = {}) => ({ ...entry(gkey, 1), rawHead: 100, rawKeys: 10, rawMmKeys: 5, rawChange: '1234', rawMmChange: '2026-10-05 10:00:00', ...extra })
    const board = [at(P), at(Q), at(X), at(Y, { rawChange: undefined, rawMmChange: undefined })]
    const now = new Map([
      // pool_address corrected: same identities, the replacement's newer ingested_at
      [P, { activity: 10, mm: 5, activityChange: '1234', mmChange: '2026-10-05 11:00:00', mmFp: '' }],
      // nothing changed
      [Q, { activity: 10, mm: 5, activityChange: '1234', mmChange: '2026-10-05 10:00:00', mmFp: '' }],
      // an activity row re-decoded under its key: same identities, new content fingerprint
      [X, { activity: 10, mm: 5, activityChange: '98765', mmChange: '2026-10-05 10:00:00', mmFp: '' }],
      // counted before the marks existed: compared on the identities alone
      [Y, { activity: 10, mm: 5, activityChange: '98765', mmChange: '2026-10-05 11:00:00', mmFp: '' }],
    ])
    expect([...activityBackfilledGkeys(board, now)].sort()).toEqual([P, X].sort())
  })

  // A correction ingested in the SAME SECOND as the row it replaces (identical
  // ingested_at, pool_address changed): identities and max(ingested_at) stand still, only
  // the content fingerprint moves — and that alone re-queues the entity.
  it('re-queues a same-second money-market correction through the fingerprint', async () => {
    const { activityBackfilledGkeys } = await import('../src/services/explorerService.ts')
    const stamp = '2026-10-05 10:00:00'
    const at = (gkey: string, extra: Record<string, unknown> = {}) => ({ ...entry(gkey, 1), rawHead: 100, rawKeys: 10, rawMmKeys: 5, rawChange: '1234', rawMmChange: stamp, rawMmFp: '555', ...extra })
    const board = [at(P), at(Q), at(Y, { rawMmFp: undefined })]
    const now = new Map([
      [P, { activity: 10, mm: 5, activityChange: '1234', mmChange: stamp, mmFp: '777' }], // same second, new pool_address
      [Q, { activity: 10, mm: 5, activityChange: '1234', mmChange: stamp, mmFp: '555' }], // nothing changed
      [Y, { activity: 10, mm: 5, activityChange: '1234', mmChange: stamp, mmFp: '777' }], // stored before the fingerprint: compared on the rest
    ])
    expect([...activityBackfilledGkeys(board, now)]).toEqual([P])
  })

  it('reads each source\'s change mark with its identities, over the same FINAL rows', () => {
    const tables = explorerService.slice(explorerService.indexOf('const ACTIVITY_SOURCE_TABLES'))
    const tablesBody = tables.slice(0, tables.indexOf('\n}\n'))
    // The fingerprint covers the key, so two accounts' rows for one event cannot cancel.
    expect(tablesBody).toContain('groupBitXor(cityHash64(account, block_height, event_index, isNull(extrinsic_index), ifNull(extrinsic_index, 0), event_name, block_timestamp, is_module_transfer, asset_id, amount, has_amount))')
    expect(tablesBody).toContain('toString(max(ingested_at))')
    // The money-market fingerprint: every column, key and ingested_at included, Nullable
    // ones as isNull + ifNull (a NULL would drop the row out of groupBitXor).
    expect(tablesBody).toContain("groupBitXor(cityHash64(account_id, block_height, event_index, event_name, block_timestamp, asset_address, isNull(pool_address), ifNull(pool_address, ''), isNull(amount), ifNull(amount, ''), liquidated_collateral_amount, ingested_at))")
    const at = explorerService.indexOf('async function activitySourceRefs')
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('toString(count()) AS refs, ${change} AS change, ${fingerprint ?? "\'\'"} AS fp FROM ${table} FINAL')
  })

  it('leaves the table only through the drop, and only drops what the delete removed', () => {
    const at = explorerService.indexOf('async function refreshActivityLeaderboardUncached')
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toContain('activityLeaderboardSchedule(')
    expect(body).toContain('if (dropped.length && await dropActivityTotals(dropped))')
  })
})
