import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const statement = (sql: string, name: string): string =>
  sql.split('\n').find(line => line.includes(`price_data.${name} `) && line.startsWith('CREATE')) ?? ''

// DCA.TradeFailed's dispatch error is decoded once, by the MV, into a column of the
// read model. Re-reading raw_events for the page's keys looked bounded but was not:
// an event_name predicate cannot prune granules, so args_json was decompressed for
// every row in every granule the keys touched — 49.0M rows / 7.88 GiB for one deep
// page — and past ~20,900 keys the IN list overflowed ClickHouse's max_query_size
// and the request failed outright instead of paging.
describe('DCA failure errors come from the read model', () => {
  it('declares error on dca_events', () => {
    expect(statement(tables, 'dca_events')).toContain('`error` String')
  })

  it('populates error from the failure event, and matches the table on the other MV', () => {
    const failed = statement(views, 'dca_failed_events_mv')
    expect(failed).toContain('`error` String')
    expect(failed).toContain("JSONExtractRaw(args_json, 'error') AS error")

    // Both MVs insert into the same table, so the executed-event MV has to carry the
    // column too — it just has no error to report.
    const executed = statement(views, 'dca_events_mv')
    expect(executed).toContain('`error` String')
    expect(executed).toContain("'' AS error")
  })

  it('reads the column instead of re-decoding raw_events on the failure feeds', () => {
    const start = explorerService.indexOf('async function getRecentDcaFailures')
    expect(start).toBeGreaterThan(-1)
    // Module-level function, so its body ends at the first column-0 closing brace.
    const failures = explorerService.slice(start, start + explorerService.slice(start).indexOf('\n}\n'))
    expect(failures).toContain('dca_events')

    expect(failures).toContain('e.error AS error')
    expect(failures).toContain('dcaError: r.error || undefined')
    expect(failures).not.toContain('args_json')
    expect(failures).not.toContain('raw_events')
  })
})
