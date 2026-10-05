import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for the User Revenue routes: /v1/stats/user-revenue (the hourly
// fold, clamped to its published cut) and /v1/accounts/{address}/earnings (the
// account facts under both identities, earned/paid/net).

type Row = Record<string, unknown>

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

// 2026-08-28 10:00 is the newest folded hour, so everything is published through 11:00.
const WINDOWS: Row = {
  expected_first: String(Date.UTC(2022, 2, 12, 12) / 1000), first_hour: String(Date.UTC(2022, 2, 12, 12) / 1000), last_hour: String(Date.UTC(2026, 7, 28, 10) / 1000), folded: '39000',
  folded_day: '24', folded_week: '168', folded_month: '720', day: '1', week: '2', month: '3', all_time: '4', unpriced: '0',
}
const windowsHandler = (query: string): Row[] | undefined => (query.includes('-- ur:windows') ? [{ ...WINDOWS, folded: String((Date.UTC(2026, 7, 28, 10) - Date.UTC(2022, 2, 12, 12)) / 3_600_000 + 1) }] : query.includes('-- ur:unmeasured') ? [{ asset_id: '46', reason: 'peg-never-moved', hours: '720', last_hour: '0' }] : undefined)

describe('GET /v1/stats/user-revenue', () => {
  it('reads the account facts, clamps the window to the account fold\'s cut and splits earned / paid / net', async () => {
    const now = new Date()
    const currentMonth = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1
    const cut = Date.UTC(2026, 7, 28, 11) / 1000
    const client = fakeDataClient(
      windowsHandler,
      query => (query.includes('-- ur:account-coverage') ? [{ m: String(currentMonth), computed: '1756375200', through: String(cut), expected_first: String(currentMonth) }] : undefined),
      query => (query.includes('-- ur:day-buckets')
        ? [
            { t: String(Date.UTC(2026, 7, 27) / 1000), ds: 'lp_fee_omnipool', holder_class: 'user', earned: '12.345', paid: '0', net: '12.345', unpriced: '0', h_earned: '0', h_paid: '0', h_net: '0' },
            { t: String(Date.UTC(2026, 7, 27) / 1000), ds: 'mm_supply_interest', holder_class: 'user', earned: '5', paid: '-1.999', net: '3.001', unpriced: '2', h_earned: '0', h_paid: '0', h_net: '0' },
            { t: String(Date.UTC(2026, 7, 27) / 1000), ds: 'mm_borrow_interest', holder_class: 'user', earned: '0', paid: '-10.5', net: '-10.5', unpriced: '0', h_earned: '0', h_paid: '-9.004', h_net: '-9.004' },
          ]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/stats/user-revenue?fromTime=2026-08-20T00:00:00Z&toTime=2026-08-30T00:00:00Z&class=user', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.publishedThrough).toBe('2026-08-28T11:00:00.000Z')
    expect(body.to).toBe('2026-08-28T11:00:00.000Z')
    expect(body.coverage).toMatchObject({ from: '2022-03-12T12:00:00.000Z' })
    expect(body.coverage.unmeasured).toEqual(expect.arrayContaining([expect.stringContaining('accrual: its on-chain rate never moved (a static governance-set peg) (720 of the last 720 published hours)')]))
    // A signed stream keeps both sides: earned and paid are never netted away.
    expect(body.items).toEqual([
      { bucket: '2026-08-27T00:00:00.000Z', stream: 'lp_fee_omnipool', holderClass: 'user', earnedUsd: '12.35', paidUsd: '0.00', amountUsd: '12.35', unpricedCells: 0 },
      { bucket: '2026-08-27T00:00:00.000Z', stream: 'mm_supply_interest', holderClass: 'user', earnedUsd: '5.00', paidUsd: '-2.00', amountUsd: '3.00', unpricedCells: 2 },
      // Borrow interest stays whole (the frozen meaning); its HOLLAR part is stated beside it, never added to it.
      {
        bucket: '2026-08-27T00:00:00.000Z', stream: 'mm_borrow_interest', holderClass: 'user', earnedUsd: '0.00', paidUsd: '-10.50', amountUsd: '-10.50', unpricedCells: 0,
        hollarInterest: { earnedUsd: '0.00', paidUsd: '-9.00', amountUsd: '-9.00' },
      },
    ])
    const read = client.seen.find(s => s.query.includes('-- ur:day-buckets'))!
    expect(read.params.from).toBe('2026-08-20')
    expect(read.params.to).toBe('2026-08-28')
    expect(read.params.cls).toBe('user')
    expect(read.query).toContain('FROM price_data.account_user_revenue_daily')
    expect(read.query).toContain('sumIf(amount_usd, amount_usd > 0)')
    // The slice is HOLLAR's borrow interest by the fact's own asset; the items stay under the fold's streams.
    expect(read.query).toContain("sumIf(amount_usd, (stream = 'mm_borrow_interest' AND asset_id = 222))) AS h_net")
    expect(read.query).toContain('stream AS ds')
    expect(res.headers['cache-control']).toBe('private, max-age=300')
  })

  it('rejects an unknown stream or class', async () => {
    app = await freshDataApp(fakeDataClient(windowsHandler, query => (query.includes('-- ur:day-buckets') || query.includes('-- ur:account-coverage') ? [] : undefined)))
    expect((await app.inject({ url: '/v1/stats/user-revenue?stream=made_up', headers: AUTH })).statusCode).toBe(400)
    expect((await app.inject({ url: '/v1/stats/user-revenue?class=whale', headers: AUTH })).statusCode).toBe(400)
  })

  it('serves an empty, unpublished state without a bucket read', async () => {
    const client = fakeDataClient(query => (query.includes('-- ur:windows') ? [{ ...WINDOWS, folded: '0' }] : query.includes('-- ur:unmeasured') || query.includes('-- ur:account-coverage') ? [] : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/stats/user-revenue', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ publishedThrough: null, items: [], coverage: { from: null, complete: false } })
    expect(client.seen.some(s => s.query.includes('-- ur:day-buckets'))).toBe(false)
  })
})

describe('GET /v1/accounts/{address}/earnings', () => {
  const ACCOUNT = `0x${'22'.repeat(32)}`
  const ETH_FORM = `0x45544800${'22'.repeat(20)}0000000000000000`
  const now = new Date()
  const currentMonth = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1

  it('combines the native and ETH-mapped identities and splits earned / paid / net', async () => {
    const client = fakeDataClient(
      windowsHandler,
      query => (query.includes('-- ur:account-coverage') ? [{ m: String(currentMonth), computed: '1756375200', through: String(Date.UTC(2026, 7, 28, 11) / 1000), expected_first: String(currentMonth) }] : undefined),
      query => (query.includes('-- ur:account-buckets')
        ? [{ t: String(Date.UTC(2026, 7, 1) / 1000), stream: 'mm_supply_interest', holder_class: 'user', earned: '5.555', paid: '0', net: '5.555', unpriced: '0' },
           { t: String(Date.UTC(2026, 7, 1) / 1000), stream: 'farm_rewards', holder_class: 'user', earned: '10', paid: '-2.5', net: '7.5', unpriced: '1' },
           { t: String(Date.UTC(2026, 7, 1) / 1000), stream: 'mm_borrow_interest', holder_class: 'user', earned: '0', paid: '-9.674', net: '-9.674', unpriced: '0', h_earned: '0', h_paid: '-9.003', h_net: '-9.003' }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACCOUNT}/earnings?bucket=month&fromTime=2026-01-01T00:00:00Z&toTime=2026-09-01T00:00:00Z`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.account.accountIdHex).toBe(ACCOUNT)
    expect(body.from).toBe('2026-01-01T00:00:00.000Z')
    // Clamped to the account fold's cut, like /v1/stats/user-revenue: never a day the fold has not published.
    expect(body.to).toBe('2026-08-28T11:00:00.000Z')
    expect(body.coverage.complete).toBe(true)
    expect(body.publishedThrough).toBe('2026-08-28T11:00:00.000Z') // the account fold's own cut
    expect(body.items).toEqual([
      { bucket: '2026-08-01T00:00:00.000Z', stream: 'mm_supply_interest', holderClass: 'user', earnedUsd: '5.56', paidUsd: '0.00', amountUsd: '5.56', unpricedCells: 0 },
      { bucket: '2026-08-01T00:00:00.000Z', stream: 'farm_rewards', holderClass: 'user', earnedUsd: '10.00', paidUsd: '-2.50', amountUsd: '7.50', unpricedCells: 1 },
      // Additive: the HOLLAR part of the account's borrow interest, inside the item's own figures.
      {
        bucket: '2026-08-01T00:00:00.000Z', stream: 'mm_borrow_interest', holderClass: 'user', earnedUsd: '0.00', paidUsd: '-9.67', amountUsd: '-9.67', unpricedCells: 0,
        hollarInterest: { earnedUsd: '0.00', paidUsd: '-9.00', amountUsd: '-9.00' },
      },
    ])
    const read = client.seen.find(s => s.query.includes('-- ur:account-buckets'))!
    expect(read.params.accounts).toEqual([ACCOUNT, ETH_FORM])
    expect(read.params.from).toBe('2026-01-01')
    expect(read.params.to).toBe('2026-08-28')
    expect(read.query).toContain('FROM price_data.account_user_revenue_daily')
    expect(res.headers['cache-control']).toBe('private, max-age=300')
  })

  it('reads nothing for a window wholly past the account fold\'s cut', async () => {
    const client = fakeDataClient(
      windowsHandler,
      query => (query.includes('-- ur:account-coverage') ? [{ m: String(currentMonth), computed: '1', through: String(Date.UTC(2026, 7, 28, 11) / 1000), expected_first: String(currentMonth) }] : undefined),
      query => (query.includes('-- ur:account-buckets') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACCOUNT}/earnings?fromTime=2026-09-01T00:00:00Z&toTime=2026-09-10T00:00:00Z`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    // An empty window past the cut is the empty interval AT the cut: `to` never passes publishedThrough.
    expect(res.json()).toMatchObject({ from: '2026-08-28T11:00:00.000Z', to: '2026-08-28T11:00:00.000Z', publishedThrough: '2026-08-28T11:00:00.000Z', items: [] })
    expect(client.seen.some(s => s.query.includes('-- ur:account-buckets'))).toBe(false)
  })

  it('flags an account fold with an unpublished month as incomplete but still answers', async () => {
    const client = fakeDataClient(
      windowsHandler,
      // The current month is missing: the fold has not reached it.
      query => (query.includes('-- ur:account-coverage') ? [{ m: '202201', computed: '1756375200', expected_first: '202201' }] : undefined),
      query => (query.includes('-- ur:account-buckets') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACCOUNT}/earnings`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ items: [], coverage: { from: '2022-01-01T00:00:00.000Z', complete: false } })
  })

  it('reads a bound EVM address\'s earnings under its substrate owner, the fold\'s booking key', async () => {
    const h160 = `${'ab'.repeat(20)}`
    const owner = `0x${h160}${'cd'.repeat(12)}`
    const client = fakeDataClient(
      windowsHandler,
      query => (query.includes('-- ur:account-coverage') ? [{ m: String(currentMonth), computed: '1', through: String(Math.floor(Date.now() / 1000) - 3_600), expected_first: String(currentMonth) }] : undefined),
      query => (query.includes('-- ur:booking-key') ? [{ owner }] : undefined),
      query => (query.includes('-- ur:account-buckets') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/0x${h160}/earnings`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().bookedUnder.accountIdHex).toBe(owner)
    expect(client.seen.find(s => s.query.includes('-- ur:booking-key'))!.params.h).toBe(`0x${h160}`)
    expect(client.seen.find(s => s.query.includes('-- ur:account-buckets'))!.params.accounts).toEqual([owner, `0x45544800${h160}0000000000000000`])
  })

  it('keys the cached facts on the account fold\'s cut and the publication generation, so any rebuild of the month is served at once', async () => {
    const through = Date.UTC(2026, 7, 28, 11) / 1000
    const client = fakeDataClient(
      windowsHandler,
      query => (query.includes('-- ur:account-coverage') ? [{ m: String(currentMonth), computed: '1', through: String(through), expected_first: String(currentMonth) }] : undefined),
      query => (query.includes('-- ur:account-buckets') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const url = `/v1/accounts/${ACCOUNT}/earnings?fromTime=2026-08-01T00:00:00Z&toTime=2026-08-10T00:00:00Z`
    await app.inject({ url, headers: AUTH })
    expect(client.seen.filter(s => s.query.includes('-- ur:account-buckets')).length).toBe(1)
    const { earningsCacheKey } = await import('../../src/data/routes/userRevenue.ts')
    expect(earningsCacheKey('a', 'day', '2026-08-01', '2026-08-09', through, 1)).not.toBe(earningsCacheKey('a', 'day', '2026-08-01', '2026-08-09', through + 3_600, 1))
    // A rebuild at the same cut (a restated closed month) turns the key over too.
    expect(earningsCacheKey('a', 'day', '2026-08-01', '2026-08-09', through, 1)).not.toBe(earningsCacheKey('a', 'day', '2026-08-01', '2026-08-09', through, 2))
    const { userRevenueStatsCacheKey } = await import('../../src/data/routes/userRevenue.ts')
    expect(userRevenueStatsCacheKey('day', undefined, 'user', '2026-08-01', '2026-08-09', through, 1)).not.toBe(userRevenueStatsCacheKey('day', undefined, 'user', '2026-08-01', '2026-08-09', through, 2))
  })

  it('400s an unparseable address', async () => {
    app = await freshDataApp(fakeDataClient(windowsHandler))
    expect((await app.inject({ url: '/v1/accounts/not-an-address/earnings', headers: AUTH })).statusCode).toBe(400)
  })
})

describe('dayWindowThroughCut (both User Revenue routes)', () => {
  const t = (iso: string) => Date.parse(iso) / 1000
  it('widens to whole days, clamps to the cut, and states an empty future window at the cut', async () => {
    const { dayWindowThroughCut } = await import('../../src/data/routes/userRevenue.ts')
    const cut = t('2026-08-28T11:00:00Z')
    expect(dayWindowThroughCut(t('2026-08-01T05:00:00Z'), t('2026-08-10T05:00:00Z'), cut))
      .toEqual({ from: t('2026-08-01T00:00:00Z'), to: t('2026-08-11T00:00:00Z'), fromDay: '2026-08-01', toDay: '2026-08-10' })
    expect(dayWindowThroughCut(t('2026-08-01T00:00:00Z'), t('2026-09-10T00:00:00Z'), cut).to).toBe(cut)
    // A fromTime later on the cut's own day still reads that day (widened to its start) up to the cut.
    expect(dayWindowThroughCut(t('2026-08-28T12:00:00Z'), t('2026-08-29T12:00:00Z'), cut)).toMatchObject({ from: t('2026-08-28T00:00:00Z'), to: cut })
    // A window whose first day starts after the cut: empty, at the cut.
    for (const from of [t('2026-08-29T05:00:00Z'), t('2026-09-01T00:00:00Z')]) {
      const w = dayWindowThroughCut(from, from + 86_400, cut)
      expect(w.from).toBe(cut)
      expect(w.to).toBe(cut)
    }
    // Nothing published: the empty interval at the first day's start.
    expect(dayWindowThroughCut(t('2026-08-01T05:00:00Z'), t('2026-08-10T00:00:00Z'), null)).toMatchObject({ from: t('2026-08-01T00:00:00Z'), to: t('2026-08-01T00:00:00Z') })
  })
})
