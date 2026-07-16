import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_ACTIVITY_VALUES_SCHEMA_SQL,
  ACCOUNT_ACTIVITY_VALUES_SELECT_SQL,
} from '../src/db/migrations.ts'
import {
  eventValueFilterSql,
  exactHistoricalValuePredicateSql,
  exactValuePredicateSql,
  historicalVolumeSql,
  minimumRawAmountForValue,
  activityRowMatchesFilters,
  voteDetails,
} from '../src/services/explorerService.ts'

describe('value-aware account activity precision', () => {
  it('stores and extracts raw on-chain amounts as UInt256', () => {
    expect(ACCOUNT_ACTIVITY_VALUES_SCHEMA_SQL).toContain('amount UInt256')
    expect(ACCOUNT_ACTIVITY_VALUES_SCHEMA_SQL).not.toContain('amount Float64')
    expect(ACCOUNT_ACTIVITY_VALUES_SELECT_SQL).toContain('toUInt256OrZero(raw_amount) AS amount')
    expect(ACCOUNT_ACTIVITY_VALUES_SELECT_SQL).toContain("toUInt8(raw_amount != '') AS has_amount")
    expect(ACCOUNT_ACTIVITY_VALUES_SELECT_SQL).toContain("= 'SplitAbstain'")
  })

  it('sums split vote balances without JavaScript number coercion', () => {
    const max = ((1n << 128n) - 1n).toString()
    expect(voteDetails({ vote: { __kind: 'Split', aye: max, nay: max } }).amount)
      .toBe(String(2n * BigInt(max)))
    expect(voteDetails({ vote: { __kind: 'SplitAbstain', aye: max, nay: max, abstain: max } }).amount)
      .toBe(String(3n * BigInt(max)))
  })

  it('rounds the minimum passing raw amount upward at the threshold boundary', () => {
    expect(minimumRawAmountForValue('10', '2.5', 6)).toBe(4_000_000n)
    expect(minimumRawAmountForValue('10', '3', 18)).toBe(3_333_333_333_333_333_334n)
    expect(minimumRawAmountForValue('10', '0', 18)).toBeNull()
  })

  it('keeps thresholds above UInt128 exact and compares them as UInt256', () => {
    const threshold = minimumRawAmountForValue('1e12', '0.000000000001', 18)!
    const maxUInt128 = (1n << 128n) - 1n
    const maxUInt256 = (1n << 256n) - 1n
    expect(threshold).toBe(10n ** 42n)
    expect(threshold).toBeGreaterThan(maxUInt128)
    expect(threshold).toBeLessThan(maxUInt256)

    const sql = exactValuePredicateSql('asset_id', 'amount', [{ assetId: 5, amount: threshold.toString() }], {
      amountIsUInt256: true,
      hasAmountExpr: 'has_amount',
    })
    expect(sql).toContain(`['${threshold}']`)
    expect(sql).toContain('toUInt256(amount) >= toUInt256(transform')
    expect(sql).not.toContain('Float64')
  })

  it('uses the event price when current and historical thresholds cross', () => {
    const raw = 7_000_000n
    const currentThreshold = minimumRawAmountForValue('10', '2', 6)!
    const eventThreshold = minimumRawAmountForValue('10', '1', 6)!

    expect(raw >= currentThreshold).toBe(true)
    expect(raw >= eventThreshold).toBe(false)
  })

  it('builds an exact historical UInt256 ceil-div predicate without Float64', () => {
    const numerator = (10n * 1_000_000_000_000n * 1_000_000n).toString()
    const sql = exactHistoricalValuePredicateSql(
      'asset_id',
      'raw_amount',
      'event_price.close',
      [{ assetId: 5, numerator }],
      '1',
    )

    expect(sql).toContain("toUInt256OrZero(raw_amount)")
    expect(sql).toContain("toUInt256(event_price.close * toDecimal128('1000000000000', 0))")
    expect(sql).toContain('intDivOrZero')
    expect(sql).toContain('moduloOrZero')
    expect(sql).not.toContain('Float64')
  })

  it('supports the full finite Number exponent range without throwing', () => {
    expect(minimumRawAmountForValue('1e201', '1', 0)).toBe(10n ** 201n)
    expect(minimumRawAmountForValue('1e-201', '1', 18)).toBe(1n)
  })

  it('does not round a token amount up across the filter boundary', () => {
    const row = {
      amount: '9999999999999999999',
      asset: { assetId: 1, decimals: 18 },
      amountIn: null,
      amountOut: null,
      assetIn: null,
      assetOut: null,
      valueUsd: null,
    }
    expect(activityRowMatchesFilters(row as never, { min: 10, unit: 'token' })).toBe(false)
  })

  it('joins hourly closes only for USD and places the predicate before pagination', () => {
    const usd = eventValueFilterSql('asset_id', 'raw_amount', 'block_timestamp', { min: 10, unit: 'usd' }, new Map(), 'event_price')
    const constantAsset = eventValueFilterSql('0', 'raw_amount', 'block_timestamp', { min: 10, unit: 'usd' }, new Map(), 'event_price')
    const token = eventValueFilterSql('asset_id', 'raw_amount', 'block_timestamp', { min: 10, unit: 'token' }, new Map(), 'event_price')
    const query = `SELECT * FROM source ${usd.joinSql} WHERE 1 ${usd.predicateSql} ORDER BY block_height DESC LIMIT 25`

    expect(usd.joinSql).toContain('ASOF LEFT JOIN')
    expect(usd.joinSql).toContain('price_data.ohlc_1h')
    expect(usd.joinSql).toContain('interval_start + INTERVAL 1 HOUR AS price_time')
    expect(usd.joinSql).toContain('price_time <= block_timestamp')
    expect(constantAsset.joinSql).toContain('asof_join_key = toUInt8(isNotNull(block_timestamp))')
    expect(token.joinSql).toBe('')
    expect(query.indexOf(usd.predicateSql)).toBeLessThan(query.indexOf('LIMIT 25'))
  })

  it('aggregates historical volume in integer atoms before presentation', () => {
    const sql = historicalVolumeSql('legs', 'valued')
    expect(sql).toContain('sum(multiplyDecimal(multiplyDecimal(toDecimal256(l.amount, 0)')
    expect(sql).toContain('toDecimal256(p.close, 12)')
    expect(sql).not.toContain('toDecimal256OrZero(l.amount')
    expect(sql).toContain('interval_start + INTERVAL 1 HOUR AS price_time')
    expect(sql).not.toContain('sum(toFloat64OrZero(l.amount)')
  })
})
