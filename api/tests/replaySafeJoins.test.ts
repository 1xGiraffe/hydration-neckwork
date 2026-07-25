import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hollarSupplySql } from '../src/services/hollarService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// Raw ranges can be inserted again, so `dca_schedules` (ReplacingMergeTree keyed on
// id) can hold two rows for one schedule until its parts merge. A plain join then
// multiplies every activity row it matches — silently doubling failed DCA rows in
// the global, account, tag and asset feeds, none of which dedupe afterwards.
describe('dca_schedules joins are replay-safe', () => {
  it('never joins the table without ANY, FINAL, or an id-grouped subquery', () => {
    const joins = explorerService.match(/(?:\w+\s+){0,3}JOIN\s*(?:\(SELECT[^)]*\))?\s*(?:price_data\.)?dca_schedules[^\n]*/g) ?? []

    expect(joins.length).toBeGreaterThan(0)
    for (const join of joins) {
      expect(join, join).toMatch(/ANY\s+LEFT\s+JOIN|FINAL/)
    }
  })
})

// The HOLLAR dashboard and the asset directory count the same holders. HOLLAR sits
// in two pots (EVM ERC-20 and the Tokens pallet), so counting the rows of their
// union counts a holder of both twice.
describe('HOLLAR supply', () => {
  it('folds an account across its two pots before counting holders', () => {
    const sql = hollarSupplySql()

    expect(sql).toContain('count() AS holders')
    expect(sql).not.toContain('countIf(bal > 0) AS holders')
    // The union is grouped per account before the holder count sees it.
    const unionAt = sql.indexOf('UNION ALL')
    const groupAfterUnion = sql.indexOf('GROUP BY account_id', unionAt)
    expect(unionAt).toBeGreaterThan(-1)
    expect(groupAfterUnion).toBeGreaterThan(unionAt)
    expect(sql.slice(groupAfterUnion)).toContain('WHERE bal > 0')
  })
})
