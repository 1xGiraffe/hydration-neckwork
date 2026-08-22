import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The security kind has TWO sources and one subscription. Indexed Hydration
// actions arrive on the row lane off the Security ledger; the states nothing on
// Hydration indexes — a backing deficit, an origin-chain rate-limiter queue, an
// origin manager's pause flag, a fuse running out — arrive here, on the snapshot
// lane, edge-triggered with persisted arm state.
//
// Every invariant below is about not paging somebody twice (the delivery matrix
// in evaluator.ts), or — for an unreadable reading — at all.

let alertState: WormholeAlertState | null = null
let generation = 0
const alertCalls: number[] = []
vi.mock('../src/services/wormholeNttService.ts', () => ({
  getWormholeAlertState: async () => { alertCalls.push(1); return alertState },
  getWormholeSnapshotGeneration: () => generation,
  getWormholeManagers: () => [],
  getWormholeSummary: async () => null,
}))
const timeline: SafetyEvent[] = []
vi.mock('../src/services/securityService.ts', () => ({
  getSecurityDashboard: async () => ({ timeline: [...timeline] }),
}))
// Counted, not stubbed out: the price lane's read is how a test sees whether the
// VALUE half of the snapshot lane ran on a given tick.
const priceReads: number[] = []
vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  return { ...actual, ensurePrices: async () => { priceReads.push(1); return new Map() } }
})

import {
  SAFETY_ROW_LANE_KINDS, SAFETY_SNAPSHOT_KINDS,
  evaluateStateFlip, evaluatorCursors, initEvaluator, renderMatch, resetEvaluatorForTests, runEvaluatorTick,
  stopNotificationEvaluator, wormholeReleaseText, type ArmState, type RuleMatch,
} from '../src/notifications/evaluator.ts'
import {
  createRule, findEquivalentRule, initNotifications, loadNotifications, type NotificationRule,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { KIND_LABELS, NOTIFICATION_KINDS, SAFETY_KINDS, describeRule, parseRuleParams, ruleParamSchemas } from '../src/notifications/notificationRules.ts'
import { renderNotification } from '../src/notifications/render.ts'
import type { SafetyEvent } from '../src/services/securityService.ts'
import type { WormholeAlertState } from '../src/services/wormholeNttService.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'bb'.repeat(32)

let client: FakeClient
let tables: { raw_ingestion_state: { head: number }[] }

const inbox = () => insertedRows(client, 'user_notification_inbox')
const setHead = (head: number) => { tables.raw_ingestion_state[0].head = head }

const fuse = (utilizationPct: number, limit = 100_000, durationSec = 86_400) =>
  ({ utilizationPct, limit, durationSec })

const asset = (over: Partial<WormholeAlertState['assets'][number]> = {}): WormholeAlertState['assets'][number] => ({
  assetId: 21,
  symbol: 'USDC',
  originChainName: 'Ethereum',
  status: 'ok',
  residualUsd: 0,
  pausedLocal: false,
  pausedOrigin: false,
  fuses: { in: fuse(0), out: fuse(0) },
  ...over,
})

const state = (over: Partial<WormholeAlertState> = {}): WormholeAlertState => ({
  assets: [asset()],
  queued: [],
  asOf: '2026-08-22T09:00:00.000Z',
  ...over,
})

// A Hydration-side ledger row, the shape securityService's timeline hands over.
const ledgerEvent = (over: Partial<SafetyEvent> = {}): SafetyEvent => ({
  kind: 'pause', label: 'Wormhole USDC manager paused',
  detail: 'Transfers of USDC over Wormhole are halted in both directions until the manager is unpaused.',
  blockHeight: 1_010, blockTimestamp: '2026-08-22 09:00:00', extrinsicIndex: 2, asset: null,
  ...over,
})

// The snapshot lane runs on every fifth tick, so a scenario advances in fives.
const snapshotTick = async () => { for (let i = 0; i < 5; i++) await runEvaluatorTick() }

beforeEach(async () => {
  resetEvaluatorForTests()
  resetDeliveryStateForTests()
  alertState = state()
  generation = 0
  alertCalls.length = 0
  priceReads.length = 0
  timeline.length = 0
  tables = { raw_ingestion_state: [{ head: 1_000 }] }
  client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
  initNotifications(client)
  await loadNotifications()
  initEvaluator(client)
})

afterEach(async () => { await stopNotificationEvaluator() })

describe('the unified security kind', () => {
  it('is the only security kind there is', () => {
    expect(NOTIFICATION_KINDS).not.toContain('wormhole')
    expect(ruleParamSchemas).not.toHaveProperty('wormhole')
    expect(KIND_LABELS.safety).toBe('Security')
  })

  it('keeps the event enumeration in the order the UI mirrors', () => {
    expect(SAFETY_KINDS).toEqual([
      'limit', 'pause', 'unpause', 'lockdown', 'lockdown-lifted', 'freeze', 'unfreeze',
      'deficit', 'queued', 'released', 'fuse',
    ])
  })

  // One event, one delivery path. An event on both lists would reach the same
  // subscriber twice under two identities that nothing downstream can collapse.
  it('splits every event between the two lanes, covering all of them', () => {
    expect([...new Set([...SAFETY_ROW_LANE_KINDS, ...SAFETY_SNAPSHOT_KINDS])].sort()).toEqual([...SAFETY_KINDS].sort())
    // The overlaps are the events split by SIDE rather than by kind: a pause and
    // a queue exist on Hydration (indexed) and on the origin chain (state only).
    const both = SAFETY_ROW_LANE_KINDS.filter(k => (SAFETY_SNAPSHOT_KINDS as readonly string[]).includes(k))
    expect(both.sort()).toEqual(['pause', 'queued', 'unpause'])
  })

  it('round-trips its parameters and defaults both floors', () => {
    const bare = parseRuleParams('safety', {})
    expect(bare).toEqual({ ok: true, params: { deficitUsd: 100, fusePct: 90 } })
    const narrowed = parseRuleParams('safety', { kinds: ['deficit', 'fuse'], deficitUsd: 5_000, fusePct: 50 })
    expect(narrowed).toEqual({ ok: true, params: { kinds: ['deficit', 'fuse'], deficitUsd: 5_000, fusePct: 50 } })
    // A rule written before the bridge events existed keeps validating, and
    // simply gains the defaults.
    expect(parseRuleParams('safety', { kinds: ['freeze', 'unfreeze'] }))
      .toEqual({ ok: true, params: { kinds: ['freeze', 'unfreeze'], deficitUsd: 100, fusePct: 90 } })
    expect(parseRuleParams('safety', { kinds: ['nonsense'] }).ok).toBe(false)
    expect(parseRuleParams('safety', { unexpected: 1 }).ok).toBe(false)
    expect(parseRuleParams('safety', { fusePct: 101 }).ok).toBe(false)
  })

  // Two bells — the Security overview's and the Wormhole section's — post the
  // same `params: {}`, and a stored rule carries the defaults. They have to be
  // ONE subscription, or the second bell mints a rule beside the one it owns.
  it('treats a bare rule and its defaulted twin as one subscription', async () => {
    const bare = await createRule(OWNER, { kind: 'safety', params: {} })
    const spelled = await createRule(OWNER, { kind: 'safety', params: { deficitUsd: 100, fusePct: 90 } })
    expect(spelled.ruleId).toBe(bare.ruleId)
    expect(findEquivalentRule(OWNER, 'safety', {})?.ruleId).toBe(bare.ruleId)
  })

  it('describes itself in one line, naming a floor only for an event it watches', () => {
    expect(describeRule('safety', {})).toBe('Security · every action')
    expect(describeRule('safety', { kinds: ['freeze'] })).toBe('Security · freeze')
    expect(describeRule('safety', { kinds: ['deficit', 'fuse'] }))
      .toBe('Security · deficit ≥ $100, fuse ≥ 90% · deficit, fuse')
    expect(describeRule('safety', { kinds: ['deficit'], deficitUsd: 5_000 }))
      .toBe('Security · deficit ≥ $5k · deficit')
  })
})

/* ============ the no-duplicates matrix ============ */

describe('one event, one lane', () => {
  const watch = () => createRule(OWNER, { kind: 'safety', params: {} })

  it('delivers a Hydration-side pause on the ledger lane only', async () => {
    await watch()
    await snapshotTick()                                    // seeds both lanes
    // The pause reaches the ledger as an indexed manager log AND flips the
    // snapshot's local flag — the same event seen twice. Only the row lane may
    // report it.
    timeline.push(ledgerEvent())
    alertState = state({ assets: [asset({ pausedLocal: true })] })
    setHead(1_100)
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe('Wormhole USDC manager paused')
    expect(inbox()[0].block_height).toBe(1_010)
  })

  it('delivers an origin-side pause on the snapshot lane only', async () => {
    await watch()
    await snapshotTick()                                    // first sight arms
    // Nothing on Hydration indexes an Ethereum manager's pause, so the ledger
    // stays empty and the flip is all there is.
    alertState = state({ assets: [asset({ pausedOrigin: true })] })
    setHead(1_100)
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe('USDC Wormhole transfers paused')
    expect(inbox()[0].block_height).toBe(0)
  })

  it('reports a Hydration-side queue from the ledger and an origin queue from the snapshot', async () => {
    await watch()
    await snapshotTick()
    timeline.push(ledgerEvent({
      kind: 'queued', blockHeight: 1_010,
      label: 'Wormhole USDC outbound transfer queued #7',
      detail: 'A USDC transfer leaving Hydration for Ethereum exceeded Hydration\'s rate limit.',
    }))
    alertState = state({
      queued: [{ digest: '0x' + 'ab'.repeat(32), symbol: 'sUSDS', amount: 80_000, chainName: 'Ethereum', releasableAt: null }],
    })
    setHead(1_100)
    await snapshotTick()
    expect(inbox().map(r => r.title).sort()).toEqual([
      'Wormhole USDC outbound transfer queued #7',
      "sUSDS held by Ethereum's rate limiter",
    ])
  })
})

describe('the deficit event', () => {
  const watch = (params: Record<string, unknown> = {}) => createRule(OWNER, { kind: 'safety', params })

  it('arms on first sight without firing, then fires on the crossing', async () => {
    // A rule created while an asset is already short waits for a real crossing,
    // so a fresh deployment does not page every subscriber at once.
    await watch()
    alertState = state({ assets: [asset({ residualUsd: -500, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)

    // Back inside the band, then out again: that is the crossing.
    alertState = state({ assets: [asset({ residualUsd: 0 })] })
    await snapshotTick()
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe('USDC backing deficit')
    expect(inbox()[0].body).toBe('$412 of USDC supply has no custody behind it on Ethereum.')
    expect(inbox()[0].url).toBe('/security/wormhole')
    expect(inbox()[0].block_height).toBe(0)
  })

  it('does not fire again while the deficit merely persists', async () => {
    await watch()
    await snapshotTick()                                   // arms at zero
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    for (const usd of [-500, -450, -600]) {
      alertState = state({ assets: [asset({ residualUsd: usd, status: 'deficit' })] })
      await snapshotTick()
    }
    expect(inbox()).toHaveLength(1)
  })

  it('re-arms only past the hysteresis band', async () => {
    await watch()
    await snapshotTick()
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)

    // $99 of confirmed shortfall grades 'attention' and is inside the 2% band
    // around the $100 threshold's re-arm line, so it does not re-arm.
    alertState = state({ assets: [asset({ residualUsd: -99, status: 'attention' })] })
    await snapshotTick()
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)

    // Comfortably back inside, then out: a second alert.
    alertState = state({ assets: [asset({ residualUsd: 0 })] })
    await snapshotTick()
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(2)
  })

  it('never pages on a shortfall the classifier has not graded', async () => {
    await watch()
    await snapshotTick()                                   // arms at zero
    // An unconfirmed first reading: the page it links to says "ok — more
    // likely a transfer caught mid-settlement", so the alert says nothing.
    alertState = state({ assets: [asset({ residualUsd: -5_900, status: 'ok' })] })
    await snapshotTick()
    // A no-scan deployment: every routine transfer opens a negative gap the
    // monitor cannot verify, so paging on it would page on ordinary traffic.
    alertState = state({ assets: [asset({ residualUsd: -5_900, status: 'unverified' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
    // The graded verdict is what fires.
    alertState = state({ assets: [asset({ residualUsd: -5_900, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
  })

  it('treats an unreadable residual as no news at all', async () => {
    // An unread custody balance must never read as a total deficit.
    await watch()
    await snapshotTick()
    alertState = state({ assets: [asset({ residualUsd: null, status: 'unconfigured' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
    // …and it does not disarm the rule either.
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
  })

  it('arms each asset separately', async () => {
    await watch()
    alertState = state({ assets: [asset(), asset({ assetId: 1_000_745, symbol: 'sUSDS' })] })
    await snapshotTick()
    alertState = state({
      assets: [asset({ residualUsd: -412, status: 'deficit' }), asset({ assetId: 1_000_745, symbol: 'sUSDS', residualUsd: -900, status: 'deficit' })],
    })
    await snapshotTick()
    expect(inbox().map(r => r.title).sort()).toEqual(['USDC backing deficit', 'sUSDS backing deficit'])
  })

  it('honours the rule’s own floor', async () => {
    await watch({ deficitUsd: 5_000 })
    await snapshotTick()
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
    alertState = state({ assets: [asset({ residualUsd: -6_000, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
  })

  it('is silent for a rule that did not ask for it', async () => {
    await watch({ kinds: ['pause'] })
    await snapshotTick()
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
  })
})

describe('the fuse event', () => {
  const watch = (params: Record<string, unknown> = {}) => createRule(OWNER, { kind: 'safety', params })

  it('fires when an origin fuse crosses the default 90%', async () => {
    await watch()
    await snapshotTick()                                   // arms at 0%
    alertState = state({ assets: [asset({ fuses: { in: fuse(93), out: fuse(4) } })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe('USDC entry fuse nearly spent')
    expect(inbox()[0].body).toBe('The Ethereum entry fuse for USDC is at 93% of its 100k USDC per 24h limit — beyond it, transfers are held for 24h.')
    expect(inbox()[0].url).toBe('/security/wormhole')
    expect(inbox()[0].block_height).toBe(0)
  })

  it('honours a rule’s own threshold', async () => {
    await watch({ kinds: ['fuse'], fusePct: 50 })
    await snapshotTick()
    alertState = state({ assets: [asset({ fuses: { in: fuse(61), out: fuse(0) } })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe('USDC entry fuse nearly spent')
  })

  it('arms the two legs separately and names the release leg as such', async () => {
    await watch()
    await snapshotTick()
    alertState = state({ assets: [asset({ fuses: { in: fuse(95), out: fuse(97) } })] })
    await snapshotTick()
    expect(inbox().map(r => r.title).sort()).toEqual([
      'USDC entry fuse nearly spent', 'USDC release fuse nearly spent',
    ])
  })

  it('does not fire again while the fuse merely stays spent', async () => {
    await watch({ kinds: ['fuse'] })
    await snapshotTick()
    alertState = state({ assets: [asset({ fuses: { in: fuse(93), out: null } })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    for (const pct of [95, 99, 91]) {
      alertState = state({ assets: [asset({ fuses: { in: fuse(pct), out: null } })] })
      await snapshotTick()
    }
    expect(inbox()).toHaveLength(1)

    // Refilled well past the re-arm band, then spent again: a second alert.
    alertState = state({ assets: [asset({ fuses: { in: fuse(10), out: null } })] })
    await snapshotTick()
    alertState = state({ assets: [asset({ fuses: { in: fuse(93), out: null } })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(2)
  })

  it('treats an unread origin limiter as no news, never as 0%', async () => {
    await watch({ kinds: ['fuse'] })
    alertState = state({ assets: [asset({ fuses: { in: null, out: null } })] })
    await snapshotTick()
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
    // The first READABLE value only arms; nothing has crossed yet.
    alertState = state({ assets: [asset({ fuses: { in: fuse(99), out: null } })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
  })

  // Hydration's own legs are uncapped at the u64 trimmed ceiling, so they are
  // never evaluated — the alert state does not even carry them.
  it('never evaluates a Hydration-side fuse', async () => {
    await watch({ kinds: ['fuse'] })
    await snapshotTick()
    const [only] = state().assets
    expect(Object.keys(only.fuses).sort()).toEqual(['in', 'out'])
  })

  it('is silent for a rule that did not ask for it', async () => {
    await watch({ kinds: ['deficit'] })
    await snapshotTick()
    alertState = state({ assets: [asset({ fuses: { in: fuse(99), out: fuse(99) } })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
  })
})

describe('the rate-limiter queue events', () => {
  const held = {
    digest: '0x319c998f9e8ab534fb886dbfc4db6fccf0d10101cdb687f1a6657f79cb83d41c',
    symbol: 'sUSDS',
    amount: 79_998.96642431,
    chainName: 'Ethereum',
    releasableAt: '2026-08-23T09:00:00.000Z',
  }

  it('reports a held transfer once, keyed by its digest', async () => {
    vi.setSystemTime(Date.parse('2026-08-22T09:00:00Z'))
    await createRule(OWNER, { kind: 'safety', params: {} })
    alertState = state({ queued: [held] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe("sUSDS held by Ethereum's rate limiter")
    expect(inbox()[0].body).toContain('80k sUSDS')
    expect(inbox()[0].body).toContain('releasable in 24h')
    // Still held on the next pass: the identity is the digest, so it is the
    // same notification rather than a second one.
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    vi.useRealTimers()
  })

  it('announces a digest once per process, not once per dedup window', async () => {
    vi.setSystemTime(Date.parse('2026-08-22T09:00:00Z'))
    await createRule(OWNER, { kind: 'safety', params: {} })
    alertState = state({ queued: [held] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)

    // Eight days on, the transfer is still held and the inbox dedup entry has
    // aged out (an unrelated alert triggers the prune). The lane must not have
    // kept re-emitting the digest, or a long-held transfer would page again
    // every time it outlives the dedup window.
    vi.setSystemTime(Date.parse('2026-08-30T09:00:00Z'))
    alertState = state({ queued: [held], assets: [asset({ pausedOrigin: true })] })
    await snapshotTick()                                   // the prune-triggering alert
    alertState = state({ queued: [held], assets: [asset({ pausedOrigin: true })] })
    await snapshotTick()
    expect(inbox().map(r => r.title)).toEqual([
      "sUSDS held by Ethereum's rate limiter", 'USDC Wormhole transfers paused',
    ])
    vi.useRealTimers()
  })

  it('reports the release once the digest leaves the snapshot', async () => {
    await createRule(OWNER, { kind: 'safety', params: ({ kinds: ['released'] }) })
    alertState = state({ queued: [held] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
    alertState = state({ queued: [] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe("sUSDS released by Ethereum's rate limiter")
    // Not again on the next pass — the digest is forgotten once reported.
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
  })

  it('never invents a release for a digest it did not see held', async () => {
    await createRule(OWNER, { kind: 'safety', params: { kinds: ['released'] } })
    alertState = state({ queued: [] })
    await snapshotTick()
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
  })
})

describe('the origin pause flip', () => {
  it('records the first reading and fires on the change', async () => {
    await createRule(OWNER, { kind: 'safety', params: {} })
    alertState = state({ assets: [asset({ pausedOrigin: true })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)                        // first sight arms only

    alertState = state({ assets: [asset({ pausedOrigin: false })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe('USDC Wormhole transfers resumed')

    alertState = state({ assets: [asset({ pausedOrigin: true })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(2)
    expect(inbox()[1].title).toBe('USDC Wormhole transfers paused')
    expect(inbox()[1].body).toContain('on Ethereum')
  })

  // The v4 double-delivery this lane had to lose: the snapshot carries BOTH
  // flags, and the local one is already an indexed ledger row.
  it('ignores the Hydration-side flag entirely', async () => {
    await createRule(OWNER, { kind: 'safety', params: {} })
    await snapshotTick()
    alertState = state({ assets: [asset({ pausedLocal: true })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
  })

  it('says nothing about a flag it cannot read', async () => {
    await createRule(OWNER, { kind: 'safety', params: {} })
    await snapshotTick()
    alertState = state({ assets: [asset({ pausedOrigin: null })] })
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
  })
})

/* ============ when the lane runs ============ */

// The monitor publishes in steps, and the step is observable for free, so the
// security half of the snapshot lane does not have to wait out its 30s rhythm to
// notice one. The value triggers describe a continuous level and keep the rhythm
// exactly.
describe('the snapshot lane’s cadence', () => {
  const priceRule = () => createRule(OWNER, { kind: 'price', params: { assetId: 21, direction: 'above', price: 1 } })

  it('runs the security lane off-rhythm when the monitor published a new snapshot', async () => {
    await createRule(OWNER, { kind: 'safety', params: {} })
    await runEvaluatorTick()                                // tick 1: on rhythm, arms
    alertCalls.length = 0
    await runEvaluatorTick()                                // tick 2: off rhythm, no news
    expect(alertCalls).toHaveLength(0)

    // A new snapshot lands between two ticks.
    alertState = state({ assets: [asset({ residualUsd: -412, status: 'deficit' })] })
    generation += 1
    await runEvaluatorTick()                                // tick 3: off rhythm, but stepped
    expect(alertCalls).toHaveLength(1)
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].title).toBe('USDC backing deficit')

    // The same generation on the next tick is not news again.
    await runEvaluatorTick()
    expect(alertCalls).toHaveLength(1)
  })

  it('keeps the five-tick rhythm when the generation holds', async () => {
    await createRule(OWNER, { kind: 'safety', params: {} })
    for (let i = 0; i < 5; i++) await runEvaluatorTick()
    expect(alertCalls).toHaveLength(1)                      // tick 1 only
    await runEvaluatorTick()                                // tick 6: back on rhythm
    expect(alertCalls).toHaveLength(2)
  })

  it('leaves the value triggers on the rhythm a generation bump does not touch', async () => {
    await priceRule()
    await runEvaluatorTick()                                // tick 1: on rhythm
    expect(priceReads).toHaveLength(1)
    // Four off-rhythm ticks, each with a fresh bridge snapshot: the price lane
    // must not be dragged along by the bridge's clock.
    for (let i = 0; i < 4; i++) { generation += 1; await runEvaluatorTick() }
    expect(priceReads).toHaveLength(1)
    await runEvaluatorTick()                                // tick 6: its own rhythm
    expect(priceReads).toHaveLength(2)
  })
})

describe('the lane’s source', () => {
  it('says nothing at all before the monitor has measured anything', async () => {
    await createRule(OWNER, { kind: 'safety', params: {} })
    alertState = null
    await snapshotTick()
    await snapshotTick()
    expect(inbox()).toHaveLength(0)
  })

  it('is not read at all when nobody subscribes', async () => {
    await snapshotTick()
    expect(alertCalls).toHaveLength(0)
  })

  it('takes no row-lane cursor of its own — the safety cursor is the ledger’s', async () => {
    await createRule(OWNER, { kind: 'safety', params: {} })
    await snapshotTick()
    expect(evaluatorCursors()).not.toHaveProperty('safety-state')
  })
})

describe('evaluateStateFlip', () => {
  const prev = (value: boolean, epoch = 0): ReadonlyMap<string, ArmState> =>
    new Map([['k', { armed: true, lastValue: value ? 1 : 0, epoch }]])

  it('records a first reading without firing', () => {
    const { fired, next } = evaluateStateFlip([{ key: 'k', value: true }], new Map())
    expect(fired).toEqual([])
    expect(next.get('k')).toEqual({ armed: true, lastValue: 1, epoch: 0 })
  })

  it('fires on a change and increments the epoch', () => {
    const { fired, next } = evaluateStateFlip([{ key: 'k', value: false }], prev(true, 3))
    expect(fired).toEqual([{ key: 'k', value: false, epoch: 4 }])
    expect(next.get('k')).toEqual({ armed: true, lastValue: 0, epoch: 4 })
  })

  it('writes nothing when the state holds', () => {
    const { fired, next } = evaluateStateFlip([{ key: 'k', value: true }], prev(true))
    expect(fired).toEqual([])
    expect(next.size).toBe(0)
  })

  it('ignores an unreadable flag', () => {
    const { fired, next } = evaluateStateFlip([{ key: 'k', value: null }], prev(true))
    expect(fired).toEqual([])
    expect(next.size).toBe(0)
  })
})

describe('the rendered messages', () => {
  const rule = { ruleId: 'r', accountId: OWNER, kind: 'safety', params: {} } as unknown as NotificationRule
  const render = (payload: RuleMatch['payload']) =>
    renderNotification(renderMatch({ ruleId: 'r', accountId: OWNER, kind: 'safety', identity: 'i', blockHeight: 0, payload }, rule, () => null))

  it('states a deficit through the shared USD scale', () => {
    const out = render({ lane: 'safety-state', event: 'deficit', symbol: 'USDC', chainName: 'Ethereum', deficitUsd: 412.4 })
    expect(out.title).toBe('USDC backing deficit')
    expect(out.body).toBe('$412 of USDC supply has no custody behind it on Ethereum.')
    expect(out.path).toBe('/security/wormhole')
  })

  it('states a fuse through the shared amount scale and the window it read', () => {
    const out = render({
      lane: 'safety-state', event: 'fuse', symbol: 'sUSDS', chainName: 'Ethereum',
      direction: 'out', utilizationPct: 93.4, limit: 100_000, durationSec: 86_400,
    })
    expect(out.title).toBe('sUSDS release fuse nearly spent')
    expect(out.body).toBe('The Ethereum release fuse for sUSDS is at 93.4% of its 100k sUSDS per 24h limit — beyond it, transfers are held for 24h.')
    expect(out.path).toBe('/security/wormhole')
  })

  it('shortens the digest the way a hash is shortened everywhere else', () => {
    const out = render({
      lane: 'safety-state', event: 'queued', symbol: 'sUSDS', chainName: 'Ethereum',
      digest: '0x319c998f9e8ab534fb886dbfc4db6fccf0d10101cdb687f1a6657f79cb83d41c',
      amount: 79_998.96642431, releasableAt: null,
    })
    expect(out.body).toContain('0x319c99…83d41c')
    expect(out.body).toContain('80k sUSDS')
  })

  it('says how long is left, or that the release is open now', () => {
    const now = Date.parse('2026-08-22T09:00:00Z')
    expect(wormholeReleaseText('2026-08-23T09:00:00Z', now)).toBe('releasable in 24h')
    expect(wormholeReleaseText('2026-08-22T08:00:00Z', now)).toBe('releasable now')
    expect(wormholeReleaseText(null, now)).toBe('held until the limiter releases it')
  })
})
