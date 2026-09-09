import { describe, expect, it } from 'vitest'
import {
  aliasStateFromSnapshot,
  buildRepairedPriceRows,
  canonicalAssetId,
  chunked,
  decodeBlockTrades,
  parseArgs,
  resolveRange,
  rowsForTrade,
  type AliasState,
  type DecodedTrade,
  type PriceVolumeRow,
} from '../../src/scripts/repair-volume.ts'
import type { ClickHouseClient } from '../../src/db/client.ts'
import type { PriceRow } from '../../src/db/schema.ts'

type ExistingPriceRowFixture = PriceRow & {
  block_timestamp: string
  native_volume_buy: string
  native_volume_sell: string
  usd_volume_buy: string
  usd_volume_sell: string
  hops: number
}

describe('volume repair helpers', () => {
  // The repair walks raw rows the way the live extractor walks a block's
  // events: a routed Omnipool trade's two hub hops fold back into one trade, so
  // the repaired history books H2O only where H2O was actually traded.
  it('folds the hub hops of each block before making rows, block by block', () => {
    const swapped = (block_height: number, swapper: string, input: [number, string], output: [number, string]) => ({
      block_height,
      event_name: 'Broadcast.Swapped3',
      args_json: JSON.stringify({
        swapper, fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
        inputs: [{ asset: input[0], amount: input[1] }], outputs: [{ asset: output[0], amount: output[1] }],
      }),
    })
    const trades = decodeBlockTrades([
      swapped(100, '0xalice', [5, '1000'], [1, '700']),
      swapped(100, '0xalice', [1, '697'], [10, '2000']),
      swapped(100, '0xrouter', [1, '1040'], [0, '731']),
      // The next block's out-of-hub hop must not pair with anything here.
      swapped(101, '0xalice', [0, '50'], [1, '3']),
    ])
    expect(trades.map(t => [t.blockHeight, t.trade.account, t.trade.inputs.map(l => l.assetId), t.trade.outputs.map(l => l.assetId)])).toEqual([
      [100, '0xalice', [5], [10]],
      [100, '0xrouter', [1], [0]],
      [101, '0xalice', [0], [1]],
    ])
  })

  // A chunk's block list rides to ClickHouse as an HTTP query parameter, which
  // the server caps at 128 KiB: a busy 20,000-block chunk names more blocks than
  // fit. Key lists are therefore sent in slices.
  it('slices a key list into bounded batches, in order and without loss', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunked([1, 2], 5)).toEqual([[1, 2]])
    expect(chunked([], 3)).toEqual([])
  })

  it('builds generic canonical asset aliases from raw snapshots', () => {
    const aliases = aliasStateFromSnapshot(JSON.stringify({
      assets: {
        items: [
          { assetId: 5, decimals: 10 },
          { assetId: 1001, decimals: 10 },
          { assetId: 690, decimals: 18 },
          { assetId: 69, decimals: 18 },
        ],
        atoken_equivalences: [[5, 1001]],
        lp_equivalences: [[690, 69]],
      },
    }))

    expect(canonicalAssetId(1001, aliases)).toBe(5)
    expect(canonicalAssetId(690, aliases)).toBe(69)
    expect(aliases.decimals.get(1001)).toBe(10)
  })

  it('infers LP aliases from snapshot asset symbols when explicit equivalences are absent', () => {
    const aliases = aliasStateFromSnapshot(JSON.stringify({
      assets: {
        items: [
          { assetId: 69, symbol: 'GDOT', decimals: 18 },
          { assetId: 690, symbol: '2-Pool-GDOT', decimals: 18 },
        ],
        atoken_equivalences: [],
        lp_equivalences: [],
      },
    }))

    expect(canonicalAssetId(690, aliases)).toBe(69)
  })

  it('skips wrapper self-conversions before account and price aggregation', () => {
    const aliases: AliasState = {
      atokenToBase: new Map([[1001, 5]]),
      lpToDisplay: new Map(),
      decimals: new Map([
        [5, 10],
        [1001, 10],
        [10, 6],
      ]),
    }
    const prices = new Map([
      ['123:5', '2.000000000000'],
      ['123:1001', '2.000000000000'],
      ['123:10', '1.000000000000'],
    ])
    const wrap: DecodedTrade = {
      account: 'alice',
      inputs: [{ assetId: 5, amount: 1_000_000_0000n }],
      outputs: [{ assetId: 1001, amount: 1_000_000_0000n }],
    }
    const swap: DecodedTrade = {
      account: 'alice',
      inputs: [{ assetId: 1001, amount: 1_000_000_0000n }],
      outputs: [{ assetId: 10, amount: 20_000_000n }],
    }

    const first = rowsForTrade(wrap, 123, aliases, prices)
    const second = rowsForTrade(swap, 123, aliases, prices)

    expect(first.tradeRows).toEqual([])
    expect(first.priceRows).toEqual([])
    expect(second.tradeRows).toHaveLength(2)
    expect(second.tradeRows[0]).toMatchObject({
      asset_id: 5,
      native_volume_sell: '10000000000',
      usd_volume_sell: '2.000000000000',
      native_volume_buy: '0',
      usd_volume_buy: '0.000000000000',
    })
    expect(second.tradeRows[1]).toMatchObject({
      asset_id: 10,
      native_volume_buy: '20000000',
      usd_volume_buy: '20.000000000000',
    })
  })

  it('falls back to canonical prices for priced wrapper repair rows', () => {
    const aliases: AliasState = {
      atokenToBase: new Map(),
      lpToDisplay: new Map([[690, 69]]),
      decimals: new Map([
        [69, 18],
        [690, 18],
        [10, 6],
      ]),
    }
    const prices = new Map([
      ['123:69', '1.250000000000'],
      ['123:10', '1.000000000000'],
    ])
    const trade: DecodedTrade = {
      account: 'alice',
      inputs: [{ assetId: 690, amount: 2_000_000_000_000_000_000n }],
      outputs: [{ assetId: 10, amount: 2_500_000n }],
    }

    const result = rowsForTrade(trade, 123, aliases, prices)

    expect(result.tradeRows[0]).toMatchObject({
      asset_id: 69,
      native_volume_sell: '2000000000000000000',
      usd_volume_sell: '2.500000000000',
    })
    expect(result.priceRows[0]).toMatchObject({
      asset_id: 69,
      native_volume_sell: '2000000000000000000',
      usd_volume_sell: '2.500000000000',
    })
  })

  it('clears stale price volumes when a touched priced key has no corrected volume', () => {
    const existing: ExistingPriceRowFixture[] = [{
      asset_id: 5,
      block_height: 123,
      block_timestamp: '2026-06-21 00:00:00',
      usd_price: '2.000000000000',
      native_volume_buy: '10000000000',
      native_volume_sell: '10000000000',
      usd_volume_buy: '2.000000000000',
      usd_volume_sell: '2.000000000000',
      hops: 0,
    }]
    const corrected: PriceVolumeRow[] = []

    expect(buildRepairedPriceRows(existing, corrected)).toEqual([{
      asset_id: 5,
      block_height: 123,
      block_timestamp: '2026-06-21 00:00:00',
      usd_price: '2.000000000000',
      native_volume_buy: '0',
      native_volume_sell: '0',
      usd_volume_buy: '0.000000000000',
      usd_volume_sell: '0.000000000000',
      hops: 0,
    }])
  })

  // A scoped repair only writes the targeted assets' rows, so a leg of some
  // other asset that has no indexed price is booked unpriced and never counted
  // as a problem — its row is discarded anyway.
  it('values only the targeted assets when the repair is scoped', () => {
    // Asset 4200 has neither a price nor snapshot decimals here — the two
    // things a valuation demands and an out-of-scope leg may lack.
    const aliases: AliasState = { atokenToBase: new Map(), lpToDisplay: new Map(), decimals: new Map([[1, 12]]) }
    const prices = new Map([['123:1', '5.000000000000']])
    const trade: DecodedTrade = {
      account: 'alice',
      inputs: [{ assetId: 1, amount: 1_000_000_000_000n }],
      outputs: [{ assetId: 4200, amount: 7n }],
    }

    const scoped = rowsForTrade(trade, 123, aliases, prices, new Set([1]))
    expect(scoped.unpricedLegs).toBe(0)
    expect(scoped.priceRows.find(row => row.asset_id === 1)).toMatchObject({ native_volume_sell: '1000000000000', usd_volume_sell: '5.000000000000' })
    expect(scoped.priceRows.find(row => row.asset_id === 4200)).toMatchObject({ native_volume_buy: '7', usd_volume_buy: '0.000000000000' })
    expect(rowsForTrade(trade, 123, aliases, new Map([...prices, ['123:4200', '1.000000000000']]), new Set([1])).priceRows).toHaveLength(2)
  })

  // The live extractor books a leg whose asset has no price at event time as
  // no USD volume, and the live writer keeps no price row for it (a row priced
  // at 0 would put a 0 low into every candle of its bucket). A repair of that
  // block writes exactly what the live path wrote — nothing for the leg — and
  // says so, since a run that skips thousands of legs is a broken price load,
  // not a gap. H2O had exactly such a gap (blocks 13,029,404–13,033,543,
  // 2026-07-06 23:50 to 07-07 08:00), which is what aborted the first repair.
  it('books nothing for a targeted leg without an event-time price, like the live extractor, and reports it', () => {
    const aliases: AliasState = { atokenToBase: new Map(), lpToDisplay: new Map(), decimals: new Map([[1, 12], [0, 12]]) }
    const prices = new Map([['123:0', '0.010000000000']])
    const trade: DecodedTrade = {
      account: 'router',
      inputs: [{ assetId: 1, amount: 1_040_000_000_000n }],
      outputs: [{ assetId: 0, amount: 1_159_565_575_244_418n }],
    }

    const rows = rowsForTrade(trade, 123, aliases, prices, new Set([1]))
    expect(rows.unpricedLegs).toBe(1)
    // No price row for H2O at all — not a zero-priced one.
    expect(rows.priceRows.find(row => row.asset_id === 1)).toBeUndefined()
    // The counterparty leg was never in scope; its row carries on as before.
    expect(rows.priceRows.find(row => row.asset_id === 0)).toMatchObject({ native_volume_buy: '1159565575244418' })
    // The account's own ledger keeps the native amount, unpriced, as live does.
    expect(rows.tradeRows.find(row => row.asset_id === 1)).toMatchObject({ native_volume_sell: '1040000000000', usd_volume_sell: '0.000000000000' })

    // Missing decimals are the same kind of gap.
    const noDecimals: AliasState = { atokenToBase: new Map(), lpToDisplay: new Map(), decimals: new Map([[0, 12]]) }
    expect(rowsForTrade(trade, 123, noDecimals, new Map([...prices, ['123:1', '5.000000000000']]), new Set([1])).unpricedLegs).toBe(1)

    // An unscoped repair holds every leg to the same rule rather than aborting.
    const unscoped = rowsForTrade(trade, 123, aliases, prices)
    expect(unscoped.unpricedLegs).toBe(1)
    expect(unscoped.priceRows.map(row => row.asset_id)).toEqual([0])
  })

  it('fails when corrected volume has no positive indexed price', () => {
    const existing: ExistingPriceRowFixture[] = [{
      asset_id: 5,
      block_height: 123,
      block_timestamp: '2026-06-21 00:00:00',
      usd_price: '0',
      native_volume_buy: '10000000000',
      native_volume_sell: '0',
      usd_volume_buy: '0.000000000000',
      usd_volume_sell: '0.000000000000',
      hops: 0,
    }]
    const corrected: PriceVolumeRow[] = [{
      asset_id: 5,
      block_height: 123,
      native_volume_buy: '10000000000',
      native_volume_sell: '0',
      usd_volume_buy: '0.000000000000',
      usd_volume_sell: '0.000000000000',
    }]

    expect(() => buildRepairedPriceRows(existing, corrected)).toThrow('without a positive indexed USD price')
  })

  it('defaults --from-block repairs through the current safe tip', async () => {
    const client = {
      query: () => ({
        json: async () => [{ max_block: 1000 }],
      }),
    } as unknown as ClickHouseClient

    await expect(resolveRange(client, parseArgs(['--from-block=900']))).resolves.toEqual({
      from: 900,
      to: 900,
      safeTip: 900,
    })
  })

  it('parses asset filters for scoped repair runs', () => {
    const args = parseArgs(['--from-block=123', '--asset-ids=34,20,34'])

    expect([...(args.assetIds ?? [])]).toEqual([34, 20])
  })

  it('forces the ohlc target back on when --skip-ohlc is combined with an explicit prices target', () => {
    const args = parseArgs(['--from-block=123', '--targets=prices', '--skip-ohlc'])

    expect([...args.targets].sort()).toEqual(['ohlc', 'prices'])
  })

  it('forces the ohlc target back on when --skip-ohlc is combined with the default targets', () => {
    const args = parseArgs(['--from-block=123', '--skip-ohlc'])

    expect([...args.targets].sort()).toEqual(['ohlc', 'prices', 'trade-volume'])
  })

  it('honors --skip-ohlc when prices are not among the requested targets', () => {
    const args = parseArgs(['--from-block=123', '--targets=trade-volume', '--skip-ohlc'])

    expect([...args.targets]).toEqual(['trade-volume'])
  })
})

describe('volume repair: Uniswap v3 pool swaps', () => {
  const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
  const pools = new Map([[POOL, { token0AssetId: 1001, token1AssetId: 222 }]])
  const swapRow = (block_height: number, extrinsic_index: number) => ({
    block_height,
    extrinsic_index,
    event_name: 'EVM.Log',
    args_json: JSON.stringify({
      log: {
        address: POOL,
        topics: [
          '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
          '0x0000000000000000000000005a79de848626994c4099640ef5c48fd65dae4159',
          '0x0000000000000000000000006e896769ddecd994f63e5772218a820918e0ff6f',
        ],
        data: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffe6dbabd300000000000000000000000000000000000000000000000000a411a5b06516450000000000000000000000000000000000002a5f9ddcd191e225a5b8b880afcb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002d5f3',
      },
    }),
  })
  const routedRow = (block_height: number, extrinsic_index: number) => ({
    block_height,
    extrinsic_index,
    event_name: 'Broadcast.Swapped3',
    args_json: JSON.stringify({
      swapper: '0xrouted', fillerType: { __kind: 'UniswapV3' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 222, amount: '46181299507238469' }], outputs: [{ asset: 1001, amount: '421811245' }],
    }),
  })

  // The repair reads the same raw rows the live extractor saw as events, so a
  // pool's Swap log is a trade of the recipient — and is dropped when the
  // extrinsic's Broadcast fill already booked the hop.
  it('decodes a direct swap from its EVM.Log row and skips the log of a routed one', () => {
    const trades = decodeBlockTrades([
      swapRow(14395782, 4),
      swapRow(14395790, 2), routedRow(14395790, 2),
      swapRow(14395791, 2), routedRow(14395791, 3),
    ], pools)
    expect(trades.map(t => [t.blockHeight, t.trade.account, t.trade.filler, t.trade.inputs, t.trade.outputs])).toEqual([
      [14395782, '0x455448006e896769ddecd994f63e5772218a820918e0ff6f0000000000000000', 'UniswapV3', [{ assetId: 222, amount: 46181299507238469n }], [{ assetId: 1001, amount: 421811245n }]],
      [14395790, '0xrouted', 'UniswapV3', [{ assetId: 222, amount: 46181299507238469n }], [{ assetId: 1001, amount: 421811245n }]],
      [14395791, '0x455448006e896769ddecd994f63e5772218a820918e0ff6f0000000000000000', 'UniswapV3', [{ assetId: 222, amount: 46181299507238469n }], [{ assetId: 1001, amount: 421811245n }]],
      [14395791, '0xrouted', 'UniswapV3', [{ assetId: 222, amount: 46181299507238469n }], [{ assetId: 1001, amount: 421811245n }]],
    ])
  })

  it('ignores EVM.Log rows without a pool index', () => {
    expect(decodeBlockTrades([swapRow(14395782, 4)])).toEqual([])
  })
})
