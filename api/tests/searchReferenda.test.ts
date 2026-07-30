import { describe, expect, it } from 'vitest'
import { initExplorerService, search, type SearchResult } from '../src/services/explorerService.ts'
import { initGovernanceService, referendumStatusFrom } from '../src/services/governanceService.ts'
import { initReferendumTitleService } from '../src/services/referendumTitleService.ts'

// A fixed referendum directory shared by every test below. `getReferenda` (which
// search() reaches for both the index and title matchers) is single-flight cached
// under one key regardless of query text — real behaviour that keeps a burst of
// searches to one ClickHouse read, but it also means every test in this file sees
// the SAME snapshot rather than one it can swap out per test. Kept constant here
// so that is harmless; each `it` below instead uses distinct query TEXT so
// search()'s own 10s response cache never crosses tests either.
interface FixtureRow { pallet: 'opengov' | 'democracy'; index: number; events: string[]; blockHeight: number; title: string | null }

const DIRECTORY: FixtureRow[] = [
  { pallet: 'opengov', index: 3000, events: ['Referenda.Submitted'], blockHeight: 9_999_000, title: null },
  { pallet: 'democracy', index: 263, events: ['Democracy.Started', 'Democracy.Passed'], blockHeight: 9_998_000, title: 'Treasury Council election' },
  { pallet: 'opengov', index: 263, events: ['Referenda.Submitted', 'Referenda.DecisionStarted'], blockHeight: 9_997_000, title: 'Treasury spend for Bifrost integration' },
  { pallet: 'opengov', index: 2634, events: ['Referenda.Submitted'], blockHeight: 9_996_000, title: null },
  { pallet: 'opengov', index: 2630, events: ['Referenda.Confirmed'], blockHeight: 9_995_000, title: null },
  { pallet: 'opengov', index: 99, events: ['Referenda.Rejected'], blockHeight: 9_994_000, title: 'Q3 treasury spend report' },
  { pallet: 'opengov', index: 5, events: ['Referenda.TimedOut'], blockHeight: 9_993_000, title: 'xtreasury spend fund' },
  { pallet: 'opengov', index: 42, events: ['Referenda.Confirmed'], blockHeight: 9_992_000, title: 'Treasury Spend' },
  ...Array.from({ length: 10 }, (_, i) => ({
    pallet: 'opengov' as const, index: 500 + i, events: ['Referenda.Submitted'],
    blockHeight: 9_991_000 - i * 1000, title: `Fillertoken proposal ${i + 1}`,
  })),
]

// `blockHitHeight` mimics raw_blocks answering "yes" for exactly one height, so a
// test can prove a digit query still finds the block it finds today alongside the
// new referendum hits.
function clientFor(blockHitHeight: number | null) {
  return {
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      if (opts.query.includes('price_data.referendum_lifecycle_events') && opts.query.includes('groupArray')) {
        return {
          json: async () => DIRECTORY.map(r => ({
            pallet: r.pallet, ref_index: r.index, events: r.events, block_height: r.blockHeight, ts: '2026-01-01 00:00:00',
          })),
        }
      }
      if (opts.query.includes('price_data.referendum_titles')) {
        return { json: async () => DIRECTORY.filter(r => r.title).map(r => ({ pallet: r.pallet, ref_index: r.index, title: r.title })) }
      }
      if (opts.query.includes('price_data.raw_blocks')) {
        const h = opts.query_params?.h
        return { json: async () => [{ c: blockHitHeight != null && h === blockHitHeight ? '1' : '0' }] }
      }
      return { json: async () => [] }
    },
  }
}

function init(blockHitHeight: number | null = null): void {
  const client = clientFor(blockHitHeight)
  initExplorerService(client as never)
  initGovernanceService(client as never)
  initReferendumTitleService(client as never)
}

const refs = (results: SearchResult[]) => results.filter(r => r.type === 'referendum')

describe('search: referendum index', () => {
  it('matches an exact index on both pallets, ranks it over a prefix match, and keeps finding the block a digit query finds today', async () => {
    init(263)
    const all = await search('263')
    const hits = refs(all)

    expect(hits.map(r => `${r.pallet}:${r.index}`)).toEqual(['democracy:263', 'opengov:263', 'opengov:2634', 'opengov:2630'])
    // Status comes from the same lifecycle-status mapping the referendum page uses.
    expect(hits.find(r => r.pallet === 'opengov' && r.index === 263)?.status)
      .toBe(referendumStatusFrom('opengov', ['Referenda.Submitted', 'Referenda.DecisionStarted']))
    expect(hits.find(r => r.pallet === 'democracy' && r.index === 263)?.status)
      .toBe(referendumStatusFrom('democracy', ['Democracy.Started', 'Democracy.Passed']))
    // An index with no fetched title yet is still findable by number.
    expect(hits.find(r => r.index === 2634)?.label).toBeUndefined()
    // The number still resolves the block it resolves today — the referendum
    // group is additive, not a replacement for the existing digit matchers.
    expect(all.some(r => r.type === 'block' && r.value === '263')).toBe(true)
  })

  it('falls back to prefix matching when nothing matches exactly', async () => {
    init()
    const hits = refs(await search('26'))

    expect(hits.map(r => `${r.pallet}:${r.index}`).sort()).toEqual(['democracy:263', 'opengov:263', 'opengov:2630', 'opengov:2634'].sort())
  })
})

describe('search: referendum title', () => {
  it('ranks an exact title, then a prefix, then a word-start, then a mid-word match — case-insensitively', async () => {
    init()
    const hits = refs(await search('TREASURY spend'))

    // 42 = exact "Treasury Spend"; 263 = starts with the phrase; 99 = the phrase
    // starts a later word ("Q3 treasury spend report"); 5 = "xtreasury spend
    // fund", where only "spend" sits at a word start, not the full phrase.
    expect(hits.map(r => r.index)).toEqual([42, 263, 99, 5])
    expect(hits.find(r => r.index === 263)?.label).toBe('Treasury spend for Bifrost integration')
    // Democracy #263's title ("Treasury Council election") never contains the
    // literal phrase "treasury spend" — it must not appear just because it shares
    // the word "treasury".
    expect(hits.some(r => r.pallet === 'democracy')).toBe(false)
  })

  it('caps results even when more titles match, keeping the newest first', async () => {
    init()
    const hits = refs(await search('fillertoken'))

    expect(hits).toHaveLength(8)
    expect(hits.every(r => r.pallet === 'opengov' && r.index != null && r.index >= 500 && r.index < 510)).toBe(true)
    expect(hits.map(r => r.index)).toEqual([500, 501, 502, 503, 504, 505, 506, 507])
  })

  it('matches nothing for a phrase no title contains', async () => {
    init()
    expect(refs(await search('does not exist anywhere'))).toEqual([])
  })
})
