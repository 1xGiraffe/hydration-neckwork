import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import { assetDescriptor } from '../services/explorerAssets.ts'
import { avgBlockMsSql, clampBlockMs, NOMINAL_PARA_BLOCK_MS } from '../services/blockTime.ts'
import {
  accountRef, activityRowMatchesAction, activityTypeMatchesFamily, ensurePrices,
  getAddressActivity, getListTagActivity, getPrimaryHealthFactor, getRecentActivity, getTagActivity,
  type AccountRef, type ActivityRow,
} from '../services/explorerService.ts'
import { getSecurityDashboard, type SafetyEvent } from '../services/securityService.ts'
import { isGenericReferendumTitle, referendumTitleFor } from '../services/referendumTitleService.ts'
import { enactmentOutcomeFrom, referendumEnactmentTaskId } from '../services/governanceService.ts'
import { tagMapFor } from '../services/userListService.ts'
import { tagForAccount } from '../services/tagService.ts'
import {
  commitNotifications, prepareNotifications, sendOutbound, type DeliverableNotification,
} from './delivery.ts'
import {
  KIND_LABELS, REFERENDUM_PHASES, TC_MOTION_PHASES,
  type NotificationKind, type RuleParams, type SafetyKind,
} from './notificationRules.ts'
import {
  getWormholeAlertState, getWormholeSnapshotGeneration, type WormholeAlertState,
} from '../services/wormholeNttService.ts'
import {
  activeRulesByKind, armStateKey, channelsFor, getChannel, getNotificationState, setNotificationState,
  type NotificationChannel, type NotificationRule,
} from './notificationStore.ts'
import { resolveActivityTarget } from './ruleTargets.ts'
import {
  account as accountPart, amount as amountPart, code as codePart, compactAmount, compactUsd,
  humanDuration, renderList, renderNotification, shortHash, text as textPart, usd as usdPart,
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
// Upper bound on outbound messages per rule per tick (see outboundGroups): a
// catch-up window holds dozens of blocks and must not arrive as a push burst.
export const MAX_OUTBOUND_SENDS = 5
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
// How long one outbound message shadows an identical one (see claimOutbound).
// Long enough to cover the lanes drifting apart — two rules matching one event
// can land in different ticks, because each kind carries its own cursor — and
// short enough that a genuinely recurring alert is never swallowed.
const OUTBOUND_DEDUP_MS = 10 * 60_000

export interface BlockWindow { from: number; to: number }

// Clamp the window and report what the clamp skipped. `from` is exclusive,
// `to` inclusive.
export function resolveWindow(cursor: number, head: number): { window: BlockWindow; skipped: number } {
  const to = Math.max(cursor, head)
  const from = to - cursor > MAX_WINDOW_BLOCKS ? to - MAX_WINDOW_BLOCKS : cursor
  return { window: { from, to }, skipped: from - cursor }
}

export const inWindow = (blockHeight: number, w: BlockWindow): boolean => blockHeight > w.from && blockHeight <= w.to

/**
 * How far a FEED-BACKED lane may advance its cursor: only as far as its source
 * has demonstrably reached.
 *
 * The cursor is anchored on the raw ingestion head, but the activity feed is
 * keyed and built on its own head (`indexedRawHead` — all pipelines, a 1.5s
 * cache, plus an SSE-published floor), and ClickHouse gives no ordering between
 * the insert that moves `raw_ingestion_state` and the inserts that carry a
 * block's rows. A window can therefore name blocks the page provably could not
 * have contained, and because the cursor only moves forward, stepping over them
 * loses them for good rather than late.
 *
 * Clamping holds those blocks back for the next window to re-read. It never
 * regresses below `from`: the lane has already accounted for everything at or
 * below its own cursor.
 */
export function windowCoveredTo(window: BlockWindow, sourceHead: number): number {
  return Math.max(window.from, Math.min(window.to, sourceHead))
}

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
  /** Executed phase only: how the enactment went (see enactmentOutcomeFrom). */
  outcome?: 'ok' | 'failed' | 'unavailable' | null
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
  | { lane: 'dca-start'; row: DcaScheduleRow; hourlyUsd: number; perExecutionUsd: number
      /** Budget of the sold asset in USD; null for an unbounded schedule. */
      totalUsd: number | null
      /** Planned executions — exact for a Sell, USD-estimated for a Buy. */
      executions: number | null
      periodMs: number; runtimeMs: number | null }
  | { lane: 'safety-state'; event: SafetyStateEvent; symbol: string; chainName: string
      /** Deficit only: how much minted supply has no custody behind it. */
      deficitUsd?: number
      /** Queue events only. */
      digest?: string; amount?: number; releasableAt?: string | null
      /** Fuse only: which leg, how spent it is, and what it is spending. */
      direction?: FuseDirection; utilizationPct?: number; limit?: number; durationSec?: number }

/** A DCA schedule as it was created: the standing order, not any one execution. */
export interface DcaScheduleRow {
  id: number
  blockHeight: number
  who: string
  assetIn: number
  assetOut: number
  /** 'Sell' prices `amountPer` in assetIn, 'Buy' in assetOut — the MV writes whichever leg was fixed. */
  direction: string
  amountPer: string
  /** '0' on chain means unbounded. */
  totalAmount: string
  periodBlocks: number
}

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

// Two DIFFERENT rules routinely describe one on-chain event: a large-trade
// floor and an account-activity rule on a tag the trader belongs to both match
// the same swap, and the reader's phone buzzes once per rule with the same
// words. What identifies a buzz is its wording AT A BLOCK — rules whose wording
// differs are telling the reader different things and both still arrive, and
// the block keeps a rule's OWN per-block messages apart when a catch-up window
// renders several of them identically ("2 × Event matcher" for block after
// block), which the outbound split exists to separate.
export function outboundIdentity(accountId: string, blockHeight: number, message: RenderedNotification): string {
  return createHash('sha256')
    // NUL-joined: a body is free text that may hold any printable separator,
    // so the one byte it cannot hold is what keeps the encoding injective.
    .update([accountId, String(blockHeight), message.path, message.title, message.body].join('\0'))
    .digest('hex')
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

// 'dca' is not a row type. The feed categorises DCA executions under the Trade
// chip and keeps a `dca` flag for the badge — `normalizeActivityTypeKey` maps the
// FETCH the same way — so a rule naming 'dca' means "a trade row carrying the
// flag". Comparing the rule's word to `row.type` ('dca' === 'trade') matched
// nothing and silenced every dca rule outright.
const activityTypeSelects = (row: ActivityRow, type: string): boolean =>
  type === 'dca' ? row.type === 'trade' && row.dca === true : activityTypeMatchesFamily(row.type, type)

export function evaluateAccountActivity(rows: readonly ActivityRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['account-activity']
    const type = activityTypeForFeed(p.type)
    return matchRows(rows, rule, window, r => r.blockHeight, activityIdentity,
      r => isFinalRow(r)
        && (type === 'all' || activityTypeSelects(r, type))
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

// What the protocol itself earned on this extrinsic, LP share excluded.
//
// A row whose revenue is not known yet must NOT read as 0: the field is absent until
// the block's events are queryable, and the lane's cursor only moves forward — deciding
// "no match" now would drop the row for good. Returning false leaves it to the tick
// that sees the revenue, because the cursor is already clamped to the source head.
export function revenueRowMatches(row: ActivityRow, params: RuleParams['protocol-revenue']): boolean {
  return row.revenue != null && row.revenue.protocolUsd >= params.minUsd
}

// A liquidation is money-market activity whose action is the liquidation call itself;
// borrows and supplies against the same market are not liquidations. An unvalued row
// still counts when no floor was set, but never passes a floor the owner chose.
export function liquidationRowMatches(row: ActivityRow, params: RuleParams['liquidation']): boolean {
  if (row.type !== 'mm' || row.mmAction !== 'LiquidationCall') return false
  if (params.minUsd == null) return true
  return row.valueUsd != null && row.valueUsd >= params.minUsd
}

export function evaluateProtocolRevenue(rows: readonly ActivityRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['protocol-revenue']
    return matchRows(rows, rule, window, r => r.blockHeight, activityIdentity,
      r => isFinalRow(r) && revenueRowMatches(r, p),
      row => ({ lane: 'activity', row }))
  })
}

export function evaluateLiquidations(rows: readonly ActivityRow[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['liquidation']
    return matchRows(rows, rule, window, r => r.blockHeight, activityIdentity,
      r => isFinalRow(r) && liquidationRowMatches(r, p),
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

/* ============ the security delivery matrix ============ */

// There is ONE security kind, fed by two lanes, and every event has exactly one
// of them as its path. Nothing below is a preference: an event reachable from
// both lanes would be delivered twice to the same subscriber, with two different
// identities, and no amount of deduplication downstream could collapse them.
//
//   event              | ROW lane (indexed Security ledger) | SNAPSHOT lane (bridge state)
//   -------------------+------------------------------------+------------------------------
//   limit              | yes, incl. Wormhole manager limits  | never
//   pause / unpause    | yes — HYDRATION side only, incl.    | ORIGIN side only
//                      |   the local NTT managers            |
//   lockdown, freeze…  | yes                                 | never
//   queued             | HYDRATION-side queue logs (the two  | ORIGIN-side queues, from the
//                      |   TransferQueued topics)            |   monitor's queue set
//   released           | never (no log marks a release)      | yes, on a digest seen held
//   deficit            | never (not an indexed fact at all)  | yes
//   fuse               | never (an origin limiter's level)   | yes
//
// The two pause halves are what makes this delicate: the snapshot carries BOTH
// flags, and reporting its `pausedLocal` would restate the ledger's own row.
// `safetySnapshotMatches` therefore reads the origin flag only.
//
// One thing must never reach either lane: a GAP-CLOSING MINT. Those are sent to
// the dead address (0x…dEaD), so they raise `Tokens.TotalIssuance` and the
// dead-address balance by the same amount in the same block. The bridge monitor
// subtracts the second from the first before it computes a residual (see
// `classifyBacking`'s `burned` term), so the residual does not move and the
// deficit event stays silent. Anyone changing that subtraction is changing
// whether fixing a gap pages every subscriber about a gap.
export const SAFETY_ROW_LANE_KINDS: readonly SafetyKind[] = [
  'limit', 'pause', 'unpause', 'lockdown', 'lockdown-lifted', 'freeze', 'unfreeze', 'queued',
]
/** The events the bridge snapshot delivers; `queued` and the pause pair are split by SIDE, not by kind. */
export const SAFETY_SNAPSHOT_KINDS = ['deficit', 'queued', 'released', 'fuse', 'pause', 'unpause'] as const
export type SafetyStateEvent = typeof SAFETY_SNAPSHOT_KINDS[number]
/** Hydration-centric fuse legs: `in` is the entry limiter, `out` the release leg of an exit. */
export type FuseDirection = 'in' | 'out'

export function evaluateSafety(events: readonly SafetyEvent[], rules: readonly NotificationRule[], window: BlockWindow): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['safety']
    const kinds = p.kinds?.length ? new Set<string>(p.kinds) : null
    return matchRows(events, rule, window, e => e.blockHeight, safetyIdentity,
      e => !kinds || kinds.has(e.kind),
      event => ({ lane: 'safety', event }))
  })
}

// A referendum's dedup identity is (index, phase): one Confirmed is one
// notification however often an overlapping window re-evaluates it. Confirmation
// is the exception, because it is the one part of the lifecycle that REPEATS —
// support can fall away mid-period, aborting it back to deciding, and the
// referendum can enter confirmation again later. Keyed on the phase alone the
// second entry would carry the first one's id and the inbox, a ReplacingMergeTree
// on exactly that id, would swallow it. So those two phases key on their block,
// the same answer the `voted` phase needed in the TC lane.
const REPEATABLE_PHASES = new Set<ReferendumPhase>(['confirming', 'confirm-aborted'])
export function referendumIdentity(row: ReferendumEventRow): string {
  return REPEATABLE_PHASES.has(row.phase)
    ? `${row.index}:${row.phase}@${row.blockHeight}`
    : `${row.index}:${row.phase}`
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
    return matchRows(rows, rule, window, r => r.blockHeight, referendumIdentity,
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
  'protocol-revenue': readonly ActivityRow[]
  liquidation: readonly ActivityRow[]
  safety: readonly SafetyEvent[]
  referendum: readonly ReferendumEventRow[]
  'tc-motion': readonly TcMotionEventRow[]
  event: readonly ChainEventRow[]
  extrinsic: readonly ChainExtrinsicRow[]
}
export type RowLaneKind = keyof RowLaneRows
export const ROW_LANE_KINDS: RowLaneKind[] = ['account-activity', 'large-trade', 'large-transfer', 'protocol-revenue', 'liquidation', 'safety', 'referendum', 'tc-motion', 'event', 'extrinsic']

export function evaluateRowKind<K extends RowLaneKind>(
  kind: K, rows: RowLaneRows[K], rules: readonly NotificationRule[], window: BlockWindow,
  titleFor?: (index: number) => string | null,
): RuleMatch[] {
  switch (kind) {
    case 'account-activity': return evaluateAccountActivity(rows as RowLaneRows['account-activity'], rules, window)
    case 'large-trade':
    case 'large-transfer': return evaluateLargeValue(rows as RowLaneRows['large-trade'], rules, window)
    case 'protocol-revenue': return evaluateProtocolRevenue(rows as RowLaneRows['protocol-revenue'], rules, window)
    case 'liquidation': return evaluateLiquidations(rows as RowLaneRows['liquidation'], rules, window)
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

/** A boolean the lane watches for transitions rather than for a level. */
export interface FlagInput { key: string; value: boolean | null }
export interface FlagFlip { key: string; value: boolean; epoch: number }

/**
 * Edge-triggered evaluation of a boolean state.
 *
 * The persisted shape is the same `ArmState` the threshold lanes keep, so the
 * store's per-rule row and its deletion-with-the-rule work unchanged: here
 * `lastValue` carries the last observed flag as 1 or 0 and `armed` is always
 * true (a flag has no hysteresis band to re-arm through).
 *
 * First sight only records — a rule created while a manager is already paused
 * waits for a genuine flip, the same rule `evaluateThreshold` follows — and an
 * unreadable flag changes nothing at all.
 */
export function evaluateStateFlip(
  inputs: readonly FlagInput[],
  prev: ReadonlyMap<string, ArmState>,
): { fired: FlagFlip[]; next: Map<string, ArmState> } {
  const fired: FlagFlip[] = []
  const next = new Map<string, ArmState>()
  for (const input of inputs) {
    if (input.value == null) continue
    const now = input.value ? 1 : 0
    const cur = prev.get(input.key)
    if (!cur || cur.lastValue == null) {
      next.set(input.key, { armed: true, lastValue: now, epoch: cur?.epoch ?? 0 })
      continue
    }
    if (cur.lastValue === now) continue
    const epoch = cur.epoch + 1
    fired.push({ key: input.key, value: input.value, epoch })
    next.set(input.key, { armed: true, lastValue: now, epoch })
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
  submitted: 'submitted', deciding: 'entered its decision period',
  // Named for the transition, not the state, so the pair cannot be misread as
  // one another: a referendum that ENTERED confirmation has not been confirmed.
  confirming: 'entered its confirmation period',
  'confirm-aborted': 'fell out of confirmation, back to deciding',
  confirmed: 'confirmed',
  executed: 'executed', rejected: 'rejected', cancelled: 'cancelled', 'timed-out': 'timed out', killed: 'killed',
}

// Asset ids in human-facing summaries read as tickers, from the same registry
// the rest of the api renders symbols from.

// When a rate-limited transfer can be let out. Anyone may call the release once
// the window has opened, which is the actionable part of the message.
export function wormholeReleaseText(releasableAt: string | null, nowMs = Date.now()): string {
  const at = releasableAt ? Date.parse(releasableAt) : NaN
  if (!Number.isFinite(at)) return 'held until the limiter releases it'
  return at <= nowMs ? 'releasable now' : `releasable in ${humanDuration(at - nowMs)}`
}

// One match → the {title, body, path} the shared renderer turns into all three
// surfaces. Pure: everything it needs is already on the match.
// `rule` is kept in the signature (every caller has one to hand and a lane may
// need it again) but no message is shaped by it now that the health-factor body
// no longer restates the rule description.
export function renderMatch(match: RuleMatch, _rule: NotificationRule, viewerTag: ViewerTag): RenderInput {
  const p = match.payload
  switch (p.lane) {
    case 'activity': {
      const row = p.row
      const title: RenderPart[] = [textPart(activityHeadline(row))]
      if (row.who) title.push(textPart('by'), accountPart(renderAccount(row.who, viewerTag)))
      const body: (string | RenderPart[])[] = [activityAmountLine(row, viewerTag)]
      // Only the lanes that watch revenue ask the feed to attach it, so the field's
      // presence is the signal that this alert is about revenue — no need to branch on
      // the rule's kind. Absent means nobody computed it (a lane that opted out, or a
      // block whose events are not queryable yet), which is not the same as $0.00.
      if (row.revenue) {
        body.push([textPart('Protocol revenue'), usdPart(row.revenue.protocolUsd)])
      }
      return { title, body, path: activityPath(row) }
    }
    case 'safety':
      return {
        title: [textPart(p.event.label)],
        body: [p.event.detail],
        path: '/security',
      }
    case 'referendum': {
      // What the proposal IS matters more than which phase boundary it crossed,
      // so the headline carries the title and the state change reads underneath.
      // With no title yet (the submitted phase parks until one exists) the state
      // change is all there is, and becomes the headline.
      // An enactment's message says how it went — a failed call is exactly what
      // a subscriber wants to hear about, and 'executed' would paper over it.
      const phaseText = p.row.phase === 'executed'
        ? p.row.outcome === 'failed' ? 'executed — the call FAILED'
          : p.row.outcome === 'unavailable' ? 'approved, but its call was unavailable at enactment'
            : 'executed'
        : PHASE_LABEL[p.row.phase]
      const change = `Referendum #${p.row.index} ${phaseText}`
      return {
        title: [textPart(p.title || change)],
        body: p.title ? [change] : [],
        path: `/referendum/opengov/${p.row.index}`,
      }
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
        body: [],
        path: `/event/${p.row.blockHeight}-${p.row.eventIndex}`,
      }
    case 'extrinsic': {
      const title: RenderPart[] = [textPart(p.row.success ? 'Extrinsic' : 'Failed extrinsic'), codePart(p.row.callName)]
      const body: (string | RenderPart[])[] = []
      if (p.row.signer) body.push([textPart('Signed by'), accountPart(renderAccount(p.row.signer, viewerTag))])
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
    case 'dca-start': {
      const row = p.row
      const inSym = assetDescriptor(row.assetIn).symbol
      const outSym = assetDescriptor(row.assetOut).symbol
      const title: RenderPart[] = [textPart(`DCA started ${inSym} → ${outSym}`)]
      if (row.who) title.push(textPart('by'), accountPart(renderAccount(accountRef(row.who), viewerTag)))
      // The notification states the PLAN: what each trade moves, how often, and
      // what the first hour adds up to — which is the figure the rule matched on
      // (the hourly rate capped by the budget, so a small bounded schedule never
      // reads as its extrapolated rate).
      const plan: RenderPart[] = [
        usdPart(p.perExecutionUsd), textPart(`per trade every ${humanDuration(p.periodMs)} · first hour ≈`), usdPart(p.hourlyUsd),
      ]
      // The size line: the budget bounds it, or nothing does.
      const size: RenderPart[] = p.totalUsd == null
        ? [textPart('Unbounded schedule')]
        : [
            textPart('Budget ≈'), usdPart(p.totalUsd),
            ...(p.executions != null && p.runtimeMs != null
              ? [textPart(`· ~${compactAmount(p.executions)} executions over ~${humanDuration(p.runtimeMs)}`)]
              : []),
          ]
      return { title, body: [plan, size], path: `/dca/${row.id}` }
    }
    case 'safety-state': {
      // Every one of these is a statement about the bridge's own state, so they
      // all open the same page; the headline carries which asset and which leg.
      const path = '/security/wormhole'
      if (p.event === 'deficit') {
        return {
          title: [textPart(`${p.symbol} backing deficit`)],
          body: [[usdPart(p.deficitUsd ?? 0), textPart(`of ${p.symbol} supply has no custody behind it on ${p.chainName}.`)]],
          path,
        }
      }
      if (p.event === 'queued' || p.event === 'released') {
        const held = p.event === 'queued'
        const when = wormholeReleaseText(p.releasableAt ?? null)
        return {
          title: [textPart(`${p.symbol} ${held ? 'held by' : 'released by'} ${p.chainName}'s rate limiter`)],
          body: [[
            amountPart(p.amount ?? 0, p.symbol),
            textPart(held ? `· ${when}` : '· the transfer has left custody'),
          ], [codePart(shortHash(p.digest ?? ''))]],
          path,
        }
      }
      if (p.event === 'fuse') {
        // The fuse fires BEFORE the limit binds, so the message has to say what
        // happens past it — the queue is the consequence somebody acts to avoid.
        const leg = p.direction === 'out' ? 'release' : 'entry'
        const window = humanDuration((p.durationSec ?? 0) * 1000)
        return {
          title: [textPart(`${p.symbol} ${leg} fuse nearly spent`)],
          body: [[
            textPart(`The ${p.chainName} ${leg} fuse for ${p.symbol} is at ${compactAmount(p.utilizationPct ?? 0)}% of its`),
            amountPart(p.limit ?? 0, p.symbol),
            textPart(`per ${window} limit — beyond it, transfers are held for ${window}.`),
          ]],
          path,
        }
      }
      // Only the ORIGIN manager's flag reaches this lane; a Hydration-side pause
      // is an indexed log and arrives on the ledger (see the delivery matrix).
      const paused = p.event === 'pause'
      return {
        title: [textPart(`${p.symbol} Wormhole transfers ${paused ? 'paused' : 'resumed'}`)],
        body: [paused
          ? `The ${p.symbol} manager on ${p.chainName} is paused, so no ${p.symbol} can cross the bridge in either direction.`
          : `The ${p.symbol} manager on ${p.chainName} is running again.`],
        path,
      }
    }
    case 'health-factor': {
      const title: RenderPart[] = [textPart(`Health factor ${compactAmount(p.value)}`)]
      if (p.account) title.push(textPart('—'), accountPart(renderAccount(p.account, viewerTag)))
      return {
        title,
        // The headline already names the value and whose position it is, so the
        // body states the threshold once and stops. Appending the rule
        // description repeated both, mid-sentence and lowercase.
        body: [[textPart(`Below the ${compactAmount(p.threshold)} you set.`)]],
        path: `/account/${encodeURIComponent(p.account?.address ?? p.address)}`,
      }
    }
  }
}

/** The asset `amountPer` is denominated in, per direction — `totalAmount` is
 * NOT this asset on a Buy: the budget is always the sold asset (assetIn). */
export const dcaPricedAsset = (row: DcaScheduleRow): number =>
  (row.direction === 'Buy' ? row.assetOut : row.assetIn)

/**
 * Matches DCA *starts* for the large-trade rules that want them. A schedule is a
 * standing order, so it is judged on what an hour of it is worth rather than on
 * any single execution, and it alerts once — identity is the schedule id.
 *
 * `dcaStart: false` opts a rule out. The asset scope matches either leg, the same
 * way `activityReferencesAsset` treats a swap.
 */
export function evaluateDcaStart(
  rows: readonly DcaScheduleRow[],
  rules: readonly NotificationRule[],
  window: BlockWindow,
  valueUsd: (assetId: number, raw: string) => number | null,
  blockMs: number,
): RuleMatch[] {
  return rules.flatMap(rule => {
    const p = rule.params as RuleParams['large-trade']
    if (p.dcaStart === false) return []
    return matchRows(rows, rule, window, r => r.blockHeight, r => `dca:${r.id}`,
      row => {
        if (p.assetId != null && row.assetIn !== p.assetId && row.assetOut !== p.assetId) return false
        return dcaHourly(row, valueUsd, blockMs).hourlyUsd >= p.minUsd
      },
      row => {
        const plan = dcaHourly(row, valueUsd, blockMs)
        return {
          lane: 'dca-start', row,
          hourlyUsd: plan.hourlyUsd, perExecutionUsd: plan.perExecutionUsd, totalUsd: plan.totalUsd,
          executions: plan.executions, periodMs: row.periodBlocks * blockMs,
          runtimeMs: plan.executions == null || plan.executions <= 0
            ? null
            : plan.executions * row.periodBlocks * blockMs,
        }
      })
  })
}

export function dcaHourly(
  row: DcaScheduleRow, valueUsd: (assetId: number, raw: string) => number | null, blockMs: number,
): { hourlyUsd: number; perExecutionUsd: number; totalUsd: number | null; executions: number | null } {
  // The two figures live in DIFFERENT denominations on a Buy: `amountPer` fixes
  // the bought leg (assetOut) while `totalAmount` is always the BUDGET of the
  // sold asset (assetIn) — the pallet reserves the spend currency. Pricing both
  // with one asset made a 192k-HDX ($1.4k) budget read as ~$10^11 of USDT, so
  // the min(rate, budget) cap never bit and a $1.4k schedule alerted as $81.6k/h.
  const perExecutionUsd = valueUsd(dcaPricedAsset(row), row.amountPer) ?? 0
  const totalRaw = toBigIntOrNull(row.totalAmount)
  const totalUsd = totalRaw == null || totalRaw === 0n ? null : valueUsd(row.assetIn, row.totalAmount)
  return {
    hourlyUsd: dcaHourlyValueUsd(perExecutionUsd, totalUsd, row.periodBlocks, blockMs),
    perExecutionUsd,
    totalUsd,
    executions: dcaExecutionsPlanned(row, perExecutionUsd, totalUsd),
  }
}

/**
 * How many executions the schedule plans. Exact for a Sell (both figures share
 * assetIn, so the raw division is unitless); estimated through USD for a Buy
 * (the budget buys a price-dependent number of fixed-size purchases); null for
 * an unbounded schedule or when the estimate has no price to stand on.
 */
export function dcaExecutionsPlanned(
  row: DcaScheduleRow, perExecutionUsd: number, totalUsd: number | null,
): number | null {
  const per = toBigIntOrNull(row.amountPer)
  const total = toBigIntOrNull(row.totalAmount)
  if (per == null || total == null || per === 0n || total === 0n) return null
  if (row.direction !== 'Buy') return Number(total / per)
  return totalUsd != null && perExecutionUsd > 0 ? Math.max(1, Math.floor(totalUsd / perExecutionUsd)) : null
}

const toBigIntOrNull = (raw: string): bigint | null => {
  try { return BigInt(raw) } catch { return null }
}

/**
 * What an hour of a DCA schedule is actually worth, in USD.
 *
 * Its RATE alone overstates a short burst — a three-execution schedule reads as
 * thousands per hour while only ever moving a few hundred — and its TOTAL alone
 * ignores a large slow schedule that pushes real size every hour. The lower of
 * the two is the honest answer. `totalUsd` null means the schedule is unbounded
 * (`total_amount` 0 on chain), where only the rate bounds it.
 */
export function dcaHourlyValueUsd(
  perExecutionUsd: number, totalUsd: number | null, periodBlocks: number, blockMs: number,
): number {
  if (!(perExecutionUsd > 0) || !(periodBlocks > 0) || !(blockMs > 0)) return 0
  const rate = perExecutionUsd * 3_600_000 / (periodBlocks * blockMs)
  return totalUsd == null ? rate : Math.min(rate, totalUsd)
}

/**
 * How a rule's matches for one tick become outbound messages. Matches sharing a
 * block are ONE event and merge; matches in different blocks are different events
 * and must not be — a 6s tick spans more than one ~4.8s block, so collapsing the
 * whole tick turned unrelated swaps into a single digest.
 *
 * Over `maxSends` the OLDEST blocks collapse into one leading digest, because a
 * catch-up window (the 600-block clamp, or a rewound cursor) holds dozens of
 * blocks and one push each would arrive as a burst. Nothing is dropped and chain
 * order is preserved. Input must be sorted oldest-first.
 */
export function outboundGroups<T extends { blockHeight: number }>(matches: readonly T[], maxSends: number): T[][] {
  if (!matches.length) return []
  const byBlock: T[][] = []
  for (const match of matches) {
    const last = byBlock[byBlock.length - 1]
    if (last && last[0].blockHeight === match.blockHeight) last.push(match)
    else byBlock.push([match])
  }
  if (byBlock.length <= maxSends) return byBlock
  const keep = Math.max(1, maxSends - 1)
  return [byBlock.slice(0, byBlock.length - keep).flat(), ...byBlock.slice(byBlock.length - keep)]
}

// One message for several matches of one rule. `total` is how many matches the
// digest stands for, which is not `rendered.length`: only the few matches the
// message lists by name are ever rendered, so a rule that matched thousands of
// rows costs five renders.
export function renderDigest(rule: NotificationRule, entries: readonly RenderInput[], total = entries.length): RenderedNotification {
  // Entries arrive as INPUTS, not rendered text: renderList needs their parts and
  // their own paths to keep each bullet's links (the entry's page, and any account
  // in it). Only the few a digest lists are ever built, so a rule that matched
  // thousands of rows still costs five renders.
  const listed = entries.slice(0, COALESCE_LIST)
  return renderList({
    title: [textPart(`${total} × ${KIND_LABELS[rule.kind]}`)],
    path: '/notifications',
    entries: listed,
    more: total - listed.length,
  })
}

/* ============ the loop ============ */

const counters = {
  ticks: 0, errors: 0, seeded: 0, skippedBlocks: 0, truncatedPages: 0,
  matches: 0, delivered: 0, coalesced: 0, cooldownSuppressed: 0,
  deferredGroups: 0, sourceFetches: 0, digested: 0, outboundDuplicates: 0,
}
export function evaluatorCounters(): Readonly<typeof counters> { return { ...counters } }

let client: ClickHouseClient | null = null
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false
let tick = 0
// The Wormhole snapshot generation the security half of the snapshot lane last
// ran against. -1 so the first tick always runs it, whatever the monitor has
// already published.
let lastSecurityGeneration = -1
const lastSendAtMs = new Map<string, number>()
// When each recently sent message was last delivered, keyed by outboundIdentity.
const lastOutboundAtMs = new Map<string, number>()

/**
 * Claims the right to send `message` to `accountId`, false when an identical
 * one already went out inside the dedup window.
 *
 * Deliberately NOT part of the inbox path: the inbox stays a complete per-rule
 * ledger — the same split the cooldown already makes, where a muffled rule
 * still records everything it matched — so a reader can always see which of
 * their alerts fired. Only the buzz is collapsed.
 */
function claimOutbound(send: PendingSend, nowMs: number): boolean {
  // Swept here rather than on a timer: the map only grows when something is
  // sent, so the send path is the only place it can need collecting.
  if (lastOutboundAtMs.size > 512) {
    for (const [key, at] of lastOutboundAtMs) {
      if (nowMs - at > OUTBOUND_DEDUP_MS) lastOutboundAtMs.delete(key)
    }
  }
  const key = outboundIdentity(send.accountId, send.blockHeight, send.message)
  const last = lastOutboundAtMs.get(key)
  if (last != null && nowMs - last <= OUTBOUND_DEDUP_MS) return false
  lastOutboundAtMs.set(key, nowMs)
  return true
}
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
  lastSecurityGeneration = -1
  lastSendAtMs.clear()
  lastOutboundAtMs.clear()
  cursors.clear()
  dirtyCursors.clear()
  parked = null
  parkedDirty = false
  rotation.clear()
  cursorsPersistedAtMs = 0
  seenOriginQueued.clear()
  originQueuedMemo.clear()
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
    // The bridge monitor publishes in steps, so the security half of the
    // snapshot lane follows its generation counter as well as the rhythm — an
    // integer compare, no I/O, on a tick that would otherwise do nothing.
    const generation = getWormholeSnapshotGeneration()
    const onRhythm = tick % SNAPSHOT_EVERY_TICKS === 1
    const security = onRhythm || generation !== lastSecurityGeneration
    if (security) lastSecurityGeneration = generation
    const snapshot = onRhythm || security ? await runSnapshotLane({ values: onRhythm, security }) : []
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
      // it rather than stepping over its rows. Blocks the SOURCE has not revealed
      // yet wait the same way (see windowCoveredTo).
      const covered = windowCoveredTo(window, (await visibleSourceHead()) ?? window.to)
      return { kind, matches, nextCursor: deferred ? cursor : covered }
    }
    case 'large-trade':
    case 'large-transfer': {
      const feedType = kind === 'large-trade' ? 'trade' : 'transfer'
      const { matches, deferred } = await largeValueMatches(kind, feedType, rules, window, { left: SOURCE_FETCH_CAP })
      // A large-trade rule also watches DCA STARTS: a standing order pushing this
      // much per hour is the same event to a subscriber as one big swap. Only the
      // trade kind has schedules to watch, and a deferred fetch must not let the
      // cursor step over them either.
      const dca = kind === 'large-trade' ? await dcaStartMatches(rules, window) : []
      const covered = windowCoveredTo(window, (await visibleSourceHead()) ?? window.to)
      return { kind, matches: [...matches, ...dca], nextCursor: deferred ? cursor : covered }
    }
    case 'protocol-revenue':
    case 'liquidation': {
      const { matches, deferred } = kind === 'protocol-revenue'
        ? await protocolRevenueMatches(rules, window, { left: SOURCE_FETCH_CAP })
        : await liquidationMatches(rules, window, { left: SOURCE_FETCH_CAP })
      // Same source as the large-value lanes, so the same rule applies: never step
      // the cursor past the blocks that source has actually shown.
      const covered = windowCoveredTo(window, (await visibleSourceHead()) ?? window.to)
      return { kind, matches, nextCursor: deferred ? cursor : covered }
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
  limit: number, filters: { min?: number; unit?: 'usd' }, type = 'all',
  opts: { revenue?: boolean } = { revenue: false },
): Promise<ActivityRow[] | null> {
  switch (target.kind) {
    case 'address': return getAddressActivity(target.address, type, limit, 0, undefined, filters, undefined, undefined, opts)
    case 'tag': return getTagActivity(target.tagId, type, limit, 0, undefined, filters, undefined, undefined, opts)
    default: {
      const resolved = resolveActivityTarget(viewer, target)
      if (!resolved) return []
      return getListTagActivity(target.listId, target.tagId, resolved.members, type, limit, 0, undefined, filters, undefined, undefined, opts)
    }
  }
}

// Both new lanes read the activity feed the large-value lanes already read, so
// neither adds a source. Revenue is opt-in per page (it costs a read of its own), and
// these are the only lanes that ask for it: a liquidation message reports the revenue
// the liquidation produced, which is most of the point of watching one.
async function protocolRevenueMatches(
  rules: NotificationRule[], window: BlockWindow, budget: FetchBudget,
): Promise<{ matches: RuleMatch[]; deferred: boolean }> {
  // No server-side revenue filter exists, so every rule reads the SAME page whatever
  // its floor — one group, one fetch, floors applied per rule in the evaluator.
  const groups = groupRules(rules, () => 'all')
  const bounds = await windowDayBounds(window)
  return visitGroups('protocol-revenue', groups, budget, async group => {
    const rows = await fetchActivityPage(
      limit => getRecentActivity(limit, bounds?.from, bounds?.to, 0, 'all', {}, undefined, FORWARD_ONLY_REVENUE_PAGE),
      window)
    return evaluateProtocolRevenue(rows, group, window)
  })
}

async function liquidationMatches(
  rules: NotificationRule[], window: BlockWindow, budget: FetchBudget,
): Promise<{ matches: RuleMatch[]; deferred: boolean }> {
  // The fetch differs only by target, so rules sharing one target share a page. An
  // untargeted rule watches the whole chain and reads the plain mm feed.
  const groups = groupRules(rules, rule => {
    const target = (rule.params as RuleParams['liquidation']).target
    if (!target) return 'chain'
    return activitySourceKey({ ...rule, params: { ...rule.params as object, target } } as NotificationRule) ?? 'unreadable'
  })
  const bounds = await windowDayBounds(window)
  return visitGroups('liquidation', groups, budget, async group => {
    const target = (group[0].params as RuleParams['liquidation']).target
    const rows = await fetchActivityPage(limit => target
      ? fetchTargetActivity(target, group[0].accountId, limit, {}, 'mm', { revenue: true })
      : getRecentActivity(limit, bounds?.from, bounds?.to, 0, 'mm', {}, undefined, FORWARD_ONLY_REVENUE_PAGE),
      window)
    return evaluateLiquidations(rows, group, window)
  })
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

// How every lane that reads the GLOBAL feed must ask for its page.
//
// `forwardOnly` is the load-bearing half: these lanes day-bound their fetch (a
// sparse floor walks all history otherwise), and a dated read is served the
// shared classified window — stale-while-revalidate, on a key that carries no
// head. Their cursor tracks the live head every tick, so a row that landed while
// that window was fresh sat below the cursor by the time it appeared and was
// never seen again. Measured live 2026-08-21: 66 trades cleared a $500 HDX floor
// and ONE of them notified; every one of the ten ~$1.1k DCA executions of
// schedule 33789 that day was silent. Declaring the reader forward-only puts the
// page on the head-keyed window: one build per block, complete when it is read.
//
// `revenue` stays per lane — only the two revenue-reading lanes pay for it.
const FORWARD_ONLY_PAGE = { revenue: false, forwardOnly: true } as const
const FORWARD_ONLY_REVENUE_PAGE = { revenue: true, forwardOnly: true } as const

async function largeValueMatches(
  kind: 'large-trade' | 'large-transfer', feedType: 'trade' | 'transfer',
  rules: NotificationRule[], window: BlockWindow, budget: FetchBudget,
): Promise<{ matches: RuleMatch[]; deferred: boolean }> {
  const groups = groupRules(rules, rule => largeValueKey(rule.params as RuleParams['large-trade']))
  // The feed walks HISTORY until `limit` rows clear the value floor — and a rule
  // whose floor matches almost nothing (a $10k floor on one token) walks past
  // the read guard and throws too-broad on every tick, wedging the whole lane
  // behind one rule. Day-bounding the fetch to the window's own days caps the
  // walk absolutely; the rows are block-filtered to the exact window by
  // evaluateLargeValue either way. A missing bound (block not in the blocks
  // table yet) falls back to the unbounded fetch rather than skipping the tick.
  const bounds = await windowDayBounds(window)
  return visitGroups(kind, groups, budget, async group => {
    const params = group.map(r => r.params as RuleParams['large-trade'])
    const min = Math.min(...params.map(p => p.minUsd))
    const assetId = params[0].assetId
    const filters = { min, unit: 'usd' as const, ...(assetId == null ? {} : { token: String(assetId) }) }
    // No large-value rule reads revenue, so this lane must not pay for attaching it.
    const rows = await fetchActivityPage(limit => getRecentActivity(limit, bounds?.from, bounds?.to, 0, feedType, filters, undefined, FORWARD_ONLY_PAGE), window)
    return evaluateLargeValue(rows, group, window)
  })
}

// The window's block range as feed day bounds (the feed's time filter is
// day-granular), so a windowed fetch scans at most two days instead of walking
// all history for a rare match. null when either boundary block has no row yet.
async function windowDayBounds(window: BlockWindow): Promise<{ from: string; to: string } | null> {
  if (!client) return null
  try {
    const res = await client.query({
      query: `SELECT toString(toDate(min(block_timestamp))) AS f, toString(toDate(max(block_timestamp))) AS t, count() AS n
              FROM price_data.blocks WHERE block_height IN ({from:UInt32}, {to:UInt32})`,
      query_params: { from: Math.max(window.from, 1), to: window.to },
      format: 'JSONEachRow',
    })
    const row = (await res.json<{ f: string; t: string; n: string }>())[0]
    if (!row || Number(row.n) < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(row.f)) return null
    return { from: row.f, to: /^\d{4}-\d{2}-\d{2}$/.test(row.t) ? row.t : row.f }
  } catch { return null }
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

export const REFERENDUM_PHASE_BY_EVENT: Record<string, ReferendumPhase> = {
  'Referenda.Submitted': 'submitted',
  'Referenda.DecisionStarted': 'deciding',
  'Referenda.ConfirmStarted': 'confirming',
  'Referenda.ConfirmAborted': 'confirm-aborted',
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

// Enactments are Scheduler events that name their TASK, never their referendum
// — the task id is a one-way hash — so the lane runs the hash the other way:
// every known referendum index's enactment task id, grown as the chain mints
// new indexes, matched against the window's named dispatches. ~400 blake2
// hashes once, then a Map hit per dispatch.
const enactmentTaskIndex = new Map<string, number>()
let enactmentTasksBuiltTo = -1
function enactmentIndexFor(taskId: string, maxIndex: number): number | undefined {
  for (let i = enactmentTasksBuiltTo + 1; i <= maxIndex; i++) enactmentTaskIndex.set(referendumEnactmentTaskId(i), i)
  enactmentTasksBuiltTo = Math.max(enactmentTasksBuiltTo, maxIndex)
  return enactmentTaskIndex.get(taskId)
}

// The window's enactments as 'executed' phase rows. The dispatches table is
// small (one row per named scheduler dispatch), and most windows have none.
async function queryWindowEnactments(window: BlockWindow): Promise<ReferendumEventRow[]> {
  if (!client) return []
  const res = await client.query({
    query: `SELECT task_id, block_height, event_index, event_name, args_json
            FROM price_data.scheduler_named_dispatches
            WHERE block_height > {from:UInt32} AND block_height <= {to:UInt32}
            ORDER BY block_height, event_index`,
    query_params: { from: window.from, to: window.to },
    format: 'JSONEachRow',
  })
  const dispatches = await res.json<{ task_id: string; block_height: number; event_index: number; event_name: string; args_json: string }>()
  if (!dispatches.length) return []
  const maxRes = await client.query({
    query: `SELECT max(ref_index) AS ref_index FROM price_data.referendum_lifecycle_events WHERE pallet = 'opengov'`,
    format: 'JSONEachRow',
  })
  const maxIndex = (await maxRes.json<{ ref_index: number }>()).reduce((m, r) => Math.max(m, Number(r.ref_index)), -1)
  const out: ReferendumEventRow[] = []
  for (const d of dispatches) {
    const index = enactmentIndexFor(d.task_id, maxIndex)
    // Named dispatches that are not referendum enactments (other scheduled
    // tasks) simply do not resolve to an index.
    if (index == null) continue
    out.push({
      blockHeight: Number(d.block_height), eventIndex: Number(d.event_index),
      index, phase: 'executed', track: null,
      outcome: enactmentOutcomeFrom(d.event_name, d.args_json),
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
  const rows = [...await queryWindowReferenda(window), ...await queryWindowEnactments(window)]
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
// The DCA-start half of the large-trade lane: value each new schedule at
// event-time prices and hand it to the pure matcher. Prices come from the shared
// map the rest of the loop already uses; a schedule whose asset has no price
// values at 0 and simply does not clear any floor.
async function dcaStartMatches(rules: NotificationRule[], window: BlockWindow): Promise<RuleMatch[]> {
  const enabled = rules.filter(r => (r.params as RuleParams['large-trade']).dcaStart !== false)
  if (!enabled.length) return []
  const rows = await queryWindowDcaSchedules(window)
  if (!rows.length) return []
  const prices = await ensurePrices()
  const valueUsd = (assetId: number, raw: string): number | null => {
    const price = prices.get(assetId)?.price
    if (price == null) return null
    const human = humanAmount(raw, assetDescriptor(assetId).decimals)
    return human == null ? null : human * price
  }
  return evaluateDcaStart(rows, enabled, window, valueUsd, await paraBlockMsForEvaluator())
}

// The measured parachain slot, so a schedule's rate is not computed against a
// nominal 6s while the chain runs ~4.8s (and 2s is planned). Cached for a minute:
// it moves with runtime upgrades, not between ticks.
let blockMsCache: { ms: number; at: number } | null = null
async function paraBlockMsForEvaluator(): Promise<number> {
  if (blockMsCache && Date.now() - blockMsCache.at < 60_000) return blockMsCache.ms
  let ms = NOMINAL_PARA_BLOCK_MS
  try {
    if (client) {
      const res = await client.query({ query: avgBlockMsSql(), format: 'JSONEachRow' })
      const row = (await res.json<{ ms: number | string | null }>())[0]
      ms = clampBlockMs(Number(row?.ms))
    }
  } catch { ms = NOMINAL_PARA_BLOCK_MS }
  blockMsCache = { ms, at: Date.now() }
  return ms
}

// The newest block whose ROWS are actually visible, as opposed to the newest the
// ingestion state claims. Every block produces events and the activity views are
// filled by the same insert that fills raw_events, so this is a completeness
// watermark for every feed-backed lane — and unlike a source-specific max (the
// newest block that happened to hold a swap) it advances on every block, so a
// quiet stretch never strands the cursor behind the 600-block clamp.
async function visibleSourceHead(): Promise<number | null> {
  if (!client) return null
  try {
    const res = await client.query({
      query: 'SELECT max(block_height) AS head FROM price_data.raw_events',
      format: 'JSONEachRow',
    })
    const head = Number((await res.json<{ head: number | string | null }>())[0]?.head ?? 0)
    return Number.isFinite(head) && head > 0 ? head : null
  } catch { return null }
}

// DCA schedules created in the window, from the schedule-first projection (a few
// rows per schedule, so a block-window scan is cheap). `total_amount` '0' is an
// unbounded schedule and is carried through verbatim for the matcher to read.
async function queryWindowDcaSchedules(window: BlockWindow): Promise<DcaScheduleRow[]> {
  if (!client) return []
  const res = await client.query({
    query: `SELECT id, block_height, who, asset_in, asset_out, direction, amount_per, total_amount, period
            FROM price_data.dca_schedules
            WHERE block_height > {from:UInt32} AND block_height <= {to:UInt32}
            ORDER BY block_height DESC
            LIMIT {cap:UInt32}`,
    query_params: { from: window.from, to: window.to, cap: RAW_WINDOW_CAP },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{
    id: number | string; block_height: number; who: string; asset_in: number; asset_out: number
    direction: string; amount_per: string; total_amount: string; period: number
  }>()
  if (rows.length >= RAW_WINDOW_CAP) counters.truncatedPages++
  return rows.map(r => ({
    id: Number(r.id), blockHeight: r.block_height, who: r.who,
    assetIn: r.asset_in, assetOut: r.asset_out, direction: r.direction,
    amountPer: String(r.amount_per), totalAmount: String(r.total_amount), periodBlocks: r.period,
  }))
}

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

/**
 * Which halves of the snapshot lane this tick runs.
 *
 * The value triggers keep the fixed rhythm: a price and a health factor move
 * continuously, so there is no event to react to and a fifth of the ticks is the
 * resolution they were sized for.
 *
 * The security half is different — its source publishes in steps, and the step
 * is observable for free (an in-memory counter on the Wormhole monitor). So it
 * also runs on ANY tick where the monitor published a new snapshot, which takes
 * a confirmed backing shortfall from "up to 30s behind its snapshot" to "one 6s
 * tick behind it". The rhythm stays as the floor for everything a generation
 * bump does not cover.
 */
async function runSnapshotLane(run: { values: boolean; security: boolean }): Promise<RuleMatch[]> {
  const matches: RuleMatch[] = []
  if (run.values) {
    await guard('price', async () => { matches.push(...await priceMatches()) })
    await guard('health-factor', async () => { matches.push(...await healthFactorMatches()) })
  }
  if (run.security) {
    await guard('safety-state', async () => { matches.push(...await safetySnapshotMatches()) })
  }
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

  // Each rule's watched addresses: its one address, or the target tag's current
  // members (resolved live, so the membership follows the tag). A tag is capped:
  // every member costs a health-factor read per tick, and a rule on a 1,000
  // account tag would spend the whole tick budget on one subscriber. The cap
  // takes the tag's own member order.
  const MAX_TAG_MEMBERS = 50
  const watched = new Map<string, string[]>()
  for (const rule of rules) {
    const p = rule.params as RuleParams['health-factor']
    if (p.target.kind === 'address') { watched.set(rule.ruleId, [p.target.address]); continue }
    const resolved = resolveActivityTarget(rule.accountId, p.target)
    watched.set(rule.ruleId, (resolved?.members ?? []).slice(0, MAX_TAG_MEMBERS))
  }

  // One lookup per ADDRESS: several rules on one position (a warning threshold
  // and a panic threshold), or one address in several watched tags, still read
  // the same number once.
  const byAddress = new Map<string, number | null>()
  for (const address of new Set([...watched.values()].flat())) {
    // Unreadable is NOT zero: an address with no primary-market position, or a
    // position whose health factor cannot be read, must never look like an
    // imminent liquidation.
    byAddress.set(address, await getPrimaryHealthFactor(address).catch(() => null))
  }

  // Arm state is PER (rule, member) — one member crossing must not disarm the
  // rule for the others — but persisted as one row per rule (the same
  // armStateKey the store deletes with the rule): an address rule keeps the
  // legacy plain ArmState shape, a tag rule bundles `{ members: { addr: state } }`.
  const MEMBER_KEY_SEP = '\n'
  const prev = new Map<string, ArmState>()
  for (const rule of rules) {
    const raw = getNotificationState(armStateKey(rule.ruleId))
    const single = parseArmState(raw)
    const addresses = watched.get(rule.ruleId) ?? []
    if (single && addresses.length === 1) { prev.set(`${rule.ruleId}${MEMBER_KEY_SEP}${addresses[0]}`, single); continue }
    const bundled = parseMemberArmStates(raw)
    if (bundled) for (const [addr, state] of bundled) prev.set(`${rule.ruleId}${MEMBER_KEY_SEP}${addr}`, state)
  }

  const inputs: ThresholdInput[] = rules.flatMap(rule => {
    const p = rule.params as RuleParams['health-factor']
    return (watched.get(rule.ruleId) ?? []).map(address => ({
      ruleId: `${rule.ruleId}${MEMBER_KEY_SEP}${address}`,
      direction: 'below' as const, threshold: p.threshold,
      value: byAddress.get(address) ?? null,
    }))
  })
  const { fired, next } = evaluateThreshold(inputs, prev)

  // Group the changed member states back into their rule's one row. The row is
  // rewritten whole, so unchanged members must ride along or they would reset.
  const changedRules = new Set([...next.keys()].map(key => key.split(MEMBER_KEY_SEP)[0]))
  for (const ruleId of changedRules) {
    const addresses = watched.get(ruleId) ?? []
    const states = new Map<string, ArmState>()
    for (const address of addresses) {
      const key = `${ruleId}${MEMBER_KEY_SEP}${address}`
      const state = next.get(key) ?? prev.get(key)
      if (state) states.set(address, state)
    }
    const rule = rules.find(r => r.ruleId === ruleId)
    const isSingleAddress = rule && (rule.params as RuleParams['health-factor']).target.kind === 'address'
    const value = isSingleAddress && states.size === 1
      ? JSON.stringify([...states.values()][0])
      : JSON.stringify({ members: Object.fromEntries(states) })
    await setNotificationState(armStateKey(ruleId), value)
  }

  const byId = new Map(rules.map(r => [r.ruleId, r]))
  return fired.map(f => {
    const sep = f.ruleId.indexOf(MEMBER_KEY_SEP)
    const ruleId = f.ruleId.slice(0, sep)
    const address = f.ruleId.slice(sep + 1)
    const rule = byId.get(ruleId)!
    const norm = normalizeAddress(address)
    return {
      ruleId, accountId: rule.accountId, kind: rule.kind,
      // The member is part of the identity: two members of one tag crossing in
      // the same tick are two alerts, not one deduplicated away.
      identity: `below:${address}:${f.epoch}`, blockHeight: 0,
      payload: {
        lane: 'health-factor', address,
        account: norm ? accountRef(norm.accountId) : null,
        threshold: f.threshold, value: f.value,
      } as MatchPayload,
    }
  })
}

/* ============ safety snapshot lane ============ */

// Digests seen queued at some point in THIS process. A release is only reported
// for a digest that was observed held first: the monitor's queue set is a
// snapshot of what is held right now, so a digest simply being absent proves
// nothing about whether it was ever there. Restarting therefore drops the
// pending release rather than inventing one.
const seenOriginQueued = new Set<string>()

// Arm-state keys inside one rule's bundled row. The separator cannot appear in
// an asset id, a side or a direction, so a key round-trips.
const STATE_KEY_SEP = '\n'
const wantsSafetyEvent = (params: RuleParams['safety'], event: SafetyKind): boolean =>
  !params.kinds?.length || params.kinds.includes(event)

/**
 * The bridge-state half of the security kind. It reads the Wormhole monitor's
 * in-memory snapshot — never the chain, never the activity feed — so it costs
 * nothing beyond the rules it has, and it states exactly the verdict
 * `/security/wormhole` shows.
 *
 * Nothing here is anchored on a block window: a backing deficit, an origin
 * rate-limiter queue, an origin manager's pause flag and a fuse's utilization
 * are all CURRENT STATE, which is the sanctioned exception to window anchoring.
 * Persisted arm state per rule bounds how often each can refire, and the queue
 * events carry a deterministic identity that the inbox-seeded recent-id set
 * collapses across restarts.
 *
 * It delivers only what no indexed row carries — see the delivery matrix above
 * `evaluateSafety`. Concretely: the ORIGIN pause flag only (a Hydration-side
 * pause is a manager log on the ledger) and the ORIGIN queue set only (a
 * Hydration-side queue would emit its own TransferQueued log).
 */
async function safetySnapshotMatches(): Promise<RuleMatch[]> {
  const rules = activeRulesByKind('safety')
  if (!rules.length) return []
  const state = await getWormholeAlertState()
  // No snapshot yet is not "nothing is wrong": a monitor that has measured
  // nothing must not report a clean bridge, and it must not arm anything either.
  if (!state) return []

  const matches: RuleMatch[] = []
  for (const rule of rules) {
    const params = rule.params as RuleParams['safety']
    const prev = parseMemberArmStates(getNotificationState(armStateKey(rule.ruleId))) ?? new Map<string, ArmState>()
    const next = new Map(prev)
    let changed = false

    if (wantsSafetyEvent(params, 'deficit')) {
      const { fired, next: armed } = evaluateThreshold(
        state.assets.map(a => ({
          ruleId: `deficit${STATE_KEY_SEP}${a.assetId}`,
          direction: 'above' as const,
          threshold: params.deficitUsd,
          // A shortfall is a NEGATIVE residual, so the watched value is its
          // magnitude — but only once the classifier has graded it. A negative
          // residual with any other status is either an unconfirmed first
          // reading (the sampling skew the confirmation pass exists to refute)
          // or an unverifiable gap on a deployment that is not checking
          // in-flight transfers, where every routine transfer opens one; paging
          // on either would contradict the page the alert links to. A readable
          // clean reading is 0 so the threshold can re-arm; an unread residual
          // is null and changes nothing — an unreadable custody balance must
          // never read as a total deficit.
          value: a.residualUsd == null ? null
            : a.status === 'deficit' || a.status === 'attention' ? Math.max(0, -a.residualUsd)
              : 0,
        })),
        prev,
      )
      for (const [key, arm] of armed) { next.set(key, arm); changed = true }
      for (const fire of fired) {
        const assetId = Number(fire.ruleId.slice(fire.ruleId.indexOf(STATE_KEY_SEP) + 1))
        const asset = state.assets.find(a => a.assetId === assetId)
        if (!asset) continue
        matches.push(stateMatch(rule, `deficit:${assetId}:${fire.epoch}`, {
          lane: 'safety-state', event: 'deficit', symbol: asset.symbol, chainName: asset.originChainName, deficitUsd: fire.value,
        }))
      }
    }

    // A fuse warns BEFORE the limit binds: past it the origin limiter holds the
    // transfer for a whole refill window, which is what the 'queued' event
    // reports. Only the ORIGIN legs are evaluated — Hydration's own are uncapped
    // at the u64 trimmed ceiling, so their utilization is meaninglessly ~0; were
    // that ever to change, the origin table would still be the operative one,
    // because a transfer has to clear both.
    if (wantsSafetyEvent(params, 'fuse')) {
      const legs = state.assets.flatMap(a => FUSE_DIRECTIONS.map(dir => ({ asset: a, dir, fuse: a.fuses[dir] })))
      const { fired, next: armed } = evaluateThreshold(
        legs.map(leg => ({
          ruleId: `fuse${STATE_KEY_SEP}${leg.asset.assetId}:${leg.dir}`,
          direction: 'above' as const,
          threshold: params.fusePct,
          // An unread origin limiter is null, not 0%: a chain that failed to
          // answer must neither fire nor re-arm anything.
          value: leg.fuse?.utilizationPct ?? null,
        })),
        prev,
      )
      for (const [key, arm] of armed) { next.set(key, arm); changed = true }
      for (const fire of fired) {
        const key = fire.ruleId.slice(fire.ruleId.indexOf(STATE_KEY_SEP) + 1)
        const leg = legs.find(l => `${l.asset.assetId}:${l.dir}` === key)
        if (!leg?.fuse) continue
        matches.push(stateMatch(rule, `fuse:${leg.asset.assetId}:${leg.dir}:${fire.epoch}`, {
          lane: 'safety-state', event: 'fuse', symbol: leg.asset.symbol, chainName: leg.asset.originChainName,
          direction: leg.dir, utilizationPct: fire.value, limit: leg.fuse.limit, durationSec: leg.fuse.durationSec,
        }))
      }
    }

    // Both directions come out of ONE flip evaluation, so a rule narrowed to
    // 'pause' still tracks the unpause that has to happen before it can fire
    // again; the unwanted side is dropped at the match, not at the state.
    if (wantsSafetyEvent(params, 'pause') || wantsSafetyEvent(params, 'unpause')) {
      const inputs: FlagInput[] = state.assets.map(a => ({
        key: `pause${STATE_KEY_SEP}${a.assetId}:origin`, value: a.pausedOrigin,
      }))
      const { fired, next: flipped } = evaluateStateFlip(inputs, prev)
      for (const [key, arm] of flipped) { next.set(key, arm); changed = true }
      for (const flip of fired) {
        const event: SafetyStateEvent = flip.value ? 'pause' : 'unpause'
        if (!wantsSafetyEvent(params, event)) continue
        const [assetIdText] = flip.key.slice(flip.key.indexOf(STATE_KEY_SEP) + 1).split(':')
        const asset = state.assets.find(a => a.assetId === Number(assetIdText))
        if (!asset) continue
        matches.push(stateMatch(rule, `${event}:${assetIdText}:origin:${flip.epoch}`, {
          lane: 'safety-state', event, symbol: asset.symbol, chainName: asset.originChainName,
        }))
      }
    }

    const held = new Set(state.queued.map(q => q.digest))
    if (wantsSafetyEvent(params, 'queued')) {
      for (const entry of state.queued) {
        // Announced on the pass that first sees it, not on every pass: the
        // monitor keeps probing a digest for as long as the limiter holds it —
        // weeks, past the inbox dedup set's TTL — and re-emitting it each tick
        // would page subscribers again whenever it outlives that window. After
        // a restart the set is empty, so a still-held digest re-emits once and
        // the inbox dedup collapses it unless it has already outlived the TTL.
        if (seenOriginQueued.has(entry.digest)) continue
        matches.push(stateMatch(rule, `queued:${entry.digest}`, {
          lane: 'safety-state', event: 'queued', symbol: entry.symbol, chainName: entry.chainName,
          digest: entry.digest, amount: entry.amount, releasableAt: entry.releasableAt,
        }))
      }
    }
    if (wantsSafetyEvent(params, 'released')) {
      for (const digest of seenOriginQueued) {
        if (held.has(digest)) continue
        const remembered = originQueuedMemo.get(digest)
        if (!remembered) continue
        matches.push(stateMatch(rule, `released:${digest}`, {
          lane: 'safety-state', event: 'released', symbol: remembered.symbol, chainName: remembered.chainName,
          digest, amount: remembered.amount, releasableAt: remembered.releasableAt,
        }))
      }
    }

    if (changed) await setNotificationState(armStateKey(rule.ruleId), JSON.stringify({ members: Object.fromEntries(next) }))
  }

  // Remembered AFTER the rules ran, so a digest that appeared and vanished
  // between two ticks cannot fire its release in the same pass that first saw it.
  for (const entry of state.queued) {
    seenOriginQueued.add(entry.digest)
    originQueuedMemo.set(entry.digest, entry)
  }
  for (const digest of [...seenOriginQueued]) {
    if (!state.queued.some(q => q.digest === digest)) { seenOriginQueued.delete(digest); originQueuedMemo.delete(digest) }
  }
  return matches
}

const FUSE_DIRECTIONS: readonly FuseDirection[] = ['in', 'out']

// What a queued transfer looked like while it was held, so its release can be
// described after it has left the snapshot.
const originQueuedMemo = new Map<string, WormholeAlertState['queued'][number]>()

const stateMatch = (rule: NotificationRule, identity: string, payload: MatchPayload): RuleMatch => ({
  ruleId: rule.ruleId,
  accountId: rule.accountId,
  kind: rule.kind,
  identity,
  // A bridge state has no block of its own; the identity is what dedupes it.
  blockHeight: 0,
  payload,
})

// The bundled per-member arm-state row a tag-target health-factor rule keeps
// (see healthFactorMatches). null for the legacy plain shape or garbage.
export function parseMemberArmStates(raw: string | null): Map<string, ArmState> | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as { members?: Record<string, unknown> }
    if (!o?.members || typeof o.members !== 'object') return null
    const out = new Map<string, ArmState>()
    for (const [addr, value] of Object.entries(o.members)) {
      const state = parseArmState(JSON.stringify(value))
      if (state) out.set(addr, state)
    }
    return out
  } catch { return null }
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
  /** Newest block the message covers; part of its outbound identity. */
  blockHeight: number
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
      const inputFor = (match: RuleMatch) => renderMatch(match, rule, viewerTag)
      const render = (match: RuleMatch) => renderNotification(inputFor(match))
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
          rendered: renderDigest(rule, overflow.slice(0, COALESCE_LIST).map(inputFor), overflow.length),
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
      // One message per BLOCK rather than per tick. The push `tag` must carry the
      // block too: a repeated tag REPLACES the previous notification on the
      // device, which would silently re-collapse exactly what this split exists
      // to separate. Only the entries a digest actually lists get rendered, so a
      // huge collapsed group stays cheap.
      const renderedFor = new Map(detailed.map((match, i) => [match, rendered[i]] as const))
      for (const group of outboundGroups(list, MAX_OUTBOUND_SENDS)) {
        if (group.length > 1) counters.coalesced++
        const shown = group.slice(0, COALESCE_LIST)
        const message = group.length === 1
          ? (renderedFor.get(shown[0]) ?? render(shown[0]))
          : renderDigest(rule, shown.map(inputFor), group.length)
        const blockHeight = group[group.length - 1].blockHeight
        sends.push({
          ruleId, accountId: rule.accountId, message, channels, blockHeight,
          tag: `${ruleId}:${blockHeight}`,
        })
      }
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
  const sentAt = Date.now()
  for (const send of sends) {
    if (!fresh.has(send.ruleId)) continue
    // A second rule describing the same event in the same words adds nothing,
    // and — like a replayed match — it must not restart the cooldown clock
    // either: nothing was sent, so nothing should be counted as sent.
    if (!claimOutbound(send, sentAt)) {
      counters.outboundDuplicates++
      continue
    }
    lastSendAtMs.set(send.ruleId, Date.now())
    sendOutbound(send.accountId, send.message, send.tag, send.channels)
  }
  return true
}

function ruleOf(match: RuleMatch): NotificationRule | null {
  return activeRulesByKind(match.kind).find(r => r.ruleId === match.ruleId) ?? null
}
