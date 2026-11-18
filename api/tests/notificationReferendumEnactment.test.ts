import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { installReferendumTitles } from './helpers/referendumTitles.ts'
import {
  cursorKey, initEvaluator, resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import {
  createRule, initNotifications, loadNotifications, rulesFor, setNotificationState,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { initExplorerService } from '../src/services/explorerService.ts'
import { referendumEnactmentTaskId } from '../src/services/governanceService.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// A referendum's enactment is a Scheduler event that names its TASK — a one-way
// blake2 hash — never its referendum. The lane recovers the index by hashing
// every known index the other way and matching. These tests pin that reverse
// mapping end to end: a dispatch for a known referendum becomes an 'executed'
// notification, a named task that is not an enactment stays silent, and the
// alert fires exactly once.

initExplorerService(fakeClient())

const OWNER = '0x' + 'aa'.repeat(32)

describe('referendum enactment notifications', () => {
  let client: FakeClient
  let tables: Record<string, Record<string, unknown>[]>

  const inbox = () => insertedRows(client, 'user_notification_inbox')
  const setHead = (head: number) => { tables.raw_ingestion_state[0] = { head } }

  const dispatch = (index: number, block: number, result: unknown, eventName = 'Scheduler.Dispatched') => ({
    task_id: referendumEnactmentTaskId(index), block_height: block, event_index: 2,
    event_name: eventName, args_json: JSON.stringify({ result }),
  })

  beforeEach(async () => {
    resetEvaluatorForTests()
    resetDeliveryStateForTests()
    tables = {
      raw_ingestion_state: [{ head: 1_000 }],
      // The submitted row is what teaches the lane 412 exists (max index).
      referendum_lifecycle_events: [{
        pallet: 'opengov', ref_index: 412, block_height: 800, event_index: 1,
        event_name: 'Referenda.Submitted', args_json: JSON.stringify({ track: 5 }),
      }],
      scheduler_named_dispatches: [],
      forum_posts: [{ pallet: 'opengov', ref_index: 412, title: 'Add HDX liquidity to the Omnipool' }],
      raw_events: [], raw_extrinsics: [],
      user_notification_rules: [], user_notification_state: [], user_notification_channels: [],
      user_notification_inbox: [],
    }
    client = fakeClient(tables)
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
    installReferendumTitles(tables.forum_posts as { pallet: string; ref_index: number; title: string }[])
    // Cursor above the submitted row: the enactment is the only news.
    await setNotificationState(cursorKey('referendum'), '900')
  })

  afterEach(async () => { await stopNotificationEvaluator() })

  it('turns a named dispatch back into its referendum and fires exactly once', async () => {
    await createRule(OWNER, { kind: 'referendum', params: { phases: ['executed'] } })
    tables.scheduler_named_dispatches.push(
      dispatch(412, 950, { __kind: 'Ok' }),
      // A named scheduler task that is not any referendum's enactment.
      { task_id: '0x' + 'de'.repeat(32), block_height: 951, event_index: 4, event_name: 'Scheduler.Dispatched', args_json: JSON.stringify({ result: { __kind: 'Ok' } }) },
    )
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toContain('Add HDX liquidity')
    expect(String(inbox()[0].body)).toContain('Referendum #412 executed')
    expect(String(inbox()[0].url)).toContain('/referendum/opengov/412')

    // The dispatch row is still in the table on the next tick — not news twice.
    setHead(1_100)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
  })

  it('reports a failed enactment as a failure', async () => {
    await createRule(OWNER, { kind: 'referendum', params: { phases: ['executed'] } })
    tables.scheduler_named_dispatches.push(dispatch(412, 950, { __kind: 'Err' }))
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].body)).toContain('the call FAILED')
  })

  it('does not wake rules that filter to other phases', async () => {
    await createRule(OWNER, { kind: 'referendum', params: { phases: ['confirmed'] } })
    tables.scheduler_named_dispatches.push(dispatch(412, 950, { __kind: 'Ok' }))
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
  })

  // There is no per-track subscription. A rule stored with a `track` no longer
  // parses, so the store skips it at load: never listed, never evaluated, its row
  // left alone, and only the number of such rules is logged.
  it('skips a stored per-track rule at load and never evaluates it', async () => {
    tables.user_notification_rules.push({
      rule_id: 'stored-track-rule', account_id: OWNER, kind: 'referendum', name: 'Referenda on treasurer',
      params: JSON.stringify({ track: '5' }), channels: [], muted: 0, cooldown_s: 0, deleted: 0,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await loadNotifications()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 per-track referendum rule(s) skipped'))
      expect(warn.mock.calls.flat().join(' ')).not.toContain('stored-track-rule')
    } finally { warn.mockRestore() }
    expect(rulesFor(OWNER)).toHaveLength(0)
    await setNotificationState(cursorKey('referendum'), '900')
    tables.scheduler_named_dispatches.push(dispatch(412, 950, { __kind: 'Ok' }))
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
  })
})
