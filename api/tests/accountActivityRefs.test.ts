import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accountActivityRefsQuery } from '../src/services/explorerService.ts'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const explorerService = source('../src/services/explorerService.ts')
const affinityService = source('../src/services/accountAffinityService.ts')
const tables = source('../../clickhouse/schema/001_tables.sql')
const materializedViews = source('../../clickhouse/schema/003_materialized_views.sql')
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

const OMNIPOOL = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
const OMNIPOOL_EVM = '0x455448006d6f646c6f6d6e69706f6f6c00000000000000000000000000000000'

const arms = (sql: string): string[] => sql.split(/UNION ALL/).filter(part => part.includes('account ='))

// price_data.account_activity_v3 is ORDER BY (account, block_height, event_index).
// Grouping (block_height, event_index) over `account IN (…)` is therefore not a
// sort-order prefix and ClickHouse hashes every row of every listed account
// before the LIMIT applies — 5.3 GiB and a memory-ceiling 500 on the Omnipool
// pallet account's 72.5M references. Pinning `account` per arm turns each read
// back into a reverse primary-key walk that stops at the arm's own LIMIT.
describe('account-activity reference reads limit per account, then merge', () => {
  it('gives every account its own bounded newest-first arm', () => {
    const sql = accountActivityRefsQuery([OMNIPOOL, OMNIPOOL_EVM], '', '1', 25, 50)

    expect(arms(sql)).toHaveLength(2)
    expect(sql).toContain(`account = '${OMNIPOOL}'`)
    expect(sql).toContain(`account = '${OMNIPOOL_EVM}'`)
    expect(sql).not.toContain('account IN (')
    for (const arm of arms(sql)) {
      expect(arm).toContain('ORDER BY block_height DESC, event_index DESC')
      // offset + limit: the merged head can never need a reference older than
      // the (offset + limit)-th newest of any single account.
      expect(arm).toContain('LIMIT 75')
    }
  })

  it('de-duplicates and pages only after the arms are merged', () => {
    const sql = accountActivityRefsQuery([OMNIPOOL, OMNIPOOL_EVM], '', '1', 25, 50)
    const merged = sql.slice(sql.lastIndexOf(')'))

    expect(merged).toContain('GROUP BY block_height, event_index')
    expect(merged).toContain('ORDER BY block_height DESC, event_index DESC')
    expect(merged).toContain('LIMIT 25 OFFSET 50')
  })

  it('pushes the caller predicate and the time bound into every arm', () => {
    const cond = "event_name IN ('Balances.Transfer','Tokens.Transfer')"
    const sql = accountActivityRefsQuery([OMNIPOOL, OMNIPOOL_EVM], cond, 'block_timestamp >= toDateTime(100)', 25)

    // Applied after the per-arm LIMIT it would keep the newest rows first and
    // filter second, dropping older matches an account really has.
    for (const arm of arms(sql)) {
      expect(arm).toContain(cond)
      expect(arm).toContain('block_timestamp >= toDateTime(100)')
    }
    expect(sql.slice(sql.lastIndexOf(')'))).not.toContain(cond)
  })

  it('keeps the merged scan once the arm fan-out would cost more than it saves', () => {
    const many = Array.from({ length: 9 }, (_, i) => `0x${String(i).repeat(64).slice(0, 64)}`)
    const sql = accountActivityRefsQuery(many, '', '1', 25)

    // Each arm re-reads one granule per active part, so past a handful of
    // accounts the split reads more than the single scan's merged mark ranges.
    expect(arms(sql)).toHaveLength(0)
    expect(sql).toContain('account IN (')
    expect(sql).toContain('GROUP BY block_height, event_index')
  })

  it('counts the same reference set exactly, without hashing it', () => {
    const at = explorerService.indexOf('async function countAccountEvents')
    const fn = explorerService.slice(at, explorerService.indexOf('\n}', at))

    // block_height and event_index are both UInt32, so the 32-bit shift packs a
    // reference into a UInt64 one-to-one. A narrower shift would depend on how
    // many events a block may hold, and uniq/uniqExact would trade the exact
    // total for memory.
    expect(fn).toContain('groupBitmap(bitShiftLeft(toUInt64(block_height), 32) + toUInt64(event_index))')
    expect(fn).not.toMatch(/\buniq\w*\(/)
    expect(fn).not.toContain('GROUP BY')
  })

  it('rejects anything that is not an account id', () => {
    const sql = accountActivityRefsQuery([OMNIPOOL, "' OR 1=1 --"], '', '1', 25)

    expect(arms(sql)).toHaveLength(1)
    expect(sql).not.toContain('OR 1=1')
  })

  it('builds the events page and the activity prefilters from the one helper', () => {
    // Two implementations of the same reference read is how the paging site and
    // the prefilters drifted into separate query shapes in the first place.
    const helperStart = explorerService.indexOf('export function accountActivityRefsQuery')
    const helperEnd = explorerService.indexOf('function accountActivityRefsSql', helperStart)
    expect(helperStart).toBeGreaterThan(-1)

    expect(occurrences(explorerService, 'FROM price_data.account_activity_v3\n')).toBe(5)
    for (let at = explorerService.indexOf('FROM price_data.account_activity_v3\n'); at > -1;
      at = explorerService.indexOf('FROM price_data.account_activity_v3\n', at + 1)) {
      if (at > helperStart && at < helperEnd) continue
      const read = explorerService.slice(at, at + 400)
      // A whole-table ranking is a different shape and not the drift this guards: it
      // takes no account predicate at all, so there is no per-account read to push a
      // limit into — its LIMIT is a top-N of the aggregate, not a page of references.
      if (read.includes('GROUP BY account\n') && !read.includes('account IN')) continue
      // Only unbounded set/count reads may stay inline; anything that pages or
      // limits has to come from the helper, or it groups before it limits again.
      expect(read).not.toContain('LIMIT')
    }
    expect(explorerService).toContain('query: accountActivityRefsQuery(accounts,')
    expect(explorerService.match(/accountActivityRefsQuery\(/g)?.length).toBeGreaterThan(3)
  })
})

// account_activity_v3 holds the same rows as the retired account_activity under the
// same engine, partitioning and sort key, and adds asset_id/amount/has_amount — so
// every reader's column set is a strict subset and v1 is pure duplicated write and
// merge cost. The reads move to v3; the declaration goes away so a fresh database
// never creates the table or its materialized view again.
describe('the account activity index has exactly one table behind it', () => {
  // A bare `account_activity` (not `_v3`) anywhere in the read models would mean a
  // reader still pins the retired table alive.
  const bare = /price_data\.account_activity(?!_v3)\b/g

  it('leaves no reader on the retired table', () => {
    expect(explorerService.match(bare)).toBeNull()
    expect(affinityService.match(bare)).toBeNull()
    // And the readers that moved are all still there: five in the explorer service
    // (the helper's merged and per-account arms, the vote-count prefilter, the
    // events total, the leaderboard's reference pool) and two in the affinity
    // service (direct transfers, CEX interactions). The ninth is the account
    // activity watermark, which reads only max(block_height) for the account —
    // it is what keeps an idle account's page from rebuilding every few seconds.
    expect(occurrences(explorerService, 'price_data.account_activity_v3')).toBe(9)
    expect(occurrences(affinityService, 'price_data.account_activity_v3')).toBe(2)
  })

  it('no longer declares the retired table or its materialized view', () => {
    expect(tables.match(bare)).toBeNull()
    expect(materializedViews.match(bare)).toBeNull()
    expect(materializedViews).not.toContain('account_activity_mv')
    expect(occurrences(tables, 'CREATE TABLE IF NOT EXISTS price_data.account_activity_v3 ')).toBe(1)
    expect(occurrences(materializedViews, 'price_data.account_activity_v3_mv TO price_data.account_activity_v3 ')).toBe(1)
  })

  // The repointed reads are deliberately non-FINAL: `account` leads the sort key, so
  // a pinned account prunes to its own granules, while FINAL would force a merging
  // read across the partition set. Un-merged ReplacingMergeTree duplicates are
  // collapsed by the callers' own GROUP BY / groupBitmap instead.
  it('keeps every repointed read off FINAL', () => {
    const reads = explorerService.split('FROM price_data.account_activity_v3\n').slice(1)
    expect(reads).toHaveLength(5)
    for (const read of reads) expect(read.slice(0, 400)).not.toContain('FINAL')

    const affinityReads = affinityService.split('FROM price_data.account_activity_v3\n').slice(1)
    expect(affinityReads).toHaveLength(2)
    for (const read of affinityReads) expect(read.slice(0, 400)).not.toContain('FINAL')
  })
})
