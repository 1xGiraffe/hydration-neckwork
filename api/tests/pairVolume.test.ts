import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { posix } from 'node:path'
import {
  DUST_SHARE,
  PAIR_VOLUME_5MIN_TABLE,
  pairVolume5minInsertSql,
  pairVolumeBucketStart,
  pairVolumeRowsSql,
  queryPairVolume,
  reachesPairVolumeTail,
  scaledText,
} from '../src/services/pairVolume.ts'
import { routedNettedCteSql } from '../src/services/poolVolumes.ts'
import { PAIR_VOLUME_5MIN_FOLD, hourlyFoldStaleHoursSql } from '../src/derivations/jobs.ts'
import { resetCacheForTests } from '../src/services/cache.ts'

const HOURS = [
  { hour: '2026-09-29 10:00:00', fingerprint: '11' },
  { hour: '2026-09-29 11:00:00', fingerprint: '12' },
]

describe('pair volume SQL', () => {
  const sql = pairVolumeRowsSql('1')

  it('is the routed netting with the raw net amount and a 5-minute bucket carried, without the fee split', () => {
    expect(sql).toContain(routedNettedCteSql('1', undefined, true, '5min', { fees: false, amounts: true }))
    expect(sql).toContain("toStartOfFiveMinutes(min(block_time), 'UTC') AS day")
    expect(sql).toContain('AS net_amt')
    expect(sql).not.toContain('fee_total')
    // Whole-trade aToken wraps are dropped as in every netted volume.
    expect(sql).toContain('HAVING min(all_aave) = 0')
  })

  it('finds each side\'s endpoint by the raw amount\'s sign, keyed through the price aliases, tolerating route dust only', () => {
    expect(sql).toMatch(/sumMapIf\(\[transform\(toUInt32\(asset_id\)|sumMapIf\(\[toUInt32\(asset_id\)/)
    expect(sql).toContain('net_amt < 0) AS ins')
    expect(sql).toContain('net_amt > 0) AS outs')
    expect(DUST_SHARE).toBe(0.01)
    expect(sql).toContain('arraySum(in_usds) - arrayMax(in_usds) <= arraySum(in_usds) / 100')
    expect(sql).toContain('arraySum(out_usds) - arrayMax(out_usds) <= arraySum(out_usds) / 100')
    // A trade whose two endpoints read one series is no pair's.
    expect(sql).toContain('WHERE a_in != a_out')
  })

  it('values a trade by the routed rule and keeps both endpoint amounts in whole units', () => {
    expect(sql).toContain('greatest(side_in, side_out) AS usd')
    expect(sql).toContain('toDecimal256(-net_amt, 18) /')
    expect(sql).toContain('toDecimal128(sum(if(a_in < a_out, amt_in, amt_out)), 18) AS amount_lo')
    expect(sql).toContain('toDecimal128(sum(if(a_in < a_out, amt_out, amt_in)), 18) AS amount_hi')
    expect(sql).toContain('GROUP BY asset_lo, asset_hi, interval_start')
  })

  it('leaves the existing netted surfaces\' SQL exactly as it was', () => {
    // The fees ride with the day unless asked otherwise, and no amount appears.
    const day = routedNettedCteSql('1', undefined, true, 'day')
    expect(day).toContain('fee_total')
    expect(day).not.toContain('net_amt')
    expect(day).toContain('arrayJoin(arrayMap((n, i) -> tuple(tupleElement(n, 1), tupleElement(n, 2),\n')
    expect(day).toContain('sum(tupleElement(leg, 3)) AS fee_total')
    expect(routedNettedCteSql()).not.toContain('net_amt')
  })

  it('writes a marker row for every folded hour, so an hour without a pair trade is held', () => {
    const insert = pairVolume5minInsertSql('202609', HOURS, 'price_data.pair_volume_5min_staging')
    expect(insert).toMatch(/^INSERT INTO price_data\.pair_volume_5min_staging \(asset_lo, asset_hi, interval_start, hour, volume_usd, volume_lo_in_usd, amount_lo, amount_hi, trades, unpriced_trades, registry_fp, computed_at\)/)
    expect(insert).toContain("arrayJoin([toDateTime('2026-09-29 10:00:00'), toDateTime('2026-09-29 11:00:00')]) AS h")
    expect(insert).toContain('SELECT toUInt32(0), toUInt32(0), h, h,')
    expect(insert).toContain("toYYYYMM(block_timestamp) = 202609")
  })

  it('is a valued hourly fold on the volume watermarks whose staleness reads only the marker rows', () => {
    expect(PAIR_VOLUME_5MIN_FOLD).toMatchObject({ model: 'pair_volume_5min', table: PAIR_VOLUME_5MIN_TABLE, valued: true, heldRows: 'asset_lo = 0 AND asset_hi = 0' })
    const stale = hourlyFoldStaleHoursSql(PAIR_VOLUME_5MIN_FOLD)
    expect(stale).toContain(`FROM ${PAIR_VOLUME_5MIN_TABLE}\n      WHERE asset_lo = 0 AND asset_hi = 0\n      GROUP BY hour`)
    expect(stale).toContain('price_data.pool_swap_hour_watermarks')
  })

  it('is created by the schema with its staging twin, keyed by pair then time', () => {
    const ddl = readFileSync(fileURLToPath(new URL('../../clickhouse/schema/015_pair_volume.sql', import.meta.url)), 'utf8')
    for (const t of ['pair_volume_5min', 'pair_volume_5min_staging']) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS price_data.${t} (`)
    }
    expect(ddl.match(/ORDER BY \(asset_lo, asset_hi, interval_start\)/g)).toHaveLength(2)
    expect(ddl.match(/PARTITION BY toYYYYMM\(hour\)/g)).toHaveLength(2)
  })
})

describe('pair volume buckets', () => {
  it('buckets onto the candle model\'s grid: UTC fixed buckets, the ISO (Monday) week, the calendar month', () => {
    const t = Date.parse('2026-09-30T13:47:00Z') / 1000 // a Wednesday
    expect(pairVolumeBucketStart('5min', t)).toBe(Date.parse('2026-09-30T13:45:00Z') / 1000)
    expect(pairVolumeBucketStart('4h', t)).toBe(Date.parse('2026-09-30T12:00:00Z') / 1000)
    expect(pairVolumeBucketStart('1d', t)).toBe(Date.parse('2026-09-30T00:00:00Z') / 1000)
    expect(pairVolumeBucketStart('1w', t)).toBe(Date.parse('2026-09-28T00:00:00Z') / 1000)
    expect(pairVolumeBucketStart('1M', t)).toBe(Date.parse('2026-09-01T00:00:00Z') / 1000)
  })

  it('renders fixed-scale amounts as exact decimal text', () => {
    expect(scaledText(1_500_000_000_000_000_000n, 18)).toBe('1.5')
    expect(scaledText(7n, 18)).toBe('0.000000000000000007')
    expect(scaledText(0n, 12)).toBe('0')
  })
})

describe('queryPairVolume', () => {
  beforeEach(() => resetCacheForTests())

  const client = (rows: unknown[], tail: unknown[] = [], storedThrough = 0) => {
    const seen: Array<{ query: string; params: Record<string, unknown> }> = []
    return {
      seen,
      query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
        seen.push({ query, params: query_params ?? {} })
        const out = query.includes('-- pair-volume:stored-through') ? [{ t: storedThrough }]
          : query.includes('-- pair-volume:stored') ? rows
            : query.includes('-- pair-volume:tail') ? tail : []
        return { json: async () => out }
      }),
    }
  }

  it('reads one (lo, hi) key for either orientation; USD is the same both ways and the amounts swap', async () => {
    const rows = [{ t: 3_600, v: '10', v_lo_in: '4', a_lo: '100', a_hi: '2' }]
    const c1 = client(rows), c2 = client(rows)
    const fwd = await queryPairVolume(c1 as never, { baseId: 22, quoteId: 10, interval: '1h', fromSec: 0, toSec: 7_200 })
    const rev = await queryPairVolume(c2 as never, { baseId: 10, quoteId: 22, interval: '1h', fromSec: 0, toSec: 7_200 })
    expect(c1.seen[0]!.params).toMatchObject({ lo: 10, hi: 22 })
    expect(c2.seen[0]!.params).toMatchObject({ lo: 10, hi: 22 })
    expect(fwd.get(3_600)).toEqual({ usd: 10n * 10n ** 12n, baseBoughtUsd: 4n * 10n ** 12n, base: 2n * 10n ** 18n, quote: 100n * 10n ** 18n })
    expect(rev.get(3_600)).toEqual({ usd: 10n * 10n ** 12n, baseBoughtUsd: 6n * 10n ** 12n, base: 100n * 10n ** 18n, quote: 2n * 10n ** 18n })
    // A past window never builds the live tail.
    expect(c1.seen.some(s => s.query.includes('-- pair-volume:tail'))).toBe(false)
  })

  it('adds the unfolded tail past the fold\'s last hour, bounded, and stops the stored read where it starts', async () => {
    const head = { block: 99, time: 10 * 3_600 + 600 }
    const c = client([], [{ asset_lo: 10, asset_hi: 22, t: 10 * 3_600 + 300, v: '1', v_lo_in: '0', a_lo: '1', a_hi: '1' }], 2 * 3_600)
    const out = await queryPairVolume(c as never, { baseId: 22, quoteId: 10, interval: '1h', fromSec: 0, toSec: 10 * 3_600, head })
    expect(out.get(10 * 3_600)?.usd).toBe(10n ** 12n)
    // The fold reached 02:00 but the tail never reaches back further than four hours before the head's hour.
    const tail = c.seen.find(s => s.query.includes('-- pair-volume:tail'))!
    expect(tail.params).toEqual({ from: 6 * 3_600, to: head.time })
    const stored = c.seen.find(s => s.query.startsWith('-- pair-volume:stored\n'))!
    expect(stored.params.end).toBe(6 * 3_600)
  })

  it('reads the tail for any window reaching the hours the tail covers, closed buckets included, and never for an older one', () => {
    const head = 10 * 3_600 + 600
    expect(reachesPairVolumeTail(6 * 3_600 + 1, head)).toBe(true)
    expect(reachesPairVolumeTail(6 * 3_600, head)).toBe(false)
  })

  it('answers nothing for two ids that read one series', async () => {
    const c = client([])
    expect((await queryPairVolume(c as never, { baseId: 5, quoteId: 5, interval: '1h', fromSec: 0, toSec: 1 })).size).toBe(0)
    expect(c.query).not.toHaveBeenCalled()
  })
})

// The aggregator adapters keep their own volume definitions: nothing they import,
// directly or through any chain of imports, reaches the pair-volume module.
describe('aggregator adapters', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url))
  const ADAPTERS = [
    'public/routes/coingecko.ts', 'public/services/coingecko.ts',
    'public/routes/dexscreener.ts', 'public/services/dexscreener.ts',
    'public/routes/defillama.ts', 'public/services/defillama.ts',
  ]
  const importsOf = (file: string): string[] => {
    const source = readFileSync(SRC + file, 'utf8')
    const out: string[] = []
    for (const m of source.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2]!
      const resolved = posix.normalize(posix.join(posix.dirname(file), spec))
      if (resolved.endsWith('.ts') && existsSync(SRC + resolved)) out.push(resolved)
    }
    return out
  }

  it('never import the pair-volume reader, at any depth', () => {
    const seen = new Set<string>()
    const stack = [...ADAPTERS]
    while (stack.length) {
      const f = stack.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      stack.push(...importsOf(f))
    }
    for (const a of ADAPTERS) expect(seen.has(a)).toBe(true)
    expect([...seen].filter(f => f === 'services/pairVolume.ts')).toEqual([])
  })
})
