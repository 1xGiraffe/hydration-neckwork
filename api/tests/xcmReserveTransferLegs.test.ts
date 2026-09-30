import { describe, expect, it } from 'vitest'
import { reserveTransferLegs, siblingSovereignAccount, xcmLegAssets } from '../src/services/explorerService.ts'

// A local-reserve asset (HDX) is not burned by an XTokens send: it moves into the
// destination parachain's sovereign account, so its leg is that transfer, not a
// withdrawal. Measured: 1,685 sends in history had no row at all.
describe('reserve-transfer legs of an outbound send', () => {
  it('derives a sibling parachain\'s sovereign account', () => {
    // Interlay, 2032, as the chain itself records it (block 9,392,639).
    expect(siblingSovereignAccount(2032)).toBe('0x7369626cf0070000000000000000000000000000000000000000000000000000')
    expect(siblingSovereignAccount(1000)).toBe('0x7369626ce8030000000000000000000000000000000000000000000000000000')
  })

  const SENDER = '0xf05c79ca03a7353aa8e452ea01ec7de430c5edf1c32d8fd25b5347d155102fab'
  const INTERLAY = siblingSovereignAccount(2032)
  const legs = [
    { from: SENDER, to: INTERLAY, assetId: 0, amount: '4098000000000000000' },
    // Not this send's: another sender, and this sender into another chain's sovereign.
    { from: '0x' + '11'.repeat(32), to: INTERLAY, assetId: 0, amount: '5' },
    { from: SENDER, to: siblingSovereignAccount(2034), assetId: 0, amount: '6' },
  ]

  it('takes only the sender\'s transfer into its own destination\'s sovereign', () => {
    expect(reserveTransferLegs(legs, SENDER, 2032)).toEqual([{ assetId: 0, amount: '4098000000000000000' }])
    expect(reserveTransferLegs(legs, SENDER, null)).toEqual([])
  })

  it('lets the send\'s payload leg claim it where no withdrawal matched', () => {
    // The only withdrawal is the transaction fee (529.49 HDX) — never the payload.
    const available = [{ assetId: 0, amount: '529485713816' }, ...reserveTransferLegs(legs, SENDER, 2032)]
    expect(xcmLegAssets(['4098000000000000000'], available)).toEqual([0])
  })
})
