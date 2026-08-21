import { describe, expect, it } from 'vitest'
import { PROTOCOL_REVENUE_PREDICATE_SQL, buildRevenueEventRowsSql } from '../src/services/revenueStreams.ts'

// Since 2026-03 the Omnipool protocol fee is no longer split burned/treasury: every
// leg is paid to the Omnipool pallet account, so it stays in the pool and accrues to
// LPs. The predicate counted it as protocol revenue regardless of destination, which
// booked $14.5k of one 30-day window — 21% of reported protocol revenue — that the
// protocol never received. One swap read $12,588 where it earned $181.
//
// The exception is HDX: its Omnipool liquidity is protocol-provided, so a fee retained
// in the HDX position IS the protocol's. The derivation marks those 'pol' rather than
// asking this predicate to know which position a hub-denominated fee accrued to.
const evaluate = (sql: string, row: { stream: string; dest: string }): boolean => {
  // The predicate is plain SQL over two columns, so it can be checked directly.
  const expr = sql
    .replaceAll('stream', JSON.stringify(row.stream))
    .replaceAll('dest', JSON.stringify(row.dest))
    .replaceAll('!=', '!==')
    .replaceAll(/(?<![!=<>])=(?!=)/g, '===')
    .replace(/"([^"]*)" IN \(([^)]*)\)/g, (_m, v, list) => `[${list}].includes("${v}")`)
    .replaceAll("'", '"')
    .replaceAll(' AND ', ' && ')
    .replaceAll(' OR ', ' || ')
  return eval(expr) as boolean
}

describe('which revenue rows are the protocol’s', () => {
  it('excludes a protocol fee left in the pool', () => {
    expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream: 'omnipool_protocol_fee', dest: 'lp' })).toBe(false)
  })

  it('excludes an asset fee left in the pool, as it always did', () => {
    expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream: 'omnipool_asset_fee', dest: 'lp' })).toBe(false)
  })

  it('counts a fee retained in the protocol-provided HDX position', () => {
    expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream: 'omnipool_protocol_fee', dest: 'pol' })).toBe(true)
    expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream: 'omnipool_asset_fee', dest: 'pol' })).toBe(true)
  })

  it('still counts the historical burned and treasury legs', () => {
    for (const dest of ['burned', 'protocol']) {
      expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream: 'omnipool_protocol_fee', dest })).toBe(true)
      expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream: 'omnipool_asset_fee', dest })).toBe(true)
    }
  })

  it('still excludes the legacy asset-fee leg that names no destination', () => {
    expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream: 'omnipool_asset_fee', dest: 'unknown' })).toBe(false)
  })

  it('leaves every other stream counted in full', () => {
    for (const stream of ['network_fee', 'hsm_revenue', 'liquidation_penalty', 'pepl_liquidation_profit', 'asset_reserve']) {
      expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream, dest: '' })).toBe(true)
    }
  })
})

// The fee's own asset names the position for an asset fee, but a protocol fee is
// denominated in the hub asset — so the position it accrued to is the asset that was
// SOLD, which only the sibling leg knows.
describe('marking a fee retained in the HDX position', () => {
  it('reads the asset fee’s own asset', () => {
    const sql = buildRevenueEventRowsSql('omnipool_asset_fee', '1')
    expect(sql).toContain("'pol'")
    expect(sql).toMatch(/asset_id = 0/)
  })

  it('reads the sold asset for the hub-denominated protocol fee', () => {
    const sql = buildRevenueEventRowsSql('omnipool_protocol_fee', '1')
    expect(sql).toContain("'pol'")
    // The sold side of the same swap event, not the fee's own (hub) asset.
    expect(sql).toMatch(/leg_kind = 'in'/)
  })
})
