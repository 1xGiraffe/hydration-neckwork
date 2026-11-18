import { describe, expect, it } from 'vitest'
import { ACTIVITY_POOL_KEY_BOUNDS, mergeTopRefs } from '../src/services/explorerService.ts'

// The activity pool is read as one top-N per key range of account_activity_v3 and
// merged; it must rank exactly what one GROUP BY over the whole table ranks.
describe('the activity pool key ranges', () => {
  const rangesOf = (account: string) => ACTIVITY_POOL_KEY_BOUNDS.slice(0, -1)
    .filter((lo, i) => account >= lo && account < ACTIVITY_POOL_KEY_BOUNDS[i + 1])

  it('are strictly increasing', () => {
    for (let i = 1; i < ACTIVITY_POOL_KEY_BOUNDS.length; i++) {
      expect(ACTIVITY_POOL_KEY_BOUNDS[i] > ACTIVITY_POOL_KEY_BOUNDS[i - 1]).toBe(true)
    }
  })

  it('put every ranked account in exactly one range', () => {
    let seed = 7
    const hex = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (seed % 16).toString(16) }
    const accounts = [
      `0x${'0'.repeat(64)}`, `0x${'f'.repeat(64)}`,
      // the module accounts the bounds cut around (Omnipool, router, referral, treasury)
      '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000',
      '0x6d6f646c726f7574657265780000000000000000000000000000000000000000',
      '0x6d6f646c726566657272616c0000000000000000000000000000000000000000',
      '0x6d6f646c70792f74727372790000000000000000000000000000000000000000',
      ...Array.from({ length: 2_000 }, () => `0x${Array.from({ length: 64 }, hex).join('')}`),
    ]
    for (const account of accounts) {
      expect(account).toMatch(/^0x[0-9a-f]{64}$/)
      expect(rangesOf(account), account).toHaveLength(1)
    }
  })

  it('merge to the same top counts as one ranking over every account', () => {
    let seed = 11
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    const all = Array.from({ length: 3_000 }, (_, i) => ({
      account: `0x${'0123456789abcdef'[rand(16)]}${i.toString(16).padStart(63, '0')}`,
      // heavy ties, so the boundary is decided by the counts and not by luck
      refs: rand(50),
    }))
    const limit = 251
    const lists = ACTIVITY_POOL_KEY_BOUNDS.slice(0, -1).map((lo, i) => all
      .filter(r => r.account >= lo && r.account < ACTIVITY_POOL_KEY_BOUNDS[i + 1])
      .sort((a, b) => b.refs - a.refs).slice(0, limit))
    const merged = mergeTopRefs(lists, limit)
    const whole = [...all].sort((a, b) => b.refs - a.refs).slice(0, limit)
    expect(merged.map(r => r.refs)).toEqual(whole.map(r => r.refs))
    // Every account strictly above the boundary count is in both.
    const boundary = whole[limit - 1].refs
    const above = (rows: typeof all) => rows.filter(r => r.refs > boundary).map(r => r.account).sort()
    expect(above(merged)).toEqual(above(whole))
  })
})
