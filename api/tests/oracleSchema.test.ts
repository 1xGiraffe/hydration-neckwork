import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '../src/db/schemaBootstrap.ts'
import { ORACLE_TOPICS } from '../src/services/oracleDecode.ts'

// The oracle tables are fed by materialized views on the two busiest raw tables. An MV that
// throws fails the SOURCE insert, so raw ingestion stops until it is fixed; these pins hold
// the NULL-safety and no-throw shape of both SELECTs: every
// Nullable source column is either wrapped in ifNull() or lands in a Nullable target column,
// and every conversion of extracted text is an *OrZero form.
const statementsOf = (file: string) =>
  splitSqlStatements(readFileSync(new URL(`../../clickhouse/schema/${file}`, import.meta.url), 'utf8'))
    .map(s => s.replace(/^[ \t]*--.*$/gm, '').trim())
const tables = statementsOf('001_tables.sql')
const views = statementsOf('003_materialized_views.sql')
const one = (list: string[], prefix: string) => {
  const found = list.filter(s => s.startsWith(prefix))
  expect(found, prefix).toHaveLength(1)
  return found[0]
}
const table = (name: string) => one(tables, `CREATE TABLE IF NOT EXISTS price_data.${name} `)
const mv = (name: string) => one(views, `CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `)

/** `name type` pairs of a CREATE's column list. */
function columns(stmt: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of stmt.matchAll(/`([a-z_0-9]+)` ((?:LowCardinality\(|Nullable\(|Array\()?[A-Za-z0-9]+(?:\([^)]*\))?\)?)/g)) if (!out.has(m[1])) out.set(m[1], m[2])
  return out
}
const nullableOf = (stmt: string) => [...columns(stmt)].filter(([, t]) => t.startsWith('Nullable(')).map(([c]) => c)
const selectOf = (stmt: string) => stmt.slice(stmt.indexOf(') AS ') + 5)

describe('oracle_feed_logs_mv', () => {
  const s = mv('oracle_feed_logs_mv')
  const sel = selectOf(s)
  const target = columns(table('oracle_feed_logs'))
  it('reads raw_evm_logs and writes oracle_feed_logs, keyed by the raw row identity', () => {
    expect(s).toContain('TO price_data.oracle_feed_logs ')
    expect(sel).toContain('FROM price_data.raw_evm_logs')
    expect(table('oracle_feed_logs')).toContain('ReplacingMergeTree(ingested_at)')
    expect(table('oracle_feed_logs')).toContain('ORDER BY (block_height, event_index)')
  })
  it('selects exactly the four oracle topics the service decodes', () => {
    for (const t of Object.values(ORACLE_TOPICS)) expect(sel).toContain(`'${t}'`)
    expect(sel.match(/'0x[0-9a-f]{64}'/g)).toHaveLength(4)
    expect(sel).toContain("WHERE ifNull(topic0, '') IN (")
  })
  it('never lets a NULL of raw_evm_logs reach an ordinary column', () => {
    expect(nullableOf(table('raw_evm_logs'))).toEqual(expect.arrayContaining(['topic0', 'extrinsic_index', 'event_name']))
    expect(target.get('extrinsic_index')).toBe('Nullable(UInt32)')
    for (const c of nullableOf(table('raw_evm_logs'))) {
      if (!new RegExp(`\\b${c}\\b`).test(sel)) continue
      const wrapped = sel.includes(`ifNull(${c},`)
      const nullableTarget = (target.get(c) ?? '').startsWith('Nullable(')
      expect(wrapped || nullableTarget, `${c} is Nullable in raw_evm_logs`).toBe(true)
    }
    expect(sel).not.toMatch(/CAST\(|::|toUInt\d+\(|toInt\d+\(|toFloat\d+\(/)
  })
})

describe('ema_oracle_updates_mv', () => {
  const s = mv('ema_oracle_updates_mv')
  const sel = s.slice(s.indexOf(') AS WITH ') + 5)
  it('reads EmaOracle.OracleUpdated from raw_events into ema_oracle_updates, keyed pair-first over the raw identity', () => {
    expect(s).toContain('TO price_data.ema_oracle_updates ')
    expect(sel).toContain("FROM price_data.raw_events WHERE event_name = 'EmaOracle.OracleUpdated'")
    expect(table('ema_oracle_updates')).toContain('ORDER BY (source, asset_a, asset_b, block_height, event_index)')
    // The tail and the floor probe are block ranges across every pair: the 4th key column needs a skipping index.
    expect(table('ema_oracle_updates')).toContain('INDEX idx_ema_block block_height TYPE minmax GRANULARITY 1')
    expect(table('ema_oracle_updates')).toContain('ReplacingMergeTree(ingested_at)')
  })
  it('reads no Nullable column of raw_events', () => {
    expect(nullableOf(table('raw_events'))).toEqual(expect.arrayContaining(['extrinsic_index', 'call_address']))
    for (const c of nullableOf(table('raw_events'))) expect(sel, c).not.toMatch(new RegExp(`\\b${c}\\b`))
  })
  it('converts extracted text only through *OrZero, and guards every division', () => {
    expect(sel.match(/toFloat64OrZero\(JSONExtractString\(/g)).toHaveLength(4)
    expect(sel).not.toMatch(/toFloat64\(|CAST\(|::|toUInt\d+\(JSONExtractString/)
    // Integer conversions take numbers only (JSONExtractUInt, reinterpretAsUInt8), which never throw.
    for (const m of sel.matchAll(/toUInt32\(([A-Za-z]+)\(/g)) expect(['JSONExtractUInt', 'reinterpretAsUInt8']).toContain(m[1])
    expect(sel).toContain('if(short_d > 0, short_n / short_d, 0)')
    expect(sel).toContain('if(day_d > 0, day_n / day_d, 0)')
  })
  it('keeps the exact values for the window the page lists, the floats for all history', () => {
    expect(table('ema_oracle_updates')).toMatch(/`updates` String CODEC\(ZSTD\(6\)\) TTL block_timestamp \+ toIntervalDay\(40\)/)
    expect(table('ema_oracle_updates')).not.toMatch(/TTL block_timestamp \+ toIntervalDay\(\d+\)(?: DELETE)?\s*SETTINGS/)
  })
})
