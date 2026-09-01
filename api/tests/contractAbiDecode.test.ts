import { describe, it, expect } from 'vitest'
import { keccakAsHex } from '@polkadot/util-crypto'
import {
  buildAbiIndexes,
  decodeFunctionInput,
  decodeEventLog,
  decodeEvmCallSites,
  decodeEvmLogArgs,
  getContractAbiIndexes,
} from '../src/services/contractAbiDecode.ts'
import {
  initContractVerificationService,
  loadVerifiedContracts,
} from '../src/services/contractVerificationService.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'pause',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Transfer',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  { type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] },
  { type: 'error', name: 'NotOwner', inputs: [] },
]

// Known constants, independent of our keccak plumbing: a signature-computation
// bug (missing canonicalization, wrong separator) cannot survive these.
const TRANSFER_SELECTOR = '0xa9059cbb'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
const addrWord = (addr: string) => word(addr)
const ADDR_A = '0x00000000000000000000000000000000000000aa'
const ADDR_B = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'

describe('buildAbiIndexes', () => {
  it('indexes functions by selector and events by topic0', () => {
    const idx = buildAbiIndexes(ERC20_ABI)
    const fn = idx.functionsBySelector.get(TRANSFER_SELECTOR)
    expect(fn?.name).toBe('transfer')
    expect(fn?.signature).toBe('transfer(address,uint256)')
    const ev = idx.eventsByTopic0.get(TRANSFER_TOPIC0)
    expect(ev?.name).toBe('Transfer')
    expect(ev?.signature).toBe('Transfer(address,address,uint256)')
  })

  it('ignores constructors, errors, and anonymous events', () => {
    const idx = buildAbiIndexes([
      ...ERC20_ABI,
      { type: 'event', name: 'Ghost', anonymous: true, inputs: [{ name: 'x', type: 'uint256', indexed: false }] },
    ])
    expect(idx.functionsBySelector.size).toBe(2)
    expect(idx.eventsByTopic0.size).toBe(1)
  })

  it('canonicalizes uint/int aliases and tuples in signatures', () => {
    const idx = buildAbiIndexes([
      {
        type: 'function',
        name: 'submit',
        inputs: [
          { name: 'n', type: 'uint' },
          {
            name: 'pair',
            type: 'tuple',
            components: [
              { name: 'a', type: 'address' },
              { name: 'bs', type: 'int[]' },
            ],
          },
        ],
      },
    ])
    const selector = `0x${keccakAsHex('submit(uint256,(address,int256[]))').slice(2, 10)}`
    expect(idx.functionsBySelector.get(selector)?.signature).toBe('submit(uint256,(address,int256[]))')
  })

  it('returns empty indexes for malformed ABI json', () => {
    for (const junk of [null, 42, 'abi', { abi: [] }, [{ type: 'function' }]]) {
      const idx = buildAbiIndexes(junk)
      expect(idx.functionsBySelector.size).toBe(0)
      expect(idx.eventsByTopic0.size).toBe(0)
    }
  })
})

describe('decodeFunctionInput', () => {
  const idx = buildAbiIndexes(ERC20_ABI)

  it('decodes transfer(address,uint256) calldata', () => {
    const input = `${TRANSFER_SELECTOR}${addrWord(ADDR_B)}${word('f4240')}`
    const out = decodeFunctionInput(idx, input)
    expect(out).toEqual({
      decoded: true,
      name: 'transfer',
      signature: 'transfer(address,uint256)',
      selector: TRANSFER_SELECTOR,
      params: [
        { name: 'to', type: 'address', value: ADDR_B },
        { name: 'value', type: 'uint256', value: '1000000' },
      ],
    })
  })

  it('decodes a zero-argument call', () => {
    const selector = `0x${keccakAsHex('pause()').slice(2, 10)}`
    expect(decodeFunctionInput(idx, selector)).toEqual({
      decoded: true,
      name: 'pause',
      signature: 'pause()',
      selector,
      params: [],
    })
  })

  it('decodes dynamic strings (DIA setValue shape)', () => {
    const dia = buildAbiIndexes([
      {
        type: 'function',
        name: 'setValue',
        inputs: [
          { name: 'key', type: 'string' },
          { name: 'value', type: 'uint128' },
          { name: 'timestamp', type: 'uint128' },
        ],
      },
    ])
    const selector = `0x${keccakAsHex('setValue(string,uint128,uint128)').slice(2, 10)}`
    const key = Buffer.from('HDX/USD', 'utf8').toString('hex')
    const input = [
      selector.slice(2),
      word('60'), // offset of string
      word('2540be400'), // 10_000_000_000
      word('68b0f2a0'),
      word('7'), // string length
      key.padEnd(64, '0'),
    ].join('')
    const out = decodeFunctionInput(dia, `0x${input}`)
    expect(out.decoded).toBe(true)
    if (out.decoded) {
      expect(out.signature).toBe('setValue(string,uint128,uint128)')
      expect(out.params.map(p => p.value)).toEqual(['HDX/USD', '10000000000', '1756426912'])
    }
  })

  it('decodes arrays and nested tuples', () => {
    const abi = buildAbiIndexes([
      {
        type: 'function',
        name: 'multi',
        inputs: [
          { name: 'targets', type: 'address[]' },
          {
            name: 'order',
            type: 'tuple',
            components: [
              { name: 'kind', type: 'uint8' },
              { name: 'flags', type: 'bool[2]' },
            ],
          },
        ],
      },
    ])
    const selector = `0x${keccakAsHex('multi(address[],(uint8,bool[2]))').slice(2, 10)}`
    const input = [
      selector.slice(2),
      word('80'), // offset of targets
      word('2'), // order.kind
      word('1'), // order.flags[0]
      word('0'), // order.flags[1]
      word('2'), // targets.length
      addrWord(ADDR_A),
      addrWord(ADDR_B),
    ].join('')
    const out = decodeFunctionInput(abi, `0x${input}`)
    expect(out.decoded).toBe(true)
    if (out.decoded) {
      expect(out.params[0].value).toEqual([ADDR_A, ADDR_B])
      expect(out.params[1].value).toEqual({ kind: '2', flags: [true, false] })
    }
  })

  it('decodes negative int256 as a signed decimal string', () => {
    const abi = buildAbiIndexes([
      { type: 'function', name: 'setAnswer', inputs: [{ name: 'answer', type: 'int256' }] },
    ])
    const selector = `0x${keccakAsHex('setAnswer(int256)').slice(2, 10)}`
    const out = decodeFunctionInput(abi, `${selector}${'f'.repeat(64)}`)
    expect(out.decoded).toBe(true)
    if (out.decoded) expect(out.params[0].value).toBe('-1')
  })

  it('falls back to selector-only when the selector is unknown', () => {
    expect(decodeFunctionInput(idx, `0xdeadbeef${word('1')}`)).toEqual({
      decoded: false,
      selector: '0xdeadbeef',
    })
  })

  it('falls back to selector-only on truncated arguments', () => {
    const input = `${TRANSFER_SELECTOR}${addrWord(ADDR_B)}` // uint256 word missing
    expect(decodeFunctionInput(idx, input)).toEqual({ decoded: false, selector: TRANSFER_SELECTOR })
  })

  it('returns decoded:false with a null selector for empty input', () => {
    expect(decodeFunctionInput(idx, '0x')).toEqual({ decoded: false, selector: null })
    expect(decodeFunctionInput(idx, '0xa9059c')).toEqual({ decoded: false, selector: null })
    expect(decodeFunctionInput(null, `${TRANSFER_SELECTOR}${addrWord(ADDR_B)}${word('1')}`)).toEqual({
      decoded: false,
      selector: TRANSFER_SELECTOR,
    })
  })

  it('returns decoded:false on unsupported parameter types, never a partial guess', () => {
    const abi = buildAbiIndexes([
      {
        type: 'function',
        name: 'oddball',
        inputs: [
          { name: 'a', type: 'uint256' },
          { name: 'f', type: 'fixed128x18' },
        ],
      },
    ])
    const selector = `0x${keccakAsHex('oddball(uint256,fixed128x18)').slice(2, 10)}`
    const out = decodeFunctionInput(abi, `${selector}${word('1')}${word('2')}`)
    expect(out).toEqual({ decoded: false, selector })
  })
})

describe('decodeEventLog', () => {
  const idx = buildAbiIndexes(ERC20_ABI)

  it('decodes indexed and non-indexed params by position', () => {
    const out = decodeEventLog(idx, [TRANSFER_TOPIC0, `0x${addrWord(ADDR_A)}`, `0x${addrWord(ADDR_B)}`], `0x${word('f4240')}`)
    expect(out).toEqual({
      decoded: true,
      name: 'Transfer',
      signature: 'Transfer(address,address,uint256)',
      decodedBy: 'verified-abi',
      params: [
        { name: 'from', type: 'address', value: ADDR_A, indexed: true },
        { name: 'to', type: 'address', value: ADDR_B, indexed: true },
        { name: 'value', type: 'uint256', value: '1000000' },
      ],
    })
  })

  it('represents indexed dynamic params as their topic hash', () => {
    const abi = buildAbiIndexes([
      {
        type: 'event',
        name: 'KeySet',
        anonymous: false,
        inputs: [
          { name: 'key', type: 'string', indexed: true },
          { name: 'value', type: 'uint256', indexed: false },
        ],
      },
    ])
    const topic0 = keccakAsHex('KeySet(string,uint256)').toLowerCase()
    const keyHash = keccakAsHex('HDX/USD').toLowerCase()
    const out = decodeEventLog(abi, [topic0, keyHash], `0x${word('5')}`)
    expect(out.decoded).toBe(true)
    if (out.decoded) {
      expect(out.params[0]).toEqual({ name: 'key', type: 'string', value: keyHash, indexed: true, hashed: true })
      expect(out.params[1].value).toBe('5')
    }
  })

  it('returns decoded:false for unknown topic0, topic-count mismatch, and short data', () => {
    expect(decodeEventLog(idx, [`0x${'11'.repeat(32)}`], '0x')).toEqual({ decoded: false })
    // Transfer expects 2 indexed topics
    expect(decodeEventLog(idx, [TRANSFER_TOPIC0, `0x${addrWord(ADDR_A)}`], `0x${word('1')}`)).toEqual({ decoded: false })
    // value word missing from data
    expect(decodeEventLog(idx, [TRANSFER_TOPIC0, `0x${addrWord(ADDR_A)}`, `0x${addrWord(ADDR_B)}`], '0x')).toEqual({ decoded: false })
    expect(decodeEventLog(null, [TRANSFER_TOPIC0], '0x')).toEqual({ decoded: false })
    expect(decodeEventLog(idx, [], '0x')).toEqual({ decoded: false })
  })
})

// The per-address index cache must rotate with `verifiedAt` (re-verification
// replaces the ABI without an eviction API) and must never issue more than the
// single primary-key ABI read per (address, verifiedAt).
describe('getContractAbiIndexes', () => {
  const ADDR = '0xdee629af973ebf5bf261ace12ffd1900ac715f5e'

  function fakeClient(abiJson: string, verifiedAt: string, queries: string[]): ClickHouseClient {
    return {
      query: async ({ query }: { query: string }) => {
        queries.push(query)
        return {
          json: async () => {
            if (query.includes('evm_logs_by_contract')) return []
            if (query.includes('FROM price_data.contract_abis')) {
              if (query.includes('abi_json !=')) {
                // verified-map load shape
                return [{
                  address: ADDR, contract_name: 'DIAOracleV2', compiler_version: 'v0.8.19',
                  match_type: 'PARTIAL', source: 'verified', code_hash: '0xcc',
                  verified_at: verifiedAt, abi_present: 1,
                }]
              }
              return [{ abi_json: abiJson, contract_name: 'DIAOracleV2', source: 'verified' }]
            }
            if (query.includes('FROM price_data.contract_sources')) return []
            throw new Error(`unexpected query: ${query}`)
          },
        }
      },
    } as unknown as ClickHouseClient
  }

  it('builds from the verified ABI, caches per verifiedAt, and rotates on re-verification', async () => {
    const queries: string[] = []
    initContractVerificationService(fakeClient(JSON.stringify(ERC20_ABI), '2026-08-04 10:00:00.000', queries))
    await loadVerifiedContracts()

    const first = await getContractAbiIndexes(ADDR)
    expect(first?.functionsBySelector.get(TRANSFER_SELECTOR)?.name).toBe('transfer')

    // Warm hit: no further ClickHouse reads for the same verifiedAt.
    const before = queries.length
    const again = await getContractAbiIndexes(ADDR.toUpperCase().replace('0X', '0x'))
    expect(again).toBe(first)
    expect(queries.length).toBe(before)

    // Re-verification bumps verifiedAt; the key rotates without eviction.
    const queries2: string[] = []
    const nextAbi = [{ type: 'function', name: 'setValue', inputs: [{ name: 'key', type: 'string' }] }]
    initContractVerificationService(fakeClient(JSON.stringify(nextAbi), '2026-08-05 11:00:00.000', queries2))
    await loadVerifiedContracts()
    const rotated = await getContractAbiIndexes(ADDR)
    expect(rotated?.functionsBySelector.get(TRANSFER_SELECTOR)).toBeUndefined()
    expect(rotated?.functionsBySelector.size).toBe(1)
  })

  it('returns null for unverified contracts without querying', async () => {
    const queries: string[] = []
    initContractVerificationService(fakeClient('[]', '2026-08-04 10:00:00.000', queries))
    await loadVerifiedContracts()
    queries.length = 0
    expect(await getContractAbiIndexes('0x' + '99'.repeat(20))).toBeNull()
    expect(queries).toEqual([])
  })
})

describe('proxy-aware decoding', () => {
  // keccak('Upgraded(address)') — the upgrade event the ERC1967/OZ/Aave proxy
  // families all emit. The vector is pinned independently below; the fake
  // client rejects a scan for any other topic, so production wiring is pinned
  // through behavior.
  const UPGRADED_TOPIC0 = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b'

  it('hashes Upgraded(address) to the pinned topic0', () => {
    expect(keccakAsHex('Upgraded(address)').toLowerCase()).toBe(UPGRADED_TOPIC0)
  })

  const topicAddr = (addr: string) => `0x${addrWord(addr)}`
  const transferEvent = (names: [string, string, string]) => ({
    type: 'event',
    name: 'Transfer',
    anonymous: false,
    inputs: [
      { name: names[0], type: 'address', indexed: true },
      { name: names[1], type: 'address', indexed: true },
      { name: names[2], type: 'uint256', indexed: false },
    ],
  })
  const PROXY_ABI = [
    {
      type: 'event',
      name: 'Upgraded',
      anonymous: false,
      inputs: [{ name: 'implementation', type: 'address', indexed: true }],
    },
  ]
  const transferLog = (emitter: string) => ({
    log: {
      address: emitter,
      topics: [TRANSFER_TOPIC0, topicAddr(ADDR_A), topicAddr(ADDR_B)],
      data: `0x${word('0de0b6b3a7640000')}`,
    },
  })

  // `upgraded` maps a scanned address to its Upgraded log topics, newest
  // upgrade first — the order the production scan query returns.
  function proxyFakeClient(
    contracts: { address: string; abi: unknown; source?: string }[],
    upgraded: Record<string, string[][]>,
  ): ClickHouseClient {
    return {
      query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({
        json: async () => {
          if (query.includes('evm_logs_by_contract')) {
            if (query_params?.topic0 !== UPGRADED_TOPIC0) throw new Error(`scan for unexpected topic0: ${query_params?.topic0}`)
            return (upgraded[String(query_params?.address)] ?? []).map(topics => ({ topics }))
          }
          if (query.includes('FROM price_data.contract_abis')) {
            if (query.includes('abi_json !=')) {
              return contracts.map(c => ({
                address: c.address, contract_name: 'X', compiler_version: 'v0.8.19',
                match_type: 'FULL', source: c.source ?? 'verified', code_hash: '0xcc',
                verified_at: '2026-08-31 10:00:00.000', abi_present: 1,
              }))
            }
            const c = contracts.find(c => c.address === String(query_params?.address))
            return c ? [{ abi_json: JSON.stringify(c.abi), contract_name: 'X', source: c.source ?? 'verified' }] : []
          }
          if (query.includes('FROM price_data.contract_sources')) return []
          throw new Error(`unexpected query: ${query}`)
        },
      }),
    } as unknown as ClickHouseClient
  }

  it('decodes a log emitted by a verified proxy through its implementation ABI', async () => {
    const PROXY = '0x' + 'a1'.repeat(20)
    const IMPL = '0x' + 'a2'.repeat(20)
    initContractVerificationService(proxyFakeClient(
      [{ address: PROXY, abi: PROXY_ABI }, { address: IMPL, abi: [transferEvent(['from', 'to', 'value'])] }],
      { [PROXY]: [[UPGRADED_TOPIC0, topicAddr(IMPL)]] },
    ))
    await loadVerifiedContracts()

    const decoded = await decodeEvmLogArgs(transferLog(PROXY))
    expect(decoded?.name).toBe('Transfer')
    expect(decoded?.params.map(p => p.name)).toEqual(['from', 'to', 'value'])
    expect(decoded?.params[2].value).toBe('1000000000000000000')

    // The proxy's own events still decode through its own ABI.
    const own = await decodeEvmLogArgs({ log: { address: PROXY, topics: [UPGRADED_TOPIC0, topicAddr(IMPL)], data: '0x' } })
    expect(own?.name).toBe('Upgraded')
  })

  it('prefers the proxy own ABI over the implementation on a signature collision', async () => {
    const PROXY = '0x' + 'b1'.repeat(20)
    const IMPL = '0x' + 'b2'.repeat(20)
    initContractVerificationService(proxyFakeClient(
      [
        { address: PROXY, abi: [transferEvent(['pFrom', 'pTo', 'pValue'])] },
        { address: IMPL, abi: [transferEvent(['from', 'to', 'value'])] },
      ],
      { [PROXY]: [[UPGRADED_TOPIC0, topicAddr(IMPL)]] },
    ))
    await loadVerifiedContracts()
    const decoded = await decodeEvmLogArgs(transferLog(PROXY))
    expect(decoded?.params.map(p => p.name)).toEqual(['pFrom', 'pTo', 'pValue'])
  })

  it('prefers the newest implementation when upgrades disagree', async () => {
    const PROXY = '0x' + 'c1'.repeat(20)
    const NEW_IMPL = '0x' + 'c2'.repeat(20)
    const OLD_IMPL = '0x' + 'c3'.repeat(20)
    initContractVerificationService(proxyFakeClient(
      [
        { address: PROXY, abi: PROXY_ABI },
        { address: NEW_IMPL, abi: [transferEvent(['nFrom', 'nTo', 'nValue'])] },
        { address: OLD_IMPL, abi: [transferEvent(['oFrom', 'oTo', 'oValue'])] },
      ],
      { [PROXY]: [[UPGRADED_TOPIC0, topicAddr(NEW_IMPL)], [UPGRADED_TOPIC0, topicAddr(OLD_IMPL)]] },
    ))
    await loadVerifiedContracts()
    const decoded = await decodeEvmLogArgs(transferLog(PROXY))
    expect(decoded?.params.map(p => p.name)).toEqual(['nFrom', 'nTo', 'nValue'])
  })

  it('ignores implementations without a decode-eligible verified ABI', async () => {
    const PROXY = '0x' + 'd1'.repeat(20)
    const UNVERIFIED_IMPL = '0x' + 'd2'.repeat(20)
    const MANUAL_IMPL = '0x' + 'd3'.repeat(20)
    initContractVerificationService(proxyFakeClient(
      [
        { address: PROXY, abi: PROXY_ABI },
        { address: MANUAL_IMPL, abi: [transferEvent(['from', 'to', 'value'])], source: 'manual' },
      ],
      { [PROXY]: [[UPGRADED_TOPIC0, topicAddr(MANUAL_IMPL)], [UPGRADED_TOPIC0, topicAddr(UNVERIFIED_IMPL)]] },
    ))
    await loadVerifiedContracts()
    expect(await decodeEvmLogArgs(transferLog(PROXY))).toBeNull()
  })

  it('decodes proxy-targeted calldata with the implementation ABI', async () => {
    const PROXY = '0x' + 'e1'.repeat(20)
    const IMPL = '0x' + 'e2'.repeat(20)
    const implAbi = [{
      type: 'function',
      name: 'transfer',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
      outputs: [],
    }]
    initContractVerificationService(proxyFakeClient(
      [{ address: PROXY, abi: PROXY_ABI }, { address: IMPL, abi: implAbi }],
      { [PROXY]: [[UPGRADED_TOPIC0, topicAddr(IMPL)]] },
    ))
    await loadVerifiedContracts()
    const input = `${TRANSFER_SELECTOR}${addrWord(ADDR_B)}${word('01')}`
    const [site] = await decodeEvmCallSites('EVM.call', { target: PROXY, input })
    expect(site?.call.decoded).toBe(true)
    expect(site?.call.decoded && site.call.name).toBe('transfer')
  })
})
