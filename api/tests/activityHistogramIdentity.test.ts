import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

// activity_histogram_events.activity_index holds two identities in one integer: a
// swap's extrinsic index (so a router hop and its pool leg are one activity) and
// every other row's event index. Deduplicating on the number alone merges a swap in
// extrinsic N with an unrelated event at index N in the same block, so the daily
// histogram must key on the identity space too — and the service's notion of which
// events are swaps has to match the MV that wrote the column.
function names(list: string): string[] {
  return [...list.matchAll(/'([A-Za-z]+\.[A-Za-z]+Executed)'/g)].map(m => m[1])
}

// The MV's swap list is the `event_name IN (…)` test whose true branch keys the row
// on its extrinsic index.
function mvSwapNames(): string[] {
  const end = schema.indexOf(', ifNull(extrinsic_index, event_index), event_index)) AS activity_index')
  expect(end).toBeGreaterThan(-1)
  const start = schema.lastIndexOf('event_name IN (', end)
  return names(schema.slice(start, end))
}

function serviceSwapNames(): string[] {
  const at = explorerService.indexOf('const HISTOGRAM_SWAP_EVENTS_SQL')
  expect(at).toBeGreaterThan(-1)
  return names(explorerService.slice(at, explorerService.indexOf('\n', at)))
}

describe('daily activity histogram identity', () => {
  it('keys the histogram on the identity space, not the bare index', () => {
    const at = explorerService.indexOf('FROM price_data.activity_histogram_events')
    const query = explorerService.slice(explorerService.lastIndexOf('query = `', at), at)

    expect(query).toContain('uniqExact(${histogramIdentitySql()})')
    const def = explorerService.slice(explorerService.indexOf('export function histogramIdentitySql'))
    expect(def.slice(0, def.indexOf('\n}'))).toContain("tuple(block_height, multiIf(event_name IN (${HISTOGRAM_SWAP_EVENTS_SQL}), 1, event_name = '${V3_COMPOUND_HISTOGRAM_EVENT}', 2, 0), activity_index)")
  })

  // A compound row carries its extrinsic too (uniswap_v3_compound_histogram_mv), in a
  // space of its own: extrinsic 2's compound is not event 2 of the block.
  it('keys a compound on its extrinsic in the MV that writes it', () => {
    const v3 = readFileSync(new URL('../../clickhouse/schema/010_uniswap_v3.sql', import.meta.url), 'utf8')
    const mv = v3.slice(v3.indexOf('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.uniswap_v3_compound_histogram_mv'))
    expect(mv).toContain("assumeNotNull(extrinsic_index) AS activity_index, 'Gamma.Compound' AS event_name")
    expect(explorerService).toContain("export const V3_COMPOUND_HISTOGRAM_EVENT = 'Gamma.Compound'")
  })

  it('mirrors the materialized view that writes activity_index', () => {
    const service = serviceSwapNames()
    const mv = mvSwapNames()

    expect(service.length).toBeGreaterThan(0)
    expect([...service].sort()).toEqual([...mv].sort())
  })
})
