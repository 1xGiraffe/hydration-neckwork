import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyStandardJson, fetchDeployedBytecode, isEmptyCode, zeroLibraryCallProtection } from '../src/services/verifierClient.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ADDRESS = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const input = { address: ADDRESS, bytecode: '0x6080', compilerVersion: '0.8.10+commit.fc410830', stdJsonInput: { language: 'Solidity', sources: {} } }

// The Blockscout verifier's failure taxonomy is not expressible through HTTP
// status alone: a bytecode mismatch is HTTP 200 with status FAILURE, an
// oversized payload surfaces as a broken pipe, and only request-shape problems
// are 4xx. Each branch below, misrouted, either reports a mismatch as success
// or a clean failure as a transport error.
describe('verifyStandardJson failure taxonomy', () => {
  it('treats HTTP 200 with status FAILURE as no_match, never as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'FAILURE', message: 'No contract could be verified with provided data' }),
    }))
    const res = await verifyStandardJson(input)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('no_match')
  })

  it('classifies a compilation error message as compiler_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'FAILURE', message: 'Compilation error: ParserError: Expected identifier' }),
    }))
    const res = await verifyStandardJson(input)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('compiler_error')
  })

  it('maps a broken pipe to bad_request (payload too large), not verifier_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('write EPIPE')))
    const res = await verifyStandardJson(input)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('bad_request')
      expect(res.message).toMatch(/too large/i)
    }
  })

  it('maps an unreachable verifier to verifier_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')))
    const res = await verifyStandardJson(input)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('verifier_unavailable')
  })

  it('maps non-JSON output to verifier_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<html>bad gateway</html>' }))
    const res = await verifyStandardJson(input)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('verifier_unavailable')
  })

  it('maps an HTTP 400 {code,message} envelope to bad_request with the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 400,
      text: async () => JSON.stringify({ code: 3, message: 'invalid compiler version' }),
    }))
    const res = await verifyStandardJson(input)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('bad_request')
      expect(res.message).toBe('invalid compiler version')
    }
  })

  it('returns the parsed artifacts on SUCCESS, defaulting matchType to PARTIAL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        status: 'SUCCESS',
        source: {
          contractName: 'Store', fileName: 'src/Store.sol',
          abi: '[{"type":"function","name":"retrieve"}]',
          compilerVersion: 'v0.8.10+commit.fc410830',
          compilerSettings: '{"evmVersion":"london","optimizer":{"enabled":true,"runs":200}}',
          constructorArguments: '0x0001',
          sourceFiles: { 'src/Store.sol': 'contract Store {}' },
          matchType: 'PARTIAL',
        },
      }),
    }))
    const res = await verifyStandardJson(input)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.matchType).toBe('PARTIAL')
      expect(res.contractName).toBe('Store')
      expect(res.sourceFiles['src/Store.sol']).toBe('contract Store {}')
      expect(res.abi).toContain('retrieve')
    }
  })
})

// A library's deployed runtime code is its compiled runtime code with the
// 20-byte call-protection operand patched to the library's own address, so the
// two can never be byte-equal and no standard-json input can make them so.
// Measured on NFTDescriptor (Uniswap v3-periphery) at
// 0x5DCE5306f247984042C18c0AEc99A60E24078Bc9: exactly offsets 1–20 differed,
// the other 24,521 bytes were identical, and those 20 bytes were the contract's
// own address. Zeroing the operand back out is what turns that into a match;
// the guards below are what keep every non-library submission untouched.
describe('zeroLibraryCallProtection', () => {
  // PUSH20 <operand> ; ADDRESS ; EQ, then body and a metadata tail.
  const PROTECTED_BODY = '3014608060405260043610610030575f80fd5ba264697066735822'
  const withOperand = (operand: string) => `0x73${operand}${PROTECTED_BODY}`
  const COMPILED = withOperand('0'.repeat(40))

  it('zeroes the operand when the prologue carries the address under verification', () => {
    expect(zeroLibraryCallProtection(withOperand(ADDRESS.slice(2)), ADDRESS)).toBe(COMPILED)
  })

  it('rewrites only offsets 1-20, leaving length and every later byte alone', () => {
    const onChain = withOperand(ADDRESS.slice(2))
    const out = zeroLibraryCallProtection(onChain, ADDRESS)
    expect(out).toHaveLength(onChain.length)
    expect(out.slice(0, 4)).toBe('0x73')
    expect(out.slice(44)).toBe(onChain.slice(44))
  })

  it('accepts a checksummed operand from a node that answers in mixed case', () => {
    expect(zeroLibraryCallProtection(withOperand('531A654D1696ed52E7275a8CEDE955e82620F99A'), ADDRESS)).toBe(COMPILED)
  })

  it('leaves an ordinary contract untouched: no prologue, nothing to substitute', () => {
    const runtime = '0x6080604052348015600f57600080fd5b506004361061002b575f80fd5b'
    expect(zeroLibraryCallProtection(runtime, ADDRESS)).toBe(runtime)
  })

  it('leaves a leading PUSH20 that is not followed by ADDRESS;EQ untouched', () => {
    // A contract that merely opens by pushing an address is not call-protected.
    const runtime = `0x73${ADDRESS.slice(2)}608060405260043610610030575f80fd5b`
    expect(zeroLibraryCallProtection(runtime, ADDRESS)).toBe(runtime)
  })

  it('leaves a protector holding some other address untouched', () => {
    // Only the deploying constructor writes this operand, and it writes the
    // library's own address. A different one means the code was not produced by
    // deploying this library here, so it must still fail to match.
    const runtime = withOperand('5dce5306f247984042c18c0aec99a60e24078bc9')
    expect(zeroLibraryCallProtection(runtime, ADDRESS)).toBe(runtime)
  })

  it('leaves an already-zeroed protector and truncated code alone', () => {
    expect(zeroLibraryCallProtection(COMPILED, ADDRESS)).toBe(COMPILED)
    const short = `0x73${ADDRESS.slice(2)}30`
    expect(zeroLibraryCallProtection(short, ADDRESS)).toBe(short)
  })

  it('is applied on the submit path, so the verifier compares against zeroes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'FAILURE', message: 'No contract could be verified with provided data' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await verifyStandardJson({ ...input, bytecode: withOperand(ADDRESS.slice(2)) })
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body) as { bytecode: string; bytecodeType: string }
    expect(sent.bytecode).toBe(COMPILED)
    // The substitution must not have leaked into the creation-code path.
    expect(sent.bytecodeType).toBe('DEPLOYED_BYTECODE')
  })
})

describe('deployed bytecode fetch', () => {
  it('treats 0x and all-zero code as no code (asset precompiles plant 0x00)', () => {
    expect(isEmptyCode('0x')).toBe(true)
    expect(isEmptyCode('0x00')).toBe(true)
    expect(isEmptyCode('0x0000')).toBe(true)
    expect(isEmptyCode('0x6080')).toBe(false)
  })

  it('returns null for a planted 0x00 answer and the code for a real contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: '0x00' }) }))
    await expect(fetchDeployedBytecode('0x0000000000000000000000000000000100000001')).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: '0x6080604052' }) }))
    await expect(fetchDeployedBytecode('0x531a654d1696ed52e7275a8cede955e82620f99a')).resolves.toBe('0x6080604052')
  })

  it('returns null on transport errors and malformed results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(fetchDeployedBytecode('0x531a654d1696ed52e7275a8cede955e82620f99a')).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: 'not-hex' }) }))
    await expect(fetchDeployedBytecode('0x531a654d1696ed52e7275a8cede955e82620f99a')).resolves.toBeNull()
  })
})

describe('listCompilerVersions', () => {
  it('parses, de-noises and sorts the version list newest-first', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ compilerVersions: [
        'v0.8.10+commit.fc410830',
        'v0.8.19-nightly.2023.1.4+commit.f2bf23a0',
        'v0.8.19+commit.7dd6d404',
        'v0.4.26+commit.4563c3fc',
      ] }),
    }))
    const { listCompilerVersions } = await import('../src/services/verifierClient.ts')
    await expect(listCompilerVersions()).resolves.toEqual([
      'v0.8.19+commit.7dd6d404',
      'v0.8.10+commit.fc410830',
      'v0.4.26+commit.4563c3fc',
    ])
  })

  it('returns an empty list when the verifier is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const { listCompilerVersions } = await import('../src/services/verifierClient.ts')
    await expect(listCompilerVersions()).resolves.toEqual([])
  })
})
