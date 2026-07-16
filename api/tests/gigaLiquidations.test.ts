import { describe, it, expect } from 'vitest'
import { liquidationPointsFromPositions } from '../src/services/explorerService.ts'

// gigahdx positions: collateral is entirely HDX-priced (stHDX), debt is a
// $1-stable (HOLLAR) — so a position's liquidation price is currentPrice/HF,
// and the stHDX at stake is its collateral USD at today's price.
describe('liquidationPointsFromPositions', () => {
  const P = 0.005
  const row = (collateralUsd: number, hf: number) => ({
    total_collateral_base: String(Math.round(collateralUsd * 1e8)),
    total_debt_base: '1',
    health_factor: BigInt(Math.round(hf * 1e18)).toString(),
  })

  it('derives price = current/HF and stHDX = collateral/price', () => {
    const pts = liquidationPointsFromPositions([row(1000, 2)], P)
    expect(pts).toHaveLength(1)
    expect(pts[0].price).toBeCloseTo(0.0025, 6)
    expect(pts[0].stHdx).toBeCloseTo(200_000, 0)
  })

  it('sorts ascending by liquidation price and keeps already-liquidatable (HF<1) positions', () => {
    const pts = liquidationPointsFromPositions([row(100, 1.5), row(100, 0.9), row(100, 4)], P)
    expect(pts.map(p => +(p.price / P).toFixed(3))).toEqual([0.25, 0.667, 1.111])
  })

  it('drops rows without debt, zero/invalid HF, or zero collateral', () => {
    const noDebt = { ...row(100, 2), total_debt_base: '0' }
    const zeroHf = { ...row(100, 2), health_factor: '0' }
    const noColl = row(0, 2)
    expect(liquidationPointsFromPositions([noDebt, zeroHf, noColl], P)).toEqual([])
  })
})
