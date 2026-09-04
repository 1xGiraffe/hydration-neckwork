import { beforeEach, describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import {
  applyEventTimeUsd,
  chooseEventTimeLeg,
  initExplorerService,
  isPinnedToUsd,
  type PreTradeSpot,
} from '../src/services/explorerService.ts'

// A trade detail is valued at the pre-trade per-block spot of its most reliably
// priced leg. These pin the parts of that rule that must not drift: which leg wins
// and that the choice is direction-free, that the read is strictly PRE-trade, and
// that a stale row is rejected rather than used.

const spot = (priceRaw: string, hops = 0, block = 999): PreTradeSpot => ({ priceRaw, hops, block })

describe('isPinnedToUsd', () => {
  it('accepts a seeded reference and a centred basket member, rejects a depegged stable', () => {
    expect(isPinnedToUsd('1')).toBe(true)
    expect(isPinnedToUsd('1.000000000000')).toBe(true)
    expect(isPinnedToUsd('1.000249269215')).toBe(true) // USDT, centred against USDC
    expect(isPinnedToUsd('0.998721703365')).toBe(true) // HOLLAR at par
    expect(isPinnedToUsd('0.99')).toBe(true)
    expect(isPinnedToUsd('0.989999999999')).toBe(false)
    expect(isPinnedToUsd('0.957549082261')).toBe(false) // DAI in the March-2023 depeg
    expect(isPinnedToUsd('3.443134264038')).toBe(false)
    expect(isPinnedToUsd('0')).toBe(false)
  })
})

describe('chooseEventTimeLeg', () => {
  const dai = { assetId: 2, spot: spot('1') }
  const dot = { assetId: 5, spot: spot('3.443134264038') }

  it('prefers the pinned leg whichever side of the swap it is on', () => {
    expect(chooseEventTimeLeg([dai, dot])?.assetId).toBe(2)
    expect(chooseEventTimeLeg([dot, dai])?.assetId).toBe(2)
  })

  it('prefers the pinned leg even when the floating leg is the Omnipool-direct one', () => {
    const hollarViaHop = { assetId: 222, spot: spot('0.9987', 1) }
    const hdxDirect = { assetId: 0, spot: spot('0.0081', 0) }
    expect(chooseEventTimeLeg([hdxDirect, hollarViaHop])?.assetId).toBe(222)
  })

  it('among floating legs prefers fewer hops, then the fresher row, then the lower asset id', () => {
    const direct = { assetId: 20, spot: spot('2450', 0, 100) }
    const hopped = { assetId: 15, spot: spot('1.44', 1, 100) }
    expect(chooseEventTimeLeg([hopped, direct])?.assetId).toBe(20)

    const fresher = { assetId: 20, spot: spot('2450', 0, 100) }
    const older = { assetId: 5, spot: spot('4.5', 0, 96) }
    expect(chooseEventTimeLeg([older, fresher])?.assetId).toBe(20)

    const hdx = { assetId: 0, spot: spot('0.0043', 0, 100) }
    const dotSame = { assetId: 5, spot: spot('4.57', 0, 100) }
    expect(chooseEventTimeLeg([dotSame, hdx])?.assetId).toBe(0)
    expect(chooseEventTimeLeg([hdx, dotSame])?.assetId).toBe(0)
  })

  it('skips unpriced legs and returns null when no leg is priced', () => {
    expect(chooseEventTimeLeg([{ assetId: 17, spot: null }, dot])?.assetId).toBe(5)
    expect(chooseEventTimeLeg([{ assetId: 17, spot: null }, { assetId: 27, spot: null }])).toBeNull()
  })
})

interface SpotRow { asset_id: number; event_block: number; price_block: number; price_raw: string; hops: number }

// A fake ClickHouse that answers the two reads applyEventTimeUsd issues: the
// pre-trade spot ASOF (near window first, then the far window for misses) and the
// block-timestamp lookup used to bound the far rows.
function fakeClient(rowsFor: (lo: number, hi: number, ids: number[]) => SpotRow[], times: Record<number, number>) {
  const queries: { query: string; params: Record<string, unknown> }[] = []
  const client = {
    query: async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => {
      queries.push({ query, params: query_params })
      return {
        json: async () => {
          if (query.includes('explorer:pre-trade-spot')) {
            return rowsFor(Number(query_params.lo), Number(query_params.hi), query_params.ids as number[])
          }
          if (query.includes('FROM price_data.blocks')) {
            return (query_params.hs as number[]).filter(h => times[h] != null).map(h => ({ block_height: h, ts: times[h] }))
          }
          throw new Error(`Unexpected query: ${query}`)
        },
      }
    },
  } as unknown as ClickHouseClient
  return { client, queries }
}

const DAI_DOT_TRADE = {
  blockHeight: 1_708_547,
  legs: [
    { assetId: 2, decimals: 18, raw: '877673281569645742771' },
    { assetId: 5, decimals: 10, raw: '2434262411217' },
  ],
}

describe('applyEventTimeUsd', () => {
  beforeEach(() => { initExplorerService(undefined as unknown as ClickHouseClient) })

  it('values the swap from its pinned leg exactly and reads strictly below the event block', async () => {
    const { client, queries } = fakeClient((lo, hi) => {
      // The newest rows below the event block: DAI seeded at exactly $1, DOT floating.
      expect(lo).toBe(1_708_547 - 2_000)
      expect(hi).toBe(1_708_547)
      return [
        { asset_id: 2, event_block: 1_708_547, price_block: 1_708_545, price_raw: '1', hops: 0 },
        { asset_id: 5, event_block: 1_708_547, price_block: 1_708_545, price_raw: '3.443134264038', hops: 0 },
      ]
    }, {})
    initExplorerService(client)
    const row = { valueUsd: 641.84 as number | null, ...DAI_DOT_TRADE }
    await applyEventTimeUsd([row], r => ({ block: r.blockHeight, legs: r.legs }))
    expect(row.valueUsd).toBeCloseTo(877.673281569645742771, 6)
    expect(queries).toHaveLength(1)
    // Pre-trade: the event block's own row reflects the pool AFTER the swap.
    expect(queries[0].query).toMatch(/p\.block_height < l\.event_block/)
    expect(queries[0].query).toMatch(/block_height < \{hi:UInt32\}/)
  })

  it('values the mirror image of a swap from the same leg', async () => {
    const rowsFor = () => [
      { asset_id: 2, event_block: 1_709_273, price_block: 1_709_272, price_raw: '1', hops: 0 },
      { asset_id: 5, event_block: 1_709_273, price_block: 1_709_272, price_raw: '4.6', hops: 0 },
    ]
    initExplorerService(fakeClient(rowsFor, {}).client)
    const legs = [
      { assetId: 5, decimals: 10, raw: '500040699426' },
      { assetId: 2, decimals: 18, raw: '250272179241387567507' },
    ]
    const sell = { valueUsd: null as number | null, block: 1_709_273, legs }
    const buy = { valueUsd: null as number | null, block: 1_709_273, legs: [...legs].reverse() }
    await applyEventTimeUsd([sell, buy], r => ({ block: r.block, legs: r.legs }))
    expect(sell.valueUsd).toBeCloseTo(250.272179241387567507, 6)
    expect(buy.valueUsd).toBe(sell.valueUsd)
  })

  it('falls back to the far window for a sparse feed and rejects a row older than the staleness bound', async () => {
    const event = 13_847_575
    const { client, queries } = fakeClient((lo, hi, ids) => {
      if (lo === event - 2_000) {
        // Only HDX ticks in the near window; INTR's feed died at block 9,120,270.
        return [{ asset_id: 0, event_block: event, price_block: event - 1, price_raw: '0.008', hops: 0 }]
      }
      expect(lo).toBe(event - 1_500_000)
      expect(hi).toBe(event)
      expect(ids).toEqual([17])
      return [{ asset_id: 17, event_block: event, price_block: 12_600_000, price_raw: '0.0017', hops: 1 }]
    }, { [event]: 1_756_242_246, [12_600_000]: 1_756_242_246 - 31 * 86_400 })
    initExplorerService(client)
    const row = {
      valueUsd: null as number | null, block: event,
      legs: [
        { assetId: 0, decimals: 12, raw: '5000000000000000' },
        { assetId: 17, decimals: 10, raw: '5127237053930' },
      ],
    }
    await applyEventTimeUsd([row], r => ({ block: r.block, legs: r.legs }))
    // INTR's 31-day-old row is rejected, so the trade values from the HDX leg.
    expect(row.valueUsd).toBeCloseTo(5000 * 0.008, 9)
    expect(queries.map(q => q.query.includes('price_data.blocks'))).toEqual([false, false, true])
  })

  it('keeps a far-window row that is inside the bound', async () => {
    const event = 13_847_575
    const { client } = fakeClient((lo) => lo === event - 2_000
      ? []
      : [{ asset_id: 17, event_block: event, price_block: 13_000_000, price_raw: '0.0017', hops: 1 }],
    { [event]: 1_756_242_246, [13_000_000]: 1_756_242_246 - 29 * 86_400 })
    initExplorerService(client)
    const row = { valueUsd: null as number | null, block: event, legs: [{ assetId: 17, decimals: 10, raw: '5127237053930' }] }
    await applyEventTimeUsd([row], r => ({ block: r.block, legs: r.legs }))
    expect(row.valueUsd).toBeCloseTo(512.7237053930 * 0.0017, 9)
  })

  it('leaves valueUsd null when no leg has a usable price', async () => {
    const event = 13_847_575
    const { client } = fakeClient((lo) => lo === event - 2_000
      ? []
      : [{ asset_id: 17, event_block: event, price_block: 12_600_000, price_raw: '0.0017', hops: 1 }],
    { [event]: 1_756_242_246, [12_600_000]: 1_756_242_246 - 31 * 86_400 })
    initExplorerService(client)
    const row = { valueUsd: 12.5 as number | null, block: event, legs: [{ assetId: 17, decimals: 10, raw: '5127237053930' }, { assetId: 27, decimals: 12, raw: '1' }] }
    await applyEventTimeUsd([row], r => ({ block: r.block, legs: r.legs }))
    expect(row.valueUsd).toBeNull()
  })
})
