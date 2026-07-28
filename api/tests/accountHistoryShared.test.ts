import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resampleValueSeriesToTrailingYear, SPARK_WEEKS } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const fn = (name: string) => {
  const at = explorerService.indexOf(`async function ${name}(`)
  expect(at, name).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
}

// getAccountHistoryShared holds the instance's largest read: the 180-bucket per-asset
// walk over an account's whole life, driven mostly by the accounts-directory prewarm
// (one reconstruction per row per pass). Its cost is therefore divided by how long one
// entry lives, and these guards pin the two properties that make a long-lived entry
// safe — the reconstruction owes nothing to the account-value generation, and no
// consumer reads the one point that ages.
describe('the shared reconstruction outlives an account-value generation', () => {
  it('keys on the scope and account set alone', () => {
    const sites = [...explorerService.matchAll(/`explorer:account-history:[^`]*`/g)].map(match => match[0])
    expect(sites).toEqual(['`explorer:account-history:${scopeKey}:${accountSetFingerprint(accounts)}`'])
  })

  // The entry has to outlast several directory prewarm passes to be worth anything:
  // at one pass every five minutes, a TTL of one pass rebuilds every row every time.
  it('lives long enough to span several prewarm passes', () => {
    const ttl = /const ACCOUNT_HISTORY_TTL_MS = (\d+) \* 60_000/.exec(explorerService)
    expect(ttl?.[1], 'ACCOUNT_HISTORY_TTL_MS in minutes').toBeDefined()
    const prewarm = [...explorerService.matchAll(/accountsPrewarmTimer = setInterval\([^,]+, (\d+) \* 60_000\)/g)]
    expect(prewarm).toHaveLength(1)
    expect(Number(ttl![1])).toBeGreaterThanOrEqual(6 * Number(prewarm[0][1]))
  })

  // Why it may: every bucket is valued at a candle that had already closed by the
  // bucket's own timestamp, so the pinned current-price map the generation names
  // cannot move a single value in here. Pinned by count so a new price read inside
  // the reconstruction fails this rather than silently reintroducing the dependency.
  it('values buckets at closed historical candles, never the pinned price map', () => {
    const body = fn('getAccountHistory')

    expect(body).not.toContain('ensureAccountValuePrices')
    expect(body).not.toContain('accountValuePriceMap')
    expect(body).toContain('FROM price_data.ohlc_1d')
    // The one current-price read it does make ranks the per-asset chip list; it never
    // values a bucket.
    expect([...body.matchAll(/ensurePrices\(\)/g)]).toHaveLength(1)
    expect(body).toContain('alignedBalanceHistory.sort(')
  })

  // Four consumers share one entry, and each must own the live point itself. Pinned by
  // count: a fifth consumer that forgot to would serve a stale headline value.
  it('leaves every consumer to supply the live final point', () => {
    const sites = [...explorerService.matchAll(/(?<!function )getAccountHistoryShared\(/g)]
    expect(sites).toHaveLength(4)

    // The two detail charts overwrite the last point with the displayed net worth.
    // getTag's own call moved into buildTagDetailForMembers when the library-tag
    // aggregate view was extracted to share it — getTag now only delegates there,
    // so the pin follows the call site rather than the (unchanged) public name.
    for (const consumer of ['getAddressHistory', 'buildTagDetailForMembers']) {
      const body = fn(consumer)
      expect(body, consumer).toContain('const portfolioSeries = history.portfolioSeries.slice()')
      expect(body, consumer).toContain('portfolioSeries[portfolioSeries.length - 1] = +(')
    }
    // The directory row pins its own authoritative Value column into the last bucket.
    expect(fn('enrichAccountSparklines')).toContain('series[SPARK_WEEKS - 1] = +Number(raw[i].usd_total ?? 0).toFixed(2)')
    // The markers read deltas, and skip the one that lands on the pinned point.
    expect(fn('getAccountValueEvents')).toContain('getAccountHistoryShared(historyAccounts, cacheKey)')
    const jumps = explorerService.indexOf('function selectValueJumps(')
    expect(jumps).toBeGreaterThan(-1)
    expect(explorerService.slice(jumps, explorerService.indexOf('\n}\n', jumps)))
      .toContain('for (let i = 1; i < series.length - 1; i++)')
  })

  // A reconstruction that fails must leave the wallet-only series enrichAccountRows
  // already produced; a row must never regress to an empty sparkline.
  it('never turns a failed reconstruction into a blank row', () => {
    const body = fn('enrichAccountSparklines')

    expect([...body.matchAll(/rows\[i\]\.sparkline = /g)]).toHaveLength(1)
    expect(body).toContain('if (portfolioSeries.length > 1) {')
    const at = body.indexOf('} catch {')
    expect(at).toBeGreaterThan(-1)
    expect(body.slice(at)).not.toContain('sparkline')
  })
})

// The staleness the longer TTL buys is bounded by the grid the series is resampled
// onto. A reconstruction built half an hour earlier saw the same closed candles and
// the same balance observations for every bucket that is not the current week, so it
// resamples to the same 53 weekly points — which is what keeps a directory row's
// sparkline equal to the detail chart's own resample.
describe('an older reconstruction resamples to the same trailing year', () => {
  const now = new Date('2026-07-27T09:42:00Z')
  const BUCKET_MS = 5 * 24 * 60 * 60 * 1000   // (max-min)/180 for a whole-life account
  const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')

  // 181 buckets of a whole-life series, ending at `now`, with a value that grows so
  // any bucket taken from the wrong sample shows up as an inequality.
  const wholeLife = (endMs: number, count = 181) => {
    const values: number[] = []
    const dates: string[] = []
    for (let i = 0; i < count; i++) {
      values.push(1000 + i * 37.5)
      dates.push(iso(endMs - (count - 1 - i) * BUCKET_MS))
    }
    return { values, dates }
  }

  it('agrees on every bucket behind the pinned one', () => {
    const fresh = wholeLife(now.getTime())
    // The same reconstruction half an hour earlier: `max(block_height)` was 30 minutes
    // back, so every bucket boundary sat proportionally earlier and the final bucket
    // had not yet absorbed the newest observation.
    const aged = wholeLife(now.getTime() - 30 * 60_000)
    aged.values[aged.values.length - 1] = 6000

    const a = resampleValueSeriesToTrailingYear(fresh.values, fresh.dates, now)
    const b = resampleValueSeriesToTrailingYear(aged.values, aged.dates, now)

    expect(a).toHaveLength(SPARK_WEEKS)
    expect(b.slice(0, SPARK_WEEKS - 1)).toEqual(a.slice(0, SPARK_WEEKS - 1))
  })

  it('is identical once the final bucket is pinned to the live value', () => {
    const fresh = wholeLife(now.getTime())
    const aged = wholeLife(now.getTime() - 30 * 60_000)
    aged.values[aged.values.length - 1] = 6000

    const a = resampleValueSeriesToTrailingYear(fresh.values, fresh.dates, now)
    const b = resampleValueSeriesToTrailingYear(aged.values, aged.dates, now)
    const live = 7777.77
    a[SPARK_WEEKS - 1] = live
    b[SPARK_WEEKS - 1] = live

    expect(b).toEqual(a)
  })

  it('still left-pads a young account with zeros when the series is older', () => {
    // 30 buckets only: the account was born inside the trailing year.
    const aged = wholeLife(now.getTime() - 30 * 60_000, 30)
    const series = resampleValueSeriesToTrailingYear(aged.values, aged.dates, now)

    expect(series).toHaveLength(SPARK_WEEKS)
    const firstNonZero = series.findIndex(v => v !== 0)
    expect(firstNonZero).toBeGreaterThan(0)
    expect(series.slice(0, firstNonZero).every(v => v === 0)).toBe(true)
    expect(series.slice(firstNonZero).every(v => v > 0)).toBe(true)
  })
})
