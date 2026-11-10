import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACTIVITY_PAGE_MARK_COVERAGE, SETTLED_ACTIVITY_PAGE_MS, scopedActivityPageTtlMs, trappedArrivalMark,
  type ActivityMarkArm, type ActivityRow,
} from '../src/services/explorerService.ts'
import type { TrappedArrival } from '../src/services/xcmTrappedArrivals.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const evaluator = readFileSync(new URL('../src/notifications/evaluator.ts', import.meta.url), 'utf8')

const bodyOf = (src: string, name: string): string => {
  const at = src.indexOf(name)
  expect(at, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', at)
  expect(end, name).toBeGreaterThan(at)
  return src.slice(at, end)
}
const body = (name: string): string => bodyOf(explorerService, name)

// A scoped activity page is held for SETTLED_ACTIVITY_PAGE_MS rather than 30–60s only
// because its key's watermark moves whenever any source of the page gains a row for the
// scope. These pin that premise: a source the page starts reading without an arm of the
// watermark behind it fails here, before it can sit unseen under a held page.
describe('every source of a scoped page moves its watermark', () => {
  // The sources the page reads, as the code names them: the tables collectAccountActivity
  // queries itself, the row builders it calls, and the enumerated snapshot's sources.
  const collect = body('async function collectAccountActivity')
  const tables = [...new Set(collect.match(/price_data\.[a-z0-9_]+/g) ?? [])]
  const builders = [...new Set([...collect.matchAll(
    /\b(getRecent[A-Za-z0-9]+|getCollectiveVotes|accountBondSaleTradeRows|hsmDirectTradeRows|evmTransferCandidateSql|liquidityScopedSourceSql|trappedArrivalRows|erc20CandidateRows)\(/g,
  )].map(m => m[1]))]
  const enumerated = (explorerService.match(/const ENUMERATED_SOURCE_NAMES = \[([^\]]+)\] as const/)?.[1] ?? '')
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)

  it('finds the sources it checks', () => {
    // A rename that empties a list would pass every check below vacuously.
    expect(tables.length).toBeGreaterThanOrEqual(5)
    expect(builders.length).toBeGreaterThanOrEqual(20)
    expect(enumerated).toEqual(['otc', 'dcaFailures', 'rewards', 'staking', 'bonds', 'strategies', 'intents', 'xcswaps', 'votes', 'xcm', 'ntt', 'v3'])
  })

  it('names an arm of the watermark for each one', () => {
    for (const source of [...tables, ...builders, ...enumerated]) {
      expect(ACTIVITY_PAGE_MARK_COVERAGE[source], `${source} is read by the scoped page but not covered by its watermark`).toBeDefined()
      expect(ACTIVITY_PAGE_MARK_COVERAGE[source].length, source).toBeGreaterThan(0)
    }
  })

  it('reads every arm the table relies on', () => {
    const mark = body('async function accountActivityWatermark')
    const reads: Record<ActivityMarkArm, string[]> = {
      indexed: ['FROM price_data.account_activity_bounds WHERE account IN'],
      dca: ['FROM price_data.dca_events_by_account'],
      erc20: ['FROM price_data.erc20_transfer_deltas WHERE holder IN', 'FROM price_data.atoken_scaled_deltas WHERE holder IN'],
      strategy: ['f.watermarkSql(strategyH160s)'],
      trapped: ['trappedArrivalMark(trappedArrivalsKnown(client), accounts)'],
    }
    const used = new Set(Object.values(ACTIVITY_PAGE_MARK_COVERAGE).flat())
    for (const arm of used) for (const read of reads[arm]) expect(mark, arm).toContain(read)
    // The arms are maxed into the one mark the page key carries.
    expect(mark).toContain('return Math.max(0, ...marks, ...erc20Mark, ...strategyMarks, trappedMark)')
  })

  // The one source measured outside every indexed arm: a trapped inbound XCM credited
  // nobody, so only the trap set names its beneficiary.
  it('covers the trapped arrivals the inbound XCM rows merge', () => {
    for (const fn of ['async function xcmInRowsForBlocks', 'async function getRecentXcmIn']) {
      expect(body(fn), fn).toContain('trappedArrivalRows(prices, {')
    }
    expect(ACTIVITY_PAGE_MARK_COVERAGE.getRecentXcmIn).toContain('trapped')
    expect(ACTIVITY_PAGE_MARK_COVERAGE.xcm).toContain('trapped')
    // Read from the same in-memory set the rows come from, so the arm costs no query and
    // moves exactly when the rows can appear.
    expect(body('async function trappedArrivalRows')).toContain('all = await trappedArrivals(client)')
  })

  it('takes the newest trap meant for the scope', () => {
    const trap = (blockHeight: number, beneficiary: string | null): TrappedArrival => ({
      blockHeight, ts: '2026-11-10 08:38:36', eventIndex: 0, barrierEventIndex: 1, messageId: null,
      originKind: 'Sibling', originParaId: 2006, assets: [], beneficiary, feeAssetId: null, feeAssetAccepted: false,
    })
    const a = '0xbc1d7b06ba4f4aacdfea6f00ddfbcdd4c768236980ed8991e0e86bccce1f613d'
    const traps = [trap(16_840_347, a), trap(16_840_100, a), trap(16_900_000, '0x' + 'ab'.repeat(32)), trap(16_950_000, null)]
    expect(trappedArrivalMark(traps, [a])).toBe(16_840_347)
    expect(trappedArrivalMark(traps, [a.toUpperCase().replace('0X', '0x')])).toBe(16_840_347)
    expect(trappedArrivalMark(traps, ['0x' + 'cd'.repeat(32)])).toBe(0)
    expect(trappedArrivalMark([], [a])).toBe(0)
  })
})

describe('a scoped page is held past its backstop only when nothing under its key can change', () => {
  const row = (extra: Partial<ActivityRow> = {}): ActivityRow => ({ type: 'transfer', blockHeight: 100, ...extra } as ActivityRow)
  const base = { settled: true, mark: 16_844_000, dated: true, provenance: { venue: false, generation: 16_844_000 }, rows: [row()] }

  it('holds a settled page built at its mark', () => {
    expect(scopedActivityPageTtlMs(base)).toBe(SETTLED_ACTIVITY_PAGE_MS)
    // A windowed page reads its sources live and carries no generation.
    expect(scopedActivityPageTtlMs({ ...base, provenance: { venue: false } })).toBe(SETTLED_ACTIVITY_PAGE_MS)
    // A snapshot read after the act is as good as one read at it.
    expect(scopedActivityPageTtlMs({ ...base, provenance: { venue: false, generation: base.mark + 3 } })).toBe(SETTLED_ACTIVITY_PAGE_MS)
    expect(SETTLED_ACTIVITY_PAGE_MS).toBe(600_000)
  })

  it('keeps the old backstop for everything else', () => {
    // Not settled: a source written after its block, or the swap drain, may not have landed.
    expect(scopedActivityPageTtlMs({ ...base, settled: false })).toBe(30_000)
    expect(scopedActivityPageTtlMs({ ...base, settled: false, dated: false })).toBe(60_000)
    // A closed dated window has no mark at all.
    expect(scopedActivityPageTtlMs({ ...base, mark: 0 })).toBe(30_000)
    // Built from the snapshot the act superseded.
    expect(scopedActivityPageTtlMs({ ...base, provenance: { venue: false, generation: base.mark - 1 } })).toBe(30_000)
    // A pool venue's page, and a page whose provenance was never reported.
    expect(scopedActivityPageTtlMs({ ...base, provenance: { venue: true } })).toBe(30_000)
    expect(scopedActivityPageTtlMs({ ...base, provenance: {} })).toBe(30_000)
    // A row still settling off-chain is restated by a rebuild, never by the mark.
    expect(scopedActivityPageTtlMs({ ...base, rows: [row(), row({ type: 'xcswap', xcswapStatus: null } as Partial<ActivityRow>)] })).toBe(30_000)
  })

  it('decides it in the page cache, with the settled test read before the build', () => {
    const scoped = body('async function getScopedAccountActivity')
    expect(scoped).toContain('return cachedFor(key, async () => {')
    // Revenue moves with a derivation cycle, not with the mark: only a page without it.
    expect(scoped).toContain('const settled = opts.revenue === false && filters.minRevenue == null && await activityWatermarkSettled(mark)')
    expect(scoped.indexOf('await activityWatermarkSettled(mark)')).toBeLessThan(scoped.indexOf('await getAccountActivity('))
    expect(scoped).toContain('getAccountActivity(accounts, limit, type, offset, action, filters, from, to, opts, provenance)')
    expect(scoped).toContain('scopedActivityPageTtlMs({ settled, mark, provenance, rows, dated: Boolean(window) })')
    // The member set is part of the key, so a membership edit is a new key at once.
    expect(scoped).toContain(':activity:w${mark}:m${membershipFingerprint(accounts)}:')
    const settled = body('async function activityWatermarkSettled')
    expect(settled).toContain('(await indexedRawHead()) - mark < MARKED_HOLD_SETTLED_BLOCKS')
    expect(settled).toContain('swapQueueDrainedTo(mark)')
    // The located page reports the snapshot it was built from; a venue says so.
    const page = body('async function getAccountActivity')
    expect(page).toContain('provenance.venue = venue != null')
    expect(page).toContain('provenance.generation = held?.generation')
  })

  // The page shape that is held is the one the account-activity lane asks for, which is
  // where the re-reads came from; the liquidation lane asks with revenue and keeps 30s.
  it('is the page the account-activity lane reads', () => {
    expect(bodyOf(evaluator, 'async function accountActivityMatches')).toContain("'all', { revenue: false }")
    expect(bodyOf(evaluator, 'async function liquidationMatches')).toContain("'mm', { revenue: true }")
  })
})

describe('cachedFor', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.useRealTimers() })

  it('serves each value for the lifetime its own load decided', async () => {
    vi.useFakeTimers()
    const { cachedFor } = await import('../src/services/cache.ts')
    const load = vi.fn()
      .mockResolvedValueOnce({ value: 'held', ttlMs: 600_000 })
      .mockResolvedValueOnce({ value: 'short', ttlMs: 30_000 })
      .mockResolvedValueOnce({ value: 'next', ttlMs: 30_000 })

    await expect(cachedFor('k', load)).resolves.toBe('held')
    vi.advanceTimersByTime(599_000)
    await expect(cachedFor('k', load)).resolves.toBe('held')
    vi.advanceTimersByTime(2_000)
    await expect(cachedFor('k', load)).resolves.toBe('short')
    vi.advanceTimersByTime(29_000)
    await expect(cachedFor('k', load)).resolves.toBe('short')
    vi.advanceTimersByTime(2_000)
    await expect(cachedFor('k', load)).resolves.toBe('next')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('shares one load between concurrent readers and stores nothing when it throws', async () => {
    const { cachedFor } = await import('../src/services/cache.ts')
    const load = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return { value: { ok: true }, ttlMs: 1_000 }
    })
    const [a, b] = await Promise.all([cachedFor('same', load), cachedFor('same', load)])
    expect(a).toBe(b)
    expect(load).toHaveBeenCalledTimes(1)

    const failing = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ value: 2, ttlMs: 1_000 })
    await expect(cachedFor('f', failing)).rejects.toThrow('boom')
    await expect(cachedFor('f', failing)).resolves.toBe(2)
    await expect(cachedFor('bad', async () => ({ value: 1, ttlMs: -1 }))).rejects.toThrow(RangeError)
  })
})
