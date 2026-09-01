import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  SAFETY_ROW_LANE_KINDS, SAFETY_SNAPSHOT_KINDS,
  activityIdentity, activityPath, activityReferencesAsset, armStateKey, evaluateAccountActivity,
  evaluateEvents, evaluateExtrinsics, evaluateLargeValue, evaluateReferendum, evaluateRowKind,
  evaluateSafety, evaluateThreshold, inWindow, isFinalRow, nameMatches, notificationIdFor,
  pageMissedRows, parseArmState, REFERENDUM_PHASE_BY_EVENT,
  renderDigest, renderMatch, resolveWindow, safetyIdentity,
  type ArmState, type BlockWindow, type ChainEventRow, type ChainExtrinsicRow, type ReferendumEventRow,
  type RuleMatch, type ThresholdInput, type ViewerTag,
} from '../src/notifications/evaluator.ts'
import { renderNotification } from '../src/notifications/render.ts'
import { normalizeAddress } from '../src/services/addressIdentity.ts'
import type { NotificationRule } from '../src/notifications/notificationStore.ts'
import { SAFETY_KINDS, type NotificationKind } from '../src/notifications/notificationRules.ts'
import type { SafetyEvent } from '../src/services/securityService.ts'
import {
  getPrimaryHealthFactor, initExplorerService, mmMarkets,
  type AccountRef, type ActivityRow, type AssetRef,
} from '../src/services/explorerService.ts'
import { fakeClient } from './helpers/userFakes.ts'

// The evaluator's matching core is a set of pure functions over rows somebody
// else fetched, so every invariant that matters — the backfill blind spot, the
// finality gate, edge-triggered thresholds — is pinned here without a database.

const OWNER = '0x' + 'aa'.repeat(32)
const WHALE = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const W: BlockWindow = { from: 1_000, to: 1_100 }

let ruleSeq = 0
function rule(kind: NotificationKind, params: unknown, over: Partial<NotificationRule> = {}): NotificationRule {
  return {
    ruleId: `rule-${++ruleSeq}`, accountId: OWNER, kind, name: '', params,
    channels: [], muted: false, cooldownS: 0, ...over,
  }
}

const asset = (assetId: number, symbol: string, decimals = 12): AssetRef =>
  ({ assetId, iconAssetId: assetId, symbol, name: symbol, decimals, parachainId: null, origin: null })

const ref = (accountId: string, over: Partial<AccountRef> = {}): AccountRef =>
  ({ accountId, address: WHALE, emoji: '🐋', tag: null, identity: null, profile: null, ...over })

function activity(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    type: 'trade', blockHeight: 1_050, timestamp: '2026-08-18 10:00:00',
    eventIndex: 7, extrinsicIndex: 2,
    who: ref(OWNER), to: null,
    asset: null, assetIn: asset(0, 'HDX'), assetOut: asset(10, 'USDT', 6),
    amount: null, amountIn: '1000000000000000', amountOut: '25000000',
    valueUsd: 25, ...over,
  }
}

const noViewerTag: ViewerTag = () => null

/* ============ window + cursor ============ */

describe('resolveWindow', () => {
  it('opens the window just above the cursor and closes it at the head', () => {
    expect(resolveWindow(1_000, 1_010)).toEqual({ window: { from: 1_000, to: 1_010 }, skipped: 0 })
  })

  it('never walks backwards when the head query answers below the cursor', () => {
    expect(resolveWindow(1_010, 1_000)).toEqual({ window: { from: 1_010, to: 1_010 }, skipped: 0 })
  })

  it('clamps a long gap to 600 blocks and reports what it skipped', () => {
    const { window, skipped } = resolveWindow(1_000, 3_000)
    expect(window).toEqual({ from: 2_400, to: 3_000 })
    expect(skipped).toBe(1_400)
  })

  it('excludes the cursor block itself, so a re-evaluated tick matches nothing twice', () => {
    expect(inWindow(1_000, W)).toBe(false)
    expect(inWindow(1_001, W)).toBe(true)
    expect(inWindow(1_100, W)).toBe(true)
    expect(inWindow(1_101, W)).toBe(false)
  })
})

describe('pageMissedRows', () => {
  it('only suspects a miss when a saturated page starts above the cursor', () => {
    const rows = [{ blockHeight: 1_050 }, { blockHeight: 1_060 }]
    expect(pageMissedRows(rows, W, 2)).toBe(true)
    expect(pageMissedRows(rows, W, 50)).toBe(false)
    expect(pageMissedRows([{ blockHeight: 999 }, { blockHeight: 1_060 }], W, 2)).toBe(false)
  })
})

/* ============ finality ============ */

describe('finality gate', () => {
  it('rejects pending-head and mempool rows and accepts everything else', () => {
    expect(isFinalRow({})).toBe(true)
    expect(isFinalRow({ finalized: true })).toBe(true)
    expect(isFinalRow({ finalized: false })).toBe(false)
    expect(isFinalRow({ mempool: true })).toBe(false)
  })

  it('never matches an unfinalized or pool row, however well it fits the rule', () => {
    const r = rule('account-activity', { address: WHALE })
    const rows = [
      activity({ blockHeight: 1_050, eventIndex: 1, finalized: false }),
      activity({ blockHeight: 1_051, eventIndex: 2, mempool: true }),
      activity({ blockHeight: 1_052, eventIndex: 3 }),
    ]
    expect(evaluateAccountActivity(rows, [r], W).map(m => m.blockHeight)).toEqual([1_052])
  })
})

/* ============ the backfill blind spot ============ */

describe('backfill immunity', () => {
  it('ignores a row inserted below the cursor, which is every backfill and repair row', () => {
    const r = rule('event', { section: 'Omnipool' })
    const rows: ChainEventRow[] = [
      { blockHeight: 12, eventIndex: 0, extrinsicIndex: null, name: 'Omnipool.SellExecuted' },
      { blockHeight: 1_000, eventIndex: 0, extrinsicIndex: null, name: 'Omnipool.SellExecuted' },
      { blockHeight: 1_050, eventIndex: 4, extrinsicIndex: null, name: 'Omnipool.SellExecuted' },
    ]
    expect(evaluateEvents(rows, [r], W).map(m => m.blockHeight)).toEqual([1_050])
  })
})

/* ============ row-lane matchers ============ */

describe('account-activity matching', () => {
  it('honours the type family, the action and the USD floor', () => {
    const anyActivity = rule('account-activity', { address: WHALE })
    const bigTrades = rule('account-activity', { address: WHALE, type: 'trade', minUsd: 100 })
    const rows = [
      activity({ blockHeight: 1_010, eventIndex: 1, valueUsd: 25 }),
      activity({ blockHeight: 1_020, eventIndex: 2, valueUsd: 5_000 }),
      activity({ blockHeight: 1_030, eventIndex: 3, type: 'transfer', valueUsd: 9_000 }),
    ]
    expect(evaluateAccountActivity(rows, [anyActivity], W)).toHaveLength(3)
    expect(evaluateAccountActivity(rows, [bigTrades], W).map(m => m.blockHeight)).toEqual([1_020])
  })

  it('reads the API activity-type vocabulary, where `stake` names staking rows', () => {
    const r = rule('account-activity', { address: WHALE, type: 'stake' })
    const rows = [activity({ type: 'staking', stakingAction: 'Stake' }), activity({ blockHeight: 1_051, eventIndex: 8 })]
    expect(evaluateAccountActivity(rows, [r], W).map(m => m.blockHeight)).toEqual([1_050])
  })

  it('collapses a row the source handed back twice', () => {
    const r = rule('account-activity', { address: WHALE })
    const row = activity()
    expect(evaluateAccountActivity([row, { ...row }], [r], W)).toHaveLength(1)
  })
})

describe('large-trade matching', () => {
  it('applies the USD floor and the optional asset, matching either side of the pair', () => {
    const anyBig = rule('large-trade', { minUsd: 1_000 })
    const usdtOnly = rule('large-trade', { minUsd: 1_000, assetId: 10 })
    const rows = [
      activity({ blockHeight: 1_010, eventIndex: 1, valueUsd: 500 }),
      activity({ blockHeight: 1_020, eventIndex: 2, valueUsd: 5_000 }),
      activity({ blockHeight: 1_030, eventIndex: 3, valueUsd: 8_000, assetIn: asset(5, 'DOT'), assetOut: asset(9, 'GLMR') }),
    ]
    expect(evaluateLargeValue(rows, [anyBig], W).map(m => m.blockHeight)).toEqual([1_020, 1_030])
    expect(evaluateLargeValue(rows, [usdtOnly], W).map(m => m.blockHeight)).toEqual([1_020])
  })

  it('counts a nested pool asset as a reference', () => {
    const row = activity({ assetRefs: [102] })
    expect(activityReferencesAsset(row, 102)).toBe(true)
    expect(activityReferencesAsset(row, 103)).toBe(false)
  })
})

// The exact sibling of large-trade over the transfer feed: the loop asks the
// feed for transfers, so the matcher itself has only the floor and the asset
// scope left to apply — and the invariants it shares with every row lane
// (finality, the window's lower bound) hold identically.
describe('large-transfer matching', () => {
  const transfer = (over: Partial<ActivityRow> = {}): ActivityRow => activity({
    type: 'transfer', to: ref('0x6d6f646c70792f7472737279' + '00'.repeat(20), { address: '7L53bUTBbfuj14UpdCNPwmgzzHSsrsTWBHX5pys32mVWM3C1' }),
    asset: asset(0, 'HDX'), assetIn: undefined, assetOut: undefined,
    amount: '4870000000000000000', amountIn: null, amountOut: null, valueUsd: 106_000, ...over,
  })

  it('applies the USD floor and the optional asset scope', () => {
    const anyBig = rule('large-transfer', { minUsd: 1_000 })
    const hdxOnly = rule('large-transfer', { minUsd: 1_000, assetId: 0 })
    const rows = [
      transfer({ blockHeight: 1_010, eventIndex: 1, valueUsd: 500 }),
      transfer({ blockHeight: 1_020, eventIndex: 2 }),
      transfer({ blockHeight: 1_030, eventIndex: 3, asset: asset(5, 'DOT'), valueUsd: 8_000 }),
    ]
    expect(evaluateLargeValue(rows, [anyBig], W).map(m => m.blockHeight)).toEqual([1_020, 1_030])
    expect(evaluateLargeValue(rows, [hdxOnly], W).map(m => m.blockHeight)).toEqual([1_020])
  })

  it('never matches below the cursor or before finality', () => {
    const r = rule('large-transfer', { minUsd: 1_000 })
    const rows = [
      transfer({ blockHeight: 900, eventIndex: 1 }),                    // backfilled
      transfer({ blockHeight: 1_020, eventIndex: 2, finalized: false }),
      transfer({ blockHeight: 1_021, eventIndex: 3, mempool: true }),
      transfer({ blockHeight: 1_022, eventIndex: 4 }),
    ]
    expect(evaluateLargeValue(rows, [r], W).map(m => m.blockHeight)).toEqual([1_022])
  })

  it('dispatches through evaluateRowKind under its own kind', () => {
    const matches = evaluateRowKind('large-transfer', [transfer()], [rule('large-transfer', { minUsd: 1_000 })], W)
    expect(matches.map(m => m.identity)).toEqual(['1050-e7'])
    expect(matches[0].kind).toBe('large-transfer')
  })
})

describe('safety matching', () => {
  const event = (over: Partial<SafetyEvent> = {}): SafetyEvent => ({
    kind: 'freeze', label: 'Omnipool tradability set', detail: '2-Pool → Frozen',
    blockHeight: 1_050, blockTimestamp: '2026-08-18 10:00:00', extrinsicIndex: 1, asset: null, ...over,
  })

  it('narrows to the subscribed kinds and leaves an unfiltered rule catching everything', () => {
    const frozenOnly = rule('safety', { kinds: ['freeze', 'unfreeze'] })
    const everything = rule('safety', {})
    const events = [event(), event({ blockHeight: 1_060, kind: 'pause', label: 'Call paused' }), event({ blockHeight: 1_070, kind: 'unfreeze' })]
    expect(evaluateSafety(events, [frozenOnly], W).map(m => m.blockHeight)).toEqual([1_050, 1_070])
    expect(evaluateSafety(events, [everything], W)).toHaveLength(3)
  })

  it('keeps the identity out of `detail`, which restates history and can move', () => {
    const a = safetyIdentity(event({ detail: '2-Pool → Frozen' }))
    const b = safetyIdentity(event({ detail: '2-Pool → Frozen (was Tradable)' }))
    expect(a).toBe(b)
  })
})

describe('referendum matching', () => {
  const row = (over: Partial<ReferendumEventRow> = {}): ReferendumEventRow =>
    ({ blockHeight: 1_050, eventIndex: 3, index: 101, phase: 'submitted', track: 1, ...over })

  it('filters by phase and enriches the title when one is known', () => {
    const r = rule('referendum', { phases: ['confirmed', 'killed'] })
    const rows = [row(), row({ blockHeight: 1_060, phase: 'confirmed', track: null }), row({ blockHeight: 1_070, phase: 'killed', track: null })]
    const matches = evaluateReferendum(rows, [r], W, i => (i === 101 ? 'Add HDX liquidity' : null))
    expect(matches.map(m => m.identity)).toEqual(['101:confirmed', '101:killed'])
    expect(matches[0].payload).toMatchObject({ lane: 'referendum', title: 'Add HDX liquidity' })
  })

  it('treats the executed phase as one more filterable phase, outcome riding along', () => {
    const r = rule('referendum', { phases: ['executed'] })
    const rows = [row(), row({ blockHeight: 1_060, phase: 'executed', track: null, outcome: 'ok' })]
    const matches = evaluateReferendum(rows, [r], W)
    expect(matches.map(m => m.identity)).toEqual(['101:executed'])
    expect(matches[0].payload).toMatchObject({ lane: 'referendum', row: { outcome: 'ok' } })
    // And a rule with no phase filter hears about enactments without opting in.
    expect(evaluateReferendum(rows, [rule('referendum', {})], W)).toHaveLength(2)
  })

  // Entering confirmation is the phase a passing referendum's watchers care most
  // about — it is the first moment the outcome is in sight — and the chain
  // announces it with its own event. Referendum #396 crossed it at block
  // 14074297 having notified its watchers of `submitted` and `deciding`, and
  // nobody heard, because the lane read only the phases either side of it.
  it('reports entering confirmation, and falling back out of it', () => {
    expect(REFERENDUM_PHASE_BY_EVENT['Referenda.ConfirmStarted']).toBe('confirming')
    expect(REFERENDUM_PHASE_BY_EVENT['Referenda.ConfirmAborted']).toBe('confirm-aborted')
    const rows = [
      row({ blockHeight: 1_060, phase: 'confirming', track: null }),
      row({ blockHeight: 1_070, phase: 'confirm-aborted', track: null }),
    ]
    expect(evaluateReferendum(rows, [rule('referendum', { phases: ['confirming'] })], W).map(m => m.identity))
      .toEqual(['101:confirming@1060'])
    // And a rule naming no phases hears both without opting in — which is what
    // every rule stored as `{}` is.
    expect(evaluateReferendum(rows, [rule('referendum', {})], W)).toHaveLength(2)
  })

  // Confirmation can abort and begin again (four referenda on this chain have
  // done it). Keyed on the phase alone, the second entry would carry the first
  // one's identity and the inbox — a ReplacingMergeTree on that id — would
  // silently swallow it. The `voted` precedent: block-key the repeatable phases.
  it('keeps a re-entered confirmation distinct from the first', () => {
    const rows = [
      row({ blockHeight: 1_050, phase: 'confirming', track: null }),
      row({ blockHeight: 1_060, phase: 'confirm-aborted', track: null }),
      row({ blockHeight: 1_070, phase: 'confirming', track: null }),
    ]
    const ids = evaluateReferendum(rows, [rule('referendum', {})], W).map(m => m.identity)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(['101:confirming@1050', '101:confirm-aborted@1060', '101:confirming@1070'])
    // The once-only phases keep their stable identity, so an overlapping window
    // re-evaluating them still deduplicates.
    expect(evaluateReferendum([row({ phase: 'confirmed' })], [rule('referendum', {})], W)[0].identity)
      .toBe('101:confirmed')
  })

  it('matches a track filter against the numeric track id, and keeps an unknown track', () => {
    const r = rule('referendum', { track: '1' })
    expect(evaluateReferendum([row({ track: 1 })], [r], W)).toHaveLength(1)
    expect(evaluateReferendum([row({ track: 2 })], [r], W)).toHaveLength(0)
    // Track unresolvable (no Submitted row indexed): matching rather than
    // silently dropping the event.
    expect(evaluateReferendum([row({ track: null })], [r], W)).toHaveLength(1)
  })
})

describe('event and extrinsic matching', () => {
  it('matches section and method case-insensitively', () => {
    expect(nameMatches('Omnipool.SellExecuted', 'omnipool')).toBe(true)
    expect(nameMatches('Omnipool.SellExecuted', 'OMNIPOOL', 'sellexecuted')).toBe(true)
    expect(nameMatches('Omnipool.SellExecuted', 'Omnipool', 'BuyExecuted')).toBe(false)
    expect(nameMatches('Omnipool.SellExecuted', 'Router')).toBe(false)
  })

  it('selects events by section, then by method', () => {
    const anySection = rule('event', { section: 'omnipool' })
    const oneMethod = rule('event', { section: 'Omnipool', method: 'BuyExecuted' })
    const rows: ChainEventRow[] = [
      { blockHeight: 1_010, eventIndex: 1, extrinsicIndex: 0, name: 'Omnipool.SellExecuted' },
      { blockHeight: 1_020, eventIndex: 2, extrinsicIndex: 0, name: 'Omnipool.BuyExecuted' },
      { blockHeight: 1_030, eventIndex: 3, extrinsicIndex: 0, name: 'Router.Executed' },
    ]
    expect(evaluateEvents(rows, [anySection], W)).toHaveLength(2)
    expect(evaluateEvents(rows, [oneMethod], W).map(m => m.identity)).toEqual(['1020-e2'])
  })

  it('selects extrinsics by outcome and signer', () => {
    // The rule names an SS58 address and the row carries an AccountId, so the
    // matcher normalizes before comparing — the two forms have to meet.
    const whaleId = normalizeAddress(WHALE)!.accountId
    const failedOnly = rule('extrinsic', { section: 'Omnipool', success: false })
    const bySigner = rule('extrinsic', { section: 'Omnipool', signer: WHALE })
    const rows: ChainExtrinsicRow[] = [
      { blockHeight: 1_010, extrinsicIndex: 1, callName: 'Omnipool.sell', success: true, signer: ref(whaleId) },
      { blockHeight: 1_020, extrinsicIndex: 2, callName: 'Omnipool.sell', success: false, signer: ref('0x' + 'bb'.repeat(32)) },
    ]
    expect(evaluateExtrinsics(rows, [failedOnly], W).map(m => m.identity)).toEqual(['1020-2'])
    expect(evaluateExtrinsics(rows, [bySigner], W).map(m => m.identity)).toEqual(['1010-1'])
  })

  it('dispatches through evaluateRowKind with the rows its kind expects', () => {
    const rows: ChainEventRow[] = [{ blockHeight: 1_050, eventIndex: 1, extrinsicIndex: null, name: 'Omnipool.SellExecuted' }]
    expect(evaluateRowKind('event', rows, [rule('event', { section: 'Omnipool' })], W)).toHaveLength(1)
  })
})

/* ============ identities ============ */

describe('dedup identity', () => {
  it('distinguishes an event index from an extrinsic index in the same block', () => {
    expect(activityIdentity(activity({ eventIndex: 3, extrinsicIndex: 3 }))).toBe('1050-e3')
    expect(activityIdentity(activity({ eventIndex: null, extrinsicIndex: 3 }))).toBe('1050-3')
    expect(activityIdentity(activity({ eventIndex: null, extrinsicIndex: null }))).toBeNull()
  })

  it('hashes rule id and identity into a stable notification id', () => {
    const id = notificationIdFor('rule-a', '1050-e3')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(notificationIdFor('rule-a', '1050-e3')).toBe(id)
    expect(notificationIdFor('rule-b', '1050-e3')).not.toBe(id)
    expect(notificationIdFor('rule-a', '1050-e4')).not.toBe(id)
  })
})

/* ============ threshold lane ============ */

describe('evaluateThreshold', () => {
  const above = (value: number | null): ThresholdInput => ({ ruleId: 'r', direction: 'above', threshold: 100, value })
  const below = (value: number | null): ThresholdInput => ({ ruleId: 'r', direction: 'below', threshold: 1.1, value })

  it('arms on first sight without firing, then fires on the crossing', () => {
    const first = evaluateThreshold([above(90)], new Map())
    expect(first.fired).toEqual([])
    expect(first.next.get('r')).toEqual({ armed: true, lastValue: 90, epoch: 0 })

    const crossed = evaluateThreshold([above(101)], first.next)
    expect(crossed.fired).toHaveLength(1)
    expect(crossed.fired[0]).toMatchObject({ ruleId: 'r', value: 101, epoch: 1 })
    expect(crossed.next.get('r')).toEqual({ armed: false, lastValue: 101, epoch: 1 })
  })

  it('does not arm a rule created while the value is already past its threshold', () => {
    const first = evaluateThreshold([above(150)], new Map())
    expect(first.fired).toEqual([])
    expect(first.next.get('r')?.armed).toBe(false)
    expect(evaluateThreshold([above(160)], first.next).fired).toEqual([])
  })

  it('stays silent inside the hysteresis band and re-arms only 2% past it', () => {
    const fired = new Map<string, ArmState>([['r', { armed: false, lastValue: 101, epoch: 1 }]])
    // 99 is back below the threshold but inside the 2% band — no re-arm, and
    // therefore no state write either.
    expect(evaluateThreshold([above(99)], fired).next.size).toBe(0)
    const rearmed = evaluateThreshold([above(97)], fired)
    expect(rearmed.fired).toEqual([])
    expect(rearmed.next.get('r')).toEqual({ armed: true, lastValue: 97, epoch: 1 })
    // Only now can it fire again, with a fresh epoch (hence a fresh id).
    expect(evaluateThreshold([above(120)], rearmed.next).fired[0]?.epoch).toBe(2)
  })

  it('treats an unavailable value as no information at all', () => {
    const armed = new Map<string, ArmState>([['r', { armed: true, lastValue: 1.5, epoch: 0 }]])
    const out = evaluateThreshold([below(null)], armed)
    expect(out.fired).toEqual([])
    expect(out.next.size).toBe(0)
  })

  it('reads a debt-free position (no health factor) as safe, never as zero', () => {
    const armed = new Map<string, ArmState>([['r', { armed: true, lastValue: 1.5, epoch: 0 }]])
    expect(evaluateThreshold([below(Infinity)], armed).fired).toEqual([])
    const fired = evaluateThreshold([below(1.05)], armed)
    expect(fired.fired).toHaveLength(1)
    // Recovering past threshold * 1.02 re-arms.
    expect(evaluateThreshold([below(1.2)], fired.next).next.get('r')?.armed).toBe(true)
    expect(evaluateThreshold([below(Infinity)], fired.next).next.get('r')?.armed).toBe(true)
  })

  it('writes nothing while a value merely drifts inside its band', () => {
    const state = new Map<string, ArmState>([['r', { armed: true, lastValue: 90, epoch: 0 }]])
    expect(evaluateThreshold([above(95)], state).next.size).toBe(0)
  })

  it('resumes from persisted state after a restart instead of refiring', () => {
    const persisted = JSON.stringify({ armed: false, lastValue: 101, epoch: 1 })
    const restored = parseArmState(persisted)!
    expect(restored).toEqual({ armed: false, lastValue: 101, epoch: 1 })
    const out = evaluateThreshold([above(105)], new Map([['r', restored]]))
    expect(out.fired).toEqual([])
    expect(out.next.size).toBe(0)
  })

  it('keys its persisted state per rule and survives an unreadable value', () => {
    expect(armStateKey('abc')).toBe('arm:abc')
    expect(parseArmState(null)).toBeNull()
    expect(parseArmState('not json')).toBeNull()
    expect(parseArmState('{"epoch":3}')).toBeNull()
  })
})

/* ============ rendering ============ */

describe('renderMatch', () => {
  const match = (payload: RuleMatch['payload'], kind: NotificationKind): RuleMatch =>
    ({ ruleId: 'r', accountId: OWNER, kind, identity: 'i', blockHeight: 1_050, payload })

  it('links an activity to its canonical explorer page', () => {
    expect(activityPath(activity())).toBe('/swap/1050-e7')
    expect(activityPath(activity({ type: 'transfer' }))).toBe('/transfer/1050-e7')
    expect(activityPath(activity({ type: 'mm', mmAction: 'Borrow' }))).toBe('/borrow/1050-e7')
    expect(activityPath(activity({ type: 'trade', dca: true, dcaScheduleId: 42 }))).toBe('/dca/42')
  })

  it('renders a swap with the shared account notation and rough number scale', () => {
    const r = rule('account-activity', { address: WHALE })
    const input = renderMatch(match({ lane: 'activity', row: activity() }, 'account-activity'), r, noViewerTag)
    const out = renderNotification(input)
    expect(out.title).toContain('Swap by')
    expect(out.title).toContain('15Da…BDRLZ')
    expect(out.body).toContain('1k HDX → 25 USDT · $25')
    expect(out.url).toMatch(/\/swap\/1050-e7$/)
  })

  // A large transfer goes through the same activity shape a watched account's
  // transfer does, so the two read identically: the sender in the headline, the
  // amount and the recipient on the line under it — both in the shared account
  // notation, the module account included.
  it('names both sides of a transfer with the shared account notation', () => {
    const r = rule('large-transfer', { minUsd: 10_000 })
    const treasury = ref('0x6d6f646c70792f7472737279' + '00'.repeat(20), { address: '7L53bUTBbfuj14UpdCNPwmgzzHSsrsTWBHX5pys32mVWM3C1' })
    const row = activity({
      type: 'transfer', to: treasury, asset: asset(0, 'HDX'), assetIn: undefined, assetOut: undefined,
      amount: '4870000000000000000', amountIn: null, amountOut: null, valueUsd: 106_000,
    })
    const out = renderNotification(renderMatch(match({ lane: 'activity', row }, 'large-transfer'), r, noViewerTag))
    expect(out.title).toBe('Transfer by 🐋 15Da…BDRLZ')
    expect(out.body).toContain('4.87M HDX to ⚙️ py/trsry (3C1) · $106k')
    expect(out.url).toMatch(/\/transfer\/1050-e7$/)
    expect(out.telegramHtml).toContain('<b>py/trsry</b>')
  })

  it('prefers the recipient’s own list tag over everything the ref carries', () => {
    const r = rule('account-activity', { address: WHALE })
    const tagged: ViewerTag = id => (id === OWNER ? { name: 'My whale' } : null)
    const out = renderNotification(renderMatch(match({ lane: 'activity', row: activity() }, 'account-activity'), r, tagged))
    expect(out.title).toContain('My whale')
  })

  it('states the threshold and the current value for a value trigger', () => {
    const price = renderNotification(renderMatch(
      match({ lane: 'price', assetId: 0, direction: 'above', threshold: 0.02, value: 0.025 }, 'price'),
      rule('price', { assetId: 0, direction: 'above', price: 0.02 }), noViewerTag))
    expect(price.title).toContain('above $0.02')
    expect(price.body).toContain('$0.025')
    expect(price.url).toMatch(/\/asset\/0$/)

    const hf = renderNotification(renderMatch(
      match({ lane: 'health-factor', address: WHALE, account: null, threshold: 1.1, value: 1.04 }, 'health-factor'),
      rule('health-factor', { address: WHALE, threshold: 1.1 }), noViewerTag))
    expect(hf.title).toContain('Health factor 1.04')
    expect(hf.url).toContain(`/account/${encodeURIComponent(WHALE)}`)
  })

  it('says how an enactment went, not just that it happened', () => {
    const r = rule('referendum', {})
    const refRow = (outcome: 'ok' | 'failed' | 'unavailable' | null) =>
      ({ lane: 'referendum' as const, row: { blockHeight: 1_050, eventIndex: 3, index: 101, phase: 'executed' as const, track: null, outcome }, title: 'Add HDX liquidity' })
    expect(renderNotification(renderMatch(match(refRow('ok'), 'referendum'), r, noViewerTag)).body)
      .toContain('Referendum #101 executed')
    expect(renderNotification(renderMatch(match(refRow('failed'), 'referendum'), r, noViewerTag)).body)
      .toContain('the call FAILED')
    expect(renderNotification(renderMatch(match(refRow('unavailable'), 'referendum'), r, noViewerTag)).body)
      .toContain('unavailable at enactment')
    const out = renderNotification(renderMatch(match(refRow('ok'), 'referendum'), r, noViewerTag))
    expect(out.title).toContain('Add HDX liquidity')
    expect(out.url).toMatch(/\/referendum\/opengov\/101$/)
  })

  it('escapes chain-derived text on the Telegram side', () => {
    const r = rule('event', { section: 'Omnipool' })
    const out = renderNotification(renderMatch(
      match({ lane: 'event', row: { blockHeight: 1_050, eventIndex: 2, extrinsicIndex: null, name: 'Omni<pool>.Sell&Executed' } }, 'event'),
      r, noViewerTag))
    expect(out.telegramHtml).toContain('<code>Omni&lt;pool&gt;.Sell&amp;Executed</code>')
  })
})

describe('renderDigest', () => {
  it('lists five matches by name and counts the rest', () => {
    const r = rule('large-trade', { minUsd: 1_000 }, { name: 'Whale watch' })
    // Entries are render INPUTS: a digest keeps each bullet's own links.
    const entries = Array.from({ length: 6 }, (_, i) => ({ title: `Swap ${i}`, path: '/activity' }))
    const digest = renderDigest(r, entries)
    expect(digest.title).toBe('6 × Large trade')
    // The rule's own name is deliberately absent: the reader knows what they
    // subscribed to, and the entries say what happened.
    expect(digest.body).not.toContain('Whale watch')
    expect(digest.body).toContain('• Swap 0')
    expect(digest.body).toContain('• Swap 4')
    expect(digest.body).not.toContain('• Swap 5')
    expect(digest.body).toContain('and 1 more')
  })

  it('lists the entries alone, with no rule description, and no empty remainder', () => {
    const digest = renderDigest(rule('large-trade', { minUsd: 5_000 }), [
      { title: 'a', path: '/x' }, { title: 'b', path: '/x' },
    ])
    expect(digest.body).not.toContain('trades over $5k')
    expect(digest.body).toBe('• a\n• b')
    expect(digest.body).not.toContain('and 0 more')
  })
})

/* ============ health-factor source ============ */

describe('primary-market health factor', () => {
  // The two lending markets are isolated: a GIGAHDX position must never move a
  // primary-market alert, in either direction.
  const WAD = 10n ** 18n
  // uint256 max is how the money market spells "no debt".
  const MAX_UINT256_STRING = (2n ** 256n - 1n).toString()
  const position = (pool: string, hf: bigint) => ({
    pool_address: pool, lb: 13_000_000, ts: '2026-08-18 10:00:00',
    c: '1000000000', d: '500000000', ab: '0', lt: '8000', ltv: '7000', hf: hf.toString(),
  })
  const primaryPool = mmMarkets().find(m => m.role === 'primary')!.poolProxy
  const supplementalPool = mmMarkets().find(m => m.role === 'supplemental')!.poolProxy

  it('reads the primary market alone and ignores the supplemental one', async () => {
    initExplorerService(fakeClient({
      money_market_latest_positions: [position(primaryPool, WAD * 105n / 100n), position(supplementalPool, WAD * 5n)],
    }))
    expect(await getPrimaryHealthFactor('0x' + '11'.repeat(20))).toBeCloseTo(1.05, 6)
  })

  it('reports a debt-free position as infinite, never as zero', async () => {
    initExplorerService(fakeClient({
      money_market_latest_positions: [{ ...position(primaryPool, 0n), d: '0', hf: MAX_UINT256_STRING }],
    }))
    expect(await getPrimaryHealthFactor('0x' + '22'.repeat(20))).toBe(Infinity)
  })

  it('reports no position and an unreadable address as unknown, not as a value', async () => {
    initExplorerService(fakeClient({ money_market_latest_positions: [position(supplementalPool, WAD)] }))
    expect(await getPrimaryHealthFactor('0x' + '33'.repeat(20))).toBeNull()
    expect(await getPrimaryHealthFactor('not-an-address')).toBeNull()
  })
})

/* ============ registry parity ============ */

// A safety rule can only narrow to a kind one of its two lanes actually emits.
// The lists live in three files (the rule registry, the dashboard builder, the
// evaluator's delivery matrix), so a new action kind reaching a lane without
// reaching the registry would be unsubscribable — and one removed from a lane
// would leave a rule that can never match.
describe('safety kinds registry', () => {
  it('names exactly the kinds securityService puts on the ledger', () => {
    const source = readFileSync(new URL('../src/services/securityService.ts', import.meta.url), 'utf8')
    // From the Wormhole manager builder through buildTimeline: everything that
    // becomes a SafetyEvent row.
    const ledger = source.slice(
      source.indexOf('export function buildWormholeSafetyEvents('),
      source.indexOf('\n// `TechnicalCommittee.set_members('))
    const emitted = new Set(
      [...ledger.matchAll(/kind: ([^\n]+),/g)]
        .flatMap(m => [...m[1].matchAll(/'([a-z-]+)'/g)].map(q => q[1])))
    expect([...emitted].sort()).toEqual([...SAFETY_ROW_LANE_KINDS].sort())
  })

  // The bridge-state half is not indexed anywhere, so its only registry is the
  // matrix itself; together the two lanes must cover the whole vocabulary.
  it('leaves no safety kind without a lane', () => {
    expect([...new Set([...SAFETY_ROW_LANE_KINDS, ...SAFETY_SNAPSHOT_KINDS])].sort()).toEqual([...SAFETY_KINDS].sort())
  })
})

/* ============ an OTC fill reaches the maker's rules ============ */

// A fill names only the taker on chain, so a maker watching their own account
// used to be told nothing when an order of theirs was consumed — the row was
// not on their feed at all. Now that it is (with the maker as `to`), it has to
// pass the same trade rules a swap does, and say who took it.
describe('OTC fills on the maker side', () => {
  const MAKER = '0x' + 'cc'.repeat(32)
  const otcFill = (over: Partial<ActivityRow> = {}): ActivityRow => activity({
    type: 'otc', otcAction: 'Fill', otcPartial: true, otcOrderId: 1_548,
    who: ref(OWNER), to: ref(MAKER), ...over,
  })

  it('matches a trade rule, an otc rule and an unrestricted one alike', () => {
    for (const type of [undefined, 'trade', 'otc']) {
      const r = rule('account-activity', { target: { kind: 'address', address: WHALE }, type })
      expect(evaluateAccountActivity([otcFill()], [r], W)).toHaveLength(1)
    }
  })

  it('is still excluded by a rule that asked for a different family or action', () => {
    const other = rule('account-activity', { target: { kind: 'address', address: WHALE }, type: 'transfer' })
    expect(evaluateAccountActivity([otcFill()], [other], W)).toHaveLength(0)
    const swaps = rule('account-activity', { target: { kind: 'address', address: WHALE }, type: 'trade', action: 'swap' })
    expect(evaluateAccountActivity([otcFill()], [swaps], W)).toHaveLength(0)
    const fills = rule('account-activity', { target: { kind: 'address', address: WHALE }, type: 'trade', action: 'otc-fill' })
    expect(evaluateAccountActivity([otcFill()], [fills], W)).toHaveLength(1)
  })

  // Both ends of a fill are somebody's account. A rule set up on the taker and a
  // rule set up on the maker are two different subscriptions to the same
  // settlement, and each is entitled to its own notification — the matcher tests
  // the ROW's family and value, never which side of it the target sits on.
  it('matches a rule configured for the taker and one configured for the maker alike', () => {
    const takerRule = rule('account-activity', { target: { kind: 'address', address: WHALE }, type: 'trade' })
    const makerRule = rule('account-activity', { target: { kind: 'address', address: MAKER }, type: 'trade' })
    const row = otcFill()
    expect(evaluateAccountActivity([row], [takerRule], W)).toHaveLength(1)
    expect(evaluateAccountActivity([row], [makerRule], W)).toHaveLength(1)
    // Both at once: one row, one match per rule, and two distinct notifications.
    const both = evaluateAccountActivity([row], [takerRule, makerRule], W)
    expect(both).toHaveLength(2)
    expect(both.map(m => m.identity)).toEqual(['1050-e7', '1050-e7'])
    expect(new Set(both.map(m => notificationIdFor(m.ruleId, m.identity))).size).toBe(2)
  })

  it('keeps a stable identity and opens the fill, not the block', () => {
    expect(activityIdentity(otcFill())).toBe('1050-e7')
    expect(activityPath(otcFill())).toBe('/otc-fill/1050-e7')
  })

  it('names the taker in the headline and the maker on the line under it', () => {
    const r = rule('account-activity', { target: { kind: 'address', address: WHALE }, type: 'trade' })
    const [hit] = evaluateAccountActivity([otcFill()], [r], W)
    const out = renderNotification(renderMatch(hit, r, noViewerTag))
    expect(out.title).toContain('OTC fill by')
    expect(out.body).toContain('to')
    expect(out.url).toMatch(/\/otc-fill\/1050-e7$/)
  })
})
