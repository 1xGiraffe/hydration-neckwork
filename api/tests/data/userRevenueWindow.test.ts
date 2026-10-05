import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// The User Revenue facts are whole UTC days, so an intra-day toTime cannot cut a
// day: the routes widen the window to whole days and REPORT the widened window.

type Row = Record<string, unknown>
let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

const WINDOWS: Row = {
  expected_first: String(Date.UTC(2022, 2, 12, 12) / 1000), first_hour: String(Date.UTC(2022, 2, 12, 12) / 1000), last_hour: String(Date.UTC(2026, 7, 28, 10) / 1000),
  folded: String((Date.UTC(2026, 7, 28, 10) - Date.UTC(2022, 2, 12, 12)) / 3_600_000 + 1),
  folded_day: '24', folded_week: '168', folded_month: '720', day: '1', week: '2', month: '3', all_time: '4', unpriced: '0',
}
const cut = Date.UTC(2026, 7, 28, 11) / 1000
const client = () => fakeDataClient(
  q => (q.includes('-- ur:windows') ? [WINDOWS] : q.includes('-- ur:unmeasured') ? [] : undefined),
  q => (q.includes('-- ur:account-coverage') ? [{ m: '202608', computed: '1756375200', through: String(cut), expected_first: '202608' }] : undefined),
  q => (q.includes('-- ur:day-buckets') || q.includes('-- ur:account-buckets') || q.includes('booking') ? [] : undefined),
)

describe('user revenue windows are whole UTC days', () => {
  it('stats: an intra-day toTime reports the end of its day', async () => {
    const c = client()
    app = await freshDataApp(c)
    const res = await app.inject({ url: '/v1/stats/user-revenue?fromTime=2026-08-20T07:00:00Z&toTime=2026-08-25T12:00:00Z', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ from: '2026-08-20T00:00:00.000Z', to: '2026-08-26T00:00:00.000Z' })
    const read = c.seen.find(s => s.query.includes('-- ur:day-buckets'))!
    expect(read.params).toMatchObject({ from: '2026-08-20', to: '2026-08-25' })
  })

  it('stats: a midnight toTime ends there, and the cut still clamps', async () => {
    app = await freshDataApp(client())
    const midnight = await app.inject({ url: '/v1/stats/user-revenue?fromTime=2026-08-20T00:00:00Z&toTime=2026-08-25T00:00:00Z', headers: AUTH })
    expect(midnight.json()).toMatchObject({ to: '2026-08-25T00:00:00.000Z' })
    const pastCut = await app.inject({ url: '/v1/stats/user-revenue?fromTime=2026-08-20T00:00:00Z&toTime=2026-08-28T05:00:00Z', headers: AUTH })
    expect(pastCut.json()).toMatchObject({ to: '2026-08-28T11:00:00.000Z' })
  })
})
