import { describe, it, expect } from 'vitest'
import { classifyEvmAddress, decodeScaleVecU8 } from '../src/services/contractRegistryService.ts'

// The classifier decides what enters the contract registry (and so the
// directory, the tag and every pill glyph). Every carve-out family from the
// runtime must be excluded — the failure this pins is a precompile, sentinel
// or module truncation being presented as a user-deployed contract.
describe('classifyEvmAddress', () => {
  const realCode = new Uint8Array([0x60, 0x80, 0x60, 0x40])

  it('classifies asset ERC-20 precompiles (first 16 bytes …01 + asset id)', () => {
    expect(classifyEvmAddress('0x0000000000000000000000000000000100000000', realCode)).toBe('asset-erc20')
    expect(classifyEvmAddress('0x0000000000000000000000000000000100000005', new Uint8Array([0]))).toBe('asset-erc20')
    // HOLLAR's asset id maps to a real deployed contract, not a precompile —
    // its address does NOT match the precompile pattern.
    expect(classifyEvmAddress('0x531a654d1696ed52e7275a8cede955e82620f99a', realCode)).toBe('contract')
  })

  it('does not classify a near-miss of the asset-precompile pattern as asset-erc20', () => {
    // 16th byte is 0x02, not 0x01 — outside the precompile family.
    expect(classifyEvmAddress('0x0000000000000000000000000000000200000005', realCode)).toBe('contract')
  })

  it('classifies chainlink-adapter oracle precompiles (first 3 bytes 0x000001)', () => {
    expect(classifyEvmAddress('0x0000010000000000000000000000000000000005', realCode)).toBe('oracle-adapter')
    expect(classifyEvmAddress('0x000001010000000200000000000000000000000f', new Uint8Array([0]))).toBe('oracle-adapter')
  })

  it('classifies each system precompile', () => {
    for (let i = 1; i <= 9; i++) {
      expect(classifyEvmAddress('0x' + i.toString(16).padStart(40, '0'), realCode)).toBe('system-precompile')
    }
    for (const tail of ['0401', '0806', '080a', '090a']) {
      expect(classifyEvmAddress('0x' + tail.padStart(40, '0'), realCode)).toBe('system-precompile')
    }
    // 0x…0a is NOT a standard precompile on this runtime.
    expect(classifyEvmAddress('0x' + 'a'.padStart(40, '0'), realCode)).toBe('contract')
  })

  it('classifies the all-FF holding address and the synthetic-log sentinel', () => {
    expect(classifyEvmAddress('0x' + 'ff'.repeat(20), realCode)).toBe('sentinel')
    expect(classifyEvmAddress('0x' + '73796e7468'.repeat(4), realCode)).toBe('sentinel')
  })

  it('never classifies reserved substrate-derived H160s (modl/sibl/para) as contracts', () => {
    expect(classifyEvmAddress('0x6d6f646c6f6d6e69706f6f6c0000000000000000', realCode)).not.toBe('contract')
    expect(classifyEvmAddress('0x7369626cd0070000000000000000000000000000', realCode)).not.toBe('contract')
    expect(classifyEvmAddress('0x70617261d0070000000000000000000000000000', realCode)).not.toBe('contract')
  })

  it('classifies real deployed addresses as contract', () => {
    // HOLLAR token and a money-market pool proxy — live contracts on chain.
    expect(classifyEvmAddress('0x531a654d1696ed52e7275a8cede955e82620f99a', realCode)).toBe('contract')
    expect(classifyEvmAddress('0x1b02e051683b5cfac5929c25e84adb26ecf87b38', realCode)).toBe('contract')
    // Case-insensitive input.
    expect(classifyEvmAddress('0x531A654D1696ED52E7275A8CEDE955E82620F99A', realCode)).toBe('contract')
  })

  it('lands planted marker codes (one-byte 0x00 / empty / all-zero) in planted-unknown, never contract', () => {
    expect(classifyEvmAddress('0x1234567890abcdef1234567890abcdef12345678', new Uint8Array([0x00]))).toBe('planted-unknown')
    expect(classifyEvmAddress('0x1234567890abcdef1234567890abcdef12345678', new Uint8Array([]))).toBe('planted-unknown')
    expect(classifyEvmAddress('0x1234567890abcdef1234567890abcdef12345678', new Uint8Array([0, 0, 0]))).toBe('planted-unknown')
  })

  it('with no code available, pattern-unmatched addresses stay contract (code check is separate)', () => {
    expect(classifyEvmAddress('0x531a654d1696ed52e7275a8cede955e82620f99a')).toBe('contract')
  })
})

// EVM.AccountCodes values arrive as SCALE Vec<u8>; the planted marker is the
// one-byte 0x00 the runtime plants at every asset precompile.
describe('decodeScaleVecU8', () => {
  it('decodes the planted one-byte 0x00 marker', () => {
    expect(decodeScaleVecU8('0x0400')).toEqual(new Uint8Array([0x00]))
  })

  it('decodes single-byte-mode lengths', () => {
    expect(decodeScaleVecU8('0x14deadbeefaa')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xaa]))
  })

  it('decodes two-byte-mode lengths', () => {
    const body = new Uint8Array(64).fill(7)
    const hex = '0x0101' + Buffer.from(body).toString('hex')
    expect(decodeScaleVecU8(hex)).toEqual(body)
  })

  it('returns null for truncated or malformed values', () => {
    expect(decodeScaleVecU8('0x14dead')).toBeNull()  // declares 5 bytes, carries 2
    expect(decodeScaleVecU8('0x')).toBeNull()
    expect(decodeScaleVecU8('nope')).toBeNull()
  })
})
