import { describe, expect, it } from 'vitest'
import {
  assetVolumeHourlyInsertSql,
  poolVolumeHourlyInsertSql,
  routedVolumeHourlyInsertSql,
  volumeFillsCteSql,
} from '../src/services/volumeHourly.ts'
import { FILL_USD, IS_OMNIPOOL_FIRST_HOP, NEXT_FILL_WINDOW, routedBucketSql } from '../src/services/poolVolumes.ts'
import { lpFeeLegSql } from '../src/services/poolYield.ts'
import { V3_FEE_PROTOCOL_CTE, V3_FEE_PROTOCOL_SIDES_SQL, v3FeeSideSql } from '../src/services/revenueStreams.ts'
import { volumeHourlyPriceParams } from '../src/derivations/jobs.ts'
import { valuationRegistryFingerprintSql } from '../src/services/valuation.ts'

// The hourly volume models persist what the public volume surfaces compute per
// request, so their SQL must be built from the same fragments (one definition) and
// keep the properties every pool_swap_legs fold relies on. The numbers themselves
// were reconciled against /v1/pools/*/volumes on live data at deployment; what a
// unit test can pin is the shape that makes them equal.

const HOURS = [
  { hour: '2026-09-14 10:00:00', fingerprint: '11' },
  { hour: '2026-09-30 23:00:00', fingerprint: '22' },
]
const HOUR_SET = HOURS.map(h => h.hour)
const pool = poolVolumeHourlyInsertSql('202609', HOURS, 'price_data.pool_volume_hourly_staging')
const asset = assetVolumeHourlyInsertSql('202609', HOURS, 'price_data.asset_volume_hourly_staging')

describe('volume hourly fold SQL', () => {
  it('collapses the replaceable leg identity before any sum', () => {
    for (const sql of [pool, asset]) {
      const dedup = sql.indexOf('GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index')
      expect(dedup).toBeGreaterThan(-1)
      expect(sql.indexOf('sumIf(usd')).toBeGreaterThan(dedup)
      for (const column of ['asset_id', 'amount', 'fee_dest', 'fee_recipient']) {
        expect(sql).toContain(`argMax(${column}, ingested_at)`)
      }
    }
  })

  it('reads exactly the hours it folds, inside their one source month, without the aToken wraps', () => {
    for (const sql of [pool, asset]) {
      expect(sql).toContain("WHERE venue != 'aave'")
      expect(sql).toContain('toYYYYMM(block_timestamp) = 202609')
      expect(sql).toContain("toStartOfHour(block_timestamp) IN (toDateTime('2026-09-14 10:00:00'), toDateTime('2026-09-30 23:00:00'))")
    }
  })

  it('refuses a partition or hour that is not a literal of the expected shape', () => {
    expect(() => volumeFillsCteSql('2026-09', HOUR_SET)).toThrow()
    expect(() => volumeFillsCteSql('202609', ["2026-10-02 00:00:00') OR 1 --"])).toThrow()
    expect(() => poolVolumeHourlyInsertSql('202609', [{ hour: HOUR_SET[0], fingerprint: '1) OR (1' }], 'x')).toThrow()
  })

  // The staleness check compares each hour's stored fingerprint with the
  // registry's current one, so every row must carry its own hour's value.
  it('stamps every row with its hour\'s registry fingerprint', () => {
    const lookup = "transform(hour, [toDateTime('2026-09-14 10:00:00'), toDateTime('2026-09-30 23:00:00')],\n                   [toUInt64(11), toUInt64(22)], toUInt64(0)) AS registry_fp"
    expect(pool).toContain(lookup)
    expect(asset).toContain(lookup)
    expect(routedVolumeHourlyInsertSql('202609', HOURS, 't')).toContain(lookup.replace('transform(hour,', 'transform(trade_hour,'))
  })

  it('values each leg at the candle closed by the fill, on the vectorised operators', () => {
    for (const sql of [pool, asset]) {
      expect(sql).toContain('interval_start + INTERVAL 1 HOUR AS price_time')
      expect(sql).toContain('p.price_time <= l.block_time')
      expect(sql).toContain('ASOF LEFT JOIN')
      expect(sql).toContain('toDecimal256(l.amount, 0) * toDecimal256(p.close, 12) /')
      expect(sql).not.toContain('multiplyDecimal(')
      expect(sql).not.toContain('divideDecimal(')
      // The public surfaces' anchored candle window, bound per month by the job.
      expect(sql).toContain('{anchor:DateTime}')
      expect(sql).toContain('{hours:UInt32}')
    }
  })

  it('values a fill and an asset side by the public surfaces\' own rules', () => {
    expect(pool).toContain(`${FILL_USD} AS fill_usd`)
    expect(asset).toContain(`${FILL_USD} AS fill_usd`)
    // An asset side inherits the fill's value only when its own legs are unpriced.
    expect(asset).toContain('if(tupleElement(p, 2) > 0, tupleElement(p, 2), fill_usd)')
  })

  it('counts an Omnipool hub swap once, by the same next-fill rule as the routed total', () => {
    expect(pool).toContain(NEXT_FILL_WINDOW)
    expect(pool).toContain(`NOT (${IS_OMNIPOOL_FIRST_HOP}) AS carries`)
    expect(pool).toContain('toDecimal128(sumIf(fill_usd, carries), 12) AS volume_usd')
    expect(pool).toContain('toUInt32(countIf(carries)) AS fills')
    expect(pool).toContain('toUInt32(countIf(carries AND fill_usd = 0)) AS unpriced_fills')
    // …while fees are paid on both hops and are summed over every fill.
    expect(pool).toContain('toDecimal128(sum(lp_fee_usd), 12) AS lp_fee_usd_sum')
    expect(pool).toContain('toDecimal128(sum(protocol_fee_usd), 12) AS protocol_fee_usd_sum')
  })

  it('keeps fee legs out of volume and splits them by the yield endpoints\' LP rule', () => {
    const fills = volumeFillsCteSql('202609', HOUR_SET)
    expect(fills).toContain("sumIf(usd, leg_kind = 'in') AS leg_in_usd")
    expect(fills).toContain("sumIf(usd, leg_kind = 'out') AS leg_out_usd")
    expect(fills).toContain(`sumIf(usd - v3_protocol_usd, leg_kind = 'fee' AND ${lpFeeLegSql()}) AS leg_lp_fee_usd`)
    expect(fills).toContain(`sumIf(usd, leg_kind = 'fee' AND NOT (${lpFeeLegSql()})) + sumIf(v3_protocol_usd, leg_kind = 'fee' AND ${lpFeeLegSql()}) AS leg_protocol_fee_usd`)
    expect(lpFeeLegSql()).toContain("venue = 'omnipool'")
    expect(lpFeeLegSql()).toContain("fee_dest != 'burned'")
  })

  it('moves a Uniswap v3 pool\'s protocol share from LP to protocol fees, by the uniswap_v3_fee stream\'s rule', () => {
    const fills = volumeFillsCteSql('202609', HOUR_SET)
    // The same fragments the revenue stream reads: the SetFeeProtocol in force at
    // the swap, for the fee's token side.
    expect(fills).toContain(V3_FEE_PROTOCOL_CTE)
    expect(fills).toContain(`ASOF INNER JOIN ${V3_FEE_PROTOCOL_SIDES_SQL} AS fp`)
    expect(fills).toContain('fp.at_key <= f.at_key')
    expect(fills).toContain(`${v3FeeSideSql('s.fee_asset_id')} AS side`)
    // Only v3 fee legs carry a share; a missing divisor (LEFT JOIN default 0) carries none.
    expect(fills).toContain("if(p.venue = 'uniswapv3' AND p.leg_kind = 'fee' AND d.fp > 0,")
    expect(fills).toContain('p.usd / toDecimal256(d.fp, 0), toDecimal256(0, 12)) AS v3_protocol_usd')
    // Its own narrow, deduplicated read of the hours' v3 fee legs.
    expect(fills).toContain("WHERE l.venue = 'uniswapv3' AND l.leg_kind = 'fee'")
    expect(fills).toContain('argMax(l.asset_id, l.ingested_at) AS fee_asset_id')
    expect(fills).toContain('GROUP BY l.pool_key, l.block_height, l.event_index')
  })

  it('leaves the H2O hub asset and fee-only appearances out of asset volume', () => {
    expect(asset).toContain('asset_id != 1 AND side_legs > 0) AS asset_parts')
    expect(asset).toContain("toUInt32(countIf(leg_kind != 'fee')) AS side_legs")
  })

  // ClickHouse resolves a later reference to a SELECT alias, and an aggregate that
  // reads its own alias is refused as a nested aggregate.
  it('never aliases an aggregate to the column it reads', () => {
    for (const sql of [pool, asset]) {
      for (const column of ['lp_fee_usd', 'protocol_fee_usd', 'fill_usd', 'volume_usd', 'legs']) {
        expect(sql).not.toMatch(new RegExp(`\\(${column}\\)\\s+AS\\s+${column}\\b`))
      }
    }
  })

  // ClickHouse re-reads a CTE at every reference, so a second reference would
  // re-run the scan, the dedup and the ASOF join.
  it('is one linear chain: every stage is referenced exactly once', () => {
    const references = (sql: string, cte: string): number =>
      (sql.match(new RegExp(`\\b${cte}\\b`, 'g')) ?? []).length - (sql.includes(`${cte} AS (`) ? 1 : 0)
    for (const [sql, ctes] of [
      [pool, ['legs', 'priced', 'split', 'v3_fee_sided', 'v3_fee_div', 'fill_asset', 'fill', 'flagged', 'counted']],
      // (`legs` is also a column of the asset model, so its CTE is checked on the pool chain.)
      [asset, ['priced', 'fill_asset', 'fill', 'sides']],
    ] as const) {
      for (const cte of ctes) expect([cte, references(sql, cte)]).toEqual([cte, 1])
    }
  })

  it('writes the declared columns into the staging twin', () => {
    expect(pool).toContain('INSERT INTO price_data.pool_volume_hourly_staging (venue, pool_key, hour, volume_usd, fills, lp_fee_usd, protocol_fee_usd, unpriced_fills, registry_fp, computed_at)')
    expect(asset).toContain('INSERT INTO price_data.asset_volume_hourly_staging (asset_id, venue, pool_key, hour, volume_usd, legs, unpriced_legs, registry_fp, computed_at)')
    expect(pool).toContain('GROUP BY venue, pool_key, hour')
    expect(asset).toContain('GROUP BY side_asset, venue, pool_key, hour')
  })
})

describe('routed volume hourly fold SQL', () => {
  const routed = routedVolumeHourlyInsertSql('202609', HOURS, 'price_data.routed_volume_hourly_staging')

  it('reads the hours it folds, every venue (whole-trade wraps dropped later)', () => {
    expect(routed).toContain('toYYYYMM(block_timestamp) = 202609')
    expect(routed).toContain("toStartOfHour(block_timestamp) IN (toDateTime('2026-09-14 10:00:00'), toDateTime('2026-09-30 23:00:00'))")
    expect(routed).not.toContain("venue != 'aave'")
    expect(routed).toContain('HAVING min(all_aave) = 0')
  })

  it('is the routed definition the DefiLlama day series uses, at the hour grain', () => {
    // Same netting stage and the same per-trade fold; only the bucket differs.
    expect(routed).toContain("toStartOfHour(min(block_time), 'UTC') AS day")
    expect(routed).toContain('toDecimal128(sum(greatest(side_in, side_out)), 12) AS volume_usd')
    const daily = routedBucketSql()
    expect(daily).toContain("toDate(min(block_time), 'UTC') AS day")
    expect(daily).toContain('sum(greatest(side_in, side_out))')
  })

  it('values legs on the shared anchored candle window', () => {
    expect(routed).toContain('{anchor:DateTime}')
    expect(routed).toContain('{hours:UInt32}')
    expect(routed).toContain('p.price_time <= l.block_time')
  })

  it('writes the declared columns into the staging twin, one row per hour', () => {
    expect(routed).toContain('INSERT INTO price_data.routed_volume_hourly_staging (hour, volume_usd, trades, unpriced_trades, registry_fp, computed_at)')
    expect(routed).toContain('GROUP BY trade_hour')
    expect(routed).toContain('toUInt32(countIf(side_in = 0 AND side_out = 0)) AS unpriced_trades')
    expect(routed).not.toMatch(/\(volume_usd\)\s+AS\s+volume_usd\b/)
  })
})

// The registry inputs a leg's USD depends on, fingerprinted per hour: what makes a
// registry change re-fold exactly the hours whose legs it re-values.
describe('valuationRegistryFingerprintSql', () => {
  it('hashes an asset with its decimal unit, its price alias and whether that alias is priceable', () => {
    const sql = valuationRegistryFingerprintSql('a')
    expect(sql.startsWith('cityHash64(a, toDecimal256(transform(toUInt32(a)')).toBe(true)
    expect(sql).toContain('has([')
  })
})

describe('volumeHourlyPriceParams', () => {
  const seconds = (ts: string) => Date.parse(`${ts.replace(' ', 'T')}Z`) / 1000

  // The window depends on the month and the cut alone, never on which of the
  // month's hours are folded, so a leg values the same in any fold of its hour.
  it('anchors a closed month on its end and spans it whole', () => {
    expect(volumeHourlyPriceParams('202609', seconds('2026-10-02 02:00:00')))
      .toEqual({ anchor: '2026-10-01 00:00:00', hours: 720 })
    expect(volumeHourlyPriceParams('202402', seconds('2026-10-02 02:00:00')))
      .toEqual({ anchor: '2024-03-01 00:00:00', hours: 696 })
  })

  it('anchors the live month on the cut', () => {
    expect(volumeHourlyPriceParams('202610', seconds('2026-10-02 02:00:00')))
      .toEqual({ anchor: '2026-10-02 02:00:00', hours: 26 })
  })

  it('has nothing to build in a month the cut has not entered', () => {
    expect(volumeHourlyPriceParams('202611', seconds('2026-10-02 02:00:00'))).toBeNull()
    expect(volumeHourlyPriceParams('202610', seconds('2026-10-01 00:00:00'))).toBeNull()
  })
})
