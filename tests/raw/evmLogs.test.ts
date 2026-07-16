import { keccakAsHex } from '@polkadot/util-crypto'
import { describe, expect, it } from 'vitest'
import { decodeEvmLog, extractEvmLogs } from '../../src/raw/evmLogs.ts'
import type { RawEvent } from '../../src/raw/processor.ts'

function topicAddress(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`.toLowerCase()
}

function uintWord(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, '0')
}

describe('raw EVM log decoder', () => {
  it('decodes current Money Market Supply logs', () => {
    const reserve = '0x00000000000000000000000000000000000003e8'
    const user = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'
    const onBehalfOf = '0x1111111111111111111111111111111111111111'
    const topic0 = keccakAsHex('Supply(address,address,address,uint256,uint16)').toLowerCase()

    const decoded = decodeEvmLog({
      topics: [
        topic0,
        topicAddress(reserve),
        topicAddress(onBehalfOf),
        `0x${uintWord(0)}`,
      ],
      data: `0x${topicAddress(user).slice(2)}${uintWord(123n)}`,
    })

    expect(decoded.decodeStatus).toBe('decoded')
    expect(decoded.eventName).toBe('Supply')
    expect(decoded.decodedArgs.reserve).toBe(reserve)
    expect(decoded.decodedArgs.user).toBe(user)
    expect(decoded.decodedArgs.onBehalfOf).toBe(onBehalfOf)
    expect(decoded.decodedArgs.amount).toBe('123')
    expect(decoded.assets).toEqual([reserve])
    expect(decoded.participants).toEqual([user, onBehalfOf])
  })

  it('keeps unknown topics as undecoded warnings', () => {
    const decoded = decodeEvmLog({
      topics: [`0x${'11'.repeat(32)}`],
      data: '0x',
    })

    expect(decoded.decodeStatus).toBe('undecoded')
    expect(decoded.warning).toContain('No configured ABI')
  })

  it('rejects out-of-range byte arrays instead of truncating them', () => {
    const event = {
      name: 'EVM.Log',
      index: 1,
      block: { height: 1 },
      args: {
        log: {
          address: `0x${'11'.repeat(20)}`,
          topics: [[256]],
          data: [],
        },
      },
    } as unknown as RawEvent

    expect(extractEvmLogs([event], '2026-07-11 00:00:00', 'test')).toEqual([])
  })
})
