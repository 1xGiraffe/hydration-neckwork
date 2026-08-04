import { afterEach, describe, expect, it, vi } from 'vitest'
import { ethCall, ethCallAt, ethEstimateGas, ethGasPrice, ethGetCode, ethGetTransactionReceipt, EvmRpcError } from '../src/evmRpc'

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

  it('estimates gas for a full tx object and parses the hex quantity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x5208' }) })
    vi.stubGlobal('fetch', fetchMock)
    const tx = { from: '0x' + '11'.repeat(20), to: ADDR, data: '0xd0e30db0', value: '0x1' }
    await expect(ethEstimateGas(tx)).resolves.toBe(21_000n)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.method).toBe('eth_estimateGas')
    expect(body.params).toEqual([tx])
  })

  it('keeps the revert payload on a failed estimate for decoding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x08c379a0ff' } }),
    }))
    const err = await ethEstimateGas({ to: ADDR, data: '0x' }).catch(e => e as EvmRpcError)
    expect(err).toBeInstanceOf(EvmRpcError)
    expect((err as EvmRpcError).data).toBe('0x08c379a0ff')
  })

  it('fetches the gas price as a bigint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(ethGasPrice()).resolves.toBe(1_000_000_000n)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.method).toBe('eth_gasPrice')
    expect(body.params).toEqual([])
  })

  it('answers null for a pending tx receipt and the object once mined', async () => {
    const receipt = { status: '0x1', blockNumber: '0x10', transactionHash: '0x' + 'aa'.repeat(32) }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(ethGetTransactionReceipt(receipt.transactionHash)).resolves.toBeNull()
    await expect(ethGetTransactionReceipt(receipt.transactionHash)).resolves.toEqual(receipt)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.method).toBe('eth_getTransactionReceipt')
    expect(body.params).toEqual([receipt.transactionHash])
  })

  it('replays a call with from/value at a specific block via ethCallAt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) })
    vi.stubGlobal('fetch', fetchMock)
    const tx = { from: '0x' + '11'.repeat(20), to: ADDR, data: '0xd0e30db0' }
    await expect(ethCallAt(tx, '0x10')).resolves.toBe('0x')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.method).toBe('eth_call')
    expect(body.params).toEqual([tx, '0x10'])
  })
})
