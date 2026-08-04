import { describe, expect, it } from 'vitest'
import { encodeCall, decodeResult, decodeRevert, parseInputValue, parseArgs, readFunctions, type AbiFunctionItem } from '../src/abiCodec'

// The Read tab's whole correctness rests on this codec: what we encode must be
// byte-identical to what solc-generated callers produce, and results must decode
// without precision loss (uint256 answers are the norm, not the edge case).

const erc20BalanceOf: AbiFunctionItem = {
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}
const transfer: AbiFunctionItem = {
  type: 'function', name: 'transfer', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}

describe('encodeCall / decodeResult round-trips', () => {
  it('encodes balanceOf(address) with the canonical selector', () => {
    const data = encodeCall(erc20BalanceOf, ['0x531a654d1696ed52e7275a8cede955e82620f99a'])
    expect(data.startsWith('0x70a08231')).toBe(true)
    expect(data).toHaveLength(2 + 8 + 64)
  })

  it('decodes a uint256 result as a bigint with no precision loss', () => {
    // 2^128 + 1 — far past Number precision.
    const value = (1n << 128n) + 1n
    const data = `0x${value.toString(16).padStart(64, '0')}` as const
    expect(decodeResult(erc20BalanceOf, data)).toBe(value)
  })

  it('round-trips array arguments', () => {
    const fn: AbiFunctionItem = {
      type: 'function', name: 'sum', stateMutability: 'pure',
      inputs: [{ name: 'xs', type: 'uint256[]' }],
      outputs: [{ name: '', type: 'uint256[]' }],
    }
    const data = encodeCall(fn, [[1n, 2n, 3n]])
    // An encoded call is selector + args; the args of `xs` decode back as the
    // same array when interpreted as the function's (identical) output tuple.
    const decoded = decodeResult(fn, `0x${data.slice(10)}`)
    expect(decoded).toEqual([1n, 2n, 3n])
  })

  it('round-trips tuple arguments and results', () => {
    const fn: AbiFunctionItem = {
      type: 'function', name: 'echo', stateMutability: 'pure',
      inputs: [{ name: 'p', type: 'tuple', components: [{ name: 'a', type: 'address' }, { name: 'n', type: 'uint256' }] }],
      outputs: [{ name: '', type: 'tuple', components: [{ name: 'a', type: 'address' }, { name: 'n', type: 'uint256' }] }],
    }
    const arg = { a: '0x531a654d1696ed52e7275a8cede955e82620f99a', n: 42n }
    const data = encodeCall(fn, [arg])
    const decoded = decodeResult(fn, `0x${data.slice(10)}`) as { a: string; n: bigint }
    expect(decoded.n).toBe(42n)
    expect(decoded.a.toLowerCase()).toBe(arg.a.toLowerCase())
  })
})

describe('decodeRevert', () => {
  it('decodes a standard Error(string) revert to its message', () => {
    // Error("insufficient balance") — selector 0x08c379a0 + abi-encoded string.
    const revert = encodeCall(
      { type: 'function', name: 'Error', stateMutability: 'pure', inputs: [{ name: '', type: 'string' }], outputs: [] },
      ['insufficient balance'],
    ).replace(/^0x[0-9a-f]{8}/, '0x08c379a0')
    expect(decodeRevert(revert)).toBe('insufficient balance')
  })

  it('decodes a Panic(uint256) revert to a named code', () => {
    const panic = '0x4e487b71' + '11'.padStart(64, '0') // arithmetic overflow
    expect(decodeRevert(panic)).toMatch(/panic/i)
  })

  it('returns null for undecodable revert data so the caller can show raw hex', () => {
    expect(decodeRevert('0xdeadbeef')).toBeNull()
    expect(decodeRevert('0x')).toBeNull()
  })
})

describe('parseInputValue (form validation)', () => {
  it('parses integers as bigints and rejects garbage', () => {
    expect(parseInputValue({ type: 'uint256' }, ' 123 ')).toBe(123n)
    expect(parseInputValue({ type: 'int128' }, '-5')).toBe(-5n)
    expect(() => parseInputValue({ type: 'uint256' }, '12.5')).toThrow(/integer/i)
    expect(() => parseInputValue({ type: 'uint256' }, 'abc')).toThrow(/integer/i)
    expect(() => parseInputValue({ type: 'uint256' }, '-1')).toThrow(/unsigned/i)
  })

  it('validates addresses and lowercases them so a stale checksum never hard-fails the encode', () => {
    expect(parseInputValue({ type: 'address' }, '0x531A654d1696ED52e7275A8CEDe955E82620f99a')).toBe('0x531a654d1696ed52e7275a8cede955e82620f99a')
    expect(() => parseInputValue({ type: 'address' }, '0x123')).toThrow(/address/i)
    expect(() => parseInputValue({ type: 'address' }, 'not-an-address')).toThrow(/address/i)
  })

  it('parses bools and hex bytes', () => {
    expect(parseInputValue({ type: 'bool' }, 'true')).toBe(true)
    expect(parseInputValue({ type: 'bool' }, '0')).toBe(false)
    expect(() => parseInputValue({ type: 'bool' }, 'yes')).toThrow(/bool/i)
    expect(parseInputValue({ type: 'bytes' }, '0xdeadbeef')).toBe('0xdeadbeef')
    expect(() => parseInputValue({ type: 'bytes32' }, 'deadbeef')).toThrow(/hex/i)
  })

  it('parses arrays and tuples from JSON, coercing integer elements to bigint', () => {
    expect(parseInputValue({ type: 'uint256[]' }, '[1, "2", 3]')).toEqual([1n, 2n, 3n])
    expect(() => parseInputValue({ type: 'uint256[]' }, 'not json')).toThrow(/json/i)
    const tuple = parseInputValue(
      { type: 'tuple', components: [{ name: 'a', type: 'address' }, { name: 'n', type: 'uint256' }] },
      '["0x531a654d1696ed52e7275a8cede955e82620f99a", "7"]',
    )
    expect(tuple).toEqual(['0x531a654d1696ed52e7275a8cede955e82620f99a', 7n])
  })

  it('passes strings through untouched', () => {
    expect(parseInputValue({ type: 'string' }, 'hello world')).toBe('hello world')
  })
})

describe('parseArgs', () => {
  it('maps each raw input through its parameter type', () => {
    expect(parseArgs(transfer, ['0x531a654d1696ed52e7275a8cede955e82620f99a', '1000'])).toEqual([
      '0x531a654d1696ed52e7275a8cede955e82620f99a', 1000n,
    ])
  })

  it('names the offending parameter in the error', () => {
    expect(() => parseArgs(transfer, ['0x531a654d1696ed52e7275a8cede955e82620f99a', 'x'])).toThrow(/amount/)
  })
})

describe('readFunctions', () => {
  it('keeps only view/pure functions from a full ABI', () => {
    const abi = [
      erc20BalanceOf,
      transfer,
      { type: 'event', name: 'Transfer', inputs: [] },
      { type: 'function', name: 'symbol', stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'string' }] },
    ]
    expect(readFunctions(abi).map(f => f.name)).toEqual(['balanceOf', 'symbol'])
  })
})
