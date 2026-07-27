import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A deep activity page carries tens of thousands of candidate rows, so any lookup
// keyed on "every block in this page" has to pass the list as a bound array in
// chunks. Interpolating it into the SQL text overflows ClickHouse's max_query_size
// and the route answers 500 with a raw database error instead of rows.
describe('per-page block lookups stay inside the query size limit', () => {
  it('resolves DCA swap legs with a chunked bound array', () => {
    const at = explorerService.indexOf('const fetchSwapLegs')
    expect(at).toBeGreaterThan(-1)
    const fn = explorerService.slice(at, explorerService.indexOf('const [, schedById]', at))

    expect(fn).toContain('block_height IN {blocks:Array(UInt32)}')
    // The chunking is the helper's; the 2,000 block quantum is still this read's.
    expect(fn).toContain('mapChunksConcurrently(blocks, 2_000,')
    expect(fn).toContain('query_params: { blocks: chunk }')
    expect(fn).not.toMatch(/block_height IN \(\$\{blocks\}\)/)
  })

  it('resolves XCM withdrawal legs with a chunked bound array', () => {
    const at = explorerService.indexOf("WHERE event_name='Currencies.Withdrawn' AND block_height IN")
    expect(at).toBeGreaterThan(-1)
    const surrounding = explorerService.slice(at - 700, at + 900)

    expect(surrounding).toContain('block_height IN {blocks:Array(UInt32)}')
    expect(surrounding).toContain('mapChunksConcurrently(blocks, 2_000,')
    expect(surrounding.match(/query_params: \{ blocks: chunk \}/g)).toHaveLength(2)
  })
})
