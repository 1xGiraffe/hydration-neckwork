import { describe, expect, it } from 'vitest'
import {
  accountBorrowInterestSql,
  assetReserveMintsSql,
  distributeUsd1e12,
} from '../src/services/borrowAttribution.ts'
import { attributablePayerSql } from '../src/services/revenueStreams.ts'

describe('accountBorrowInterestSql', () => {
  const sql = accountBorrowInterestSql()

  it('uses RAY in string form and FINAL on every ReplacingMergeTree source', () => {
    expect(sql).toContain("toUInt256('1000000000000000000000000000')")
    expect(sql).not.toMatch(/1e27|10 \*\* 27/)
    // A table alias may sit between the name and FINAL, but FINAL may not go
    // missing: without it a replayed range double-counts every delta.
    expect(sql).toMatch(/atoken_scaled_deltas_by_contract(\s+AS\s+\w+)?\s+FINAL/)
    expect(sql).toMatch(/atoken_reserve_map(\s+AS\s+\w+)?\s+FINAL/)
    expect(sql).toMatch(/atoken_scaled_anchor(\s+AS\s+\w+)?\s+FINAL/)
  })

  it('scopes to the reserve debt-token set from atoken_reserve_map', () => {
    // 38 contracts emit Mint chain-wide; an unscoped read would count random
    // ERC-20s as debt.
    expect(sql).toContain("vdebt != ''")
    expect(sql).toContain('lower(asset_address) = {reserve:String}')
    expect(sql).toMatch(/IN \(SELECT contract FROM vdebts\)/)
  })

  it('applies the anchor only to windows that start after it', () => {
    // Pre-B0 windows reconstruct from deltas alone (the measured-fidelity
    // recipe); adding the B0 anchor to them would double the opening balance.
    expect(sql).toContain('anchor_applies')
    expect(sql).toContain('block_height > (SELECT b FROM b0)')
  })

  it('books principal flows with the exact atoken_scaled_deltas event semantics', () => {
    // Mint.value INCLUDES balanceIncrease, Burn.value EXCLUDES it — the same
    // convention the atoken_scaled_deltas MVs in
    // clickhouse/schema/003_materialized_views.sql apply; mixing them up
    // misattributes every repayment's realized interest as principal.
    expect(sql).toMatch(/Mint',[\s\S]*value[\s\S]*-[\s\S]*balanceIncrease/)
    expect(sql).toMatch(/value[\s\S]*\+[\s\S]*balanceIncrease/)
  })

  it('maps holders to the ETH-mapped substrate account form and clamps dust negatives', () => {
    expect(sql).toContain("concat('0x45544800', substring(lower(holder), 3), '0000000000000000')")
    expect(sql).toContain('greatest(')
  })

  it('blanks protocol-internal holders through the shared payer predicate', () => {
    // The revenue streams and this surface must recognise the SAME protocol
    // actors — pallet accounts (here in their ETH-mapped form, since a pallet
    // holding debt does so through its truncated H160) and the runtime
    // executor. They still weigh (conservation), but never appear as payers.
    // Restating the rule here is how the two silently drifted apart before.
    expect(sql).toContain(attributablePayerSql('mapped'))
    expect(sql).toContain("startsWith(mapped, '0x455448006d6f646c')")
    // The executor's H160 mapped back is exactly the account the streams list.
    expect(sql).toContain('0x45544800000000000000000000000000000000000000090a0000000000000000')
  })
})

describe('assetReserveMintsSql', () => {
  it('windows each mint against the previous mint on the same reserve', () => {
    const sql = assetReserveMintsSql()
    expect(sql).toContain("event_name = 'MintedToTreasury'")
    expect(sql).toContain('lagInFrame')
    expect(sql).toContain('PARTITION BY reserve')
    // Epoch default: a reserve's first mint attributes over its whole history.
    expect(sql).toContain('toDateTime(0)')
  })
})

describe('distributeUsd1e12', () => {
  it('conserves the total exactly under floor rounding', () => {
    const total = 1_000_000_000_001n // an amount no 3-way split divides evenly
    const shares = distributeUsd1e12(total, [
      { account: 'a', weight: 1n },
      { account: 'b', weight: 1n },
      { account: 'c', weight: 1n },
    ])
    const sum = [...shares.values()].reduce((x, y) => x + y, 0n)
    expect(sum).toBe(total)
    expect(shares.size).toBe(3)
  })

  it('is proportional to the weights', () => {
    const shares = distributeUsd1e12(100n, [
      { account: 'a', weight: 3n },
      { account: 'b', weight: 1n },
    ])
    expect(shares.get('a')).toBe(75n)
    expect(shares.get('b')).toBe(25n)
  })

  it('attributes a weightless total to the empty account, never scaling it onto payers', () => {
    const shares = distributeUsd1e12(500n, [])
    expect(shares.get('')).toBe(500n)
    const zeroWeights = distributeUsd1e12(500n, [{ account: 'a', weight: 0n }])
    expect(zeroWeights.get('')).toBe(500n)
    expect(zeroWeights.has('a')).toBe(false)
  })

  it('accumulates repeated accounts and drops non-positive totals', () => {
    const shares = distributeUsd1e12(10n, [
      { account: 'a', weight: 1n },
      { account: 'a', weight: 1n },
    ])
    expect(shares.get('a')).toBe(10n)
    expect(distributeUsd1e12(0n, [{ account: 'a', weight: 1n }]).size).toBe(0)
  })
})
