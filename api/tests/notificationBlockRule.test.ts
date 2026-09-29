import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  evaluateBlockRules, initEvaluator, renderMatch, resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import { renderNotification } from '../src/notifications/render.ts'
import {
  activeRulesByKind, allRules, createRule, initNotifications, loadNotifications, updateRule, type NotificationRule,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { describeRule, isSelfDeletingKind, parseRuleParams, KIND_LABELS } from '../src/notifications/notificationRules.ts'
import { initExplorerService } from '../src/services/explorerService.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// A block alert names one future height, fires once that block is finalized and
// indexed, and then deletes itself: the height cannot be reached twice.

const OWNER = '0x' + 'aa'.repeat(32)
const HEAD = 1_000

initExplorerService(fakeClient({ raw_ingestion_state: [{ head: HEAD }] }))

const rule = (block: number, over: Partial<NotificationRule> = {}): NotificationRule => ({
  ruleId: `r-${block}`, accountId: OWNER, kind: 'block', name: '', params: { block }, channels: [], muted: false, cooldownS: 0, ...over,
})

describe('block rule params', () => {
  it('takes one positive integer height and nothing else', () => {
    expect(parseRuleParams('block', { block: 15_172_059 })).toEqual({ ok: true, params: { block: 15_172_059 } })
    expect(parseRuleParams('block', { block: 0 }).ok).toBe(false)
    expect(parseRuleParams('block', { block: 1.5 }).ok).toBe(false)
    expect(parseRuleParams('block', {}).ok).toBe(false)
    expect(parseRuleParams('block', { block: 5, extra: 1 }).ok).toBe(false)
  })

  it('is the one self-deleting kind and describes the height', () => {
    expect(isSelfDeletingKind('block')).toBe(true)
    expect(isSelfDeletingKind('price')).toBe(false)
    expect(KIND_LABELS.block).toBe('Future block')
    expect(describeRule('block', { block: 15_172_059 })).toBe('block #15,172,059 being reached')
  })
})

describe('evaluateBlockRules', () => {
  it('fires a rule once its height is reached, with the height as identity', () => {
    const { matches, expired } = evaluateBlockRules([rule(999), rule(1_000), rule(1_001)], 1_000)
    expect(matches.map(m => m.identity)).toEqual(['block:999', 'block:1000'])
    expect(matches.map(m => m.blockHeight)).toEqual([999, 1_000])
    expect(expired).toEqual(['r-999', 'r-1000'])
  })

  it('expires a muted rule without matching it', () => {
    const { matches, expired } = evaluateBlockRules([rule(900, { muted: true })], 1_000)
    expect(matches).toEqual([])
    expect(expired).toEqual(['r-900'])
  })

  it('ignores every other kind', () => {
    expect(evaluateBlockRules([{ ...rule(5), kind: 'price' }], 1_000)).toEqual({ matches: [], expired: [] })
  })

  it('renders a link to the block', () => {
    const [match] = evaluateBlockRules([rule(1_000)], 1_000).matches
    const rendered = renderNotification(renderMatch(match, rule(1_000), () => null))
    expect(rendered.title).toBe('Block #1,000 reached')
    expect(rendered.url).toContain('/block/1000')
  })
})

describe('block rule lifecycle', () => {
  let client: FakeClient
  let tables: { raw_ingestion_state: { head: number }[]; raw_events: never[] }

  beforeEach(async () => {
    resetEvaluatorForTests()
    resetDeliveryStateForTests()
    tables = { raw_ingestion_state: [{ head: HEAD }], raw_events: [] }
    client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
  })

  afterEach(async () => { await stopNotificationEvaluator() })

  it('refuses a height the index has already reached', async () => {
    await expect(createRule(OWNER, { kind: 'block', params: { block: HEAD } })).rejects.toMatchObject({ status: 422 })
    await expect(createRule(OWNER, { kind: 'block', params: { block: HEAD - 50 } })).rejects.toMatchObject({ status: 422 })
    const ok = await createRule(OWNER, { kind: 'block', params: { block: HEAD + 1 } })
    await expect(updateRule(OWNER, ok.ruleId, { params: { block: 10 } })).rejects.toMatchObject({ status: 422 })
  })

  it('stays quiet until the block is reached, then fires once and deletes itself', async () => {
    const created = await createRule(OWNER, { kind: 'block', params: { block: HEAD + 5 } })
    await runEvaluatorTick()
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(0)
    expect(activeRulesByKind('block')).toHaveLength(1)

    tables.raw_ingestion_state[0].head = HEAD + 5
    await runEvaluatorTick()
    const inbox = insertedRows(client, 'user_notification_inbox')
    expect(inbox).toHaveLength(1)
    expect(String(inbox[0].title)).toBe(`Block #${(HEAD + 5).toLocaleString('en-US')} reached`)
    expect(allRules().some(r => r.ruleId === created.ruleId)).toBe(false)
    // The soft-delete row was persisted, so a restart does not bring it back.
    const deletes = insertedRows(client, 'user_notification_rules').filter(r => r.rule_id === created.ruleId && r.deleted === 1)
    expect(deletes).toHaveLength(1)

    tables.raw_ingestion_state[0].head = HEAD + 6
    await runEvaluatorTick()
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(1)
  })

  it('waits for the block rows to be visible, not just the ingestion checkpoint', async () => {
    await createRule(OWNER, { kind: 'block', params: { block: HEAD + 5 } })
    tables.raw_ingestion_state[0].head = HEAD + 5
    client.sourceHead = HEAD + 4
    await runEvaluatorTick()
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(0)
    client.sourceHead = HEAD + 5
    await runEvaluatorTick()
    expect(insertedRows(client, 'user_notification_inbox')).toHaveLength(1)
  })
})
