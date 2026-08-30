import { describe, expect, it, vi } from 'vitest'
import { RARE_EVENT_REORG_MARGIN_BLOCKS, RareEventLedger, mergeRareEventWindow, rareEventKey } from '../src/services/rareEventLedger.ts'

// A ledger answers "every row of this family" from memory plus a tail read above
// a settled floor. What must hold for that to stay exact: the floor trails the
// head by the reorg margin, never moves backwards, rows above it are never kept
// (they are re-read while they can still change), and a replayed copy of a row
// replaces the earlier one instead of duplicating it.

type Row = { block_height: number; event_index: number; v?: string }
const row = (block: number, index = 0, v?: string): Row => ({ block_height: block, event_index: index, ...(v ? { v } : {}) })

describe('mergeRareEventWindow', () => {
  it('settles rows up to head minus the margin and keeps the rest unsettled', () => {
    const head = 10_000
    const fresh = [row(100), row(head - RARE_EVENT_REORG_MARGIN_BLOCKS), row(head - RARE_EVENT_REORG_MARGIN_BLOCKS + 1), row(head)]
    const { next, all } = mergeRareEventWindow<Row>(null, fresh, head)
    expect(next.upTo).toBe(head - RARE_EVENT_REORG_MARGIN_BLOCKS)
    expect([...next.rows.values()].map(r => r.block_height)).toEqual([100, head - RARE_EVENT_REORG_MARGIN_BLOCKS])
    // The answer is the whole family regardless of what was settled.
    expect(all.map(r => r.block_height)).toEqual([100, head - RARE_EVENT_REORG_MARGIN_BLOCKS, head - RARE_EVENT_REORG_MARGIN_BLOCKS + 1, head])
  })

  it('merges the settled set with the tail, oldest first, tie-broken by event index', () => {
    const settled = { upTo: 500, rows: new Map([[rareEventKey(row(300, 2)), row(300, 2)], [rareEventKey(row(300, 1)), row(300, 1)]]) }
    const { all } = mergeRareEventWindow<Row>(settled, [row(900, 0), row(700, 5)], 2_000)
    expect(all.map(r => `${r.block_height}:${r.event_index}`)).toEqual(['300:1', '300:2', '700:5', '900:0'])
  })

  it('never moves the floor backwards when the head reads lower than before', () => {
    const settled = { upTo: 5_000, rows: new Map([[rareEventKey(row(4_000)), row(4_000)]]) }
    const { next } = mergeRareEventWindow<Row>(settled, [], 4_500)
    expect(next.upTo).toBe(5_000)
    expect(next.rows.size).toBe(1)
  })

  it('lets a replayed copy of a row replace the earlier one rather than duplicate it', () => {
    const settled = { upTo: 5_000, rows: new Map([[rareEventKey(row(4_000, 3, 'old')), row(4_000, 3, 'old')]]) }
    const { all } = mergeRareEventWindow<Row>(settled, [row(4_000, 3, 'new')], 9_000)
    expect(all).toEqual([row(4_000, 3, 'new')])
  })
})

describe('RareEventLedger', () => {
  const ledger = (heads: number[], pages: Row[][]) => {
    const query = vi.fn(async ({ query_params }: { query_params: { from: number; names: string[] } }) => ({
      json: async () => pages.shift() ?? [],
      params: query_params,
    }))
    const head = vi.fn(async () => heads.shift() ?? 0)
    const instance = new RareEventLedger<Row>({
      eventNames: ['Council.Voted'],
      columnsSql: 'block_height, event_index',
      head,
      client: () => ({ query } as never),
    })
    return { instance, query }
  }

  it('reads the whole family once, then only the blocks above the settled floor', async () => {
    // 9,900 sits inside the reorg margin of a 10,000 head, so it is not settled by
    // the first read and the second tail read returns it again.
    const { instance, query } = ledger([10_000, 10_100], [[row(100), row(9_900)], [row(9_900), row(10_050)]])
    expect((await instance.rows()).map(r => r.block_height)).toEqual([100, 9_900])
    expect(query.mock.calls[0][0].query_params.from).toBe(-1)
    expect((await instance.rows()).map(r => r.block_height)).toEqual([100, 9_900, 10_050])
    // The second read starts where the first settled: head − margin.
    expect(query.mock.calls[1][0].query_params.from).toBe(10_000 - RARE_EVENT_REORG_MARGIN_BLOCKS)
    expect(query.mock.calls[1][0].query_params.names).toEqual(['Council.Voted'])
  })

  it('shares one read between concurrent callers', async () => {
    const { instance, query } = ledger([10_000], [[row(100)]])
    const [a, b] = await Promise.all([instance.rows(), instance.rows()])
    expect(a).toEqual(b)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
