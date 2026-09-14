import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dueContractActivityCounts, type ContractActivityEntry } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const body = (marker: string): string => {
  const at = explorerService.indexOf(marker)
  expect(at, marker).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
}

// A paced sweep orders its queue by staleness, and a member that was never RECORDED is
// infinitely stale. So an entity whose total cannot be established — the structural pots
// legitimately answer `null` — holds the front of the queue on every cycle and spends one
// of the cycle's counts forever, quietly dropping the sweep below the coverage its rate
// is sized for. Recording the attempt (a `countedAt` with no total) moves it to the back.
describe('a sweep records every attempt, answered or not', () => {
  it('records the activity leaderboards unanswerable members and its failed reads', () => {
    const sweep = body('async function refreshActivityLeaderboardUncached')

    // Both arms: the null-total answer and the thrown read.
    expect(sweep.match(/total: null, complete: false, countedAt/g)?.length).toBe(2)
    // And neither arm skips the member without writing one.
    expect(sweep).not.toContain('if (!result || result.total.total == null) continue')
  })

  it('records a contracts failed count the same way', () => {
    const sweep = body('async function refreshContractActivityCounts')

    expect(sweep).toContain('total: null, complete: false')
    expect(sweep).not.toContain('if (!total) continue')
  })

  // An unestablished total is not a zero. It is never written to the swept table the
  // directory reads, so the column shows a dash rather than "0 activities".
  it('never publishes a null total as a number', () => {
    const persist = body('async function persistActivityTotals')
    expect(persist).toContain('entry.total != null')

    const rank = explorerService.slice(explorerService.indexOf('let rankedDepth = 0'))
    expect(rank.slice(0, 300)).toContain('entry.total == null')
  })

  // The queue is the observable half of the rule, and it is pure.
  it('leaves a recorded attempt alone until its TTL, and never a never-counted one', () => {
    const now = Date.UTC(2026, 8, 14)
    const iso = (ms: number) => new Date(now - ms).toISOString()
    const entries = new Map<string, ContractActivityEntry>([
      // Answered nothing, but recorded just now: not due.
      ['0xa', { total: null, complete: false, countedAt: iso(60_000) }],
      // Counted a day ago: overdue.
      ['0xb', { total: 12, complete: true, countedAt: iso(24 * 3_600_000) }],
    ])
    // '0xc' has never been recorded at all, so it is infinitely overdue and leads.
    expect(dueContractActivityCounts(['0xa', '0xb', '0xc'], entries, now)).toEqual(['0xc', '0xb'])
    // …and once recorded — even with nothing to show for it — it stops preempting.
    entries.set('0xc', { total: null, complete: false, countedAt: iso(60_000) })
    expect(dueContractActivityCounts(['0xa', '0xb', '0xc'], entries, now)).toEqual(['0xb'])
  })

  // The rate is only sound as a relationship: each sweep must reach every member of its
  // own set inside the freshness window, with no member able to consume a slot twice in
  // one window. Pinned as arithmetic so tuning any constant has to keep it.
  it('counts fast enough to cover both sweeps sets inside their TTLs', () => {
    const constant = (name: string): number => {
      const m = new RegExp(`const ${name} = ([^\n]+)`).exec(explorerService)
      expect(m, name).not.toBeNull()
      return Number(new Function(`return ${m![1].replace(/;.*$/, '')}`)())
    }

    const leaderboardPool = constant('ACTIVITY_LEADERBOARD_POOL') + constant('ACTIVITY_LEADERBOARD_DIRECTORY_POOL_MAX')
    const leaderboardCounts = (constant('ACTIVITY_LEADERBOARD_ENTRY_TTL_MS') / constant('ACTIVITY_LEADERBOARD_REFRESH_MS'))
      * constant('ACTIVITY_LEADERBOARD_COUNTS_PER_CYCLE')
    expect(leaderboardCounts, `${leaderboardCounts} counts per TTL vs ${leaderboardPool} members`)
      .toBeGreaterThanOrEqual(leaderboardPool)

    // The contracts twin, against the registry it sweeps (~375 contracts today). Its
    // cadence is the metrics pass it rides.
    const cadence = /contractMetricsTimer = setInterval\([^,]+, ([^)]+)\)/.exec(explorerService)
    expect(cadence).not.toBeNull()
    const contractPasses = constant('CONTRACT_ACTIVITY_ENTRY_TTL_MS') / Number(new Function(`return ${cadence![1]}`)())
    expect(contractPasses * constant('CONTRACT_ACTIVITY_PER_PASS')).toBeGreaterThanOrEqual(375)
  })
})

// The accounts directory overwrites enrichAccountRows' pin with the full-portfolio
// series; /contracts never runs that pass, so its sparkline ends wherever
// enrichAccountRows left it — and a contract holding money-market collateral or debt
// would end its series on a wallet-only number while the value beside it nets both.
describe('a sparkline ends on the value shown beside it', () => {
  it('pins the final bucket from the rows total value', () => {
    expect(body('async function enrichAccountRows')).toContain('raw[i].usd_total ?? raw[i].usd')
    expect(body('async function enrichAccountSparklines')).toContain('raw[i].usd_total')
  })

  it('gives the contracts pass a total that nets the money market', () => {
    const contracts = explorerService.slice(explorerService.indexOf('const mmDelta = new Map<string'))
    expect(contracts).toContain('usd_total: usd + (mm ? mm.collateral - mm.debt : 0)')
  })
})

// A destination filter is resolved off-chain, so it is not a SQL predicate. Applied
// after the page's LIMIT/OFFSET it would return only the matches among the newest page,
// and page 2 would start at row `offset` of the UNFILTERED stream.
describe('the cross-chain swap feed pages the filtered ordering', () => {
  it('walks the source when a destination is requested', () => {
    const feed = body('export async function getRecentXcswaps')

    expect(feed).toContain('fetchFilteredDeep')
    expect(feed).toContain(`row.xcswapDestAsset === destinationAsset`)
    // The unfiltered read keeps its SQL page; the filtered one must not take an OFFSET
    // from SQL at all.
    expect(feed).toContain('return deep.slice(offset, offset + limit)')
  })
})
