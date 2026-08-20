import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { assetDescriptor } from '../services/explorerAssets.ts'
import {
  accountRef, activityRowMatchesAction, activityTypeMatchesFamily, ensurePrices,
  getAddressActivity, getListTagActivity, getPrimaryHealthFactor, getRecentActivity, getTagActivity,
  type AccountRef, type ActivityRow,
} from '../services/explorerService.ts'
import { getSecurityDashboard, type SafetyEvent } from '../services/securityService.ts'
import { isGenericReferendumTitle, referendumTitleFor } from '../services/referendumTitleService.ts'
import { tagMapFor } from '../services/userListService.ts'
import { tagForAccount } from '../services/tagService.ts'
import {
  commitNotifications, prepareNotifications, sendOutbound, type DeliverableNotification,
} from './delivery.ts'
import {
  describeRule, KIND_LABELS, REFERENDUM_PHASES, TC_MOTION_PHASES,
  type NotificationKind, type RuleParams,
} from './notificationRules.ts'
import {
  activeRulesByKind, armStateKey, channelsFor, getChannel, getNotificationState, setNotificationState,
  type NotificationChannel, type NotificationRule,
} from './notificationStore.ts'
import { resolveActivityTarget } from './ruleTargets.ts'
import {
  account as accountPart, amount as amountPart, code as codePart, compactAmount, compactUsd,
  renderNotification, shortHash, text as textPart, usd as usdPart,
  type RenderAccount, type RenderInput, type RenderPart, type RenderedNotification,
} from './render.ts'

// The trigger evaluator: one always-on loop that turns each new stretch of the
// chain into notifications.
//
// It is deliberately independent of the SSE-gated live-head service — that one
// stops polling when no browser is watching, and an alert must fire whether or
// not anybody has the explorer open — so this module owns its own interval.
//
// Two lanes:
//   * the ROW lane, every tick, over each kind's own block window
//     `(cursor, head]`: one source read per KIND — or, for the two activity
//     kinds, per watched address/asset — never per rule, with every rule's own
//     filters re-applied to the shared rows by a pure function;
//   * the SNAPSHOT lane, every fifth tick, for the two value triggers (price,
//     health factor) that describe a level rather than an event. They are
//     edge-triggered with a persisted armed flag, so a value parked just past
//     its threshold produces one notification, not one every 30 seconds.
//
// All I/O lives in the loop below; every matching decision is a pure function
// over already-fetched rows, which is what the tests exercise.

/* ============ cursor + window ============ */

// The evaluator's high-water mark, anchored on the LIVE pipeline's head:
//
//   SELECT max(last_block) FROM raw_ingestion_state FINAL WHERE pipeline_id = 'raw-live'
//
// The `pipeline_id` filter is the backfill-immunity gate, not a detail. Backfill
// workers run under their own `raw-backfill-*` ids and walk DOWNWARD, so every
// row they insert lands below this cursor and can never fire a notification —
// and neither can a repair INSERT, an MV rebuild, or a re-derivation.
//
// AGENTS.md calls a forward high-water cursor WRONG for read models, precisely
// because it goes blind to blocks backfilled beneath it. That blind spot is the
// required behavior here: a notification is a statement about something that
// just happened, and re-indexing 2024 must not page anybody. Read models keep
// using partition-diff/atomic-replace; this cursor is the one sanctioned
// exception and must stay pinned to the live pipeline.
//
// The cursor is PER KIND (`cursor:<kind>`), because the kinds do not all read a
// source that tracks the head. A SQL-windowed kind queries `(cursor, head]` and
// advances to the head; the safety kind reads a shared 20s/120s cached dashboard
// snapshot, so its newest row is normally BEHIND the head — a head-anchored
// cursor would step over every safety action ever emitted between two ticks. It
// therefore advances only to the newest block the timeline it saw actually
// contained. Both keep the same blind spot below the cursor, which is what makes
// a backfill silent; a fresh install seeds from the legacy single cursor when one
// is stored, otherwise from the head (or, for safety, its newest timeline row).
const LIVE_PIPELINE_ID = 'raw-live'
const LEGACY_CURSOR_KEY = `cursor:${LIVE_PIPELINE_ID}`
export const cursorKey = (kind: RowLaneKind): string => `cursor:${kind}`

// How far behind the head a single tick may look. A longer gap (a restart, a
// stalled evaluator, a paused api) is skipped rather than replayed: nobody
// wants an hour of alerts at once, and the inbox is not a backlog queue.
const MAX_WINDOW_BLOCKS = 600

const DEFAULT_EVAL_MS = 6_000
const SNAPSHOT_EVERY_TICKS = 5
// Rows fetched per activity source per tick. ~600 blocks of head movement
// between ticks is already the clamp, so one page covers a normal tick many
// times over; a page that turns out to be too small is refetched once.
const ACTIVITY_PAGE = 50
const ACTIVITY_PAGE_WIDE = 250
// Activity source fetches one tick may spend PER KIND. Groups beyond it are
// deferred to a later tick by a persistent rotation, and the kind's cursor does
// NOT advance while any group is deferred — so a deferred group loses nothing
// until the window clamp catches up with it. At 25 fetches per 6s tick the
// rotation covers 250 groups a minute, and the clamp is ~600 blocks (~20
// minutes), so a deployment stays lossless up to a few thousand distinct watched
// addresses. The budget is per kind rather than shared because the row lane
// visits the kinds in a fixed order, and a shared budget the first kind can
// exhaust would starve the second one forever.
const SOURCE_FETCH_CAP = 25
// Bound on a raw window query. The window is at most 600 blocks, so this is
// only ever reached by a rule matching a very common pallet.
const RAW_WINDOW_CAP = 5_000
// Matches listed by name in a coalesced message before it says "and N more".
const COALESCE_LIST = 5
// Inbox rows one rule may write in one tick. The oldest matches keep their own
// detail row and the remainder collapses into a single digest row, so a rule on
// a busy pallet costs a bounded write instead of thousands.
const INBOX_ROWS_PER_RULE = 20
// How often the cursors are persisted while nothing fires. They are
// authoritative in memory; the row exists so a restart does not replay, and a
// tick that delivered something persists at once.
const CURSOR_PERSIST_MS = 60_000
// Re-arm band for the value triggers: the value has to come back 2% past the
// threshold before the rule can fire again, so a level oscillating on the line
// produces one notification rather than a stream.
const HYSTERESIS = 0.02

export interface BlockWindow { from: number; to: number }

// Clamp the window and report what the clamp skipped. `from` is exclusive,
// `to` inclusive.
export function resolveWindow(cursor: number, head: number): { window: BlockWindow; skipped: number } {
  const to = Math.max(cursor, head)
  const from = to - cursor > MAX_WINDOW_BLOCKS ? to - MAX_WINDOW_BLOCKS : cursor
  return { window: { from, to }, skipped: from - cursor }
}

export const inWindow = (blockHeight: number, w: BlockWindow): boolean => blockHeight > w.from && blockHeight <= w.to

// Finality gate: the pending-head layer marks its rows `finalized: false` and
// the transaction pool marks its projections `mempool: true`. Neither is a fact
// yet, and a reorg would make a sent notification unretractable.
export const isFinalRow = (row: { finalized?: boolean; mempool?: boolean }): boolean =>
  row.finalized !== false && row.mempool !== true

// A page that starts above the cursor may have older matches behind it. The
// loop reacts by refetching once with a wider page.
export function pageMissedRows(rows: readonly { blockHeight: number }[], w: BlockWindow, limit: number): boolean {
  if (rows.length < limit) return false
  const oldest = rows.reduce((m, r) => Math.min(m, r.blockHeight), Number.POSITIVE_INFINITY)
  return Number.isFinite(oldest) && oldest > w.from
}

/* ============ matches ============ */

export type ReferendumPhase = typeof REFERENDUM_PHASES[number]

export interface ChainEventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  name: string
}
export interface ChainExtrinsicRow {
  blockHeight: number
  extrinsicIndex: number
  callName: string
  success: boolean
  signer: AccountRef | null
}
export interface ReferendumEventRow {
  blockHeight: number
  eventIndex: number
  index: number
  phase: ReferendumPhase
  /** Track id, when the event carries one (Submitted/DecisionStarted only). */
  track: number | null
}

export type TcMotionPhase = typeof TC_MOTION_PHASES[number]

// One Technical Committee motion event. The proposal hash is the motion's
// identity in every phase — the committee pallet reports no index after
// `Proposed` — and the per-phase fields are exactly what the event carries.
export interface TcMotionEventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  phase: TcMotionPhase
  proposalHash: string
  /** The member who proposed or voted, when the event names one. */
  actor: AccountRef | null
  /** How THIS member voted (voted phase only). */
  aye: boolean | null
  /** The running tally the event reports (voted, closed). */
  yes: number | null
  no: number | null
  /** Ayes needed to pass, on Proposed. */
  threshold: number | null
  /** Whether the dispatched call succeeded, on an executed phase. */
  ok: boolean | null
}

export type MatchPayload =
  | { lane: 'activity'; row: ActivityRow }
  | { lane: 'safety'; event: SafetyEvent }
  | { lane: 'referendum'; row: ReferendumEventRow; title: string | null }
  | { lane: 'tc-motion'; row: TcMotionEventRow }
  | { lane: 'event'; row: ChainEventRow }
  | { lane: 'extrinsic'; row: ChainExtrinsicRow }
  | { lane: 'price'; assetId: number; direction: 'above' | 'below'; threshold: number; value: number }
  | { lane: 'health-factor'; address: string; account: AccountRef | null; threshold: number; value: number }

export interface RuleMatch {
  ruleId: string
  accountId: string
  kind: NotificationKind
  /** Dedup identity WITHIN the rule; hashed with the rule id into the id. */
  identity: string
  blockHeight: number
  payload: MatchPayload
}

// Deterministic notification id. The same match evaluated again — a replay, a
// restart, an overlapping window — produces the same id, which the inbox's
// ReplacingMergeTree key and the recent-id set both collapse.
export function notificationIdFor(ruleId: string, identity: string): string {
  return createHash('sha256').update(`${ruleId}:${identity}`).digest('hex')
}

// Activity rows are identified the way the explorer's own activity URLs are
// (`activityId` in ActivityTable.tsx): the `e` marks an event index, so event 3
// and extrinsic 3 of one block are never the same notification.
export function activityIdentity(row: ActivityRow): string | null {
  if (row.eventIndex != null) return `${row.blockHeight}-e${row.eventIndex}`
  if (row.extrinsicIndex != null) return `${row.blockHeight}-${row.extrinsicIndex}`
  return null
}

// A safety action's identity. `detail` is deliberately excluded: it restates the
// previous state ("… (was Frozen)"), which depends on how much history the
// dashboard had loaded, and an id must not move under a notification.
export const safetyIdentity = (e: SafetyEvent): string =>
  `${e.blockHeight}-${e.extrinsicIndex ?? 'b'}:${e.kind}:${e.asset?.assetId ?? ''}:${e.label}`

/* ============ pure row-lane matchers ============ */

// The activity-type aliases the explorer routes accept (`ACTIVITY_TYPE_ALIASES`
// in routes/explorer.ts): rules speak the API's vocabulary, rows the domain's.
const ACTIVITY_TYPE_ALIASES: Record<string, string> = { stake: 'staking' }
export const activityTypeForFeed = (type?: string): string =>
  (!type || type === 'all' ? 'all' : ACTIVITY_TYPE_ALIASES[type] ?? type)

function matchRows<T>(
  rows: readonly T[],
  rule: NotificationRule,
  window: BlockWindow,
  blockOf: (row: T) => number,
  identityOf: (row: T) => string | null,
  accepts: (row: T) => boolean,
  payloadOf: (row: T) => MatchPayload,
): RuleMatch[] {
  const out: RuleMatch[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!inWindow(blockOf(row), window)) continue
    if (!accepts(row)) continue
    const identity = identityOf(row)
    // ReplacingMergeTree sources can hand back the same row twice after a
    // replay; one match per identity keeps a coalesced message honest.
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    out.push({
      ruleId: rule.ruleId, accountId: rule.accountId, kind: rule.kind,
      identity, blockHeight: blockOf(row), payload: payloadOf(row),
    })
  }
  return out
}

export function evaluateAccountActivity(rows: readonly ActivityRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['account-activity']
    const type = activityTypeForFeed(p.type)
    return matchRows(rows, rule, window, r => r.blockHeight, activityIdentity,
      r => isFinalRow(r)
        && (type === 'all' || activityTypeMatchesFamily(r.type, type))
        && activityRowMatchesAction(r, p.action)
        && (p.minUsd == null || (r.valueUsd != null && r.valueUsd >= p.minUsd)),
      row => ({ lane: 'activity', row }))
  })
}

// The value-floor matcher, shared by the two kinds that differ only in which
// activity feed the loop reads for them (`large-trade` over trades,
// `large-transfer` over transfers). Both carry the same params, and neither has
// anything left to check once the feed has been asked the right question: the
// rows are already of the kind's type, so only the USD floor and the optional
// asset scope remain.
export function evaluateLargeValue(rows: readonly ActivityRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['large-trade']
    return matchRows(rows, rule, window, r => r.blockHeight, activityIdentity,
      r => isFinalRow(r)
        && r.valueUsd != null && r.valueUsd >= p.minUsd
        && (p.assetId == null || activityReferencesAsset(r, p.assetId)),
      row => ({ lane: 'activity', row }))
  })
}

// Every asset a row references, matching the feed's own multi-asset filter
// semantics: nested pool assets and both sides of a pair count.
export function activityReferencesAsset(row: ActivityRow, assetId: number): boolean {
  return row.asset?.assetId === assetId
    || row.assetIn?.assetId === assetId
    || row.assetOut?.assetId === assetId
    || (row.assetRefs?.includes(assetId) ?? false)
}

export function evaluateSafety(events: readonly SafetyEvent[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['safety']
    const kinds = p.kinds?.length ? new Set<string>(p.kinds) : null
    return matchRows(events, rule, window, e => e.blockHeight, safetyIdentity,
      e => !kinds || kinds.has(e.kind),
      event => ({ lane: 'safety', event }))
  })
}

export function evaluateReferendum(
  rows: readonly ReferendumEventRow[],
  rules: readonly NotificationRule[],
  window: BlockWindow,
  titleFor: (index: number) => string | null = () => null,
): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['referendum']
    const phases = p.phases?.length ? new Set<string>(p.phases) : null
    const track = p.track?.trim().toLowerCase()
    return matchRows(rows, rule, window, r => r.blockHeight, r => `${r.index}:${r.phase}`,
      r => (!phases || phases.has(r.phase))
        // A track filter can only reject an event whose track is KNOWN. The
        // chain puts the track on Submitted and DecisionStarted; the loop
        // back-fills the rest from the referendum's own Submitted row, and an
        // index whose submission is not indexed at all keeps matching rather
        // than silently disappearing.
        && (!track || r.track == null || String(r.track) === track),
      row => ({ lane: 'referendum', row, title: titleFor(row.index) }))
  })
}

// A motion's dedup identity is (hash, phase): one Approved is one notification
// however often an overlapping window re-evaluates it. VOTED is the exception —
// every member casts their own vote, so the EVENT is the identity there. Keying it
// on the phase alone would have collapsed a five-member motion into a single
// notification and hidden every member but the first.
export function tcMotionIdentity(row: TcMotionEventRow): string {
  return row.phase === 'voted'
    ? `${row.proposalHash}:voted:${row.blockHeight}-e${row.eventIndex}`
    : `${row.proposalHash}:${row.phase}`
}

export function evaluateTcMotion(rows: readonly TcMotionEventRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['tc-motion']
    const phases = p.phases?.length ? new Set<string>(p.phases) : null
    return matchRows(rows, rule, window, r => r.blockHeight, tcMotionIdentity,
      r => !phases || phases.has(r.phase),
      row => ({ lane: 'tc-motion', row }))
  })
}

// Section/method names are matched case-insensitively — the chain writes
// `Omnipool.SellExecuted` and `Omnipool.sell`, and a rule should not have to
// know which casing a pallet chose.
const nameParts = (name: string): { section: string; method: string } => {
  const dot = name.indexOf('.')
  return dot < 0
    ? { section: name.toLowerCase(), method: '' }
    : { section: name.slice(0, dot).toLowerCase(), method: name.slice(dot + 1).toLowerCase() }
}
export function nameMatches(name: string, section: string, method?: string): boolean {
  const parts = nameParts(name)
  if (parts.section !== section.trim().toLowerCase()) return false
  return !method || parts.method === method.trim().toLowerCase()
}

export function evaluateEvents(rows: readonly ChainEventRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['event']
    return matchRows(rows, rule, window, r => r.blockHeight, r => `${r.blockHeight}-e${r.eventIndex}`,
      r => nameMatches(r.name, p.section, p.method),
      row => ({ lane: 'event', row }))
  })
}

export function evaluateExtrinsics(rows: readonly ChainExtrinsicRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['extrinsic']
    const signer = p.signer ? normalizeAddress(p.signer)?.accountId ?? null : null
    return matchRows(rows, rule, window, r => r.blockHeight, r => `${r.blockHeight}-${r.extrinsicIndex}`,
      r => nameMatches(r.callName, p.section, p.method)
        && (p.success === undefined || r.success === p.success)
        && (!signer || r.signer?.accountId === signer),
      row => ({ lane: 'extrinsic', row }))
  })
}

// The row lane's dispatcher. `rows` is keyed to `kind` by RowLaneRows, so a
// caller cannot hand the safety matcher a page of activity rows.
export interface RowLaneRows {
  'account-activity': readonly ActivityRow[]
  'large-trade': readonly ActivityRow[]
  'large-transfer': readonly ActivityRow[]
  safety: readonly SafetyEvent[]
  referendum: readonly ReferendumEventRow[]
  'tc-motion': readonly TcMotionEventRow[]
  event: readonly ChainEventRow[]
  extrinsic: readonly ChainExtrinsicRow[]
}
export type RowLaneKind = keyof RowLaneRows
export const ROW_LANE_KINDS: RowLaneKind[] = ['account-activity', 'large-trade', 'large-transfer', 'safety', 'referendum', 'tc-motion', 'event', 'extrinsic']

export function evaluateRowKind<K extends RowLaneKind>(
  kind: K, rows: RowLaneRows[K], rules: readonly NotificationRule[], window: BlockWindow,
  titleFor?: (index: number) => string | null,
): RuleMatch[] {
  switch (kind) {
    case 'account-activity': return evaluateAccountActivity(rows as RowLaneRows['account-activity'], rules, window)
    case 'large-trade':
    case 'large-transfer': return evaluateLargeValue(rows as RowLaneRows['large-trade'], rules, window)
    case 'safety': return evaluateSafety(rows as RowLaneRows['safety'], rules, window)
    case 'referendum': return evaluateReferendum(rows as RowLaneRows['referendum'], rules, window, titleFor)
    case 'tc-motion': return evaluateTcMotion(rows as RowLaneRows['tc-motion'], rules, window)
    case 'event': return evaluateEvents(rows as RowLaneRows['event'], rules, window)
    default: return evaluateExtrinsics(rows as RowLaneRows['extrinsic'], rules, window)
  }
}

/* ============ pure snapshot-lane core ============ */

export interface ArmState {
  /** Whether a crossing may fire. Cleared by a fire, set by a re-arm. */
  armed: boolean
  /** The value at the last state change — diagnostics, not a matching input. */
  lastValue: number | null
  /** Increments per fire; the crossing's dedup identity. */
  epoch: number
}
export interface ThresholdInput {
  ruleId: string
  direction: 'above' | 'below'
  threshold: number
  /** null = unavailable (no price, no position, unreadable health factor). */
  value: number | null
}
export interface ThresholdFire extends ThresholdInput { value: number; epoch: number }

const isPast = (d: 'above' | 'below', v: number, t: number) => (d === 'above' ? v >= t : v <= t)
const isRearmed = (d: 'above' | 'below', v: number, t: number) =>
  (d === 'above' ? v < t * (1 - HYSTERESIS) : v > t * (1 + HYSTERESIS))

// Edge-triggered threshold evaluation.
//
// `next` holds ONLY the states that changed, so a value drifting inside its band
// costs no write. An unavailable value changes nothing at all — a dead price
// feed or an unreadable position must never read as zero and liquidate-alert
// somebody who is fine.
export function evaluateThreshold(
  inputs: readonly ThresholdInput[],
  prev: ReadonlyMap<string, ArmState>,
): { fired: ThresholdFire[]; next: Map<string, ArmState> } {
  const fired: ThresholdFire[] = []
  const next = new Map<string, ArmState>()
  for (const input of inputs) {
    const v = input.value
    if (v == null || Number.isNaN(v)) continue
    const cur = prev.get(input.ruleId)
    if (!cur) {
      // First sight only arms. A rule created while its value is already past
      // the threshold waits for a genuine crossing instead of firing at once,
      // which also keeps a fresh deployment from paging every subscriber.
      next.set(input.ruleId, { armed: !isPast(input.direction, v, input.threshold), lastValue: v, epoch: 0 })
      continue
    }
    if (cur.armed && isPast(input.direction, v, input.threshold)) {
      const epoch = cur.epoch + 1
      fired.push({ ...input, value: v, epoch })
      next.set(input.ruleId, { armed: false, lastValue: v, epoch })
    } else if (!cur.armed && isRearmed(input.direction, v, input.threshold)) {
      next.set(input.ruleId, { armed: true, lastValue: v, epoch: cur.epoch })
    }
  }
  return { fired, next }
}

// Defined in the store, where deleting a rule also deletes its state row.
export { armStateKey }

export function parseArmState(raw: string | null): ArmState | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<ArmState>
    if (typeof o?.armed !== 'boolean') return null
    return { armed: o.armed, lastValue: typeof o.lastValue === 'number' ? o.lastValue : null, epoch: Number(o.epoch) || 0 }
  } catch { return null }
}

/* ============ rendering a match ============ */

// The recipient's own list tag for an account, resolved exactly the way AddrPill
// resolves it client-side (`resolveTag` in explorer-ui/src/userTags.ts): the
// viewer's lists in their chosen order, with the system directory occupying a
// slot in that order — so a system tag placed above a personal list still wins.
export type ViewerTag = (accountId: string) => { name: string } | null

// Resolved per RECIPIENT, at render time, from userListService's resident maps —
// no query, and never from the sender's or the chain's point of view. Two people
// notified about the same account see it under their own names for it, which is
// the whole point: an account the reader has tagged "Kraken hot wallet" must
// read as that in the message, exactly as it does on the page.
export function viewerTagResolver(recipient: string): ViewerTag {
  // tagMapFor ships the viewer's visible lists in their user_list_order
  // priority, with the reserved 'system' slot in its chosen position.
  const lists = tagMapFor(recipient).map(list => ({
    listId: list.listId,
    byAccount: new Map(list.tags.flatMap(tag => tag.members.map(m => [m, tag] as const))),
  }))
  const memo = new Map<string, { name: string } | null>()
  return accountId => {
    const hit = memo.get(accountId)
    if (hit !== undefined) return hit
    let resolved: { name: string } | null = null
    for (const list of lists) {
      if (list.listId === 'system') {
        // The system slot, mirroring resolveTag's `if (sys) return sys;
        // continue`: an account that HAS a system tag is resolved by it (it
        // already rides on the AccountRef, and accountNotation reads it next),
        // so no list ranked below may override it — but an account WITHOUT one
        // falls THROUGH the slot to those lower lists. Stopping at the slot
        // outright made every list a viewer had ordered below 'system' — which
        // is every subscribed list by default — invisible to messages.
        if (tagForAccount(accountId)) break
        continue
      }
      const tag = list.byAccount.get(accountId)
      if (tag) { resolved = { name: tag.name }; break }
    }
    memo.set(accountId, resolved)
    return resolved
  }
}

export function renderAccount(ref: AccountRef, viewerTag: ViewerTag): RenderAccount {
  return {
    accountId: ref.accountId, address: ref.address, emoji: ref.emoji,
    userTag: viewerTag(ref.accountId), tag: ref.tag,
    profile: ref.profile, identity: ref.identity, contractName: ref.contractName ?? null,
  }
}

const humanAmount = (raw: string | null, decimals: number): number | null => {
  if (raw == null) return null
  const n = Number(raw) / 10 ** decimals
  return Number.isFinite(n) ? n : null
}

// Canonical explorer path for an activity row — the same slug/id pair the UI
// links to (activitySlug/activityId in ActivityTable.tsx), so a notification
// opens the page the reader would have found themselves.
export function activityPath(row: ActivityRow): string {
  const slug = (() => {
    switch (row.type) {
      case 'trade': return row.dca ? 'dca' : 'swap'
      case 'dca': return 'dca'
      case 'xcm': return 'cross-chain'
      case 'liquidity': return row.liqAction === 'Remove' ? 'remove-liquidity'
        : row.liqAction === 'Create' ? 'create-pool'
          : row.liqAction === 'Destroy' ? 'destroy-pool'
            : row.liqAction === 'Claim' ? 'claim-rewards'
              : row.liqAction === 'ClaimReferral' ? 'claim-referral-rewards' : 'add-liquidity'
      case 'mm': return MM_SLUG[row.mmAction ?? ''] ?? 'lend'
      case 'staking': return 'staking'
      case 'vote': return 'vote'
      case 'otc': return row.otcAction === 'Pull' ? 'otc-pull' : row.otcAction === 'Fill' ? 'otc-fill' : 'otc-place'
      default: return 'transfer'
    }
  })()
  // A DCA execution's canonical page is its SCHEDULE, matching the UI.
  if ((row.type === 'dca' || row.dca) && row.dcaScheduleId != null) return `/dca/${row.dcaScheduleId}`
  const id = activityIdentity(row)
  return id ? `/${slug}/${id}` : `/block/${row.blockHeight}`
}
const MM_SLUG: Record<string, string> = {
  Supply: 'lend', Withdraw: 'withdraw', Borrow: 'borrow', Repay: 'repay',
  LiquidationCall: 'liquidate', Liquidate: 'liquidate', ClaimRewards: 'claim-rewards',
}

const ACTIVITY_LABEL: Record<ActivityRow['type'], string> = {
  transfer: 'Transfer', trade: 'Swap', xcm: 'Cross-chain', liquidity: 'Liquidity',
  mm: 'Money market', dca: 'DCA', staking: 'Staking', vote: 'Vote', otc: 'OTC',
}
function activityHeadline(row: ActivityRow): string {
  if (row.type === 'liquidity' && row.liqAction === 'ClaimReferral') return 'Claim referral rewards'
  if (row.type === 'liquidity' && row.liqAction) return `${row.liqAction} liquidity`
  if (row.type === 'mm' && row.mmAction) return row.mmAction
  if (row.type === 'otc' && row.otcAction) return `OTC ${row.otcAction.toLowerCase()}`
  if (row.type === 'trade' && row.dca) return 'DCA swap'
  return ACTIVITY_LABEL[row.type]
}

function activityAmountLine(row: ActivityRow, viewerTag: ViewerTag): RenderPart[] {
  const parts: RenderPart[] = []
  const inAmount = humanAmount(row.amountIn, row.assetIn?.decimals ?? 0)
  const outAmount = humanAmount(row.amountOut, row.assetOut?.decimals ?? 0)
  if (row.assetIn && inAmount != null && row.assetOut && outAmount != null) {
    parts.push(amountPart(inAmount, row.assetIn.symbol), textPart('→'), amountPart(outAmount, row.assetOut.symbol))
  } else {
    const one = humanAmount(row.amount, row.asset?.decimals ?? 0)
    if (row.asset && one != null) parts.push(amountPart(one, row.asset.symbol))
  }
  if (row.to) parts.push(textPart('to'), accountPart(renderAccount(row.to, viewerTag)))
  if (row.valueUsd != null) parts.push(textPart('·'), usdPart(row.valueUsd))
  return parts
}

// How a motion phase reads in a headline. 'voted' is deliberately not "voted on":
// the body names the member and their side, and the headline says what happened.
const TC_MOTION_PHASE_LABEL: Record<TcMotionPhase, string> = {
  proposed: 'proposed', voted: 'voted', approved: 'approved',
  disapproved: 'disapproved', executed: 'executed', closed: 'closed',
}

const PHASE_LABEL: Record<ReferendumPhase, string> = {
  submitted: 'submitted', deciding: 'entered its decision period', confirmed: 'confirmed',
  rejected: 'rejected', cancelled: 'cancelled', 'timed-out': 'timed out', killed: 'killed',
}

// Asset ids in human-facing summaries read as tickers, from the same registry
// the rest of the api renders symbols from.
const symbolOf = (assetId: number): string => assetDescriptor(assetId).symbol

// One match → the {title, body, path} the shared renderer turns into all three
// surfaces. Pure: everything it needs is already on the match.
export function renderMatch(match: RuleMatch, rule: NotificationRule, viewerTag: ViewerTag): RenderInput {
  const p = match.payload
  switch (p.lane) {
    case 'activity': {
      const row = p.row
      const title: RenderPart[] = [textPart(activityHeadline(row))]
      if (row.who) title.push(textPart('by'), accountPart(renderAccount(row.who, viewerTag)))
      return { title, body: [activityAmountLine(row, viewerTag), [textPart(`Block ${row.blockHeight}`)]], path: activityPath(row) }
    }
    case 'safety':
      return {
        title: [textPart(p.event.label)],
        body: [p.event.detail, [textPart(`Block ${p.event.blockHeight}`)]],
        path: '/security',
      }
    case 'referendum':
      return {
        title: [textPart(`Referendum #${p.row.index} ${PHASE_LABEL[p.row.phase]}`)],
        body: [p.title ?? '', p.row.track == null ? '' : `Track ${p.row.track}`],
        path: `/referendum/opengov/${p.row.index}`,
      }
    case 'tc-motion': {
      const row = p.row
      const body: (string | RenderPart[])[] = []
      if (row.actor) {
        const line: RenderPart[] = [
          textPart(row.phase === 'voted' ? 'Voted by' : 'Proposed by'),
          accountPart(renderAccount(row.actor, viewerTag)),
        ]
        if (row.aye != null) line.push(textPart(row.aye ? '· Aye' : '· Nay'))
        body.push(line)
      }
      // The tally the event itself reported, so a reader sees where the motion
      // stands without opening it. Absent on the phases that carry none.
      if (row.yes != null || row.no != null) body.push(`${row.yes ?? 0} aye / ${row.no ?? 0} nay`)
      if (row.threshold != null) body.push(`Threshold ${row.threshold}`)
      if (row.ok != null) body.push(row.ok ? 'Dispatched successfully' : 'Dispatch failed')
      body.push([textPart(`Block ${row.blockHeight}`)])
      return {
        title: [textPart(`TC motion ${shortHash(row.proposalHash)} ${TC_MOTION_PHASE_LABEL[row.phase]}`)],
        body,
        // A member's vote IS a real activity row (the vote feeds merge the
        // collective votes), so it links to that row's own page. The other phases
        // have no activity of their own and link to the event, the same way the
        // `event` lane does.
        path: row.phase === 'voted'
          ? `/vote/${row.blockHeight}-e${row.eventIndex}`
          : `/event/${row.blockHeight}-${row.eventIndex}`,
      }
    }
    case 'event':
      return {
        title: [textPart('Event'), codePart(p.row.name)],
        body: [[textPart(`Block ${p.row.blockHeight}`)]],
        path: `/event/${p.row.blockHeight}-${p.row.eventIndex}`,
      }
    case 'extrinsic': {
      const title: RenderPart[] = [textPart(p.row.success ? 'Extrinsic' : 'Failed extrinsic'), codePart(p.row.callName)]
      const body: (string | RenderPart[])[] = []
      if (p.row.signer) body.push([textPart('Signed by'), accountPart(renderAccount(p.row.signer, viewerTag))])
      body.push([textPart(`Block ${p.row.blockHeight}`)])
      return { title, body, path: `/extrinsic/${p.row.blockHeight}-${p.row.extrinsicIndex}` }
    }
    case 'price': {
      const symbol = assetDescriptor(p.assetId).symbol
      return {
        title: [textPart(`${symbol} ${p.direction} ${compactUsd(p.threshold)}`)],
        body: [[textPart('Now'), usdPart(p.value)]],
        path: `/asset/${p.assetId}`,
      }
    }
    case 'health-factor': {
      const title: RenderPart[] = [textPart(`Health factor ${compactAmount(p.value)}`)]
      if (p.account) title.push(textPart('—'), accountPart(renderAccount(p.account, viewerTag)))
      return {
        title,
        body: [[textPart(`Below the ${compactAmount(p.threshold)} you set. ${describeRule(rule.kind, rule.params, symbolOf)}.`)]],
        path: `/account/${encodeURIComponent(p.account?.address ?? p.address)}`,
      }
    }
  }
}

// One message for several matches of one rule. `total` is how many matches the
// digest stands for, which is not `rendered.length`: only the few matches the
// message lists by name are ever rendered, so a rule that matched thousands of
// rows costs five renders.
export function renderDigest(rule: NotificationRule, rendered: readonly RenderedNotification[], total = rendered.length): RenderedNotification {
  // A tag target is named from the rule OWNER's point of view — the same
  // resolution the rules list shows them, so a digest cannot describe a rule
  // differently from the page that created it.
  const label = rule.name || describeRule(rule.kind, rule.params, symbolOf, t => resolveActivityTarget(rule.accountId, t))
  const listed = rendered.slice(0, COALESCE_LIST).map(r => r.title)
  const more = total - listed.length
  return renderNotification({
    title: [textPart(`${total} × ${KIND_LABELS[rule.kind]}`)],
    body: [label, ...listed.map(t => `• ${t}`), ...(more > 0 ? [`and ${more} more`] : [])],
    path: '/notifications',
  })
}

/* ============ the loop ============ */

const counters = {
  ticks: 0, errors: 0, seeded: 0, skippedBlocks: 0, truncatedPages: 0,
  matches: 0, delivered: 0, coalesced: 0, cooldownSuppressed: 0,
  deferredGroups: 0, sourceFetches: 0, digested: 0,
}
export function evaluatorCounters(): Readonly<typeof counters> { return { ...counters } }

let client: ClickHouseClient | null = null
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false
let tick = 0
const lastSendAtMs = new Map<string, number>()
// Per-kind cursors, authoritative in memory and persisted on a timer (see
// flushCursors). `dirtyCursors` is what has moved since the last write.
const cursors = new Map<RowLaneKind, number>()
const dirtyCursors = new Set<RowLaneKind>()
let cursorsPersistedAtMs = 0
// Where the round-robin over activity source groups resumes, per kind.
const rotation = new Map<RowLaneKind, number>()

export function initEvaluator(c: ClickHouseClient): void {
  client = c
}

/* ============ per-kind cursor state ============ */

// A kind's cursor: from memory, else from its own state row, else from the
// legacy single cursor (an upgrade in place), else unknown — which means the
// lane seeds instead of evaluating.
function cursorFor(kind: RowLaneKind): number | null {
  const held = cursors.get(kind)
  if (held != null) return held
  const stored = getNotificationState(cursorKey(kind)) ?? getNotificationState(LEGACY_CURSOR_KEY)
  const value = stored == null ? Number.NaN : Number(stored)
  if (!Number.isFinite(value) || value <= 0) return null
  cursors.set(kind, value)
  return value
}

async function seedCursor(kind: RowLaneKind, at: number): Promise<void> {
  counters.seeded++
  cursors.set(kind, at)
  dirtyCursors.delete(kind)
  await setNotificationState(cursorKey(kind), String(at))
  cursorsPersistedAtMs = Date.now()
}

function advanceCursor(kind: RowLaneKind, to: number): void {
  if (cursors.get(kind) === to) return
  cursors.set(kind, to)
  dirtyCursors.add(kind)
}

// Persisting every tick would write ~14k rows a day into user_notification_state
// for a cursor nobody reads between restarts. A tick that delivered something
// persists at once (so a crash cannot re-send it), an idle one at most once a
// minute, and `stopNotificationEvaluator` flushes whatever is left.
//
// The referendum lane's parked submissions ride the same cadence: they are held in
// memory the same way, and a restart that dropped them would replay a parked alert
// at most once — the notification id makes that free.
async function flushCursors(force: boolean): Promise<void> {
  if (!dirtyCursors.size && !parkedDirty) return
  const now = Date.now()
  // A parked submission is written at ONCE rather than on the idle cadence: its
  // row sits below the cursor the moment this tick advances, so a restart that
  // lost the map would lose the alert entirely rather than replay it.
  if (!force && !parkedDirty && now - cursorsPersistedAtMs < CURSOR_PERSIST_MS) return
  const pending = [...dirtyCursors]
  dirtyCursors.clear()
  cursorsPersistedAtMs = now
  for (const kind of pending) {
    const value = cursors.get(kind)
    if (value != null) await setNotificationState(cursorKey(kind), String(value))
  }
  if (parkedDirty) {
    parkedDirty = false
    await setNotificationState(PARKED_SUBMISSIONS_KEY, serializeParkedSubmissions(parkedSubmissions()))
  }
}

/** The cursors as they stand in memory, for tests and diagnostics. */
export function evaluatorCursors(): Record<string, number> {
  return Object.fromEntries(cursors)
}

export function evaluatorIntervalMs(): number {
  const raw = Number(process.env.NOTIFY_EVAL_MS)
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : DEFAULT_EVAL_MS
}

export function startNotificationEvaluator(intervalMs = evaluatorIntervalMs()): void {
  if (timer) return
  timer = setInterval(() => { void runEvaluatorTick() }, intervalMs)
  // Never a reason to hold the process open: the loop is a follower, not work
  // anybody is waiting on.
  timer.unref?.()
}

// Resolves once the cursors the throttle was still holding have been written —
// a shutdown that dropped them would replay the last minute of blocks on the
// next boot. Safe to call without awaiting; the write's failure is swallowed.
export function stopNotificationEvaluator(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  return flushCursors(true).catch(() => {})
}

export function resetEvaluatorForTests(): void {
  void stopNotificationEvaluator()
  client = null
  inFlight = false
  tick = 0
  lastSendAtMs.clear()
  cursors.clear()
  dirtyCursors.clear()
  parked = null
  parkedDirty = false
  rotation.clear()
  cursorsPersistedAtMs = 0
  for (const k of Object.keys(counters) as (keyof typeof counters)[]) counters[k] = 0
}

// The live pipeline's head. Returns null when it cannot be read — an unknown
// head advances nothing, which is the safe direction.
async function queryLiveHead(): Promise<number | null> {
  if (!client) return null
  const res = await client.query({
    query: `SELECT max(last_block) AS head FROM price_data.raw_ingestion_state FINAL WHERE pipeline_id = {pipeline:String}`,
    query_params: { pipeline: LIVE_PIPELINE_ID },
    format: 'JSONEachRow',
  })
  const head = Number((await res.json<{ head: number | string | null }>())[0]?.head ?? 0)
  return Number.isFinite(head) && head > 0 ? head : null
}

// One pass. Never throws: a source that fails is counted and skipped, and the
// kind whose lane failed keeps its cursor, so the next tick evaluates that
// window again. Delivery is at-least-once within the window clamp — a duplicate
// is impossible (the notification id is deterministic and the dedup set survives
// a restart), a silent loss is not acceptable.
export async function runEvaluatorTick(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    counters.ticks++
    tick++
    const head = await queryLiveHead()
    if (head == null) return
    const lanes: LaneOutcome[] = []
    for (const kind of ROW_LANE_KINDS) {
      const rules = activeRulesByKind(kind)
      if (!rules.length) continue
      await guard(kind, async () => {
        const outcome = await runKindLane(kind, rules, head)
        if (outcome) lanes.push(outcome)
      })
    }
    const snapshot = tick % SNAPSHOT_EVERY_TICKS === 1 ? await runSnapshotLane() : []
    const matches = [...lanes.flatMap(l => l.matches), ...snapshot]
    // Cursors move only once this tick's matches are durably in the inbox: a
    // failed write with an advanced cursor would lose them for good.
    if (await dispatch(matches)) {
      for (const lane of lanes) {
        advanceCursor(lane.kind, lane.nextCursor)
        lane.commit?.()
      }
    }
    await flushCursors(matches.length > 0)
  } catch (err) {
    counters.errors++
    console.error('[notifications] evaluator tick failed', err)
  } finally {
    inFlight = false
  }
}

async function guard(what: string, run: () => Promise<void>): Promise<void> {
  try { await run() } catch (err) {
    counters.errors++
    console.error(`[notifications] ${what} lane failed`, err)
  }
}

/* ============ row lane ============ */

/** One kind's matches for this tick, and where its cursor may move to. */
interface LaneOutcome {
  kind: RowLaneKind
  matches: RuleMatch[]
  nextCursor: number
  /**
   * State the lane may only keep once this tick's rows are durably in the inbox —
   * applied exactly where the cursor advances. The referendum lane's parked
   * submissions use it: dropping a released entry before the write landed would
   * lose a notification whose row sits below the window for good.
   */
  commit?: () => void
}
/** Activity source fetches this kind has left this tick. */
interface FetchBudget { left: number }

// A kind's lane: seed if it has no cursor yet, otherwise window and match.
// Returns null when there is nothing to advance (seeded, or an empty window).
async function runKindLane(kind: RowLaneKind, rules: NotificationRule[], head: number): Promise<LaneOutcome | null> {
  const cursor = cursorFor(kind)
  if (kind === 'safety') return safetyLane(rules, cursor, head)
  if (cursor == null) {
    // First run seeds at the head and evaluates nothing: everything already
    // indexed is history, and history does not page anybody.
    await seedCursor(kind, head)
    return null
  }
  const { window, skipped } = resolveWindow(cursor, head)
  if (skipped > 0) {
    counters.skippedBlocks += skipped
    console.warn(`[notifications] ${kind} cursor ${cursor} was ${head - cursor} blocks behind the live head; skipping ${skipped} blocks`)
  }
  if (window.to <= window.from) return null
  switch (kind) {
    case 'account-activity': {
      const { matches, deferred } = await accountActivityMatches(rules, window, { left: SOURCE_FETCH_CAP })
      // A deferred group has not seen this window yet, so the cursor waits for
      // it rather than stepping over its rows.
      return { kind, matches, nextCursor: deferred ? cursor : window.to }
    }
    case 'large-trade':
    case 'large-transfer': {
      const feedType = kind === 'large-trade' ? 'trade' : 'transfer'
      const { matches, deferred } = await largeValueMatches(kind, feedType, rules, window, { left: SOURCE_FETCH_CAP })
      return { kind, matches, nextCursor: deferred ? cursor : window.to }
    }
    case 'referendum': return { kind, ...await referendumMatches(rules, window), nextCursor: window.to }
    case 'tc-motion': return { kind, matches: evaluateTcMotion(await queryWindowTcMotions(window), rules, window), nextCursor: window.to }
    case 'event': return { kind, matches: evaluateEvents(await queryWindowEvents(rules, window), rules, window), nextCursor: window.to }
    default: return { kind, matches: evaluateExtrinsics(await queryWindowExtrinsics(rules, window), rules, window), nextCursor: window.to }
  }
}

// The safety lane's source is the shared security dashboard, cached 20s fresh /
// 120s stale on a key that has no head in it — so between two ticks the snapshot
// it returns is usually the SAME one, whose newest row sits at or below the
// cursor. Anchoring this cursor on the live head therefore made the lane
// unable to fire at all: every tick moved the cursor past a timeline it had not
// seen yet. It instead advances only to the newest block the timeline actually
// contained, which keeps the blind spot below the cursor (a backfilled safety
// action stays silent) while guaranteeing every action the dashboard eventually
// reveals is above the cursor exactly once.
async function safetyLane(rules: NotificationRule[], cursor: number | null, head: number): Promise<LaneOutcome | null> {
  const timeline = (await getSecurityDashboard()).timeline
  const newest = timeline.reduce((max, e) => Math.max(max, e.blockHeight), 0)
  if (cursor == null) {
    // Seed at the newest action the timeline knows about, not at the head: the
    // head is normally far above it and everything in between is history.
    await seedCursor('safety', newest > 0 ? newest : head)
    return null
  }
  const to = Math.max(cursor, newest)
  if (to === cursor) return null
  return { kind: 'safety', matches: evaluateSafety(timeline, rules, { from: cursor, to }), nextCursor: to }
}

// One source fetch per WATCHED TARGET, not per rule variant: the pure matcher
// re-applies each rule's own type/action/USD filter, so the group asks the feed
// the widest question ('all', no floor) and the narrow rules read the same page.
// Grouping on the filters instead made the number of queries per tick a function
// of how many DIFFERENT alerts people had written for one target.
//
// A TAG target is one group however many accounts it holds — the scoped feeds
// (getTagActivity/getListTagActivity) classify and scope to the tag's CURRENT
// members in one query, which is what makes a tag subscription cost the same as
// an address one and pick up a new member with no work at all.
//
// Returns null for a rule whose target no longer resolves — a deleted tag, or a
// list its owner may no longer read. Such a rule joins no group, so it fetches
// nothing and matches nothing, silently.
function activitySourceKey(rule: NotificationRule): string | null {
  const target = (rule.params as RuleParams['account-activity']).target
  if (target.kind === 'address') return `address:${target.address}`
  if (target.kind === 'tag') return `tag:${target.tagId}`
  // Every rule left in a list-tag group can read the list, so they all see the
  // same member set and can share one fetch across owners.
  return resolveActivityTarget(rule.accountId, target) ? `list-tag:${target.listId}:${target.tagId}` : null
}

// The scoped feed behind one group's target. The visibility check is repeated
// HERE rather than trusted from creation time: a list unshared between two ticks
// must stop contributing rows immediately, without the rule being touched.
async function fetchTargetActivity(
  target: RuleParams['account-activity']['target'], viewer: string,
  limit: number, filters: { min?: number; unit?: 'usd' },
): Promise<ActivityRow[] | null> {
  switch (target.kind) {
    case 'address': return getAddressActivity(target.address, 'all', limit, 0, undefined, filters)
    case 'tag': return getTagActivity(target.tagId, 'all', limit, 0, undefined, filters)
    default: {
      const resolved = resolveActivityTarget(viewer, target)
      if (!resolved) return []
      return getListTagActivity(target.listId, target.tagId, resolved.members, 'all', limit, 0, undefined, filters)
    }
  }
}

async function accountActivityMatches(rules: NotificationRule[], window: BlockWindow, budget: FetchBudget): Promise<{ matches: RuleMatch[]; deferred: boolean }> {
  const groups = new Map<string, NotificationRule[]>()
  for (const rule of rules) {
    const key = activitySourceKey(rule)
    if (key == null) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(rule)
  }
  return visitGroups('account-activity', groups, budget, async group => {
    const params = group.map(r => r.params as RuleParams['account-activity'])
    // The type and the action cannot be merged — two rules can name different
    // families — but a USD floor can: when EVERY rule in the group has one, the
    // page is fetched at the lowest of them, which cannot hide a match and keeps
    // a busy target from saturating the page with rows nobody subscribed to.
    const floors = params.map(p => p.minUsd)
    const min = floors.every(f => f != null) ? Math.min(...floors as number[]) : null
    const filters = min == null ? {} : { min, unit: 'usd' as const }
    const rows = await fetchActivityPage(limit => fetchTargetActivity(params[0].target, group[0].accountId, limit, filters), window)
    return evaluateAccountActivity(rows, group, window)
  })
}

// One fetch per ASSET, at the lowest floor any of that asset's rules asked for —
// a higher floor is re-applied by the matcher. The rules that name no asset are
// their own chain-wide group, likewise at their lowest floor.
//
// The two value-floor kinds read the same feed under different `type`s, and each
// gets its OWN groups, rotation and fetch budget: a large-trade rule on HDX and
// a large-transfer rule on HDX ask the feed two different questions, so they
// cannot share a fetch, and the per-kind budget is what keeps either from
// starving the other (see SOURCE_FETCH_CAP).
const largeValueKey = (p: RuleParams['large-trade']): string => (p.assetId == null ? '' : String(p.assetId))

async function largeValueMatches(
  kind: 'large-trade' | 'large-transfer', feedType: 'trade' | 'transfer',
  rules: NotificationRule[], window: BlockWindow, budget: FetchBudget,
): Promise<{ matches: RuleMatch[]; deferred: boolean }> {
  const groups = groupRules(rules, rule => largeValueKey(rule.params as RuleParams['large-trade']))
  return visitGroups(kind, groups, budget, async group => {
    const params = group.map(r => r.params as RuleParams['large-trade'])
    const min = Math.min(...params.map(p => p.minUsd))
    const assetId = params[0].assetId
    const filters = { min, unit: 'usd' as const, ...(assetId == null ? {} : { token: String(assetId) }) }
    const rows = await fetchActivityPage(limit => getRecentActivity(limit, undefined, undefined, 0, feedType, filters), window)
    return evaluateLargeValue(rows, group, window)
  })
}

function groupRules(rules: readonly NotificationRule[], keyOf: (rule: NotificationRule) => string): Map<string, NotificationRule[]> {
  const groups = new Map<string, NotificationRule[]>()
  for (const rule of rules) {
    const key = keyOf(rule)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(rule)
  }
  return groups
}

// Visit at most `budget.left` groups, resuming where the last tick stopped so no
// group is starved: the rotation index is kept per kind for the life of the
// process. Groups it does not reach are counted and reported as deferred, which
// holds the kind's cursor back until they have been seen.
async function visitGroups(
  kind: RowLaneKind,
  groups: Map<string, NotificationRule[]>,
  budget: FetchBudget,
  run: (group: NotificationRule[]) => Promise<RuleMatch[]>,
): Promise<{ matches: RuleMatch[]; deferred: boolean }> {
  const keys = [...groups.keys()].sort()
  if (!keys.length) return { matches: [], deferred: false }
  const start = (rotation.get(kind) ?? 0) % keys.length
  const take = Math.min(keys.length, Math.max(budget.left, 0))
  const matches: RuleMatch[] = []
  for (let i = 0; i < take; i++) {
    const key = keys[(start + i) % keys.length]
    budget.left--
    counters.sourceFetches++
    matches.push(...await run(groups.get(key)!))
  }
  rotation.set(kind, (start + take) % keys.length)
  const deferred = keys.length - take
  counters.deferredGroups += deferred
  return { matches, deferred: deferred > 0 }
}

// One page, widened once if it turns out to start above the cursor. A page that
// is STILL saturated after the wide fetch delivers what it has and counts the
// truncation rather than paging deeper: the feed is not a backlog queue, and an
// unbounded catch-up is exactly what the window clamp exists to prevent.
async function fetchActivityPage(
  fetch: (limit: number) => Promise<ActivityRow[] | null>,
  window: BlockWindow,
): Promise<ActivityRow[]> {
  let rows = (await fetch(ACTIVITY_PAGE)) ?? []
  if (pageMissedRows(rows, window, ACTIVITY_PAGE)) {
    rows = (await fetch(ACTIVITY_PAGE_WIDE)) ?? []
    if (pageMissedRows(rows, window, ACTIVITY_PAGE_WIDE)) counters.truncatedPages++
  }
  return rows
}

const REFERENDUM_PHASE_BY_EVENT: Record<string, ReferendumPhase> = {
  'Referenda.Submitted': 'submitted',
  'Referenda.DecisionStarted': 'deciding',
  'Referenda.Confirmed': 'confirmed',
  'Referenda.Rejected': 'rejected',
  'Referenda.Cancelled': 'cancelled',
  'Referenda.TimedOut': 'timed-out',
  'Referenda.Killed': 'killed',
}

// OpenGov lifecycle events in the window, from the referendum-first projection
// `referendum_lifecycle_events` (the same source the referendum pages read).
// It holds only lifecycle rows — a few per referendum — so a block-window scan
// over it is a few thousand rows rather than the raw_events table.
async function queryWindowReferenda(window: BlockWindow): Promise<ReferendumEventRow[]> {
  if (!client) return []
  const res = await client.query({
    query: `SELECT ref_index, block_height, event_index, event_name, args_json
            FROM price_data.referendum_lifecycle_events
            WHERE pallet = 'opengov' AND block_height > {from:UInt32} AND block_height <= {to:UInt32}
            ORDER BY block_height, event_index`,
    query_params: { from: window.from, to: window.to },
    format: 'JSONEachRow',
  })
  const out: ReferendumEventRow[] = []
  for (const r of await res.json<{ ref_index: number; block_height: number; event_index: number; event_name: string; args_json: string }>()) {
    const phase = REFERENDUM_PHASE_BY_EVENT[r.event_name]
    if (!phase) continue
    out.push({
      blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
      index: Number(r.ref_index), phase, track: trackFromArgs(r.args_json),
    })
  }
  return out
}

function trackFromArgs(argsJson: string): number | null {
  try {
    const track = (JSON.parse(argsJson || '{}') as { track?: unknown }).track
    return typeof track === 'number' ? track : null
  } catch { return null }
}

// Only Submitted and DecisionStarted carry the track, so a rule filtering by
// track needs the referendum's own submission for every other phase. That is a
// primary-key lookup on (pallet, ref_index) over the same small projection,
// bounded by the handful of referenda the window touched.
async function fillReferendumTracks(rows: ReferendumEventRow[]): Promise<void> {
  const unknown = [...new Set(rows.filter(r => r.track == null).map(r => r.index))]
  if (!client || !unknown.length) return
  const res = await client.query({
    query: `SELECT ref_index, args_json
            FROM price_data.referendum_lifecycle_events
            WHERE pallet = 'opengov' AND ref_index IN {idx:Array(UInt32)}
              AND event_name IN ('Referenda.Submitted', 'Referenda.DecisionStarted')`,
    query_params: { idx: unknown },
    format: 'JSONEachRow',
  })
  const byIndex = new Map<number, number>()
  for (const r of await res.json<{ ref_index: number; args_json: string }>()) {
    const track = trackFromArgs(r.args_json)
    if (track != null) byIndex.set(Number(r.ref_index), track)
  }
  for (const row of rows) if (row.track == null) row.track = byIndex.get(row.index) ?? null
}

async function referendumMatches(rules: NotificationRule[], window: BlockWindow): Promise<{ matches: RuleMatch[]; commit?: () => void }> {
  const rows = await queryWindowReferenda(window)
  if (rows.length && rules.some(r => (r.params as RuleParams['referendum']).track)) await fillReferendumTracks(rows)
  // Titles are off-chain (SubSquare) and already in memory; a referendum the
  // refresher has not seen yet simply renders without one — except at SUBMITTED,
  // where the title is the whole message (see resolveSubmittedMatches).
  const titleFor = (index: number) => referendumTitleFor('opengov', index)
  const matches = rows.length ? evaluateReferendum(rows, rules, window, titleFor) : []
  const resolved = resolveSubmittedMatches(parkedSubmissions(), matches, rows, rules, titleFor, Date.now())
  if (!resolved.changed) return { matches: resolved.matches }
  return {
    matches: resolved.matches,
    commit: () => {
      parked = resolved.pending
      parkedDirty = true
    },
  }
}

/* ============ parked submitted-phase notifications ============ */

// One submission held back for want of a title. Keyed by referendum index, so a
// second Submitted for the same index (there is none) could not duplicate it.
export interface ParkedSubmission {
  blockHeight: number
  eventIndex: number
  track: number | null
  /** Wall clock at parking, for the expiry below. */
  parkedAt: number
}
// One state row holds the whole map: it is a handful of entries at most (Hydration
// submits a referendum every few days) and it is read and rewritten as a unit.
const PARKED_SUBMISSIONS_KEY = 'referendum:pending-submitted'
// How long a submission waits for a title. Past it the alert is dropped rather
// than delivered: two weeks after the fact, "a referendum was submitted" is not
// news, and a referendum still without a SubSquare post by then has none coming.
const PARKED_SUBMISSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

let parked: Map<number, ParkedSubmission> | null = null
let parkedDirty = false

export function parseParkedSubmissions(raw: string | null): Map<number, ParkedSubmission> {
  const out = new Map<number, ParkedSubmission>()
  if (!raw) return out
  try {
    const parsedRaw: unknown = JSON.parse(raw)
    const parsed = parsedRaw && typeof parsedRaw === 'object' ? parsedRaw as Record<string, Partial<ParkedSubmission>> : {}
    for (const [key, value] of Object.entries(parsed)) {
      const index = Number(key)
      if (!Number.isInteger(index) || !value) continue
      const blockHeight = Number(value.blockHeight)
      const eventIndex = Number(value.eventIndex)
      const parkedAt = Number(value.parkedAt)
      if (!Number.isFinite(blockHeight) || !Number.isFinite(eventIndex) || !Number.isFinite(parkedAt)) continue
      const track = value.track == null ? null : Number(value.track)
      out.set(index, { blockHeight, eventIndex, parkedAt, track: track != null && Number.isFinite(track) ? track : null })
    }
  } catch { /* an unreadable row parks nothing rather than throwing the lane */ }
  return out
}

export function serializeParkedSubmissions(map: ReadonlyMap<number, ParkedSubmission>): string {
  return JSON.stringify(Object.fromEntries([...map].map(([index, entry]) => [String(index), entry])))
}

// Loaded lazily from the state row, so a restart resumes whatever was held.
function parkedSubmissions(): Map<number, ParkedSubmission> {
  if (!parked) parked = parseParkedSubmissions(getNotificationState(PARKED_SUBMISSIONS_KEY))
  return parked
}

/** What is currently held back, for tests and diagnostics. */
export function evaluatorParkedSubmissions(): Record<number, ParkedSubmission> {
  return Object.fromEntries(parkedSubmissions())
}

// The submitted-phase gate.
//
// "Referendum #412 submitted" with no title says nothing the headline did not
// already say, and a submission is the one phase where that is the WHOLE message —
// the later phases at least report an outcome. So a submitted match whose title is
// still the platform's placeholder is HELD rather than delivered, and re-checked
// every tick. It leaves the map when:
//   * a real title arrives — the notification is built and delivered then, under
//     the same `${index}:submitted` dedup identity it would have had, so a rule
//     that somehow already received it is not told twice;
//   * the referendum's DecisionStarted enters the window — the phase a rule is
//     actually watching wins, and a rule subscribed to BOTH is told once;
//   * it has waited 14 days, after which it is dropped silently.
//
// Rules are re-matched at RESOLUTION time, not at parking time: the map holds the
// event, not a list of recipients, so a rule written while a submission was parked
// is served by it and a deleted one simply no longer matches.
export function resolveSubmittedMatches(
  pending: ReadonlyMap<number, ParkedSubmission>,
  matches: readonly RuleMatch[],
  windowRows: readonly ReferendumEventRow[],
  rules: readonly NotificationRule[],
  titleFor: (index: number) => string | null,
  nowMs: number,
): { matches: RuleMatch[]; pending: Map<number, ParkedSubmission>; changed: boolean } {
  const next = new Map(pending)
  let changed = false
  const kept: RuleMatch[] = []
  for (const match of matches) {
    const row = submittedRowOf(match)
    if (!row || !isGenericReferendumTitle(titleOf(match))) { kept.push(match); continue }
    if (next.has(row.index)) continue
    next.set(row.index, { blockHeight: row.blockHeight, eventIndex: row.eventIndex, track: row.track, parkedAt: nowMs })
    changed = true
  }
  // A referendum entering its decision period is the deadline: the submission is
  // now old news, so whatever title exists is the one it goes out with.
  const decided = new Set(windowRows.filter(r => r.phase === 'deciding').map(r => r.index))
  const decidingDelivered = new Set(kept
    .filter(m => m.payload.lane === 'referendum' && m.payload.row.phase === 'deciding')
    .map(m => `${m.ruleId}:${(m.payload as { row: ReferendumEventRow }).row.index}`))
  for (const [index, entry] of next) {
    const title = titleFor(index)
    const forced = decided.has(index)
    if (isGenericReferendumTitle(title) && !forced) {
      if (nowMs - entry.parkedAt >= PARKED_SUBMISSION_TTL_MS) { next.delete(index); changed = true }
      continue
    }
    const row: ReferendumEventRow = {
      blockHeight: entry.blockHeight, eventIndex: entry.eventIndex, index, phase: 'submitted', track: entry.track,
    }
    // Its own one-block window: the row sits below the lane's current window by
    // construction, and the matcher's job here is the rule's filters, not recency.
    const released = evaluateReferendum([row], rules, { from: row.blockHeight - 1, to: row.blockHeight }, () => title)
    for (const match of released) {
      if (forced && decidingDelivered.has(`${match.ruleId}:${index}`)) continue
      kept.push(match)
    }
    next.delete(index)
    changed = true
  }
  return { matches: kept, pending: next, changed }
}

const titleOf = (match: RuleMatch): string | null =>
  (match.payload.lane === 'referendum' ? match.payload.title : null)

const submittedRowOf = (match: RuleMatch): ReferendumEventRow | null =>
  match.payload.lane === 'referendum' && match.payload.row.phase === 'submitted' ? match.payload.row : null

const TC_MOTION_PHASE_BY_EVENT: Record<string, TcMotionPhase> = {
  'TechnicalCommittee.Proposed': 'proposed',
  'TechnicalCommittee.Voted': 'voted',
  'TechnicalCommittee.Approved': 'approved',
  'TechnicalCommittee.Disapproved': 'disapproved',
  // One act, two events: the collective dispatches an approved motion, and a
  // single member dispatches one that needed only their own vote.
  'TechnicalCommittee.Executed': 'executed',
  'TechnicalCommittee.MemberExecuted': 'executed',
  'TechnicalCommittee.Closed': 'closed',
}
const TC_MOTION_EVENT_NAMES = Object.keys(TC_MOTION_PHASE_BY_EVENT)

const argsOf = (argsJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(argsJson || '{}') as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}
const argNumber = (args: Record<string, unknown>, key: string): number | null => {
  const value = args[key]
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

// Technical Committee motion events in the window, straight off raw_events. The
// committee has emitted a few thousand events in the chain's whole history, and
// the event-name set index makes a 600-block window a near-empty scan — so this
// needs no projection of its own, unlike the referendum lane's.
async function queryWindowTcMotions(window: BlockWindow): Promise<TcMotionEventRow[]> {
  if (!client) return []
  const res = await client.query({
    query: `SELECT block_height, event_index, extrinsic_index, event_name, args_json
            FROM price_data.raw_events
            WHERE block_height > {from:UInt32} AND block_height <= {to:UInt32}
              AND event_name IN {names:Array(String)}
            ORDER BY block_height DESC, event_index DESC
            LIMIT {cap:UInt32}`,
    query_params: { from: window.from, to: window.to, names: TC_MOTION_EVENT_NAMES, cap: RAW_WINDOW_CAP },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }>()
  if (rows.length >= RAW_WINDOW_CAP) counters.truncatedPages++
  const out: TcMotionEventRow[] = []
  for (const r of rows) {
    const phase = TC_MOTION_PHASE_BY_EVENT[r.event_name]
    if (!phase) continue
    const args = argsOf(r.args_json)
    const account = typeof args.account === 'string' ? args.account : null
    const hash = typeof args.proposalHash === 'string' ? args.proposalHash : ''
    if (!hash) continue
    const result = args.result as { __kind?: unknown } | undefined
    out.push({
      blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
      extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index),
      phase, proposalHash: hash,
      actor: account ? accountRef(account) : null,
      aye: phase === 'voted' && typeof args.voted === 'boolean' ? args.voted : null,
      yes: argNumber(args, 'yes'), no: argNumber(args, 'no'),
      threshold: phase === 'proposed' ? argNumber(args, 'threshold') : null,
      ok: result && typeof result.__kind === 'string' ? result.__kind === 'Ok' : null,
    })
  }
  return out.sort(byBlockThen(r => r.eventIndex))
}

const sectionsOf = (rules: NotificationRule[]): string[] =>
  [...new Set(rules.map(r => (r.params as RuleParams['event']).section.trim().toLowerCase()))]

// Both raw window queries are range scans over the tables' own primary key
// (`block_height` first), narrowed to the rules' pallets in SQL so only the
// candidate rows are decompressed. The window is at most 600 blocks.
//
// They read NEWEST first and are re-sorted into chain order in memory: the cap
// has to truncate the oldest end of an over-full window, because the newest rows
// are the ones somebody is waiting to be told about — an ascending LIMIT would
// have delivered the start of the window and dropped the present.
const byBlockThen = <T extends { blockHeight: number }>(indexOf: (row: T) => number) =>
  (a: T, b: T) => a.blockHeight - b.blockHeight || indexOf(a) - indexOf(b)

async function queryWindowEvents(rules: NotificationRule[], window: BlockWindow): Promise<ChainEventRow[]> {
  if (!client) return []
  const res = await client.query({
    query: `SELECT block_height, event_index, extrinsic_index, event_name
            FROM price_data.raw_events
            WHERE block_height > {from:UInt32} AND block_height <= {to:UInt32}
              AND lower(splitByChar('.', event_name)[1]) IN {sections:Array(String)}
            ORDER BY block_height DESC, event_index DESC
            LIMIT {cap:UInt32}`,
    query_params: { from: window.from, to: window.to, sections: sectionsOf(rules), cap: RAW_WINDOW_CAP },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; event_name: string }>()
  if (rows.length >= RAW_WINDOW_CAP) counters.truncatedPages++
  return rows.map(r => ({
    blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
    extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index), name: r.event_name,
  })).sort(byBlockThen(r => r.eventIndex))
}

async function queryWindowExtrinsics(rules: NotificationRule[], window: BlockWindow): Promise<ChainExtrinsicRow[]> {
  if (!client) return []
  const res = await client.query({
    query: `SELECT block_height, extrinsic_index, call_name, success, coalesce(signer, effective_signer) AS signer
            FROM price_data.raw_extrinsics
            WHERE block_height > {from:UInt32} AND block_height <= {to:UInt32}
              AND lower(splitByChar('.', call_name)[1]) IN {sections:Array(String)}
            ORDER BY block_height DESC, extrinsic_index DESC
            LIMIT {cap:UInt32}`,
    query_params: { from: window.from, to: window.to, sections: sectionsOf(rules), cap: RAW_WINDOW_CAP },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ block_height: number; extrinsic_index: number; call_name: string; success: number; signer: string | null }>()
  if (rows.length >= RAW_WINDOW_CAP) counters.truncatedPages++
  return rows.map(r => ({
    blockHeight: Number(r.block_height), extrinsicIndex: Number(r.extrinsic_index),
    callName: r.call_name, success: Number(r.success) === 1,
    signer: r.signer ? accountRef(r.signer) : null,
  })).sort(byBlockThen(r => r.extrinsicIndex))
}

/* ============ snapshot lane ============ */

async function runSnapshotLane(): Promise<RuleMatch[]> {
  const matches: RuleMatch[] = []
  await guard('price', async () => { matches.push(...await priceMatches()) })
  await guard('health-factor', async () => { matches.push(...await healthFactorMatches()) })
  return matches
}

function loadArmStates(rules: readonly NotificationRule[]): Map<string, ArmState> {
  const prev = new Map<string, ArmState>()
  for (const rule of rules) {
    const state = parseArmState(getNotificationState(armStateKey(rule.ruleId)))
    if (state) prev.set(rule.ruleId, state)
  }
  return prev
}

async function persistArmStates(next: ReadonlyMap<string, ArmState>): Promise<void> {
  for (const [ruleId, state] of next) await setNotificationState(armStateKey(ruleId), JSON.stringify(state))
}

async function priceMatches(): Promise<RuleMatch[]> {
  const rules = activeRulesByKind('price')
  if (!rules.length) return []
  const prices = await ensurePrices()
  const inputs = rules.map(rule => {
    const p = rule.params as RuleParams['price']
    const price = prices.get(p.assetId)?.price
    return { ruleId: rule.ruleId, direction: p.direction, threshold: p.price, value: price != null && price > 0 ? price : null }
  })
  const { fired, next } = evaluateThreshold(inputs, loadArmStates(rules))
  await persistArmStates(next)
  const byId = new Map(rules.map(r => [r.ruleId, r]))
  return fired.map(f => {
    const rule = byId.get(f.ruleId)!
    const p = rule.params as RuleParams['price']
    return {
      ruleId: rule.ruleId, accountId: rule.accountId, kind: rule.kind,
      identity: `crossing:${f.direction}:${f.epoch}`, blockHeight: 0,
      payload: { lane: 'price', assetId: p.assetId, direction: f.direction, threshold: f.threshold, value: f.value } as MatchPayload,
    }
  })
}

async function healthFactorMatches(): Promise<RuleMatch[]> {
  const rules = activeRulesByKind('health-factor')
  if (!rules.length) return []
  // One lookup per ADDRESS: several rules on one position (a warning threshold
  // and a panic threshold) are the common shape, and they read the same number.
  const byAddress = new Map<string, number | null>()
  for (const address of new Set(rules.map(r => (r.params as RuleParams['health-factor']).address))) {
    // Unreadable is NOT zero: an address with no primary-market position, or a
    // position whose health factor cannot be read, must never look like an
    // imminent liquidation.
    byAddress.set(address, await getPrimaryHealthFactor(address).catch(() => null))
  }
  const inputs: ThresholdInput[] = rules.map(rule => {
    const p = rule.params as RuleParams['health-factor']
    return { ruleId: rule.ruleId, direction: 'below' as const, threshold: p.threshold, value: byAddress.get(p.address) ?? null }
  })
  const { fired, next } = evaluateThreshold(inputs, loadArmStates(rules))
  await persistArmStates(next)
  const byId = new Map(rules.map(r => [r.ruleId, r]))
  return fired.map(f => {
    const rule = byId.get(f.ruleId)!
    const p = rule.params as RuleParams['health-factor']
    const norm = normalizeAddress(p.address)
    return {
      ruleId: rule.ruleId, accountId: rule.accountId, kind: rule.kind,
      identity: `below:${f.epoch}`, blockHeight: 0,
      payload: {
        lane: 'health-factor', address: p.address,
        account: norm ? accountRef(norm.accountId) : null,
        threshold: f.threshold, value: f.value,
      } as MatchPayload,
    }
  })
}

/* ============ dispatch ============ */

// A rule's channels: the ones it names, or every channel the account has when
// it names none. A named channel that has since been deleted (or belongs to
// somebody else) is dropped rather than widening the rule.
export function channelsForRule(rule: NotificationRule): NotificationChannel[] {
  if (!rule.channels.length) return channelsFor(rule.accountId)
  return rule.channels
    .map(id => getChannel(id))
    .filter((c): c is NotificationChannel => c != null && c.accountId === rule.accountId)
}

/** One outbound message, held back until the inbox rows for the tick have landed. */
interface PendingSend {
  ruleId: string
  accountId: string
  message: RenderedNotification
  tag: string
  channels: NotificationChannel[]
}

// The whole tick's matches: rendered per rule, written to the inbox in ONE
// insert, then sent. Returns false when the write failed, which is the caller's
// signal to leave every cursor where it was.
async function dispatch(matches: RuleMatch[]): Promise<boolean> {
  if (!matches.length) return true
  counters.matches += matches.length
  const byRule = new Map<string, RuleMatch[]>()
  for (const m of matches) {
    if (!byRule.has(m.ruleId)) byRule.set(m.ruleId, [])
    byRule.get(m.ruleId)!.push(m)
  }
  const viewerTags = new Map<string, ViewerTag>()
  const notifications: DeliverableNotification[] = []
  const sends: PendingSend[] = []
  for (const [ruleId, list] of byRule) {
    await guard('dispatch', async () => {
      const rule = ruleOf(list[0])
      if (!rule) return
      if (!viewerTags.has(rule.accountId)) viewerTags.set(rule.accountId, viewerTagResolver(rule.accountId))
      const viewerTag = viewerTags.get(rule.accountId)!
      // Oldest first, so a coalesced message reads in chain order and the
      // leading match (the one that carries the outbound message) is stable.
      list.sort((a, b) => a.blockHeight - b.blockHeight || a.identity.localeCompare(b.identity))

      // A rule on a busy pallet can match the whole window. The oldest matches
      // keep their own detail row; the rest collapse into one digest row, so the
      // inbox stays a readable ledger and the write stays bounded.
      const detailed = list.slice(0, INBOX_ROWS_PER_RULE)
      const overflow = list.slice(INBOX_ROWS_PER_RULE)
      const render = (match: RuleMatch) => renderNotification(renderMatch(match, rule, viewerTag))
      const rendered = detailed.map(render)
      for (const [i, match] of detailed.entries()) {
        notifications.push({
          notificationId: notificationIdFor(ruleId, match.identity),
          accountId: rule.accountId, ruleId, kind: rule.kind,
          rendered: rendered[i], blockHeight: match.blockHeight,
        })
      }
      if (overflow.length) {
        counters.digested++
        // Deterministic identity, so the same truncated window collapses on a
        // replay exactly like a detail row does.
        const identity = `digest:${overflow[0].identity}:${overflow[overflow.length - 1].identity}`
        notifications.push({
          notificationId: notificationIdFor(ruleId, identity),
          accountId: rule.accountId, ruleId, kind: rule.kind,
          rendered: renderDigest(rule, overflow.slice(0, COALESCE_LIST).map(render), overflow.length),
          blockHeight: overflow[overflow.length - 1].blockHeight,
        })
      }

      // Cooldown suppresses the OUTBOUND message only; the inbox stays complete,
      // so a quiet rule is quiet, never lossy.
      const now = Date.now()
      const last = lastSendAtMs.get(ruleId) ?? 0
      const muffled = rule.cooldownS > 0 && now - last < rule.cooldownS * 1000
      if (muffled) counters.cooldownSuppressed++
      const channels = muffled ? [] : channelsForRule(rule)
      if (!channels.length) return
      if (list.length > 1) counters.coalesced++
      // One message per rule per tick: the single match itself, or a digest
      // naming the first few and counting the rest.
      const message = list.length === 1 ? rendered[0] : renderDigest(rule, rendered.slice(0, COALESCE_LIST), list.length)
      sends.push({ ruleId, accountId: rule.accountId, message, tag: ruleId, channels })
    })
  }

  const prepared = prepareNotifications(notifications)
  try {
    await commitNotifications(prepared)
  } catch (err) {
    counters.errors++
    console.error('[notifications] inbox write failed; cursors held for the next tick', err)
    return false
  }
  counters.delivered += prepared.rows.length
  // A rule whose every match was already delivered sends nothing: an
  // overlapping window is a replay, not news, and it must not restart the
  // cooldown clock either.
  const fresh = new Set(prepared.rows.map(r => r.ruleId))
  for (const send of sends) {
    if (!fresh.has(send.ruleId)) continue
    lastSendAtMs.set(send.ruleId, Date.now())
    sendOutbound(send.accountId, send.message, send.tag, send.channels)
  }
  return true
}

function ruleOf(match: RuleMatch): NotificationRule | null {
  return activeRulesByKind(match.kind).find(r => r.ruleId === match.ruleId) ?? null
}
