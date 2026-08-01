import { describe, expect, it } from 'vitest'
import { decodeNttTransferSent, nttDestination, ocnChainName, originTxExplorerUrl } from '../src/services/explorerService.ts'

// A journey's ends are named by Ocelloids URNs, and a bridge can put either end on a
// chain this app has no other reason to know. Two things then go wrong quietly: the
// chain id gets ignored, so every EVM chain reads as "Ethereum", and its transaction
// links point at etherscan where it does not exist. These pin the ends the live
// bridges actually reach — measured on Hydration's own journeys: ethereum:1,
// ethereum:8453 (Base), solana:101 and sui.

describe('ocnChainName', () => {
  it('tells the EVM chains apart rather than calling them all Ethereum', () => {
    expect(ocnChainName('urn:ocn:ethereum:1')).toBe('Ethereum')
    expect(ocnChainName('urn:ocn:ethereum:8453')).toBe('Base')
    expect(ocnChainName('urn:ocn:ethereum:42161')).toBe('Arbitrum')
  })

  // An unmapped EVM chain says which one it is instead of claiming Ethereum; a wrong
  // name is worse than an unfamiliar one.
  it('names an unmapped EVM chain by its id', () => {
    expect(ocnChainName('urn:ocn:ethereum:999999')).toBe('EVM chain 999999')
  })

  // Sui identifies itself with a hex digest, which the old numeric-only URN pattern
  // rejected outright — so a Sui journey resolved to nothing at all.
  it('accepts a non-numeric chain id', () => {
    expect(ocnChainName('urn:ocn:sui:0x35834a8a')).toBe('Sui')
  })

  it('names substrate ends and rejects nonsense', () => {
    expect(ocnChainName('urn:ocn:polkadot:0')).toBe('Polkadot')
    expect(ocnChainName('urn:ocn:solana:101')).toBe('Solana')
    expect(ocnChainName('not-a-urn')).toBeNull()
    expect(ocnChainName('')).toBeNull()
  })
})

describe('originTxExplorerUrl', () => {
  const tx = '0x' + 'ab'.repeat(32)

  it('sends each EVM chain to its own explorer', () => {
    expect(originTxExplorerUrl('urn:ocn:ethereum:1', tx)).toBe(`https://etherscan.io/tx/${tx}`)
    expect(originTxExplorerUrl('urn:ocn:ethereum:8453', tx)).toBe(`https://basescan.org/tx/${tx}`)
    expect(originTxExplorerUrl('urn:ocn:ethereum:42161', tx)).toBe(`https://arbiscan.io/tx/${tx}`)
  })

  // A link is only offered where it would resolve; an unmapped chain gets none rather
  // than a plausible-looking etherscan URL for a transaction that is not there.
  it('offers no link for an unmapped EVM chain', () => {
    expect(originTxExplorerUrl('urn:ocn:ethereum:999999', tx)).toBeNull()
  })

  // Solana signatures are base58, so the hex test that guards the EVM/substrate
  // branches must not be applied to them.
  it('links a base58 Solana signature', () => {
    const sig = '5x7cH1kQ2pYourSignatureHere9aBcDeFgHiJkLmNoPqRsTuVwXyZ'
    expect(originTxExplorerUrl('urn:ocn:solana:101', sig)).toBe(`https://solscan.io/tx/${encodeURIComponent(sig)}`)
  })

  it('links a Sui digest', () => {
    expect(originTxExplorerUrl('urn:ocn:sui:0x35834a8a', 'AbCdEf123')).toBe('https://suiscan.xyz/mainnet/tx/AbCdEf123')
  })

  it('has nothing to link without a hash', () => {
    expect(originTxExplorerUrl('urn:ocn:ethereum:1', null)).toBeNull()
    expect(originTxExplorerUrl('urn:ocn:ethereum:1', 'not-hex')).toBeNull()
  })
})

// Wormhole Native Token Transfers replaced Moonbeam Routed Liquidity for the venues MRL
// served. A send burns the token here and mints it on the far chain, so it carries no
// XCM topic, no destination junction and no sibling — and the crosschain index cannot be
// joined to it either (none of 47 NTT journeys' origin hashes matches a Hydration
// extrinsic hash or an EVM transaction hash). The far end is only in our own log.
//
// Decoded from a real send: 0.002 WETH at block 13405364, recipientChain 2.
describe('decodeNttTransferSent', () => {
  const topic = '0xe54e51e42099622516fa3b48e9733581c9dbdcb771cafb093f745a0532a35982'
  const sender = '0x000000000000000000000000e6af127259bf7f1b0539fc0a955494f48e31240b'
  const recipient = '0x000000000000000000000000e6af127259bf7f1b0539fc0a955494f48e31240b'
  // amount, fee, recipientChain, sequence
  const data = '0x00000000000000000000000000000000000000000000000000071afd498d0000'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000002'
    + '0000000000000000000000000000000000000000000000000000000000000001'

  it('reads the recipient, amount and destination chain of a real send', () => {
    expect(decodeNttTransferSent([topic, sender, recipient], data)).toEqual({
      recipient: recipient.toLowerCase(),
      amount: '2000000000000000',
      recipientChain: 2,
    })
  })

  it('ignores any other log', () => {
    expect(decodeNttTransferSent(['0x' + '11'.repeat(32), sender, recipient], data)).toBeNull()
    // A truncated payload names no chain, and guessing one would invent a destination.
    expect(decodeNttTransferSent([topic, sender, recipient], '0x00')).toBeNull()
    // Without a bytes32 recipient there is no account to show.
    expect(decodeNttTransferSent([topic, sender], data)).toBeNull()
  })
})

describe('nttDestination', () => {
  const sent = (recipientChain: number, recipient = '0x' + '00'.repeat(12) + 'e6af127259bf7f1b0539fc0a955494f48e31240b') =>
    ({ recipient, amount: '1', recipientChain })

  // An EVM destination wants the low 20 bytes; Solana and Sui need all 32, which is what
  // their encodings are built from.
  it('narrows a bytes32 recipient for EVM chains and keeps it whole otherwise', () => {
    expect(nttDestination(sent(2))).toEqual({ urn: 'urn:ocn:ethereum:1', account: '0xe6af127259bf7f1b0539fc0a955494f48e31240b' })
    expect(nttDestination(sent(30))).toEqual({ urn: 'urn:ocn:ethereum:8453', account: '0xe6af127259bf7f1b0539fc0a955494f48e31240b' })
    const solRecipient = '0x' + 'ab'.repeat(32)
    expect(nttDestination(sent(1, solRecipient))).toEqual({ urn: 'urn:ocn:solana:101', account: solRecipient })
  })

  // Wormhole numbers chains its own way, and an unmapped one yields no destination rather
  // than a plausible wrong chain — the same rule the EVM explorer links follow.
  it('yields nothing for a chain it does not know', () => {
    expect(nttDestination(sent(9999))).toBeNull()
  })
})
