import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../../src/db/client.js'
import {
  DAY_CLOSES_SELECT,
  OHLC_TABLE_SPECS,
  buildDeleteDayClosesQuery,
  buildDeleteOHLCQuery,
  buildRebuildOHLCQuery,
  buildRederiveDayClosesQuery,
  buildRestoreRollbackPrefixQuery,
  clearOHLCForTimeRange,
  rebuildOHLCForTimeRange,
  restoreRollbackOHLCPrefix,
} from '../../src/ohlc/repair.js'

function recordingClient(): { client: ClickHouseClient; queries: string[] } {
  const queries: string[] = []
  const client = { command: async ({ query }: { query: string }) => { queries.push(query) } } as unknown as ClickHouseClient
  return { client, queries }
}

describe('OHLC repair helpers', () => {
  it('uses ISO Monday week boundaries for weekly repair queries', () => {
    const spec = OHLC_TABLE_SPECS.find(entry => entry.table === 'ohlc_1w')
    expect(spec).toBeDefined()

    const query = buildDeleteOHLCQuery(spec!, '2024-02-01 00:23:24', '2024-02-01 12:00:00')
    expect(query).toContain("toStartOfWeek(toDateTime('2024-02-01 00:23:24'), 1)")
    expect(query).not.toContain('toStartOfInterval')
  })

  it('restores only the preserved prefix before the rollback start time', () => {
    const spec = OHLC_TABLE_SPECS.find(entry => entry.table === 'ohlc_1d')
    expect(spec).toBeDefined()

    const query = buildRestoreRollbackPrefixQuery(spec!, '2024-02-01 00:23:24')
    expect(query).toContain("toStartOfDay(b.block_timestamp) = toStartOfDay(toDateTime('2024-02-01 00:23:24'))")
    expect(query).toContain("b.block_timestamp < toDateTime('2024-02-01 00:23:24')")
  })

  it('rebuilds full intervals from prices for the requested range', () => {
    const spec = OHLC_TABLE_SPECS.find(entry => entry.table === 'ohlc_1m')
    expect(spec).toBeDefined()

    const query = buildRebuildOHLCQuery(spec!, '2024-01-29 00:00:00', '2024-02-01 00:00:00')
    expect(query).toContain("toStartOfMonth(b.block_timestamp) >= toStartOfMonth(toDateTime('2024-01-29 00:00:00'))")
    expect(query).toContain("toStartOfMonth(b.block_timestamp) <= toStartOfMonth(toDateTime('2024-02-01 00:00:00'))")
    expect(query).toContain('argMinState(price, block_time) AS open_state')
  })

  // price_data.prices is a ReplacingMergeTree keyed on (asset_id, block_height).
  // A re-indexed block leaves duplicate rows until a merge collapses them, so a
  // rebuild that sums the raw read multiplies that block's volume into the candle
  // permanently. Every INSERT…SELECT into a candle table has to collapse the key
  // before it aggregates.
  it.each(OHLC_TABLE_SPECS.map(spec => spec.table))(
    'deduplicates the replayable prices read before aggregating %s',
    table => {
      const spec = OHLC_TABLE_SPECS.find(entry => entry.table === table)!
      const queries = [
        buildRebuildOHLCQuery(spec, '2024-02-01 00:00:00', '2024-02-02 00:00:00'),
        buildRebuildOHLCQuery(spec, '2024-02-01 00:00:00', '2024-02-02 00:00:00', [34]),
        buildRestoreRollbackPrefixQuery(spec, '2024-02-01 00:23:24'),
      ]

      for (const query of queries) {
        expect(query).toContain('GROUP BY p.asset_id, p.block_height')
        // The sums must read the collapsed rows, never the raw table columns.
        expect(query).toContain('sumState(volume_buy) AS volume_buy_state')
        expect(query).toContain('sumState(volume_sell) AS volume_sell_state')
        expect(query).not.toContain('sumState(p.usd_volume_buy)')
        expect(query).not.toContain('sumState(p.usd_volume_sell)')
      }
    },
  )

  it('can scope delete and rebuild queries to selected assets', () => {
    const spec = OHLC_TABLE_SPECS.find(entry => entry.table === 'ohlc_1h')
    expect(spec).toBeDefined()

    const deleteQuery = buildDeleteOHLCQuery(spec!, '2024-02-01 00:00:00', '2024-02-02 00:00:00', [34, 20, 34])
    const rebuildQuery = buildRebuildOHLCQuery(spec!, '2024-02-01 00:00:00', '2024-02-02 00:00:00', [34, 20, 34])

    expect(deleteQuery).toContain('AND asset_id IN (34, 20)')
    expect(rebuildQuery).toContain('AND p.asset_id IN (34, 20)')
  })

  // ohlc_1h_day_closes is written by a view chained off ohlc_1h, which no DELETE
  // reaches. A repair or rollback that left its days alone would keep the deleted
  // candles' hours and closes — and a corrected close at the same instant as the old
  // one ties in argMax, so either could win.
  describe('ohlc_1h_day_closes', () => {
    it('re-derives with the view\'s own SELECT', () => {
      const schema = readFileSync(new URL('../../clickhouse/schema/023_ohlc_day_closes.sql', import.meta.url), 'utf8')
      expect(schema).toContain(`AS ${DAY_CLOSES_SELECT} GROUP BY asset_id, day;`)
      const query = buildRederiveDayClosesQuery('2024-02-01 00:23:24', '2024-02-03 05:00:00')
      expect(query).toContain(DAY_CLOSES_SELECT)
      expect(query).toContain('GROUP BY asset_id, day')
    })

    it('clears and re-derives whole days, scoped to the assets asked', () => {
      const del = buildDeleteDayClosesQuery('2024-02-01 00:23:24', '2024-02-03 05:00:00', [34, 20, 34])
      expect(del).toContain("day >= toStartOfDay(toDateTime('2024-02-01 00:23:24'))")
      expect(del).toContain("day <= toStartOfDay(toDateTime('2024-02-03 05:00:00'))")
      expect(del).toContain('AND asset_id IN (34, 20)')
      const rederive = buildRederiveDayClosesQuery('2024-02-01 00:23:24', '2024-02-03 05:00:00', [34])
      expect(rederive).toContain("interval_start >= toStartOfDay(toDateTime('2024-02-01 00:23:24'))")
      expect(rederive).toContain("interval_start < toStartOfDay(toDateTime('2024-02-03 05:00:00')) + INTERVAL 1 DAY")
      expect(rederive).toContain('AND asset_id IN (34)')
    })

    it('clears the days with the candles and re-derives them after the rebuild', async () => {
      const { client, queries } = recordingClient()
      await rebuildOHLCForTimeRange(client, '2024-02-01 00:00:00', '2024-02-02 00:00:00', [34])
      const candleInserts = queries.flatMap((q, i) => q.startsWith('INSERT INTO price_data.ohlc_') && !q.startsWith('INSERT INTO price_data.ohlc_1h_day_closes') ? [i] : [])
      const lastCandleInsert = candleInserts[candleInserts.length - 1]
      expect(queries.filter(q => q.startsWith('DELETE FROM price_data.ohlc_1h_day_closes'))).toEqual([buildDeleteDayClosesQuery('2024-02-01 00:00:00', '2024-02-02 00:00:00', [34])])
      expect(queries[queries.length - 1]).toBe(buildRederiveDayClosesQuery('2024-02-01 00:00:00', '2024-02-02 00:00:00', [34]))
      expect(lastCandleInsert).toBeGreaterThan(queries.findIndex(q => q.startsWith('DELETE FROM price_data.ohlc_1h_day_closes')))
      expect(lastCandleInsert).toBe(queries.length - 2)
    })

    it('re-derives the rollback start\'s day after the prefix is restored', async () => {
      const { client, queries } = recordingClient()
      await clearOHLCForTimeRange(client, '2024-02-01 00:23:24', '2024-02-05 00:00:00')
      expect(queries[queries.length - 1]).toBe(buildDeleteDayClosesQuery('2024-02-01 00:23:24', '2024-02-05 00:00:00'))
      queries.length = 0
      await restoreRollbackOHLCPrefix(client, '2024-02-01 00:23:24')
      expect(queries).toHaveLength(OHLC_TABLE_SPECS.length + 1)
      expect(queries[queries.length - 1]).toBe(buildRederiveDayClosesQuery('2024-02-01 00:23:24', '2024-02-01 00:23:24'))
    })
  })
})
