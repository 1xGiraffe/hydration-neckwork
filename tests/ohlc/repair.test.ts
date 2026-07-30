import { describe, expect, it } from 'vitest'
import {
  OHLC_TABLE_SPECS,
  buildDeleteOHLCQuery,
  buildRebuildOHLCQuery,
  buildRestoreRollbackPrefixQuery,
} from '../../src/ohlc/repair.js'

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
    expect(query).toContain('argMinState(p.usd_price, b.block_timestamp) AS open_state')
  })

  it('can scope delete and rebuild queries to selected assets', () => {
    const spec = OHLC_TABLE_SPECS.find(entry => entry.table === 'ohlc_1h')
    expect(spec).toBeDefined()

    const deleteQuery = buildDeleteOHLCQuery(spec!, '2024-02-01 00:00:00', '2024-02-02 00:00:00', [34, 20, 34])
    const rebuildQuery = buildRebuildOHLCQuery(spec!, '2024-02-01 00:00:00', '2024-02-02 00:00:00', [34, 20, 34])

    expect(deleteQuery).toContain('AND asset_id IN (34, 20)')
    expect(rebuildQuery).toContain('AND p.asset_id IN (34, 20)')
  })
})
