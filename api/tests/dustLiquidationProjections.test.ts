import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// One function's source, ending where the next top-level declaration or comment begins.
// A `\n}` scan would stop at the closing brace of a destructured argument type, which is
// exactly where accountTransferArm's SQL starts.
function functionBody(name: string): string {
  const at = explorerService.indexOf(`function ${name}`)
  expect(at, name).toBeGreaterThan(-1)
  const rest = explorerService.slice(at + 1)
  const next = rest.search(/\n(?:async function |function |export |interface |type |const |\/\/)/)
  expect(next, name).toBeGreaterThan(-1)
  return rest.slice(0, next)
}

// raw_events indexes event_name with a `set(200)` skip index, which is not selective
// enough to prune granules, so a predicate on it scans every granule the read touches
// and decompresses args_json (~9 KiB a row) along the way. The dust pair and the
// liquidation extrinsic set are both matched against a handful of thousand rows, and
// reading them out of raw_events cost the busiest account's exact transfer count 241M
// rows / 36.96 GiB, which was the single largest read on the instance.
//
// Every assertion below also pins HOW MANY sites it found. A bare "does not contain"
// guard passes just as happily when the thing it guards has been renamed out from under
// it, which is how two earlier guards in this repo degraded to asserting nothing.
describe('dust and liquidation projections replace the raw_events scans', () => {
  it('names neither event anywhere in the read model', () => {
    expect(occurrences(explorerService, 'Tokens.DustLost')).toBe(0)
    expect(occurrences(explorerService, 'Liquidation.Liquidated')).toBe(0)
  })

  it('reads the dust pair from one projection, at both of its two sites', () => {
    expect(occurrences(explorerService, 'price_data.dust_lost_events')).toBe(2)
    // The count arm's exclusion and the row path's sibling matcher — the same quantity
    // decided twice is this codebase's recurring defect, so both must name one table.
    expect(functionBody('accountTransferArm')).toContain('FROM price_data.dust_lost_events')
    expect(functionBody('suppressDustTransferRows')).toContain('FROM price_data.dust_lost_events')
  })

  it('reads the liquidation extrinsics from one projection, at both of its two sites', () => {
    expect(occurrences(explorerService, 'price_data.liquidation_extrinsics')).toBe(2)
    expect(functionBody('accountSwapTradeArm')).toContain('FROM price_data.liquidation_extrinsics')
    expect(functionBody('liquidationExtrinsics')).toContain('FROM price_data.liquidation_extrinsics')
  })

  // Both projections are only ever the right side of a NOT IN or a lookup set, which is
  // set-semantic: an unmerged ReplacingMergeTree duplicate cannot change the answer, so
  // FINAL would only cost a merge pass. If one ever becomes a counted source, that
  // reasoning stops holding — which is what this pins.
  it('reads both projections without FINAL', () => {
    expect(occurrences(explorerService, 'dust_lost_events FINAL')).toBe(0)
    expect(occurrences(explorerService, 'liquidation_extrinsics FINAL')).toBe(0)
  })

  // Both compare the pre-extracted columns, not re-parsed JSON: if a reader went back to
  // args_json the two sides could fold case or widen an id differently and the pair would
  // silently stop matching.
  it('compares the pre-extracted columns rather than args_json', () => {
    for (const site of ['accountTransferArm', 'suppressDustTransferRows']) {
      const body = functionBody(site)
      expect(body, site).toContain('block_height, event_index, who, asset_id, amount')
      expect(occurrences(body, 'args_json'), site).toBe(0)
    }
    expect(occurrences(functionBody('liquidationExtrinsics'), 'args_json')).toBe(0)
  })

  // A from/to request must prune partitions in every source arm. The share-routed-trade
  // exclusion was the one subquery without the bound: it read all 5.03M liquidity rows /
  // 342 MiB for a window holding 19,920 of them.
  it('bounds both source reads in the swap trade arm', () => {
    const arm = functionBody('accountSwapTradeArm')
    expect(occurrences(arm, '${bound}')).toBe(2)
    // The share-leg exclusion reads the account-first twin: the arm names `who`,
    // which the block-keyed source could not prune on.
    expect(arm).toContain('FROM price_data.liquidity_activity_by_account\n          WHERE ${bound}')
  })
})

// The projections exist only to hold what the readers compare on. If the declaration and
// the comparison ever disagree on how `who` is folded or how currencyId is widened, the
// dust count changes silently — so the extraction is pinned here against the schema.
describe('the projection declarations match what the readers compare', () => {
  it('declares both tables keyed on the identity each reader looks up', () => {
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.dust_lost_events (`block_height` UInt32, `event_index` UInt32, `who` String, `asset_id` UInt32, `amount` String, `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY tuple() ORDER BY (block_height, event_index)')
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.liquidation_extrinsics (`block_height` UInt32, `extrinsic_index` UInt32, `block_timestamp` DateTime, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY tuple() ORDER BY (block_height, extrinsic_index)')
  })

  it('extracts the dust tuple exactly as the readers compare it', () => {
    expect(occurrences(views, 'price_data.dust_lost_events_mv')).toBe(1)
    expect(views).toContain(`lower(JSONExtractString(args_json, 'who')) AS who`)
    expect(views).toContain(`toUInt32(JSONExtractInt(args_json, 'currencyId')) AS asset_id`)
    expect(views).toContain(`JSONExtractString(args_json, 'amount') AS amount, block_timestamp, ingested_at FROM price_data.raw_events WHERE event_name = 'Tokens.DustLost'`)
  })

  it('keeps only the extrinsic-bearing liquidations, non-nullable', () => {
    expect(occurrences(views, 'price_data.liquidation_extrinsics_mv')).toBe(1)
    expect(views).toContain(`SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index, block_timestamp, ingested_at FROM price_data.raw_events WHERE (event_name = 'Liquidation.Liquidated') AND (extrinsic_index IS NOT NULL)`)
  })
})
