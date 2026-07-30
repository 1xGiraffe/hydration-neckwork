import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dcaScheduleJoinSql } from '../src/services/explorerService.ts'

// Comments are stripped so the scan below reads the SQL this file sends, not the
// prose that explains why it is written that way — the trap has to be nameable in a
// comment without the guard against it firing on the name.
const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  .replaceAll(/^\s*\/\/.*$/gm, '')
  .replaceAll(/^\s*--.*$/gm, '')

// Every DCA read resolves an execution's schedule through this join, so the join is
// where an execution can silently acquire another schedule's identity. On ClickHouse
// 26.3 `ANY LEFT JOIN` does exactly that: it returns the right number of rows with
// the `id` column mis-associated, so an execution renders under its own block, event
// index and amounts but another schedule's id — and because the counts match, no
// count-based guard can see it. Whether that is reachable depends only on the shape
// of the left side's bound, so the shape is what has to be pinned here rather than
// the one bound that happens to be safe today.
describe('dcaScheduleJoinSql', () => {
  it('deduplicates the schedule side instead of asking the join to do it', () => {
    const sql = dcaScheduleJoinSql(['asset_in', 'asset_out'])
    // FINAL on the projected right side: replacement semantics belong to the table
    // that replaces, and dca_schedules is small enough to resolve whole.
    expect(sql).toContain('FROM price_data.dca_schedules FINAL')
    expect(sql).toContain('SELECT id, asset_in, asset_out')
    // A right side that is 1:1 by construction needs no join-side row picking.
    expect(sql).toMatch(/^LEFT JOIN \(/)
    expect(sql).not.toContain('ANY')
  })

  it('joins on the execution row\'s own schedule id', () => {
    expect(dcaScheduleJoinSql(['direction'])).toContain('s ON s.id = e.id')
  })

  it('projects only the columns the caller asked for', () => {
    expect(dcaScheduleJoinSql(['amount_per'])).toBe(
      'LEFT JOIN (SELECT id, amount_per FROM price_data.dca_schedules FINAL) s ON s.id = e.id')
  })
})

// The trap is version-dependent and invisible in the query's row count, so nothing
// about a passing read proves the next `ANY LEFT JOIN` is safe. Keep the construct
// out of the explorer's SQL entirely rather than re-deriving which bounds are
// affected each time a query grows a new predicate.
describe('explorer SQL avoids ANY joins', () => {
  it('resolves every DCA schedule lookup through the shared deduplicated join', () => {
    expect(explorerService).not.toMatch(/\bANY\s+(LEFT|INNER|RIGHT|FULL)?\s*JOIN\b/)
    // …and both DCA readers go through the one helper, so there is a single place
    // where this decision lives.
    expect(explorerService.match(/dcaScheduleJoinSql\(\[/g)?.length).toBe(2)
    expect(explorerService).not.toMatch(/JOIN\s+price_data\.dca_schedules\b/)
  })
})
