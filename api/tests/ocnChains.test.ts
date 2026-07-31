import { describe, expect, it } from 'vitest'
import { ocnChainName, originTxExplorerUrl } from '../src/services/explorerService.ts'

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
