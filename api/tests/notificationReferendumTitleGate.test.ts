import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  cursorKey, evaluateReferendum, evaluatorParkedSubmissions, initEvaluator, parseParkedSubmissions,
  resetEvaluatorForTests, resolveSubmittedMatches, runEvaluatorTick, serializeParkedSubmissions,
  stopNotificationEvaluator,
  type BlockWindow, type ParkedSubmission, type ReferendumEventRow, type RuleMatch,
} from '../src/notifications/evaluator.ts'
import {
  createRule, getNotificationState, initNotifications, loadNotifications, setNotificationState,
  type NotificationRule,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import {
  initReferendumTitleService, isGenericReferendumTitle, loadReferendumTitles,
} from '../src/services/referendumTitleService.ts'
import { initExplorerService } from '../src/services/explorerService.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// A submitted-phase notification with no real title says nothing its own headline
// did not already say — "Referendum #412 submitted" IS the index. So it is HELD
// until the title service has a title or the referendum starts deciding. These are
// the gate's rules: what counts as a title, when a held alert goes out, and that it
// goes out exactly once whatever the wait or the restart in between.

initExplorerService(fakeClient())

const OWNER = '0x' + 'aa'.repeat(32)
const W: BlockWindow = { from: 1_000, to: 1_100 }
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 18)

let ruleSeq = 0
function rule(params: unknown): NotificationRule {
  return {
    ruleId: `rule-${++ruleSeq}`, accountId: OWNER, kind: 'referendum', name: '', params,
    channels: [], muted: false, cooldownS: 0,
  }
}

const row = (over: Partial<ReferendumEventRow> = {}): ReferendumEventRow =>
  ({ blockHeight: 1_050, eventIndex: 3, index: 412, phase: 'submitted', track: 5, ...over })

const titles = new Map<number, string>()
const titleFor = (index: number) => titles.get(index) ?? null

// One tick of the gate: match the window, then run it through the gate the lane
// runs it through.
function tick(
  pending: ReadonlyMap<number, ParkedSubmission>,
  rows: ReferendumEventRow[],
  rules: NotificationRule[],
  nowMs = NOW,
): { matches: RuleMatch[]; pending: Map<number, ParkedSubmission>; changed: boolean } {
  const matches = evaluateReferendum(rows, rules, W, titleFor)
  return resolveSubmittedMatches(pending, matches, rows, rules, titleFor, nowMs)
}

beforeEach(() => { titles.clear() })

describe('isGenericReferendumTitle', () => {
  it('treats an absent, empty or template title as no title at all', () => {
    for (const generic of [
      null, undefined, '', '   ', 'Untitled', 'untitled',
      'Referendum #412', 'referendum 412', 'Referendum#412', 'Ref #412', 'Referenda #412',
      '[Treasurer] Referendum #412', '[Big Spender]  Referendum #7',
    ]) {
      expect(isGenericReferendumTitle(generic), JSON.stringify(generic)).toBe(true)
    }
  })

  it('keeps anything that says something, including a title that names its index', () => {
    for (const real of [
      'Add HDX liquidity to the Omnipool',
      'Referendum #412 — raise the reference fee',
      '[Treasurer] Fund the Q3 marketing budget',
      '412 HDX for a bug bounty',
    ]) {
      expect(isGenericReferendumTitle(real), real).toBe(false)
    }
  })
})

describe('parked submitted notifications', () => {
  it('parks a submission whose title is still a placeholder', () => {
    const result = tick(new Map(), [row()], [rule({ phases: ['submitted'] })])
    expect(result.matches).toHaveLength(0)
    expect(result.changed).toBe(true)
    expect(result.pending.get(412)).toMatchObject({ blockHeight: 1_050, eventIndex: 3, track: 5, parkedAt: NOW })
  })

  it('delivers straight away when the title is already real', () => {
    titles.set(412, 'Add HDX liquidity to the Omnipool')
    const result = tick(new Map(), [row()], [rule({ phases: ['submitted'] })])
    expect(result.matches.map(m => m.identity)).toEqual(['412:submitted'])
    expect(result.pending.size).toBe(0)
    expect(result.changed).toBe(false)
  })

  it('releases the held alert once the title arrives, and only once', () => {
    const subject = rule({ phases: ['submitted'] })
    const held = tick(new Map(), [row()], [subject]).pending
    titles.set(412, 'Add HDX liquidity to the Omnipool')
    // The next tick's window holds nothing at all — the release is driven by the
    // title, not by a row.
    const released = tick(held, [], [subject])
    expect(released.matches.map(m => m.identity)).toEqual(['412:submitted'])
    expect(released.matches[0].payload).toMatchObject({ lane: 'referendum', title: 'Add HDX liquidity to the Omnipool' })
    // Its block is preserved, so the notification is filed where it happened.
    expect(released.matches[0].blockHeight).toBe(1_050)
    expect(released.pending.size).toBe(0)
    // A third tick has nothing left to release.
    expect(tick(released.pending, [], [subject]).matches).toHaveLength(0)
  })

  it('serves rules that appeared while the submission was parked', () => {
    const first = rule({ phases: ['submitted'] })
    const held = tick(new Map(), [row()], [first]).pending
    titles.set(412, 'Add HDX liquidity to the Omnipool')
    const later = rule({ phases: ['submitted'] })
    const released = tick(held, [], [first, later])
    // Per-rule dedup ids make this correct rather than duplicating: each rule is
    // told once, and a rule already told is suppressed by its own id.
    expect(released.matches.map(m => m.ruleId).sort()).toEqual([first.ruleId, later.ruleId].sort())
  })

  it('drops a held alert whose rule no longer wants the submitted phase', () => {
    const held = tick(new Map(), [row()], [rule({ phases: ['submitted'] })]).pending
    titles.set(412, 'Add HDX liquidity')
    const released = tick(held, [], [rule({ phases: ['confirmed'] })])
    expect(released.matches).toHaveLength(0)
    expect(released.pending.size).toBe(0)
  })

  it('lets DecisionStarted release the deciding phase only, when the rule wants both', () => {
    const both = rule({ phases: ['submitted', 'deciding'] })
    const held = tick(new Map(), [row()], [both]).pending
    expect(held.size).toBe(1)
    const decision = row({ blockHeight: 1_080, eventIndex: 2, phase: 'deciding' })
    const released = tick(held, [decision], [both])
    // Exactly one notification about this referendum, and it is the phase the
    // reader is watching NOW.
    expect(released.matches.map(m => m.identity)).toEqual(['412:deciding'])
    expect(released.pending.size).toBe(0)
  })

  it('lets DecisionStarted release the submitted phase when that is all the rule wants', () => {
    const submittedOnly = rule({ phases: ['submitted'] })
    const held = tick(new Map(), [row()], [submittedOnly]).pending
    const released = tick(held, [row({ blockHeight: 1_080, eventIndex: 2, phase: 'deciding' })], [submittedOnly])
    // Delivered with whatever title exists — a referendum in its decision period
    // is no longer news worth holding.
    expect(released.matches.map(m => m.identity)).toEqual(['412:submitted'])
    expect(released.matches[0].payload).toMatchObject({ title: null })
    expect(released.pending.size).toBe(0)
  })

  it('expires a submission that waited a fortnight, silently', () => {
    const held = tick(new Map(), [row()], [rule({ phases: ['submitted'] })]).pending
    const thirteenDays = tick(held, [], [rule({ phases: ['submitted'] })], NOW + 13 * DAY)
    expect(thirteenDays.matches).toHaveLength(0)
    expect(thirteenDays.pending.size).toBe(1)
    const expired = tick(held, [], [rule({ phases: ['submitted'] })], NOW + 14 * DAY)
    expect(expired.matches).toHaveLength(0)
    expect(expired.pending.size).toBe(0)
    expect(expired.changed).toBe(true)
  })

  it('leaves every other phase alone, title or no title', () => {
    const subject = rule({})
    const rows = [
      row({ blockHeight: 1_010, phase: 'confirmed' }),
      row({ blockHeight: 1_020, phase: 'rejected' }),
      row({ blockHeight: 1_030, phase: 'killed' }),
    ]
    const result = tick(new Map(), rows, [subject])
    expect(result.matches.map(m => m.identity)).toEqual(['412:confirmed', '412:rejected', '412:killed'])
    expect(result.pending.size).toBe(0)
    expect(result.changed).toBe(false)
  })

  it('round-trips the persisted map, and ignores an unreadable row', () => {
    const map = new Map<number, ParkedSubmission>([[412, { blockHeight: 1_050, eventIndex: 3, track: 5, parkedAt: NOW }]])
    expect(parseParkedSubmissions(serializeParkedSubmissions(map))).toEqual(map)
    expect(parseParkedSubmissions('not json').size).toBe(0)
    expect(parseParkedSubmissions(null).size).toBe(0)
    // A partial entry cannot be re-evaluated, so it is dropped rather than guessed.
    expect(parseParkedSubmissions('{"9":{"blockHeight":1}}').size).toBe(0)
  })
})

/* ============ the same thing through the loop, across a restart ============ */

describe('parked submissions survive a restart', () => {
  const lifecycle = (index: number, name: string, block: number, eventIndex = 1) => ({
    pallet: 'opengov', ref_index: index, block_height: block, event_index: eventIndex,
    event_name: `Referenda.${name}`, args_json: JSON.stringify({ track: 5 }),
  })

  let client: FakeClient
  let tables: Record<string, Record<string, unknown>[]>

  const inbox = () => insertedRows(client, 'user_notification_inbox')
  const setHead = (head: number) => { tables.raw_ingestion_state[0] = { head } }

  async function boot(): Promise<void> {
    resetEvaluatorForTests()
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
    initReferendumTitleService(client)
    await loadReferendumTitles()
  }

  // A restart reads the user_* tables back: the store's in-memory maps are
  // rebuilt from the rows it wrote, which is what the parked map has to survive.
  // Rows replace by key, so the whole insert log is what the load sees.
  async function restart(): Promise<void> {
    for (const table of ['user_notification_rules', 'user_notification_state', 'user_notification_channels']) {
      tables[table] = insertedRows(client, table)
    }
    await boot()
  }

  beforeEach(async () => {
    resetDeliveryStateForTests()
    tables = {
      raw_ingestion_state: [{ head: 1_000 }],
      referendum_lifecycle_events: [lifecycle(412, 'Submitted', 900)],
      referendum_titles: [],
      raw_events: [], raw_extrinsics: [],
      user_notification_rules: [], user_notification_state: [], user_notification_channels: [],
      user_notification_inbox: [],
    }
    client = fakeClient(tables)
    await boot()
    await createRule(OWNER, { kind: 'referendum', params: { phases: ['submitted'] } })
    await setNotificationState(cursorKey('referendum'), '800')
  })

  afterEach(async () => { await stopNotificationEvaluator() })

  it('parks with no title, then delivers exactly one alert once the title lands', async () => {
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
    expect(evaluatorParkedSubmissions()[412]).toMatchObject({ blockHeight: 900, eventIndex: 1 })
    // Written at once, not on the idle cadence: the cursor has already moved past
    // the row, so a restart that lost this would lose the alert.
    expect(getNotificationState('referendum:pending-submitted')).toContain('"412"')

    // Restart: fresh evaluator and store state, read back off the user_* rows.
    await restart()
    expect(evaluatorParkedSubmissions()[412]).toMatchObject({ blockHeight: 900 })

    tables.referendum_titles.push({ pallet: 'opengov', ref_index: 412, title: 'Add HDX liquidity to the Omnipool' })
    await loadReferendumTitles()
    setHead(1_010)
    await runEvaluatorTick()
    // The proposal leads; the state change reads underneath it.
    expect(inbox().map(r => String(r.title))).toEqual(['Add HDX liquidity to the Omnipool'])
    expect(inbox()[0].body).toContain('Referendum #412 submitted')
    expect(evaluatorParkedSubmissions()[412]).toBeUndefined()

    // And never again.
    setHead(1_020)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
  })
})
