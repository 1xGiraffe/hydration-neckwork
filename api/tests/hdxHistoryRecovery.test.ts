import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The dashboard's other sections come from the explorer and the chain snapshot;
// stub them so only the history's lifecycle is exercised.
vi.mock('../src/services/explorerService.ts', () => ({
  accountRef: (a: string) => ({ address: a }),
  bindCteSql: () => 'SELECT 1',
  boundAccountSql: () => '1',
  ensurePrices: async () => new Map([[0, { price: 0.01, change24h: 0 }]]),
  cutoffHeightForWindow: async () => 0,
  getGigaMarketStats: async () => null,
  getGigaLiquidationLevels: async () => null,
}))
vi.mock('../src/services/blockTime.ts', () => ({ NOMINAL_RELAY_BLOCK_MS: 6_000, paraBlockMs: async () => 2_000 }))
vi.mock('../src/services/tagService.ts', () => ({ allTags: () => [], economicModuleAccounts: () => [] }))
vi.mock('../src/services/bondState.ts', () => ({ currentBondSnapshot: () => null }))

const { resetCacheForTests } = await import('../src/services/cache.ts')
const { getHdxDashboard, hdxHistoryRetryDelayMs, initHdxService, refreshHdxHistory } = await import('../src/services/hdxService.ts')

const GENERATION = [{ snapshot_id: '1794000000000-test', cut: '2026-11-09', cut_height: 16787098, source_at: '2026-11-10 12:00:00', assets: ['0'], n: 1 }]

describe('the /hdx history recovers on the refresher', () => {
  let structureFails = 0
  let structureReads = 0
  let now = Date.parse('2026-11-10T12:00:00Z')
  const client = {
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes('hdx:closes-pointer')) return GENERATION
        if (query.includes('hdx:closes-marks')) return [{ cut: '2026-11-09', touched: 0 }]
        if (query.includes('max(block_height) AS h')) return [{ h: 16_800_000, t: Math.floor(now / 1000) }]
        if (query.includes('groupArraySortedIf')) {
          structureReads++
          if (structureFails > 0) { structureFails--; throw new Error('Timeout exceeded: elapsed 20000 ms') }
          return [{ i: 0, treasury: '1', protocol: '0', kraken: '0', user_total: '0', sq: '0', top: [], a0: '0', a1: '0', a2: '0', a3: '0', st_anchor: [], st_sum: [] }]
        }
        return []
      },
    }),
  }
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)) }

  beforeEach(() => {
    resetCacheForTests()
    initHdxService(client as never)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('backs off from 30 s, doubling to ten minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(hdxHistoryRetryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  })

  it('publishes a failed history as pending, then completes the dashboard once a retry lands', async () => {
    structureFails = 2
    const first = await getHdxDashboard()
    // the history failed: its sections are absent, never zeros, and the rest is there
    expect(first.historyPending).toBe(true)
    expect(first.structure).toBeNull()
    expect(first.churn).toBeNull()
    expect(first.price).toBe(0.01)
    await settle()
    const afterFirst = structureReads

    // inside the backoff the refresher leaves it alone
    await refreshHdxHistory()
    await settle()
    expect(structureReads).toBe(afterFirst)

    // past it the refresher reads it again; a second failure doubles the wait
    now += 30_000
    await refreshHdxHistory()
    await settle()
    expect(structureReads).toBe(afterFirst + 1)
    now += 30_000
    await refreshHdxHistory()
    await settle()
    expect(structureReads).toBe(afterFirst + 1)

    // the retry that lands rebuilds the dashboard with its history
    now += 30_000
    await refreshHdxHistory()
    await settle()
    const done = await getHdxDashboard()
    expect(done.historyPending).toBe(false)
    expect(done.structure?.weeks.length).toBeGreaterThan(0)
    expect(done.churn).not.toBeNull()

    // and once it is in, the refresher reads nothing more
    const reads = structureReads
    now += 3_600_000
    await refreshHdxHistory()
    await settle()
    expect(structureReads).toBe(reads)
  })
})
