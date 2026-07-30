import { describe, expect, it } from 'vitest'
import {
  eventValueFilterSql,
  exactHistoricalValuePredicateSql,
  exactValuePredicateSql,
  historicalPriceAssetId,
  historicalVolumeSql,
  minimumRawAmountForValue,
  activityRowMatchesFilters,
  voteDetails,
} from '../src/services/explorerService.ts'
import { PRICE_ALIAS_ID, SHARE_TOKEN_UNDERLYING_ID, priceAssetId } from '../src/services/explorerAssets.ts'

describe('value-aware account activity precision', () => {
  it('sums split vote balances without JavaScript number coercion', () => {
    const max = ((1n << 128n) - 1n).toString()
    expect(voteDetails({ vote: { __kind: 'Split', aye: max, nay: max } }).amount)
      .toBe(String(2n * BigInt(max)))
    expect(voteDetails({ vote: { __kind: 'SplitAbstain', aye: max, nay: max, abstain: max } }).amount)
      .toBe(String(3n * BigInt(max)))
  })

  // Activity rows and the referendum voter list both feed the same vote badge, so both
  // report a side with the chain's own AccountVote variant name.
  it('reports a split vote side as the chain names the variant', () => {
    expect(voteDetails({ vote: { __kind: 'Split', aye: '1', nay: '1' } }).side).toBe('Split')
    expect(voteDetails({ vote: { __kind: 'SplitAbstain', aye: '0', nay: '0', abstain: '1' } }).side).toBe('SplitAbstain')
    expect(voteDetails({ vote: { __kind: 'Standard', vote: 128, balance: '1' } }).side).toBe('Aye')
    expect(voteDetails({ vote: { __kind: 'Standard', vote: 3, balance: '1' } }).side).toBe('Nay')
    expect(voteDetails({}).side).toBe('Vote')
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

  // ohlc_1h interleaves ~76 feeds inside every granule, so the static priced-asset
  // universe prunes no marks and argMaxMerge ran over every candle in the table to
  // value a few thousand legs. Only the feeds the legs reference can satisfy the ASOF
  // equality, so narrowing the merged set to the legs' own distinct price ids is
  // result-preserving and is what makes the merge bounded.
  it('narrows the merged close set to the price feeds the legs reference', () => {
    const sql = historicalVolumeSql('liquidation_legs', 'valued')
    const occurrences = (needle: string): number => sql.split(needle).length - 1

    // Exactly one static-universe bound and one legs-derived bound on the right side.
    expect(occurrences('FROM price_data.ohlc_1h')).toBe(1)
    expect(occurrences('WHERE asset_id IN (')).toBe(1)
    expect(occurrences('AND asset_id IN (SELECT DISTINCT ')).toBe(1)
    expect(occurrences('FROM liquidation_legs n)')).toBe(1)
    // Both sides of the ASOF equality resolve the same alias chain, or the narrowed
    // set would exclude a feed the join still wants and silently zero those legs.
    const aliasExprs = [...sql.matchAll(/transform\(toUInt32\([ln]\.asset_id\),[^\n]*?, toUInt32\([ln]\.asset_id\)\)/g)]
      .map(m => m[0].replace(/\b[ln]\.asset_id\b/g, 'X'))
    expect(aliasExprs).toHaveLength(2)
    expect(aliasExprs[0]).toBe(aliasExprs[1])
    // The legs relation is read twice, so it must stay the cheap one.
    expect(occurrences('liquidation_legs')).toBe(2)
  })
})

// A pool-share token is quoted only while it is its pool's tradeable leg:
// 2-Pool-GDOT (690) has six hourly closes from April 2025 and none after, because
// GDOT (69) took over. Excluding share tokens from the historical price alias does
// NOT leave their flows unpriced — it leaves them matched against that abandoned
// feed, and since the ASOF join has no lower bound it values a 2026 liquidation at
// the April-2025 close forever (a ~4x overstatement that survives into every
// liquidation/supply/withdraw value and the account's liquidation volume). Valuing
// through the underlying is the near-peg unit-price proxy the current-price path
// already applies, and it is the only alias with a live feed.
describe('pool-share flows value through their underlying price feed', () => {
  it('resolves a share token to its underlying, never to itself', () => {
    expect(SHARE_TOKEN_UNDERLYING_ID[690]).toBe(69)
    expect(historicalPriceAssetId(690)).toBe(69)
    for (const shareId of Object.keys(SHARE_TOKEN_UNDERLYING_ID).map(Number)) {
      expect(historicalPriceAssetId(shareId)).not.toBe(shareId)
    }
  })

  // Chained aliases must land on the terminal priced id (GIGAHDX -> stHDX -> HDX),
  // and historical valuation must agree with the current-price path about which id
  // that is.
  it('resolves every alias transitively, exactly as the current-price path does', () => {
    for (const aliasedId of Object.keys(PRICE_ALIAS_ID).map(Number)) {
      expect(historicalPriceAssetId(aliasedId)).toBe(priceAssetId(aliasedId))
    }
  })

  // The min-value predicate is pushed into ClickHouse while the displayed row value
  // is computed in TypeScript. If the SQL alias and the row alias disagree, a
  // filtered page admits or drops rows against a value the rows never show.
  it('aliases share tokens in the pushed-down SQL exactly as the row builder does', () => {
    const sql = historicalVolumeSql('legs', 'out')
    // The amount normalisation emits its own transform with quoted scale factors;
    // only the unquoted asset-id -> asset-id pairs are price aliases.
    const transforms = [...sql.matchAll(/transform\(toUInt32\([^)]*\), \[([\d,]+)\], \[([\d,]+)\]/g)]
    expect(transforms).toHaveLength(2)
    for (const [, fromList, toList] of transforms) {
      const from = fromList.split(',').map(Number)
      const to = toList.split(',').map(Number)
      expect(from).toContain(690)
      expect(to[from.indexOf(690)]).toBe(69)
      from.forEach((id, i) => expect(to[i]).toBe(historicalPriceAssetId(id)))
    }
  })
})
