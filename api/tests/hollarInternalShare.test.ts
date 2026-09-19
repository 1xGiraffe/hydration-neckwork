import { describe, expect, it } from 'vitest'
import { hollarBorrowHourlyRows } from '../src/services/revenueStreams.ts'

// Interest the protocol's own accounts pay on their own HOLLAR debt is the
// protocol paying itself. The reserve series books the WHOLE market's accrual
// (pool scaled debt × Δindex), so the internal part has to be carved out of it
// by the same identity, restricted to the internal holders' scaled debt — exact
// per hour, not a month-averaged ratio.
const H = 3_600
const t0 = 1_754_000_000 - (1_754_000_000 % H)
const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
const INTERNAL = 'rev:hollar-internal-debt'
const SEED = 'rev:hollar-seed'

function fakeClient(rowsByMarker: Record<string, unknown[]>): never {
  return {
    query: async ({ query }: { query: string }) => {
      const marker = [INTERNAL, SEED].find(m => query.includes(m))
        ?? Object.keys(rowsByMarker).find(m => m !== SEED && m !== INTERNAL && query.includes(m))
      return { json: async () => (marker ? rowsByMarker[marker] ?? [] : []) }
    },
  } as never
}

// 1000 HOLLAR of scaled debt, index moving 0.001 — one hour booking 1 HOLLAR.
const market = (debt: string) => ({
  'money_market_reserve_state_history': [
    { bucket: ch(t0), pool_address: '0xpool', debt_scaled: debt, borrow_index: '1000000000000000000000000000' },
    { bucket: ch(t0 + H), pool_address: '0xpool', debt_scaled: debt, borrow_index: '1001000000000000000000000000' },
  ],
  'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
})

describe('carving the protocol’s own borrow interest out of the reserve series', () => {
  it('books no internal share when no protocol account owes anything', async () => {
    const rows = await hollarBorrowHourlyRows(fakeClient(market('1000000000000000000000')), t0, t0 + H)
    expect(rows).toHaveLength(1)
    expect(rows[0].amountPlanck).toBe(10n ** 18n)
    expect(rows[0].internalPlanck).toBe(0n)
    expect(rows[0].internalUsd1e12).toBe(0n)
  })

  it('carves out exactly the internal holders’ share of the same index move', async () => {
    // A quarter of the pool's scaled debt is the treasury's.
    const rows = await hollarBorrowHourlyRows(fakeClient({
      ...market('1000000000000000000000'),
      [INTERNAL]: [{ bucket: ch(t0 - H), pool_address: '0xpool', scaled: '250000000000000000000' }],
    }), t0, t0 + H)
    expect(rows).toHaveLength(1)
    expect(rows[0].amountPlanck).toBe(10n ** 18n)
    expect(rows[0].internalPlanck).toBe(10n ** 18n / 4n)
    // Valued through the same closed candle as the gross amount.
    expect(rows[0].internalUsd1e12).toBe(rows[0].usd1e12 / 4n)
  })

  it('samples the internal debt at the observation the accrual is differenced FROM', async () => {
    // The treasury repays right before the booked hour. The accrual covers the
    // span that ENDS at t0+H, so it is the debt at t0 that earned it — reading
    // the later balance would book none of it as internal.
    const rows = await hollarBorrowHourlyRows(fakeClient({
      ...market('1000000000000000000000'),
      [INTERNAL]: [
        { bucket: ch(t0 - H), pool_address: '0xpool', scaled: '500000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xpool', scaled: '0' },
      ],
    }), t0, t0 + H)
    expect(rows[0].internalPlanck).toBe(10n ** 18n / 2n)
  })

  it('never carves out more than the market accrued', async () => {
    // Defensive: a reconstruction gap could report internal debt above the
    // pool's own. Booking a negative external amount would be worse than
    // clamping, and the clamp is visible rather than silent.
    const rows = await hollarBorrowHourlyRows(fakeClient({
      ...market('1000000000000000000000'),
      [INTERNAL]: [{ bucket: ch(t0 - H), pool_address: '0xpool', scaled: '9000000000000000000000' }],
    }), t0, t0 + H)
    expect(rows[0].internalPlanck).toBe(rows[0].amountPlanck)
  })

  it('keeps each pool’s internal debt to itself', async () => {
    const rows = await hollarBorrowHourlyRows(fakeClient({
      'money_market_reserve_state_history': [
        { bucket: ch(t0), pool_address: '0xa', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xa', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
        { bucket: ch(t0), pool_address: '0xb', debt_scaled: '1000000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(t0 + H), pool_address: '0xb', debt_scaled: '1000000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      'ohlc_1h': [{ bucket: ch(t0), close: '1' }],
      [INTERNAL]: [{ bucket: ch(t0 - H), pool_address: '0xa', scaled: '1000000000000000000000' }],
    }), t0, t0 + H)
    const byPool = new Map(rows.map(r => [r.poolAddress, r]))
    expect(byPool.get('0xa')?.internalPlanck).toBe(10n ** 18n)
    expect(byPool.get('0xb')?.internalPlanck).toBe(0n)
  })

  it('accumulates the internal series, so a later borrow adds to an earlier one', async () => {
    const rows = await hollarBorrowHourlyRows(fakeClient({
      ...market('1000000000000000000000'),
      [INTERNAL]: [
        { bucket: ch(t0 - 2 * H), pool_address: '0xpool', scaled: '100000000000000000000' },
        { bucket: ch(t0 - H), pool_address: '0xpool', scaled: '400000000000000000000' },
      ],
    }), t0, t0 + H)
    // The series is published as a running total, so the newest row at or below
    // the sample point IS the balance — 400 of the pool's 1000, not 100 + 400.
    expect(rows[0].internalPlanck).toBe(rows[0].amountPlanck * 4n / 10n)
  })
})
