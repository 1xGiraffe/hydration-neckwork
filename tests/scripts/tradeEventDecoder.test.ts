import { describe, expect, it } from 'vitest'
import { decodeRawTrade, resolveRawOtcSides } from '../../src/scripts/tradeEventDecoder.ts'

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
      fillerAccount: null,
      inputs: [{ assetId: 0, amount: 100n }],
      outputs: [{ assetId: 5, amount: 200n }],
    })
  })

  // The filler kind is what tells an Omnipool hop through the hub asset from a
  // trade in any other pool, so a Broadcast row carries it.
  it('carries the filler kind of a Broadcast trade', () => {
    expect(decodeRawTrade(event('Broadcast.Swapped3', {
      swapper: '0xaccount',
      fillerType: { __kind: 'Omnipool' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: '100' }],
      outputs: [{ asset: 1, amount: '70' }],
    }))).toEqual({
      account: '0xaccount',
      fillerAccount: null,
      filler: 'Omnipool',
      inputs: [{ assetId: 5, amount: 100n }],
      outputs: [{ assetId: 1, amount: 70n }],
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
      fillerAccount: null,
      filler: 'XYK',
      inputs: [{ assetId: 0, amount: 123n }],
      outputs: [{ assetId: 5, amount: 999n }],
    })
  })

  // The Broadcast event of an OTC fill cannot be booked as it stands: its legs are
  // always the taker's direction while `swapper` names the maker in 620 of the 796
  // fills on chain. resolveRawOtcSides puts both accounts on their true sides once
  // the pallet's own fill event has named the taker (src/blocks/otcCounterparty.ts).
  const otcFill = () => decodeRawTrade(event('Broadcast.Swapped3', {
    swapper: '0xmaker', filler: '0xtaker',
    fillerType: { __kind: 'OTC', value: 1587 },
    operation: { __kind: 'ExactIn' },
    inputs: [{ asset: 22, amount: '800000' }],
    outputs: [{ asset: 0, amount: '100000000000000' }],
  }))!

  it('moves an OTC fill onto the taker and mirrors the maker', () => {
    const resolved = resolveRawOtcSides(otcFill(), '0xtaker')
    expect(resolved.account).toBe('0xtaker')
    expect(resolved.counterparty).toBe('0xmaker')
    // The legs are untouched — they already describe the taker.
    expect(resolved.inputs).toEqual([{ assetId: 22, amount: 800000n }])
    expect(resolved.outputs).toEqual([{ assetId: 0, amount: 100000000000000n }])
  })

  // Nothing names the taker, or it is neither account the event names: the fill
  // keeps the booking it had rather than a guess about which side is which.
  it('leaves the fill alone when the taker cannot be matched', () => {
    expect(resolveRawOtcSides(otcFill(), '0xsomeone-else').account).toBe('0xmaker')
    expect(resolveRawOtcSides(otcFill(), null).account).toBe('0xmaker')
    expect(resolveRawOtcSides(otcFill(), null).counterparty).toBeUndefined()
  })

  it('never touches a pool-venue fill', () => {
    const pool = decodeRawTrade(event('Broadcast.Swapped3', {
      swapper: '0xalice', filler: '0xpool',
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 22, amount: '800000' }], outputs: [{ asset: 0, amount: '100000000000000' }],
    }))!
    expect(resolveRawOtcSides(pool, '0xpool').account).toBe('0xalice')
    expect(resolveRawOtcSides(pool, '0xpool').counterparty).toBeUndefined()
  })
})
