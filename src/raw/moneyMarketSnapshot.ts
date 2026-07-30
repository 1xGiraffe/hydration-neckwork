export function moneyMarketSweepHasNoSuccess(positionRows: number, warningRows: number): boolean {
  return positionRows === 0 && warningRows > 0
}
