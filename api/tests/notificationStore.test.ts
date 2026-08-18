import { describe, it, expect, beforeEach } from 'vitest'
import {
  initNotifications, loadNotifications,
  createWebPushChannel, upsertTelegramChannel, deleteChannel, removeChannelById, setChannelVerified,
  channelsFor, getChannel, telegramChannelForChat,
  createRule, updateRule, deleteRule, rulesFor, allRules, activeRulesByKind, activeRuleKinds,
  canonicalParams, findEquivalentRule,
  insertInboxRows, queryInbox, unreadCount, markInboxRead, clearInbox, armStateKey,
  getNotificationState, setNotificationState, deleteNotificationState,
  hasNotification, rememberNotification,
  NOTIFICATION_LIMITS,
} from '../src/notifications/notificationStore.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const OTHER = '0x' + 'bb'.repeat(32)
const SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) }

// fakeClient accumulates every insert, so a reload test that mutates the same
// key twice would otherwise see both rows. The real read is `FROM … FINAL`,
// which collapses to the newest row per ReplacingMergeTree key — reproduce
// that collapse over the captured inserts before feeding a fresh client.
// Soft-deleted rows are KEPT, exactly as FINAL keeps them: hiding them is the
// `deleted = 0` predicate's job, which fakeClient reproduces.
function finalRows(rows: Record<string, unknown>[], key: string): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>()
  for (const r of rows) byKey.set(String(r[key]), r)
  return [...byKey.values()]
}

async function reload(client: FakeClient): Promise<FakeClient> {
  const next = fakeClient({
    user_notification_channels: finalRows(insertedRows(client, 'user_notification_channels'), 'channel_id'),
    user_notification_rules: finalRows(insertedRows(client, 'user_notification_rules'), 'rule_id'),
    user_notification_state: finalRows(insertedRows(client, 'user_notification_state'), 'key'),
    user_notification_inbox: finalRows(insertedRows(client, 'user_notification_inbox'), 'notification_id'),
  })
  initNotifications(next)
  await loadNotifications()
  return next
}

describe('notification channels', () => {
  let client: FakeClient
  beforeEach(async () => { client = fakeClient(); initNotifications(client); await loadNotifications() })

  it('registers a web push channel and never re-exposes its keys through the model', async () => {
    const channel = await createWebPushChannel(OWNER, SUB, 'Firefox on Linux')
    expect(channel.kind).toBe('webpush')
    expect(channel.verified).toBe(true)
    expect(channelsFor(OWNER).map(c => c.channelId)).toEqual([channel.channelId])
    // Persisted as one opaque JSON blob, exactly like the declaration says.
    const [row] = insertedRows(client, 'user_notification_channels')
    expect(JSON.parse(String(row.config))).toEqual(SUB)
    expect(row.label).toBe('Firefox on Linux')
  })

  it('updates the existing channel when the same endpoint re-registers', async () => {
    const first = await createWebPushChannel(OWNER, SUB, 'Firefox')
    const again = await createWebPushChannel(OWNER, { ...SUB, auth: 'z'.repeat(20) }, '')
    expect(again.channelId).toBe(first.channelId)
    expect(channelsFor(OWNER)).toHaveLength(1)
    expect(again.label).toBe('Firefox')
  })

  it('keeps one telegram channel per chat and moves it when another account links it', async () => {
    const mine = await upsertTelegramChannel(OWNER, { chatId: '4242', username: 'maf' })
    expect(telegramChannelForChat('4242')?.channelId).toBe(mine.channelId)
    expect(mine.label).toBe('@maf')
    const theirs = await upsertTelegramChannel(OTHER, { chatId: '4242', username: 'maf' })
    expect(telegramChannelForChat('4242')?.channelId).toBe(theirs.channelId)
    expect(channelsFor(OWNER)).toHaveLength(0)
    expect(channelsFor(OTHER)).toHaveLength(1)
  })

  it('deletes only its own channel, and drops the reference from every rule that named it', async () => {
    const channel = await createWebPushChannel(OWNER, SUB)
    const rule = await createRule(OWNER, { kind: 'safety', params: {}, channels: [channel.channelId] })
    // A foreign id answers 404, exactly like an id that never existed: a
    // distinguishable 403 would turn these into an existence oracle.
    await expect(deleteChannel(OTHER, channel.channelId)).rejects.toMatchObject({ status: 404 })
    await deleteChannel(OWNER, channel.channelId)
    expect(getChannel(channel.channelId)).toBeNull()
    expect(rulesFor(OWNER).find(r => r.ruleId === rule.ruleId)?.channels).toEqual([])
  })

  it('removes a dead subscription without an owner check (push 404/410 path)', async () => {
    const channel = await createWebPushChannel(OWNER, SUB)
    await removeChannelById(channel.channelId)
    expect(getChannel(channel.channelId)).toBeNull()
  })

  it('flips verification without churning rows when nothing changed', async () => {
    const channel = await upsertTelegramChannel(OWNER, { chatId: '7', username: '' })
    const before = insertedRows(client, 'user_notification_channels').length
    await setChannelVerified(channel.channelId, true)
    expect(insertedRows(client, 'user_notification_channels')).toHaveLength(before)
    await setChannelVerified(channel.channelId, false)
    expect(getChannel(channel.channelId)?.verified).toBe(false)
  })

  it('caps the channels one account can register', async () => {
    for (let i = 0; i < NOTIFICATION_LIMITS.channelsPerAccount; i++) {
      await createWebPushChannel(OWNER, { ...SUB, endpoint: `${SUB.endpoint}/${i}` })
    }
    await expect(createWebPushChannel(OWNER, { ...SUB, endpoint: `${SUB.endpoint}/over` })).rejects.toMatchObject({ status: 422 })
  })
})

describe('notification rules', () => {
  let client: FakeClient
  beforeEach(async () => { client = fakeClient(); initNotifications(client); await loadNotifications() })

  it('creates, patches and deletes a rule with ownership enforced', async () => {
    const rule = await createRule(OWNER, { kind: 'price', params: { assetId: 5, direction: 'below', price: 0.005 }, name: 'HDX floor' })
    expect(rulesFor(OWNER)).toHaveLength(1)
    expect(activeRulesByKind('price').map(r => r.ruleId)).toEqual([rule.ruleId])

    const muted = await updateRule(OWNER, rule.ruleId, { muted: true })
    expect(muted.muted).toBe(true)
    expect(activeRulesByKind('price')).toHaveLength(0)
    expect(activeRuleKinds()).toEqual([])

    await expect(updateRule(OTHER, rule.ruleId, { muted: false })).rejects.toMatchObject({ status: 404 })
    await expect(deleteRule(OTHER, rule.ruleId)).rejects.toMatchObject({ status: 404 })
    await deleteRule(OWNER, rule.ruleId)
    expect(allRules()).toHaveLength(0)
  })

  // Creating a subscription is idempotent: the same bell is reachable from
  // several surfaces, and pressing it twice must not produce a second rule that
  // then delivers every match twice.
  it('returns the existing rule instead of inserting a duplicate', async () => {
    const first = await createRule(OWNER, { kind: 'price', params: { assetId: 5, direction: 'below', price: 0.005 } })
    const inserts = () => insertedRows(client, 'user_notification_rules').length
    const before = inserts()
    const again = await createRule(OWNER, { kind: 'price', params: { assetId: 5, direction: 'below', price: 0.005 }, name: 'ignored' })
    expect(again.ruleId).toBe(first.ruleId)
    expect(again.name).toBe('')
    expect(rulesFor(OWNER)).toHaveLength(1)
    expect(inserts()).toBe(before)
    expect(findEquivalentRule(OWNER, 'price', { assetId: 5, direction: 'below', price: 0.005 })?.ruleId).toBe(first.ruleId)
    // Another account's identical rule is its own subscription.
    expect((await createRule(OTHER, { kind: 'price', params: { assetId: 5, direction: 'below', price: 0.005 } })).ruleId).not.toBe(first.ruleId)
  })

  it('dedupes params that differ only in key order or in spelling a default', async () => {
    const first = await createRule(OWNER, { kind: 'health-factor', params: { address: SS58, threshold: 1.1 } })
    // Key order is a JSON artefact, and an omitted optional the schema defaults
    // is the same subscription as one that spelled the default out.
    const reordered = await createRule(OWNER, { kind: 'health-factor', params: { threshold: 1.1, address: SS58 } })
    const defaulted = await createRule(OWNER, { kind: 'health-factor', params: { address: SS58 } })
    // The pre-target spelling normalizes onto the target form, so both reach
    // the same rule too.
    const legacy = await createRule(OWNER, { kind: 'account-activity', params: { address: SS58 } })
    const targeted = await createRule(OWNER, { kind: 'account-activity', params: { target: { kind: 'address', address: SS58 } } })
    expect([reordered.ruleId, defaulted.ruleId]).toEqual([first.ruleId, first.ruleId])
    expect(targeted.ruleId).toBe(legacy.ruleId)
    expect(rulesFor(OWNER)).toHaveLength(2)
    // Genuinely different params are a second rule.
    await createRule(OWNER, { kind: 'health-factor', params: { address: SS58, threshold: 1.5 } })
    expect(rulesFor(OWNER)).toHaveLength(3)
  })

  it('treats a muted equivalent as existing, and does not unmute it', async () => {
    const rule = await createRule(OWNER, { kind: 'safety', params: {} })
    await updateRule(OWNER, rule.ruleId, { muted: true })
    const again = await createRule(OWNER, { kind: 'safety', params: {} })
    expect(again.ruleId).toBe(rule.ruleId)
    expect(again.muted).toBe(true)
    expect(rulesFor(OWNER)).toHaveLength(1)
  })

  // The stored form is canonical, which is what makes the duplicate check a
  // string comparison — and what keeps a reload seeing the same key.
  it('persists params in canonical key order', async () => {
    await createRule(OWNER, { kind: 'price', params: { price: 0.005, direction: 'below', assetId: 5 } })
    const [row] = insertedRows(client, 'user_notification_rules')
    expect(row.params).toBe('{"assetId":5,"direction":"below","price":0.005}')
    expect(canonicalParams({ b: 1, a: [3, { d: 4, c: undefined }] })).toBe('{"a":[3,{"d":4}],"b":1}')
  })

  it('rejects params that fail the kind schema, on create and on patch', async () => {
    await expect(createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1 } })).rejects.toMatchObject({ status: 422 })
    const rule = await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1000 } })
    await expect(updateRule(OWNER, rule.ruleId, { params: { minUsd: 1 } })).rejects.toMatchObject({ status: 422 })
    expect((rulesFor(OWNER)[0].params as { minUsd: number }).minUsd).toBe(1000)
  })

  it('rejects a channel the account does not own', async () => {
    await expect(createRule(OWNER, { kind: 'safety', params: {}, channels: ['nope'] })).rejects.toMatchObject({ status: 404 })
  })

  it('caps rules per account at the documented limit', async () => {
    for (let i = 0; i < NOTIFICATION_LIMITS.rulesPerAccount; i++) {
      await createRule(OWNER, { kind: 'event', params: { section: 'Balances', method: `M${i}` } })
    }
    await expect(createRule(OWNER, { kind: 'event', params: { section: 'Balances' } })).rejects.toMatchObject({ status: 422 })
    // The cap is per account, not global.
    await expect(createRule(OTHER, { kind: 'event', params: { section: 'Balances' } })).resolves.toBeTruthy()
  })

  it('reloads channels, rules and evaluator state from persisted rows', async () => {
    const channel = await createWebPushChannel(OWNER, SUB, 'Firefox')
    const telegram = await upsertTelegramChannel(OWNER, { chatId: '99', username: 'maf' })
    const rule = await createRule(OWNER, {
      kind: 'account-activity', params: { address: SS58, type: 'trade' }, name: 'watch', channels: [telegram.channelId], cooldownS: 60,
    })
    await updateRule(OWNER, rule.ruleId, { name: 'watch closely' })
    await setNotificationState('cursor:raw-live', '9000001')

    await reload(client)

    expect(channelsFor(OWNER).map(c => c.channelId).sort()).toEqual([channel.channelId, telegram.channelId].sort())
    expect(telegramChannelForChat('99')?.accountId).toBe(OWNER)
    const [reloaded] = rulesFor(OWNER)
    expect(reloaded).toMatchObject({ ruleId: rule.ruleId, kind: 'account-activity', name: 'watch closely', cooldownS: 60, muted: false })
    expect(reloaded.channels).toEqual([telegram.channelId])
    // Persisted in the canonical, target-shaped form — a row written under the
    // pre-target spelling reloads normalized, without a migration.
    expect(reloaded.params).toEqual({ target: { kind: 'address', address: SS58 }, type: 'trade' })
    expect(getNotificationState('cursor:raw-live')).toBe('9000001')
  })

  it('does not resurrect a deleted rule or channel on reload', async () => {
    const channel = await createWebPushChannel(OWNER, SUB)
    const rule = await createRule(OWNER, { kind: 'safety', params: {} })
    await deleteRule(OWNER, rule.ruleId)
    await deleteChannel(OWNER, channel.channelId)
    await reload(client)
    expect(allRules()).toHaveLength(0)
    expect(channelsFor(OWNER)).toHaveLength(0)
  })

  // A row written under an older definition of its kind must not reach the
  // evaluator half-parsed; it is dropped at load instead.
  it('drops persisted rows whose kind or params no longer parse', async () => {
    const seeded = fakeClient({
      user_notification_rules: [
        { rule_id: 'r1', account_id: OWNER, kind: 'gone-kind', name: '', params: '{}', channels: [], muted: 0, cooldown_s: 0 },
        { rule_id: 'r2', account_id: OWNER, kind: 'price', name: '', params: '{"assetId":5}', channels: [], muted: 0, cooldown_s: 0 },
        { rule_id: 'r3', account_id: OWNER, kind: 'price', name: '', params: 'not json', channels: [], muted: 0, cooldown_s: 0 },
        { rule_id: 'r4', account_id: OWNER, kind: 'price', name: 'ok', params: '{"assetId":5,"direction":"above","price":1}', channels: [], muted: 0, cooldown_s: 0 },
      ],
      user_notification_channels: [
        { channel_id: 'c1', account_id: OWNER, kind: 'webpush', config: '{"endpoint":""}', label: '', verified: 1 },
        { channel_id: 'c2', account_id: OWNER, kind: 'telegram', config: '{"chatId":"5"}', label: '', verified: 1 },
      ],
    })
    initNotifications(seeded)
    await loadNotifications()
    expect(allRules().map(r => r.ruleId)).toEqual(['r4'])
    expect(channelsFor(OWNER).map(c => c.channelId)).toEqual(['c2'])
  })
})

describe('evaluator state and dedup set', () => {
  beforeEach(async () => { initNotifications(fakeClient()); await loadNotifications() })

  it('stores, reads and tombstones a key', async () => {
    expect(getNotificationState('arm:x')).toBeNull()
    await setNotificationState('arm:x', 'above')
    expect(getNotificationState('arm:x')).toBe('above')
    await deleteNotificationState('arm:x')
    expect(getNotificationState('arm:x')).toBeNull()
  })

  it('seeds the recent-id set from the inbox at load', async () => {
    const seeded = fakeClient({ user_notification_inbox: [{ notification_id: 'deadbeef' }] })
    initNotifications(seeded)
    await loadNotifications()
    expect(hasNotification('deadbeef')).toBe(true)
    expect(hasNotification('other')).toBe(false)
    rememberNotification('other')
    expect(hasNotification('other')).toBe(true)
  })

  // The set would otherwise grow for the life of the process. Nothing older than
  // the seed window can be re-matched, so an aged entry is dead weight.
  it('ages entries out of the recent-id set instead of growing forever', async () => {
    // Far past any real wall clock: earlier tests remember ids at Date.now(),
    // which advances the module's prune epoch — a fixture "now" behind the real
    // clock would never reopen the hourly gate (this test once pinned the very
    // hour the suite happened to run in, and started failing at that moment).
    const now = Date.UTC(2036, 7, 18, 12, 0, 0)
    const eightDays = 8 * 86_400_000
    rememberNotification('ancient', now - eightDays)
    rememberNotification('yesterday', now - 86_400_000)
    expect(hasNotification('ancient')).toBe(true)
    // The next remember an hour after the last prune sweeps what has expired.
    rememberNotification('fresh', now)
    expect(hasNotification('ancient')).toBe(false)
    expect(hasNotification('yesterday')).toBe(true)
    expect(hasNotification('fresh')).toBe(true)
  })

  // A rule's armed flag is evaluator state keyed on the rule id; leaving it
  // behind would keep a row per alert ever created.
  it('deletes a rule\'s arm state with the rule', async () => {
    const client = fakeClient()
    initNotifications(client)
    await loadNotifications()
    const rule = await createRule(OWNER, { kind: 'price', params: { assetId: 5, direction: 'above', price: 1 } })
    await setNotificationState(armStateKey(rule.ruleId), '{"armed":true,"lastValue":1,"epoch":0}')
    await deleteRule(OWNER, rule.ruleId)
    expect(getNotificationState(armStateKey(rule.ruleId))).toBeNull()
    const tombstone = insertedRows(client, 'user_notification_state').at(-1)
    expect(tombstone).toMatchObject({ key: armStateKey(rule.ruleId), deleted: 1 })
  })
})

// The inbox is the only table read on demand rather than held in memory, so it
// needs a client that distinguishes the page query from the totals query.
function inboxClient(rows: Record<string, unknown>[]) {
  const inserts: { table: string; values: Record<string, unknown>[] }[] = []
  const live = [...rows]
  // Soft-deleted rows stay in the table (that IS the delete), so only the
  // queries carrying `deleted = 0` hide them — same rule as fakeClient.
  const visible = () => live.filter(r => Number(r.deleted ?? 0) !== 1)
  return {
    inserts,
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        const rows = query.includes('deleted = 0') ? visible() : live
        if (query.includes('count()')) {
          return [{ total: rows.length, unread: rows.filter(r => Number(r.read) !== 1).length }]
        }
        if (query.includes('read = 0')) return rows.filter(r => Number(r.read) !== 1)
        return rows
      },
    }),
    insert: async ({ table, values }: { table: string; values: Record<string, unknown>[] }) => {
      inserts.push({ table, values })
      for (const v of values) {
        const i = live.findIndex(r => r.notification_id === v.notification_id)
        if (i >= 0) live[i] = v; else live.push(v)
      }
    },
    close: async () => {},
  } as unknown as FakeClient
}

describe('inbox', () => {
  const row = (id: string, read = 0) => ({
    notification_id: id, account_id: OWNER, rule_id: 'r1', kind: 'safety',
    title: `t-${id}`, body: 'b', url: '/security', block_height: 100, read, created_at: '2026-08-18 10:00:00',
  })

  it('reads an account-filtered page with totals', async () => {
    initNotifications(inboxClient([row('a'), row('b', 1)]))
    await loadNotifications()
    const page = await queryInbox(OWNER, 50, 0)
    expect(page.total).toBe(2)
    expect(page.unread).toBe(1)
    expect(page.rows.map(r => r.notificationId)).toEqual(['a', 'b'])
    expect(page.rows[0]).toMatchObject({ title: 't-a', kind: 'safety', blockHeight: 100, read: false })
    expect(await unreadCount(OWNER)).toBe(1)
  })

  it('marks rows read by re-inserting the WHOLE row, preserving created_at', async () => {
    const client = inboxClient([row('a'), row('b')])
    initNotifications(client)
    await loadNotifications()
    expect(await markInboxRead(OWNER, ['a'])).toBe(1)
    const [insert] = client.inserts
    expect(insert.values).toHaveLength(1)
    expect(insert.values[0]).toMatchObject({ notification_id: 'a', read: 1, title: 't-a', body: 'b', created_at: '2026-08-18 10:00:00' })
    // Already-read rows are not re-marked.
    expect(await markInboxRead(OWNER, ['a'])).toBe(0)
    expect(await markInboxRead(OWNER)).toBe(1)
  })

  it('never marks another account\'s rows even if the source over-returns', async () => {
    initNotifications(inboxClient([{ ...row('a'), account_id: OTHER }]))
    await loadNotifications()
    expect(await markInboxRead(OWNER)).toBe(0)
  })

  it('writes created_at explicitly so a later mark-read cannot reset it', async () => {
    const client = inboxClient([])
    initNotifications(client)
    await loadNotifications()
    await insertInboxRows([{
      notificationId: 'x', accountId: OWNER, ruleId: 'r', kind: 'price',
      title: 'T', body: 'B', url: '/asset/5', blockHeight: 0, createdAtMs: Date.UTC(2026, 7, 18, 12, 0, 0),
    }])
    expect(client.inserts[0].values[0]).toMatchObject({ notification_id: 'x', read: 0, deleted: 0, created_at: '2026-08-18 12:00:00' })
  })

  it('writes a whole batch of rows in one insert', async () => {
    const client = inboxClient([])
    initNotifications(client)
    await loadNotifications()
    await insertInboxRows(['a', 'b', 'c'].map(id => ({
      notificationId: id, accountId: OWNER, ruleId: 'r', kind: 'event',
      title: id, body: '', url: '/event/1-e1', blockHeight: 1,
    })))
    expect(client.inserts).toHaveLength(1)
    expect(client.inserts[0].values).toHaveLength(3)
    // An empty batch is not a round trip.
    await insertInboxRows([])
    expect(client.inserts).toHaveLength(1)
  })

  // "Clear inbox" is one write however long the history is: an inbox is bounded
  // only by the 180-day TTL, so a per-row round trip would scale the request with
  // how long the account has been subscribed.
  it('clears the whole inbox in ONE insert of soft-deleted replacements', async () => {
    const client = inboxClient([row('a'), row('b', 1), row('c')])
    initNotifications(client)
    await loadNotifications()

    expect(await clearInbox(OWNER)).toBe(3)
    expect(client.inserts).toHaveLength(1)
    expect(client.inserts[0].values).toHaveLength(3)
    // Whole rows, because ReplacingMergeTree keeps the newest row entire: a
    // partial replacement would blank the content it replaces, and the row is
    // what the dedup seed reads at the next boot.
    expect(client.inserts[0].values[0]).toMatchObject({
      notification_id: 'a', account_id: OWNER, rule_id: 'r1', kind: 'safety',
      title: 't-a', body: 'b', url: '/security', block_height: 100, read: 0,
      deleted: 1, created_at: '2026-08-18 10:00:00',
    })
    // The read flag rides along as it stood, so nothing is silently un-read.
    expect(client.inserts[0].values[1]).toMatchObject({ notification_id: 'b', read: 1, deleted: 1 })

    // The page and both counters are empty afterwards, and a second clear is
    // not a round trip.
    const page = await queryInbox(OWNER, 50, 0)
    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
    expect(await unreadCount(OWNER)).toBe(0)
    expect(await clearInbox(OWNER)).toBe(0)
    expect(client.inserts).toHaveLength(1)
  })

  it('clears nothing for an empty inbox', async () => {
    const client = inboxClient([])
    initNotifications(client)
    await loadNotifications()
    expect(await clearInbox(OWNER)).toBe(0)
    expect(client.inserts).toHaveLength(0)
  })

  it('never clears another account\'s rows even if the source over-returns', async () => {
    const client = inboxClient([{ ...row('a'), account_id: OTHER }])
    initNotifications(client)
    await loadNotifications()
    expect(await clearInbox(OWNER)).toBe(0)
    expect(client.inserts).toHaveLength(0)
  })

  // The invariant that makes clearing safe: emptying the history forgets what was
  // SHOWN, never what was SENT. The dedup seed therefore reads soft-deleted rows.
  it('keeps a cleared notification in the dedup seed after a reload', async () => {
    const client = inboxClient([row('a')])
    initNotifications(client)
    await loadNotifications()
    expect(hasNotification('a')).toBe(true)
    await clearInbox(OWNER)
    // The in-memory set is untouched by the clear, and the reload below is what
    // proves the durable half.
    expect(hasNotification('a')).toBe(true)

    const restarted = fakeClient({ user_notification_inbox: insertedRows(client, 'user_notification_inbox') })
    initNotifications(restarted)
    await loadNotifications()
    expect(hasNotification('a')).toBe(true)
  })
})
