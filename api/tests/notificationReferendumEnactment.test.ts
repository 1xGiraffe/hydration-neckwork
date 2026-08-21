import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  cursorKey, initEvaluator, resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import {
  createRule, initNotifications, loadNotifications, setNotificationState,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { initReferendumTitleService, loadReferendumTitles } from '../src/services/referendumTitleService.ts'
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
      // The submitted row is what teaches the lane 412 exists (max index) and
      // which track it runs on (the track-filter backfill).
      referendum_lifecycle_events: [{
        pallet: 'opengov', ref_index: 412, block_height: 800, event_index: 1,
        event_name: 'Referenda.Submitted', args_json: JSON.stringify({ track: 5 }),
      }],
      scheduler_named_dispatches: [],
      referendum_titles: [{ pallet: 'opengov', ref_index: 412, title: 'Add HDX liquidity to the Omnipool' }],
      raw_events: [], raw_extrinsics: [],
      user_notification_rules: [], user_notification_state: [], user_notification_channels: [],
      user_notification_inbox: [],
    }
    client = fakeClient(tables)
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
    initReferendumTitleService(client)
    await loadReferendumTitles()
    // Cursor above the submitted row: the enactment is the only news.
    await setNotificationState(cursorKey('referendum'), '900')
  })

  afterEach(async () => { await stopNotificationEvaluator() })

  it('turns a named dispatch back into its referendum and fires exactly once', async () => {
    await createRule(OWNER, { kind: 'referendum', params: { phases: ['executed'], track: '5' } })
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

  it('does not wake rules that filter to other phases or tracks', async () => {
    await createRule(OWNER, { kind: 'referendum', params: { phases: ['confirmed'] } })
    await createRule(OWNER, { kind: 'referendum', params: { track: '0' } })
    tables.scheduler_named_dispatches.push(dispatch(412, 950, { __kind: 'Ok' }))
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
  })
})
