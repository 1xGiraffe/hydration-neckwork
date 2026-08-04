import { describe, expect, it } from 'vitest'
import { writeFunctions } from '../src/abiShape'
import { encodeCall, parseArgs } from '../src/abiCodec'
import {
  hydrationChainParams, ensureHydrationChain, gasWithMargin, gasPriceWithMargin, parseWethValue, runEvmWrite,
} from '../src/contractWrite'
import type { WriteStage } from '../src/contractWrite'

const TO = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const FROM = '0x9a1c2b3d4e5f60718293a4b5c6d7e8f901234567'
const TX_HASH = '0x' + 'aa'.repeat(32)
const ORIGIN = 'https://hydration-explorer.neckwork.net'

const ABI = [
  { type: 'constructor', inputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'symbol', stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'event', name: 'Transfer', inputs: [] },
]

// A scriptable EIP-1193 provider that records every request — the write path
// is exercised entirely through this surface, so the tests double as a
// contract for what a real wallet will receive.
function mockProvider(handler: (method: string, params?: unknown[]) => unknown) {
  const calls: { method: string; params?: unknown[] }[] = []
  return {
    calls,
    provider: {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push({ method, params })
        return handler(method, params)
      },
    },
  }
}

describe('writeFunctions', () => {
  it('lists nonpayable and payable functions in ABI order, nothing else', () => {
    const fns = writeFunctions(ABI)
    expect(fns.map(f => f.name)).toEqual(['transfer', 'deposit'])
    expect(fns[0].stateMutability).toBe('nonpayable')
    expect(fns[1].stateMutability).toBe('payable')
  })

  it('answers empty for a non-array ABI', () => {
    expect(writeFunctions(undefined)).toEqual([])
    expect(writeFunctions({})).toEqual([])
  })
})

describe('calldata encoding vectors', () => {
  it('encodes transfer(address,uint256) to the exact known calldata', () => {
    const fn = writeFunctions(ABI)[0]
    const args = parseArgs(fn, ['0x9A1C2B3D4E5F60718293A4B5C6D7E8F901234567', '1000'])
    expect(encodeCall(fn, args)).toBe(
      '0xa9059cbb'
      + '0000000000000000000000009a1c2b3d4e5f60718293a4b5c6d7e8f901234567'
      + '00000000000000000000000000000000000000000000000000000000000003e8',
    )
  })

  it('encodes a parameterless payable function to its bare selector', () => {
    const fn = writeFunctions(ABI)[1]
    expect(encodeCall(fn, [])).toBe('0xd0e30db0')   // keccak('deposit()')[0..4]
  })
})

describe('hydrationChainParams', () => {
  it('carries exactly the §7.5 wallet_addEthereumChain parameters', () => {
    expect(hydrationChainParams(ORIGIN)).toEqual({
      chainId: '0x3640e',
      chainName: 'Hydration',
      nativeCurrency: { name: 'WETH', symbol: 'WETH', decimals: 18 },
      rpcUrls: ['https://hydration-rpc.neckwork.net'],
      blockExplorerUrls: [ORIGIN],
    })
  })
})

describe('ensureHydrationChain', () => {
  it('switches without adding when the wallet already knows the chain', async () => {
    const { provider, calls } = mockProvider(() => null)
    await ensureHydrationChain(provider, ORIGIN)
    expect(calls.map(c => c.method)).toEqual(['wallet_switchEthereumChain'])
    expect(calls[0].params).toEqual([{ chainId: '0x3640e' }])
  })

  it('adds the chain on 4902, then switches again', async () => {
    let switches = 0
    const { provider, calls } = mockProvider(method => {
      if (method === 'wallet_switchEthereumChain' && ++switches === 1) {
        throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
      }
      return null
    })
    await ensureHydrationChain(provider, ORIGIN)
    expect(calls.map(c => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain'])
    expect(calls[1].params).toEqual([hydrationChainParams(ORIGIN)])
  })

  it('propagates a user rejection instead of trying to add the chain', async () => {
    const { provider, calls } = mockProvider(() => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    })
    await expect(ensureHydrationChain(provider, ORIGIN)).rejects.toMatchObject({ code: 4001 })
    expect(calls.map(c => c.method)).toEqual(['wallet_switchEthereumChain'])
  })
})

describe('gasWithMargin', () => {
  it('adds a 25% margin with integer math', () => {
    expect(gasWithMargin(100_000n)).toBe(125_000n)
    expect(gasWithMargin(21_000n)).toBe(26_250n)
    expect(gasWithMargin(0n)).toBe(0n)
  })
})

describe('gasPriceWithMargin', () => {
  it('adds the same 25% ceiling over eth_gasPrice, so a base fee that ticks up mid-flight still fits', () => {
    expect(gasPriceWithMargin(6_468_984n)).toBe(8_086_230n)
    expect(gasPriceWithMargin(1_000_000_000n)).toBe(1_250_000_000n)
    expect(gasPriceWithMargin(0n)).toBe(0n)
  })
})

describe('parseWethValue', () => {
  it('parses whole and fractional WETH into wei with string math', () => {
    expect(parseWethValue('')).toBe(0n)
    expect(parseWethValue('0')).toBe(0n)
    expect(parseWethValue('1')).toBe(10n ** 18n)
    expect(parseWethValue('1.5')).toBe(1_500_000_000_000_000_000n)
    expect(parseWethValue('0.000000000000000001')).toBe(1n)
    // 19 significant fractional digits would silently truncate — reject.
    expect(() => parseWethValue('0.0000000000000000001')).toThrow(/18/)
  })

  it('rejects non-numeric and negative values with a user-facing message', () => {
    expect(() => parseWethValue('abc')).toThrow(/WETH/)
    expect(() => parseWethValue('-1')).toThrow(/WETH/)
    expect(() => parseWethValue('1.2.3')).toThrow(/WETH/)
  })
})

describe('runEvmWrite lifecycle', () => {
  const rpcWith = (receipts: (null | { status: string; blockNumber: string; transactionHash: string })[], callError?: unknown) => {
    let i = 0
    return {
      getTransactionReceipt: async () => receipts[Math.min(i++, receipts.length - 1)],
      call: async () => { if (callError) throw callError; return '0x' },
    }
  }

  it('walks wallet-pending → submitted → in-block → success and sends the exact tx', async () => {
    const stages: WriteStage[] = []
    const { provider, calls } = mockProvider(method => {
      if (method === 'eth_sendTransaction') return TX_HASH
      return null
    })
    const final = await runEvmWrite({
      provider, from: FROM, to: TO, data: '0xd0e30db0', valueWei: 0n, explorerOrigin: ORIGIN,
      rpc: rpcWith([null, { status: '0x1', blockNumber: '0x10', transactionHash: TX_HASH }]),
      decodeRevert: () => null,
      onStage: s => stages.push(s),
      pollMs: 0,
    })
    expect(stages.map(s => s.phase)).toEqual(['wallet-pending', 'submitted', 'in-block', 'success'])
    expect(final).toEqual({ phase: 'success', txHash: TX_HASH, blockHeight: 16 })
    const send = calls.find(c => c.method === 'eth_sendTransaction')!
    expect(send.params).toEqual([{ from: FROM, to: TO, data: '0xd0e30db0' }])
  })

  it('carries a payable value as hex wei', async () => {
    const { provider, calls } = mockProvider(method => (method === 'eth_sendTransaction' ? TX_HASH : null))
    await runEvmWrite({
      provider, from: FROM, to: TO, data: '0xd0e30db0', valueWei: 1_500_000_000_000_000_000n, explorerOrigin: ORIGIN,
      rpc: rpcWith([{ status: '0x1', blockNumber: '0x10', transactionHash: TX_HASH }]),
      decodeRevert: () => null, onStage: () => {}, pollMs: 0,
    })
    const send = calls.find(c => c.method === 'eth_sendTransaction')!
    expect(send.params).toEqual([{ from: FROM, to: TO, data: '0xd0e30db0', value: '0x14d1120d7b160000' }])
  })

  it('decodes the revert of a mined-but-failed tx by replaying the call at its block', async () => {
    const stages: WriteStage[] = []
    const { provider } = mockProvider(method => (method === 'eth_sendTransaction' ? TX_HASH : null))
    const final = await runEvmWrite({
      provider, from: FROM, to: TO, data: '0xd0e30db0', valueWei: 0n, explorerOrigin: ORIGIN,
      rpc: rpcWith([{ status: '0x0', blockNumber: '0x10', transactionHash: TX_HASH }], Object.assign(new Error('execution reverted'), { data: '0x08c379a0' })),
      decodeRevert: data => (data === '0x08c379a0' ? 'ERC20: transfer amount exceeds balance' : null),
      onStage: s => stages.push(s),
      pollMs: 0,
    })
    expect(stages.map(s => s.phase)).toEqual(['wallet-pending', 'submitted', 'in-block', 'reverted'])
    expect(final).toEqual({ phase: 'reverted', txHash: TX_HASH, blockHeight: 16, reason: 'ERC20: transfer amount exceeds balance' })
  })

  it('reports a wallet rejection as failed without polling', async () => {
    const stages: WriteStage[] = []
    const { provider } = mockProvider(method => {
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      return null
    })
    const final = await runEvmWrite({
      provider, from: FROM, to: TO, data: '0xd0e30db0', valueWei: 0n, explorerOrigin: ORIGIN,
      rpc: rpcWith([null]), decodeRevert: () => null, onStage: s => stages.push(s), pollMs: 0,
    })
    expect(final.phase).toBe('failed')
    expect((final as { error: string }).error).toMatch(/rejected/i)
    expect(stages.map(s => s.phase)).toEqual(['wallet-pending', 'failed'])
  })

  it('stays on submitted when the receipt never lands within the poll budget', async () => {
    const { provider } = mockProvider(method => (method === 'eth_sendTransaction' ? TX_HASH : null))
    const final = await runEvmWrite({
      provider, from: FROM, to: TO, data: '0xd0e30db0', valueWei: 0n, explorerOrigin: ORIGIN,
      rpc: rpcWith([null]), decodeRevert: () => null, onStage: () => {}, pollMs: 0, maxPolls: 3,
    })
    expect(final).toEqual({ phase: 'submitted', txHash: TX_HASH })
  })
})
