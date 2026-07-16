import { describe, expect, it } from 'vitest'
import { parseOutboundXcm } from '../src/services/explorerService.ts'

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

describe('parseOutboundXcm', () => {
  it('parses the legacy XTokens.TransferredAssets shape', () => {
    const p = parseOutboundXcm(XTOKENS)!
    expect(p.sender).toBe(LEGACY_SENDER)
    expect(p.amounts).toEqual(['1000'])
    expect(p.dest.destParachainId).toBe(1000)
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
