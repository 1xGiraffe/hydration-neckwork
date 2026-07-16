import { describe, expect, it } from 'vitest'
import { accountSwapDestinationRows, type AccountSwapQueueRow } from '../src/db/accountSwapQueue.ts'

const queued: AccountSwapQueueRow = {
  queued_at: '2026-07-16 12:00:00.000',
  block_height: 42,
  event_index: 7,
  extrinsic_index: 3,
  block_timestamp: '2026-07-16 11:59:59',
  event_name: 'Router.Executed',
  asset_in: 0,
  asset_out: 5,
  amount_in: '1000000000000',
  amount_out: '2000000',
  ingested_at: '2026-07-16 12:00:00',
}

describe('account swap queue', () => {
  it('resolves a queued event from only its exact extrinsic tuple', () => {
    const rows = accountSwapDestinationRows([queued], [
      { block_height: 41, extrinsic_index: 3, signer: 'wrong', effective_signer: null },
      { block_height: 42, extrinsic_index: 3, signer: 'alice', effective_signer: null },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ account: 'alice', signer: 'alice', block_height: 42, event_index: 7 })
  })

  it('deduplicates identical signer forms and retains an effective signer', () => {
    const duplicate = accountSwapDestinationRows([queued], [
      { block_height: 42, extrinsic_index: 3, signer: 'alice', effective_signer: 'alice' },
    ])
    const effective = accountSwapDestinationRows([queued], [
      { block_height: 42, extrinsic_index: 3, signer: null, effective_signer: 'evm-alice' },
    ])

    expect(duplicate.map(row => row.account)).toEqual(['alice'])
    expect(effective.map(row => [row.account, row.signer])).toEqual([['evm-alice', 'evm-alice']])
  })
})
