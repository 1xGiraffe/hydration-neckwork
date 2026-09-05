import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The lanes' own wiring: which source each kind reads, how many times it reads
// it, and what its cursor is allowed to do afterwards. The two shared sources
// (the security dashboard, the activity feed) are replaced by controllable stubs,
// because both invariants under test are about the SOURCE's behaviour rather
// than the chain's — a cached snapshot that lags the head, and a query count
// that must not scale with the number of rules.

const timeline: { kind: string; label: string; detail: string; blockHeight: number; blockTimestamp: string; extrinsicIndex: number | null; asset: null }[] = []
vi.mock('../src/services/securityService.ts', () => ({
  getSecurityDashboard: async () => ({ timeline: [...timeline] }),
}))

interface ActivityCall { kind: 'address' | 'recent'; address?: string; type?: string; action?: string; filters?: Record<string, unknown>; opts?: Record<string, unknown> }
const activityCalls: ActivityCall[] = []
let activityRows: Record<string, unknown>[] = []
vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  return {
    ...actual,
    getAddressActivity: async (address: string, type: string, _limit: number, _offset: number, action?: string, filters?: Record<string, unknown>) => {
      activityCalls.push({ kind: 'address', address, type, action, filters })
      return activityRows
    },
    getRecentActivity: async (_limit: number, _from?: string, _to?: string, _offset = 0, type = 'all', filters: Record<string, unknown> = {}, _action?: string, opts: Record<string, unknown> = {}) => {
      activityCalls.push({ kind: 'recent', type, filters, opts })
      return activityRows
    },
    getMarketHealthFactor: async (address: string, market: string) => {
      healthFactorCalls.push(`${market}:${address}`)
      return healthFactors.get(`${market}:${address}`) ?? null
    },
  }
})
// Health factors keyed `${market}:${address}`, the way the lane asks for them.
const healthFactorCalls: string[] = []
const healthFactors = new Map<string, number | null>()

// The cap lane's source, replaced whole: the reserve list is the thing under
// test, and the real reader is a ClickHouse query.
let capStates: ReserveCapState[] = []
vi.mock('../src/services/moneyMarketCaps.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/moneyMarketCaps.ts')>()
  return { ...actual, moneyMarketCapStates: async () => capStates }
})

import {
  cursorKey, evaluatorCounters, evaluatorCursors, initEvaluator, resetEvaluatorForTests, runEvaluatorTick,
  stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import {
  createRule, initNotifications, loadNotifications, setNotificationState,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { mmMarkets, type ActivityRow } from '../src/services/explorerService.ts'
import type { ReserveCapState } from '../src/services/moneyMarketCaps.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const ADDRESSES = [
  '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ',
  '13QPUtNGb84S8QTs5CjRfHNGjxeuPFyfXBFcYaHqweUmzHZJ',
  '165HvUcgi1uSzhkiMSb63LCcy5oNP4a8JbeqAKgKxxWLcJXH',
]

let client: FakeClient
let tables: { raw_ingestion_state: { head: number }[]; raw_events: never[]; raw_extrinsics: never[]; referendum_lifecycle_events: never[] }

const inbox = () => insertedRows(client, 'user_notification_inbox')
const setHead = (head: number) => { tables.raw_ingestion_state[0].head = head }

const safetyEvent = (blockHeight: number) => ({
  kind: 'freeze', label: `Tradability set at ${blockHeight}`, detail: '2-Pool → Frozen',
  blockHeight, blockTimestamp: '2026-08-18 10:00:00', extrinsicIndex: 1, asset: null,
})

const trade = (blockHeight: number, eventIndex: number, valueUsd: number, assetId = 0): Record<string, unknown> => ({
  type: 'trade', blockHeight, timestamp: '2026-08-18 10:00:00', eventIndex, extrinsicIndex: 1,
  who: null, to: null, asset: null,
  assetIn: { assetId, iconAssetId: assetId, symbol: 'HDX', name: 'HDX', decimals: 12, parachainId: null, origin: null },
  assetOut: { assetId: 10, iconAssetId: 10, symbol: 'USDT', name: 'USDT', decimals: 6, parachainId: null, origin: null },
  amount: null, amountIn: '1000000000000000', amountOut: '25000000', valueUsd,
} satisfies Partial<ActivityRow> as unknown as Record<string, unknown>)

beforeEach(async () => {
  resetEvaluatorForTests()
  resetDeliveryStateForTests()
  timeline.length = 0
  activityCalls.length = 0
  activityRows = []
  healthFactorCalls.length = 0
  healthFactors.clear()
  capStates = []
  tables = { raw_ingestion_state: [{ head: 1_000 }], raw_events: [], raw_extrinsics: [], referendum_lifecycle_events: [] }
  client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
  initNotifications(client)
  await loadNotifications()
  initEvaluator(client)
})

afterEach(async () => { await stopNotificationEvaluator() })

/* ============ safety: a cursor anchored on what the snapshot showed ============ */

describe('safety lane cursor', () => {
  const watchSafety = () => createRule(OWNER, { kind: 'safety', params: {} })

  it('seeds at the newest action the timeline holds, not at the live head', async () => {
    await watchSafety()
    timeline.push(safetyEvent(900))
    setHead(1_000)
    await runEvaluatorTick()
    expect(evaluatorCursors().safety).toBe(900)
    expect(inbox()).toHaveLength(0)
  })

  // The regression this lane exists for: getSecurityDashboard is cached 20s
  // fresh / 120s stale on a key with no head in it, so several ticks in a row
  // see the SAME snapshot while the chain head runs ahead. A head-anchored
  // cursor stepped over every action that appeared in between — the lane could
  // never fire once it was warm.
  it('fires exactly once when a stale snapshot finally reveals a new action', async () => {
    await watchSafety()
    timeline.push(safetyEvent(900))
    setHead(1_000)
    await runEvaluatorTick()                       // seeds at 900

    // Two ticks of the same cached snapshot while the head advances.
    for (const head of [1_050, 1_100]) { setHead(head); await runEvaluatorTick() }
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCursors().safety).toBe(900)

    // The cache refreshes and the action is finally visible.
    timeline.push(safetyEvent(1_020))
    setHead(1_150)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].block_height).toBe(1_020)
    expect(evaluatorCursors().safety).toBe(1_020)

    // The same snapshot on later ticks is not news.
    for (const head of [1_200, 1_250]) { setHead(head); await runEvaluatorTick() }
    expect(inbox()).toHaveLength(1)
  })

  it('keeps the blind spot below the cursor, so a backfilled action stays silent', async () => {
    await watchSafety()
    timeline.push(safetyEvent(1_000))
    await runEvaluatorTick()                       // seeds at 1000
    // A repair INSERT surfaces an action from last year.
    timeline.unshift(safetyEvent(12))
    setHead(1_100)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCursors().safety).toBe(1_000)
  })

  it('adopts the legacy single cursor on an upgrade in place', async () => {
    await watchSafety()
    // The legacy cursor sat at the head, so everything the timeline already held
    // is history under it — which is what a seed means either way.
    await setNotificationState('cursor:raw-live', '1000')
    timeline.push(safetyEvent(900))
    setHead(1_000)
    await runEvaluatorTick()
    expect(evaluatorCursors().safety).toBe(1_000)
    expect(inbox()).toHaveLength(0)
  })
})

/* ============ activity sources: one fetch per address, one per asset ============ */

describe('activity source fan-out', () => {
  it('fetches once per watched ADDRESS however many rules watch it', async () => {
    // Nine rules, three addresses, every filter combination: three fetches.
    for (const address of ADDRESSES) {
      await createRule(OWNER, { kind: 'account-activity', params: { address } })
      await createRule(OWNER, { kind: 'account-activity', params: { address, type: 'trade' } })
      await createRule(OWNER, { kind: 'account-activity', params: { address, type: 'trade', minUsd: 10_000 } })
    }
    await runEvaluatorTick()                       // seeds
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(3)
    expect(new Set(activityCalls.map(c => c.address))).toEqual(new Set(ADDRESSES))
    // The group asks the widest question; each rule's own filter is re-applied
    // by the matcher over the shared page.
    expect(activityCalls.every(c => c.type === 'all' && c.action === undefined)).toBe(true)
    expect(activityCalls.every(c => Object.keys(c.filters ?? {}).length === 0)).toBe(true)
  })

  // A floor the whole group shares can be pushed into the query without hiding a
  // match, which keeps a busy address from saturating the page.
  it('fetches at the group\'s lowest floor when every rule has one', async () => {
    const address = ADDRESSES[0]
    await createRule(OWNER, { kind: 'account-activity', params: { address, minUsd: 50_000 } })
    await createRule(OWNER, { kind: 'account-activity', params: { address, type: 'trade', minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(1)
    expect(activityCalls[0].filters).toEqual({ min: 1_000, unit: 'usd' })
  })

  it('re-applies each rule\'s own filters to the shared page', async () => {
    const address = ADDRESSES[0]
    const everything = await createRule(OWNER, { kind: 'account-activity', params: { address } })
    const big = await createRule(OWNER, { kind: 'account-activity', params: { address, minUsd: 10_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityRows = [trade(1_005, 1, 25), trade(1_006, 2, 50_000)]
    await runEvaluatorTick()
    const byRule = new Map<string, number>()
    for (const row of inbox()) byRule.set(String(row.rule_id), (byRule.get(String(row.rule_id)) ?? 0) + 1)
    expect(byRule.get(everything.ruleId)).toBe(2)
    expect(byRule.get(big.ruleId)).toBe(1)
  })

  it('fetches once per ASSET at the lowest floor, plus one chain-wide group', async () => {
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 5_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 100_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 250, assetId: 10 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1_000 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 9_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(3)
    expect(activityCalls.map(c => c.filters).sort((a, b) => Number(a?.min) - Number(b?.min))).toEqual([
      { min: 250, unit: 'usd', token: '10' },
      { min: 1_000, unit: 'usd' },
      { min: 5_000, unit: 'usd', token: '0' },
    ])
  })

  // The cap bounds one tick; the rotation is what keeps the groups it skipped
  // from starving, and the held cursor is what keeps them from losing rows.
  it('caps fetches per tick, rotates over the rest, and holds the cursor until every group is seen', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(20)}`)
    for (const address of many) await createRule(OWNER, { kind: 'account-activity', params: { address } })
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_010)

    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(25)
    expect(evaluatorCounters().deferredGroups).toBe(5)
    // Five groups have not seen (1000, 1010] yet, so the cursor waits for them.
    expect(evaluatorCursors()['account-activity']).toBe(1_000)

    const firstPass = new Set(activityCalls.map(c => c.address))
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(25)
    // The rotation resumed where it stopped, so the deferred five came first.
    const secondPass = activityCalls.slice(0, 5).map(c => String(c.address))
    expect(secondPass.some(a => firstPass.has(a))).toBe(false)
    expect(new Set([...firstPass, ...secondPass]).size).toBe(30)
  })

  // The two value-floor kinds read the SAME feed under different types, so a
  // shared group key would have handed transfer rules a page of trades. Each
  // kind groups, rotates and spends its budget on its own.
  it('keeps the trade and transfer feeds on separate fetches', async () => {
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 5_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 100_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 20_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    // One trade fetch, and two transfer fetches (one asset group at the lower of
    // its two floors, one chain-wide) — never a shared one.
    expect(activityCalls).toHaveLength(3)
    expect(activityCalls.map(c => c.type).sort()).toEqual(['trade', 'transfer', 'transfer'])
    expect(activityCalls.filter(c => c.type === 'transfer').map(c => c.filters)
      .sort((a, b) => Number(a?.min) - Number(b?.min))).toEqual([
      { min: 1_000, unit: 'usd' },
      { min: 20_000, unit: 'usd', token: '0' },
    ])
  })

  it('fires each kind from its own feed and holds its own cursor', async () => {
    const trades = await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1_000 } })
    const transfers = await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityRows = [trade(1_005, 1, 25_000)]
    await runEvaluatorTick()
    // The stub answers both feeds with the same rows, so both rules match once —
    // which is exactly what proves each kind ran its own lane.
    expect(new Set(inbox().map(r => String(r.rule_id)))).toEqual(new Set([trades.ruleId, transfers.ruleId]))
    expect(evaluatorCursors()['large-transfer']).toBe(1_010)
    expect(evaluatorCursors()['large-trade']).toBe(1_010)
  })

  // Every lane that reads the GLOBAL feed day-bounds its fetch (a sparse floor
  // walks all history otherwise), and a dated read is served the shared
  // stale-while-revalidate window: a page up to a minute old, on a key with no
  // head in it. The cursor meanwhile tracks the live head, so rows that landed
  // inside that minute were stepped over for good — measured 2026-08-21, one
  // large-trade notification against 66 qualifying rows. These lanes must
  // therefore declare themselves forward-only, which puts them on the head-keyed
  // window. The scoped feeds are keyed on their own accounts' activity height and
  // need nothing.
  it('reads the global feed as a forward-only reader, so no lane is served a stale window', async () => {
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1_000 } })
    await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 1_000 } })
    await createRule(OWNER, { kind: 'protocol-revenue', params: { minUsd: 10 } })
    await createRule(OWNER, { kind: 'liquidation', params: {} })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()

    const global = activityCalls.filter(c => c.kind === 'recent')
    expect(global.map(c => c.type).sort()).toEqual(['all', 'mm', 'trade', 'transfer'])
    expect(global.every(c => c.opts?.forwardOnly === true)).toBe(true)
  })

  // The cap is per kind: the row lane visits the kinds in a fixed order, and a
  // budget the first one could exhaust would starve the second forever.
  it('does not let a saturated kind starve the next one', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(20)}`)
    for (const address of many) await createRule(OWNER, { kind: 'account-activity', params: { address } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls.filter(c => c.kind === 'address')).toHaveLength(25)
    expect(activityCalls.filter(c => c.kind === 'recent')).toHaveLength(1)
  })
})

/* ============ health factor: one lookup per address ============ */

describe('health-factor lane', () => {
  it('reads one health factor per address and market, not one per rule', async () => {
    healthFactors.set(`core:${ADDRESSES[0]}`, 2)
    healthFactors.set(`core:${ADDRESSES[1]}`, 3)
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.1 } })
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.5 } })
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[1], threshold: 1.1 } })
    await runEvaluatorTick()
    expect(healthFactorCalls.sort()).toEqual([`core:${ADDRESSES[0]}`, `core:${ADDRESSES[1]}`].sort())
  })

  it('fires every rule whose threshold the shared value crossed', async () => {
    healthFactors.set(`core:${ADDRESSES[0]}`, 2)
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.1 } })
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.5 } })
    await runEvaluatorTick()                       // arms both
    healthFactors.set(`core:${ADDRESSES[0]}`, 1.2)
    setHead(1_030)
    for (let i = 0; i < 5; i++) await runEvaluatorTick()
    // Only the 1.5 rule crossed; the 1.1 one is still armed.
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toContain('Health factor 1.2')
  })

  // The markets are isolated: a rule on the GIGAHDX position reads THAT
  // position, and a primary-market position at 1.02 must not fire it.
  it('reads the market the rule names, never the primary one in its place', async () => {
    healthFactors.set(`core:${ADDRESSES[0]}`, 1.02)
    healthFactors.set(`gigahdx:${ADDRESSES[0]}`, 3)
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.1, market: 'gigahdx' } })
    await runEvaluatorTick()
    expect(healthFactorCalls).toEqual([`gigahdx:${ADDRESSES[0]}`])
    setHead(1_030)
    for (let i = 0; i < 5; i++) await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
    healthFactors.set(`gigahdx:${ADDRESSES[0]}`, 1.05)
    for (let i = 0; i < 5; i++) await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toContain('Health factor 1.05')
    expect(String(inbox()[0].body)).toContain('GIGAHDX')
  })
})

/* ============ money-market caps: a state flip per reserve side ============ */

describe('money-market cap lane', () => {
  const E18 = 10n ** 18n
  const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
  // A rule's market is matched to reserves by pool address, so the fixtures
  // sit on the configured markets' real pool proxies.
  const poolOf = (market: string) => mmMarkets().find(m => m.key === market)!.poolProxy
  const hollarOn = (market: string, debt: bigint, borrowCap: bigint | null = 500_000n * E18): ReserveCapState => ({
    poolAddress: poolOf(market), reserveAddress: HOLLAR,
    assetId: 222, symbol: 'HOLLAR', decimals: 18, supplied: 0n, debt,
    borrowCap, borrowCapSource: borrowCap == null ? null : 'facilitator', supplyCap: null,
  })
  const dotOnCore = (supplied: bigint): ReserveCapState => ({
    poolAddress: poolOf('core'), reserveAddress: '0x0000000000000000000000000000000100000005',
    assetId: 5, symbol: 'DOT', decimals: 10, supplied, debt: 0n,
    borrowCap: 17_000_000n * 10n ** 10n, borrowCapSource: 'poolConfigurator', supplyCap: 25_000_000n * 10n ** 10n,
  })
  const snapshotTicks = async () => { for (let i = 0; i < 5; i++) await runEvaluatorTick() }

  it('announces a reserve filling its cap and opening again, once each', async () => {
    capStates = [hollarOn('gigahdx', 400_000n * E18)]
    await createRule(OWNER, { kind: 'mm-cap', params: { market: 'gigahdx' } })
    await runEvaluatorTick()                       // first sight only records
    expect(inbox()).toHaveLength(0)
    setHead(1_030)
    capStates = [hollarOn('gigahdx', 503_084n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toBe('HOLLAR borrow cap reached · GIGAHDX')
    // Interest carries it further over the cap: nothing new.
    capStates = [hollarOn('gigahdx', 504_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
    // A small repay inside the band is not "open again".
    capStates = [hollarOn('gigahdx', 499_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
    capStates = [hollarOn('gigahdx', 450_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(2)
    expect(String(inbox()[1].title)).toBe('HOLLAR can be borrowed again · GIGAHDX')
    expect(String(inbox()[1].body)).toContain('50k HOLLAR')
  })

  it('watches only the named market, and only the named token when one is set', async () => {
    capStates = [hollarOn('gigahdx', 400_000n * E18), hollarOn('bil', 100_000n * E18, 250_000n * E18), dotOnCore(20_000_000n * 10n ** 10n)]
    await createRule(OWNER, { kind: 'mm-cap', params: { market: 'core', assetId: 222 } })
    await createRule(OWNER, { kind: 'mm-cap', params: { market: 'bil' } })
    await runEvaluatorTick()
    setHead(1_030)
    // GIGAHDX fills (nobody watches it), DOT's supply cap fills (the core rule is on HOLLAR only).
    capStates = [hollarOn('gigahdx', 503_084n * E18), hollarOn('bil', 100_000n * E18, 250_000n * E18), dotOnCore(25_000_000n * 10n ** 10n)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(0)
    // BIL fills: its rule fires.
    capStates = [hollarOn('gigahdx', 503_084n * E18), hollarOn('bil', 250_028n * E18, 250_000n * E18), dotOnCore(25_000_000n * 10n ** 10n)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toBe('HOLLAR borrow cap reached · BIL')
  })

  // The headroom is read against the cap AS IT STANDS: governance lowering a
  // cap under what is already borrowed fills the reserve as surely as borrowing
  // does, and raising it opens the reserve as surely as a repay — and the
  // message says which it was.
  it('announces a cap lowered under current use, and one raised back above it', async () => {
    capStates = [hollarOn('gigahdx', 400_000n * E18, 500_000n * E18)]
    await createRule(OWNER, { kind: 'mm-cap', params: { market: 'gigahdx' } })
    await runEvaluatorTick()
    setHead(1_030)
    capStates = [hollarOn('gigahdx', 400_000n * E18, 300_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toBe('HOLLAR borrow cap reached · GIGAHDX')
    expect(String(inbox()[0].body)).toContain('lowered from 500k')
    capStates = [hollarOn('gigahdx', 400_000n * E18, 600_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(2)
    expect(String(inbox()[1].title)).toBe('HOLLAR can be borrowed again · GIGAHDX')
    expect(String(inbox()[1].body)).toContain('raised from 300k')
    // A cap raised in the same breath as a whale filled it did not cause the
    // fill, so the message does not say it did.
    capStates = [hollarOn('gigahdx', 699_800n * E18, 700_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(3)
    expect(String(inbox()[2].title)).toBe('HOLLAR borrow cap reached · GIGAHDX')
    expect(String(inbox()[2].body)).not.toContain('raised')
  })

  // A facilitator bucket wound down to zero is a cap of zero, not "no cap":
  // nothing can be minted against it, so it reads as reached.
  it('treats a facilitator capacity of zero as a cap that has been reached', async () => {
    capStates = [hollarOn('bil', 100_000n * E18, 250_000n * E18)]
    await createRule(OWNER, { kind: 'mm-cap', params: { market: 'bil' } })
    await runEvaluatorTick()
    setHead(1_030)
    capStates = [hollarOn('bil', 100_000n * E18, 0n)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toBe('HOLLAR borrow cap reached · BIL')
    expect(String(inbox()[0].body)).toContain('lowered from 250k to 0 HOLLAR')
  })

  // A side that leaves the rule's scope — its cap removed, its reserve
  // delisted — takes its arm state with it, so a reappearance is a first
  // sight (recorded, never fired) rather than a flip against a stale reading.
  it('forgets a side that lost its cap, so its return does not replay an old state', async () => {
    capStates = [hollarOn('gigahdx', 503_084n * E18)]
    await createRule(OWNER, { kind: 'mm-cap', params: { market: 'gigahdx' } })
    await runEvaluatorTick()                       // records full
    setHead(1_030)
    capStates = [hollarOn('gigahdx', 503_084n * E18, null)]
    await snapshotTicks()
    capStates = [hollarOn('gigahdx', 503_084n * E18, 900_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(0)
    // Recorded as open on its return; the next fill is news again.
    capStates = [hollarOn('gigahdx', 899_900n * E18, 900_000n * E18)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
  })

  it('reports a supply cap in supply words', async () => {
    capStates = [dotOnCore(20_000_000n * 10n ** 10n)]
    await createRule(OWNER, { kind: 'mm-cap', params: { market: 'core' } })
    await runEvaluatorTick()
    setHead(1_030)
    capStates = [dotOnCore(25_000_000n * 10n ** 10n)]
    await snapshotTicks()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toBe('DOT supply cap reached · Money Market')
  })
})

// The cursor key is per kind; nothing may share one, or one lane's progress
// would silence another's window.
describe('cursor keys', () => {
  it('names one state key per row-lane kind', () => {
    expect(cursorKey('event')).toBe('cursor:event')
    expect(cursorKey('safety')).toBe('cursor:safety')
    expect(cursorKey('account-activity')).toBe('cursor:account-activity')
  })
})
