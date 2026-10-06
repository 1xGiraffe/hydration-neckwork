import { describe, expect, it } from 'vitest'
import {
  USER_FLOW_EVENT_STREAMS, USER_FLOW_MEAN_STREAMS, USER_FLOW_RATE_STREAMS, attributeUserShares, formatUserFlowCursor, pageUserFlow, parseUserFlowCursor,
  userFlowDripsSql, userShareKey, type UserFlowTailRow, type UserShare,
} from '../src/services/userRevenueLive.ts'
import { USER_REVENUE_STREAMS } from '../src/services/userRevenueStreams.ts'

const row = (over: Partial<UserFlowTailRow>): UserFlowTailRow => ({
  stream: 'lp_fee_stableswap', pot: 'stableswap:100', block_height: 1, block_timestamp: '2026-08-14 12:00:00',
  event_index: 0, leg_index: 0, earner: '', asset_id: 10, amount_usd: '1.000000000000', ...over,
})
const shares = (entries: Array<[string, string, UserShare]>): Map<string, UserShare> => new Map(entries.map(([s, p, v]) => [userShareKey(s, p), v]))
const E12 = 1_000_000_000_000n
const NO_HOLDERS = { protocol: new Set<string>() }

describe('attributeUserShares', () => {
  it('scales each event by user ÷ total of its pot, in integers', () => {
    const got = attributeUserShares([row({ amount_usd: '3.000000000000' })], shares([['lp_fee_stableswap', 'stableswap:100', { user: 1n * E12, total: 3n * E12, hour: 0 }]]), NO_HOLDERS)
    expect(got.map(r => r.userUsd1e12)).toEqual([1n * E12])
  })

  it('skips a pot with no known share — never assumes it is all users\'', () => {
    expect(attributeUserShares([row({ pot: 'stableswap:999' })], shares([['lp_fee_stableswap', 'stableswap:100', { user: E12, total: E12, hour: 0 }]]), NO_HOLDERS)).toEqual([])
    // The same pot under another stream is another share.
    expect(attributeUserShares([row({ stream: 'lp_fee_xyk' })], shares([['lp_fee_stableswap', 'stableswap:100', { user: E12, total: E12, hour: 0 }]]), NO_HOLDERS)).toEqual([])
  })

  it('excludes protocol-held pots and never emits a negative or zero item', () => {
    const s = shares([
      ['lp_fee_omnipool', 'omnipool:0', { user: 0n, total: 5n * E12, hour: 0 }],
      ['lp_fee_omnipool', 'omnipool:5', { user: -1n * E12, total: 5n * E12, hour: 0 }],
      ['lp_fee_omnipool', 'omnipool:7', { user: E12, total: 0n, hour: 0 }],
      ['lp_fee_omnipool', 'omnipool:8', { user: E12, total: E12, hour: 0 }],
    ])
    const got = attributeUserShares([
      row({ stream: 'lp_fee_omnipool', pot: 'omnipool:0' }),
      row({ stream: 'lp_fee_omnipool', pot: 'omnipool:5' }),
      row({ stream: 'lp_fee_omnipool', pot: 'omnipool:7' }),
      row({ stream: 'lp_fee_omnipool', pot: 'omnipool:8', amount_usd: '0' }), // unpriced: nothing to stream
      row({ stream: 'lp_fee_omnipool', pot: 'omnipool:8', amount_usd: '0.000000000001', event_index: 1 }),
    ], s, NO_HOLDERS)
    expect(got.map(r => [r.pot, r.userUsd1e12])).toEqual([['omnipool:8', 1n]])
  })

  it('caps a user side above its pot total at the whole event', () => {
    const got = attributeUserShares([row({})], shares([['lp_fee_stableswap', 'stableswap:100', { user: 3n * E12, total: 2n * E12, hour: 0 }]]), NO_HOLDERS)
    expect(got[0].userUsd1e12).toBe(E12)
  })
})

describe('user river stream modes', () => {
  it('partitions the earning streams: live events, live rates, and the revisable streams plus legacy staking at their mean', () => {
    const earning = USER_REVENUE_STREAMS.filter(s => s.sign !== 'paid').map(s => s.id).sort()
    const modes = [...USER_FLOW_EVENT_STREAMS, ...USER_FLOW_RATE_STREAMS, ...USER_FLOW_MEAN_STREAMS]
    expect(new Set(modes).size).toBe(modes.length)
    expect([...modes].sort()).toEqual(earning)
    // Legacy staking's pot inflows run below the gross accrual the fold books: it streams its mean, never live.
    expect([...USER_FLOW_MEAN_STREAMS].sort()).toEqual([...USER_REVENUE_STREAMS.filter(s => s.revisable).map(s => s.id), 'staking_legacy'].sort())
  })
})

describe('referral claims are their earner\'s', () => {
  const PALLET = `0x6d6f646c${'00'.repeat(28)}`
  const TAGGED = `0x${'cd'.repeat(32)}`
  const claim = (earner: string, i: number) => row({ stream: 'referral_commissions', pot: 'referrals', earner, event_index: i, amount_usd: '2.000000000000' })
  it('streams the whole claim of a user and nothing of a protocol or unattributed earner, whatever the pot share', () => {
    const got = attributeUserShares(
      [claim(`0x${'aa'.repeat(32)}`, 0), claim(PALLET, 1), claim(TAGGED, 2), claim('', 3), claim(`0x7369626c${'00'.repeat(28)}`, 4)],
      // A pot share that would have scaled every claim by ½ — not read for a claim.
      shares([['referral_commissions', 'referrals', { user: E12, total: 2n * E12, hour: 0 }]]),
      { protocol: new Set([TAGGED]) },
    )
    expect(got.map(r => [r.event_index, r.userUsd1e12])).toEqual([[0, 2n * E12]])
  })
})

describe('pageUserFlow', () => {
  const at = (block: number, event = 0, leg = 0, over: Partial<UserFlowTailRow> = {}) => row({ block_height: block, event_index: event, leg_index: leg, ...over })
  const v3 = (block: number, event = 0) => at(block, event, 2, { stream: 'lp_fee_uniswap_v3', pot: 'v3:0xpool' })
  const keys = (rs: readonly UserFlowTailRow[]) => rs.map(r => `${r.block_height}-${r.event_index}-${r.leg_index}`)

  it('serves the FIRST page after the cursor and continues from the last one returned: a dense stretch loses nothing', () => {
    const rows = Array.from({ length: 10 }, (_, i) => at(100 + i))
    const c0 = { main: [99, 0, 0] as const, v3: [99, 0, 0] as const }
    const p1 = pageUserFlow({ rows, newestSeconds: null, cursor: c0, head: 200, v3Ready: 200, limit: 4 })
    expect(keys(p1.rows)).toEqual(['100-0-0', '101-0-0', '102-0-0', '103-0-0'])
    const p2 = pageUserFlow({ rows, newestSeconds: null, cursor: p1.cursor, head: 200, v3Ready: 200, limit: 4 })
    const p3 = pageUserFlow({ rows, newestSeconds: null, cursor: p2.cursor, head: 200, v3Ready: 200, limit: 4 })
    expect([...keys(p1.rows), ...keys(p2.rows), ...keys(p3.rows)]).toEqual(keys(rows))
  })

  it('streams a v3 leg written minutes after the at-ingest cursor passed its block, exactly once', () => {
    const omni = [at(100), at(110), at(120)]
    // Pull 1: the v3 swap at 105 has no leg yet (pending → ready 104); the other sources run on to 120.
    const p1 = pageUserFlow({ rows: omni, newestSeconds: null, cursor: { main: [99, 0, 0], v3: [99, 0, 0] }, head: 121, v3Ready: 104 })
    expect(keys(p1.rows)).toEqual(['100-0-0', '110-0-0', '120-0-0'])
    // Pull 2: the leg landed; a later v3 swap (125) is still pending.
    const rows2 = [...omni, v3(105, 7), at(122)]
    const p2 = pageUserFlow({ rows: rows2, newestSeconds: null, cursor: p1.cursor, head: 126, v3Ready: 124 })
    expect(keys(p2.rows)).toEqual(['105-7-2', '122-0-0'])
    // Pull 3: unchanged tail → nothing repeats.
    const p3 = pageUserFlow({ rows: rows2, newestSeconds: null, cursor: p2.cursor, head: 126, v3Ready: 126 })
    expect(p3.rows).toEqual([])
    // The cursor round-trips through its string form.
    expect(parseUserFlowCursor(formatUserFlowCursor(p2.cursor))).toEqual(p2.cursor)
  })

  it('seeds from the newest minute of the TAIL (rows land ~50 s after their block), and an empty seed starts just before the head', () => {
    const t = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const newest = Math.floor(Date.parse('2026-08-14T12:00:00Z') / 1000)
    const rows = [at(90, 0, 0, { block_timestamp: t(newest - 300) }), at(95, 0, 0, { block_timestamp: t(newest - 50) }), at(96, 0, 0, { block_timestamp: t(newest) })]
    const seeded = pageUserFlow({ rows, newestSeconds: newest, cursor: null, head: 97, v3Ready: 97 })
    expect(keys(seeded.rows)).toEqual(['95-0-0', '96-0-0'])
    const empty = pageUserFlow({ rows: [], newestSeconds: null, cursor: null, head: 97, v3Ready: 97 })
    expect(empty.rows).toEqual([])
    // The head block's event 0 lands next: it is after the cursor.
    const next = pageUserFlow({ rows: [at(97, 0, 0)], newestSeconds: null, cursor: empty.cursor, head: 97, v3Ready: 97 })
    expect(keys(next.rows)).toEqual(['97-0-0'])
  })

  it('reads an older client\'s plain cursor, or garbage, as no cursor', () => {
    expect(parseUserFlowCursor('13600100-3-0')).toBeNull()
    expect(parseUserFlowCursor('u1.1-2-3')).toBeNull()
    expect(parseUserFlowCursor('u1.1-2-99999.1-2-3')).toBeNull()
    expect(parseUserFlowCursor(null)).toBeNull()
    expect(parseUserFlowCursor('u1.10-2-3.9-4294967295-65535')).toEqual({ main: [10, 2, 3], v3: [9, 4294967295, 65535] })
  })
})

describe('lending drips', () => {
  it('drip only the pots booked in the newest folded money-market hour, never a pot\'s last rate carried across hours', () => {
    const sql = userFlowDripsSql('price_data.user_revenue_hourly')
    const live = sql.slice(sql.indexOf("'live' AS mode"))
    expect(live).toContain('WHERE hour = (')
    expect(live).toContain("SELECT max(hour) FROM price_data.user_revenue_hourly")
    expect(live).toContain("startsWith(stream, 'mm_') AND NOT startsWith(via, 'unmeasured:'))")
    expect(live).toContain('GROUP BY stream, pot, asset_id')
    expect(live).not.toContain('LIMIT 1 BY')
  })
})
