import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(
  new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// Slice a top-level function by its signature up to the closing brace in column 0.
function bodyOf(signature: string): string {
  const start = explorerService.indexOf(signature)
  expect(start, `missing ${signature}`).toBeGreaterThan(-1)
  const end = explorerService.indexOf('\n}\n', start)
  expect(end, `unterminated ${signature}`).toBeGreaterThan(start)
  return explorerService.slice(start, end)
}

const SNAPSHOT_TABLE = 'money_market_account_value_snapshots'

// The published account-value snapshot is republished on a five-minute timer, and its
// aggregate rows are a verbatim copy of money_market_latest_positions (see
// buildMoneyMarketAccountValueClaims, which assigns healthFactor straight off the
// aggregate). An account page that read the snapshot therefore showed a borrow or
// repay only at the next republish: a measured 4m43s for a borrow that landed 17s
// after a refresh tick, against ~45s for the projection the snapshot copies from.
describe('money-market account detail reads the projection, not the snapshot', () => {
  const positions = bodyOf('async function getMoneyMarketPositions(h160: string)')
  const reserves = bodyOf('export async function getMoneyMarketReserves(h160: string)')

  it('reads aggregate position state from the insert-time projection', () => {
    expect(positions).toContain('latestMoneyMarketPositionsSql(')
    expect(positions).not.toContain(SNAPSHOT_TABLE)
  })

  it('reconstructs per-reserve balances per account', () => {
    expect(reserves).toContain('reconstructAccountScaled(')
    expect(reserves).not.toContain(SNAPSHOT_TABLE)
  })

  // Both must move together. attachMmReserves raises the card's displayed totals to
  // max(aggregate, reserve-derived), so a fresh aggregate beside five-minute-old
  // reserves would let a stale-high debt survive a repay — worse than either alone.
  it('gates neither path on the snapshot generation', () => {
    expect(positions).not.toContain('moneyMarketAccountValuesReady')
    expect(reserves).not.toContain('moneyMarketAccountValuesReady')
  })

  // The other direction: the snapshot is still the only global source of per-reserve
  // supplied/debt for every account at once, which the directory's value ranking folds
  // in via greatest(aggregate, sum(reserve rows)) to catch supplied-but-not-collateral
  // balances the aggregate omits. Dropping it would silently understate those accounts.
  it('leaves the accounts directory reading the snapshot', () => {
    const mmLatest = explorerService.slice(
      explorerService.indexOf('mm_latest AS ('),
      explorerService.indexOf('// Additive projections for a viewer'))
    expect(mmLatest).toContain(SNAPSHOT_TABLE)
    expect(mmLatest).toContain('reserve_present=1')
  })
})
