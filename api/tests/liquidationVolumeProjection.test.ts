import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// One function's source, ending where the next top-level declaration or comment begins.
function functionBody(name: string): string {
  const at = explorerService.indexOf(`function ${name}`)
  expect(at, name).toBeGreaterThan(-1)
  const rest = explorerService.slice(at + 1)
  const next = rest.search(/\n(?:async function |function |export |interface |type |const |\/\/)/)
  expect(next, name).toBeGreaterThan(-1)
  return rest.slice(0, next)
}

// raw_money_market_events is ordered (block_height, event_index, event_name), so a bare
// `event_name = 'LiquidationCall'` sits on the third key column behind no prefix and
// prunes no granule: the read scanned all 10.70M rows and decompressed the ZSTD(6)
// decoded_args_json to reach 8,842 legs — 785 MiB account-scoped, 1.12 GiB unfiltered.
//
// Every assertion below also pins HOW MANY sites it found. A bare "does not contain"
// guard passes just as happily when the thing it guards has been renamed out from under
// it, which is how two earlier guards in this repo degraded to asserting nothing.
describe('liquidation volume reads the LiquidationCall projection', () => {
  it('builds its legs from the projection, at the one site that has legs', () => {
    // Two readers of the projection: the account/tag volume builder below, and the
    // asset detail page's daily seizure history (its own describe block). No third
    // reader may appear without deciding which of them it belongs with.
    expect(occurrences(explorerService, 'FROM price_data.money_market_liquidation_calls')).toBe(2)
    expect(functionBody('liquidationVolumeCtes')).toContain('FROM price_data.money_market_liquidation_calls FINAL')
    // The definition plus the two callers: the account/tag volume query and the
    // accounts-directory `sort=liquidation` CTE. One builder, so the account page, both
    // tag sites and the directory ordering can never value a liquidation differently.
    // Counted with the paren so a prose cross-reference (the asset-detail reader
    // cites this builder's rationale) can't pass for a fourth call site.
    expect(occurrences(explorerService, 'liquidationVolumeCtes(')).toBe(3)
    expect(functionBody('liquidationVolumeByAccount')).toContain('${liquidationVolumeCtes(list)}')
  })

  // Unlike the set-semantic dust/liquidation-extrinsic projections, this one is summed,
  // so an unmerged ReplacingMergeTree duplicate would double a leg's USD value.
  it('deduplicates with FINAL because the legs are summed', () => {
    // Both readers sum legs, so both need it — a bare read would double a leg whose
    // replay duplicate has not merged yet.
    expect(occurrences(explorerService, 'money_market_liquidation_calls FINAL')).toBe(2)
  })

  it('touches neither raw_money_market_events nor decoded_args_json for the legs', () => {
    const body = functionBody('liquidationVolumeCtes')
    expect(occurrences(body, 'decoded_args_json')).toBe(0)
    expect(occurrences(body, 'raw_money_market_events')).toBe(0)
    expect(occurrences(body, `'LiquidationCall'`)).toBe(0)
  })

  // The remaining decoded_args_json readers are pinned so this guard cannot quietly
  // stop meaning anything. Five extract the collateral amount inside the five-event
  // money-market activity family (Supply/Borrow/Repay/Withdraw/LiquidationCall), which
  // this LiquidationCall-only projection cannot serve; the sixth is the value-events
  // debt-side fallback, already bounded to a page's (block_height, event_index) tuples.
  it('leaves exactly the money-market reads a LiquidationCall-only projection cannot serve', () => {
    expect(occurrences(explorerService, 'liquidatedCollateralAmount')).toBe(5)
    expect(occurrences(explorerService, `if(event_name='LiquidationCall', JSONExtractString(decoded_args_json,'liquidatedCollateralAmount'), amount)`)).toBe(5)
    expect(occurrences(explorerService, `WHERE (block_height, event_index) IN (\${tuples}) AND event_name = 'LiquidationCall'`)).toBe(1)
  })

  // MM_MARKETS is extensible at runtime through EXPLORER_MM_MARKETS and the asset
  // registry is runtime state, while clickhouse/schema is static — so both filters
  // belong to the read, exactly as for money_market_latest_positions. Baking either
  // into the view would silently drop a market added after the database was built.
  it('applies the runtime market and asset filters at read time, not in the view', () => {
    const body = functionBody('liquidationVolumeCtes')
    expect(occurrences(body, 'configuredMmPoolsSql()')).toBe(1)
    expect(occurrences(body, `mmAssetKnownSql('asset_address')`)).toBe(1)
    expect(occurrences(body, `mmAssetIdSql('asset_address')`)).toBe(1)
    const mv = views.slice(views.indexOf('price_data.money_market_liquidation_calls_mv'))
    expect(occurrences(mv, 'pool_address IN')).toBe(0)
    expect(occurrences(mv, '0x1b02e051683b5cfac5929c25e84adb26ecf87b38')).toBe(0)
    expect(occurrences(mv, '00000000000000000000000000000001')).toBe(0)
  })

  // account_id is stored folded, so the read matches the raw column rather than folding
  // it again — which is only safe while the view is the one doing the folding.
  it('matches the account list against the stored folded id', () => {
    expect(functionBody('liquidationVolumeCtes')).toContain('AND account_id IN (${accountFilter})')
    expect(views).toContain(`SELECT lower(ifNull(account_id, '')) AS account_id, block_height, event_index, block_timestamp, lower(ifNull(pool_address, '')) AS pool_address, lower(ifNull(asset_address, '')) AS asset_address`)
  })
})

describe('the LiquidationCall projection declaration matches what the reader consumes', () => {
  // Account-first because every one of one day's 8,104 executions was account-scoped;
  // (block_height, event_index) completes the key so it is unique per source row, which
  // is what makes replacement deterministic. PARTITION BY tuple() because 8,842 rows over
  // the ~20 months they span would be near-empty parts and neither read is time-bounded.
  it('declares the table keyed account-first on a unique event identity', () => {
    expect(occurrences(tables, 'price_data.money_market_liquidation_calls (')).toBe(1)
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.money_market_liquidation_calls (`account_id` String, `block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `pool_address` String, `asset_address` String, `liquidated_collateral_amount` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY tuple() ORDER BY (account_id, block_height, event_index) SETTINGS index_granularity = 1024;')
  })

  // The amount is the one integer-money value on this path. If the view and the reader
  // ever disagree on which JSON field it comes from, or the column is widened through a
  // float, every liquidation figure moves silently — so the pair is pinned together.
  it('extracts the collateral amount exactly as the reader values it', () => {
    expect(occurrences(views, 'price_data.money_market_liquidation_calls_mv')).toBe(1)
    expect(views).toContain(`JSONExtractString(decoded_args_json, 'liquidatedCollateralAmount') AS liquidated_collateral_amount, ingested_at FROM price_data.raw_money_market_events WHERE (event_name = 'LiquidationCall') AND (ifNull(account_id, '') != '');`)
    expect(functionBody('liquidationVolumeCtes')).toContain('liquidated_collateral_amount AS amount')
    // historicalVolumeSql parses that raw string as a 256-bit fixed-point integer.
    expect(functionBody('historicalVolumeSql')).toContain('toDecimal256(l.amount, 0)')
  })
})
