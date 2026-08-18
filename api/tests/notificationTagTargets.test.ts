import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Tag targets: an account-activity rule that watches a GROUP — a system tag, or
// a tag on one of the owner's own (or subscribed) lists — instead of a single
// address. The invariants that matter are that the membership is resolved LIVE
// (never frozen into the rule), that one target costs one fetch however many
// accounts it holds, and that losing access to a list silences the rule without
// erroring.

interface ActivityCall { kind: 'address' | 'tag' | 'list-tag'; id: string; members?: string[]; filters?: Record<string, unknown> }
const activityCalls: ActivityCall[] = []
let activityRows: Record<string, unknown>[] = []
vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  return {
    ...actual,
    getAddressActivity: async (address: string, _t: string, _l: number, _o: number, _a?: string, filters?: Record<string, unknown>) => {
      activityCalls.push({ kind: 'address', id: address, filters })
      return activityRows
    },
    getTagActivity: async (tagId: string, _t: string, _l: number, _o: number, _a?: string, filters?: Record<string, unknown>) => {
      activityCalls.push({ kind: 'tag', id: tagId, filters })
      return activityRows
    },
    getListTagActivity: async (listId: string, tagId: string, members: string[], _t: string, _l: number, _o: number, _a?: string, filters?: Record<string, unknown>) => {
      activityCalls.push({ kind: 'list-tag', id: `${listId}:${tagId}`, members: [...members], filters })
      return activityRows
    },
  }
})

import { initEvaluator, resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator } from '../src/notifications/evaluator.ts'
import { createRule, initNotifications, loadNotifications, rulesFor } from '../src/notifications/notificationStore.ts'
import { resolveActivityTarget } from '../src/notifications/ruleTargets.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import {
  createList, createTag, ensurePersonalList, initUserListService, loadUserLists,
  setTagMembers, subscribePublic, updateList,
} from '../src/services/userListService.ts'
import { initTagService, loadTags } from '../src/services/tagService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const CURATOR = '0x' + 'bb'.repeat(32)
const M1 = '0x' + '11'.repeat(32)
const M2 = '0x' + '22'.repeat(32)
const TREASURY = '0x' + '33'.repeat(32)

let client: FakeClient
let tables: { raw_ingestion_state: { head: number }[]; raw_events: never[]; raw_extrinsics: never[]; referendum_lifecycle_events: never[] }

const inbox = () => insertedRows(client, 'user_notification_inbox')
const setHead = (head: number) => { tables.raw_ingestion_state[0].head = head }

const trade = (blockHeight: number, eventIndex: number, valueUsd = 25): Record<string, unknown> => ({
  type: 'trade', blockHeight, timestamp: '2026-08-18 10:00:00', eventIndex, extrinsicIndex: 1,
  who: null, to: null, asset: null,
  assetIn: { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachainId: null, origin: null },
  assetOut: { assetId: 10, iconAssetId: 10, symbol: 'USDT', name: 'USDT', decimals: 6, parachainId: null, origin: null },
  amount: null, amountIn: '1000000000000000', amountOut: '25000000', valueUsd,
} satisfies Partial<ActivityRow> as unknown as Record<string, unknown>)

beforeEach(async () => {
  resetEvaluatorForTests()
  resetDeliveryStateForTests()
  activityCalls.length = 0
  activityRows = []
  initUserListService(fakeClient())
  await loadUserLists()
  initTagService(fakeClient({
    'price_data.account_tags': [
      { label_id: 'treasury', label_name: 'Treasury', color: '#74C742', note: '', icon: '🏦', account_id: TREASURY },
      { label_id: 'kraken', label_name: 'Kraken', color: '#5b53d3', note: '', icon: '🐙', account_id: M1 },
      { label_id: 'kraken', label_name: 'Kraken', color: '#5b53d3', note: '', icon: '🐙', account_id: M2 },
    ],
  }))
  await loadTags()
  tables = { raw_ingestion_state: [{ head: 1_000 }], raw_events: [], raw_extrinsics: [], referendum_lifecycle_events: [] }
  client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
  initNotifications(client)
  await loadNotifications()
  initEvaluator(client)
})

afterEach(async () => { await stopNotificationEvaluator() })

/* ============ creation ============ */

describe('tag target validation', () => {
  it('accepts an existing system tag and rejects one that does not exist', async () => {
    await expect(createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' } } })).resolves.toBeTruthy()
    await expect(createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'not-a-tag' } } }))
      .rejects.toMatchObject({ status: 422 })
  })

  it('accepts a list tag the creator owns, is subscribed to, or that is public', async () => {
    const mine = await ensurePersonalList(OWNER)
    const myTag = await createTag(OWNER, mine.listId, { name: 'Whales' })
    await expect(createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'list-tag', listId: mine.listId, tagId: myTag.tagId } } }))
      .resolves.toBeTruthy()

    // A public list is readable by anyone, subscribed or not — the same gate
    // its own pages use.
    const open = await createList(CURATOR, 'Desks', '', 'public')
    const openTag = await createTag(CURATOR, open.listId, { name: 'Desks' })
    await expect(createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'list-tag', listId: open.listId, tagId: openTag.tagId } } }))
      .resolves.toBeTruthy()

    // A private list is not, until it has been shared and accepted.
    const closed = await createList(CURATOR, 'Private', '', 'private')
    const closedTag = await createTag(CURATOR, closed.listId, { name: 'Inner' })
    const params = { target: { kind: 'list-tag', listId: closed.listId, tagId: closedTag.tagId } }
    await expect(createRule(OWNER, { kind: 'account-activity', params })).rejects.toMatchObject({ status: 422 })
    await updateList(CURATOR, closed.listId, { visibility: 'public' })
    await subscribePublic(OWNER, closed.listId)
    await expect(createRule(OWNER, { kind: 'account-activity', params })).resolves.toBeTruthy()
  })

  it('rejects a tag id the list does not have, without naming it', async () => {
    const mine = await ensurePersonalList(OWNER)
    await expect(createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'list-tag', listId: mine.listId, tagId: 'ffffffff-0000-4000-8000-000000000000' } } }))
      .rejects.toMatchObject({ status: 422, message: 'That list has no such tag' })
  })

  // The point of a tag target: one rule, whatever the membership, so the
  // per-account cap is not a cap on how many accounts somebody may watch.
  it('counts a tag target as one rule however many accounts it holds', async () => {
    const mine = await ensurePersonalList(OWNER)
    const tag = await createTag(OWNER, mine.listId, { name: 'Whales' })
    await setTagMembers(OWNER, mine.listId, tag.tagId, [M1, M2, TREASURY], [])
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'list-tag', listId: mine.listId, tagId: tag.tagId } } })
    expect(rulesFor(OWNER)).toHaveLength(1)
    expect(resolveActivityTarget(OWNER, { kind: 'list-tag', listId: mine.listId, tagId: tag.tagId })?.memberCount).toBe(3)
  })
})

/* ============ the lane ============ */

describe('tag target evaluation', () => {
  it('reads the scoped tag feed once per target, however many rules watch it', async () => {
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' } } })
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' }, type: 'trade' } })
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' }, type: 'trade', minUsd: 1_000 } })
    await runEvaluatorTick()                       // seeds
    setHead(1_010)
    activityCalls.length = 0
    activityRows = [trade(1_005, 1, 25), trade(1_006, 2, 50_000)]
    await runEvaluatorTick()

    expect(activityCalls).toEqual([{ kind: 'tag', id: 'kraken', filters: {} }])
    // Two rules match both rows, the $1k one only the big row.
    expect(inbox()).toHaveLength(5)
  })

  // The reason a tag target is worth having: the member set is read at fetch
  // time, so an account added to the tag afterwards is watched with no change
  // to the rule at all.
  it('scopes a list tag to its CURRENT members, including ones added after the rule', async () => {
    const mine = await ensurePersonalList(OWNER)
    const tag = await createTag(OWNER, mine.listId, { name: 'Whales' })
    await setTagMembers(OWNER, mine.listId, tag.tagId, [M1], [])
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'list-tag', listId: mine.listId, tagId: tag.tagId } } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls[0].members).toEqual([M1])

    await setTagMembers(OWNER, mine.listId, tag.tagId, [M2], [])
    setHead(1_020)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls[0].members).toEqual([M1, M2])
  })

  // Access is re-checked on every fetch, not just at creation: a list that stops
  // being visible must stop delivering at once, and quietly.
  it('goes silent when the owner can no longer see the list, without erroring', async () => {
    const shared = await createList(CURATOR, 'Desks', '', 'public')
    const tag = await createTag(CURATOR, shared.listId, { name: 'Desks' })
    await setTagMembers(CURATOR, shared.listId, tag.tagId, [M1], [])
    await subscribePublic(OWNER, shared.listId)
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'list-tag', listId: shared.listId, tagId: tag.tagId } } })
    await runEvaluatorTick()
    setHead(1_010)
    activityRows = [trade(1_005, 1)]
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)

    // Turning the list private revokes the public subscription with it.
    await updateList(CURATOR, shared.listId, { visibility: 'private' })
    setHead(1_020)
    activityCalls.length = 0
    activityRows = [trade(1_015, 1)]
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(0)
    expect(inbox()).toHaveLength(1)
  })

  it('keeps address and tag targets on their own fetches inside one budget', async () => {
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'address', address: '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ' } } })
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'kraken' }, minUsd: 5_000 } })
    await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'tag', tagId: 'treasury' }, minUsd: 100 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls.map(c => `${c.kind}:${c.id}`).sort()).toEqual([
      'address:15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ', 'tag:kraken', 'tag:treasury',
    ])
    // A group whose rules all carry a floor pushes the lowest of them into the
    // query, exactly like an address group.
    expect(activityCalls.find(c => c.id === 'kraken')?.filters).toEqual({ min: 5_000, unit: 'usd' })
  })
})
