import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { builtAtWatermark } from '../src/services/explorerService.ts'

// What countAccountActivity hands the hold: the list total plus the watermark the plan's
// enumerated snapshot was read for.
interface Counted { total: number | null; complete: boolean; generation?: number }

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const body = (name: string): string => {
  const at = explorerService.indexOf(name)
  expect(at, name).toBeGreaterThan(-1)
  // `\n}\n` rather than `\n}`: a nested object literal's closing brace is indented.
  const end = explorerService.indexOf('\n}\n', at)
  expect(end, name).toBeGreaterThan(at)
  return explorerService.slice(at, end)
}
const sites = (pattern: RegExp): number => (explorerService.match(pattern) ?? []).length
const constant = (name: string): number => {
  const match = explorerService.match(new RegExp(`const ${name} = ([0-9_]+)`))
  expect(match, name).not.toBeNull()
  return Number((match as RegExpMatchArray)[1].replaceAll('_', ''))
}

// A scoped activity total and a located page are pure functions of the scope's own rows.
// The scope's activity watermark says when that set last changed, so while it stands the
// answer cannot have: recomputing is guaranteed to return what is already held. Without
// this the whole-history count re-ran on a timer for accounts that had done nothing —
// measured at 665 calls and 1,118 CPU-seconds an hour, 12.3% of all ClickHouse query CPU,
// at a rate flat across the day because it followed a poll and not a user.
describe('a count is held for as long as the scope has not acted', () => {
  it('keys the exact recount on the watermark and holds only a complete, current count', () => {
    const held = body('async function heldActivityTotal')
    expect(held).toContain('cachedFound(`${key}:count:w${mark}`, ACTIVITY_WATERMARK_HOLD_MS')
    // Complete, because a partial total is counted to a frontier that moves with the head
    // rather than with the scope; current, because a count made while a superseded
    // snapshot was still being served predates the act that moved the watermark.
    expect(held).toContain('counted => counted.complete && builtAtWatermark(counted.generation, mark))')
    // The total the caller sees is the list-total shape, not the counted one: the
    // provenance exists to decide the hold and never reaches the wire.
    expect(held).toContain('return { total: counted.total, complete: counted.complete }')
  })

  it('holds a located page the same way, and never a refusal', () => {
    const held = body('async function heldLocatedActivityPage')
    expect(held).toContain('const mark = datedWindowIsClosed(to) ? 0 : await accountActivityWatermark(accounts)')
    expect(held).toContain(':w${mark}:')
    // `located != null` is the condition cachedFound's default would get wrong twice over:
    // an empty page is a real answer worth holding, and a refusal (null) is not, because
    // the windowed path answers it and a refusal can be transient.
    expect(held).toContain('located => located != null && builtAtWatermark(located.generation, mark))')
  })

  // Every value keyed by the watermark is trusted no longer than the page it appears on
  // already publishes its own total for. Anything the watermark cannot see — raw
  // backfilled below the head, a registry change that reroutes a share token's legs —
  // is corrected within that same window rather than a longer one.
  it('trusts a watermark-keyed value no longer than the list total itself is served', () => {
    expect(constant('ACTIVITY_WATERMARK_HOLD_MS')).toBe(constant('LIST_TOTAL_STALE_MS'))
    expect(constant('LIST_TOTAL_FRESH_MS')).toBeLessThan(constant('ACTIVITY_WATERMARK_HOLD_MS'))
  })

  // The generation is provenance carried on the value, so a consumer can tell a count
  // built at the watermark from one built from the snapshot that preceded it.
  it('treats a missing generation as unstaleable and an older one as superseded', () => {
    expect(builtAtWatermark(undefined, 14_757_426)).toBe(true)   // closed window, or a live read
    expect(builtAtWatermark(14_757_426, 14_757_426)).toBe(true)
    expect(builtAtWatermark(14_757_425, 14_757_426)).toBe(false) // built before the act
    expect(builtAtWatermark(14_757_427, 14_757_426)).toBe(true)  // built after it
  })

  // What the hold actually buys, against the cache itself.
  it('reuses an idle scope refresh and recounts the moment the scope acts', async () => {
    vi.resetModules()
    const { cachedFound } = await import('../src/services/cache.ts')
    const count = vi.fn()
      .mockResolvedValueOnce({ total: 100, complete: true, generation: 500 })
      .mockResolvedValueOnce({ total: 101, complete: true, generation: 501 })
    const held = (mark: number) => cachedFound<Counted>(`explorer:addr:0xaa:list-total:activity:count:w${mark}`, 900_000,
      count, counted => counted.complete && builtAtWatermark(counted.generation, mark))

    await expect(held(500)).resolves.toMatchObject({ total: 100 })
    // The scope did nothing, so every refresh its fresh window schedules finds the answer.
    await expect(held(500)).resolves.toMatchObject({ total: 100 })
    await expect(held(500)).resolves.toMatchObject({ total: 100 })
    expect(count).toHaveBeenCalledTimes(1)
    // It acts: a different key, so the count is made again rather than served.
    await expect(held(501)).resolves.toMatchObject({ total: 101 })
    expect(count).toHaveBeenCalledTimes(2)
  })

  it('does not hold a count built from the snapshot the act superseded', async () => {
    vi.resetModules()
    const { cachedFound } = await import('../src/services/cache.ts')
    // The scope acted at 501; the snapshot is still being refreshed, so the plan — and
    // the count over it — still describe 500.
    const count = vi.fn()
      .mockResolvedValueOnce({ total: 100, complete: true, generation: 500 })
      .mockResolvedValueOnce({ total: 101, complete: true, generation: 501 })
    const held = (mark: number) => cachedFound<Counted>('explorer:addr:0xbb:list-total:activity:count:w501', 900_000,
      count, counted => counted.complete && builtAtWatermark(counted.generation, mark))

    await expect(held(501)).resolves.toMatchObject({ total: 100 })
    // Not held under 501: the next read counts again instead of standing in for the
    // scope's newest rows for the whole hold.
    await expect(held(501)).resolves.toMatchObject({ total: 101 })
    expect(count).toHaveBeenCalledTimes(2)
    await expect(held(501)).resolves.toMatchObject({ total: 101 })
    expect(count).toHaveBeenCalledTimes(2)
  })

  it('does not hold a partial count under a watermark that does not govern it', async () => {
    vi.resetModules()
    const { cachedFound } = await import('../src/services/cache.ts')
    const count = vi.fn().mockResolvedValue({ total: 35_211, complete: false })
    const held = () => cachedFound<Counted>('explorer:tag:pallet-pots:list-total:activity:count:w500', 900_000,
      count, counted => counted.complete && builtAtWatermark(counted.generation, 500))

    await expect(held()).resolves.toMatchObject({ complete: false })
    await expect(held()).resolves.toMatchObject({ complete: false })
    expect(count).toHaveBeenCalledTimes(2)
  })
})

describe('the list total supersedes on the act, and the partial one on time alone', () => {
  it('carries the watermark as the entry generation only while the total is complete', () => {
    const total = body('async function scopedListTotal')
    expect(total).toContain("const live = query.tab === 'activity' && !datedWindowIsClosed(query.to)")
    // Read whether or not the list is partial. A partial list withholds it from the
    // GENERATION, but the recount below is still keyed on it, so the count that finally
    // comes back complete is held under the watermark it was made at rather than under a
    // placeholder that no act would ever move.
    expect(total).toContain('const mark = live ? await accountActivityWatermark(accounts) : 0')
    expect(total).toContain('return heldActivityTotal(accounts, key, mark, query)')
    expect(total).toContain('live && !partial ? mark : undefined)')
    // Whether a list is partial is only known once it has been counted; that is what
    // partialTotalLists records, and it stays the single mechanism for it.
    expect(total).toContain('const partial = partialTotalLists.has(key)')
    expect(total).toContain('if (!result.complete) partialTotalLists.set(key, Date.now() + LIST_TOTAL_PARTIAL_STALE_MS)')
  })

  // A structural pot's watermark moves every block, so as a generation it would supersede
  // the entry on every request and recount a 5-11s total each time. Time is the only thing
  // that may refresh a prefix total.
  it('leaves a partial total on its own clock', async () => {
    vi.resetModules()
    const { cachedSwr } = await import('../src/services/cache.ts')
    const key = 'explorer:tag:pallet-pots:list-total:activity'
    const count = vi.fn()
      .mockResolvedValueOnce({ total: 35_211, complete: false })
      .mockResolvedValueOnce({ total: 35_240, complete: false })

    await expect(cachedSwr(key, 300_000, 1_800_000, count, undefined)).resolves.toMatchObject({ total: 35_211 })
    // Several blocks later — the pot has acted in every one of them — and still no recount.
    await expect(cachedSwr(key, 300_000, 1_800_000, count, undefined)).resolves.toMatchObject({ total: 35_211 })
    expect(count).toHaveBeenCalledTimes(1)

    // A complete total on the same clock does supersede, which is the whole difference.
    const completeKey = 'explorer:addr:0xcc:list-total:activity'
    const complete = vi.fn()
      .mockResolvedValueOnce({ total: 1_005_254, complete: true })
      .mockResolvedValueOnce({ total: 1_005_255, complete: true })
    await expect(cachedSwr(completeKey, 120_000, 900_000, complete, 500)).resolves.toMatchObject({ total: 1_005_254 })
    // The reader is still served instantly from the held entry; the recount runs behind it.
    await expect(cachedSwr(completeKey, 120_000, 900_000, complete, 501)).resolves.toMatchObject({ total: 1_005_254 })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    await expect(cachedSwr(completeKey, 120_000, 900_000, complete, 501)).resolves.toMatchObject({ total: 1_005_255 })
  })
})

// The hold is worth nothing if a second caller counts the same feed a second way. Every
// surface that publishes a scoped activity total — the detail pages, the accounts
// leaderboard, the contracts directory, a user list's groups — reaches it through the one
// function, so all of them inherit both the number and the hold.
describe('every scoped activity total is counted through the one path', () => {
  it('routes all four list-total entry points through scopedListTotal', () => {
    for (const name of ['export async function getAddressListTotal', 'export async function getTagListTotal',
      'export async function getListTagListTotal']) {
      expect(body(name), name).toContain('scopedListTotal(')
    }
    expect(sites(/scopedListTotal\(/g)).toBe(4)   // definition + the three entry points
  })

  it('counts and locates in exactly one place each, behind the hold', () => {
    expect(sites(/countAccountActivity\(/g)).toBe(2)        // definition + heldActivityTotal
    expect(body('async function heldActivityTotal')).toContain('countAccountActivity(accounts, query.type')
    expect(sites(/heldActivityTotal\(/g)).toBe(2)
    expect(sites(/locatedAccountActivityPage\(/g)).toBe(2)  // definition + heldLocatedActivityPage
    expect(body('async function heldLocatedActivityPage')).toContain('locatedAccountActivityPage(accounts, type, limit, offset')
    expect(sites(/heldLocatedActivityPage\(/g)).toBe(2)
    expect(body('async function getAccountActivity')).toContain('await heldLocatedActivityPage(accounts, type, readLimit, readOffset')
    // The exact count is reached from the total and from a locate that found no block —
    // the offset-past-the-end case, which is what an idle watched account with no matching
    // rows hits on every poll. Both sit under a hold now.
    expect(sites(/countExactActivity\(/g)).toBe(3)
  })

  it('sweeps the directories through the very endpoints the detail pages call', () => {
    const leaderboard = body('async function activityLeaderboardTotal')
    expect(leaderboard).toContain('getTagListTotal(tag.tagId, query)')
    expect(leaderboard).toContain('getAddressListTotal(account, query)')
    expect(body('async function refreshContractActivityCounts'))
      .toContain("getAddressListTotal(address, { tab: 'activity', type: 'all' })")
    expect(body('async function sweepOneFoldGroup'))
      .toContain("getListTagListTotal(spec.listId, spec.tagId, spec.members, { tab: 'activity', type: 'all' })")
  })

  // The watermark read is on the request path of both the page and its total now. It is
  // one query per scope per couple of seconds, shared by every list a page asks for at
  // once — measured at 0.007 CPU-seconds for an account and 0.106 for the 730-member tag,
  // against the 1.68 CPU-seconds of the count it spares.
  it('reads the watermark once per scope per burst', () => {
    expect(body('async function accountActivityWatermark')).toContain("cached(`explorer:acct-watermark:${accounts.join(',')}`, 2_000")
    expect(sites(/accountActivityWatermark\(/g)).toBe(5)
  })
})
