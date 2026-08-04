import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyStandardJson, fetchDeployedBytecode, isEmptyCode } from '../src/services/verifierClient.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const input = { bytecode: '0x6080', compilerVersion: '0.8.10+commit.fc410830', stdJsonInput: { language: 'Solidity', sources: {} } }

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
