import { describe, expect, it } from 'vitest'
import { accountVolumeSource, buildPartitionInsertSql } from '../src/services/accountTradeVolume.ts'

// Per-account trading volume always reads the de-duped net-trade model (the
// legacy per-leg readiness gate was removed once its backfill completed).
describe('accountVolumeSource', () => {
  it('returns the net-trade model table and column', () => {
    expect(accountVolumeSource()).toEqual({ table: 'price_data.account_trade_volume', col: 'volume_usd' })
  })
})

describe('buildPartitionInsertSql', () => {
  it('deduplicates every replayable raw_events read with FINAL', () => {
    // raw_events is ReplacingMergeTree — a replayed range holds duplicate row
    // versions until merges collapse them. All four era reads (2× broadcast,
    // 2× legacy) must read FINAL or a mid-replay recompute doubles trade legs.
    const sql = buildPartitionInsertSql('202601')
    expect(sql.match(/FROM price_data\.raw_events FINAL/g)).toHaveLength(4)
    expect(sql).not.toMatch(/FROM price_data\.raw_events(?! FINAL)/)
  })

  it('keeps the valuation in Decimal end-to-end (no Float64 crossing)', () => {
    // Prices are Decimal(38,12) at the source, so the whole pipeline —
    // normalization, price multiply, 10^md rescale, per-trade sums — stays
    // decimal; only the final cast narrows to the stored Decimal128(12).
    const sql = buildPartitionInsertSql('202601')
    expect(sql).toContain('divideDecimal(')
    expect(sql).toContain('multiplyDecimal(')
    expect(sql).not.toContain('toFloat64(')
    expect(sql).not.toMatch(/1e\d/)
  })

  it('targets the live table by default and the staging twin when asked', () => {
    expect(buildPartitionInsertSql('202601'))
      .toContain('INSERT INTO price_data.account_trade_volume\n')
    expect(buildPartitionInsertSql('202601', 'price_data.account_trade_volume_staging'))
      .toContain('INSERT INTO price_data.account_trade_volume_staging\n')
  })

  it('filters to the requested month partition', () => {
    expect(buildPartitionInsertSql('202601')).toContain('toYYYYMM(toDateTime(block_height * 12)) = 202601')
  })
})
