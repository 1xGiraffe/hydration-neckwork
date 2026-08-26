import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { hookActivityOwnsBlockTransfers, otcRowFromEvent, suppressSubordinateActivityRows, type ActivityRow, type OtcPlacedLeg, type PriceInfo } from '../src/services/explorerService.ts'

// The OTC pallet names at most one side of an order. Placed and Cancelled carry
// no account at all, and Filled/PartiallyFilled carry only the taker — so the
// account the order BELONGS to reached no row, and a fill of it reached the
// maker's feed nowhere (its settlement legs are suppressed as plumbing on both
// sides). The order's maker, resolved from the reserve taken at placement, is
// what these rows now carry.
//
// Shapes are the real ones: order #1548, a treasury-placed HOLLAR order that no
// extrinsic signed, and its partial fill at block 13,825,116.
const MAKER = '0x08668d9785b8ab9246b45cbf26998563eac007d24e8ad55ad779b659da6b7a9a'
const TAKER = '0x5c39bc7e1369574b5e906331af8a7ee5cadccbd7dd555d54547027f5101fb922'
const SIGNER = '0xee92a79760d0480aab1a940b0abab817dfcde83655e4d2c71682ce272b26ef0a'

const prices = new Map<number, PriceInfo>()
const legs = (over: Partial<OtcPlacedLeg> = {}): OtcPlacedLeg => ({
  assetIn: 1_001_351, assetOut: 1_001_353,
  amountIn: '452563222222222222222222', amountOut: '463292880801654013221745',
  partiallyFillable: true, maker: MAKER,
  ...over,
})
const placedById = (leg = legs()) => new Map<string, OtcPlacedLeg>([['1548', leg]])

const event = (event_name: string, args: Record<string, unknown>, extrinsic_index: number | null = 2) => ({
  block_height: 13_825_116, ts: '2026-08-26 12:00:00', event_index: 53, extrinsic_index, event_name,
  args_json: JSON.stringify(args),
})

const placedArgs = {
  orderId: 1548, assetIn: 1_001_351, assetOut: 1_001_353,
  amountIn: '452563222222222222222222', amountOut: '463292880801654013221745', partiallyFillable: true,
}
const fillArgs = {
  orderId: 1548, who: TAKER,
  amountIn: '35803449399249999999', amountOut: '36652300497078009515', fee: '36652300497078010',
}

describe('otcRowFromEvent — a fill names both parties', () => {
  it('keeps the taker as the actor and adds the maker as the counterparty', () => {
    const row = otcRowFromEvent(event('OTC.PartiallyFilled', fillArgs), prices, placedById())
    expect(row?.otcAction).toBe('Fill')
    expect(row?.otcPartial).toBe(true)
    expect(row?.who?.accountId).toBe(TAKER)
    expect(row?.to?.accountId).toBe(MAKER)
  })

  it('leaves the counterparty null when the order could not be resolved', () => {
    // A fill whose Placed row is outside the indexed window renders without
    // legs today; it must not invent an owner either.
    const row = otcRowFromEvent(event('OTC.Filled', fillArgs), prices, new Map())
    expect(row?.who?.accountId).toBe(TAKER)
    expect(row?.to).toBeNull()
    expect(row?.otcPartial).toBe(false)
  })
})

describe('otcRowFromEvent — place and pull belong to the order owner', () => {
  it('uses the maker even when no extrinsic signed the placement', () => {
    // The 33 governance-dispatched placements: extrinsic_index NULL, so there
    // is no signer to fall back to and the row used to carry no account.
    const row = otcRowFromEvent(event('OTC.Placed', placedArgs, null), prices, placedById())
    expect(row?.otcAction).toBe('Place')
    expect(row?.who?.accountId).toBe(MAKER)
  })

  it('prefers the maker over the submitting signer', () => {
    // A multisig placement: the order belongs to the multisig, the signer is
    // whichever member submitted the final approval.
    const row = otcRowFromEvent(event('OTC.Placed', placedArgs), prices, placedById(), { signerFallback: SIGNER })
    expect(row?.who?.accountId).toBe(MAKER)
  })

  it('falls back to the signer when the order resolved no maker', () => {
    const row = otcRowFromEvent(event('OTC.Placed', placedArgs), prices, placedById(legs({ maker: null })), { signerFallback: SIGNER })
    expect(row?.who?.accountId).toBe(SIGNER)
  })

  it('gives a pull the same owner, and the order legs it has no fields for', () => {
    const row = otcRowFromEvent(event('OTC.Cancelled', { orderId: 1548 }, null), prices, placedById())
    expect(row?.otcAction).toBe('Pull')
    expect(row?.who?.accountId).toBe(MAKER)
    // Maker perspective: the order pays its assetOut and asks for its assetIn.
    expect(row?.assetIn?.assetId).toBe(1_001_353)
    expect(row?.assetOut?.assetId).toBe(1_001_351)
  })
})

describe('suppressSubordinateActivityRows — what an OTC row owns', () => {
  const row = (over: Partial<ActivityRow>): ActivityRow => ({
    type: 'transfer', blockHeight: 13_719_478, timestamp: '', eventIndex: 0, extrinsicIndex: null,
    who: null, to: null, asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null,
    ...over,
  })
  const maker = { accountId: MAKER, address: MAKER, emoji: '', tag: null, identity: null, profile: null } as unknown as ActivityRow['who']
  const types = (rows: ActivityRow[]) => rows.map(r => r.type)

  it('does not let a hook-context placement swallow a transfer sharing its block', () => {
    // The real pair: three treasury-manager dispatches in block 13,719,478 — one
    // funding the treasury with HOLLAR, three placing orders with it. Both are
    // extrinsic-less, and the funding leg is an action of its own.
    const rows = [
      row({ type: 'otc', otcAction: 'Place', otcOrderId: 1548, who: maker }),
      row({ to: maker, amount: '917152679888412004089323' }),
    ]
    expect(types(suppressSubordinateActivityRows(rows))).toEqual(['otc', 'transfer'])
  })

  it('still lets a hook-context semantic row of another family own its block legs', () => {
    const rows = [row({ type: 'trade', who: maker }), row({ to: maker })]
    expect(types(suppressSubordinateActivityRows(rows))).toEqual(['trade'])
  })

  it('leaves a fill owning its settlement legs through its extrinsic', () => {
    const rows = [
      row({ type: 'otc', otcAction: 'Fill', extrinsicIndex: 2, who: maker }),
      row({ extrinsicIndex: 2, to: maker }),
    ]
    expect(types(suppressSubordinateActivityRows(rows))).toEqual(['otc'])
  })
})

// The exact-count plan mirrors the hook-ownership split when it counts a
// transfer feed. Two copies of the rule is exactly how a total and the page it
// sizes drift apart — here it let the page keep the treasury's funding leg
// while the count dropped it, and the transfer tab lost the row.
describe('hook ownership is one rule, mirrored rather than restated', () => {
  const source = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  const otcRow = (otcAction: 'Place' | 'Pull' | 'Fill'): ActivityRow => ({
    type: 'otc', blockHeight: 1, timestamp: '', eventIndex: 0, extrinsicIndex: null,
    who: null, to: null, asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null,
    otcAction,
  })

  it('gives a placement and a pull no transfers to own, and a fill its own', () => {
    expect(hookActivityOwnsBlockTransfers(otcRow('Place'))).toBe(false)
    expect(hookActivityOwnsBlockTransfers(otcRow('Pull'))).toBe(false)
    expect(hookActivityOwnsBlockTransfers(otcRow('Fill'))).toBe(true)
    expect(hookActivityOwnsBlockTransfers({ ...otcRow('Place'), type: 'trade' })).toBe(true)
  })

  it('builds the plan owner set through that same predicate', () => {
    const at = source.indexOf('const owners = new Set(all.filter(')
    expect(at).toBeGreaterThan(-1)
    expect(source.slice(at, at + 200)).toContain('hookActivityOwnsBlockTransfers(row)')
  })

  it('states the rule in exactly one place', () => {
    expect(source.split("row.type === 'otc' && row.otcAction !== 'Fill'").length - 1).toBe(1)
  })
})
