import { describe, expect, it } from 'vitest'
import { liquidationPointsFromPositions, oraclePriceFromPositions } from '../src/services/explorerService.ts'

// A gigahdx position is liquidatable once its collateral, valued by the
// MARKET's own oracle, stops covering the debt at the liquidation threshold.
// That level is debt / (collateral × LT) — no price term — and is then divided
// by the staking exchange rate to become the HDX price a reader compares
// against. The earlier derivation, spot / HF, mixed two different prices: HF is
// computed against the market's oracle, and that oracle lags Omnipool spot.
describe('liquidationPointsFromPositions', () => {
  const row = (collateral: number, debtUsd: number, ltBps = 7000) => ({
    total_debt_base: String(Math.round(debtUsd * 1e8)),
    current_liquidation_threshold: String(ltBps),
    collateral,
  })

  it('derives the level from debt, collateral and the threshold alone', () => {
    // 1,000 stHDX at 70% covers $350 of debt at $0.50/stHDX.
    const pts = liquidationPointsFromPositions([row(1000, 350)], 1)

    expect(pts).toHaveLength(1)
    expect(pts[0].price).toBeCloseTo(0.5, 9)
    expect(pts[0].stHdx).toBe(1000)
  })

  it('reports the collateral as its real stHDX balance, not a USD reconstruction', () => {
    const [point] = liquidationPointsFromPositions([row(24_306_115.31, 100_175.07)], 1.008318)

    expect(point.stHdx).toBeCloseTo(24_306_115.31, 2)
  })

  // The live position of 16RzrHH1jL7efbnePgavurfbxokXTic688omnDPcxTumhpLX,
  // which app.hydration.net renders as 0.005839 HOLLAR/HDX.
  it('converts the level from stHDX to HDX through the staking rate', () => {
    const [point] = liquidationPointsFromPositions([row(24_306_115.311310677, 100_175.07444676)], 1.00831805)

    expect(point.price).toBeCloseTo(0.005839, 6)
    // Undivided it would be the price per stHDX, which is the higher number —
    // a receipt is worth more than one HDX, so its liquidation price is too.
    expect(point.price * 1.00831805).toBeCloseTo(0.00588771, 8)
  })

  it('sorts ascending and keeps already-liquidatable positions', () => {
    const pts = liquidationPointsFromPositions([row(1000, 350), row(1000, 700), row(1000, 70)], 1)

    expect(pts.map(p => +p.price.toFixed(3))).toEqual([0.1, 0.5, 1])
  })

  it('drops rows without debt, collateral, or a threshold', () => {
    const rows = [row(1000, 0), row(0, 350), row(1000, 350, 0)]

    expect(liquidationPointsFromPositions(rows, 1)).toEqual([])
  })

  it('yields nothing without a usable staking rate', () => {
    expect(liquidationPointsFromPositions([row(1000, 350)], 0)).toEqual([])
  })
})

// The chart's whole axis is stated as a distance from the current price, so
// that price has to be the market's own — the one liquidation is decided on.
// It is not callable from a request path (it lives in an EVM oracle contract),
// but every position carries it: collateral USD over collateral tokens.
describe('oraclePriceFromPositions', () => {
  const priced = (collateral: number, price: number) => ({
    total_debt_base: '1', current_liquidation_threshold: '7000', collateral,
    total_collateral_base: String(Math.round(collateral * price * 1e8)),
  })

  it('recovers the price every position was valued at', () => {
    const rows = [priced(1_000, 0.00836554), priced(2_500_000, 0.00836554), priced(17.5, 0.00836554)]

    expect(oraclePriceFromPositions(rows)).toBeCloseTo(0.00836554, 10)
  })

  it('ignores a borrower whose collateral is not all enabled', () => {
    // Same holdings, but only a tenth of them counted as collateral — a low
    // quotient that a ratio of sums would drag the whole price down with.
    const odd = { ...priced(1_000_000, 0.008), total_collateral_base: String(Math.round(1_000_000 * 0.0008 * 1e8)) }
    const rows = [priced(1_000, 0.008), priced(2_000, 0.008), odd]

    expect(oraclePriceFromPositions(rows)).toBeCloseTo(0.008, 10)
  })

  it('reports nothing when no position can be priced', () => {
    expect(oraclePriceFromPositions([])).toBeNull()
    expect(oraclePriceFromPositions([priced(0, 0.008)])).toBeNull()
  })
})
