import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mmAmountInScopeSql, type MmReserveScope } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// One function's source, ending where the next top-level declaration or comment begins.
function functionBody(name: string): string {
  const at = explorerService.indexOf(`function ${name}`)
  expect(at, name).toBeGreaterThan(-1)
  const rest = explorerService.slice(at + 1)
  const next = rest.search(/\n(?:async function |function |export |interface |type |const |\/\/)/)
  expect(next, name).toBeGreaterThan(-1)
  return rest.slice(0, next)
}

// The asset page's liquidation bars are drawn on the daily price series, so their
// day buckets and the candles' day buckets must be the SAME boundary. ohlc_1d_mv
// buckets with toStartOfDay(block_timestamp); anything else here (toDate, an hour
// offset, a truncation in the API layer) would drift a bar onto a neighbouring
// close for every liquidation near midnight.
describe('asset liquidation history buckets on the candles own day boundary', () => {
  it('buckets with the expression the daily OHLC view buckets by', () => {
    expect(functionBody('assetLiquidationDays')).toContain('toStartOfDay(block_timestamp) AS day')
    expect(views).toContain('toStartOfDay(block_timestamp) AS interval_start')
  })

  // The same projection the account/tag volume reads, for the same reasons — never
  // raw_money_market_events, whose key order prunes nothing for a LiquidationCall
  // predicate and whose decoded args are ZSTD(6).
  it('reads the bounded projection, deduplicated, and never the raw events', () => {
    const body = functionBody('assetLiquidationDays')
    expect(body).toContain('FROM price_data.money_market_liquidation_calls FINAL')
    expect(occurrences(body, 'raw_money_market_events')).toBe(0)
    expect(occurrences(body, 'decoded_args_json')).toBe(0)
  })

  // Isolated markets are never blended: a supplemental market's seizures are that
  // market's own figure. Env-configured markets are always supplemental, so this
  // resolves the primary market by role rather than naming the core pool here.
  it('scopes the legs to the primary market only', () => {
    expect(functionBody('assetLiquidationDays')).toContain('pool_address IN {pools:Array(String)}')
    expect(explorerService).toContain(`const primaryMmPools = (): string[] => MM_MARKETS.filter(m => m.role === 'primary').map(m => m.poolProxy)`)
    expect(functionBody('assetLiquidationDays')).toContain('pools: primaryMmPools()')
    expect(occurrences(functionBody('assetLiquidationDays'), 'configuredMmPoolsSql')).toBe(0)
  })

  // Event-time valuation: the last hourly close COMPLETED before the seizure, never
  // a later close and never the current price. The +1 HOUR shift on the right side
  // is what makes the ASOF match "completed by then" rather than "the hour it fell in".
  it('values each leg at the last completed hourly close', () => {
    const body = functionBody('assetLiquidationDays')
    expect(body).toContain('interval_start + INTERVAL 1 HOUR AS price_time')
    expect(body).toContain('p.price_time <= l.block_time')
    expect(occurrences(body, 'ASOF LEFT JOIN')).toBe(1)
    // One asset's feed on the right side, resolved through the same alias map the
    // rest of the historical valuation uses (an aToken and a pool-share token both
    // value through the asset they are a claim on).
    expect(body).toContain('WHERE asset_id = {priceId:UInt32}')
    expect(functionBody('mmReserveScope')).toContain('const priceId = historicalPriceAssetId(assetId)')
  })

  // Integer money: the raw amount is summed as a 256-bit integer and valued as
  // Decimal256, never through a float. A float sum of 18-decimal raw amounts loses
  // precision well before the totals get large.
  it('keeps the amount integral and the valuation fixed-point', () => {
    const body = functionBody('assetLiquidationDays')
    // The leg amount arrives as scale-0 Decimal256 from the scope normalizer, so the
    // token total is an exact integer sum and the value never leaves fixed point
    // until the single float conversion that emits USD.
    expect(body).toContain('toString(sum(l.amount)) AS amount')
    expect(body).toContain('multiplyDecimal(l.amount, toDecimal256(p.close, 12), 12)')
    expect(body).toContain(`\${mmAmountInScopeSql(scope, 'liquidated_collateral_amount')} AS amount`)
    expect(occurrences(body, 'toFloat64')).toBe(1)
  })

  // The card's headline and the chart's bars are folded from one row set, so they
  // cannot disagree — including for a day that falls outside the price series.
  it('folds the total from the same days the bars are drawn from', () => {
    const detail = explorerService.slice(explorerService.indexOf('export async function getAssetDetail'))
    expect(detail).toContain('total: totalAssetLiquidations(days)')
    expect(functionBody('totalAssetLiquidations')).toContain('BigInt(d.amount')
    // A reserve with no seizures reports zero; a non-reserve asset reports nothing.
    expect(detail).toContain('isReserve || days.length')
    // The amount basis travels WITH the amounts, so no consumer has to guess it.
    expect(detail).toContain('decimals: scope.decimals')
  })
})

// Three aliases can separate the id a reader visits from the id the market holds, and
// each one has silently emptied a surface before: an aToken is a claim on its reserve,
// and a pool-share token IS the reserve while the page is the main asset it displays
// as (the market's GDOT collateral is 2-Pool-GDOT 690 — resolving only the direct id
// left GDOT and GETH showing nothing).
describe('an asset page finds its reserve through every alias', () => {
  // The alias set itself is mmReserveIdsForAsset — one resolution shared with the
  // activity token filters, tested behaviourally in moneyMarketAddresses. What this
  // pins is that the liquidation scope reads THAT resolution rather than growing its
  // own, which is how the two could drift apart on the next alias.
  it('takes its alias set from the shared resolution', () => {
    expect(functionBody('mmReserveScope')).toContain('for (const candidate of mmReserveIdsForAsset(assetId))')
    expect(functionBody('mmReserveScope')).toContain('mmReserveAddressForAsset(candidate)')
    const ids = functionBody('mmReserveIdsForAsset')
    expect(ids).toContain('ATOKEN_UNDERLYING_ID[assetId] ?? assetId')
    expect(ids).toContain('UNDERLYING_TO_SHARE_IDS[assetId]')
    expect(ids).toContain('UNDERLYING_TO_SHARE_IDS[direct]')
    // Nothing else may resolve reserve addresses from a token id on its own.
    expect(occurrences(explorerService, 'flatMap(mmReserveAddressForAsset)')).toBe(1)
    expect(functionBody('mmTokenMatchIds')).toContain('tokenIds.flatMap(mmReserveIdsForAsset)')
    expect(functionBody('mmReserveAddressesForTokens')).toContain('mmTokenMatchIds(tokenIds).flatMap(mmReserveAddressForAsset)')
  })

  // The reverse map is derived, never hand-maintained, so it cannot drift from the
  // forward one that display and pricing already use.
  it('derives the share-token reverse map from the forward one', () => {
    const assets = readFileSync(new URL('../src/services/explorerAssets.ts', import.meta.url), 'utf8')
    expect(assets).toContain('export const UNDERLYING_TO_SHARE_IDS')
    expect(assets.slice(assets.indexOf('UNDERLYING_TO_SHARE_IDS'))).toContain('Object.entries(SHARE_TOKEN_UNDERLYING_ID)')
  })

  // One ASOF join serves the whole scope, which is only valid while every candidate
  // prices through the page asset's feed. A candidate that does not is dropped —
  // valuing it at another asset's close would be worse than omitting it.
  it('admits only candidates that price through the same feed', () => {
    expect(functionBody('mmReserveScope')).toContain('if (historicalPriceAssetId(candidate) !== priceId) continue')
  })

  // 2-Pool-PRIME carries 18 decimals where PRIME carries 6, so raw amounts from two
  // reserves of one asset are not in the same units. They are scaled to the widest
  // basis by an exact power of ten, in overflow-checked fixed point — a UInt256
  // multiply would wrap silently and a float would round the low digits away.
  it('normalizes mixed-decimal reserves to one basis without wrapping', () => {
    const body = functionBody('mmAmountInScopeSql')
    expect(body).toContain('10n ** BigInt(scope.decimals -')
    expect(body).toContain('multiplyDecimal(toDecimal256(${column}, 0), toDecimal256(${factor}, 0), 0)')
    expect(occurrences(body, 'toUInt256')).toBe(0)
    expect(occurrences(body, 'toFloat')).toBe(0)
    // The scope reports the basis its amounts are in, taken as the widest present.
    expect(functionBody('mmReserveScope')).toContain('decimals: Math.max(0, ...byAddress.values())')
  })

  // The emitted fragment is checked as text because a quoting slip here is not a
  // wrong number, it is a syntax error that takes the whole asset page down with it —
  // which is exactly what a doubled quote in the single-reserve branch did.
  const scope = (byAddress: [string, number][], decimals: number): MmReserveScope =>
    ({ priceId: 5, decimals, byAddress: new Map(byAddress) })

  it('emits a bare scale for a single reserve, quoted exactly once', () => {
    const sql = mmAmountInScopeSql(scope([['0xaa', 10]], 10), 'amt')
    expect(sql).toBe(`multiplyDecimal(toDecimal256(amt, 0), toDecimal256('1', 0), 0)`)
    expect(sql).not.toContain(`''`)
    // Nothing to look up, so a one-reserve scope never reads the address column.
    expect(sql).not.toContain('asset_address')
  })

  it('scales each reserve to the widest basis when they disagree', () => {
    // PRIME's 6-decimal legs and 2-Pool-PRIME's 18-decimal legs, summed in 18.
    const sql = mmAmountInScopeSql(scope([['0xprime', 6], ['0xpool', 18]], 18), 'amt')
    expect(sql).toBe(`multiplyDecimal(toDecimal256(amt, 0), toDecimal256(transform(lower(asset_address), ['0xprime','0xpool'], ['1000000000000','1'], '1'), 0), 0)`)
    expect(sql).not.toContain(`''`)
  })

  it('is a no-op scale when every reserve already shares the basis', () => {
    expect(mmAmountInScopeSql(scope([['0xaa', 18], ['0xbb', 18]], 18), 'amt'))
      .toContain(`['1','1']`)
  })

  it('degrades to a literal one when the scope is empty', () => {
    expect(mmAmountInScopeSql(scope([], 0), 'amt')).toBe(`multiplyDecimal(toDecimal256(amt, 0), toDecimal256('1', 0), 0)`)
  })
})
