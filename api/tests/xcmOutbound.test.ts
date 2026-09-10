import { describe, expect, it } from 'vitest'
import { parseOutboundXcm, xcmLegAssets } from '../src/services/explorerService.ts'

// Outbound XCM is represented by both the legacy XTokens event and the nested
// pallet_xcm message shape.
const LEGACY_SENDER = `0x${'11'.repeat(32)}`
const SENT_SENDER = `0x${'22'.repeat(32)}`

const XTOKENS = {
  sender: LEGACY_SENDER,
  assets: [{ id: { parents: 1, interior: { __kind: 'X3', value: [{ __kind: 'Parachain', value: 1000 }, { __kind: 'PalletInstance', value: 50 }, { __kind: 'GeneralIndex', value: '1337' }] } }, fun: { __kind: 'Fungible', value: '1000' } }],
  fee: { id: {}, fun: { __kind: 'Fungible', value: '1000' } },
  dest: { parents: 1, interior: { __kind: 'X2', value: [{ __kind: 'Parachain', value: 1000 }, { id: LEGACY_SENDER, __kind: 'AccountId32' }] } },
}

// DOT to AssetHub via pallet_xcm.
const SENT = {
  origin: { parents: 0, interior: { __kind: 'X1', value: [{ network: { __kind: 'Polkadot' }, id: SENT_SENDER, __kind: 'AccountId32' }] } },
  destination: { parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 1000 }] } },
  message: [
    { __kind: 'WithdrawAsset', value: [{ id: { parents: 1, interior: { __kind: 'Here' } }, fun: { __kind: 'Fungible', value: '2000' } }] },
    { __kind: 'ClearOrigin' },
    { fees: { id: { parents: 1, interior: { __kind: 'Here' } }, fun: { __kind: 'Fungible', value: '2000' } }, weightLimit: { __kind: 'Unlimited' }, __kind: 'BuyExecution' },
    { assets: { __kind: 'Wild', value: { __kind: 'AllCounted', value: 1 } }, beneficiary: { parents: 0, interior: { __kind: 'X1', value: [{ id: SENT_SENDER, __kind: 'AccountId32' }] } }, __kind: 'DepositAsset' },
  ],
  messageId: `0x${'33'.repeat(32)}`,
}

// The pre-MessageQueue-migration event name, XTokens.TransferredMultiAssets, carries
// the same sender/assets/fee/dest payload in the era's own MultiLocation encoding.
// This is the verbatim args_json of Hydration's oldest such event (block 1,675,796):
// DOT (parents:1, Here) to Acala (2000), with the V1 junction's nested network field.
const XTOKENS_MULTI_V1 = {
  sender: `0x${'f4'.repeat(32)}`,
  assets: [{ id: { __kind: 'Concrete', value: { parents: 1, interior: { __kind: 'Here' } } }, fun: { __kind: 'Fungible', value: '200000000' } }],
  fee: { id: { __kind: 'Concrete', value: { parents: 1, interior: { __kind: 'Here' } } }, fun: { __kind: 'Fungible', value: '200000000' } },
  dest: { parents: 1, interior: { __kind: 'X2', value: [{ __kind: 'Parachain', value: 2000 }, { network: { __kind: 'Any' }, id: `0x${'f4'.repeat(32)}`, __kind: 'AccountId32' }] } },
}

describe('parseOutboundXcm', () => {
  it('parses the legacy XTokens.TransferredAssets shape', () => {
    const p = parseOutboundXcm(XTOKENS)!
    expect(p.sender).toBe(LEGACY_SENDER)
    expect(p.amounts).toEqual(['1000'])
    expect(p.dest.destParachainId).toBe(1000)
  })

  it('parses the pre-migration XTokens.TransferredMultiAssets V1 shape', () => {
    const p = parseOutboundXcm(XTOKENS_MULTI_V1)!
    expect(p.sender).toBe(`0x${'f4'.repeat(32)}`)
    expect(p.amounts).toEqual(['200000000'])
    expect(p.dest.destParachainId).toBe(2000)
    expect(p.dest.destAccount?.accountId).toBe(`0x${'f4'.repeat(32)}`)
  })

  it('parses the PolkadotXcm.Sent shape: sender from the origin junction, amounts from the message', () => {
    const p = parseOutboundXcm(SENT)!
    expect(p.sender).toBe(SENT_SENDER)
    // WithdrawAsset only — the BuyExecution fee (same funds) must not double up.
    expect(p.amounts).toEqual(['2000'])
    expect(p.dest.destParachainId).toBe(1000)
  })

  it('resolves a relay (parents:1, Here) destination for Sent', () => {
    const p = parseOutboundXcm({ ...SENT, destination: { parents: 1, interior: { __kind: 'Here' } } })!
    expect(p.dest.destChain).toBe('Polkadot')
    expect(p.dest.destParachainId).toBeNull()
  })

  it('handles the single-object X1 junction encoding (XCM v3)', () => {
    const p = parseOutboundXcm({
      ...SENT,
      origin: { parents: 0, interior: { __kind: 'X1', value: { id: SENT_SENDER, __kind: 'AccountId32' } } },
    })!
    expect(p.sender).toBe(SENT_SENDER)
  })

  it('returns null for chain-originated messages (origin: Here) and unknown shapes', () => {
    expect(parseOutboundXcm({ ...SENT, origin: { parents: 0, interior: { __kind: 'Here' } } })).toBeNull()
    expect(parseOutboundXcm({})).toBeNull()
    expect(parseOutboundXcm(null)).toBeNull()
  })
})

// The message states amounts; only the extrinsic's own withdrawals say which asset
// each leg was. One withdrawal backs one leg — matching by amount alone lost a leg
// whenever a send carried two assets in the same amount.
describe('xcmLegAssets', () => {
  const USDC = 22
  const USDT = 10
  const wd = (assetId: number, amount: string) => ({ assetId, amount })

  it('gives two legs of the SAME amount their own asset each', () => {
    // The Polkadot Treasury's standing payout: 5,000 USDC + 5,000 USDT to AssetHub,
    // both legs 5000000000, which collapsed to one row carrying one asset.
    expect(xcmLegAssets(['5000000000', '5000000000'], [
      wd(USDC, '5000000000'),
      wd(USDT, '5000000000'),
    ])).toEqual([USDC, USDT])
  })

  it('matches legs of different amounts to their own withdrawals, in any order', () => {
    expect(xcmLegAssets(['200', '100'], [wd(USDC, '100'), wd(USDT, '200')])).toEqual([USDT, USDC])
  })

  it('leaves a leg with no withdrawal left to claim unresolved', () => {
    expect(xcmLegAssets(['100', '100'], [wd(USDC, '100')])).toEqual([USDC, null])
    expect(xcmLegAssets(['100'], [])).toEqual([null])
  })

  it('does not let one withdrawal stand for legs of a different amount', () => {
    expect(xcmLegAssets(['100'], [wd(USDC, '999')])).toEqual([null])
  })
})

// XTokens names one transferred leg as the fee item, and it is recognised by its
// AMOUNT — so it can only be told apart when that amount is unique among the legs.
describe('parseOutboundXcm: multi-currency sends', () => {
  const leg = (amount: string) => ({ id: {}, fun: { __kind: 'Fungible', value: amount } })
  const send = (amounts: string[], feeAmount: string) => ({
    sender: LEGACY_SENDER,
    assets: amounts.map(leg),
    fee: leg(feeAmount),
    dest: { parents: 1, interior: { __kind: 'X2', value: [{ __kind: 'Parachain', value: 1000 }, { id: LEGACY_SENDER, __kind: 'AccountId32' }] } },
  })

  // The Polkadot Treasury pays AssetHub 5,000 USDC + 5,000 USDT: two legs, one
  // amount. Folding them lost a leg, and calling either one the fee would book a
  // $5,000 transfer as a delivery charge.
  it('keeps both legs of an equal-amount pair and reports no fee', () => {
    const parsed = parseOutboundXcm(send(['5000000000', '5000000000'], '5000000000'))
    expect(parsed?.amounts).toEqual(['5000000000', '5000000000'])
    expect(parsed?.fee).toBeNull()
  })

  // The MRL shape this rule was written for is untouched: distinct amounts, so the
  // fee item is identifiable and stops being a transfer of its own.
  it('still separates a fee leg whose amount is unique', () => {
    const parsed = parseOutboundXcm(send(['1000000000000000000', '250000000'], '250000000'))
    expect(parsed?.amounts).toEqual(['1000000000000000000'])
    expect(parsed?.fee).toEqual({ amount: '250000000' })
  })

  // A single-leg send transfers and pays out of the same asset.
  it('leaves a single leg as payload with no fee', () => {
    const parsed = parseOutboundXcm(send(['777'], '777'))
    expect(parsed?.amounts).toEqual(['777'])
    expect(parsed?.fee).toBeNull()
  })
})
