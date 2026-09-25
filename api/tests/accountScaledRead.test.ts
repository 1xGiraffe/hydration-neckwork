import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { incentiveScaledSeries, type AccountScaledRead } from '../src/services/explorerService.ts'
import { scaledSeriesFromBuckets } from '../src/services/mmIncentiveHistory.ts'

// One history rebuild reads the accounts' aToken scaled deltas ONCE, grouped by
// both bucket keys its two consumers use: the balance tabs by block timestamp
// (like every other balance row of the chart), the settled incentives by block
// height (like the rest of their sources) — so neither moves.

const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const body = (name: string): string => {
  const at = src.indexOf(`async function ${name}(`)
  expect(at).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n}\n', at))
}

describe('the shared scaled read of a history rebuild', () => {
  it('reads atoken_scaled_deltas once, grouped by both bucket keys, and hands it to both consumers', () => {
    const read = body('loadAccountScaledRead')
    expect(read.match(/FROM price_data\.atoken_scaled_deltas FINAL/g)).toHaveLength(1)
    expect(read).toContain("if(block_height <= {maxBlock:UInt32}, toInt32(${bk.ofTs('block_timestamp')}), toInt32(-2)) AS bts")
    expect(read).toContain("if(block_height <= {endN:UInt32}, ${bk.ofHeightCarry('block_height')}, toInt32(-2)) AS bh")
    expect(read).toContain('GROUP BY holder, contract, bts, bh')
    const history = body('getAccountHistory')
    expect(history).toContain('const scaledRead = await loadHistoryScaledRead(historyH160s, rng.maxb, bk)')
    expect(history).toContain('appendMoneyMarketBalanceRows(scaledRead, rng.maxb, bk, balRows)')
    expect(history).toContain('scaledRead ? { scaled: incentiveScaledSeries(scaledRead, bk), scaledAnchorBlock: scaledRead.anchorBlock } : {}')
    // Neither consumer reads the deltas on its own any more.
    expect(body('appendMoneyMarketBalanceRows')).not.toContain('atoken_scaled_deltas')
    // The union covers every incentive programme aToken, staking-backed markets included.
    expect(body('loadHistoryScaledRead')).toContain('...programmes.map(p => p.asset.toLowerCase())')
  })

  it('folds the incentive series exactly as the incentive loader does on its own', () => {
    const bk = { N: 3, endHeight: (b: number) => [900, 1_100, 1_200, 1_300][b] }
    const read: AccountScaledRead = {
      anchorBlock: 1_000,
      anchors: new Map([['0xh|0xa', 10n]]),
      byTs: new Map(),
      byHeight: new Map([['0xh|0xa', new Map([[-1, 1n], [1, 5n], [3, -100n]])], ['0xh|0xb', new Map([[2, 7n]])]]),
    }
    const out = incentiveScaledSeries(read, bk)
    expect(out.get('0xh|0xa')).toEqual([undefined, 16n, 16n, 0n])
    expect(out.get('0xh|0xb')).toEqual([undefined, 0n, 7n, 7n])
    expect(out.get('0xh|0xa')).toEqual(scaledSeriesFromBuckets(10n, read.byHeight.get('0xh|0xa')!, bk, 1_000))
  })
})

// The explorer's chart-zoom histories take the Data API's bucketed-history cache
// rule: short while the window's end is inside the finality margin, long after.
describe('windowed history cache lifetimes', () => {
  it('keys every windowed history on its window and the finality rule, never a flat half hour', () => {
    const ttl = body('windowedHistoryTtlMs')
    expect(ttl).toContain('bucketWindowIsClosed(endSec, headSec, BUCKET_HISTORY_FINALITY_SEC) ? BUCKET_HISTORY_CLOSED_TTL_MS : BUCKET_HISTORY_SETTLING_TTL_MS')
    expect(body('getAccountHistoryWindowed')).toContain('cached(key, await windowedHistoryTtlMs(toBlock)')
    expect(body('cachedLiquidityHistory')).toContain('cached(key, await windowedHistoryTtlMs(window.toBlock)')
    expect(body('getAddressMoneyMarketHistory')).toContain('cached(key, await windowedHistoryTtlMs(window.toBlock)')
  })
})
