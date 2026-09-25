import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { cacheExpiry } from '../../src/services/cache.ts'
import { bucketWindowIsClosed } from '../../src/data/services/feed.ts'
import { BUCKET_HISTORY_CLOSED_TTL_MS, BUCKET_HISTORY_FINALITY_SEC, BUCKET_HISTORY_SETTLING_TTL_MS, bucketHistoryWindow } from '../../src/data/services/lpHistory.ts'
import { AUTH, TEST_HEAD, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for GET /v1/accounts/{address}/liquidity/history: the wire
// shape on a fixed day/week/hour grid, the account-only form, the venue filter,
// the bucket cap, "ended" judged by the index rather than the wall clock, and the
// cache key — always the window, a short TTL while it settles and a long one once
// final. The per-venue arithmetic is pinned by tests/lpHistory.test.ts.

type Row = Record<string, unknown>

const ACC = `0x${'71'.repeat(32)}`
const H = 3_600
const D = 86_400
const CLOCK_START = Date.UTC(2026, 6, 1) / 1000 // 2026-07-01
const CLOCK_END = Date.UTC(2026, 7, 28, 12) / 1000 // the test head's hour
// One row per hour: the block stamped on the mark, and the hour's last block.
const CLOCK_ROWS: Row[] = []
for (let h = CLOCK_START, i = 0; h <= CLOCK_END; h += H, i++) CLOCK_ROWS.push({ h, top: 1_000_000 + i * 1000 + 999, at_mark: 1_000_000 + i * 1000 })
const PRICED_AT = Date.UTC(2026, 6, 31) / 1000
const markHeight = (sec: number) => 1_000_000 + ((sec - CLOCK_START) / H) * 1000

const E12 = 10n ** 12n
function lpHistoryClient(overrides: { closes?: Row[]; headTime?: string } = {}) {
  return fakeDataClient(
    query => (overrides.headTime && query.includes('-- data:status:head')
      ? [{ block_height: TEST_HEAD - 10, ts: overrides.headTime, spec_version: 440 }]
      : undefined),
    query => (query.includes('max(block_height) AS top') ? CLOCK_ROWS : undefined),
    // Omnipool: one position opened before any window, 100 units of asset 5 at a
    // pool trading at its entry price (no hub leg).
    query => (query.includes('-- lp:omnipool-owner-intervals')
      ? [{ position_id: '4711', ownership_kind: 'bare', deposit_id: '', valid_from_block: 900_000, from_ts: CLOCK_START - D, valid_to_block: 0 }]
      : undefined),
    query => (query.includes('-- lp:omnipool-position-states')
      ? [{ position_id: '4711', block_height: 900_000, event_kind: 'created', asset_id: 5, amount_raw: String(100n * E12), shares_raw: String(100n * E12), price_raw: String(10n ** 18n), active: 1 }]
      : undefined),
    query => (query.includes('-- lp:omnipool-pool-states')
      ? [{ asset_id: 5, b: -1, reserve: String(1000n * E12), hub_reserve: String(1000n * E12), shares: String(1000n * E12) }]
      : undefined),
    // Stableswap pool 100: the account holds 10 of 100 shares; asset 22 is unpriced.
    query => (query.includes('-- lp:stableswap-pool-ids') ? [{ pool_id: 100 }] : undefined),
    query => (query.includes('-- lp:share-balance-history') ? [{ account_id: ACC, asset_id: '100', b: 0, bal: String(10n * E12) }] : undefined),
    query => (query.includes('-- lp:stableswap-states')
      ? [{ pool_id: 100, b: -1, aids: [10, 22], reserves: [String(1000n * E12), String(2000n * E12)], issuance: String(100n * E12) }]
      : undefined),
    // Asset 5 at $2 and asset 10 at $1, closed before every bucket end of the
    // August windows and within the 30-day carry of all of them.
    query => (query.includes('-- lp:bucket-closes')
      ? overrides.closes ?? [{ asset_id: 5, closed_at: PRICED_AT, px: '2' }, { asset_id: 10, closed_at: PRICED_AT, px: '1' }]
      : undefined),
    // Every other venue source (XYK, v3/Gamma, span times) answers empty, and so
    // do the farm-reward reads (the account has no farmed deposit).
    query => (query.includes('-- lp:') || query.includes('-- lm:') ? [] : undefined),
  )
}

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

const CLOSED = 'fromTime=2026-08-01T00:00:00Z&toTime=2026-08-05T12:00:00Z'

describe('GET /v1/accounts/:address/liquidity/history', () => {
  it('serves the account line and each position on the day grid, valued at closed candles', async () => {
    const client = lpHistoryClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?${CLOSED}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.bucket).toBe('day')
    expect(body.from).toBe('2026-08-01T00:00:00.000Z')
    // The bucket containing toTime is the last one.
    expect(body.to).toBe('2026-08-06T00:00:00.000Z')
    expect(body.points).toHaveLength(5)
    // Labelled by its start, stated at its end: the exact last block at or before
    // 2026-08-02 00:00 (the one stamped on the mark), never the end of that hour.
    expect(body.points[0]).toEqual({ bucket: '2026-08-01T00:00:00.000Z', blockHeight: markHeight(Date.UTC(2026, 7, 2) / 1000), valueUsd: '200.00', unpriced: 1, unclaimedRewardsUsd: '0.00', rewardsIncomplete: 0 })
    expect(body.positions.map((p: { venue: string }) => p.venue)).toEqual(['omnipool', 'stableswap'])
    const [omni, stable] = body.positions
    expect(omni).toMatchObject({ venue: 'omnipool', farmed: false, positionId: '4711', poolKey: 'omnipool', shareAssetId: null })
    expect(omni.spans).toEqual([{ fromBlock: 900_000, fromTime: '2026-06-30T00:00:00.000Z', toBlock: null, toTime: null, kind: 'direct' }])
    expect(omni.points[4]).toEqual({
      bucket: '2026-08-05T00:00:00.000Z', blockHeight: markHeight(Date.UTC(2026, 7, 6) / 1000), shares: String(100n * E12),
      legs: [{ assetId: '5', amount: String(100n * E12), valueUsd: '200.00' }], valueUsd: '200.00', unclaimedRewards: [],
    })
    // A leg without a price makes the position null — never zero — and it is
    // counted in the point's `unpriced` instead of its value.
    expect(stable).toMatchObject({ venue: 'stableswap', poolKey: '100', shareAssetId: '100', positionId: null, spans: [] })
    expect(stable.points[0].legs).toEqual([
      { assetId: '10', amount: String(100n * E12), valueUsd: '100.00' },
      { assetId: '22', amount: String(200n * E12), valueUsd: null },
    ])
    expect(stable.points[0].valueUsd).toBeNull()
    expect(body.positionsOmitted).toBe(0)
    expect(res.headers['cache-control']).toBe('private, max-age=60')
    // Closed (the head is weeks past the window's end): keyed on the window alone.
    const from = Date.UTC(2026, 7, 1) / 1000
    const to = Date.UTC(2026, 7, 6) / 1000
    expect(cacheExpiry(`data:accounts:lp-history:${ACC}:day:${from}:${to}:all:position`)).not.toBeNull()
  })

  it('returns only the account line for groupBy=account', async () => {
    app = await freshDataApp(lpHistoryClient())
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?${CLOSED}&groupBy=account`, headers: AUTH })).json()
    expect(body.points).toHaveLength(5)
    expect(body).not.toHaveProperty('positions')
    expect(body).not.toHaveProperty('positionsOmitted')
  })

  it('reads only the venues asked for', async () => {
    const client = lpHistoryClient()
    app = await freshDataApp(client)
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?${CLOSED}&venue=stableswap`, headers: AUTH })).json()
    expect(body.positions.map((p: { venue: string }) => p.venue)).toEqual(['stableswap'])
    expect(body.points[0]).toMatchObject({ valueUsd: '0.00', unpriced: 1 })
    expect(client.seen.some(s => s.query.includes('-- lp:omnipool-owner-intervals'))).toBe(false)
  })

  it('rejects an unknown venue and a span over the bucket cap', async () => {
    app = await freshDataApp(lpHistoryClient())
    const bad = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?venue=omnipool,curve`, headers: AUTH })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.message).toContain('curve')
    const wide = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?bucket=hour&fromTime=2026-07-01T00:00:00Z&toTime=2026-08-01T00:00:00Z`, headers: AUTH })
    expect(wide.statusCode).toBe(400)
    expect(wide.json().error.message).toContain('maximum')
  })

  it('aligns weeks to Monday', async () => {
    app = await freshDataApp(lpHistoryClient())
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?bucket=week&fromTime=2026-07-08T00:00:00Z&toTime=2026-08-20T00:00:00Z`, headers: AUTH })).json()
    expect(body.from).toBe('2026-07-13T00:00:00.000Z') // the first week STARTING in the window
    expect(body.to).toBe('2026-08-24T00:00:00.000Z')
    for (const p of body.points) expect(new Date(p.bucket).getUTCDay()).toBe(1)
  })

  it('keys a settling window on the window with a short TTL, never on the head', async () => {
    // The test head is 2026-08-28 12:00:00: the newest ended hour ends exactly there.
    app = await freshDataApp(lpHistoryClient())
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?bucket=hour&groupBy=account`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.to).toBe('2026-08-28T12:00:00.000Z')
    expect(body.points).toHaveLength(90)
    const to = Date.UTC(2026, 7, 28, 12) / 1000
    const key = `data:accounts:lp-history:${ACC}:hour:${to - 90 * H}:${to}:all:account`
    const expiry = cacheExpiry(key)
    expect(expiry).not.toBeNull()
    // Inside the finality hour: the short TTL, not the closed one.
    expect(expiry! - Date.now()).toBeLessThanOrEqual(BUCKET_HISTORY_SETTLING_TTL_MS)
    expect(cacheExpiry(`${key}:h${TEST_HEAD}`)).toBeNull()
  })

  it('holds a window the head is an hour past for the closed TTL', async () => {
    app = await freshDataApp(lpHistoryClient())
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?bucket=day`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    // Default day window: the newest 90 days ENDED by the indexed head, not by the
    // wall clock (weeks later in this test).
    expect(res.json().to).toBe('2026-08-28T00:00:00.000Z')
    const to = Date.UTC(2026, 7, 28) / 1000
    const expiry = cacheExpiry(`data:accounts:lp-history:${ACC}:day:${to - 90 * D}:${to}:all:position`)
    expect(expiry! - Date.now()).toBeGreaterThan(BUCKET_HISTORY_SETTLING_TTL_MS)
    expect(expiry! - Date.now()).toBeLessThanOrEqual(BUCKET_HISTORY_CLOSED_TTL_MS)
  })

  it('never returns a bucket the indexed head has not reached the end of', async () => {
    // Ingestion lags: the head block is 30 s before the 12:00 mark while the wall
    // clock is long past it. The 11:00–12:00 hour is still open for the index.
    const lagging = lpHistoryClient({ headTime: '2026-08-28 11:59:30' })
    app = await freshDataApp(lagging)
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?bucket=hour&groupBy=account`, headers: AUTH })).json()
    expect(body.to).toBe('2026-08-28T11:00:00.000Z')
    expect(body.points.at(-1).bucket).toBe('2026-08-28T10:00:00.000Z')
    // A toTime naming the open hour is clamped the same way.
    const named = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?bucket=hour&groupBy=account&fromTime=2026-08-28T08:00:00Z&toTime=2026-08-28T11:30:00Z`, headers: AUTH })).json()
    expect(named.points.map((p: { bucket: string }) => p.bucket)).toEqual(['2026-08-28T08:00:00.000Z', '2026-08-28T09:00:00.000Z', '2026-08-28T10:00:00.000Z'])
    expect(named.points.at(-1).blockHeight).toBe(markHeight(Date.UTC(2026, 7, 28, 11) / 1000))
  })
})

describe('GET /v1/accounts/:address/liquidity/history — unclaimed farm rewards', () => {
  // The Omnipool position of the main fixture, held through farm deposit 7 in
  // yield farm 2 (reward asset 10, $1): entered with rpvs 1.0 and 1000 valued
  // shares, the farm synced to rpvs 3.0 before August; no loyalty curve.
  const F = 10n ** 18n
  const rewardClient = () => fakeDataClient(
    query => (query.includes('max(block_height) AS top') ? CLOCK_ROWS : undefined),
    query => (query.includes('-- lp:omnipool-owner-intervals')
      ? [{ position_id: '4711', ownership_kind: 'farmed', deposit_id: '7', valid_from_block: 900_000, from_ts: CLOCK_START - D, valid_to_block: 0 }]
      : undefined),
    query => (query.includes('-- lp:omnipool-position-states')
      ? [{ position_id: '4711', block_height: 900_000, event_kind: 'created', asset_id: 5, amount_raw: String(100n * E12), shares_raw: String(100n * E12), price_raw: String(10n ** 18n), active: 1 }]
      : undefined),
    query => (query.includes('-- lp:omnipool-pool-states')
      ? [{ asset_id: 5, b: -1, reserve: String(1000n * E12), hub_reserve: String(1000n * E12), shares: String(1000n * E12) }]
      : undefined),
    query => (query.includes('-- lp:bucket-closes') ? [{ asset_id: 5, closed_at: PRICED_AT, px: '2' }, { asset_id: 10, closed_at: PRICED_AT, px: '1' }] : undefined),
    query => (query.includes('-- lm:farmed-omnipool-intervals') ? [{ position_id: '4711', deposit_id: '7', valid_from_block: 900_000, valid_to_block: 0 }] : undefined),
    query => (query.includes('-- lm:deposit-events')
      ? [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: 900_000, event_index: 4, event_kind: 'deposited', amount_s: '0' }]
      : undefined),
    query => (query.includes('-- lm:entry-captures')
      ? [{ pallet: 'omnipool', deposit_id: '7', yield_farm_id: 2, global_farm_id: 1, block_height: 900_000, capture_status: 'ok', is_event_entry: 1, valued_s: String(1000n * E12), rpvs_entry_s: String(F), claimed_s: '0', entered_at_period: 100, stopped_at_creation: 0 }]
      : undefined),
    query => (query.includes('-- lm:farm-syncs-by-bucket') ? [{ pallet: 'omnipool', yield_farm_id: 2, b: -1, blk: 950_000, idx: 1, ph: 'ApplyExtrinsic', rpvs: String(3n * F) }] : undefined),
    query => (query.includes('-- lm:farm-configs')
      ? [
          { pallet: 'omnipool_lm', event_name: 'GlobalFarmCreated', global_farm_id: 1, yield_farm_id: null, args_json: JSON.stringify({ rewardCurrency: 10, blocksPerPeriod: 1 }) },
          { pallet: 'omnipool_lm', event_name: 'YieldFarmCreated', global_farm_id: 1, yield_farm_id: 2, args_json: JSON.stringify({ loyaltyCurve: null }) },
        ]
      : undefined),
    query => (query.includes('-- lm:relay-heights') ? [{ block_height: 950_000, relay: 200 }] : undefined),
    query => (query.includes('-- lp:') || query.includes('-- lm:') ? [] : undefined),
  )

  it('states each farmed point\'s entries and the account\'s reward sum apart from the principal', async () => {
    app = await freshDataApp(rewardClient())
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?${CLOSED}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // (3.0 − 1.0) · 1000 units of the 12-decimal asset 10 at $1 = $2000.
    expect(body.points[0]).toMatchObject({ valueUsd: '200.00', unpriced: 0, unclaimedRewardsUsd: '2000.00', rewardsIncomplete: 0 })
    const [omni] = body.positions
    expect(omni).toMatchObject({ venue: 'omnipool', farmed: true, positionId: '4711' })
    expect(omni.points[0].valueUsd).toBe('200.00')
    expect(omni.points[0].unclaimedRewards).toEqual([
      { depositId: '7', globalFarmId: 1, yieldFarmId: 2, assetId: '10', amount: String(2000n * E12), valueUsd: '2000.00' },
    ])
  })

  it('omits the rewards with the venues that carry them', async () => {
    app = await freshDataApp(rewardClient())
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/history?${CLOSED}&venue=stableswap&groupBy=account`, headers: AUTH })).json()
    expect(body.points[0]).toMatchObject({ unclaimedRewardsUsd: '0.00', rewardsIncomplete: 0 })
  })
})

describe('bucketHistoryWindow', () => {
  const now = Date.UTC(2026, 8, 24, 15, 30) / 1000 // a Thursday afternoon

  it('defaults to the newest 90 ended buckets, never the open one', () => {
    const w = bucketHistoryWindow('day', undefined, undefined, now)
    expect(w.to).toBe(Date.UTC(2026, 8, 24) / 1000)
    expect((w.to - w.from) / D).toBe(90)
    const week = bucketHistoryWindow('week', undefined, undefined, now)
    expect(new Date(week.to * 1000).toISOString()).toBe('2026-09-21T00:00:00.000Z')
  })

  it('clamps a toTime in the open bucket back to the last ended one', () => {
    const w = bucketHistoryWindow('hour', now - 5 * H, now, now)
    expect(w.to).toBe(Date.UTC(2026, 8, 24, 15) / 1000)
    expect(w.from).toBe(Date.UTC(2026, 8, 24, 11) / 1000)
  })

  it('refuses a window with no ended bucket', () => {
    expect(() => bucketHistoryWindow('day', now - H, undefined, now)).toThrow(/fromTime must be before toTime/)
  })
})

describe('bucketWindowIsClosed', () => {
  it('closes a window once the head is the finality margin past its end, whatever the step', () => {
    const to = 1000 * D
    expect(BUCKET_HISTORY_FINALITY_SEC).toBe(H)
    expect(bucketWindowIsClosed(to, to, H)).toBe(false)
    expect(bucketWindowIsClosed(to, to + H - 1, H)).toBe(false)
    expect(bucketWindowIsClosed(to, to + H, H)).toBe(true)
    // A day or week window closes an hour after its end, not a whole step later.
    expect(bucketWindowIsClosed(to, to + 2 * H, H)).toBe(true)
    expect(bucketWindowIsClosed(to, Number.NaN, H)).toBe(false)
  })
})

describe('resolveBucketHistoryWindow — the chain clock must cover the window end', () => {
  it('clamps to what the clock covers, and refreshes it on demand once allowed', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { resolveBucketHistoryWindow: resolve } = await import('../../src/data/services/lpHistory.ts')
    const { resetCacheForTests } = await import('../../src/services/cache.ts')
    resetCacheForTests()
    const markAt = (h: number) => ({ h, top: h + 3_000, at_mark: h + 1, top_ts: h + 3_594 })
    const base = Date.UTC(2026, 7, 28, 6) / 1000
    // The blocks table (the clock's source) is behind raw_blocks (the head).
    let clockRows = [markAt(base), markAt(base + 3 * H), markAt(base + 4 * H), markAt(base + 5 * H)]
    const client = fakeDataClient(
      query => (query.includes('-- data:status:head') ? [{ block_height: TEST_HEAD, ts: '2026-08-28 12:00:30', spec_version: 440 }] : undefined),
      (query, params) => (query.includes('max(block_height) AS top') ? clockRows.filter(r => r.h >= Number(params.since)) : undefined),
    )
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.UTC(2026, 7, 28, 12, 1))
      // The clock's newest block is 11:59:54: the 11:00–12:00 hour's end is not
      // covered yet, and the clock was just built, so it clamps instead.
      const first = await resolve(client as never, 'hour', undefined, undefined)
      expect(first.window.to).toBe(base + 5 * H)
      clockRows = [...clockRows, markAt(base + 6 * H)]
      vi.setSystemTime(Date.UTC(2026, 7, 28, 12, 1, 5))
      resetCacheForTests()
      const second = await resolve(client as never, 'hour', undefined, undefined)
      expect(second.window.to).toBe(base + 6 * H)
      expect(second.clock.hours.at(-1)).toBe(base + 6 * H)
    } finally {
      vi.useRealTimers()
    }
  })
})
