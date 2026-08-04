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

  // Module-level function bodies end at the first column-0 closing brace.
  const body = (name: string): string => {
    const start = explorerService.indexOf(`export async function ${name}(`)
    expect(start, name).toBeGreaterThan(-1)
    return explorerService.slice(start, start + explorerService.slice(start).indexOf('\n}\n'))
  }

  it('takes the schedule page\'s failure errors off the rows it already listed', () => {
    const schedule = body('getDcaSchedule')
    // The row list comes from dca_events, so every row it can display has an
    // error column already; the second query matched raw_events on a
    // (block_height, event_index) tuple across tables to get the same string.
    expect(schedule).toContain('dcaError: x.error || undefined')
    // Spelled WITH the space the codebase actually uses: the no-space form appears
    // nowhere in api/src, so a guard written that way matched zero things and would
    // have passed over the cross-table lookup it exists to keep out. The positive
    // count pins that the construct is still spelled this way somewhere, so this
    // stays a real absence rather than another literal that can never match.
    expect((explorerService.match(/\(block_height, event_index\) IN/g) ?? []).length).toBe(13)
    expect(schedule).not.toContain('(block_height, event_index) IN')
    // The one raw_events read left in here is DCA.Terminated's point lookup, whose
    // error genuinely has no column. Pinning the count is what keeps that true: a
    // reintroduced per-row error read would be a second one.
    const rawReads = schedule.match(/FROM price_data\.raw_events/g) ?? []
    expect(rawReads).toHaveLength(1)
    expect(schedule.slice(schedule.indexOf('FROM price_data.raw_events'))).toContain("event_name = 'DCA.Terminated'")
  })

  it('reads no TradeFailed error from raw_events anywhere', () => {
    const sites = [...explorerService.matchAll(/JSONExtractRaw\(args_json,'error'\)/g)]
    // The one remaining site is DCA.Terminated's, which cannot use the column.
    expect(sites).toHaveLength(1)
    for (const site of sites) {
      const stmt = explorerService.slice(site.index ?? 0, (site.index ?? 0) + 400)
      expect(stmt).toContain("event_name = 'DCA.Terminated'")
      expect(stmt).not.toContain('DCA.TradeFailed')
    }
  })

  it('keeps the terminated schedule\'s reason on raw_events, which is its only source', () => {
    // dca_events_mv writes '' AS error for DCA.Terminated, so folding this site
    // in the way the failure sites were folded would blank every terminated
    // schedule's status reason with nothing to catch it.
    expect(statement(views, 'dca_events_mv')).toContain("'DCA.Terminated'")
    const schedule = body('getDcaSchedule')
    const at = schedule.indexOf('let statusReason')
    expect(at).toBeGreaterThan(-1)
    const reason = schedule.slice(at, schedule.indexOf('dcaTerminationReason(', at) + 200)
    expect(reason).toContain('price_data.raw_events')
    expect(reason).toContain("JSONExtractRaw(args_json,'error')")
  })

  it('reads the execution page\'s failure reason from the event row it already fetched', () => {
    const execution = body('getDcaExecution')
    expect(execution).toContain('price_data.dca_events')
    expect(execution).toContain('dispatchErrorReason(ev.error || null,')
    expect(execution).not.toContain('raw_events')
    expect(execution).not.toContain('args_json')
  })
})
