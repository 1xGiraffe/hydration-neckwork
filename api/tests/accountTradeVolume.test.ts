import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS,
  accountTradeVolumeInsertSql,
  accountVolumeSource,
  bucketBlocksPredicate,
  bucketPartition,
} from '../src/services/accountTradeVolume.ts'

// The first bucket of a synthetic month partition.
const firstBucket = (partition: string): string =>
  String(Date.UTC(Number(partition.slice(0, 4)), Number(partition.slice(4, 6)) - 1, 1) / 12_000 / ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS)

const sqlFor = (partition: string, opts: { target?: string; maxBlockTime?: string } = {}): string =>
  accountTradeVolumeInsertSql(partition, [{ bucket: firstBucket(partition), fingerprint: '7' }],
    opts.target ?? 'price_data.account_trade_volume_staging',
    { computedAt: '2026-10-02 12:00:00', maxBlockTime: opts.maxBlockTime })

// Per-account trading volume reads the de-duped net-trade model.
describe('accountVolumeSource', () => {
  it('returns the net-trade model table and column', () => {
    expect(accountVolumeSource()).toEqual({ table: 'price_data.account_trade_volume', col: 'volume_usd' })
  })
})

describe('accountTradeVolumeInsertSql', () => {
  it('deduplicates every replayable raw_events read with FINAL', () => {
    // raw_events is ReplacingMergeTree — a replayed range holds duplicate row
    // versions until merges collapse them. All four reads (2× broadcast legs,
    // legacy legs, and the DCA executions the legacy legs are keyed on) must read
    // FINAL or a mid-replay recompute doubles trade legs.
    const sql = sqlFor('202601')
    expect(sql.match(/FROM price_data\.raw_events FINAL/g)).toHaveLength(5)
    expect(sql).not.toMatch(/FROM price_data\.raw_events(?! FINAL)/)
  })

  it('keeps the valuation in Decimal end-to-end (no Float64 crossing)', () => {
    // Prices are Decimal(38,12) at the source, so the whole pipeline —
    // normalization, price multiply, 10^md rescale, per-trade sums — stays
    // decimal; only the final cast narrows to the stored Decimal128(12). The
    // arithmetic runs on the plain decimal OPERATORS, which are vectorised where
    // multiplyDecimal/divideDecimal are per-row (4.70 → 2.65 CPU-s per month INSERT);
    // every operand scale here lines up, so it is the same integer arithmetic,
    // proved bit-identical over 2.77 M netted legs including 1.10 M negative ones.
    const sql = sqlFor('202601')
    expect(sql).toContain('n.net_amt * toDecimal256(transform(')
    expect(sql).toContain(') * toDecimal256(p.close, 12) / toDecimal256(')
    expect(sql).not.toContain('divideDecimal(')
    expect(sql).not.toContain('multiplyDecimal(')
    expect(sql).not.toContain('toFloat64(')
    expect(sql).not.toMatch(/1e\d/)
  })

  it('writes the table it is given, each row stamped with its bucket\'s fingerprint and the cycle\'s read time', () => {
    const sql = sqlFor('202601')
    expect(sql).toContain('INSERT INTO price_data.account_trade_volume_staging\n')
    expect(sql).toContain('(account, block_height, trade_key, volume_usd, net_in_usd, net_out_usd, trade_count, registry_fp, computed_at)')
    expect(sql.replace(/\s+/g, ' ')).toContain('transform(intDiv(block_height, 1800), [toUInt32(81816)], [toUInt64(7)], toUInt64(0)) AS registry_fp')
    expect(sql).toContain("toDateTime('2026-10-02 12:00:00') AS computed_at")
    expect(sql).not.toContain('now()')
  })

  it('refuses a computed_at or fingerprint that is not a plain literal', () => {
    expect(() => accountTradeVolumeInsertSql('202601', [{ bucket: '81816', fingerprint: '1 OR 1' }], 't', { computedAt: '2026-10-02 12:00:00' })).toThrow()
    expect(() => accountTradeVolumeInsertSql('202601', [{ bucket: '81816', fingerprint: '1' }], 't', { computedAt: "now()) --" })).toThrow()
  })
})

// The ASOF right side is the whole ohlc_1h feed for every priced asset. Candles
// that close after the buckets' last trade can never win the ASOF match, so
// they can be cut — but only from above.
describe('valuation price window', () => {
  it('cuts candles that close after the buckets, and nothing before it', () => {
    const sql = sqlFor('197011', { maxBlockTime: '2022-09-30 23:59:54' })
    expect(sql).toContain("interval_start <= (toDateTime('2022-09-30 23:59:54') - toIntervalHour(1))")
    // No lower bound: an asset with no candle inside the buckets is valued at
    // the last candle before it, however far back that is.
    expect(sql).not.toContain('interval_start >=')
  })

  it('values against the whole feed when the buckets\' watermark is unknown', () => {
    expect(sqlFor('197011')).not.toContain('interval_start <=')
  })

  it('rejects a watermark that is not a plain ClickHouse datetime', () => {
    expect(() => sqlFor('197011', { maxBlockTime: "2022-01-01') OR 1=1 --" }))
      .toThrow()
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
    const cte = legacyCte(sqlFor('197109'))
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
    const cte = legacyCte(sqlFor('197109'))
    expect(cte).toContain('if(s.extrinsic_index IS NULL,')
    expect(cte).toContain('toUInt64(s.extrinsic_index))')
    expect(cte).toContain('x.exec_index, s.event_index)')
  })

  it('distinguishes an ASOF miss from an execution at event index 0', () => {
    // ASOF LEFT JOIN zero-fills a miss and 0 is a legal event index, so the match
    // is detected through a +1 marker, never through `exec_index > 0`.
    const cte = legacyCte(sqlFor('197109'))
    expect(cte).toContain('event_index + 1 AS exec_marker')
    expect(cte).not.toContain('x.exec_index > 0')
  })

  it('keys both legacy legs from that one source', () => {
    // Each legacy event contributes an assetIn leg and an assetOut leg. Rekeying
    // only one of them would split a hop's own two sides across keys and nothing
    // would net at all, so neither leg may read raw_events directly any more.
    const sql = sqlFor('197109')
    expect(sql.match(/\n {2}FROM legacy\n/g)).toHaveLength(2)
    expect(sql).not.toMatch(/FROM price_data\.raw_events FINAL WHERE event_name IN \('Omnipool\.SellExecuted'/)
    expect(sql).not.toContain('if(extrinsic_index IS NULL, 1099511627776 + event_index, toUInt64(extrinsic_index))')
  })

  it('bounds the execution lookup to the buckets it keys', () => {
    // The lookup is a second raw_events read; unbounded it would scan the whole
    // table per recompute.
    const cte = legacyCte(sqlFor('197501'))
    expect(cte.match(/block_height >= 13147200 AND block_height < 13149000/g)).toHaveLength(2)
  })
})

// The legacy pallets do not agree on what their buy event's fields mean, and the
// disagreement is silent: both carry `amount` and `buyPrice`, in opposite roles.
// Reading an LBP buy with XYK's order swaps the trade's two sides, so the paid
// leg is valued with the received leg's raw integer — across a decimals gap that
// turned 202 DOT into 10,000,000 DOT and one bond purchase into $77.3M of volume.
// Verified against the Router.RouteExecuted emitted in the same extrinsic:
// LBP `buyPrice` = amountOut in 26/26 legacy routed buys, XYK `amount` =
// amountOut in 396/446 (the remainder are multi-hop, where one leg != the route).
describe('legacy buy/sell field mapping', () => {
  // Which args_json field a legacy leg reads for one event, by evaluating the
  // generated multiIf's branches in order the way ClickHouse would.
  function legacyField(sql: string, side: 'in' | 'out', eventName: string): string {
    const asset = side === 'in' ? 'assetIn' : 'assetOut'
    const start = sql.indexOf(`toUInt32(greatest(0, JSONExtractInt(args_json,'${asset}')))`)
    expect(start).toBeGreaterThan(-1)
    const block = sql.slice(start, sql.indexOf('\n  FROM legacy', start))
    for (const [, list, eq, field] of block.matchAll(
      /event_name (?:IN \(([^)]*)\)|= ('[^']*')), JSONExtractString\(args_json,'(\w+)'\)/g,
    )) {
      if ((list ?? eq).split(',').map(s => s.trim().slice(1, -1)).includes(eventName)) return field
    }
    const fallback = block.match(/JSONExtractString\(args_json,'(\w+)'\)\), 0\)/)
    expect(fallback).not.toBeNull()
    return fallback![1]
  }

  it('reads an LBP buy in its own field order: amount paid, buyPrice received', () => {
    const sql = sqlFor('197011')
    expect(legacyField(sql, 'in', 'LBP.BuyExecuted')).toBe('amount')
    expect(legacyField(sql, 'out', 'LBP.BuyExecuted')).toBe('buyPrice')
  })

  it('keeps an XYK buy on the opposite order: buyPrice paid, amount received', () => {
    const sql = sqlFor('197011')
    expect(legacyField(sql, 'in', 'XYK.BuyExecuted')).toBe('buyPrice')
    expect(legacyField(sql, 'out', 'XYK.BuyExecuted')).toBe('amount')
  })

  it('keeps both pallets sells on amount paid, salePrice received', () => {
    // Sells agree across the two pallets, so this branch stays shared.
    const sql = sqlFor('197011')
    for (const name of ['XYK.SellExecuted', 'LBP.SellExecuted']) {
      expect(legacyField(sql, 'in', name)).toBe('amount')
      expect(legacyField(sql, 'out', name)).toBe('salePrice')
    }
  })

  it('leaves the Omnipool/Stableswap events on their own explicit amounts', () => {
    const sql = sqlFor('197011')
    for (const name of ['Omnipool.SellExecuted', 'Omnipool.BuyExecuted', 'Stableswap.BuyExecuted']) {
      expect(legacyField(sql, 'in', name)).toBe('amountIn')
      expect(legacyField(sql, 'out', name)).toBe('amountOut')
    }
  })
})

// A bucket is 1800 consecutive blocks. Every source the netting reads is ordered
// by block_height, so a bucket is a primary-key range on each, and every synthetic
// month partition begins at a multiple of 1800 blocks, so a bucket never straddles
// two partitions (a REPLACE PARTITION republishes whole buckets only).
describe('buckets', () => {
  const month = (block: number) => {
    const d = new Date(block * 12_000)
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }

  it('align with the synthetic month partitions for the whole representable range', () => {
    for (let year = 1970; year < 2106; year++) {
      for (let m = 0; m < 12; m++) {
        const firstBlock = Date.UTC(year, m, 1) / 12_000
        expect(firstBlock % ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS).toBe(0)
      }
    }
  })

  it('map to the partition the table keys their blocks on', () => {
    for (const b of [0, 1215, 1216, 7303, 7304, 8499]) {
      expect(bucketPartition(b)).toBe(month(b * ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS))
      expect(bucketPartition(b)).toBe(month((b + 1) * ACCOUNT_TRADE_VOLUME_BUCKET_BLOCKS - 1))
    }
    expect(bucketPartition(1216)).toBe('197011')
    expect(bucketPartition(1215)).toBe('197010')
  })

  it('read as a primary-key range narrowed to exactly the set', () => {
    expect(bucketBlocksPredicate('197501', ['7310', '7304']).replace(/\s+/g, ' '))
      .toBe('block_height >= 13147200 AND block_height < 13159800 AND intDiv(block_height, 1800) IN (7304, 7310)')
  })

  it('bound every source read of the recompute', () => {
    const sql = sqlFor('197501')
    // Four raw_events reads, the intent fills, the pot's settlement legs, the direct
    // v3 swap read and its routed-hop exclusion.
    expect(sql.match(/block_height >= 13147200 AND block_height < 13149000/g)).toHaveLength(8)
    expect(sql.match(/intDiv\(block_height, 1800\) IN \(7304\)/g)).toHaveLength(8)
  })

  it('reject a bucket of another partition, a malformed one, or none rather than scanning everything', () => {
    expect(() => bucketBlocksPredicate('197501', ['7303'])).toThrow()
    expect(() => bucketBlocksPredicate('197501', ['7304 OR 1'])).toThrow()
    expect(() => bucketBlocksPredicate('197501', [])).toThrow()
    expect(() => bucketBlocksPredicate('nonsense', ['7304'])).toThrow()
    expect(() => bucketPartition(-1)).toThrow()
  })
})

// ICE intents settle through the solver's pot: the pot runs the AMM routes (Broadcast
// swapper = pot) and the owner only pays into and receives out of it. Measured on the
// first solutions, every DCA trade of intent #34 booked $190.20 of volume to the pot
// and nothing to its owner. An owner's trade IS their fill — the Intent event's
// amounts, or, for the budget-exhausting DcaCompleted that states none, the pot's
// settlement legs — and the pot's own routes are left out, being that same trade a
// second time.
describe('ICE intent fills as owner trades', () => {
  const sql = sqlFor('202609')

  it('reads the buckets\' fills from the intent tables, deduplicated, from runtime 443 on', () => {
    expect(sql).toMatch(/FROM price_data\.intent_events(\s+AS\s+\w+)?\s+FINAL/)
    expect(sql).toMatch(/FROM price_data\.intent_orders(\s+AS\s+\w+)?\s+FINAL/)
    // The NOT NULL filter has to read the TABLE's column: `assumeNotNull(x) AS x`
    // would otherwise resolve the later `x` to the alias, which is never null,
    // and every extrinsic-less event would join on a fabricated index 0.
    expect(sql).toContain('ie.extrinsic_index IS NOT NULL')
    for (const name of ['Intent.IntentResolved', 'Intent.IntentResovedPartially', 'Intent.DcaTradeExecuted', 'Intent.DcaCompleted']) {
      expect(sql, name).toContain(`'${name}'`)
    }
    expect(sql).toContain('block_height >= 14362830')
    // Still only the four raw_events reads: the fills come from their own tables.
    expect(sql.match(/FROM price_data\.raw_events FINAL/g)).toHaveLength(5)
  })

  it('nets an owner\'s fill as one trade keyed on its Intent event: asset_in out, asset_out in', () => {
    expect(sql.match(/FROM intent_trades\n/g)).toHaveLength(2)
    expect(sql).toContain('1099511627776 + event_index AS trade_key, block_time, asset_in, -amount_in')
    expect(sql).toContain('1099511627776 + event_index, block_time, asset_out, amount_out')
  })

  it('reads a completion\'s amounts from the pot\'s settlement legs, for a single claimant only', () => {
    expect(sql).toMatch(/FROM price_data\.transfer_activity_by_time(\s+AS\s+\w+)?\s+FINAL/)
    expect(sql).toContain('t.extrinsic_index IS NOT NULL')
    expect(sql).toContain("event_name = 'Currencies.Transferred'")
    expect(sql).toContain("'0x6d6f646c6963655f696365230000000000000000000000000000000000000000'")
    // Sibling fills that state their amounts are subtracted; two completions of one
    // owner in one asset cannot be split and contribute nothing.
    expect(sql).toContain('if(c.n = 1, greatest(')
    expect(sql).toContain("event_name != 'Intent.DcaCompleted'")
  })

  it('drops the pot\'s own Broadcast legs where a fill books them to an owner, so a trade counts once', () => {
    // Only where a fill in the same extrinsic names the owner: a solution whose
    // fills name nobody yet keeps its legs on the pot instead of losing the trade.
    expect(sql).toContain("if(e.swapper = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000' AND (e.block_height, e.extrinsic_index) IN (SELECT block_height, extrinsic_index FROM intent_fills), '',")
    // Dropped, not re-attributed: the fill already carries the owner's trade.
    expect(sql).not.toMatch(/if\(JSONExtractString\(args_json,'swapper'\) = '0x6d6f646c6963655f69636523/)
  })
})

// An AAVE-filler swap is an aToken mint or redeem. A trade made of nothing else is
// a 1:1 money-market wrap, not a swap (the Treasury's share→aToken wraps in block
// 14,672,012 read as $3.27M of trading); an aave hop inside a routed swap is a real
// hop and stays. The same whole-trade rule the public volume surfaces apply.
describe('aToken wraps', () => {
  const sql = sqlFor('202609')
  it('flags each Broadcast fill by its filler and drops a trade only when every fill is a wrap', () => {
    expect(sql).toContain("toUInt8(JSONExtractString(args_json,'fillerType','__kind') = 'AAVE') AS is_aave")
    expect(sql).toContain('min(aave) AS all_aave')
    expect(sql).toContain('HAVING volume_usd > 0 AND min(all_aave) = 0')
    // Every non-Broadcast arm states a non-wrap, so a legacy, intent or direct v3
    // trade is never dropped by it.
    expect(sql.match(/, toUInt8\(0\)\n  FROM (legacy|intent_trades|v3_direct)/g)).toHaveLength(6)
  })
})

// A direct EVM swap in a concentrated-liquidity pool has no Broadcast event; the
// pool's Swap log is the trade and its recipient the trader. A routed hop through
// the same pool already reaches `legs` through its UniswapV3 Swapped3, so its
// extrinsic is excluded here — counting both would double the route.
describe('direct concentrated-liquidity swaps', () => {
  const sql = sqlFor('202609')
  it('reads the pool Swap logs, names the recipient in ETH-prefixed form, and yields to routed hops', () => {
    expect(sql).toContain("FROM price_data.uniswap_v3_events FINAL WHERE kind = 'pool' AND event_name = 'Swap'")
    expect(sql).toContain("concat('0x45544800', substring(e.counterparty, 3, 40), '0000000000000000') AS account")
    expect(sql).toContain("JSONExtractString(args_json, 'fillerType', '__kind') = 'UniswapV3'")
    expect(sql).toContain('FROM v3_direct')
  })
  it('resolves tokens through the registry or the precompile rule and drops strangers', () => {
    expect(sql).toContain("FROM price_data.assets WHERE evm_address != ''")
    expect(sql).toContain('INNER JOIN pools p ON p.pool_address = e.contract_address')
    expect(sql).toContain('asset0 != 4294967295 AND asset1 != 4294967295')
  })
})
