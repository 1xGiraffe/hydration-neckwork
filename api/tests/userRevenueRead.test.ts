import { describe, expect, it } from 'vitest'
import {
  accountCoverageFromMonths, userRevenueWindowsSql, windowFirstDay, windowsFromRow,
} from '../src/services/userRevenueRead.ts'
import { foldUserRevenueBreakdown } from '../src/services/explorerService.ts'

const H = 3_600
const row = (over: Partial<Record<string, string>> = {}) => ({
  expected_first: String(1_000 * H), first_hour: String(1_000 * H), last_hour: String(2_000 * H), folded: '1001',
  folded_day: '24', folded_week: '168', folded_month: '720',
  day: '1.5', week: '10', month: '-3.25', all_time: '100', unpriced: '7',
  ...over,
})

describe('userRevenueWindows (windowsFromRow)', () => {
  it('states every window and the cut once every hour is folded', () => {
    const w = windowsFromRow(row())
    expect(w.coverage.complete).toBe(true)
    expect(w.coverage.publishedThrough).toBe(2_001 * H)
    expect(w.day).toBe(1_500_000_000_000n)
    expect(w.month).toBe(-3_250_000_000_000n) // a net-negative window is a real figure, never clamped
    expect(w.allTime).toBe(100_000_000_000_000n)
    expect(w.unpricedCells).toBe(7)
  })

  it('nulls a window with an unfolded hour — never a plausible 0', () => {
    const w = windowsFromRow(row({ folded: '1000', folded_week: '167', folded_month: '719' }))
    expect(w.day).not.toBeNull()
    expect(w.week).toBeNull()
    expect(w.month).toBeNull()
    expect(w.allTime).toBeNull()
    expect(w.coverage.complete).toBe(false)
  })

  it('nulls a window reaching back before the first folded hour', () => {
    const w = windowsFromRow(row({ expected_first: String(1_990 * H), first_hour: String(1_990 * H), folded: '11', folded_day: '11', folded_week: '11', folded_month: '11' }))
    expect(w.day).toBeNull()
    expect(w.allTime).not.toBeNull()
  })

  it('states all time only when the folded hours reach back to the expected floor, not merely contiguous from the first marker', () => {
    // Contiguous 1,990..2,000 but the folds start at hour 1,000: the early history is not published.
    const late = windowsFromRow(row({ first_hour: String(1_990 * H), folded: '11', folded_day: '11', folded_week: '11', folded_month: '11' }))
    expect(late.allTime).toBeNull()
    expect(late.coverage.complete).toBe(false)
    expect(windowsFromRow(row({ expected_first: undefined })).allTime).toBeNull()
    expect(windowsFromRow(row()).allTime).toBe(100_000_000_000_000n)
  })

  it('reads the expected floor with the derivations\' price floor, character for character', async () => {
    const { PRICED_FLOOR_SQL } = await import('../src/derivations/jobs.ts')
    const { USER_REVENUE_EXPECTED_FIRST_HOUR_SQL } = await import('../src/services/userRevenueRead.ts')
    expect(USER_REVENUE_EXPECTED_FIRST_HOUR_SQL).toBe(PRICED_FLOOR_SQL)
    expect(userRevenueWindowsSql()).toContain(`toUnixTimestamp(${PRICED_FLOOR_SQL}) AS expected_first`)
  })

  it('publishes nothing while no hour is folded', () => {
    const w = windowsFromRow(undefined)
    expect(w.coverage.publishedThrough).toBeNull()
    expect([w.day, w.week, w.month, w.allTime]).toEqual([null, null, null, null])
    expect(w.coverage.unmeasured.length).toBeGreaterThan(0)
  })

  it('reads markers and amounts in one pass and never aliases a column it reads again', () => {
    const sql = userRevenueWindowsSql()
    expect(sql).toContain("stream = ''")
    expect(sql).not.toMatch(/AS last_hour\s*\n\s*SELECT/)
  })
})

describe('account fold coverage', () => {
  const now = Date.UTC(2026, 9, 4, 6) / 1000
  it('is complete only when every month from the price floor\'s month through the current one is published', () => {
    // Folds start at the price floor (2022-03): Aug–Oct 2026 alone is a history with a missing prefix.
    expect(accountCoverageFromMonths([{ m: 202608, computed: 1 }, { m: 202609, computed: 2 }, { m: 202610, computed: 3, through: 1_790_000_000 }], now, 202203))
      .toEqual({ firstMonth: 202608, lastMonth: 202610, complete: false, computedAt: 3, publishedThrough: 1_790_000_000, computedByMonth: new Map([[202608, 1], [202609, 2], [202610, 3]]) })
    expect(accountCoverageFromMonths([{ m: 202608, computed: 1 }, { m: 202609, computed: 2 }, { m: 202610, computed: 3, through: 1_790_000_000 }], now, 202608))
      .toEqual({ firstMonth: 202608, lastMonth: 202610, complete: true, computedAt: 3, publishedThrough: 1_790_000_000, computedByMonth: new Map([[202608, 1], [202609, 2], [202610, 3]]) })
    // An unknown floor never reads complete.
    expect(accountCoverageFromMonths([{ m: 202608, computed: 1 }, { m: 202609, computed: 2 }, { m: 202610, computed: 3 }], now, null).complete).toBe(false)
    // The account cut is the newest month's folded-through hour, never its computation time; unset reads null.
    expect(accountCoverageFromMonths([{ m: 202610, computed: 3, through: 0 }], now, 202610).publishedThrough).toBeNull()
    expect(accountCoverageFromMonths([{ m: 202608, computed: 1 }, { m: 202610, computed: 3 }], now, 202608).complete).toBe(false)
    expect(accountCoverageFromMonths([{ m: 202609, computed: 2 }], now, 202609).complete).toBe(false)
    expect(accountCoverageFromMonths([{ m: 202512, computed: 1 }, { m: 202601, computed: 1 }], Date.UTC(2026, 0, 2) / 1000, 202512).complete).toBe(true)
    expect(accountCoverageFromMonths([], now, 202203).complete).toBe(false)
  })
})

describe('publication generation', () => {
  it('is the newest build among the months a window covers, so a same-cut rebuild of a covered month moves it', async () => {
    const { publicationGeneration } = await import('../src/services/userRevenueRead.ts')
    const cov = { computedByMonth: new Map([[202607, 50], [202608, 10], [202609, 20], [202610, 30]]) }
    expect(publicationGeneration(cov)).toBe(50)
    expect(publicationGeneration(cov, '2026-08-01', '2026-09-30')).toBe(20)
    expect(publicationGeneration(cov, '2026-09-15', null)).toBe(30)
    expect(publicationGeneration({ computedByMonth: new Map() })).toBe(0)
  })
})

describe('day windows', () => {
  it('end on the day holding the cut (an exclusive end instant)', () => {
    const cut = Date.UTC(2026, 9, 4, 4) / 1000
    expect(windowFirstDay(cut, 30)).toBe('2026-09-05')
    expect(windowFirstDay(Date.UTC(2026, 9, 4) / 1000, 1)).toBe('2026-10-03')
  })
})

describe('foldUserRevenueBreakdown', () => {
  const u = (stream: string, pot: string, assetId: number, net: bigint, holderClass: 'user' | 'protocol' = 'user') => ({
    stream, pot, via: '', assetId, holderClass, earned: net > 0n ? net : 0n, paid: net < 0n ? net : 0n, net, unpriced: 0,
  })
  const T = 1_000_000_000_000n
  it('orders streams as defined, keeps signs, and states non-user facts beside the user totals', () => {
    const out = foldUserRevenueBreakdown('all', null, { complete: true, computedAt: 0, publishedThrough: Date.UTC(2026, 9, 4, 5) / 1000 }, [
      u('mm_borrow_interest', 'core:222', 222, -5n * T),
      u('lp_fee_omnipool', 'omnipool:0', 0, 3n * T),
      u('lp_fee_omnipool', 'omnipool:5', 5, 1n * T),
      u('mm_supply_interest', 'core:10', 10, 9n * T, 'protocol'),
    ], [
      { day: '2026-09-01', stream: 'lp_fee_omnipool', holderClass: 'user', net: 4n * T, earned: 4n * T, paid: 0n },
      { day: '2026-09-15', stream: 'mm_borrow_interest', holderClass: 'user', net: -5n * T, earned: 0n, paid: -5n * T },
    ])
    expect(out.streams.map(s => s.stream)).toEqual(['lp_fee_omnipool', 'mm_borrow_interest'])
    expect(out.streams[0].items.map(i => i.pot)).toEqual(['omnipool:0', 'omnipool:5']) // largest |net| first
    expect(out.streams[0].items[0].potLabel).toMatch(/^Omnipool · /)
    expect(out.totals).toEqual({ earned: 4, paid: -5, net: -1, unpriced: 0 })
    expect(out.otherClasses).toEqual([{ holderClass: 'protocol', net: 9 }])
    expect(out.asOf).toBe('2026-10-04T05:00:00.000Z') // the account fold's cut, not its computation time
    // 'all' buckets by month: both days fall into September.
    expect(out.points).toHaveLength(1)
    expect(out.points[0]).toMatchObject({ earned: 4, paid: -5, net: -1 })
  })

  it('folds the item tail past the shown cap', () => {
    const rows = Array.from({ length: 14 }, (_, i) => u('lp_fee_xyk', `xyk:${100 + i}`, 100 + i, BigInt(i + 1) * T))
    const out = foldUserRevenueBreakdown('30d', '2026-09-05', { complete: false, computedAt: null }, rows, [])
    expect(out.streams[0].items).toHaveLength(10)
    expect(out.streams[0].otherCount).toBe(4)
    expect(out.streams[0].otherNet).toBe(1 + 2 + 3 + 4)
    expect(out.complete).toBe(false)
    expect(out.grain).toBe('day')
  })
})

describe('/accounts sort user-revenue', () => {
  it('ranks positive > zero > negative > not a user row > not yet published, never ifNull-ing the unknown into the zeros', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
    const line = src.split('\n').find(l => l.trim().startsWith("'user-revenue':")) ?? ''
    // |net| under half a cent is a zero; a row with no user member (ur_has_user = 0) ranks after the payers.
    expect(line).toContain('multiIf(user_revenue_usd IS NULL, 4, ur_has_user = 0, 3, user_revenue_usd >= 0.005, 0, user_revenue_usd > -0.005, 1, 2) ASC')
    expect(src).toContain("${urUser ? `max(${urUser.sql})` : 'toUInt8(1)'} AS ur_has_user,")
    expect(line).toContain('user_revenue_usd DESC NULLS LAST')
    expect(line).toContain('g.gkey ASC')
    // A published-coverage page reads 0 for an account the facts never name; an
    // unpublished one is NULL throughout.
    expect(src).toContain("const userRevenueSelect = userRevenueCte ? 'toNullable(ifNull(urv.volume_usd, 0.))' : 'CAST(NULL AS Nullable(Float64))'")
  })
})

describe('unmeasured list', () => {
  it('lists every era gap, then each token the fold itself marked unmeasured, with a reader-facing reason', async () => {
    const { unmeasuredList, unmeasuredText } = await import('../src/services/userRevenueRead.ts')
    expect(unmeasuredList([]).every(u => u.scope === 'era')).toBe(true)
    const fromRows = unmeasuredList([{ assetId: 46, reason: 'peg-never-moved', hours: 720, lastHour: 0 }, { assetId: 33, reason: 'brand-new', hours: 3, lastHour: 0 }])
    const tokens = fromRows.filter(u => u.scope === 'token')
    expect(tokens[0]).toMatchObject({ id: 'unmeasured:46:peg-never-moved', reason: expect.stringContaining('static governance-set peg') })
    expect(tokens[1].reason).toContain('brand new')
    expect(unmeasuredText(tokens[0])).toMatch(/accrual: its on-chain rate never moved/)
  })
})

describe('the holder rule as SQL (directory ranking)', () => {
  it('tiers custodies and tagged non-users out, foreign treasuries in, prefixes out', async () => {
    const { holderIsUserSql } = await import('../src/services/userRevenueHolders.ts')
    const { resetCacheForTests } = await import('../src/services/cache.ts')
    resetCacheForTests()
    const fake = { query: async ({ query }: { query: string }) => ({ json: async () => (query.includes('ur:protocol-holders')
      ? [{ a: '0x' + '11'.repeat(32), t: 'treasury' }, { a: '0x7369626cd4070000000000000000000000000000000000000000000000000000', t: 'moonbeam-treasury' }, { a: '0x' + '22'.repeat(32), t: 'snowbridge' }]
      : []) }) } as never
    const { sql, params, ...lists } = await holderIsUserSql(fake, 'x')
    expect(Object.keys(params).sort()).toEqual(['urNonUser_0', 'urUser_0'])
    expect(params.urUser_0).toEqual(lists.urUser)
    expect(params.urNonUser_0).toEqual(lists.urNonUser)
    expect(lists.urUser).toContain('0x7369626cd4070000000000000000000000000000000000000000000000000000')
    expect(lists.urNonUser).toContain('0x' + '11'.repeat(32))
    expect(lists.urNonUser).toContain('0x' + '22'.repeat(32))
    expect(lists.urNonUser).not.toContain('0x7369626cd4070000000000000000000000000000000000000000000000000000')
    expect(sql).toContain("startsWith(lower(x), '0x7369626c')")
    expect(sql).toContain("lower(x) = '0x506172656e740000000000000000000000000000000000000000000000000000'")
  })
})

describe('one identity per directory row (userRevenueTwinOwners)', () => {
  // A substrate account and its ETH-mapped twin (0x45544800 + its first 20 bytes + zero padding), which holds
  // balances of its own and so is a directory row too; and a pure EVM account no substrate account owns.
  const S = '0x' + 'ab'.repeat(32)
  const T = '0x45544800' + 'ab'.repeat(20) + '0'.repeat(16)
  const EVM = '0x45544800' + 'cd'.repeat(20) + '0'.repeat(16)
  it('books an owned twin on its owner\'s row only — never twice — and an unowned twin on its own', async () => {
    const { userRevenueRowAccounts, userRevenueTwinOf } = await import('../src/services/userRevenueRead.ts')
    expect(userRevenueTwinOf(S)).toBe(T)
    expect(userRevenueTwinOf(T)).toBeNull()
    const owners = new Map([[T, S]])
    expect(userRevenueRowAccounts([S], owners).sort()).toEqual([S, T].sort())
    expect(userRevenueRowAccounts([T], owners)).toEqual([])
    expect(userRevenueRowAccounts([EVM], owners)).toEqual([EVM])
    // A row holding both (a tag with both members) counts the twin once.
    expect(userRevenueRowAccounts([S, T], owners).sort()).toEqual([S, T].sort())
    // A substrate account whose twin no rule assigns to it (it holds no balance) does not take the twin.
    expect(userRevenueRowAccounts([S], new Map())).toEqual([S])
  })
  // The pairs were bound as two Array(String) parameters; 1,440 twins (2026-10-05) already encoded to ~104 KB each,
  // and 2,000 would be refused by the server's field ceiling. The relation now lives in the statement itself.
  it('the ranking SQL folds the same pairs before grouping, computed in ClickHouse, with no bound list', async () => {
    const { userRevenueOwnerKeySql } = await import('../src/services/userRevenueRead.ts')
    const { encodedParamBytes, HTTP_FIELD_VALUE_LIMIT } = await import('../src/db/queryParams.ts')
    const twins = Array.from({ length: 2_000 }, (_, i) => '0x45544800' + i.toString(16).padStart(40, '0') + '0'.repeat(16))
    expect(encodedParamBytes(twins)).toBeGreaterThan(HTTP_FIELD_VALUE_LIMIT)
    const sql = userRevenueOwnerKeySql('account')
    expect(sql).not.toMatch(/\{[A-Za-z_]+:/)
    expect(sql).toMatch(/^transform\(account, arrayMap\(p -> p\.1, \(SELECT arraySort\(groupArray\(\(twin, owner\)\)\)/)
    expect(sql).toContain('price_data.account_asset_latest_balances')
    // The same statement userRevenueTwinOwners reads (one rule): both pick min(substrate account) per twin.
    expect(sql.match(/min\(s\.account_id\) AS owner/g)?.length).toBe(2)
  })
  it('sums a row\'s accounts exactly and snaps dust once (two −$0.004 halves are −$0.008, not $0)', async () => {
    const { userRevenueUsdOf } = await import('../src/services/userRevenueRead.ts')
    const m = new Map([[S, -4_000_000_000n], [T, -4_000_000_000n]])
    expect(userRevenueUsdOf(m, [S])).toBe(0)
    expect(userRevenueUsdOf(m, [S, T])).toBeCloseTo(-0.008, 12)
    expect(userRevenueUsdOf(m, [S, S])).toBe(0)
  })
})

describe('foldUserRevenueBreakdown — exact sums, one snap', () => {
  it('sums items exactly before snapping (the tab total equals the header stat), and drops items that are dust everywhere', async () => {
    const D = 4_000_000_000n // $0.004: dust alone
    const item = (pot: string, net: bigint) => ({ stream: 'lp_fee_omnipool', pot, via: '', assetId: 0, holderClass: 'user' as const, earned: net > 0n ? net : 0n, paid: net < 0n ? net : 0n, net, unpriced: 0 })
    const out = foldUserRevenueBreakdown('all', null, { complete: true, computedAt: 0, publishedThrough: null }, [item('omnipool:0', D), item('omnipool:5', D), item('omnipool:10', 2n * 10n ** 12n)], [])
    // Each $0.004 item is dust and is no item; together with the $2 item the stream is $2.008, not $2.
    expect(out.streams[0].items.map(i => i.pot)).toEqual(['omnipool:10'])
    expect(out.streams[0].net).toBeCloseTo(2.008, 12)
    expect(out.totals.net).toBeCloseTo(2.008, 12)
  })
})

describe('a sovereign row reads its truncated form too (M2: Moonbeam Treasury)', () => {
  it('counts a pallet or sovereign account\'s ETH-mapped form on its row, as the directory\'s remap does', async () => {
    const { userRevenueRowAccounts } = await import('../src/services/userRevenueRead.ts')
    const sibl = '0x7369626cd4070000' + '0'.repeat(24) + '0'.repeat(24)
    expect(sibl).toHaveLength(66)
    const twin = '0x45544800' + sibl.slice(2, 42) + '0'.repeat(16)
    expect(userRevenueRowAccounts([sibl], new Map()).sort()).toEqual([sibl, twin].sort())
  })
})

describe('display streams — HOLLAR interest apart from borrow interest', () => {
  it('partitions mm_borrow_interest by the fact\'s asset (HOLLAR in every market), the same rule in TS and SQL', async () => {
    const s = await import('../src/services/userRevenueStreams.ts')
    expect(s.userRevenueDisplayStream('mm_borrow_interest', 222)).toBe('mm_borrow_interest_hollar')
    expect(s.userRevenueDisplayStream('mm_borrow_interest', 5)).toBe('mm_borrow_interest')
    // Only borrow interest splits: HOLLAR lending interest, HOLLAR-valued token accrual stay as folded.
    expect(s.userRevenueDisplayStream('mm_supply_interest', 222)).toBe('mm_supply_interest')
    expect(s.userRevenueDisplayStream('token_accrual', 222)).toBe('token_accrual')
    expect(s.userRevenueDisplayStreamSql()).toBe("if((stream = 'mm_borrow_interest' AND asset_id = 222), 'mm_borrow_interest_hollar', stream)")
    // Every fold stream is still shown, the split adds one line right before borrow interest, with the agreed names.
    const ids = s.USER_REVENUE_DISPLAY_STREAMS.map(d => d.id)
    expect(ids.filter(id => id !== s.HOLLAR_INTEREST_STREAM)).toEqual(s.USER_REVENUE_STREAM_IDS)
    expect(ids.indexOf(s.HOLLAR_INTEREST_STREAM)).toBe(ids.indexOf('mm_borrow_interest') - 1)
    const label = new Map(s.USER_REVENUE_DISPLAY_STREAMS.map(d => [d.id, d]))
    expect(label.get('mm_borrow_interest_hollar')).toMatchObject({ label: 'HOLLAR interest', sign: 'paid' })
    expect(label.get('mm_borrow_interest')).toMatchObject({ label: 'Borrow interest', sign: 'paid' })
    // Only the display names change: the fold's own label (the Data API's) keeps its suffix.
    expect(s.USER_REVENUE_STREAMS.find(d => d.id === 'mm_borrow_interest')?.label).toBe('Borrow interest paid')
    // The fold's own stream list is untouched (the Data API's `stream` enum reads it).
    expect(s.USER_REVENUE_STREAM_IDS).not.toContain(s.HOLLAR_INTEREST_STREAM)
  })

  it('the account tab shows both lines, summing exactly to the old borrow interest, and the Borrow tab\'s read keeps the fold\'s stream', async () => {
    const { accountUserRevenueDetail } = await import('../src/services/userRevenueRead.ts')
    const T = 1_000_000_000_000n
    const seen: string[] = []
    const client = {
      query: async ({ query }: { query: string }) => {
        seen.push(query)
        const rows = query.includes('-- ur:account-detail')
          ? [
              { stream: 'mm_borrow_interest', pot: 'core:222', via: '', asset_id: '222', holder_class: 'user', earned: '0', paid: '-8.5', net: '-8.5', unpriced: '0' },
              { stream: 'mm_borrow_interest', pot: 'gigahdx:222', via: '', asset_id: '222', holder_class: 'user', earned: '0', paid: '-0.503', net: '-0.503', unpriced: '0' },
              { stream: 'mm_borrow_interest', pot: 'core:5', via: '', asset_id: '5', holder_class: 'user', earned: '0', paid: '-0.671', net: '-0.671', unpriced: '0' },
            ]
          : query.includes('-- ur:account-days')
            ? [
                { d: '2026-09-15', ds: query.includes('AS ds') && query.includes("'mm_borrow_interest_hollar'") ? 'mm_borrow_interest_hollar' : 'mm_borrow_interest', holder_class: 'user', net: '-9.003', earned: '0', paid: '-9.003' },
                { d: '2026-09-15', ds: 'mm_borrow_interest', holder_class: 'user', net: '-0.671', earned: '0', paid: '-0.671' },
              ]
            : []
        return { json: async () => rows }
      },
    }
    const acct = `0x${'f3'.repeat(32)}`
    const shown = await accountUserRevenueDetail(client as never, [acct], '2026-09-01', { display: true })
    expect(seen.find(q => q.includes('-- ur:account-days'))).toContain("'mm_borrow_interest_hollar', stream) AS ds")
    const out = foldUserRevenueBreakdown('30d', '2026-09-06', { complete: true, computedAt: 0, publishedThrough: null }, shown.rows, shown.days)
    expect(out.streams.map(r => [r.stream, r.label, r.paid])).toEqual([
      ['mm_borrow_interest_hollar', 'HOLLAR interest', -9.003],
      ['mm_borrow_interest', 'Borrow interest', -0.671],
    ])
    expect(out.streams[0].items.map(i => i.pot)).toEqual(['core:222', 'gigahdx:222'])
    expect(out.totals.paid).toBeCloseTo(-9.674, 12) // the split moves no cent
    expect(out.points[0].streams).toEqual([{ stream: 'mm_borrow_interest_hollar', net: -9.003 }, { stream: 'mm_borrow_interest', net: -0.671 }])
    // Without `display` the read is the fold's own (the Borrow tab's per-market slice keys on it).
    seen.length = 0
    const raw = await accountUserRevenueDetail(client as never, [acct], '2026-09-01', { days: false })
    expect(new Set(raw.rows.map(r => r.stream))).toEqual(new Set(['mm_borrow_interest']))
    expect(raw.rows.reduce((a, r) => a + r.net, 0n)).toBe(-9_674n * T / 1000n)
  })
})
