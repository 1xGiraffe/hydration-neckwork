import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectProxy,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  minimalProxyTarget,
  proxyKindLabel,
  slotAddress,
} from '../src/proxyDetect'

afterEach(() => {
  vi.unstubAllGlobals()
})

const PROXY = '0xfcaf4aa069c565d25539028970703f01e47d3e0b'
const IMPL = '0x5c87c0d56551149acbb7c7e637a90215810bbeb3'
const BEACON = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const WORD = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0')
const ZERO_WORD = '0x' + '0'.repeat(64)
const CLONE_CODE = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`

// A JSON-RPC transport answering by (method, params) — detectProxy runs its
// real request sequence against it.
function stubRpc(answer: (method: string, params: unknown[]) => unknown) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: answer(method, params) }) }
  }))
}

describe('slotAddress', () => {
  it('unpacks a left-padded address word', () => {
    expect(slotAddress(WORD(IMPL))).toBe(IMPL)
  })
  it('lowercases the address', () => {
    expect(slotAddress(WORD(IMPL.toUpperCase().replace('0X', '')))).toBe(IMPL)
  })
  it('rejects the zero word, dirty padding, short reads and garbage', () => {
    expect(slotAddress(ZERO_WORD)).toBeNull()
    expect(slotAddress('0x01' + WORD(IMPL).slice(4))).toBeNull()   // packed high bytes are not a plain address
    expect(slotAddress('0x0')).toBeNull()
    expect(slotAddress('0x')).toBeNull()
    expect(slotAddress(null)).toBeNull()
    expect(slotAddress(undefined)).toBeNull()
    expect(slotAddress(IMPL)).toBeNull()                           // bare address, not a storage word
  })
})

describe('minimalProxyTarget', () => {
  it('extracts the target from canonical EIP-1167 runtime code', () => {
    expect(minimalProxyTarget(CLONE_CODE)).toBe(IMPL)
  })
  it('rejects non-clone code, the zero target and prefixed variants', () => {
    expect(minimalProxyTarget('0x6080604052')).toBeNull()
    expect(minimalProxyTarget(`0x363d3d373d3d3d363d73${'0'.repeat(40)}5af43d82803e903d91602b57fd5bf3`)).toBeNull()
    expect(minimalProxyTarget(`0x00${CLONE_CODE.slice(2)}`)).toBeNull()
    expect(minimalProxyTarget(null)).toBeNull()
  })
})

describe('detectProxy', () => {
  it('resolves an EIP-1967 implementation slot', async () => {
    stubRpc((method, params) => {
      if (method === 'eth_getStorageAt' && (params as string[])[1] === EIP1967_IMPLEMENTATION_SLOT) return WORD(IMPL)
      return ZERO_WORD
    })
    await expect(detectProxy(PROXY)).resolves.toEqual({ kind: 'eip1967', implementation: IMPL })
  })

  it('resolves a beacon proxy by asking the beacon for implementation()', async () => {
    stubRpc((method, params) => {
      if (method === 'eth_getStorageAt') {
        return (params as string[])[1] === EIP1967_BEACON_SLOT ? WORD(BEACON) : ZERO_WORD
      }
      if (method === 'eth_call') {
        const tx = (params as [{ to: string; data: string }])[0]
        expect(tx.to).toBe(BEACON)
        expect(tx.data).toBe('0x5c60da1b')
        return WORD(IMPL)
      }
      return ZERO_WORD
    })
    await expect(detectProxy(PROXY)).resolves.toEqual({ kind: 'beacon', implementation: IMPL, beacon: BEACON })
  })

  it('resolves an EIP-1167 clone from its bytecode when both slots are empty', async () => {
    stubRpc(method => (method === 'eth_getCode' ? CLONE_CODE : ZERO_WORD))
    await expect(detectProxy(PROXY)).resolves.toEqual({ kind: 'eip1167', implementation: IMPL })
  })

  it('returns null for a plain contract', async () => {
    stubRpc(method => (method === 'eth_getCode' ? '0x6080604052' : ZERO_WORD))
    await expect(detectProxy(PROXY)).resolves.toBeNull()
  })

  it('returns null when the slot points back at the proxy itself', async () => {
    stubRpc((method, params) => {
      if (method === 'eth_getStorageAt' && (params as string[])[1] === EIP1967_IMPLEMENTATION_SLOT) return WORD(PROXY)
      return method === 'eth_getCode' ? '0x6080604052' : ZERO_WORD
    })
    await expect(detectProxy(PROXY)).resolves.toBeNull()
  })

  it('returns null when the beacon does not answer implementation()', async () => {
    stubRpc((method, params) => {
      if (method === 'eth_getStorageAt') {
        return (params as string[])[1] === EIP1967_BEACON_SLOT ? WORD(BEACON) : ZERO_WORD
      }
      if (method === 'eth_call') throw new Error('revert')
      return ZERO_WORD
    })
    await expect(detectProxy(PROXY)).resolves.toBeNull()
  })
})

describe('proxyKindLabel', () => {
  it('names each detection kind', () => {
    expect(proxyKindLabel('eip1967')).toBe('EIP-1967 proxy')
    expect(proxyKindLabel('beacon')).toBe('EIP-1967 beacon proxy')
    expect(proxyKindLabel('eip1167')).toBe('EIP-1167 minimal proxy')
  })
})
