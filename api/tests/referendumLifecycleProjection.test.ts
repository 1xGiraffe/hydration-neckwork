import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const governanceService = readFileSync(new URL('../src/services/governanceService.ts', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// A referendum is named inside args_json, so selecting one out of raw_events took
// `event_name LIKE 'Referenda.%'` — which the `set(200)` skip index on event_name cannot
// use the way an IN list can — plus JSONExtractInt over every row the scan reached. One
// cold detail page read 36.3M rows / 1.47 GiB, and the three sites together cost 1.74 TiB
// over three days to return at most a few hundred rows.
//
// Every assertion below also pins HOW MANY sites it found: a bare "does not contain" guard
// passes just as happily once the thing it guards has been renamed out from under it.
describe('the referendum lifecycle projection replaces the raw_events scans', () => {
  it('leaves no LIKE-prefix governance scan anywhere', () => {
    expect(occurrences(governanceService, `LIKE 'Referenda.%'`)).toBe(0)
    expect(occurrences(governanceService, `LIKE 'Democracy.%'`)).toBe(0)
    expect(occurrences(governanceService, '{prefix:String}')).toBe(0)
  })

  it('reads the lifecycle from the projection at both of its API sites', () => {
    // The detail page and the directory. The title fetcher's inventory runs the same
    // shape on a fifteen-minute loop and is guarded in its own workspace
    // (tests/governance/referendumInventory.test.ts).
    expect(occurrences(governanceService, 'price_data.referendum_lifecycle_events')).toBe(2)
  })

  it('looks a referendum up by its decoded key rather than re-parsing args_json', () => {
    expect(governanceService).toContain('WHERE pallet = {pallet:String} AND ref_index = {idx:UInt32}')
    // The page still reads args_json for the tally, track and proposal hash; what it must
    // never do again is decode the INDEX, which is what forced the full scan. The one
    // remaining decode is loadDemocracyVotes, over the vote projection rather than raw:
    // vote_activity has no ref_index column and its event_name equality does prune.
    expect(occurrences(governanceService, `JSONExtractInt(args_json, 'index')`)).toBe(0)
    expect(occurrences(governanceService, `JSONExtractInt(args_json, 'refIndex')`)).toBe(1)
    expect(governanceService).toContain(`FROM price_data.vote_activity\n            WHERE event_name = 'Democracy.Voted' AND toUInt32(JSONExtractInt(args_json, 'refIndex')) = {idx:UInt32}`)
  })

  // Unlike dust_lost_events and liquidation_extrinsics, this projection is not a lookup
  // set: its rows are returned and read positionally (first row, last concluding row,
  // last row carrying a tally) and grouped into the directory. A replayed range therefore
  // has to be collapsed, which is what FINAL does — re-running the backfill doubled the
  // physical rows to 5,292 and an un-FINAL read of referendum 368 returned 10 rows for its
  // 5 events, while every FINAL read stayed byte-identical.
  it('reads the projection with FINAL at both sites', () => {
    expect(occurrences(governanceService, 'price_data.referendum_lifecycle_events FINAL')).toBe(2)
  })

  // The last lifecycle event's block is not unique across referenda: 84 of the 580 share
  // one with another because a deposit-refund batch closes many at once. Ordering on it
  // alone made LIMIT/OFFSET pages inconsistent — walking the four pages of the default
  // limit returned two referenda twice and dropped two others, and which two varied from
  // one walk to the next.
  it('orders the directory totally, so its pages cannot overlap or skip', () => {
    expect(occurrences(governanceService, 'ORDER BY block_height DESC, pallet ASC, ref_index DESC')).toBe(1)
    expect(occurrences(governanceService, 'ORDER BY block_height DESC\n')).toBe(0)
  })

  // The lifecycle answers what each referendum IS, not how many accounts backed it: a
  // voter count is the accounts whose latest vote in the window still stands, and neither
  // half is a column here (an OpenGov Voted event does not carry the poll index, and a
  // withdrawal is a removal call that may be wrapped). The directory said `0`, which reads
  // as "nobody voted" on 580 referenda that all have voters.
  it('states the directory has no voter count rather than reporting zero', () => {
    expect(occurrences(governanceService, 'voters: 0')).toBe(0)
    expect(occurrences(governanceService, 'voters: null')).toBe(1)
    expect(governanceService).toContain('voters: number | null')
    // The real count is still exact on the detail page, off its own reconstruction.
    expect(governanceService).toContain('voters: voters.filter(voter => !voter.removed).length')
  })
})

// The projection exists to answer "which referendum is this event about" without re-reading
// args_json. If the declaration and the readers ever disagree on how that index is decoded,
// events land under the wrong referendum silently.
describe('the referendum lifecycle declaration matches what the readers select', () => {
  it('declares the table keyed referendum-first', () => {
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.referendum_lifecycle_events (`pallet` LowCardinality(String), `ref_index` UInt32, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `args_json` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY tuple() ORDER BY (pallet, ref_index, block_height, event_index) SETTINGS index_granularity = 1024;')
  })

  it('derives the pallet and index exactly as the readers used to', () => {
    expect(occurrences(views, 'price_data.referendum_lifecycle_events_mv')).toBe(1)
    expect(views).toContain(`if(event_name LIKE 'Democracy.%', 'democracy', 'opengov') AS pallet`)
    expect(views).toContain(`toUInt32(if(event_name LIKE 'Democracy.%', JSONExtractInt(args_json, 'refIndex'), JSONExtractInt(args_json, 'index'))) AS ref_index`)
  })

  // The JSONHas guards are what keep the pallets' non-referendum events out — Democracy
  // .Delegated, .PreimageNoted, .Tabled and the single .Vetoed, which names a proposal hash
  // rather than a refIndex — and the Voted exclusion keeps 53,327 vote events out of a
  // lifecycle table. Both are the readers' own predicates, so the projection holds exactly
  // the rows the scans returned.
  it('keeps the readers own filter, guards and Voted exclusion', () => {
    expect(views).toContain(`FROM price_data.raw_events WHERE ((event_name LIKE 'Referenda.%') AND JSONHas(args_json, 'index')) OR ((event_name LIKE 'Democracy.%') AND (event_name != 'Democracy.Voted') AND JSONHas(args_json, 'refIndex'));`)
  })
})
