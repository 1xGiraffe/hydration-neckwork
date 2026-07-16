import { xxhashAsHex } from '@polkadot/util-crypto'
import { describe, expect, it } from 'vitest'
import { decodeBalanceStorageKey, extractBalanceObservations } from '../../src/raw/balance.ts'
import * as systemStorage from '../../src/types/system/storage.ts'
import type { RawEvent } from '../../src/raw/processor.ts'
import type { RawCall } from '../../src/raw/processor.ts'
import type { Block as StorageBlock } from '../../src/types/support.ts'

const ACCOUNT = '0x45544800f34e845538cc8a498edd97d7cde16fdfef3d4d990000000000000000'

function storagePrefix(pallet: string, item: string): string {
  return `${xxhashAsHex(pallet, 128)}${xxhashAsHex(item, 128).slice(2)}`.toLowerCase()
}

function leU32(value: number): string {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer.toString('hex')
}

describe('raw balance storage key decoding', () => {
  it('extracts System.Account storage mutation evidence', () => {
    const key = `${storagePrefix('System', 'Account')}${'00'.repeat(16)}${ACCOUNT.slice(2)}`

    expect(decodeBalanceStorageKey(key)).toEqual({
      storageItem: 'System.Account',
      accountId: ACCOUNT,
      assetId: '0',
    })
  })

  it('extracts Tokens.Accounts storage mutation evidence', () => {
    const key = `${storagePrefix('Tokens', 'Accounts')}${'11'.repeat(16)}${ACCOUNT.slice(2)}${'22'.repeat(8)}${leU32(5)}`

    expect(decodeBalanceStorageKey(key)).toEqual({
      storageItem: 'Tokens.Accounts',
      accountId: ACCOUNT,
      assetId: '5',
    })
  })

})

describe('raw balance event extraction', () => {
  it('ignores raw EVM log payloads when collecting balance candidates', async () => {
    const block = {
      height: 2,
      hash: '0x01',
      _runtime: {
        checkStorageType: () => {
          throw new Error('balance storage should not be read for EVM.Log')
        },
      },
    } as unknown as StorageBlock
    const evmLog = {
      name: 'EVM.Log',
      index: 7,
      callAddress: [0],
      args: {
        log: {
          address: '0x1111111111111111111111111111111111111111',
          topics: [
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ACCOUNT,
          ],
          data: '0x',
        },
      },
    } as unknown as RawEvent

    const result = await extractBalanceObservations(
      block,
      '2026-06-19 00:00:00',
      [evmLog],
      [],
      'sqd',
    )

    expect(result).toEqual({
      observations: [],
      warnings: [],
    })
  })
})

describe('raw balance call extraction', () => {
  it('compacts Balances.upgrade_accounts evidence instead of duplicating the account list', async () => {
    const block = { height: 42, hash: '0x2a' } as unknown as StorageBlock
    const originalIs = systemStorage.account.v205.is
    const originalGet = systemStorage.account.v205.get
    const originalDefault = systemStorage.account.v205.getDefault
    process.env.RAW_BALANCE_READ_BATCH_ENABLED = 'false'

    ;(systemStorage.account.v205 as unknown as { is: typeof originalIs }).is = () => true
    ;(systemStorage.account.v205 as unknown as { get: typeof originalGet }).get = async () => ({
      nonce: 0,
      consumers: 0,
      providers: 0,
      sufficients: 0,
      data: { free: 1n, reserved: 0n, frozen: 0n, flags: 0n },
    } as never)
    ;(systemStorage.account.v205 as unknown as { getDefault: typeof originalDefault }).getDefault = () => ({
      nonce: 0,
      consumers: 0,
      providers: 0,
      sufficients: 0,
      data: { free: 0n, reserved: 0n, frozen: 0n, flags: 0n },
    } as never)

    try {
      const accounts = [ACCOUNT, '0x' + '11'.repeat(32)]
      const call = {
        name: 'Balances.upgrade_accounts',
        id: '0',
        address: [0],
        block,
        args: { who: accounts, large: 'x'.repeat(2000) },
      } as unknown as RawCall

      const result = await extractBalanceObservations(
        block,
        '2026-06-19 00:00:00',
        [],
        [call],
        'sqd',
      )

      expect(result.warnings).toEqual([])
      expect(result.observations).toHaveLength(2)
      const evidence = JSON.parse(result.observations[0].evidence_json)
      expect(evidence).toEqual({
        call: 'Balances.upgrade_accounts',
        call_address: '0',
        args: {
          accounts_count: 2,
          args_omitted: true,
          reason: 'large account list stored in raw_calls.args_json',
        },
      })
      expect(result.observations[0].evidence_json.length).toBeLessThan(200)
    } finally {
      ;(systemStorage.account.v205 as unknown as { is: typeof originalIs }).is = originalIs
      ;(systemStorage.account.v205 as unknown as { get: typeof originalGet }).get = originalGet
      ;(systemStorage.account.v205 as unknown as { getDefault: typeof originalDefault }).getDefault = originalDefault
      delete process.env.RAW_BALANCE_READ_BATCH_ENABLED
    }
  })
})
