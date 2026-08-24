import { describe, expect, it } from 'vitest'
import { deriveFeePayment, type FeePaymentEvent } from '../src/services/extrinsicFeePayment.ts'

// The fee's real asset comes out of the extrinsic's own balance events, so these
// fixtures are the event shapes as indexed, taken from the blocks named on each
// case. What makes them durable is the invariant, not the block: the treasury
// deposit that counts is the LAST one whose currency the payer was also debited
// in, which is what separates a fee from dust, from a pool fee leg, and from
// another account's transfer in the same extrinsic.

const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const PAYER = '0xeed1f96750a86a7a8dab8afdf5f43bd5e77cd2d7c3823be938a4cd5ac8897853'

const withdrawn = (currencyId: number, who: string, amount: string): FeePaymentEvent =>
  ({ name: 'Tokens.Withdrawn', args: { currencyId, who, amount } })
const deposited = (currencyId: number, who: string, amount: string): FeePaymentEvent =>
  ({ name: 'Tokens.Deposited', args: { currencyId, who, amount } })
const nativeWithdraw = (who: string, amount: string): FeePaymentEvent =>
  ({ name: 'Balances.Withdraw', args: { who, amount } })
const nativeDeposit = (who: string, amount: string): FeePaymentEvent =>
  ({ name: 'Balances.Deposit', args: { who, amount } })

describe('deriveFeePayment', () => {
  // 13759746-2, PolkadotXcm.transfer_assets_using_type_and_then: the fee settled
  // in DOT while raw_extrinsics.fee reported 560832600639 (0.5608 HDX). The
  // 36234999126 DOT the call itself moved must not be mistaken for the fee.
  it('reads a DOT fee off the treasury deposit, not the transferred amount', () => {
    const events = [
      withdrawn(5, PAYER, '67211138'),
      { name: 'Currencies.Withdrawn', args: { currencyId: 5, who: PAYER, amount: '67211138' } },
      withdrawn(5, PAYER, '36234999126'),
      deposited(5, TREASURY, '67211138'),
      { name: 'Currencies.Deposited', args: { currencyId: 5, who: TREASURY, amount: '67211138' } },
    ]
    expect(deriveFeePayment(events, PAYER, '560832600639', '0')).toEqual({
      assetId: 5, amount: '67211138', tipAmount: null,
    })
  })

  // 13756091-3, Router.sell. Asset 1 IS an accepted fee currency, so an H2O
  // treasury deposit is a real fee — but only when the payer was debited in H2O.
  it('accepts H2O as a fee currency', () => {
    const events = [
      withdrawn(1, PAYER, '1044760795'),
      deposited(1, '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000', '15561300184'),
      deposited(1, TREASURY, '1044760795'),
    ]
    expect(deriveFeePayment(events, PAYER, '578831684589', '0')?.assetId).toBe(1)
  })

  // The same H2O deposit with no H2O debit from the payer is an Omnipool fee leg
  // reaching the treasury, not this extrinsic's fee.
  it('ignores a treasury deposit in an asset the payer never paid', () => {
    const events = [
      nativeWithdraw(PAYER, '519092313542'),
      deposited(1, TREASURY, '1044760795'),
      nativeDeposit(TREASURY, '519092313542'),
    ]
    expect(deriveFeePayment(events, PAYER, '519092313542', '0')?.assetId).toBe(0)
  })

  // 13706669-3, Balances.transfer_allow_death: the account was killed, so
  // 0.0001 HDX of dust reached the treasury BEFORE the 0.5191 HDX fee. Summing
  // the two would overstate the fee; the fee deposit is the last one, because
  // correct_and_deposit_fee runs after the call's own events.
  it('takes the last treasury deposit, so dust does not inflate the fee', () => {
    const events = [
      nativeWithdraw(PAYER, '519092313542'),
      { name: 'Balances.DustLost', args: { account: PAYER, amount: '100000000' } },
      nativeDeposit(TREASURY, '100000000'),
      nativeDeposit(TREASURY, '519092313542'),
    ]
    expect(deriveFeePayment(events, PAYER, '519092313542', '0')).toEqual({
      assetId: 0, amount: '519092313542', tipAmount: null,
    })
  })

  // 13443355-3, Ethereum.transact: no TransactionFeePaid and no
  // raw_extrinsics.fee, and the extrinsic charged gas three times. A withdrawal
  // by a different ETH-mapped account (a contract's own) stays out of it.
  it('sums every gas deposit when there is no HDX fee figure (EVM)', () => {
    const evmPayer = '0x455448003cc86d5565b76334b5cee4b61ee8e6ad1f514c780000000000000000'
    const events = [
      withdrawn(20, evmPayer, '20866104761240'),
      deposited(20, evmPayer, '1241366916304'),
      deposited(20, TREASURY, '172683883696'),
      withdrawn(1000745, '0x455448001973e7044d9a7c7bb2d6ea1693a296a9e4b7e4480000000000000000', '2726571685210000000000'),
      deposited(20, TREASURY, '1092241118936'),
      deposited(20, TREASURY, '1771379933920'),
    ]
    expect(deriveFeePayment(events, evmPayer, null, null)).toEqual({
      assetId: 20, amount: '3036304936552', tipAmount: null,
    })
  })

  // 13749778-2, EVM.call dispatched Pays::No: actualFee is 0, so nothing was
  // charged on the substrate side and the cost is the gas — which arrives as its
  // own deposit plus a 1-planck remainder. A zero fee is the same shape as a null
  // one; taking only the last deposit would report one planck of BNC.
  it('sums the gas when the substrate fee is zero, not just null', () => {
    const payer = '0x6ee3fd0143fb2218637d42f40c52f5fd9c438829ce249e3ed0b4819c38908532'
    const events = [
      withdrawn(14, payer, '913091057149'),
      withdrawn(14, payer, '1372074068593'),
      deposited(14, payer, '1029817052552'),
      deposited(14, TREASURY, '342257016041'),
      deposited(14, payer, '913091057148'),
      deposited(14, TREASURY, '1'),
    ]
    expect(deriveFeePayment(events, payer, '0', '0')).toEqual({
      assetId: 14, amount: '342257016042', tipAmount: null,
    })
  })

  // The treasury deposit is fee + tip in one event, so the tip is split back out
  // by the tip/(fee+tip) ratio the HDX figures give.
  it('splits the tip out in the paid asset', () => {
    const events = [withdrawn(10, PAYER, '30000'), deposited(10, TREASURY, '30000')]
    // 0.5 HDX fee + 2.5 HDX tip => the tip is 5/6 of the 30000 USDT charged.
    expect(deriveFeePayment(events, PAYER, '500000000000', '2500000000000')).toEqual({
      assetId: 10, amount: '5000', tipAmount: '25000',
    })
  })

  it('is case-insensitive on the payer and matches on the mapped account', () => {
    const events = [withdrawn(10, PAYER.toUpperCase().replace('0X', '0x'), '30000'), deposited(10, TREASURY, '30000')]
    expect(deriveFeePayment(events, PAYER, '1', '0')?.assetId).toBe(10)
  })

  it('yields nothing for an inherent, a fee-free extrinsic, or a zero deposit', () => {
    expect(deriveFeePayment([deposited(10, TREASURY, '30000')], null, '1', '0')).toBeNull()
    expect(deriveFeePayment([withdrawn(10, PAYER, '30000')], PAYER, '1', '0')).toBeNull()
    expect(deriveFeePayment([withdrawn(10, PAYER, '0'), deposited(10, TREASURY, '0')], PAYER, '1', '0')).toBeNull()
  })
})
