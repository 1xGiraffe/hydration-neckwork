import { describe, expect, it } from 'vitest'
import { accountVolumeSource, buildPartitionInsertSql, partitionBlockRange } from '../src/services/accountTradeVolume.ts'

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

// The derived table's partition is a synthetic month over block_height * 12 seconds.
// ClickHouse cannot invert that expression into a primary-key range, so a rebuild
// filtered on it alone read every granule of raw_events (596M rows / 119 GiB per
// partition) instead of the partition's own ~223k blocks.
describe('partition block range', () => {
  it('inverts the partition expression the derived table is keyed by', () => {
    expect(partitionBlockRange('197501')).toEqual({ fromBlock: 13_147_200, toBlock: 13_370_400 })
    expect(partitionBlockRange('197011')).toEqual({ fromBlock: 2_188_800, toBlock: 2_404_800 })
  })

  it('rolls a December partition into the next year', () => {
    const december = partitionBlockRange('197012')
    expect(december.toBlock).toBe(partitionBlockRange('197101').fromBlock)
    expect(december.toBlock).toBeGreaterThan(december.fromBlock)
  })

  it('matches the SQL expression it replaces at both bounds', () => {
    // toYYYYMM(toDateTime(block_height * 12)) must equal the partition inside the
    // range and differ immediately outside it.
    for (const partition of ['197011', '197501']) {
      const { fromBlock, toBlock } = partitionBlockRange(partition)
      const month = (block: number) => {
        const d = new Date(block * 12_000)
        return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      }
      expect(month(fromBlock)).toBe(partition)
      expect(month(toBlock - 1)).toBe(partition)
      expect(month(fromBlock - 1)).not.toBe(partition)
      expect(month(toBlock)).not.toBe(partition)
    }
  })

  it('bounds every raw_events leg of the rebuild', () => {
    const sql = buildPartitionInsertSql('197501')
    expect(sql.match(/block_height >= 13147200 AND block_height < 13370400/g)).toHaveLength(4)
    // The original expression stays for exactness.
    expect(sql).toContain('toYYYYMM(toDateTime(block_height * 12)) = 197501')
  })

  it('rejects a malformed partition rather than scanning everything', () => {
    expect(() => partitionBlockRange('nonsense')).toThrow()
    expect(() => partitionBlockRange('197513')).toThrow()
  })
})
