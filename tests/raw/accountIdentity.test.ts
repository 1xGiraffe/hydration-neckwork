import { describe, expect, it } from 'vitest'
import {
  aliasRowsForEvmParticipants,
  aliasRowsForBoundEvent,
  deriveTruncatedAccountId,
  normalizeAccountId,
} from '../../src/raw/accountIdentity.ts'
import type { RawEvent } from '../../src/raw/processor.ts'

const EVM_ADDRESS = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'
const SUBSCAN_SUBSTRATE_ADDRESS = '12ZuLmV5gJsqomPABtWHGMgrwoWx4sEYeEEM3tDGdRXNqKys'
const TRUNCATED_ACCOUNT = '0x45544800f34e845538cc8a498edd97d7cde16fdfef3d4d990000000000000000'

describe('raw account identity', () => {
  it('derives Hydration truncated EVM AccountId32 aliases', () => {
    expect(deriveTruncatedAccountId(EVM_ADDRESS)).toBe(TRUNCATED_ACCOUNT)
  })

  it('normalizes the Subscan EVM/Substrate example pair', () => {
    expect(normalizeAccountId(SUBSCAN_SUBSTRATE_ADDRESS)).toBe(TRUNCATED_ACCOUNT)
  })

  it('emits EVM-primary aliases for explicit Bound events', () => {
    const event = {
      name: 'EVMAccounts.Bound',
      index: 7,
      extrinsicIndex: 2,
      block: { height: 123 },
      args: {
        account: SUBSCAN_SUBSTRATE_ADDRESS,
        address: EVM_ADDRESS,
      },
    } as RawEvent

    const rows = aliasRowsForBoundEvent(event, '2026-01-01 00:00:00', 'test')

    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.primary_profile)).toEqual([
      `evm:${EVM_ADDRESS}`,
      `evm:${EVM_ADDRESS}`,
      `evm:${EVM_ADDRESS}`,
    ])
    expect(rows.some(row => row.relationship === 'explicit_binding')).toBe(true)
    expect(rows.some(row => row.alias_type === 'evm_truncated_account_id' && row.alias_value === TRUNCATED_ACCOUNT)).toBe(true)
  })

  it('preserves source extrinsic indexes for EVM participant aliases', () => {
    const rows = aliasRowsForEvmParticipants(
      [EVM_ADDRESS],
      123,
      '2026-01-01 00:00:00',
      7,
      'test',
      2,
    )

    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.extrinsic_index === 2)).toBe(true)
  })
})
