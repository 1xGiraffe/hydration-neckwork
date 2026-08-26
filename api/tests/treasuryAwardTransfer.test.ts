import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const materializedViews = source('../../clickhouse/schema/003_materialized_views.sql')
const explorerService = source('../src/services/explorerService.ts')

const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

const mvLine = (name: string): string =>
  materializedViews.split('\n').find(line => line.includes(`price_data.${name} `)) ?? ''

// A treasury spend reaches its beneficiary as `Balances.Deposit` + `Treasury.Awarded`
// with NO `from` account and NO extrinsic — the treasury pallet pays out on the spend
// period, unsigned. The transfer read model only understood the three transfer events,
// so a payout was invisible on every surface that reads it: the beneficiary's activity
// feed showed the account's later trades but never the funds arriving.
//
// This is a SECOND materialized view onto the same destination table rather than a
// widening of account_transfer_activity_mv. Two reasons: the existing MV is never
// dropped, so live ingestion cannot lose transfer rows during the deploy (a drop and
// recreate leaves a gap for every block landing in between, which is silent data loss
// rather than downtime); and `Treasury.Awarded` shares none of the other events' field
// names, so folding it in would mean branching all four extractions on event_name.
// price_data.pool_swap_legs already fans five MVs into one table for the same reason.
describe('treasury awards enter the transfer read model', () => {
  const mv = mvLine('account_transfer_activity_treasury_mv')

  it('is a separate MV that leaves the existing transfer MV untouched', () => {
    expect(mv).not.toBe('')
    expect(mv).toContain('TO price_data.account_transfer_activity ')
    // The original MV still covers exactly the three transfer events, unwidened.
    const original = mvLine('account_transfer_activity_mv')
    expect(original).toContain("WHERE event_name IN ('Balances.Transfer', 'Tokens.Transfer', 'Currencies.Transferred')")
    expect(original).not.toContain('Treasury.Awarded')
  })

  it('reads only Treasury.Awarded', () => {
    expect(mv).toContain("WHERE event_name = 'Treasury.Awarded'")
  })

  it('maps the pot as sender, the award as amount, and native HDX as the asset', () => {
    // Treasury.Awarded args are {proposalIndex, award, account} — no from/to/amount,
    // so every field is projected explicitly rather than by the shared JSONHas probes.
    expect(mv).toContain(`'${TREASURY_POT}' AS from_account`)
    expect(mv).toContain("JSONExtractString(args_json, 'account') AS to_account")
    expect(mv).toContain("JSONExtractString(args_json, 'award') AS amount")
    // The treasury spends the native token; the paired Balances.Deposit confirms it.
    expect(mv).toContain('toUInt32(0) AS asset_id')
  })

  it('emits one row per participant, matching the destination key', () => {
    // account_transfer_activity is ORDER BY (account, block_height, event_index) and the
    // feed reads it account-first, so both sides need their own row — same arrayJoin the
    // sibling MV uses. Two awards in one block differ by event_index, so the
    // ReplacingMergeTree key stays stable under replay.
    expect(mv).toContain('arrayJoin(arrayFilter(account -> (account != \'\'), arrayDistinct([from_account, to_account]))) AS account')
    expect(mv).toContain('event_index')
  })

  it('survives the feed filters that drop pallet-pot legs', () => {
    // The pot is deliberately absent from NOISY_TRANSFER_POTS, and the treasury filter
    // suppresses transfers INTO the pot only — outbound payouts are meant to show. If
    // either invariant changes, these rows silently vanish again.
    const noisy = explorerService.slice(
      explorerService.indexOf('const NOISY_TRANSFER_POTS'),
      explorerService.indexOf('const noisyPotList'),
    )
    expect(noisy).not.toContain(TREASURY_POT)
    expect(explorerService).toContain("AND NOT (to_account = '${TREASURY_POT}'")
  })
})
