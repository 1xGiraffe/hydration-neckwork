import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  ROW_LANE_KINDS, cursorKey, evaluateRowKind, evaluateTcMotion, initEvaluator, renderMatch,
  resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator, tcMotionIdentity,
  type BlockWindow, type TcMotionEventRow,
} from '../src/notifications/evaluator.ts'
import { renderNotification } from '../src/notifications/render.ts'
import {
  createRule, initNotifications, loadNotifications, setNotificationState,
  type NotificationRule,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import {
  KIND_LABELS, NOTIFICATION_KINDS, TC_MOTION_PHASES, describeRule, parseRuleParams,
  type NotificationKind,
} from '../src/notifications/notificationRules.ts'
import { accountRef, initExplorerService } from '../src/services/explorerService.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// Technical Committee motions are their OWN trigger kind, never a phase of the
// referendum kind: a committee's procedural business is not what somebody
// subscribing to public referenda asked to hear about. These are the matcher's
// invariants — the phase filter, the per-member vote identity, and the two link
// targets a motion phase can have.

initExplorerService(fakeClient())

const OWNER = '0x' + 'aa'.repeat(32)
const MEMBER = '0x' + '11'.repeat(32)
const HASH = '0x0529aaaabbbbccccddddeeeeffff00001111222233334444555566664b5b'
const W: BlockWindow = { from: 1_000, to: 1_100 }

let ruleSeq = 0
function rule(kind: NotificationKind, params: unknown): NotificationRule {
  return { ruleId: `rule-${++ruleSeq}`, accountId: OWNER, kind, name: '', params, channels: [], muted: false, cooldownS: 0 }
}

const row = (over: Partial<TcMotionEventRow> = {}): TcMotionEventRow => ({
  blockHeight: 1_050, eventIndex: 3, extrinsicIndex: 2, phase: 'approved', proposalHash: HASH,
  actor: null, aye: null, yes: null, no: null, threshold: null, ok: null, ...over,
})

const viewerTag = () => null
const render = (r: TcMotionEventRow, ruleParams: unknown = {}) => {
  const subject = rule('tc-motion', ruleParams)
  const match = evaluateTcMotion([r], [subject], W)[0]
  expect(match, 'the row did not match its own rule').toBeTruthy()
  return renderNotification(renderMatch(match, subject, viewerTag))
}

describe('tc-motion registry', () => {
  it('is its own kind, with its own phase vocabulary', () => {
    expect(NOTIFICATION_KINDS).toContain('tc-motion')
    expect(KIND_LABELS['tc-motion']).toBe('TC motion')
    expect(ROW_LANE_KINDS).toContain('tc-motion')
    // Its own cursor, so subscribing to motions cannot move the referendum lane.
    expect(cursorKey('tc-motion')).toBe('cursor:tc-motion')
    expect(parseRuleParams('tc-motion', {}).ok).toBe(true)
    expect(parseRuleParams('tc-motion', { phases: [...TC_MOTION_PHASES] }).ok).toBe(true)
    expect(parseRuleParams('tc-motion', { phases: ['deciding'] }).ok).toBe(false)
    // And the separation holds in both directions: a referendum rule cannot name a
    // motion phase, so nobody can subscribe to committee traffic by accident.
    expect(parseRuleParams('referendum', { phases: ['proposed'] }).ok).toBe(false)
    expect(describeRule('tc-motion', { phases: ['approved'] })).toBe('technical committee motions — approved')
  })
})

describe('tc-motion matching', () => {
  it('filters by phase, and folds MemberExecuted into executed', () => {
    const r = rule('tc-motion', { phases: ['approved', 'executed'] })
    const rows = [
      row({ blockHeight: 1_010, phase: 'proposed' }),
      row({ blockHeight: 1_020, phase: 'approved' }),
      row({ blockHeight: 1_030, phase: 'executed', ok: true }),
      row({ blockHeight: 1_040, phase: 'closed' }),
    ]
    expect(evaluateTcMotion(rows, [r], W).map(m => m.identity))
      .toEqual([`${HASH}:approved`, `${HASH}:executed`])
    // No phases = every phase.
    expect(evaluateTcMotion(rows, [rule('tc-motion', {})], W)).toHaveLength(4)
  })

  it('gives each member vote its own identity, and every other phase one per motion', () => {
    const votes = [1, 2, 3, 4, 5].map(i => row({
      blockHeight: 1_050, eventIndex: i, phase: 'voted', actor: accountRef(MEMBER), aye: i % 2 === 1, yes: i, no: 0,
    }))
    const matches = evaluateTcMotion(votes, [rule('tc-motion', {})], W)
    // The regression this identity exists for: keyed on the phase alone, a
    // five-member motion would have collapsed into a single notification.
    expect(new Set(matches.map(m => m.identity)).size).toBe(5)
    expect(tcMotionIdentity(votes[0])).toBe(`${HASH}:voted:1050-e1`)
    // Two Approved events for one motion (a replayed window) stay one match.
    const approved = [row({ eventIndex: 3 }), row({ eventIndex: 3 })]
    expect(evaluateTcMotion(approved, [rule('tc-motion', {})], W)).toHaveLength(1)
  })

  it('never fires from a block at or below the cursor', () => {
    const r = rule('tc-motion', {})
    expect(evaluateTcMotion([row({ blockHeight: 1_000 })], [r], W)).toHaveLength(0)
    expect(evaluateTcMotion([row({ blockHeight: 999 })], [r], W)).toHaveLength(0)
    expect(evaluateTcMotion([row({ blockHeight: 1_100 })], [r], W)).toHaveLength(1)
  })

  it('is dispatched by the shared row-lane switch', () => {
    const matches = evaluateRowKind('tc-motion', [row()], [rule('tc-motion', {})], W)
    expect(matches.map(m => m.identity)).toEqual([`${HASH}:approved`])
  })
})

describe('tc-motion rendering', () => {
  it('names the motion by its shortened hash and the phase', () => {
    const message = render(row({ phase: 'approved' }))
    expect(message.title).toBe('TC motion 0x0529aa…664b5b approved')
    // Not the referendum lane's page: an approval is an event, not an activity.
    expect(message.path).toBe('/event/1050-3')
  })

  it('carries the voter, their side and the running tally on a vote', () => {
    const message = render(row({ phase: 'voted', actor: accountRef(MEMBER), aye: true, yes: 3, no: 1 }))
    expect(message.title).toBe('TC motion 0x0529aa…664b5b voted')
    expect(message.body).toContain('Voted by')
    expect(message.body).toContain('· Aye')
    expect(message.body).toContain('3 aye / 1 nay')
    // A vote IS a vote-activity row now, so it links to that row's own page.
    expect(message.path).toBe('/vote/1050-e3')
    expect(render(row({ phase: 'voted', actor: accountRef(MEMBER), aye: false })).body).toContain('· Nay')
  })

  it('states the threshold on a proposal and the result on an execution', () => {
    expect(render(row({ phase: 'proposed', actor: accountRef(MEMBER), threshold: 3 })).body).toContain('Threshold 3')
    expect(render(row({ phase: 'proposed', actor: accountRef(MEMBER) })).body).toContain('Proposed by')
    expect(render(row({ phase: 'executed', ok: true })).body).toContain('Dispatched successfully')
    expect(render(row({ phase: 'executed', ok: false })).body).toContain('Dispatch failed')
  })
})

/* ============ the lane, from raw_events to the inbox ============ */

describe('tc-motion lane', () => {
  const HEAD = 1_000
  const event = (name: string, args: Record<string, unknown>, block = 900, index = 1) => ({
    block_height: block, event_index: index, extrinsic_index: 2,
    event_name: `TechnicalCommittee.${name}`, args_json: JSON.stringify(args),
  })

  let client: FakeClient
  let tables: {
    raw_ingestion_state: { head: number }[]
    raw_events: Record<string, unknown>[]
    raw_extrinsics: never[]
    referendum_lifecycle_events: never[]
  }

  beforeEach(async () => {
    resetEvaluatorForTests()
    resetDeliveryStateForTests()
    tables = { raw_ingestion_state: [{ head: HEAD }], raw_events: [], raw_extrinsics: [], referendum_lifecycle_events: [] }
    client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
    await createRule(OWNER, { kind: 'tc-motion', params: {} })
    await setNotificationState(cursorKey('tc-motion'), '800')
  })

  afterEach(async () => { await stopNotificationEvaluator() })

  const inbox = () => insertedRows(client, 'user_notification_inbox')

  it('reads the committee events out of raw_events and renders each phase', async () => {
    tables.raw_events.push(
      event('Proposed', { account: MEMBER, proposalIndex: 12, proposalHash: HASH, threshold: 3 }, 810, 1),
      event('Voted', { account: MEMBER, proposalHash: HASH, voted: true, yes: 1, no: 0 }, 820, 4),
      event('Closed', { proposalHash: HASH, yes: 3, no: 0 }, 830, 2),
      event('Approved', { proposalHash: HASH }, 830, 3),
      event('Executed', { proposalHash: HASH, result: { __kind: 'Ok' } }, 830, 4),
    )
    await runEvaluatorTick()
    const titles = inbox().map(r => String(r.title))
    // Inbox rows are written oldest-block first, then by identity within a block.
    expect(titles).toEqual([
      'TC motion 0x0529aa…664b5b proposed',
      'TC motion 0x0529aa…664b5b voted',
      'TC motion 0x0529aa…664b5b approved',
      'TC motion 0x0529aa…664b5b closed',
      'TC motion 0x0529aa…664b5b executed',
    ])
    // The voted row links to its vote activity; the rest to their own events.
    const byTitle = new Map(inbox().map(r => [String(r.title), String(r.url)]))
    expect(byTitle.get('TC motion 0x0529aa…664b5b voted')).toContain('/vote/820-e4')
    expect(byTitle.get('TC motion 0x0529aa…664b5b approved')).toContain('/event/830-3')
  })

  it('delivers one notification per member vote, and nothing twice on a replay', async () => {
    for (const [i, aye] of [true, true, false].entries()) {
      tables.raw_events.push(event('Voted', { account: MEMBER, proposalHash: HASH, voted: aye, yes: i + 1, no: 0 }, 820, i + 1))
    }
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(3)
    expect(new Set(inbox().map(r => r.notification_id)).size).toBe(3)
    // The cursor advanced, and re-running the same window changes nothing.
    setHeadTo(client, tables, 1_010)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(3)
  })

  it('stays silent for a rule that only subscribes to referenda', async () => {
    resetEvaluatorForTests()
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
    tables.raw_events.push(event('Approved', { proposalHash: HASH }, 820, 1))
    await setNotificationState(cursorKey('referendum'), '800')
    await runEvaluatorTick()
    // The referendum lane reads referendum_lifecycle_events, which holds nothing;
    // the motion never reaches a referendum subscriber.
    expect(inbox().filter(r => r.kind === 'referendum')).toHaveLength(0)
  })
})

function setHeadTo(_client: FakeClient, tables: { raw_ingestion_state: { head: number }[] }, head: number): void {
  tables.raw_ingestion_state[0].head = head
}
