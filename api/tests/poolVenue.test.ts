import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  locateVenuePage, poolVenueForScope, venueKeysUnionSql, venueLiquidityKeysSql, venueTradeKeysSql, walkVenueRows,
  type PoolVenue, type VenueKey, type VenueKeyReader,
} from '../src/services/poolVenue.ts'

const OMNIPOOL = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
const STABLE = '0xe21da918e4176b72ef1930ffaa17edcb03b9b739c2843fb0cf096283a7d9c261'
const XYK = '0x06d9fe2fe78494608576087a614557b22628472ba22d742e12331cc9e8560fe0'
const USER = '0x7279fcf9694718e1234d102825dccaf332f0ea36edf1ca7c0358c4b68260d24b'
const evmForm = (a: string) => '0x45544800' + a.slice(2, 42) + '0000000000000000'

const venues = new Map<string, PoolVenue>([
  [OMNIPOOL, { kind: 'omnipool', account: OMNIPOOL }],
  [STABLE, { kind: 'stableswap', account: STABLE, poolId: 690 }],
  [XYK, { kind: 'xyk', account: XYK, assetA: 0, assetB: 5 }],
])

// A pool account's page is the pool's own activity — the trades it executed and the
// liquidity actions on it — not its swap legs listed as transfers.
describe('which scope reads as a pool venue', () => {
  it('is one pool account, alone or with its own truncated-H160 form', () => {
    expect(poolVenueForScope([OMNIPOOL], venues)?.kind).toBe('omnipool')
    expect(poolVenueForScope([STABLE, evmForm(STABLE)], venues)).toEqual(venues.get(STABLE))
    expect(poolVenueForScope([XYK.toUpperCase().replace('0X', '0x')], venues)?.kind).toBe('xyk')
  })

  it('is never a scope holding anything else', () => {
    expect(poolVenueForScope([USER], venues)).toBeNull()
    expect(poolVenueForScope([OMNIPOOL, USER], venues)).toBeNull()
    // A tag of pools is many venues, and no one venue's feed is its feed.
    expect(poolVenueForScope([STABLE, XYK], venues)).toBeNull()
    expect(poolVenueForScope([], venues)).toBeNull()
  })
})

describe('the SQL naming a venue\'s rows', () => {
  it('reads the Omnipool\'s trades as its pallet trade events, one row per trade', () => {
    const sql = venueTradeKeysSql(venues.get(OMNIPOOL)!, 'block_height > 1')
    expect(sql).toContain('FROM price_data.swap_activity')
    expect(sql).toContain("event_name IN ('Omnipool.SellExecuted','Omnipool.BuyExecuted')")
    expect(sql).toContain('SELECT DISTINCT block_height, event_index')
  })

  it('reads a stableswap or XYK pool\'s trades off pool_swap_legs\' (venue, pool_key) prefix', () => {
    const stable = venueTradeKeysSql(venues.get(STABLE)!, 'block_height > 1')
    expect(stable).toContain("venue = 'stableswap' AND pool_key = '690'")
    expect(stable).toContain("leg_kind = 'in'")
    const xyk = venueTradeKeysSql(venues.get(XYK)!, 'block_height > 1', [5, 1005])
    expect(xyk).toContain(`venue = 'xyk' AND pool_key = '${XYK}'`)
    expect(xyk).toContain("leg_kind IN ('in', 'out') AND asset_id IN (5,1005)")
  })

  it('selects nothing for a token no row can reference', () => {
    expect(venueTradeKeysSql(venues.get(OMNIPOOL)!, '1', [])).toContain('AND 0')
    expect(venueLiquidityKeysSql(venues.get(STABLE)!, '1', ['Stableswap.LiquidityAdded'], [], { joinSql: '', predicateSql: '' })).toContain('AND 0')
  })

  it('names an XYK pool\'s liquidity by its pair, in either order', () => {
    const sql = venueLiquidityKeysSql(venues.get(XYK)!, '1', ['XYK.LiquidityAdded'], undefined, { joinSql: 'JOIN_X', predicateSql: 'AND PRED_X' })
    expect(sql).toContain('((asset_id = 0 AND asset_b = 5) OR (asset_id = 5 AND asset_b = 0))')
    // The feed-wide liquidity classification rides along verbatim.
    expect(sql).toContain('JOIN_X')
    expect(sql).toContain('AND PRED_X')
    expect(venueLiquidityKeysSql(venues.get(STABLE)!, '1', ['Stableswap.LiquidityAdded'], undefined, { joinSql: '', predicateSql: '' })).toContain('asset_id = 690')
    expect(venueLiquidityKeysSql(venues.get(XYK)!, '1', [], undefined, { joinSql: '', predicateSql: '' })).toBe('')
  })

  it('tags each source\'s keys and never emits an empty union', () => {
    const sql = venueKeysUnionSql([{ src: 'trade', sql: b => `SELECT 1 WHERE ${b}` }, { src: 'liquidity', sql: () => '' }], 'B')
    expect(sql).toContain("'trade' AS src")
    expect(sql).not.toContain('liquidity')
    expect(venueKeysUnionSql([], 'B')).toContain('WHERE 0')
  })
})

// An in-memory reader that evaluates the bounds the walk builds, so the location
// arithmetic is checked against a plain slice of the whole feed.
function fakeReader(keys: VenueKey[]): VenueKeyReader & { reads: number[] } {
  const sorted = [...keys].sort((a, b) => b.block_height - a.block_height || b.event_index - a.event_index)
  const test = (bound: string) => {
    const js = bound.replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||').replace(/([^<>!=])=([^=])/g, '$1==$2')
    return new Function('block_height', 'event_index', `return ${js}`) as (b: number, e: number) => boolean
  }
  const reads: number[] = []
  return {
    reads,
    async count(bound) { const t = test(bound); return sorted.filter(k => t(k.block_height, k.event_index)).length },
    async buckets(bound, width) {
      const t = test(bound)
      const counts = new Map<number, number>()
      for (const k of sorted) if (t(k.block_height, k.event_index)) counts.set(Math.floor(k.block_height / width), (counts.get(Math.floor(k.block_height / width)) ?? 0) + 1)
      return [...counts].sort((a, b) => b[0] - a[0]).map(([bucket, rows]) => ({ bucket, rows }))
    },
    async read(bound, limit) { reads.push(limit); const t = test(bound); return sorted.filter(k => t(k.block_height, k.event_index)).slice(0, limit) },
  }
}

function feed(): VenueKey[] {
  const out: VenueKey[] = []
  // Uneven density, empty stretches and several rows per block, across disjoint ranges.
  for (let b = 1; b <= 3_000; b++) {
    const n = b % 97 === 0 ? 0 : b > 2_000 ? 3 : b % 5 === 0 ? 2 : 1
    for (let e = 0; e < n; e++) out.push({ block_height: b, event_index: e * 7 + (b % 3), src: e % 2 ? 'liquidity' : 'trade' })
  }
  return out
}
const RANGES = ['block_height > 2500', 'block_height <= 2500 && block_height > 900', 'block_height <= 900']
  .map(r => r.replace('&&', 'AND'))

describe('locating a venue page', () => {
  const all = feed()
  const expected = [...all].sort((a, b) => b.block_height - a.block_height || b.event_index - a.event_index)

  it('returns exactly the ranks a plain slice of the feed holds, at every depth', async () => {
    for (const offset of [0, 1, 37, 1_499, 1_500, 1_501, 2_999, 3_000, 4_123, expected.length - 5, expected.length, expected.length + 10]) {
      for (const limit of [1, 25]) {
        // A small direct-read ceiling and bucket width force the located path.
        const got = await locateVenuePage(fakeReader(all), RANGES, offset, limit, 40, 50)
        expect(got, `offset ${offset} limit ${limit}`).toEqual(expected.slice(offset, offset + limit))
      }
    }
  })

  it('reads a deep page through one bucket, not everything above it', async () => {
    const reader = fakeReader(all)
    await locateVenuePage(reader, RANGES, 4_000, 25, 40, 50)
    expect(Math.max(...reader.reads)).toBeLessThan(400)
  })

  it('agrees with the direct read on shallow pages', async () => {
    expect(await locateVenuePage(fakeReader(all), RANGES, 10, 25)).toEqual(expected.slice(10, 35))
  })
})

describe('walking a venue for row-level filters', () => {
  const all = feed()
  const build = async (keys: VenueKey[]) => keys
  const everyTenth = (k: VenueKey) => k.block_height % 10 === 0

  it('stops at the matches it needs', async () => {
    const walked = await walkVenueRows(fakeReader(all), RANGES, 30, 1e9, 100, build, everyTenth)
    expect(walked.rows.length).toBeGreaterThanOrEqual(30)
    expect(walked.exhausted).toBe(false)
    const expected = [...all].sort((a, b) => b.block_height - a.block_height || b.event_index - a.event_index).filter(everyTenth)
    expect(walked.rows.slice(0, 30)).toEqual(expected.slice(0, 30))
  })

  it('says whether it reached the end or its candidate cap', async () => {
    const whole = await walkVenueRows(fakeReader(all), RANGES, Infinity, 1e9, 500, build, everyTenth)
    expect(whole.exhausted).toBe(true)
    expect(whole.rows.length).toBe(all.filter(everyTenth).length)
    const capped = await walkVenueRows(fakeReader(all), RANGES, Infinity, 1_000, 300, build, everyTenth)
    expect(capped.exhausted).toBe(false)
    expect(capped.rows.length).toBeLessThan(whole.rows.length)
  })
})

describe('the account feed consults the venue first', () => {
  const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  it('routes a pool account\'s page and its total through the venue, so the two cannot disagree', () => {
    expect(src).toMatch(/async function getAccountActivity[\s\S]{0,1500}const venue = await poolVenueOf\(accounts\)/)
    expect(src).toMatch(/async function countAccountActivity[\s\S]{0,300}if \(venue\) return countVenueActivity/)
  })
})
