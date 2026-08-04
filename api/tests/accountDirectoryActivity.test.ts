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
  it('counts pool members through the detail pages own totals', () => {
    const at = explorerService.indexOf('async function activityLeaderboardTotal')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}', at))

    // The same two functions /explorer/address/:a/list-count and /explorer/tag/:t/list-count
    // resolve to, asked for the same tab.
    expect(body).toContain('getAddressListTotal(account, query)')
    expect(body).toContain('getTagListTotal(tag.tagId, query)')
    expect(body).toContain(`{ tab: 'activity', type: 'all' }`)
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
  it('ranks only the leading run whose exact totals clear everything outside the pool', () => {
    const at = explorerService.indexOf('let rankedDepth = 0')
    expect(at).toBeGreaterThan(-1)
    const loop = explorerService.slice(at, at + 260)

    expect(loop).toContain('!entry.complete')
    expect(loop).toContain('entry.total < refsOutside')
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
    expect(body).toContain('await activityLeaderboardTotal(member.account)')
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
