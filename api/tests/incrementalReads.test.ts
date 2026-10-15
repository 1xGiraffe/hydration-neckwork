import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assetPageHoldable, eventValueAlternativesFilterSql, sealedPartitionsBelow } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const evaluator = readFileSync(new URL('../src/notifications/evaluator.ts', import.meta.url), 'utf8')
const body = (src: string, signature: string): string => {
  const at = src.indexOf(signature)
  expect(at, signature).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n}\n', at))
}

// The source watermark folds the months that ended before a head's own month once per
// part signature; only those can be folded, and a non-month partition never is.
describe('sealed months of the source watermark', () => {
  const parts = new Map([['202608', 'a'], ['202609', 'b'], ['202610', 'c'], ['all', 'd']])

  it('seals only the month partitions before the head month, in order', () => {
    expect(sealedPartitionsBelow(parts, 202610)).toEqual(['202608', '202609'])
    expect(sealedPartitionsBelow(parts, 202608)).toEqual([])
  })

  it('seals nothing for a head with no month', () => {
    expect(sealedPartitionsBelow(parts, undefined)).toEqual([])
  })

  // Folds are kept per id and month under the month's part signature, so heads in two
  // months share them, and a part landing in one old month re-reads that month alone.
  it('keeps a fold per id and month, re-reading only the months whose parts moved', () => {
    const refs = body(explorerService, 'async function activitySourceMarksOf(')
    expect(refs).toContain('const stale = covering.filter(month => fold?.sigs.get(month) !== partitions.get(month))')
    expect(refs).toContain('for (const month of sealed) merged = combineSourceMarks(fold?.months.get(month) ?? null, merged, combine)')
    expect(refs).toContain('trimSealedMonthFolds(folds)')
  })

  it('reads the sealed and live halves in one statement shape, FINAL per partition', () => {
    const refs = body(explorerService, 'async function activitySourceMarksOf(')
    expect(refs).toContain("_partition_id IN {months:Array(String)}")
    expect(refs).toContain("_partition_id NOT IN {months:Array(String)} AND block_height <= {head:UInt32}")
    // The signature is read before the fold, so a part landing in between is never
    // stored under a key that could be asked again.
    expect(refs.indexOf('await sealedPartitionSignatures(table)')).toBeLessThan(refs.indexOf("read(chunk, stale, 'sealed')"))
  })
})

// A day-bounded value read keeps the closes it can match: every close from the hour
// before its first day, and each asset's newest close older than that.
describe('closes relation with a lower bound', () => {
  const legs = [{ assetExpr: 'asset_out', rawAmountExpr: 'amount_out', alias: 'out_price' }]

  it('narrows to the window and keeps each asset’s last earlier close', () => {
    const since = "toDateTime('2026-10-01 00:00:00')"
    const { joinSql } = eventValueAlternativesFilterSql(legs, 'block_timestamp', { min: 10, unit: 'usd' }, { since })
    expect(joinSql).toContain(`interval_start >= toStartOfHour(${since}) - INTERVAL 1 HOUR`)
    expect(joinSql).toContain('UNION ALL')
    expect(joinSql).toContain(`SELECT asset_id, max(interval_start) FROM price_data.ohlc_1h WHERE asset_id IN (0) AND interval_start < toStartOfHour(${since}) - INTERVAL 1 HOUR GROUP BY asset_id`)
  })

  it('reads the whole history without one', () => {
    const { joinSql } = eventValueAlternativesFilterSql(legs, 'block_timestamp', { min: 10, unit: 'usd' })
    expect(joinSql).not.toContain('UNION ALL')
    expect(joinSql).not.toContain('max(interval_start)')
  })

  it('is bounded by the intent feed only where its own read is dated', () => {
    expect(explorerService).toContain("eventValueAlternativesFilterSql(INTENT_VALUE_LEGS, 'block_timestamp', filters, { since: timeWindowSinceSql(from) })")
  })
})

// The asset feed's first page is held per head and only filters decided on the built
// row's value or actor keep it from being built incrementally.
describe('held asset first page', () => {
  it('holds a page whose filters are row-independent', () => {
    expect(assetPageHoldable({})).toBe(true)
    expect(assetPageHoldable({ market: 'core', token: '5' })).toBe(true)
  })

  it('builds whole under a value, revenue, identity or viewer filter', () => {
    expect(assetPageHoldable({ min: 100, unit: 'usd' })).toBe(false)
    expect(assetPageHoldable({ min: 1, unit: 'token' })).toBe(false)
    expect(assetPageHoldable({ minRevenue: 1 })).toBe(false)
    expect(assetPageHoldable({ identity: 'named' })).toBe(false)
    expect(assetPageHoldable({ viewerTagged: new Set(['0x01']) })).toBe(false)
  })

  it('merges only under a page the held rows can prove, else builds whole', () => {
    const rows = body(explorerService, 'async function heldAssetPageRows(')
    expect(rows).toContain('held.rows.filter(row => row.blockHeight <= cut)')
    expect(rows).toContain('if (merged.length >= limit || held.short)')
    expect(rows).toContain('if (!(error instanceof AssetPageAboveSaturated)) throw error')
    // Rebuilt whole on a timer, so a row landing later than the margin is bounded.
    expect(rows).toContain('now - held.fullAt < ASSET_PAGE_FULL_MS')
  })
})

// The account-activity and liquidation lanes bound their scoped reads by the window's
// first day and never by a `to`: a window with no end is never closed, so the scoped
// feed stays keyed on the scope's own activity watermark.
describe('notification lanes read the scoped feed from the window’s first day', () => {
  it('passes the lower bound alone', () => {
    const fetch = body(evaluator, 'async function fetchTargetActivity(')
    expect(fetch.match(/filters, since, undefined, opts\)/g)).toHaveLength(3)
    expect(body(evaluator, 'async function accountActivityMatches(')).toContain('const bounds = await windowDayBounds(window)')
    expect(evaluator).toContain("fetchTargetActivity(params[0].target, group[0].accountId, limit, filters, 'all', { revenue: false }, bounds?.from)")
    expect(evaluator).toContain("fetchTargetActivity(target, group[0].accountId, limit, {}, 'mm', { revenue: true }, bounds?.from)")
  })
})

// An account's Omnipool positions come from the account-first NFT events, re-checked
// against each NFT's current owner, never from the whole tables folded per request.
describe('per-account Omnipool position reconstruction', () => {
  it('starts from the account’s own NFT events and reads the folds by key', () => {
    const recon = body(explorerService, 'async function reconstructOmnipoolPositions(')
    expect(recon).toContain('FROM price_data.nft_owner_events_by_account')
    expect(recon).toContain('HAVING owner IN {accs:Array(String)}')
    expect(recon).toContain('WHERE deposit_id IN {ids:Array(String)} GROUP BY deposit_id')
    expect(recon).toContain('WHERE position_id IN {ids:Array(String)} GROUP BY position_id')
  })
})

// A lapsed exact hold re-installs its result while the scope's source marks stand,
// but only at a settled watermark and never past its maximum age.
describe('mark-revalidated exact holds', () => {
  it('wraps the located page and the held total', () => {
    expect(body(explorerService, 'async function heldLocatedActivityPage(')).toContain('markRevalidated(key, accounts, mark,')
    expect(body(explorerService, 'async function heldActivityTotal(')).toContain('markRevalidated(heldKey, accounts, mark,')
  })

  it('takes the marks before it builds and only reuses a young result', () => {
    const fn = body(explorerService, 'async function markRevalidated<T>(')
    expect(fn).toContain('(await indexedRawHead()) - mark < MARKED_HOLD_SETTLED_BLOCKS')
    expect(fn.indexOf('activitySourceMarksOf(')).toBeLessThan(fn.indexOf('const value = await build()'))
    expect(fn).toContain('Date.now() - prior.at < MARKED_HOLD_MAX_MS && sameSourceMarks(marks, prior.marks)')
  })

  // Kept only at a watermark the swap queue has drained past, never with a row still
  // waiting on a settlement, and never past a hold and a half of the old schedule.
  it('keeps only settled results, and only for thirty minutes', () => {
    const fn = body(explorerService, 'async function markRevalidated<T>(')
    expect(fn.indexOf('await swapQueueDrainedTo(mark)')).toBeLessThan(fn.indexOf('const value = await build()'))
    expect(fn).toContain('if (marks && drained && keepable(value))')
    expect(explorerService).toMatch(/^const MARKED_HOLD_MAX_MS = 30 \* 60_000$/m)
    expect(body(explorerService, 'async function heldLocatedActivityPage(')).toContain('located => keep(located) && !located!.rows.some(awaitsSettlement)')
  })

  it('drops a held result the activity sweep recounted', () => {
    expect(body(explorerService, 'export function installActivityListTotal(')).toContain('markedHolds.delete(heldActivityTotalKey(key, mark))')
  })
})

// What settles after a row's block is restated whenever a page is served, without
// waiting on a load, and a held asset page never carries a row still waiting on it.
describe('settling annotations', () => {
  it('are restated at every serve, before the journeys', () => {
    const journeys = body(explorerService, 'async function applyXcmJourneys(')
    expect(journeys.indexOf('await refreshSettlingAnnotations(rows)')).toBeLessThan(journeys.indexOf('await applyFastRelaySources(rows)'))
    const refresh = body(explorerService, 'async function refreshSettlingAnnotations(')
    expect(refresh).toContain('const index = fastRelayStore.latest()')
    expect(refresh).not.toContain('await fastRelayIndex()')
  })

  it('re-read rather than carried on a held asset page, and page two installs page one', () => {
    const rows = body(explorerService, 'async function heldAssetPageRows(')
    expect(rows).toContain('const pending = held ? held.rows.filter(awaitsSettlement).map(row => row.blockHeight) : []')
    expect(rows).toContain('...pending.map(block => block - 1)')
    const page = body(explorerService, 'async function assetActivityPage(')
    expect(page).toContain('holdAssetFirstPage(firstKey, { head, fullAt: Date.now(), rows: rows.slice(0, limit), short: rows.length < limit })')
  })
})
