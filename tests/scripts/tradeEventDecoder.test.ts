import { describe, expect, it } from 'vitest'
import { decodeRawTrade } from '../../src/scripts/tradeEventDecoder.ts'

function event(eventName: string, args: object) {
  return { block_height: 1, event_name: eventName, args_json: JSON.stringify(args) }
}

describe('trade event decoder', () => {
  it('decodes legacy pool trades', () => {
    expect(decodeRawTrade(event('Omnipool.SellExecuted', {
      who: '0xaccount', assetIn: 0, assetOut: 5, amountIn: '100', amountOut: '200',
    }))).toEqual({
      account: '0xaccount',
      inputs: [{ assetId: 0, amount: 100n }],
      outputs: [{ assetId: 5, amount: 200n }],
    })
  })

  it('decodes nested Broadcast accounts and bigint-compatible amounts', () => {
    expect(decodeRawTrade(event('Broadcast.Swapped2', {
      swapper: { value: '0xaccount' },
      inputs: [{ asset: 0, amount: '100' }],
      outputs: [{ asset: 5, amount: 200 }],
    }))).toEqual({
      account: '0xaccount',
      inputs: [{ assetId: 0, amount: 100n }],
      outputs: [{ assetId: 5, amount: 200n }],
    })
  })

  it('corrects legacy exact-output XYK Broadcast amounts', () => {
    expect(decodeRawTrade(event('Broadcast.Swapped', {
      swapper: '0xaccount',
      fillerType: { __kind: 'XYK' },
      operation: { __kind: 'ExactOut' },
      inputs: [{ asset: 0, amount: '999' }],
      outputs: [{ asset: 5, amount: '123' }],
    }))).toEqual({
      account: '0xaccount',
      inputs: [{ assetId: 0, amount: 123n }],
      outputs: [{ assetId: 5, amount: 999n }],
    })
  })
})
