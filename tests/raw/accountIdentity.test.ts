import { describe, expect, it } from 'vitest'
import {
  aliasRowsForEvmParticipants,
  aliasRowsForBoundEvent,
  dedupeAliasRows,
  deriveTruncatedAccountId,
  normalizeAccountId,
} from '../../src/raw/accountIdentity.ts'
import type { RawEvent } from '../../src/raw/processor.ts'

const EVM_ADDRESS = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'
const SUBSCAN_SUBSTRATE_ADDRESS = '12ZuLmV5gJsqomPABtWHGMgrwoWx4sEYeEEM3tDGdRXNqKys'
const TRUNCATED_ACCOUNT = '0x45544800f34e845538cc8a498edd97d7cde16fdfef3d4d990000000000000000'
// The account the Bound event actually names — a real AccountId32, not the
// truncated placeholder derived from the H160.
const BOUND_ACCOUNT = '0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809'

function boundEvent(): RawEvent {
  return {
    name: 'EVMAccounts.Bound',
    index: 7,
    extrinsicIndex: 2,
    block: { height: 123 },
    args: { account: BOUND_ACCOUNT, address: EVM_ADDRESS },
  } as RawEvent
}

const replacementKey = (row: { block_height: number; primary_profile: string; alias_type: string; alias_value: string }) =>
  `${row.block_height} ${row.primary_profile} ${row.alias_type} ${row.alias_value}`

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

  // raw_account_aliases replaces on (block_height, primary_profile, alias_type,
  // alias_value) and is blind to account_id/confidence, so a block that both binds
  // an address and logs it emits two rows for one key. Without a deliberate
  // collapse the winner is whichever ingested_at ClickHouse happens to prefer, and
  // losing the binding renders a named account as a bare H160.
  it('keeps the explicit binding when a block also logs the bound address', () => {
    const bound = aliasRowsForBoundEvent(boundEvent(), '2026-01-01 00:00:00', 'test')
    const observed = aliasRowsForEvmParticipants([EVM_ADDRESS], 123, '2026-01-01 00:00:00', 9, 'test', 3)

    // The collision is real: both sets claim the same replacement key.
    const collision = `123 evm:${EVM_ADDRESS} evm_address ${EVM_ADDRESS}`
    expect(bound.map(replacementKey)).toContain(collision)
    expect(observed.map(replacementKey)).toContain(collision)

    const rows = dedupeAliasRows([...bound, ...observed])

    const keys = rows.map(replacementKey)
    expect(new Set(keys).size).toBe(keys.length)

    const survivor = rows.find(row => replacementKey(row) === collision)
    expect(survivor?.account_id).toBe(BOUND_ACCOUNT)
    expect(survivor?.relationship).toBe('explicit_binding')
    expect(survivor?.confidence).toBe(1)
  })

  it('collapses a repeated participant address to its earliest event in the block', () => {
    const first = aliasRowsForEvmParticipants([EVM_ADDRESS], 123, '2026-01-01 00:00:00', 4, 'test', 1)
    const second = aliasRowsForEvmParticipants([EVM_ADDRESS], 123, '2026-01-01 00:00:00', 11, 'test', 2)

    const rows = dedupeAliasRows([...first, ...second])

    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.event_index === 4)).toBe(true)
  })
})
