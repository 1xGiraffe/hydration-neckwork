import { describe, expect, it } from 'vitest'
import { isZeroPosition, moneyMarketSweepHasNoSuccess, openPositionKey, trackOpenPositions } from '../../src/raw/moneyMarketSnapshot.ts'

const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const OTHER_POOL = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
const USER = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'

function observation(pool: string, user: string, collateral: string, debt: string) {
  return { pool_address: pool, user_address: user, total_collateral_base: collateral, total_debt_base: debt }
}

describe('money-market snapshot result validation', () => {
  it('fails only when every candidate produced an RPC warning', () => {
    expect(moneyMarketSweepHasNoSuccess(0, 3)).toBe(true)
    expect(moneyMarketSweepHasNoSuccess(0, 0)).toBe(false)
    expect(moneyMarketSweepHasNoSuccess(2, 1)).toBe(false)
  })
})

describe('open money-market positions', () => {
  it('keys a position on the market and the holder, case-insensitively', () => {
    expect(openPositionKey(POOL.toUpperCase(), USER.toUpperCase())).toBe(openPositionKey(POOL, USER))
    expect(openPositionKey(POOL, USER)).not.toBe(openPositionKey(OTHER_POOL, USER))
  })

  it('treats only an all-zero aggregate as no position', () => {
    expect(isZeroPosition(observation(POOL, USER, '0', '0'))).toBe(true)
    expect(isZeroPosition(observation(POOL, USER, '1', '0'))).toBe(false)
    expect(isZeroPosition(observation(POOL, USER, '0', '1'))).toBe(false)
  })

  it('opens a pair on a non-zero aggregate and closes it on a zero, per market', () => {
    const open = new Set<string>()
    trackOpenPositions(open, [observation(POOL, USER, '500', '0'), observation(OTHER_POOL, USER, '0', '9')])
    expect(open).toEqual(new Set([openPositionKey(POOL, USER), openPositionKey(OTHER_POOL, USER)]))

    // The exit in one market leaves the holder's other market open.
    trackOpenPositions(open, [observation(POOL, USER, '0', '0')])
    expect(open).toEqual(new Set([openPositionKey(OTHER_POOL, USER)]))

    // A zero for a pair that was never open is a no-op, not an error.
    trackOpenPositions(open, [observation(POOL, USER, '0', '0')])
    expect(open).toEqual(new Set([openPositionKey(OTHER_POOL, USER)]))
  })
})
