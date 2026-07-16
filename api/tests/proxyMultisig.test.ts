import { describe, expect, it } from 'vitest'
import { decodeCompact, decodeProxiesValue, decodeMultisigOpValue, deriveMultisigAccountId, proxyTypeName } from '../src/services/proxyMultisigService.ts'

describe('decodeProxiesValue', () => {
  it('decodes a real Proxy.Proxies storage value (3 proxies + deposit)', () => {
    // Captured from Hydration state: Vec of 3 ProxyDefinition + u128 deposit.
    const hex = '0x0c4d5184fcebd910b43badc23531209a3d1546dd4a1853114e20005d61c49725fb0000000000'
      + 'ee24cdac0c090625c7ac9110d9dc9a9fedd76d6588bffc23660d4eca2b5edf520200000000'
      + 'ee24cdac0c090625c7ac9110d9dc9a9fedd76d6588bffc23660d4eca2b5edf520300000000'
      + '0064dd83d1b800000000000000000000'
    const proxies = decodeProxiesValue(hex)
    expect(proxies).toEqual([
      { delegate: '0x4d5184fcebd910b43badc23531209a3d1546dd4a1853114e20005d61c49725fb', proxyType: 'Any', delay: 0 },
      { delegate: '0xee24cdac0c090625c7ac9110d9dc9a9fedd76d6588bffc23660d4eca2b5edf52', proxyType: 'Governance', delay: 0 },
      { delegate: '0xee24cdac0c090625c7ac9110d9dc9a9fedd76d6588bffc23660d4eca2b5edf52', proxyType: 'Transfer', delay: 0 },
    ])
  })

  it('names unknown proxy-type indexes without throwing', () => {
    expect(proxyTypeName(99)).toBe('Type#99')
  })

  it('keeps u32 delays unsigned', () => {
    const hex = `0x04${'11'.repeat(32)}00ffffffff`
    expect(decodeProxiesValue(hex)[0]?.delay).toBe(0xffff_ffff)
  })

  it('rejects truncated compact lengths', () => {
    expect(() => decodeCompact(new Uint8Array([0x01]), 0)).toThrow(RangeError)
    expect(() => decodeCompact(new Uint8Array(), 0)).toThrow(RangeError)
  })
})

describe('deriveMultisigAccountId', () => {
  // Fixed derivation vector for a three-of-five multisig.
  it('derives the 3-of-5 Hydration multisig from its signatories', () => {
    const signatories = [
      '0x0c691601793de060491dab143dfae19f5f6413d4ce4c363637e5ceacb2836a4e',
      '0x6ae93e7162785a77d3a2c0413a9ee04af1b948ba5df9ac191552b72e1dd49b71',
      '0x8aee4e164d5d70ac67308f303c7e063e9156903e42c1087bbc530447487fa47f',
      '0xb2927ffd2bbb0a73a317ab830e2dccd5e30cb0231c3ce7224be0f233b330742f',
      '0xee92a79760d0480aab1a940b0abab817dfcde83655e4d2c71682ce272b26ef0a',
    ]
    expect(deriveMultisigAccountId(signatories, 3)).toBe('0xefb69c118cc48c08e9ce072dafcce8d9e5e00c02f83b1a6463ba7d4155dc2ded')
  })

  it('derives the 2-of-3 Hydration multisig from its signatories', () => {
    const signatories = [
      '0x1ab695ff7ac486604f2965b57cfad12793124015a8dbf6856dbbbc34e438bc0d',
      '0x4a154ce100d43672e3cab61d2196621d0d69dccbf86d432595f2d0fc4eb5ee61',
      '0x8a28eac392445da66dc712363927619965f95b7983d64df8df51a9dc74588c5b',
    ]
    expect(deriveMultisigAccountId(signatories, 2)).toBe('0x93b7ca11cee981dff749f838c0c9e1cbd86e7fb33652f9e22b72e3ddbe00f699')
  })
})

describe('decodeMultisigOpValue', () => {
  it('decodes timepoint, depositor and approvals', () => {
    const depositor = 'aa'.repeat(32)
    const approval1 = 'bb'.repeat(32)
    const approval2 = 'cc'.repeat(32)
    // Timepoint{height=0x01020304 LE, index=2} + deposit u128 + depositor + Vec[2]
    const hex = '0x' + '04030201' + '02000000' + '00'.repeat(16) + depositor + '08' + approval1 + approval2
    const op = decodeMultisigOpValue(hex)
    expect(op).toEqual({
      sinceBlock: 0x01020304,
      depositor: '0x' + depositor,
      approvals: ['0x' + approval1, '0x' + approval2],
    })
  })

  it('returns null for truncated values', () => {
    expect(decodeMultisigOpValue('0x0403')).toBeNull()
  })

  it('keeps block heights unsigned and rejects partial approval vectors', () => {
    const depositor = 'aa'.repeat(32)
    const unsigned = `0x${'ff'.repeat(4)}${'00'.repeat(4 + 16)}${depositor}00`
    expect(decodeMultisigOpValue(unsigned)?.sinceBlock).toBe(0xffff_ffff)

    const partial = `0x${'00'.repeat(4 + 4 + 16)}${depositor}08${'bb'.repeat(32)}`
    expect(decodeMultisigOpValue(partial)).toBeNull()
  })
})
