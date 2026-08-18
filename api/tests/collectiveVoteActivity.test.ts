import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  collectiveVoteRow, collectiveVotesAdmitted, mergeVoteFeedPage, voteFeedGovWindow,
  type AssetRef, type VoteRow,
} from '../src/services/explorerService.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'

// Council / Technical Committee votes are first-class vote activity: they are
// merged into the same feed the indexed conviction votes come from, on every
// surface. Two things have to hold for that, and both are pinned here — the row a
// collective event builds, and the arithmetic that pages the merge without
// breaking the vote category's EXACT total.

const HDX = { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12 } as AssetRef
const VOTER = '0x' + '11'.repeat(32)
const HASH = '0x0529aaaabbbbccccddddeeeeffff00001111222233334444555566664b5b'

const event = (over: Partial<{ event_name: string; args: Record<string, unknown>; block: number; index: number }> = {}) => ({
  block_height: over.block ?? 7_000_000,
  ts: '2026-08-01 00:00:00',
  event_index: over.index ?? 4,
  extrinsic_index: 2,
  event_name: over.event_name ?? 'TechnicalCommittee.Voted',
  args_json: JSON.stringify({ account: VOTER, proposalHash: HASH, voted: true, yes: 3, no: 0, ...over.args }),
})

describe('collective vote rows', () => {
  it('builds a vote row from the committee event arg shape', () => {
    const row = collectiveVoteRow(event(), HDX)
    expect(row.pallet).toBe('Technical Committee')
    expect(row.action).toBe('Voted')
    expect(row.side).toBe('Aye')
    // The proposal hash stands in for a referendum index, shortened the same way
    // the UI shortens a hash (first 8 + … + last 6).
    expect(row.referendum).toBe('0x0529aa…664b5b')
    expect(row.account?.accountId).toBe(VOTER)
    // No capital, no conviction — a collective vote locks nothing, and inventing a
    // zero would read as a vote with no weight rather than one with no stake.
    expect(row.amount).toBeNull()
    expect(row.conviction).toBeNull()
    expect(row.asset.assetId).toBe(0)
  })

  it('names the council apart from the technical committee, and reads the side off `voted`', () => {
    expect(collectiveVoteRow(event({ event_name: 'Council.Voted' }), HDX).pallet).toBe('Council')
    expect(collectiveVoteRow(event({ args: { voted: false } }), HDX).side).toBe('Nay')
    // An event whose `voted` flag is missing states no side rather than guessing one.
    expect(collectiveVoteRow(event({ args: { voted: null } }), HDX).side).toBe('Vote')
  })
})

/* ── the merged pager ─────────────────────────────────────────────────────── */

const vote = (block: number, index: number, collective: boolean): VoteRow => ({
  blockHeight: block, timestamp: '2026-08-01 00:00:00', eventIndex: index, extrinsicIndex: 1,
  account: null, pallet: collective ? 'Technical Committee' : 'ConvictionVoting', action: 'Voted',
  referendum: collective ? '0x0529aa…664b5b' : '371', side: 'Aye',
  conviction: collective ? null : 'Locked3x', amount: collective ? null : '1000',
  asset: HDX, valueUsd: collective ? 0 : 1,
})

const newestFirst = (a: VoteRow, b: VoteRow) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex
const key = (r: VoteRow) => `${r.blockHeight}:${r.eventIndex}`

// A corpus whose two sources interleave at every scale: the indexed source holds
// a row in every block, the collective one every seventh block, plus a pair that
// share a block so the (block, event) tie-break is exercised too.
const GOV = Array.from({ length: 120 }, (_, i) => vote(9_000 - i, 1, false))
const COLLECTIVE = [
  ...Array.from({ length: 18 }, (_, i) => vote(9_000 - i * 7, 3, true)),
  vote(8_995, 2, true),
].sort(newestFirst)
const NAIVE = [...GOV, ...COLLECTIVE].sort(newestFirst)

// What the service does: ask the indexed source for the window the arithmetic
// says it needs (SQL LIMIT/OFFSET over ITS ordering), then translate ranks.
function page(limit: number, offset: number): VoteRow[] {
  const window = voteFeedGovWindow(limit, offset, COLLECTIVE.length)
  const gov = GOV.slice(window.start, window.start + window.limit)
  return mergeVoteFeedPage(gov, COLLECTIVE, limit, offset, window.start)
}

describe('vote feed merge paging', () => {
  it('returns exactly the merged ordering at every offset, without reading it whole', () => {
    for (const limit of [1, 5, 25]) {
      for (let offset = 0; offset < NAIVE.length + limit; offset += limit) {
        expect(page(limit, offset).map(key), `limit ${limit} offset ${offset}`)
          .toEqual(NAIVE.slice(offset, offset + limit).map(key))
      }
    }
  })

  it('keeps the indexed read bounded by the small source, not by the offset', () => {
    // The deep page is what this arithmetic exists for: a 25-row page at offset
    // 2,500 reads 25 + 19 indexed rows, not 2,525.
    const window = voteFeedGovWindow(25, 2_500, COLLECTIVE.length)
    expect(window.limit).toBe(25 + COLLECTIVE.length)
    expect(window.start).toBe(2_500 - COLLECTIVE.length)
    // Page 1 needs no lead at all.
    expect(voteFeedGovWindow(25, 0, COLLECTIVE.length)).toEqual({ start: 0, limit: 25 })
  })

  it('pages consecutively with no overlap and no gap across a source boundary', () => {
    const seen = new Set<string>()
    for (let offset = 0; offset < NAIVE.length; offset += 7) {
      for (const row of page(7, offset)) {
        expect(seen.has(key(row)), `${key(row)} served twice`).toBe(false)
        seen.add(key(row))
      }
    }
    expect(seen.size).toBe(NAIVE.length)
  })

  // getGlobalActivityTotal counts each source's own rows and adds them. The pager
  // must therefore serve exactly that many rows across the whole feed: a total the
  // feed cannot fill is a pager offering pages that answer empty.
  it('serves as many rows as the union total counts', () => {
    const total = GOV.length + COLLECTIVE.length
    let served = 0
    for (let offset = 0; offset < total + 25; offset += 25) served += page(25, offset).length
    expect(served).toBe(total)
  })
})

describe('which feeds admit a collective vote', () => {
  // The token filter resolves a ticker through the asset registry, so the two
  // tokens these cases name have to exist in it.
  beforeAll(async () => {
    await loadExplorerAssets({
      query: vi.fn(async () => ({ json: async () => [
        { asset_id: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
        { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
      ] })),
    } as never)
  })
  afterAll(() => stopExplorerAssetsRefresh())

  // The source gate and the total's union are the same predicate, so a filtered
  // feed and its published length can never disagree about these rows.
  it('excludes them from any value floor and from a non-HDX token filter', () => {
    expect(collectiveVotesAdmitted({})).toBe(true)
    expect(collectiveVotesAdmitted({ token: 'HDX' })).toBe(true)
    expect(collectiveVotesAdmitted({ min: 10, unit: 'usd' })).toBe(false)
    expect(collectiveVotesAdmitted({ min: 10, unit: 'token' })).toBe(false)
    expect(collectiveVotesAdmitted({ token: 'DOT' })).toBe(false)
  })

  it('gates the exact total on the same predicate the feed reads under', () => {
    const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
    const at = src.indexOf('export async function getGlobalActivityTotal')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('\n}', at))
    expect(body).toContain('collectiveVotesAdmitted(filters) ? countCollectiveVotes(from, to) : 0')
  })
})
