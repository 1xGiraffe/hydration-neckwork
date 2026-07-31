import { describe, expect, it } from 'vitest'
import { dcaOrderTermsFromCallArgs, dcaOrderTermsFromEventArgs, dcaScheduleTermsFromCallArgs } from '../src/services/explorerService.ts'

// The terms a DCA trades on live in two places and neither is the dca_schedules
// projection: the order's price bound and its route are on the DCA.Scheduled event,
// while slippage and the retry limit are only on the DCA.schedule call. Both are
// read as raw JSON, so these pin the shapes the chain has actually emitted —
// verified against indexed raw_events/raw_calls — and the Option semantics that
// separate "unset" from zero.

// Real args, trimmed of nothing: a Sell with a three-hop route.
const SELL_EVENT = JSON.stringify({
  id: 34152,
  who: '0x4554480090432ce13cb0ba238686b95c1bd32fb66f2c480b0000000000000000',
  period: 6,
  totalAmount: '2781590071504041834016',
  order: {
    assetIn: 16, assetOut: 0,
    amountIn: '115899586312668409750',
    minAmountOut: '92724982101721',
    route: [
      { pool: { __kind: 'XYK' }, assetIn: 16, assetOut: 5 },
      { pool: { __kind: 'Aave' }, assetIn: 5, assetOut: 1001 },
      { pool: { __kind: 'Omnipool' }, assetIn: 1001, assetOut: 0 },
    ],
    __kind: 'Sell',
  },
})

const BUY_EVENT = JSON.stringify({
  id: 34148,
  who: '0xd2e3301ac3d70a2e0a9759fc054743223ae1eb9d18927bb39dd80254fddf087f',
  period: 6,
  totalAmount: '698265446238456168237',
  order: {
    assetIn: 222, assetOut: 0,
    amountOut: '27778000000000000',
    maxAmountIn: '239737803208536617761',
    route: [{ pool: { __kind: 'Omnipool' }, assetIn: 222, assetOut: 0 }],
    __kind: 'Buy',
  },
})

describe('dcaOrderTermsFromEventArgs', () => {
  it('reads a Sell order\'s floor and its route in order', () => {
    const terms = dcaOrderTermsFromEventArgs(SELL_EVENT)
    expect(terms?.minAmountOut).toBe('92724982101721')
    expect(terms?.maxAmountIn).toBeNull()
    expect(terms?.route).toEqual([
      { pool: 'XYK', poolId: null, assetIn: 16, assetOut: 5 },
      { pool: 'Aave', poolId: null, assetIn: 5, assetOut: 1001 },
      { pool: 'Omnipool', poolId: null, assetIn: 1001, assetOut: 0 },
    ])
  })

  it('reads a Buy order\'s ceiling instead', () => {
    const terms = dcaOrderTermsFromEventArgs(BUY_EVENT)
    expect(terms?.maxAmountIn).toBe('239737803208536617761')
    expect(terms?.minAmountOut).toBeNull()
  })

  // Only Stableswap picks between several pools, so it is the only venue that
  // carries an id — dropping it would name the venue but not the pool.
  it('keeps the pool id Stableswap hops carry', () => {
    const args = JSON.stringify({ order: { assetIn: 10, assetOut: 690, minAmountOut: '1', __kind: 'Sell', route: [{ pool: { __kind: 'Stableswap', value: 690 }, assetIn: 10, assetOut: 690 }] } })
    expect(dcaOrderTermsFromEventArgs(args)?.route).toEqual([
      { pool: 'Stableswap', poolId: 690, assetIn: 10, assetOut: 690 },
    ])
  })

  // An empty route is a real answer, not missing data: the order named no path, so
  // the router picks one per execution. Collapsing it to null would make the page
  // hide the row instead of saying so.
  it('separates "no path named" from "path unknown"', () => {
    const empty = JSON.stringify({ order: { assetIn: 5, assetOut: 222, amountIn: '1', minAmountOut: '2', route: [], __kind: 'Sell' } })
    expect(dcaOrderTermsFromEventArgs(empty)?.route).toEqual([])
    // The pre-router event shape carried no order at all.
    expect(dcaOrderTermsFromEventArgs(JSON.stringify({ id: 12, who: '0xab' }))).toBeNull()
    expect(dcaOrderTermsFromEventArgs('not json')).toBeNull()
  })

  // A floor of nothing rejects nothing. A fifth of all Sell orders set minAmountOut
  // to 0 to opt out of an absolute limit and lean on slippage alone, so reporting it
  // would state a constraint the order does not have.
  it('reads a zero bound as no bound at all', () => {
    const noFloor = JSON.stringify({ order: { assetIn: 5, assetOut: 0, amountIn: '1', minAmountOut: '0', route: [], __kind: 'Sell' } })
    expect(dcaOrderTermsFromEventArgs(noFloor)?.minAmountOut).toBeNull()
    // The route beside it is still a real answer, so the order is not discarded.
    expect(dcaOrderTermsFromEventArgs(noFloor)?.route).toEqual([])
    const noCeiling = JSON.stringify({ order: { assetIn: 5, assetOut: 0, amountOut: '1', maxAmountIn: '0', route: [], __kind: 'Buy' } })
    expect(dcaOrderTermsFromEventArgs(noCeiling)?.maxAmountIn).toBeNull()
    // One raw unit is still a bound, however useless — only an exact zero is not.
    const tiny = JSON.stringify({ order: { assetIn: 5, assetOut: 0, amountIn: '1', minAmountOut: '1', route: [], __kind: 'Sell' } })
    expect(dcaOrderTermsFromEventArgs(tiny)?.minAmountOut).toBe('1')
  })

  it('drops a malformed leg rather than inventing asset 0', () => {
    const args = JSON.stringify({ order: { __kind: 'Sell', minAmountOut: '1', route: [{ pool: {}, assetIn: 1, assetOut: 2 }, { pool: { __kind: 'Omnipool' }, assetIn: 1, assetOut: 2 }] } })
    expect(dcaOrderTermsFromEventArgs(args)?.route).toEqual([{ pool: 'Omnipool', poolId: null, assetIn: 1, assetOut: 2 }])
  })
})

describe('dcaScheduleTermsFromCallArgs', () => {
  const call = (schedule: Record<string, unknown>) => JSON.stringify({ schedule })

  it('reads slippage as the Permill it is, and the retry limit', () => {
    const args = call({ owner: '0xab', period: 6, totalAmount: '1', maxRetries: 5, slippage: 30000, order: { assetIn: 1001, assetOut: 0, amountIn: '1', minAmountOut: '2', route: [], __kind: 'Sell' } })
    expect(dcaScheduleTermsFromCallArgs(args)).toEqual({ slippagePermill: 30000, maxRetries: 5 })
  })

  // Both are Option fields. An absent maxRetries means the runtime default applies,
  // which is emphatically not "retries: 0" — the old projection extracted a key the
  // event never had and so read 0 for every schedule ever created.
  it('leaves an unset Option null rather than zero', () => {
    expect(dcaScheduleTermsFromCallArgs(call({ owner: '0xab', period: 6, totalAmount: '1', slippage: 10000, order: {} })))
      .toEqual({ slippagePermill: 10000, maxRetries: null })
    expect(dcaScheduleTermsFromCallArgs(call({ owner: '0xab', period: 6, totalAmount: '1', order: {} })))
      .toEqual({ slippagePermill: null, maxRetries: null })
    // A real zero is still a zero.
    expect(dcaScheduleTermsFromCallArgs(call({ maxRetries: 0, slippage: 0, order: {} })))
      .toEqual({ slippagePermill: 0, maxRetries: 0 })
  })

  it('returns null when there is no schedule to read', () => {
    expect(dcaScheduleTermsFromCallArgs('{}')).toBeNull()
    expect(dcaScheduleTermsFromCallArgs('not json')).toBeNull()
  })
})

// The call wraps the same order object the event carries, and it is the only place
// a pre-router schedule's order survives at all.
describe('dcaOrderTermsFromCallArgs', () => {
  it('reads the order through the call\'s schedule wrapper', () => {
    const args = JSON.stringify({
      schedule: {
        owner: '0xab', period: 6, totalAmount: '5399332313499', maxRetries: 5, slippage: 30000,
        order: { assetIn: 1001, assetOut: 0, amountIn: '1799777437833', minAmountOut: '15972144307790785', route: [{ pool: { __kind: 'Omnipool' }, assetIn: 1001, assetOut: 0 }], __kind: 'Sell' },
      },
    })
    expect(dcaOrderTermsFromCallArgs(args)).toEqual({
      minAmountOut: '15972144307790785',
      maxAmountIn: null,
      route: [{ pool: 'Omnipool', poolId: null, assetIn: 1001, assetOut: 0 }],
    })
  })

  it('returns null for a call with no order', () => {
    expect(dcaOrderTermsFromCallArgs(JSON.stringify({ schedule: { owner: '0xab' } }))).toBeNull()
  })
})
