import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '../src/db/schemaBootstrap.ts'

// The user-revenue watermark MVs sit on ingestion paths — raw-live's balance
// observations, the snapshot MVs' pool-state grids, the money-market and
// liquidity-mining projections. An MV that throws, or puts a NULL into an
// ordinary column, fails the SOURCE insert and stalls ingestion (the
// 2026-10-02 raw-live outage). These pins hold every SELECT to non-Nullable
// source columns and conversion-free expressions, and keep the declarations
// idempotent.
const statementsOf = (file: string) =>
  splitSqlStatements(readFileSync(new URL(`../../clickhouse/schema/${file}`, import.meta.url), 'utf8'))
    .map(s => s.replace(/^[ \t]*--.*$/gm, '').trim())
const all = ['001_tables.sql', '003_materialized_views.sql', '006_public.sql', '007_money_market_history.sql', '010_uniswap_v3.sql', '016_user_revenue.sql'].flatMap(statementsOf)
const ur = statementsOf('016_user_revenue.sql')

/** `name type` pairs of a CREATE TABLE's column list. */
function columns(stmt: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of stmt.matchAll(/`([a-z_0-9]+)` ((?:LowCardinality\(|Nullable\(|Array\(|SimpleAggregateFunction\()?[A-Za-z0-9]+(?:\([^)]*\))?\)?)/g)) if (!out.has(m[1])) out.set(m[1], m[2])
  return out
}
const tableOf = (name: string) => {
  const found = all.filter(s => s.startsWith(`CREATE TABLE IF NOT EXISTS price_data.${name} `))
  expect(found, name).toHaveLength(1)
  return found[0]
}

describe('016_user_revenue.sql', () => {
  it('is idempotent: every statement is CREATE … IF NOT EXISTS, ADD COLUMN/PROJECTION IF NOT EXISTS or a MODIFY SETTING', () => {
    for (const s of ur) expect(s).toMatch(/^(CREATE (TABLE|MATERIALIZED VIEW) IF NOT EXISTS|ALTER TABLE price_data\.\w+ (ADD (COLUMN|PROJECTION) IF NOT EXISTS|MODIFY SETTING))/)
  })

  it('carries the staleness reads\' projections on the live tables and their staging twins, the CREATE and the upgrade alike', () => {
    for (const [t, proj] of [['user_revenue_hourly', 'assets_by_month'], ['user_revenue_exposure_anchor', 'fp_by_month']] as const) {
      for (const name of [t, `${t}_staging`]) {
        expect(ur.find(s => s.startsWith(`CREATE TABLE IF NOT EXISTS price_data.${name} `))).toContain(`PROJECTION ${proj} (`)
        expect(ur.some(s => s.startsWith(`ALTER TABLE price_data.${name} ADD PROJECTION IF NOT EXISTS ${proj} (`))).toBe(true)
      }
    }
  })

  it('declares byte-identical staging twins for the three published tables', () => {
    for (const t of ['user_revenue_hourly', 'account_user_revenue_daily', 'user_revenue_exposure_anchor']) {
      const live = ur.find(s => s.startsWith(`CREATE TABLE IF NOT EXISTS price_data.${t} `))!
      const twin = ur.find(s => s.startsWith(`CREATE TABLE IF NOT EXISTS price_data.${t}_staging `))!
      expect(twin.replace(`${t}_staging`, t)).toBe(live)
      // The same ADD COLUMNs on both, so an upgraded deployment keeps them identical.
      const alters = (name: string) => ur.filter(s => s.startsWith(`ALTER TABLE price_data.${name} `)).map(s => s.replace(name, 'T'))
      expect(alters(`${t}_staging`)).toEqual(alters(t))
    }
  })

  const views = ur.filter(s => s.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS'))
  const watermarkViews = views.filter(v => / TO price_data\.user_revenue_(hour|block)_watermarks /.test(v))
  it('feeds the two watermark tables from twelve sources, and the voting-records projection from raw_events', () => {
    expect(watermarkViews).toHaveLength(12)
    expect(views.filter(v => !watermarkViews.includes(v)).map(v => v.match(/price_data\.(\S+) TO/)![1])).toEqual(['gigahdx_reward_records_mv'])
  })

  for (const v of views) {
    const name = v.match(/price_data\.(\S+) TO/)![1]
    const sel = v.slice(v.indexOf(') AS SELECT ') + 5)
    const source = sel.match(/FROM price_data\.(\w+)/)![1]
    it(`${name}: reads only non-Nullable columns of ${source} and converts nothing that can throw`, () => {
      const cols = columns(tableOf(source))
      const used = [...sel.matchAll(/\b([a-z_]+)\b/g)].map(m => m[1]).filter(c => cols.has(c))
      expect(used.length).toBeGreaterThan(0)
      for (const c of used) expect(cols.get(c), `${source}.${c}`).not.toMatch(/^Nullable/)
      // JSONExtractUInt / JSONExtractString return their default on a malformed payload and never throw;
      // every other extractor or conversion could.
      expect(sel.replace(/JSONExtract(UInt|String)\(args_json, '\w+'\)/g, '')).not.toMatch(/JSONExtract|toUInt\d+\(|toInt\d+\(|toFloat|CAST\((?!\[\], 'Array\(UInt32\)'\))|::/)
      // The aggregates a replay cannot move (min/max) — never an additive sum or count.
      if (watermarkViews.includes(v)) expect(sel).not.toMatch(/\b(sum|count)\(/)
    })
  }
})
