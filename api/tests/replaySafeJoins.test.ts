import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hollarSupplySql } from '../src/services/hollarService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// Raw ranges can be inserted again, so `dca_schedules` (ReplacingMergeTree keyed on
// id) can hold two rows for one schedule until its parts merge. A plain join then
// multiplies every activity row it matches — silently doubling failed DCA rows in
// the global, account, tag and asset feeds, none of which dedupe afterwards. The
// duplicate is resolved on the schedule side, before the join sees it; asking the
// join to pick one row instead is what `dcaScheduleJoinSql` explains it cannot do.
describe('dca_schedules joins are replay-safe', () => {
  it('never joins the table without resolving its replacements first', () => {
    const joins = explorerService.match(/JOIN[^;]{0,200}?price_data\.dca_schedules[^\n]*/g) ?? []

    expect(joins.length).toBeGreaterThan(0)
    for (const join of joins) expect(join, join).toContain('FINAL')
  })
})

// raw_blocks/raw_extrinsics/raw_events all replace on their event identity, so a
// re-indexed range holds each row twice until its parts merge. The blocks list
// paged and counted those rows directly, showing a block twice with doubled
// extrinsic and event counts.
describe('block list reads are replay-safe', () => {
  it('pages the block list from a deduplicated source', () => {
    const at = explorerService.indexOf('SELECT block_height, toString(block_timestamp) AS ts, block_hash, author, spec_version')
    expect(at).toBeGreaterThan(-1)
    const paged = explorerService.slice(at, explorerService.indexOf('OFFSET {offset:UInt32}', at))

    expect(paged).toContain('FROM price_data.raw_blocks FINAL')
  })

  it('counts extrinsic and event identities per block, not rows', () => {
    expect(explorerService).toContain('SELECT block_height, uniqExact(extrinsic_index) AS c FROM price_data.raw_extrinsics')
    expect(explorerService).toContain('SELECT block_height, uniqExact(event_index) AS c FROM price_data.raw_events')
    expect(explorerService).toContain('SELECT uniqExact(event_index) AS c FROM price_data.raw_events WHERE block_height = {h:UInt32}')
    expect(explorerService).not.toContain('SELECT block_height, count() AS c FROM price_data.raw_events')
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

// money_market_reserve_indices is a ReplacingMergeTree, but both readers resolve
// duplicates themselves with argMax over (block_height, event_index, ingested_at) —
// the full replacement key plus the version column — so FINAL only added a part
// merge. Proven output-identical on the live table (1,875 rows / same checksum,
// 84 -> 39 ms; and 25 rows / same checksum, 98 -> 44 ms).
describe('money-market reserve indices', () => {
  it('resolves duplicates with argMax instead of FINAL', () => {
    const reads = explorerService.match(/FROM price_data\.money_market_reserve_indices[^\n]*/g) ?? []

    expect(reads.length).toBe(2)
    for (const read of reads) expect(read, read).not.toContain('FINAL')
    // The dedup must still be explicit wherever the table is read.
    expect((explorerService.match(/argMax\([a-z_]+, tuple\(block_height,event_index,ingested_at\)\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(3)
  })
})
