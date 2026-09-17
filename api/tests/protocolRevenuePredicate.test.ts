import { describe, expect, it } from 'vitest'
import { PROTOCOL_REVENUE_PREDICATE_SQL, buildRevenueEventRowsSql } from '../src/services/revenueStreams.ts'

// An omnipool fee leg is the protocol's unless the pool kept it for the LPs of the
// position it landed in. The derivation resolves that position and marks the row, so
// this predicate only reads the destination class: 'lp' and the legacy destination-less
// asset-fee leg are the LPs', everything else — routed out, burned, or retained in the
// protocol-provided HDX position ('pol') — is the protocol's.
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
    for (const stream of ['network_fee', 'hsm_revenue', 'ice_matched_fee', 'uniswap_v3_fee', 'liquidation_penalty', 'pepl_liquidation_profit', 'asset_reserve']) {
      expect(evaluate(PROTOCOL_REVENUE_PREDICATE_SQL, { stream, dest: '' })).toBe(true)
    }
  })
})

// Which retained legs the derivation marks 'pol'. An asset fee stays in the position of
// the asset it was charged in, so the fee's own asset decides; a hub protocol fee is
// credited to the HDX sub-pool's hub reserve whatever pair was traded, so every one of
// them is protocol-owned.
describe('marking a fee retained in the HDX position', () => {
  it('reads the asset fee’s own asset', () => {
    const sql = buildRevenueEventRowsSql('omnipool_asset_fee', '1')
    expect(sql).toContain("'pol'")
    expect(sql).toMatch(/asset_id = 0/)
  })

  it('marks the hub-denominated protocol fee without consulting the trade', () => {
    const sql = buildRevenueEventRowsSql('omnipool_protocol_fee', '1')
    expect(sql).toContain("'pol'")
    expect(sql).not.toMatch(/leg_kind = 'in'/)
    expect(sql).not.toContain("'lp'")
  })
})
