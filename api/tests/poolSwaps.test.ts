import { beforeEach, describe, expect, it } from 'vitest'
import { getPoolSwaps, initExplorerService } from '../src/services/explorerService.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

// A pool page's "swaps that happened IN this pool" is the one feed no other surface can
// show, and everything about it turns on confirming pool identity:
//
//  - XYK swap events name their pool by ACCOUNT (`pool`), never by `poolId` — only
//    Stableswap carries a poolId. A poolId comparison is 0 for every XYK row, so the
//    page could only ever be empty.
//  - Identity is confirmed against the events, which the candidate read cannot express,
//    so the walk has to keep going until it has the pool's OWN swaps. Confirming after a
//    single LIMIT reports a busy pool as idle whenever a busier sibling shares its pin
//    asset.
//  - asset_swap_activity is a ReplacingMergeTree with no version column, so a replayed
//    range holds the same swap twice until the parts merge.

const POOL_ACCOUNT = `0x${'7a'.repeat(32)}`
const MEMBERS = [100, 101]

interface Candidate { block_height: number; event_index: number; mine: boolean }

let candidates: Candidate[] = []
let identityQueries: { query: string; params: Record<string, unknown> | undefined }[] = []

const candidateRow = (c: Candidate): Record<string, unknown> => ({
  block_height: c.block_height,
  ts: '2026-08-04 10:00:00',
  event_index: c.event_index,
  extrinsic_index: 1,
  event_name: 'XYK.SellExecuted',
  who: `0x${'11'.repeat(32)}`,
  asset_in: MEMBERS[0],
  asset_out: MEMBERS[1],
  amount_in: '1000',
  amount_out: '2000',
})

// The cursor fetchFilteredDeep appends: `(1) AND (block_height < H OR (block_height = H
// AND event_index < E))`.
function belowCursor(query: string): (c: Candidate) => boolean {
  const m = /block_height < (\d+) OR \(block_height = \d+ AND event_index < (\d+)\)/.exec(query)
  if (!m) return () => true
  const [h, e] = [Number(m[1]), Number(m[2])]
  return c => c.block_height < h || (c.block_height === h && c.event_index < e)
}

function fakeClient(): ClickHouseClient {
  return {
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => ({
      json: async () => {
        const q = opts.query
        if (q.includes('xyk_pool_registry')) return [{ pool_account: POOL_ACCOUNT, created_block: 10 }]
        if (q.includes('FROM price_data.asset_swap_activity')) {
          const limit = Number(opts.query_params?.n ?? 0)
          return candidates.filter(belowCursor(q)).slice(0, limit).map(candidateRow)
        }
        if (q.includes('FROM price_data.raw_events') && q.includes('args_json')) {
          identityQueries.push({ query: q, params: opts.query_params })
          const asked = [...q.matchAll(/\((\d+),(\d+)\)/g)].map(([, h, e]) => `${h}:${e}`)
          const account = opts.query_params?.poolAccount
          return candidates
            .filter(c => c.mine && account === POOL_ACCOUNT && asked.includes(`${c.block_height}:${c.event_index}`))
            .map(c => ({ block_height: c.block_height, event_index: c.event_index }))
        }
        return []
      },
    }),
  } as unknown as ClickHouseClient
}

describe('a pool page reads its own swaps', () => {
  beforeEach(() => {
    resetCacheForTests()
    candidates = []
    identityQueries = []
    initExplorerService(fakeClient())
  })

  it('confirms an XYK pool by its account, which is the only identity its events carry', async () => {
    candidates = [
      { block_height: 500, event_index: 1, mine: true },
      { block_height: 499, event_index: 2, mine: false },
      { block_height: 498, event_index: 3, mine: true },
    ]
    const rows = await getPoolSwaps(1_000_042, MEMBERS, 'xyk', 5)

    expect(rows.map(r => r.blockHeight)).toEqual([500, 498])
    // The predicate is the account the registry holds for this share token — never a
    // poolId, which an XYK event does not carry at all.
    expect(identityQueries[0].query).toContain(`JSONExtractString(args_json, 'pool')`)
    expect(identityQueries[0].query).not.toContain('poolId')
    expect(identityQueries[0].params?.poolAccount).toBe(POOL_ACCOUNT)
  })

  it('confirms a stableswap pool by its poolId', async () => {
    candidates = [{ block_height: 500, event_index: 1, mine: true }]
    await getPoolSwaps(690, MEMBERS, 'stableswap', 5)

    expect(identityQueries[0].query).toContain(`JSONExtractInt(args_json, 'poolId')`)
    expect(identityQueries[0].params?.poolId).toBe(690)
  })

  // Two pools can share the pin asset, so the candidate read returns both pools' hops.
  // If identity were applied after one LIMIT, a page full of the sibling's swaps would
  // report this pool as having traded nothing.
  it('keeps walking past a page that holds only another pools swaps', async () => {
    candidates = [
      ...Array.from({ length: 240 }, (_, i) => ({ block_height: 1_000 - i, event_index: 1, mine: false })),
      ...Array.from({ length: 5 }, (_, i) => ({ block_height: 700 - i, event_index: 1, mine: true })),
    ]
    const rows = await getPoolSwaps(1_000_043, MEMBERS, 'xyk', 5)

    expect(rows).toHaveLength(5)
    expect(rows.map(r => r.blockHeight)).toEqual([700, 699, 698, 697, 696])
    expect(identityQueries.length).toBeGreaterThan(1)   // it took more than one page
  })

  // A re-ingested range holds the same swap twice until the parts merge.
  it('renders a replayed swap once', async () => {
    candidates = [
      { block_height: 500, event_index: 1, mine: true },
      { block_height: 500, event_index: 1, mine: true },
      { block_height: 499, event_index: 4, mine: true },
    ]
    const rows = await getPoolSwaps(1_000_044, MEMBERS, 'xyk', 25)

    expect(rows.map(r => `${r.blockHeight}:${r.eventIndex}`)).toEqual(['500:1', '499:4'])
  })

  it('says nothing rather than guessing when the registry has no account for the pool', async () => {
    candidates = [{ block_height: 500, event_index: 1, mine: true }]
    initExplorerService({
      query: async () => ({ json: async () => [] }),
    } as unknown as ClickHouseClient)

    expect(await getPoolSwaps(1_000_045, MEMBERS, 'xyk', 5)).toEqual([])
  })
})
