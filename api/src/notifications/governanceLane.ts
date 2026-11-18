import { createHash } from 'node:crypto'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { convictionSnapshotReady } from '../services/convictionState.ts'
import { accountRef, type AccountRef } from '../services/explorerService.ts'
import { assetDescriptor, displayDescriptor } from '../services/explorerAssets.ts'
import {
  accountUnlockSteps, getNeedsVote, liveReferendumDeadlines, type LiveDeadline, type UnlockSteps,
} from '../services/governanceRead.ts'
import { tokenAmount } from '../services/moneyMarketCaps.ts'
import { isGenericReferendumTitle, referendumTitleFor } from '../services/referendumTitleService.ts'
import { clip } from './forumLane.ts'
import type { NotificationKind, RuleParams } from './notificationRules.ts'
import {
  RECENT_NOTIFICATION_TTL_MS, armStateKey, canonicalParams, getNotificationState, setNotificationStates, type NotificationRule,
} from './notificationStore.ts'
import { amount as amountPart, humanDuration, text as textPart, type RenderInput, type RenderPart } from './render.ts'

// The governance kinds: `gov-unvoted` ("a live referendum you have not voted on is
// ending soon") and `gov-unlockable` ("conviction-locked HDX of yours became
// unlockable"). Both are row-lane kinds of the evaluator with their own block
// cursors, `cursor:gov-unvoted` and `cursor:gov-unlockable`, anchored on the live
// head like every chain lane — this module holds their pure matching and their reads.
//
// Neither has an indexed row to match; each fires on a block the governance state
// names in advance, and the two are anchored differently because only one of those
// blocks is exact.
//
// An UNLOCK step's block is exact (a lock's end, in blocks), so `gov-unlockable` is
// window-anchored: it fires when the live head passes the step inside the kind's
// window `(cursor, head]`, re-reading TRAILING_RECHECK_BLOCKS below the cursor (the
// sources are the shared governance snapshots — the referendum directory and the
// conviction state — each cached a block or so on a key without the head, so a
// change seen a tick late is delivered late rather than stepped over). Identity:
// (rule, account, unlock block).
//
// A REMINDER's onset is not exact: it is `deadline − lead`, and the lead (up to a
// week) becomes blocks at the governance clock's MEASURED pace, which moves hourly —
// a 1% change shifts a week's lead by ~3,000 blocks, far past any re-check, and can
// move an onset backwards over the cursor. So `gov-unvoted` is a level over the
// referendum's CURRENT "ending within the lead" stretch rather than a crossing: it
// fires while the head is inside the stretch (onset ≤ head < deadline), once per
// stretch — the identity names the deadline kind and the block that deadline began to
// apply (`unvoted:<ref>:<account>:decision|confirm:<start>`), so a pace change re-dates
// the onset without changing the identity, and a confirmation that aborts back to the
// decision end is a new stretch with its own reminder. It never fires for a stretch
// whose onset is at or below the rule's floor (already inside the lead when the rule
// was created), nor for one whose onset is older than the dedup memory less a day
// (UNVOTED_MAX_AGE_MS), so a stretch can never outlive the memory of its reminder and
// fire twice.
//
// Common to both:
//   * never above the live head the lane anchors on, nor above the every-block
//     `raw_events` watermark (`upper`), so a message never names a block the explorer
//     cannot show yet; a lane with no cursor seeds at the head and evaluates nothing;
//   * never at or below the RULE's own floor — the head at which the lane first saw
//     the rule (or its changed parameters), persisted per rule — so a referendum
//     already inside the lead when the rule was created, or a step its new account
//     had already passed, is silent however far a window reaches back. Every floor is
//     at or above the head the lane seeded at, so a backfill (which writes below the
//     cursor) can fire neither.
//
// Both read only snapshots and ClickHouse-backed caches (needs-vote, the conviction
// state, the account Governance tab's lock plan) — never the chain. The evaluator
// groups rules by watched account and visits a bounded number of accounts per tick
// (its `visitGroups` rotation), and the cursor waits for every account to be read.

export const GOV_KINDS = ['gov-unvoted', 'gov-unlockable'] as const satisfies readonly NotificationKind[]
export type GovKind = typeof GOV_KINDS[number]

export type GovMatchPayload =
  | {
    lane: 'gov-unvoted'
    index: number
    title: string | null
    deadline: LiveDeadline['kind']
    deadlineBlock: number
    /** From the head the lane ran at to the deadline, at the governance clock's pace. */
    remainingMs: number
    account: AccountRef
  }
  | {
    lane: 'gov-unlockable'
    /** The account whose lock it is (the watched one or a related one). */
    account: AccountRef
    /** The unlock step's block. */
    block: number
    /** Raw HDX units: what this step adds, and what is freeable from it on. */
    amount: string
    total: string
  }

export interface GovMatch {
  ruleId: string
  accountId: string
  kind: GovKind
  identity: string
  blockHeight: number
  payload: GovMatchPayload
}

/** A window's bounds for one rule: fire for blocks in `(lower, upper]`. */
export interface GovBounds {
  /** The rule's own floor, raised to the re-check-widened cursor (an unlock) or the oldest onset a reminder may still have (UNVOTED_MAX_AGE_MS). */
  lower: number
  /** The live head, clamped to the every-block watermark. */
  upper: number
}

/** The canonical account an address-param rule watches — the dedup and grouping key. */
export function govAccountKey(rule: NotificationRule): string {
  const address = (rule.params as { address?: unknown } | null)?.address
  if (typeof address !== 'string') return ''
  return normalizeAddress(address)?.accountId ?? address
}

/* ============ gov-unvoted ============ */

const TITLE_CHARS = 90

export const leadBlocksFor = (leadHours: number, msPerBlock: number): number =>
  Math.round((leadHours * 3_600_000) / msPerBlock)

/**
 * A reminder may fire only for a stretch whose onset is younger than this: the dedup
 * memory (RECENT_NOTIFICATION_TTL_MS) less a day of slack for the onset moving with
 * the clock's pace. A stretch lasts at most the lead (≤ a week), so a reminder can
 * never be re-made after its id has been forgotten.
 */
export const UNVOTED_MAX_AGE_MS = RECENT_NOTIFICATION_TTL_MS - 86_400_000

/**
 * A referendum's current "ending within the lead" stretch: which deadline it is
 * about, the block that deadline began to apply (the stretch's identity), and its
 * onset — the first block at which the deadline was at most `leadBlocks` ahead.
 *
 * Normally the onset is `deadline − lead`. A deadline can also APPEAR already inside
 * the lead (a confirmation period shorter than the lead begins, or a decision period
 * shorter than it starts), and then the stretch begins when the deadline began to
 * apply. A confirmation that began while the decision end was already inside the
 * lead, and whose own end is inside it too, CONTINUES the stretch that began on the
 * decision end — the referendum was "ending soon" throughout — so it keeps that
 * stretch's identity and onset and is not reminded twice. A referendum back to
 * deciding after an aborted confirmation is on its decision stretch again.
 */
export interface UnvotedStretch { kind: 'decision' | 'confirm'; start: number; onset: number }

export function unvotedStretch(d: LiveDeadline, leadBlocks: number): UnvotedStretch {
  const own: UnvotedStretch = {
    kind: d.kind === 'confirm-end' ? 'confirm' : 'decision', start: d.since, onset: Math.max(d.block - leadBlocks, d.since),
  }
  if (d.kind !== 'confirm-end' || !d.decision) return own
  const before = Math.max(d.decision.block - leadBlocks, d.decision.since)
  return before < d.since && own.onset === d.since ? { kind: 'decision', start: d.decision.since, onset: before } : own
}

export const unvotedOnset = (d: LiveDeadline, leadBlocks: number): number => unvotedStretch(d, leadBlocks).onset

export interface UnvotedCandidate { rule: NotificationRule; deadline: LiveDeadline; stretch: UnvotedStretch }

/**
 * The (rule, referendum) pairs whose current stretch the head is inside — onset at or
 * below `upper`, deadline still ahead of it — and whose onset is above the rule's
 * `lower` bound. Pure.
 */
export function unvotedCandidates(
  deadlines: readonly LiveDeadline[], rules: readonly NotificationRule[], msPerBlock: number,
  boundsOf: (rule: NotificationRule) => GovBounds,
): UnvotedCandidate[] {
  const out: UnvotedCandidate[] = []
  if (!(msPerBlock > 0)) return out
  for (const rule of rules) {
    if (rule.kind !== 'gov-unvoted' || rule.muted) continue
    const { leadHours } = rule.params as RuleParams['gov-unvoted']
    const lead = leadBlocksFor(leadHours, msPerBlock)
    const { lower, upper } = boundsOf(rule)
    for (const d of deadlines) {
      const stretch = unvotedStretch(d, lead)
      if (stretch.onset > lower && stretch.onset <= upper && upper < d.block) out.push({ rule, deadline: d, stretch })
    }
  }
  return out
}

/**
 * The reminders a set of candidates makes, given what needs-vote says each watched
 * account still has to vote on (`needs`: account key → referendum indexes, null when
 * the address names no account). A referendum the account voted on — directly, or
 * through a delegation on its track, which needs-vote counts as covered — is silent,
 * and so is one that is no longer live. Pure.
 */
export function evaluateUnvoted(
  candidates: readonly UnvotedCandidate[], needs: ReadonlyMap<string, ReadonlySet<number> | null>,
  ctx: { head: number; msPerBlock: number; title: (index: number) => string | null; account: (key: string) => AccountRef },
): GovMatch[] {
  const out: GovMatch[] = []
  for (const { rule, deadline, stretch } of candidates) {
    const key = govAccountKey(rule)
    if (!needs.get(key)?.has(deadline.index)) continue
    const title = ctx.title(deadline.index)
    out.push({
      ruleId: rule.ruleId, accountId: rule.accountId, kind: 'gov-unvoted',
      identity: `unvoted:${deadline.index}:${key}:${stretch.kind}:${stretch.start}`, blockHeight: stretch.onset,
      payload: {
        lane: 'gov-unvoted', index: deadline.index,
        // Someone else's words: one line of plain text, clipped (the renderer escapes it per surface).
        title: title ? clip(title.replace(/\p{Cc}/gu, ' '), TITLE_CHARS) || null : null,
        deadline: deadline.kind, deadlineBlock: deadline.block,
        remainingMs: Math.max(0, (deadline.block - ctx.head) * ctx.msPerBlock),
        account: ctx.account(key),
      },
    })
  }
  return out
}

/* ============ gov-unlockable ============ */

/**
 * The unlock steps in each rule's bounds. `schedules` is the watched account's (and
 * its related accounts') schedule computed at a block at or below every rule's lower
 * bound, so a step the head has already passed is still listed. A step frees what
 * it adds over the step before it (or over what was freeable before the schedule);
 * `total` is what is freeable from the step on. Pure.
 */
export function evaluateUnlockable(
  schedules: readonly UnlockSteps[], rules: readonly NotificationRule[],
  boundsOf: (rule: NotificationRule) => GovBounds, account: (accountId: string) => AccountRef,
): GovMatch[] {
  const out: GovMatch[] = []
  for (const rule of rules) {
    if (rule.kind !== 'gov-unlockable' || rule.muted) continue
    const { lower, upper } = boundsOf(rule)
    for (const s of schedules) {
      let prev = s.freeableAt
      for (const step of s.steps) {
        const added = step.freeable - prev
        prev = step.freeable
        if (!(step.block > lower && step.block <= upper) || added <= 0n) continue
        out.push({
          ruleId: rule.ruleId, accountId: rule.accountId, kind: 'gov-unlockable',
          identity: `unlock:${s.accountId}:${step.block}`, blockHeight: step.block,
          payload: { lane: 'gov-unlockable', account: account(s.accountId), block: step.block, amount: added.toString(), total: step.freeable.toString() },
        })
      }
    }
  }
  return out
}

/* ============ per-rule floors ============ */

// A rule's floor: the live head at which the lane first evaluated it, stored with a
// digest of its parameters so an edit (a different account or lead) re-floors it.
// Kept under the rule's `arm:` state key, which deleting the rule already removes.
const floors = new Map<string, { floor: number; key: string }>()

export function resetGovernanceLaneForTests(): void { floors.clear(); source = governanceSource }

const paramsDigest = (rule: NotificationRule): string =>
  createHash('sha256').update(canonicalParams(rule.params)).digest('hex').slice(0, 16)

export function parseFloor(raw: string | null): { floor: number; key: string } | null {
  const m = raw ? /^(\d+):([0-9a-f]{16})$/.exec(raw) : null
  return m ? { floor: Number(m[1]), key: m[2] } : null
}

/**
 * Every rule's floor, assigning `head` to a rule seen for the first time (or with
 * changed parameters) and persisting it before the lane matches anything: a floor
 * that existed only in memory would let a restart re-floor the rule higher, which is
 * the silent direction, but the write is what makes the floor survive at all.
 */
export async function ruleFloors(rules: readonly NotificationRule[], head: number): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const fresh: { ruleId: string; floor: number; key: string }[] = []
  for (const rule of rules) {
    const key = paramsDigest(rule)
    let held = floors.get(rule.ruleId) ?? parseFloor(getNotificationState(armStateKey(rule.ruleId)))
    if (held && held.key !== key) held = null
    if (held) { floors.set(rule.ruleId, held); out.set(rule.ruleId, held.floor); continue }
    fresh.push({ ruleId: rule.ruleId, floor: head, key })
  }
  if (fresh.length) {
    await setNotificationStates(fresh.map(f => ({ key: armStateKey(f.ruleId), value: `${f.floor}:${f.key}` })))
    for (const f of fresh) { floors.set(f.ruleId, { floor: f.floor, key: f.key }); out.set(f.ruleId, f.floor) }
  }
  return out
}

/* ============ the lane's reads ============ */

/** Where the lane's facts come from; the tests swap it. */
export interface GovSource {
  /** Whether the conviction-state snapshot has loaded: without it every account would read "not voted". */
  ready(): boolean
  deadlines(): Promise<{ msPerBlock: number; deadlines: LiveDeadline[] }>
  /** needs-vote for one address: the live referenda it has no vote on, null when it names no account. */
  needsVote(address: string): Promise<ReadonlySet<number> | null>
  unlockSteps(address: string, atBlock: number): Promise<UnlockSteps[] | null>
  title(index: number): string | null
  account(accountId: string): AccountRef
}

export const governanceSource: GovSource = {
  ready: convictionSnapshotReady,
  deadlines: liveReferendumDeadlines,
  async needsVote(address) {
    const entry = (await getNeedsVote([address])).accounts[0]
    return entry?.accountId ? new Set(entry.needsVote) : null
  },
  unlockSteps: accountUnlockSteps,
  title(index) {
    const t = referendumTitleFor('opengov', index)
    return t && !isGenericReferendumTitle(t) ? t : null
  },
  account: accountRef,
}

let source: GovSource = governanceSource
/** The source the lane reads: the governance read models, or a test's stand-in. */
export const govSource = (): GovSource => source
export function setGovernanceSourceForTests(s: GovSource | null): void { source = s ?? governanceSource }

/**
 * One watched account's matches for one kind: `rules` all watch the same account
 * (the evaluator's group). `window.from` is the re-check-widened cursor (an unlock's
 * lower bound), `window.upper` the clamped head, `window.head` the live head.
 */
export async function governanceGroupMatches(
  kind: GovKind, rules: readonly NotificationRule[], window: { from: number; upper: number; head: number },
  floorOf: ReadonlyMap<string, number>, deadlines: { msPerBlock: number; deadlines: LiveDeadline[] } | null,
  src: GovSource = source,
): Promise<GovMatch[]> {
  const address = (rules[0]?.params as { address?: string } | undefined)?.address
  if (!address) return []
  const floor = (rule: NotificationRule) => floorOf.get(rule.ruleId) ?? window.head
  if (kind === 'gov-unvoted') {
    if (!deadlines || !(deadlines.msPerBlock > 0)) return []
    const oldest = window.upper - Math.floor(UNVOTED_MAX_AGE_MS / deadlines.msPerBlock)
    const candidates = unvotedCandidates(deadlines.deadlines, rules, deadlines.msPerBlock,
      rule => ({ lower: Math.max(floor(rule), oldest), upper: window.upper }))
    if (!candidates.length) return []
    const needs = new Map([[govAccountKey(rules[0]), await src.needsVote(address)]])
    return evaluateUnvoted(candidates, needs, {
      head: window.head, msPerBlock: deadlines.msPerBlock, title: src.title, account: src.account,
    })
  }
  const boundsOf = (rule: NotificationRule): GovBounds => ({ lower: Math.max(window.from, floor(rule)), upper: window.upper })
  // Computed at the lowest bound any of the group's rules has, so every step a rule
  // could still fire for is listed; each rule then keeps its own bounds.
  const atBlock = Math.min(...rules.map(r => boundsOf(r).lower))
  if (!(atBlock < window.upper)) return []
  const schedules = await src.unlockSteps(address, atBlock)
  return schedules ? evaluateUnlockable(schedules, rules, boundsOf, src.account) : []
}

/* ============ the message ============ */

const HDX = 0

/**
 * The message for a governance match. The account renders through the shared
 * notation (`accountPartFor`, bound by the evaluator to the recipient's own tag
 * names); a referendum title is someone else's words and travels as plain text.
 */
export function renderGovMatch(p: GovMatchPayload, accountPartFor: (ref: AccountRef) => RenderPart): RenderInput {
  if (p.lane === 'gov-unvoted') {
    const what = p.deadline === 'confirm-end' ? 'Its confirmation period ends' : 'Its decision period ends'
    const body: (string | RenderPart[])[] = []
    if (p.title) body.push(`“${p.title}”`)
    body.push([accountPartFor(p.account), textPart('has not voted on it')])
    body.push(`${what} at block #${p.deadlineBlock.toLocaleString('en-US')}`)
    return {
      title: [textPart(`Referendum #${p.index} ends in ${humanDuration(p.remainingMs)} — no vote yet`)],
      body,
      path: `/referendum/opengov/${p.index}`,
    }
  }
  const decimals = assetDescriptor(HDX).decimals
  const symbol = displayDescriptor(HDX).symbol
  const added = tokenAmount(BigInt(p.amount), decimals)
  const total = tokenAmount(BigInt(p.total), decimals)
  const body: (string | RenderPart[])[] = [
    [accountPartFor(p.account), textPart(`· conviction-voting lock released at block #${p.block.toLocaleString('en-US')}`)],
  ]
  if (p.total !== p.amount) body.push([textPart('Unlockable in total:'), amountPart(total, symbol)])
  return {
    title: [amountPart(added, symbol), textPart('now unlockable')],
    body,
    path: `/account/${encodeURIComponent(p.account.address)}?view=governance`,
  }
}
