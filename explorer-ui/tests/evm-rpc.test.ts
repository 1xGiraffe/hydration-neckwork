import { afterEach, describe, expect, it, vi } from 'vitest'
import { ethCall, ethGetCode, EvmRpcError } from '../src/evmRpc'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ADDR = '0x531a654d1696ed52e7275a8cede955e82620f99a'

describe('evmRpc', () => {
  it('returns the eth_call result hex', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0001' }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(ethCall(ADDR, '0x70a08231')).resolves.toBe('0x0001')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.method).toBe('eth_call')
    expect(body.params).toEqual([{ to: ADDR, data: '0x70a08231' }, 'latest'])
  })

  it('surfaces a revert as EvmRpcError carrying the revert data for decoding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x08c379a0aa' } }),
    }))
    const err = await ethCall(ADDR, '0x70a08231').catch(e => e as EvmRpcError)
    expect(err).toBeInstanceOf(EvmRpcError)
    expect((err as EvmRpcError).data).toBe('0x08c379a0aa')
    expect((err as EvmRpcError).message).toMatch(/reverted/)
  })

  it('throws a plain EvmRpcError on transport failure, with no revert data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const err = await ethGetCode(ADDR).catch(e => e as EvmRpcError)
    expect(err).toBeInstanceOf(EvmRpcError)
    expect((err as EvmRpcError).data).toBeUndefined()
  })

  it('fetches code via eth_getCode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6080' }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(ethGetCode(ADDR)).resolves.toBe('0x6080')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.method).toBe('eth_getCode')
    expect(body.params).toEqual([ADDR, 'latest'])
  })
})
