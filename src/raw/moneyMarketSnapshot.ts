import type { RawMoneyMarketPositionRow } from './types.js'

export function moneyMarketSweepHasNoSuccess(positionRows: number, warningRows: number): boolean {
  return positionRows === 0 && warningRows > 0
}

// One (market, holder) pair as a set member, both halves lowercase — the identity
// the open-position set below is keyed on.
export function openPositionKey(poolProxy: string, userAddress: string): string {
  return `${poolProxy.toLowerCase()}:${userAddress.toLowerCase()}`
}

// Whether an aggregate observation states a position at all: Aave answers
// getUserAccountData with zeroed totals for an account that is not a user.
export function isZeroPosition(position: Pick<RawMoneyMarketPositionRow, 'total_collateral_base' | 'total_debt_base'>): boolean {
  return position.total_collateral_base === '0' && position.total_debt_base === '0'
}

// Fold a batch of observations into the set of open (market, holder) pairs: a
// non-zero aggregate opens the pair, an all-zero one closes it. A batch is one
// block's reads (or one sweep's, at one block), so a holder's several rows in it
// are the same state and their order does not matter.
export function trackOpenPositions(
  open: Set<string>,
  positions: Iterable<Pick<RawMoneyMarketPositionRow, 'pool_address' | 'user_address' | 'total_collateral_base' | 'total_debt_base'>>,
): void {
  for (const position of positions) {
    if (!position.user_address) continue
    const key = openPositionKey(position.pool_address, position.user_address)
    if (isZeroPosition(position)) open.delete(key)
    else open.add(key)
  }
}
