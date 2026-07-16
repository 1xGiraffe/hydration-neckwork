import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchChainHead,
  fetchFinalizedHead,
  parseRpcBlockNumber,
} from '../../src/rpc/head.ts'

function rpcResponse(result: unknown, ok = true): Response {
  return {
    ok,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  } as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseRpcBlockNumber', () => {
  it.each([
    ['0x0', 0],
    ['0x10', 16],
    ['0x0000ff', 255],
  ])('parses %s', (value, expected) => {
    expect(parseRpcBlockNumber(value)).toBe(expected)
  })

  it.each([
    undefined,
    10,
    '',
    '10',
    '0x',
    '0x10garbage',
    `0x${(BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(16)}`,
  ])('rejects malformed or unsafe value %s', (value) => {
    expect(parseRpcBlockNumber(value)).toBeNull()
  })
})

describe('Substrate RPC heads', () => {
  it('loads the best block and includes a request timeout', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rpcResponse({ number: '0x2a' }))

    await expect(fetchChainHead('https://rpc.example')).resolves.toBe(42)

    const init = fetchMock.mock.calls[0][1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'chain_getHeader', params: [] })
  })

  it('loads the finalized hash and then its block header', async () => {
    const hash = `0x${'ab'.repeat(32)}`
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rpcResponse(hash))
      .mockResolvedValueOnce(rpcResponse({ number: '0x2a' }))

    await expect(fetchFinalizedHead('https://rpc.example')).resolves.toBe(42)

    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      method: 'chain_getHeader',
      params: [hash],
    })
  })

  it('returns null for unsupported transports and malformed responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rpcResponse({ number: '0x2oops' }))

    await expect(fetchChainHead('wss://rpc.example')).resolves.toBeNull()
    await expect(fetchChainHead('https://rpc.example')).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
