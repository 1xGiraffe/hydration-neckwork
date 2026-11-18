import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cursorKey, evaluatorCursors, initEvaluator, renderMatch, resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator, type RuleMatch,
} from '../src/notifications/evaluator.ts'
import {
  UNVOTED_MAX_AGE_MS, evaluateUnlockable, evaluateUnvoted, govAccountKey, leadBlocksFor, parseFloor, renderGovMatch,
  setGovernanceSourceForTests, unvotedCandidates, unvotedOnset, unvotedStretch, type GovBounds, type GovSource,
} from '../src/notifications/governanceLane.ts'
import {
  armStateKey, createRule, deleteRule, getNotificationState, initNotifications, loadNotifications, updateRule, type NotificationRule,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { KIND_LABELS, NOTIFICATION_KINDS, describeRule, parseRuleParams } from '../src/notifications/notificationRules.ts'
import { renderNotification, text } from '../src/notifications/render.ts'
import { initExplorerService, type AccountRef } from '../src/services/explorerService.ts'
import { displayDescriptor } from '../src/services/explorerAssets.ts'
import type { LiveDeadline, UnlockSteps } from '../src/services/governanceRead.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// The governance kinds fire on a block the governance state names in advance — the
// onset of a referendum's "ending within the lead" stretch, a lock tranche's unlock
// block — once the live head passes it after the kind's cursor, never for one
// already passed when the cursor seeded or the rule was created, and never twice.

initExplorerService(fakeClient())

const OWNER = '0x' + 'aa'.repeat(32)
const WATCHED = '0x' + '11'.repeat(20)
const OTHER = '0x' + '22'.repeat(20)
const HEAD = 1_000_000
const MS_PER_BLOCK = 2_000
// One hour at 2 s blocks.
const LEAD_1H = 1_800
// The registry's HDX symbol (the bare-registry fallback in a test process).
const HDX = displayDescriptor(0).symbol

const ref = (accountId: string): AccountRef => ({ accountId, address: accountId, emoji: '🦊', tag: null, profile: null })

let n = 0
function rule(kind: 'gov-unvoted' | 'gov-unlockable', params: Record<string, unknown>, over: Partial<NotificationRule> = {}): NotificationRule {
  const parsed = parseRuleParams(kind, params)
  if (!parsed.ok) throw new Error(parsed.error)
  return { ruleId: `r${++n}`, accountId: OWNER, kind, name: '', params: parsed.params, channels: [], muted: false, cooldownS: 0, ...over }
}

const deciding = (index: number, block: number, since = HEAD - 50_000): LiveDeadline =>
  ({ index, kind: 'decision-end', block, since, decision: null })

describe('governance kinds in the registry', () => {
  it('registers both kinds with an address and a bounded lead', () => {
    expect(NOTIFICATION_KINDS).toContain('gov-unvoted')
    expect(NOTIFICATION_KINDS).toContain('gov-unlockable')
    expect(KIND_LABELS['gov-unvoted']).toBe('Vote reminder')
    expect(KIND_LABELS['gov-unlockable']).toBe('Unlockable HDX')
    // The default lead is explicit, so a bell posting no lead and a stored rule are one subscription.
    expect(parseRuleParams('gov-unvoted', { address: WATCHED })).toEqual({ ok: true, params: { address: WATCHED, leadHours: 24 } })
    expect(parseRuleParams('gov-unvoted', { address: WATCHED, leadHours: 1 }).ok).toBe(true)
    expect(parseRuleParams('gov-unvoted', { address: WATCHED, leadHours: 168 }).ok).toBe(true)
    expect(parseRuleParams('gov-unvoted', { address: WATCHED, leadHours: 0 }).ok).toBe(false)
    expect(parseRuleParams('gov-unvoted', { address: WATCHED, leadHours: 169 }).ok).toBe(false)
    expect(parseRuleParams('gov-unvoted', { address: WATCHED, leadHours: 1.5 }).ok).toBe(false)
    expect(parseRuleParams('gov-unvoted', {}).ok).toBe(false)
    expect(parseRuleParams('gov-unvoted', { address: 'not-an-address' }).ok).toBe(false)
    // One account, never a tag: a tag would fan one rule out over every member.
    expect(parseRuleParams('gov-unvoted', { target: { kind: 'tag', tagId: 'treasury' } }).ok).toBe(false)
    expect(parseRuleParams('gov-unlockable', { address: WATCHED })).toEqual({ ok: true, params: { address: WATCHED } })
    expect(parseRuleParams('gov-unlockable', { address: WATCHED, leadHours: 24 }).ok).toBe(false)
    expect(parseRuleParams('gov-unlockable', {}).ok).toBe(false)
  })

  it('describes what is watched; the account is the pill beside it', () => {
    expect(describeRule('gov-unvoted', { address: WATCHED, leadHours: 48 })).toBe('referenda without a vote, 48h before they end')
    expect(describeRule('gov-unlockable', { address: WATCHED })).toBe('conviction-locked HDX becoming unlockable')
  })
})

describe('unvotedStretch', () => {
  it('names the deadline kind and the block it began to apply, which is the reminder identity', () => {
    expect(unvotedStretch(deciding(1, HEAD + 5_000, HEAD - 7), LEAD_1H)).toEqual({ kind: 'decision', start: HEAD - 7, onset: HEAD + 5_000 - LEAD_1H })
    const confirming: LiveDeadline = { index: 1, kind: 'confirm-end', block: HEAD + 600, since: HEAD, decision: { block: HEAD + 90_000, since: HEAD - 10_000 } }
    expect(unvotedStretch(confirming, LEAD_1H)).toEqual({ kind: 'confirm', start: HEAD, onset: HEAD })
    const continuing: LiveDeadline = { ...confirming, decision: { block: HEAD + 1_500, since: HEAD - 90_000 } }
    expect(unvotedStretch(continuing, LEAD_1H)).toEqual({ kind: 'decision', start: HEAD - 90_000, onset: HEAD + 1_500 - LEAD_1H })
  })
})

describe('unvotedOnset', () => {
  it('is the crossing of deadline − lead when the deadline was already further away', () => {
    expect(unvotedOnset(deciding(1, HEAD + 5_000), LEAD_1H)).toBe(HEAD + 5_000 - LEAD_1H)
  })

  it('is the start of the phase when the deadline appeared already inside the lead', () => {
    // A confirmation period shorter than the lead: ending soon from ConfirmStarted on.
    const d: LiveDeadline = { index: 1, kind: 'confirm-end', block: HEAD + 600, since: HEAD, decision: { block: HEAD + 90_000, since: HEAD - 10_000 } }
    expect(unvotedOnset(d, LEAD_1H)).toBe(HEAD)
  })

  it('keeps the stretch that began on the decision end when confirmation continues it', () => {
    // The decision end came within the lead at HEAD − 300; confirmation began at HEAD
    // with its own end inside the lead too, so the referendum never stopped ending soon.
    const d: LiveDeadline = { index: 1, kind: 'confirm-end', block: HEAD + 600, since: HEAD, decision: { block: HEAD + 1_500, since: HEAD - 90_000 } }
    expect(unvotedOnset(d, LEAD_1H)).toBe(HEAD + 1_500 - LEAD_1H)
  })

  it('dates the lead through the governance clock, not a constant', () => {
    expect(leadBlocksFor(1, 2_000)).toBe(1_800)
    expect(leadBlocksFor(24, 2_160)).toBe(40_000)
  })
})

describe('unvoted reminders (pure)', () => {
  const r = rule('gov-unvoted', { address: WATCHED, leadHours: 1 })
  const onsetAt = HEAD + 10
  const d = deciding(42, onsetAt + LEAD_1H)
  const bounds = (lower: number, upper: number) => (): GovBounds => ({ lower, upper })
  const needs = new Map([[govAccountKey(r), new Set([42])]])
  const ctx = { head: HEAD + 12, msPerBlock: MS_PER_BLOCK, title: () => 'Fund the docs', account: ref }

  it('fires when the onset lies in (lower, upper] — not before, not above the head', () => {
    expect(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, HEAD + 9))).toEqual([])
    expect(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, HEAD + 10)).map(c => c.stretch.onset)).toEqual([onsetAt])
    // At or below the lower bound (the rule's floor) it is history.
    expect(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD + 10, HEAD + 20))).toEqual([])
    // Inside the stretch it stays a candidate (the identity keeps it single) until the deadline.
    expect(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, d.block - 1))).toHaveLength(1)
    expect(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, d.block))).toEqual([])
  })

  it('is silent for an account that voted (or delegated) on it', () => {
    const candidates = unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, HEAD + 12))
    expect(evaluateUnvoted(candidates, needs, ctx)).toHaveLength(1)
    expect(evaluateUnvoted(candidates, new Map([[govAccountKey(r), new Set([7])]]), ctx)).toEqual([])
    // An address that names no account needs nothing.
    expect(evaluateUnvoted(candidates, new Map([[govAccountKey(r), null]]), ctx)).toEqual([])
  })

  it('keeps one identity per (rule, account, referendum, stretch) across re-evaluations', () => {
    const a = evaluateUnvoted(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, HEAD + 12)), needs, ctx)
    const b = evaluateUnvoted(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD - 150, HEAD + 40)), needs, { ...ctx, head: HEAD + 40 })
    expect(a[0].identity).toBe(b[0].identity)
    expect(a[0].identity).toBe(`unvoted:42:${govAccountKey(r)}:decision:${HEAD - 50_000}`)
    expect(a[0].blockHeight).toBe(onsetAt)
  })

  it('carries a hostile title as one clipped line of plain text', () => {
    const hostile = { ...ctx, title: () => '<b>Treasury</b>\nYour funds were moved\u0007 ' + 'x'.repeat(200) }
    const [m] = evaluateUnvoted(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, HEAD + 12)), needs, hostile)
    const rendered = renderNotification(renderGovMatch(m.payload, a => text(a.address)))
    expect(rendered.body.split('\n')).toHaveLength(3)
    expect(rendered.body.split('\n')[0]).toMatch(/^“<b>Treasury<\/b> Your funds were moved x+…”$/)
    expect(rendered.body).not.toContain('\u0007')
    expect(rendered.telegramHtml).toContain('&lt;b&gt;Treasury&lt;/b&gt;')
    expect(rendered.telegramHtml).not.toContain('<b>Treasury')
  })

  it('renders the referendum, the account, the deadline and the time left', () => {
    const [m] = evaluateUnvoted(unvotedCandidates([d], [r], MS_PER_BLOCK, bounds(HEAD, HEAD + 12)), needs, ctx)
    const rendered = renderNotification(renderGovMatch(m.payload, a => text(a.address)))
    expect(rendered.title).toBe('Referendum #42 ends in 60 min — no vote yet')
    expect(rendered.body).toBe(`“Fund the docs”\n${govAccountKey(r)} has not voted on it\nIts decision period ends at block #1,001,810`)
    expect(rendered.path).toBe('/referendum/opengov/42')
  })
})

describe('unlockable HDX (pure)', () => {
  const r = rule('gov-unlockable', { address: WATCHED })
  const UNIT = 10n ** 12n
  const schedule: UnlockSteps[] = [{
    accountId: govAccountKey(r), freeableAt: 0n,
    steps: [{ block: HEAD + 20, freeable: 1_500n * UNIT }, { block: HEAD + 90, freeable: 2_000_000n * UNIT }],
  }]
  const at = (lower: number, upper: number) => evaluateUnlockable(schedule, [r], () => ({ lower, upper }), ref)

  it('fires at the unlock block, not before, once per tranche', () => {
    expect(at(HEAD, HEAD + 19)).toEqual([])
    const [m] = at(HEAD, HEAD + 20)
    expect(m.identity).toBe(`unlock:${govAccountKey(r)}:${HEAD + 20}`)
    expect(m.blockHeight).toBe(HEAD + 20)
    // Re-evaluating an overlapping window yields the same identity, so the inbox collapses it.
    expect(at(HEAD + 5, HEAD + 30).map(x => x.identity)).toEqual([m.identity])
    // A step at or below the lower bound never fires.
    expect(at(HEAD + 20, HEAD + 30)).toEqual([])
  })

  it('says what the step adds and what is unlockable in total', () => {
    const [, second] = at(HEAD, HEAD + 100)
    const rendered = renderNotification(renderGovMatch(second.payload, a => text(a.address)))
    expect(rendered.title).toBe(`2M ${HDX} now unlockable`)
    expect(rendered.body).toContain(`conviction-voting lock released at block #${(HEAD + 90).toLocaleString('en-US')}`)
    expect(rendered.body).toContain(`Unlockable in total: 2M ${HDX}`)
    expect(rendered.path).toBe(`/account/${encodeURIComponent(govAccountKey(r))}?view=governance`)
  })
})

describe('per-rule floors', () => {
  it('parses only its own encoding', () => {
    expect(parseFloor('1000:0123456789abcdef')).toEqual({ floor: 1000, key: '0123456789abcdef' })
    expect(parseFloor('{"armed":true}')).toBeNull()
    expect(parseFloor(null)).toBeNull()
  })
})

/* ============ through the evaluator ============ */

describe('governance lanes through the evaluator', () => {
  let client: FakeClient
  let tables: { raw_ingestion_state: { head: number }[] }
  let deadlines: LiveDeadline[]
  let unvoted: Set<number>
  let steps: { block: number; freeable: bigint }[]
  let ready: boolean
  let msPerBlock: number

  const source: GovSource = {
    ready: () => ready,
    deadlines: async () => ({ msPerBlock, deadlines }),
    needsVote: async address => (address === WATCHED || address === OTHER ? new Set(unvoted) : null),
    // The Governance tab's schedule computed at `atBlock`: only later steps, and
    // what the earlier ones already freed.
    unlockSteps: async (address, atBlock) => [{
      accountId: address,
      freeableAt: steps.filter(s => s.block <= atBlock).reduce((m, s) => (s.freeable > m ? s.freeable : m), 0n),
      steps: steps.filter(s => s.block > atBlock),
    }],
    title: () => null,
    account: ref,
  }

  const inbox = () => insertedRows(client, 'user_notification_inbox')
  const tick = async (head: number, sourceHead?: number) => {
    tables.raw_ingestion_state[0].head = head
    client.sourceHead = sourceHead
    await runEvaluatorTick()
  }

  beforeEach(async () => {
    resetEvaluatorForTests()
    resetDeliveryStateForTests()
    tables = { raw_ingestion_state: [{ head: HEAD }] }
    client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
    setGovernanceSourceForTests(source)
    deadlines = []
    unvoted = new Set()
    steps = []
    ready = true
    msPerBlock = MS_PER_BLOCK
  })

  afterEach(async () => { await stopNotificationEvaluator() })

  it('fires once when the onset crosses the head after the cursor, and never again', async () => {
    deadlines = [deciding(42, HEAD + 10 + LEAD_1H)]
    unvoted = new Set([42])
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD) // seeds the cursor
    expect(getNotificationState(cursorKey('gov-unvoted'))).toBe(String(HEAD))
    await tick(HEAD + 5) // first sight of the rule: its floor
    expect(inbox()).toHaveLength(0)
    await tick(HEAD + 12)
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toBe('Referendum #42 ends in 60 min — no vote yet')
    expect(inbox()[0].url).toBe('/referendum/opengov/42')
    // The re-check window still covers the onset; the identity keeps it single.
    await tick(HEAD + 20)
    await tick(HEAD + 40)
    expect(inbox()).toHaveLength(1)
  })

  it('still reminds once when a pace change moves the onset back past the cursor', async () => {
    // A day's lead is 43,200 blocks at 2 s; at 1.9 s it is 45,474, so the onset moves
    // from HEAD + 3,000 back to HEAD + 726 — behind a cursor at HEAD + 1,000 by more
    // than any trailing re-check.
    deadlines = [deciding(42, HEAD + 3_000 + 43_200)]
    unvoted = new Set([42])
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 24 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    await tick(HEAD + 500)
    await tick(HEAD + 1_000)
    expect(inbox()).toHaveLength(0)
    msPerBlock = 1_900
    await tick(HEAD + 1_003)
    expect(inbox()).toHaveLength(1)
    // Back to the old pace and on: the same stretch, so the same identity.
    msPerBlock = MS_PER_BLOCK
    await tick(HEAD + 3_100)
    await tick(HEAD + 3_200)
    expect(inbox()).toHaveLength(1)
  })

  it('reminds again on the decision end after an aborted confirmation, once per stretch', async () => {
    unvoted = new Set([42])
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    // A confirmation shorter than the lead begins at HEAD + 20: ending soon from then on.
    deadlines = [{ index: 42, kind: 'confirm-end', block: HEAD + 620, since: HEAD + 20, decision: { block: HEAD + 90_000, since: HEAD - 10_000 } }]
    await tick(HEAD + 25)
    expect(inbox()).toHaveLength(1)
    // It aborts; the decision end is far, so nothing until it comes within the lead.
    deadlines = [deciding(42, HEAD + 90_000, HEAD - 10_000)]
    await tick(HEAD + 400)
    expect(inbox()).toHaveLength(1)
    await tick(HEAD + 90_000 - LEAD_1H + 2)
    await tick(HEAD + 90_000 - LEAD_1H + 50)
    expect(inbox()).toHaveLength(2)
  })

  it('does not repeat when a confirmation continues a stretch that began on the decision end', async () => {
    unvoted = new Set([42])
    deadlines = [deciding(42, HEAD + 10 + LEAD_1H)]
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    await tick(HEAD + 12)
    expect(inbox()).toHaveLength(1)
    deadlines = [{ index: 42, kind: 'confirm-end', block: HEAD + 630, since: HEAD + 30, decision: { block: HEAD + 10 + LEAD_1H, since: HEAD - 50_000 } }]
    await tick(HEAD + 40)
    deadlines = [deciding(42, HEAD + 10 + LEAD_1H)]
    await tick(HEAD + 60)
    expect(inbox()).toHaveLength(1)
  })

  it('never reminds of a stretch older than the dedup memory allows', () => {
    expect(UNVOTED_MAX_AGE_MS).toBeLessThan(7 * 86_400_000)
    expect(UNVOTED_MAX_AGE_MS).toBeGreaterThan(5 * 86_400_000)
  })

  it('stays silent for a referendum already inside the lead when the cursor seeded', async () => {
    deadlines = [deciding(42, HEAD - 100 + LEAD_1H)]
    unvoted = new Set([42])
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    await tick(HEAD + 50)
    expect(inbox()).toHaveLength(0)
  })

  it('stays silent for one already inside the lead when the rule was created on a running lane', async () => {
    unvoted = new Set([42, 43])
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: OTHER, leadHours: 1 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    // A second rule arrives after referendum 42's onset (HEAD + 8) but inside the
    // lane's trailing re-check: its floor keeps 42 silent for it.
    deadlines = [deciding(42, HEAD + 8 + LEAD_1H), deciding(43, HEAD + 30 + LEAD_1H)]
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD + 10)
    await tick(HEAD + 40)
    const fired = inbox().map(r => String(r.title))
    // The running rule (OTHER) gets both; the new one (WATCHED) only 43.
    expect(fired.filter(t => t.startsWith('Referendum #42'))).toHaveLength(1)
    expect(fired.filter(t => t.startsWith('Referendum #43'))).toHaveLength(2)
  })

  it('is silent once the account has voted', async () => {
    deadlines = [deciding(42, HEAD + 10 + LEAD_1H)]
    unvoted = new Set()
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    await tick(HEAD + 12)
    expect(inbox()).toHaveLength(0)
  })

  it('never fires above the every-block watermark, and catches up once it passes', async () => {
    deadlines = [deciding(42, HEAD + 10 + LEAD_1H)]
    unvoted = new Set([42])
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    await tick(HEAD + 12, HEAD + 9)
    expect(inbox()).toHaveLength(0)
    await tick(HEAD + 13, HEAD + 13)
    expect(inbox()).toHaveLength(1)
  })

  it('holds the lane while the conviction snapshot has not loaded', async () => {
    deadlines = [deciding(42, HEAD + 10 + LEAD_1H)]
    unvoted = new Set([42])
    await createRule(OWNER, { kind: 'gov-unvoted', params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD)
    ready = false
    await tick(HEAD + 12)
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCursors()['gov-unvoted']).toBe(HEAD)
  })

  it('re-floors a rule whose watched account changed, and forgets the floor with the rule', async () => {
    unvoted = new Set([42])
    const created = await createRule(OWNER, { kind: 'gov-unvoted', params: { address: OTHER, leadHours: 1 } })
    await tick(HEAD)
    await tick(HEAD + 5)
    expect(parseFloor(getNotificationState(armStateKey(created.ruleId)))?.floor).toBe(HEAD + 5)
    deadlines = [deciding(42, HEAD + 8 + LEAD_1H)]
    await updateRule(OWNER, created.ruleId, { params: { address: WATCHED, leadHours: 1 } })
    await tick(HEAD + 10)
    expect(parseFloor(getNotificationState(armStateKey(created.ruleId)))?.floor).toBe(HEAD + 10)
    expect(inbox()).toHaveLength(0)
    await deleteRule(OWNER, created.ruleId)
    expect(getNotificationState(armStateKey(created.ruleId))).toBeNull()
  })

  it('fires an unlock at its block, not before, once per tranche, never for one passed before the seed', async () => {
    const UNIT = 10n ** 12n
    steps = [{ block: HEAD - 10, freeable: 100n * UNIT }, { block: HEAD + 20, freeable: 600n * UNIT }]
    await createRule(OWNER, { kind: 'gov-unlockable', params: { address: WATCHED } })
    await tick(HEAD)
    await tick(HEAD + 5)
    await tick(HEAD + 19)
    expect(inbox()).toHaveLength(0)
    await tick(HEAD + 20)
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toBe(`500 ${HDX} now unlockable`)
    expect(String(inbox()[0].body)).toContain(`Unlockable in total: 600 ${HDX}`)
    await tick(HEAD + 25)
    await tick(HEAD + 60)
    expect(inbox()).toHaveLength(1)
    expect(evaluatorCursors()['gov-unlockable']).toBe(HEAD + 60)
  })

  it('renders through the evaluator with the recipient-aware account notation', async () => {
    const match: RuleMatch = {
      ruleId: 'r', accountId: OWNER, kind: 'gov-unlockable', identity: 'unlock:x:1', blockHeight: 1,
      payload: { lane: 'gov-unlockable', account: ref(WATCHED), block: 1, amount: String(10n ** 12n), total: String(10n ** 12n) },
    }
    const rendered = renderNotification(renderMatch(match, rule('gov-unlockable', { address: WATCHED }), () => ({ name: 'My cold wallet' })))
    expect(rendered.title).toBe(`1 ${HDX} now unlockable`)
    expect(rendered.body).toContain('My cold wallet')
    expect(rendered.body).not.toContain('Unlockable in total')
  })
})
