import { describe, expect, it } from 'vitest'
import { deriveFeePayment, type FeePaymentEvent } from '../src/services/extrinsicFeePayment.ts'
import { EVM_EXECUTION_EVENTS } from '../src/services/revenueStreams.ts'

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

// A PolkadotXcm.execute pays its program's weight to the treasury through the XCM
// weight trader, which deposits when the executor drops — the last thing before
// PolkadotXcm.Attempted. The program's WithdrawAsset debited the payer in that
// currency, so the debit rule alone admits the deposit as a fee; the revenue
// model books it as the xcm_execution_fee stream instead, and the two readers
// apply one rule.
describe('deriveFeePayment: XCM execution fee', () => {
  const attempted: FeePaymentEvent = { name: 'PolkadotXcm.Attempted', args: { outcome: { __kind: 'Complete' } } }
  const mirror = (currencyId: number, who: string, amount: string): FeePaymentEvent =>
    ({ name: 'Currencies.Deposited', args: { currencyId, who, amount } })

  // 15038567-3, a bare PolkadotXcm.execute: 0.00637 DOT to the trader right before
  // Attempted, then the 1.2676 HDX substrate fee after it.
  it('drops the trader deposit before Attempted and keeps the substrate fee after it', () => {
    const events = [
      nativeWithdraw(PAYER, '1267652060185'),
      withdrawn(5, PAYER, '363436585125'),
      { name: 'XcmpQueue.XcmpMessageSent', args: { messageHash: '0x71' } },
      deposited(5, PAYER, '2101331'),
      deposited(5, TREASURY, '6369393'),
      mirror(5, TREASURY, '6369393'),
      attempted,
      nativeDeposit(PAYER, '26966971'),
      nativeDeposit(TREASURY, '1267625093214'),
      { name: 'Balances.Issued', args: { amount: '1267625093214' } },
    ]
    expect(deriveFeePayment(events, PAYER, '1267625093214', '0')).toEqual({
      assetId: 0, amount: '1267625093214', tipAmount: null,
    })
  })

  // 14934388-2, a dispatch_permit running an execute, both settling in DOT: the
  // trader took 8107653 (event 11) and the permit fee was 7418021 (event 15).
  // Summing the candidates in the fee currency counted both as the fee.
  it('does not sum the trader deposit into a same-currency permit fee', () => {
    const evmPayer = '0x45544800ece792e16f847add756d2c421801ff82999d23330000000000000000'
    const events = [
      withdrawn(5, evmPayer, '150852673'),
      withdrawn(5, evmPayer, '23595741780'),
      withdrawn(39, evmPayer, '10000000000000000000'),
      { name: 'XcmpQueue.XcmpMessageSent', args: { messageHash: '0x36' } },
      deposited(5, evmPayer, '2673992'),
      deposited(5, TREASURY, '8107653'),
      mirror(5, TREASURY, '8107653'),
      attempted,
      deposited(5, evmPayer, '143434652'),
      deposited(5, TREASURY, '7418021'),
    ]
    expect(deriveFeePayment(events, evmPayer, '0', '0')).toEqual({
      assetId: 5, amount: '7418021', tipAmount: null,
    })
  })

  // 12607469-2, PolkadotXcm.transfer_assets_using_type_and_then: the fee withdrawal
  // killed the HDX account, its dust reached the treasury, and the in-credit local
  // leg emitted the same Attempted — with withdrawals between the two. Nothing
  // before that barrier is the trader's; the fee is the deposit after it.
  it('leaves a treasury deposit alone when anything but run bookkeeping separates it from the barrier', () => {
    const events = [
      nativeWithdraw(PAYER, '882499267177'),
      { name: 'Balances.DustLost', args: { account: PAYER, amount: '471485963310' } },
      nativeDeposit(TREASURY, '471485963310'),
      { name: 'Treasury.Deposit', args: { value: '471485963310' } },
      withdrawn(5, PAYER, '15939847684'),
      withdrawn(1000766, PAYER, '26499192'),
      attempted,
      { name: 'PolkadotXcm.FeesPaid', args: {} },
      nativeDeposit(TREASURY, '882499267177'),
    ]
    expect(deriveFeePayment(events, PAYER, '882499267177', '0')).toEqual({
      assetId: 0, amount: '882499267177', tipAmount: null,
    })
    // The same shape without the dust: a treasury deposit that a withdrawal
    // separates from Attempted is not the trader's and stays the fee candidate.
    const gasThenTransfer = [
      nativeWithdraw(PAYER, '5000'),
      nativeDeposit(TREASURY, '5000'),
      withdrawn(5, PAYER, '15939847684'),
      attempted,
    ]
    expect(deriveFeePayment(gasThenTransfer, PAYER, '0', '0')).toEqual({ assetId: 0, amount: '5000', tipAmount: null })
  })
})

// An EVM dispatch never debits through a Withdraw. It PREPAYS gas as
// Balances.Burned and refunds the unused part as Balances.Minted, so with only
// Withdraw counted as a debit nothing was ever charged in the resolver's eyes,
// every treasury deposit was rejected for naming an undebited currency, and the
// fee read as unknown on every Ethereum.transact and dispatch_permit there is.
describe('deriveFeePayment: EVM gas', () => {
  const EVM_PAYER = '0x455448008b4f80fa734da0c9a51d2895534decc0085e5ac30000000000000000'
  const burned = (who: string, amount: string): FeePaymentEvent =>
    ({ name: 'Balances.Burned', args: { who, amount } })
  const minted = (who: string, amount: string): FeePaymentEvent =>
    ({ name: 'Balances.Minted', args: { who, amount } })

  // 14872335-2, MultiTransactionPayment.dispatch_permit: a batch of three EVM
  // calls, each prepaying and refunding its own gas. raw_extrinsics.fee is null
  // — the dispatch is Pays::No — so the gas is the sum of the deposits, and the
  // burns net of the mints equal it to the planck.
  it('states the gas an EVM dispatch actually paid', () => {
    const events = [
      burned(EVM_PAYER, '3956683459714'),
      burned(EVM_PAYER, '335168574794'),
      minted(EVM_PAYER, '294318228898'),
      nativeDeposit(TREASURY, '40850345896'),
      burned(EVM_PAYER, '2011011448764'),
      minted(EVM_PAYER, '1753516515335'),
      nativeDeposit(TREASURY, '257494933429'),
      minted(EVM_PAYER, '3622439950186'),
      nativeDeposit(TREASURY, '334243509528'),
    ]
    // 6,302,863,483,272 burned − 5,670,274,694,419 returned = 632,588,788,853.
    expect(deriveFeePayment(events, EVM_PAYER, null, null)).toEqual({
      assetId: 0, amount: '632588788853', tipAmount: null,
    })
  })

  it('still ignores a treasury deposit in a currency the payer never paid', () => {
    const events = [
      burned(EVM_PAYER, '1000'),
      // A pool fee leg reaching the treasury in another asset is not this fee.
      deposited(5, TREASURY, '999999'),
      nativeDeposit(TREASURY, '400'),
    ]
    expect(deriveFeePayment(events, EVM_PAYER, null, null)).toEqual({
      assetId: 0, amount: '400', tipAmount: null,
    })
  })

  it('reports nothing when the payer burned gas but the treasury got none', () => {
    expect(deriveFeePayment([burned(EVM_PAYER, '1000'), minted(EVM_PAYER, '1000')], EVM_PAYER, null, null)).toBeNull()
  })

  // With no substrate fee every HDX treasury deposit is summed, and the payer's
  // gas burn vouches for HDX — so the dust of an account the call killed, swept
  // to the treasury as the Balances.Deposit right after Balances.DustLost, would
  // be read as gas. Taking the last deposit (the substrate-fee case) never met
  // this; the sum does.
  it('leaves the dust sweep after DustLost out of the gas sum', () => {
    const events = [
      burned(EVM_PAYER, '5000'),
      { name: 'Balances.DustLost', args: { account: EVM_PAYER, amount: '333' } },
      nativeDeposit(TREASURY, '333'),
      minted(EVM_PAYER, '1000'),
      nativeDeposit(TREASURY, '4000'),
    ]
    expect(deriveFeePayment(events, EVM_PAYER, null, null)).toEqual({
      assetId: 0, amount: '4000', tipAmount: null,
    })
  })

  it('still reads a deposit that merely follows a dust sweep at a distance', () => {
    const events = [
      { name: 'Balances.DustLost', args: { account: EVM_PAYER, amount: '333' } },
      nativeDeposit(TREASURY, '333'),
      burned(EVM_PAYER, '5000'),
      nativeDeposit(TREASURY, '4000'),
    ]
    expect(deriveFeePayment(events, EVM_PAYER, null, null)?.amount).toBe('4000')
  })
})

// A signed extrinsic that runs the EVM is Pays::Yes: it prepays gas mid-dispatch
// (one treasury deposit per EVM call, net of the refund) AND settles the
// substrate fee post-dispatch. Taking the last deposit alone stated the fee and
// lost the gas — 15011574-3's page said 0.928 HDX while its activity row's
// revenue booked 1.275 HDX. The gas is every earlier candidate in the fee
// currency, under the scope the revenue stream's deposit arm uses
// (EVM_EXECUTION_EVENTS), so page and book are one figure.
describe('deriveFeePayment: gas beside a substrate fee', () => {
  const burned = (who: string, amount: string): FeePaymentEvent => ({ name: 'Balances.Burned', args: { who, amount } })
  const minted = (who: string, amount: string): FeePaymentEvent => ({ name: 'Balances.Minted', args: { who, amount } })
  const evmExecuted: FeePaymentEvent = { name: 'EVM.Executed', args: { address: '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923' } }

  // 15011574-3, Dispatcher.dispatch_evm_call: 1,765,954,456,969 burned,
  // 1,418,746,619,275 minted back, 347,207,837,694 to the treasury as gas
  // (event 35), then the 928,231,574,052 fee (event 49). revenue_events books
  // exactly those two rows for the extrinsic.
  it('states the gas a dispatch_evm_call paid beside its HDX fee', () => {
    const events = [
      nativeWithdraw(PAYER, '931327713168'),
      burned(PAYER, '1765954456969'),
      minted(PAYER, '1418746619275'),
      nativeDeposit(TREASURY, '347207837694'),
      { name: 'EVM.Log', args: {} },
      evmExecuted,
      nativeDeposit(PAYER, '3096139116'),
      nativeDeposit(TREASURY, '928231574052'),
    ]
    expect(deriveFeePayment(events, PAYER, '928231574052', '0')).toEqual({
      assetId: 0, amount: '928231574052', tipAmount: null,
      gas: { assetId: 0, amount: '347207837694' },
    })
  })

  // 15055487-2, Utility.batch_all of EVM calls: the batch pays one substrate fee
  // (1,627,066,659,277, event 91) and each call its own gas (670,667,471,565 at
  // event 12 here, folded to one deposit in the fixture).
  it('sums every gas deposit of a batch under one fee', () => {
    const events = [
      nativeWithdraw(PAYER, '1629456357681'),
      burned(PAYER, '1764960845192'),
      minted(PAYER, '1094293373627'),
      nativeDeposit(TREASURY, '400000000000'),
      evmExecuted,
      burned(PAYER, '100000000000'),
      nativeDeposit(TREASURY, '270667471565'),
      evmExecuted,
      nativeDeposit(PAYER, '2389698404'),
      nativeDeposit(TREASURY, '1627066659277'),
    ]
    expect(deriveFeePayment(events, PAYER, '1627066659277', '0')).toEqual({
      assetId: 0, amount: '1627066659277', tipAmount: null,
      gas: { assetId: 0, amount: '670667471565' },
    })
  })

  it('carries the gas in the fee currency when that is not HDX', () => {
    const events = [
      withdrawn(10, PAYER, '30000'),
      deposited(10, TREASURY, '12000'),
      evmExecuted,
      deposited(10, TREASURY, '30000'),
    ]
    expect(deriveFeePayment(events, PAYER, '500000000000', '0')).toEqual({
      assetId: 10, amount: '30000', tipAmount: null, gas: { assetId: 10, amount: '12000' },
    })
  })

  // The scope is the revenue stream's: only an extrinsic the EVM ran in has gas.
  // Outside it an earlier same-currency treasury deposit is not a charge the
  // payer made, and the deposit arm books none — so the page states none.
  it('reads no gas into an extrinsic that never ran the EVM', () => {
    const events = [
      nativeWithdraw(PAYER, '5000'),
      nativeDeposit(TREASURY, '300'),
      nativeDeposit(TREASURY, '5000'),
    ]
    expect(deriveFeePayment(events, PAYER, '5000', '0')).toEqual({ assetId: 0, amount: '5000', tipAmount: null })
  })

  it('admits gas under exactly the markers the revenue stream scopes on', () => {
    for (const marker of EVM_EXECUTION_EVENTS) {
      const events = [burned(PAYER, '900'), nativeDeposit(TREASURY, '300'), { name: marker, args: {} }, nativeDeposit(TREASURY, '5000')]
      expect(deriveFeePayment(events, PAYER, '5000', '0')?.gas, marker).toEqual({ assetId: 0, amount: '300' })
    }
  })

  // The tip split stays the fee's own — gas never enters the fee + tip ratio.
  it('splits the tip out of the fee alone, with the gas beside it', () => {
    const events = [burned(PAYER, '900'), nativeDeposit(TREASURY, '300'), evmExecuted, nativeDeposit(TREASURY, '30000')]
    expect(deriveFeePayment(events, PAYER, '500000000000', '2500000000000')).toEqual({
      assetId: 0, amount: '5000', tipAmount: '25000', gas: { assetId: 0, amount: '300' },
    })
  })

  // With no substrate fee the gas IS the fee figure (the Ethereum.transact and
  // Pays::No shapes above); nothing is stated twice.
  it('states no separate gas when the gas is the whole charge', () => {
    const events = [burned(PAYER, '900'), nativeDeposit(TREASURY, '300'), evmExecuted, nativeDeposit(TREASURY, '600')]
    expect(deriveFeePayment(events, PAYER, null, null)).toEqual({ assetId: 0, amount: '900', tipAmount: null })
    expect(deriveFeePayment(events, PAYER, '0', '0')).toEqual({ assetId: 0, amount: '900', tipAmount: null })
  })
})

// pallet-currencies emits `Currencies.Withdrawn`/`Currencies.Deposited` after the
// pallet it routed to: over a Tokens or HDX movement it repeats a twin that sits
// directly before it, and over an ERC-20 registry asset (HOLLAR, GDOT, BIL, the
// aTokens — balances in contract storage) it is the ONLY record, the underlying
// leaving nothing but the contract's EVM.Log. Skipping every Currencies event as a
// mirror made a HOLLAR fee invisible: the page fell back to the HDX figure and the
// revenue model booked the gas of no ERC-20-paying dispatch.
describe('deriveFeePayment: Currencies events of an ERC-20 fee currency', () => {
  const currenciesWithdrawn = (currencyId: number, who: string, amount: string): FeePaymentEvent =>
    ({ name: 'Currencies.Withdrawn', args: { currencyId, who, amount } })
  const currenciesDeposited = (currencyId: number, who: string, amount: string): FeePaymentEvent =>
    ({ name: 'Currencies.Deposited', args: { currencyId, who, amount } })
  const evmLog: FeePaymentEvent = { name: 'EVM.Log', args: { log: { address: '0x531a654d1696ed52e7275a8cede955e82620f99a', topics: [], data: '0x' } } }
  const evmExecuted: FeePaymentEvent = { name: 'EVM.Executed', args: { address: '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923' } }

  // 15033063-2, Dispatcher.dispatch_evm_call paid in HOLLAR (222): the
  // pre-dispatch withdrawal (event 4), the gas deposit (8), the refund (17) and
  // the fee deposit (19) are each a bare Currencies event behind the contract's
  // Transfer log; the EVM prepay and its refund are logs alone.
  it('reads a HOLLAR fee and its gas off bare Currencies events', () => {
    const hollarPayer = '0xf61d983487817667805f61db0f5ba60b29efa3b8563ed79379e56872d394207f'
    const events = [
      evmLog,
      currenciesWithdrawn(222, hollarPayer, '7047366697622991'),
      evmLog, evmLog, evmLog,
      currenciesDeposited(222, TREASURY, '3095806610000484'),
      evmLog,
      evmExecuted,
      evmLog,
      currenciesDeposited(222, hollarPayer, '29058565494202'),
      evmLog,
      currenciesDeposited(222, TREASURY, '7018308132128789'),
    ]
    expect(deriveFeePayment(events, hollarPayer, '981751934865', '0')).toEqual({
      assetId: 222, amount: '7018308132128789', tipAmount: null,
      gas: { assetId: 222, amount: '3095806610000484' },
    })
  })

  // 15049694-2, EVM.call dispatched Pays::No in GDOT (69, a rebasing aToken):
  // the gas deposit plus a 1-wei remainder, the refund a wei short of the
  // withdrawal. Nothing was charged on the substrate side, so both are summed.
  it('sums the gas of a Pays::No dispatch paid in an aToken', () => {
    const gdotPayer = '0x5477ba60781dfea03c2dd9362e53fc10036852b3ea91450ca7336208bf283b77'
    const events = [
      evmLog,
      currenciesWithdrawn(69, gdotPayer, '7189908168283688'),
      evmLog,
      currenciesDeposited(69, TREASURY, '3035606701717149'),
      evmExecuted,
      evmLog,
      currenciesDeposited(69, gdotPayer, '7189908168283687'),
      evmLog,
      currenciesDeposited(69, TREASURY, '1'),
    ]
    expect(deriveFeePayment(events, gdotPayer, '0', '0')).toEqual({
      assetId: 69, amount: '3035606701717150', tipAmount: null,
    })
  })

  // The mirror of a Tokens deposit repeats its currency and amount directly
  // after it; the mirror of an HDX deposit has the pallet's own `Balances.Issued`
  // between the two. Neither is a second deposit — summed, a Pays::No fee in DOT
  // or HDX would double.
  it('does not count the mirror of a Tokens or HDX treasury deposit', () => {
    const dot = [
      withdrawn(5, PAYER, '150852673'),
      currenciesWithdrawn(5, PAYER, '150852673'),
      deposited(5, TREASURY, '8107653'),
      currenciesDeposited(5, TREASURY, '8107653'),
      deposited(5, TREASURY, '1'),
      currenciesDeposited(5, TREASURY, '1'),
    ]
    expect(deriveFeePayment(dot, PAYER, '0', '0')).toEqual({ assetId: 5, amount: '8107654', tipAmount: null })
    const hdx = [
      nativeWithdraw(PAYER, '5000'),
      { name: 'Balances.Rescinded', args: { amount: '5000' } },
      currenciesWithdrawn(0, PAYER, '5000'),
      nativeDeposit(TREASURY, '4000'),
      { name: 'Balances.Issued', args: { amount: '4000' } },
      currenciesDeposited(0, TREASURY, '4000'),
    ]
    expect(deriveFeePayment(hdx, PAYER, '0', '0')).toEqual({ assetId: 0, amount: '4000', tipAmount: null })
  })

  // Two movements of one amount are two deposits; a Currencies event is a mirror
  // only of the deposit directly before it, never of an earlier one.
  it('keeps a Currencies deposit that repeats nothing directly before it', () => {
    const events = [
      withdrawn(5, PAYER, '9000'),
      currenciesWithdrawn(222, PAYER, '4000'),
      deposited(5, TREASURY, '4000'),
      currenciesDeposited(5, TREASURY, '4000'),
      evmLog,
      currenciesDeposited(222, TREASURY, '4000'),
    ]
    expect(deriveFeePayment(events, PAYER, '0', '0')).toEqual({ assetId: 222, amount: '4000', tipAmount: null })
  })

  it("still needs the payer's own debit in the ERC-20 currency", () => {
    const events = [
      currenciesWithdrawn(222, '0x455448001973e7044d9a7c7bb2d6ea1693a296a9e4b7e4480000000000000000', '5000'),
      currenciesDeposited(222, TREASURY, '4000'),
    ]
    expect(deriveFeePayment(events, PAYER, '0', '0')).toBeNull()
  })
})

// The EVM gas prepay of a dispatch charged in an ERC-20 currency is a `burn_from`
// on the runtime's ERC-20 adapter: the contract's Transfer from the payer to the
// adapter's holding address, an EVM.Log and no pallet event. An unsigned dispatch
// (Ethereum.transact, dispatch_permit) has no pre-dispatch withdrawal either, so
// nothing named a debit and its fee read as unknown — 866 permits over the
// ERC-20 era. The log IS the debit, on the contract whose own log sits directly
// before the bare Currencies deposit that paid the treasury.
describe("deriveFeePayment: the ERC-20 adapter's transfer as the debit", () => {
  const GDOT = '0x34d5ffb83d86dfa8ac5ba64e5e29f74f8b8d6e91'
  const HOLDING = '0x' + 'f'.repeat(40)
  const TREASURY_H160 = '0x6d6f646c70792f74727372790000000000000000'
  // 14802829-2's permit signer: a bound EVM account, stored as "ETH\0" + H160 + 8 zero bytes.
  const permitSigner = '0x45544800336f25787ee2bfb521e49eeb9b006abdc83976500000000000000000'
  const permitSignerH160 = '0x336f25787ee2bfb521e49eeb9b006abdc8397650'
  const pad = (h160: string): string => '0x' + '0'.repeat(24) + h160.slice(2)
  const transfer = (contract: string, from: string, to: string, value: string): FeePaymentEvent => ({
    name: 'EVM.Log',
    args: { log: { address: contract, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(from), pad(to)], data: value } },
  })
  const balanceTransfer = (contract: string): FeePaymentEvent => ({
    name: 'EVM.Log',
    args: { log: { address: contract, topics: ['0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666'], data: '0x' } },
  })
  const currenciesDeposited = (currencyId: number, who: string, amount: string): FeePaymentEvent =>
    ({ name: 'Currencies.Deposited', args: { currencyId, who, amount } })

  // 14802829-2, MultiTransactionPayment.dispatch_permit paid in GDOT (69): the
  // prepay (event 5), its refund (9) and the treasury's share (12) are Transfer
  // logs of the aToken, each followed by its BalanceTransfer log; only the
  // treasury's is followed by a Currencies.Deposited. Pays::No, no fee figure.
  it('reads the gas of a permit paid in an aToken off the adapter transfers', () => {
    const events = [
      transfer(GDOT, permitSignerH160, HOLDING, '18905780577002739'),
      balanceTransfer(GDOT),
      { name: 'MultiTransactionPayment.CurrencySet', args: { accountId: permitSigner, assetId: 69 } },
      transfer(GDOT, HOLDING, permitSignerH160, '7482926956190260'),
      balanceTransfer(GDOT),
      transfer(GDOT, HOLDING, TREASURY_H160, '11422853620812479'),
      balanceTransfer(GDOT),
      currenciesDeposited(69, TREASURY, '11422853620812479'),
    ]
    expect(deriveFeePayment(events, permitSigner, null, null)).toEqual({
      assetId: 69, amount: '11422853620812479', tipAmount: null,
    })
  })

  it("maps a substrate payer to its first 20 bytes, the runtime's evm_address", () => {
    const events = [
      transfer(GDOT, PAYER.slice(0, 42), HOLDING, '500'),
      transfer(GDOT, HOLDING, TREASURY_H160, '400'),
      currenciesDeposited(69, TREASURY, '400'),
    ]
    expect(deriveFeePayment(events, PAYER, null, null)?.amount).toBe('400')
  })

  it('vouches only through a transfer of the payer, to holding, on the contract that paid the treasury', () => {
    const other = '0x1973e7044d9a7c7bb2d6ea1693a296a9e4b7e448'
    const otherContract = '0x531a654d1696ed52e7275a8cede955e82620f99a'
    const deposit = [transfer(GDOT, HOLDING, TREASURY_H160, '400'), currenciesDeposited(69, TREASURY, '400')]
    expect(deriveFeePayment([transfer(GDOT, other, HOLDING, '500'), ...deposit], permitSigner, null, null)).toBeNull()
    expect(deriveFeePayment([transfer(GDOT, permitSignerH160, other, '500'), ...deposit], permitSigner, null, null)).toBeNull()
    expect(deriveFeePayment([transfer(otherContract, permitSignerH160, HOLDING, '500'), ...deposit], permitSigner, null, null)).toBeNull()
    // A Currencies deposit with no contract log directly before it names no
    // contract, so the adapter rule cannot vouch for it.
    const detached = [transfer(GDOT, permitSignerH160, HOLDING, '500'), transfer(GDOT, HOLDING, TREASURY_H160, '400'),
      { name: 'EVM.Executed', args: {} }, currenciesDeposited(69, TREASURY, '400')]
    expect(deriveFeePayment(detached, permitSigner, null, null)).toBeNull()
  })
})
