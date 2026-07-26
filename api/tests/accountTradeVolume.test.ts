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
    // versions until merges collapse them. All four reads (2× broadcast legs,
    // legacy legs, and the DCA executions the legacy legs are keyed on) must read
    // FINAL or a mid-replay recompute doubles trade legs.
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

// Pre-router (legacy) era: a routed DCA execution emits one pallet *Executed event
// per hop, then one DCA.TradeExecuted. Keying each hop on its own event index turns
// one trade into per-hop trades — the intermediate asset leaves as an output of the
// first key and arrives as an input of the second instead of netting to zero — so
// volume_usd counts gross hops. Both legacy legs must take their key from the
// enclosing execution instead.
describe('legacy swap identity', () => {
  // The `legacy` CTE is the single keyed source both legacy legs read.
  function legacyCte(sql: string): string {
    const start = sql.indexOf('\nlegacy AS (')
    expect(start).toBeGreaterThan(-1)
    const end = sql.indexOf('\n),', start)
    expect(end).toBeGreaterThan(start)
    return sql.slice(start, end)
  }

  it('anchors an unsigned legacy leg on the DCA execution enclosing it', () => {
    const cte = legacyCte(buildPartitionInsertSql('197109'))
    // Nearest FOLLOWING execution for the same (block, owner): every hop of a
    // routed execution precedes its DCA.TradeExecuted, so the inequality has to
    // run forwards. Matching backwards would key hops on the PREVIOUS execution
    // and leave the last one unkeyed.
    expect(cte).toContain('ASOF LEFT JOIN')
    expect(cte).toContain("event_name = 'DCA.TradeExecuted'")
    expect(cte).toContain('s.block_height = x.block_height AND s.who = x.who AND s.event_index <= x.exec_index')
    expect(cte).toContain('1099511627776 + if(x.exec_marker > 0, x.exec_index, s.event_index)')
  })

  it('leaves a signed swap on its extrinsic and an unenclosed block-hook swap on its event', () => {
    // Pallet/block-hook swaps (treasury and referral distribution) have no
    // enclosing execution at all; their own event is the only identity there is,
    // and the ASOF miss must fall back to it rather than to some later trade.
    const cte = legacyCte(buildPartitionInsertSql('197109'))
    expect(cte).toContain('if(s.extrinsic_index IS NULL,')
    expect(cte).toContain('toUInt64(s.extrinsic_index))')
    expect(cte).toContain('x.exec_index, s.event_index)')
  })

  it('distinguishes an ASOF miss from an execution at event index 0', () => {
    // ASOF LEFT JOIN zero-fills a miss and 0 is a legal event index, so the match
    // is detected through a +1 marker, never through `exec_index > 0`.
    const cte = legacyCte(buildPartitionInsertSql('197109'))
    expect(cte).toContain('event_index + 1 AS exec_marker')
    expect(cte).not.toContain('x.exec_index > 0')
  })

  it('keys both legacy legs from that one source', () => {
    // Each legacy event contributes an assetIn leg and an assetOut leg. Rekeying
    // only one of them would split a hop's own two sides across keys and nothing
    // would net at all, so neither leg may read raw_events directly any more.
    const sql = buildPartitionInsertSql('197109')
    expect(sql.match(/\n {2}FROM legacy\n/g)).toHaveLength(2)
    expect(sql).not.toMatch(/FROM price_data\.raw_events FINAL WHERE event_name IN \('Omnipool\.SellExecuted'/)
    expect(sql).not.toContain('if(extrinsic_index IS NULL, 1099511627776 + event_index, toUInt64(extrinsic_index))')
  })

  it('bounds the execution lookup to the partition it keys', () => {
    // The lookup is a second raw_events read; unbounded it would scan the whole
    // table per rebuild, exactly the regression partitionBlockRange exists to stop.
    const cte = legacyCte(buildPartitionInsertSql('197501'))
    expect(cte.match(/block_height >= 13147200 AND block_height < 13370400/g)).toHaveLength(2)
    expect(cte.match(/toYYYYMM\(toDateTime\(block_height \* 12\)\) = 197501/g)).toHaveLength(2)
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
