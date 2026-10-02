import { describe, expect, it } from 'vitest'
import { allocateFundingPools } from '../src/services/dcaFunding.ts'

// Account 12VN3c… (2026-10-02): four open-ended orders sell HUSDC from one wallet
// holding 25,900 HUSDC — 63.6 per ~26 h into GDOT and 5.3 per ~61 min into each of
// GSOL, GETH and atBTC. Each used to claim the whole 25.9k and its own end date.
const H = 10n ** 6n
const pool = 'acc|1000'
const orders = [
  { key: 'gdot', poolKey: pool, perTrade: 636n * H / 10n, periodSeconds: 26 * 3600 },
  { key: 'gsol', poolKey: pool, perTrade: 53n * H / 10n, periodSeconds: 61 * 60 },
  { key: 'geth', poolKey: pool, perTrade: 53n * H / 10n, periodSeconds: 61 * 60 },
  { key: 'atbtc', poolKey: pool, perTrade: 53n * H / 10n, periodSeconds: 61 * 60 },
]
const balances = new Map([[pool, 25_900n * H]])

describe('allocateFundingPools', () => {
  it('splits one wallet across the orders it funds, once, by each order\'s rate', () => {
    const out = allocateFundingPools(orders, balances)
    const shares = orders.map(o => out.get(o.key)!.share!)
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(25_900n * H)
    // The three hourly orders spend ~2.1x what the daily GDOT order does.
    expect(Number(shares[1]) / Number(shares[0])).toBeCloseTo((5.3 / 61) / (63.6 / (26 * 60)), 3)
    expect(out.get('gsol')!.members).toEqual(['gdot', 'gsol', 'geth', 'atbtc'])
  })

  it('dates every member\'s end at the balance over the COMBINED rate', () => {
    const out = allocateFundingPools(orders, balances)
    const perDay = 63.6 * 86400 / (26 * 3600) + 3 * 5.3 * 86400 / (61 * 60)
    for (const o of orders) expect(out.get(o.key)!.runsOutSeconds! / 86400).toBeCloseTo(25_900 / perDay, 2)
    // ~60 days together, not the ~200–440 days each claimed alone.
    expect(out.get('gdot')!.runsOutSeconds! / 86400).toBeLessThan(70)
  })

  it('keeps separate wallets and separate assets apart', () => {
    const out = allocateFundingPools([
      { key: 'a', poolKey: 'acc|1000', perTrade: 5n, periodSeconds: 60 },
      { key: 'b', poolKey: 'acc|4444', perTrade: 5n, periodSeconds: 60 },
    ], new Map([['acc|1000', 100n], ['acc|4444', 50n]]))
    expect(out.get('a')!.share).toBe(100n)
    expect(out.get('b')!.share).toBe(50n)
    expect(out.get('a')!.members).toEqual(['a'])
  })

  it('states no split when a member\'s rate is unknown, or the balance is', () => {
    const unknownRate = allocateFundingPools([
      { key: 'sell', poolKey: pool, perTrade: 5n, periodSeconds: 60 },
      { key: 'buy', poolKey: pool, perTrade: null, periodSeconds: 60 },   // a Buy that never traded
    ], balances)
    expect(unknownRate.get('sell')!.share).toBeNull()
    expect(unknownRate.get('sell')!.runsOutSeconds).toBeNull()
    expect(unknownRate.get('sell')!.perDay).not.toBeNull()
    const noBalance = allocateFundingPools([{ key: 'x', poolKey: 'nobody|1', perTrade: 5n, periodSeconds: 60 }], new Map())
    expect(noBalance.get('x')!.share).toBeNull()
  })
})
