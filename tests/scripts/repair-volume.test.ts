import { describe, expect, it } from 'vitest'
import {
  aliasStateFromSnapshot,
  buildRepairedPriceRows,
  canonicalAssetId,
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
