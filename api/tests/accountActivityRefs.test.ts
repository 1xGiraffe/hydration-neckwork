import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accountActivityRefsQuery } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const OMNIPOOL = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
const OMNIPOOL_EVM = '0x455448006d6f646c6f6d6e69706f6f6c00000000000000000000000000000000'

const arms = (sql: string): string[] => sql.split(/UNION ALL/).filter(part => part.includes('account ='))

// price_data.account_activity is ORDER BY (account, block_height, event_index).
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

    for (let at = explorerService.indexOf('FROM price_data.account_activity\n'); at > -1;
      at = explorerService.indexOf('FROM price_data.account_activity\n', at + 1)) {
      if (at > helperStart && at < helperEnd) continue
      // Only unbounded set/count reads may stay inline; anything that pages or
      // limits has to come from the helper, or it groups before it limits again.
      expect(explorerService.slice(at, at + 400)).not.toContain('LIMIT')
    }
    expect(explorerService).toContain('query: accountActivityRefsQuery(accounts,')
    expect(explorerService.match(/accountActivityRefsQuery\(/g)?.length).toBeGreaterThan(3)
  })
})
