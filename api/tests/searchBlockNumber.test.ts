import { describe, expect, it } from 'vitest'
import { initExplorerService, search, searchNumber, type SearchResult } from '../src/services/explorerService.ts'
import { initGovernanceService } from '../src/services/governanceService.ts'
import { initReferendumTitleService } from '../src/services/referendumTitleService.ts'

// Every height in the UI renders through F.int, pinned to en-US, so the number a
// reader copies off a page carries commas. Pasting it back has to find the block.
describe('searchNumber', () => {
  it('reads a height as the UI wrote it', () => {
    expect(searchNumber('14,871,261')).toBe(14_871_261)
    expect(searchNumber('14871261')).toBe(14_871_261)
    // The spaces a non-US locale or a spreadsheet can produce, and underscores.
    expect(searchNumber('14 871 261')).toBe(14_871_261)
    expect(searchNumber('14 871 261')).toBe(14_871_261)
    expect(searchNumber('14 871 261')).toBe(14_871_261)
    expect(searchNumber('14_871_261')).toBe(14_871_261)
    expect(searchNumber(" 14,871,261 ".trim())).toBe(14_871_261)
  })

  // A period is NOT a separator here: "1.5" would silently become block 15.
  it('refuses a period, so a decimal never becomes a height', () => {
    expect(searchNumber('1.5')).toBeNull()
    expect(searchNumber('14.871.261')).toBeNull()
  })

  it('refuses anything that is not purely a number, and anything past UInt32', () => {
    expect(searchNumber('0x1234')).toBeNull()
    expect(searchNumber('14,871,26a')).toBeNull()
    expect(searchNumber('')).toBeNull()
    expect(searchNumber(',,,')).toBeNull()
    // block_height is UInt32 on every column that holds one.
    expect(searchNumber('4294967295')).toBe(4_294_967_295)
    expect(searchNumber('4294967296')).toBeNull()
    expect(searchNumber('99999999999999999999')).toBeNull()
  })
})

// A height the chain has not reached is still worth offering: the block page
// answers one with a live countdown.
const HEAD = 14_871_000

function init(): void {
  const client = {
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      if (opts.query.includes('max(block_height) AS head')) return { json: async () => [{ head: String(HEAD) }] }
      // No height is indexed in this fixture, so every lookup falls to the
      // future-block branch — which is the branch under test.
      if (opts.query.includes('price_data.raw_blocks')) return { json: async () => [{ c: '0' }] }
      return { json: async () => [] }
    },
  }
  initExplorerService(client as never)
  initGovernanceService(client as never)
  initReferendumTitleService(client as never)
}

const blocks = (r: SearchResult[]) => r.filter(x => x.type === 'block')

describe('search: a height the chain has not reached', () => {
  it('offers a block past the head, and says it has not happened', async () => {
    init()
    const hits = blocks(await search(String(HEAD + 5_000)))
    expect(hits).toHaveLength(1)
    // The route is built from `value`, so it must stay plain digits.
    expect(hits[0].value).toBe(String(HEAD + 5_000))
    expect(hits[0].desc).toBe('not produced yet')
  })

  // `head` here is the INDEXED head, which trails the chain by the finality lag.
  // The block right behind it exists already — calling it unproduced would be
  // wrong, and the block page says "waiting to be indexed" about exactly these.
  it('calls a block inside the indexing lag un-indexed, not unproduced', async () => {
    init()
    const hits = blocks(await search(String(HEAD + 2)))
    expect(hits.map(h => h.desc)).toEqual(['not indexed yet'])
  })

  it('finds the same block when the separators are pasted with it', async () => {
    init()
    const hits = blocks(await search((HEAD + 6_000).toLocaleString('en-US')))
    expect(hits.map(h => h.value)).toEqual([String(HEAD + 6_000)])
  })

  it('offers nothing for a height beyond the horizon', async () => {
    init()
    // Past a year of blocks at any pace this chain has run.
    expect(blocks(await search(String(HEAD + 400_000_000)))).toEqual([])
  })

  it('offers nothing for a height BELOW the head that is simply not indexed', async () => {
    init()
    // Not a future block — a gap. Offering it would send the reader to a
    // countdown for a block that already happened.
    expect(blocks(await search(String(HEAD - 5_000)))).toEqual([])
  })
})
