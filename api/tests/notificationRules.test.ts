import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  NOTIFICATION_KINDS, ACTIVITY_TYPES, SAFETY_KINDS, REFERENDUM_PHASES, REFERENDUM_TRACKS,
  ruleParamSchemas, parseRuleParams, describeRule, isNotificationKind, KIND_LABELS,
  referendumTrackId, referendumTrackName,
} from '../src/notifications/notificationRules.ts'
import { activityTypes } from '../src/routes/explorer.ts'

const SS58 = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
const EVM = '0x531a8b7f7ba36bfd8e0f0b62f2fcb2e2b8e2f99a'
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src')

describe('rule kind registry', () => {
  it('has a schema, a label and a describer for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(ruleParamSchemas[kind], kind).toBeDefined()
      expect(KIND_LABELS[kind], kind).toBeTruthy()
    }
    expect(Object.keys(ruleParamSchemas).sort()).toEqual([...NOTIFICATION_KINDS].sort())
    expect(isNotificationKind('price')).toBe(true)
    expect(isNotificationKind('not-a-kind')).toBe(false)
  })

  // A rule may only name an activity type the feed can actually filter on;
  // a divergence here would produce rules that silently never match.
  it('mirrors the explorer feed activity-type vocabulary', () => {
    expect([...ACTIVITY_TYPES]).toEqual(activityTypes)
  })

  // The security kind spans two sources. Its LEDGER half must name kinds
  // securityService actually emits; its bridge-state half (deficit, released,
  // fuse) exists only in the Wormhole monitor's snapshot and has no counterpart
  // there. `queued` is in both — Hydration-side queue logs on the ledger,
  // origin-side queues in the snapshot.
  it('covers every safety timeline kind the security service emits', () => {
    const src = readFileSync(join(srcDir, 'services/securityService.ts'), 'utf8')
    const snapshotOnly = new Set(['deficit', 'released', 'fuse'])
    for (const kind of SAFETY_KINDS) {
      if (snapshotOnly.has(kind)) continue
      expect(src, kind).toContain(`'${kind}'`)
    }
  })
})

describe('rule param validation', () => {
  it('accepts the documented params per kind', () => {
    expect(parseRuleParams('account-activity', { address: SS58, type: 'trade', minUsd: 100 }).ok).toBe(true)
    expect(parseRuleParams('account-activity', { address: EVM }).ok).toBe(true)
    expect(parseRuleParams('large-trade', { minUsd: 100 }).ok).toBe(true)
    expect(parseRuleParams('large-trade', { assetId: 0, minUsd: 25_000 }).ok).toBe(true)
    expect(parseRuleParams('large-transfer', { minUsd: 100 }).ok).toBe(true)
    expect(parseRuleParams('large-transfer', { assetId: 0, minUsd: 25_000 }).ok).toBe(true)
    expect(parseRuleParams('price', { assetId: 5, direction: 'below', price: 0.005 }).ok).toBe(true)
    expect(parseRuleParams('health-factor', { address: SS58 }).ok).toBe(true)
    expect(parseRuleParams('referendum', { phases: ['deciding', 'confirmed'] }).ok).toBe(true)
    expect(parseRuleParams('referendum', {}).ok).toBe(true)
    expect(parseRuleParams('referendum', { track: '0' }).ok).toBe(true)
    expect(parseRuleParams('referendum', { track: 'root' }).ok).toBe(true)
    expect(parseRuleParams('tc-motion', {}).ok).toBe(true)
    expect(parseRuleParams('tc-motion', { phases: ['proposed', 'voted', 'executed'] }).ok).toBe(true)
    expect(parseRuleParams('safety', { kinds: [...SAFETY_KINDS] }).ok).toBe(true)
    expect(parseRuleParams('extrinsic', { section: 'Utility', method: 'dispatch_as', success: false }).ok).toBe(true)
    expect(parseRuleParams('event', { section: 'Balances' }).ok).toBe(true)
  })

  // Three target shapes, one of which is the pre-target spelling kept alive for
  // rules already in the database and clients already in the wild.
  it('accepts every account-activity target spelling and normalizes the legacy one', () => {
    const legacy = parseRuleParams('account-activity', { address: SS58, type: 'trade' })
    expect(legacy.ok && legacy.params.target).toEqual({ kind: 'address', address: SS58 })
    const explicit = parseRuleParams('account-activity', { target: { kind: 'address', address: EVM } })
    expect(explicit.ok && explicit.params.target).toEqual({ kind: 'address', address: EVM })
    const tag = parseRuleParams('account-activity', { target: { kind: 'tag', tagId: 'money-market' }, minUsd: 1_000 })
    expect(tag.ok && tag.params.target).toEqual({ kind: 'tag', tagId: 'money-market' })
    const listTag = parseRuleParams('account-activity', {
      target: { kind: 'list-tag', listId: '2b7f0a1e-0000-4000-8000-000000000001', tagId: '2b7f0a1e-0000-4000-8000-000000000002' },
    })
    expect(listTag.ok).toBe(true)
  })

  it('rejects a malformed or incomplete target', () => {
    expect(parseRuleParams('account-activity', {}).ok).toBe(false)
    expect(parseRuleParams('account-activity', { target: { kind: 'tag' } }).ok).toBe(false)
    expect(parseRuleParams('account-activity', { target: { kind: 'list-tag', listId: 'x' } }).ok).toBe(false)
    expect(parseRuleParams('account-activity', { target: { kind: 'nonsense', tagId: 'x' } }).ok).toBe(false)
    expect(parseRuleParams('account-activity', { target: { kind: 'address', address: 'not-an-address' } }).ok).toBe(false)
    // Still a closed param set: an unknown key is a typo, not an extension.
    expect(parseRuleParams('account-activity', { target: { kind: 'tag', tagId: 'x' }, nope: 1 }).ok).toBe(false)
  })

  it('defaults the health-factor threshold to 1.1', () => {
    const parsed = parseRuleParams('health-factor', { address: SS58 })
    expect(parsed.ok && parsed.params.threshold).toBe(1.1)
  })

  it('rejects params that would produce an unmatchable or unbounded rule', () => {
    // A "large trade" floor under $100 is every trade.
    expect(parseRuleParams('large-trade', { minUsd: 5 }).ok).toBe(false)
    expect(parseRuleParams('large-trade', {}).ok).toBe(false)
    // The transfer sibling shares that floor, and the same closed param set.
    expect(parseRuleParams('large-transfer', { minUsd: 5 }).ok).toBe(false)
    expect(parseRuleParams('large-transfer', {}).ok).toBe(false)
    expect(parseRuleParams('large-transfer', { minUsd: 5_000, address: SS58 }).ok).toBe(false)
    expect(parseRuleParams('price', { assetId: 5, direction: 'sideways', price: 1 }).ok).toBe(false)
    expect(parseRuleParams('price', { assetId: 5, direction: 'above', price: 0 }).ok).toBe(false)
    expect(parseRuleParams('account-activity', { address: 'not-an-address' }).ok).toBe(false)
    expect(parseRuleParams('account-activity', { address: SS58, type: 'nonsense' }).ok).toBe(false)
    expect(parseRuleParams('health-factor', { address: SS58, threshold: 42 }).ok).toBe(false)
    expect(parseRuleParams('referendum', { phases: ['pending'] }).ok).toBe(false)
    // A track that is neither an id nor a name would match nothing at all.
    expect(parseRuleParams('referendum', { track: 'treasury' }).ok).toBe(false)
    // The two governance kinds keep separate vocabularies on purpose: neither can
    // be talked into delivering the other's traffic.
    expect(parseRuleParams('tc-motion', { phases: ['deciding'] }).ok).toBe(false)
    expect(parseRuleParams('tc-motion', { track: '0' }).ok).toBe(false)
    expect(parseRuleParams('referendum', { phases: ['approved'] }).ok).toBe(false)
    expect(parseRuleParams('referendum', { track: '99' }).ok).toBe(false)
    expect(parseRuleParams('safety', { kinds: [] }).ok).toBe(false)
    expect(parseRuleParams('extrinsic', { section: 'Utility.dispatch' }).ok).toBe(false)
    expect(parseRuleParams('event', {}).ok).toBe(false)
    // Unknown keys are a typo, not a silently-ignored extension point.
    expect(parseRuleParams('event', { section: 'Balances', minUsd: 1 }).ok).toBe(false)
  })

  it('names the offending field in its error', () => {
    const parsed = parseRuleParams('price', { assetId: 5, direction: 'above', price: -1 })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('price')
  })
})

describe('describeRule', () => {
  it('summarizes each kind in one line', () => {
    expect(describeRule('account-activity', { address: SS58, type: 'trade', minUsd: 5000 }))
      // No address in the sentence: every surface that shows it draws the
      // account beside it as a pill, and repeating a truncated address there is
      // what made a rule read its own address twice.
      .toBe('trade activity over $5k')
    expect(describeRule('large-trade', { assetId: 0, minUsd: 10_000 })).toBe('trades over $10k on asset 0')
    expect(describeRule('price', { assetId: 5, direction: 'below', price: 0.005 })).toBe('asset 5 price below $0.005')
    // With the asset registry to hand, an id reads as its ticker.
    const symbolOf = (id: number) => (id === 0 ? 'HDX' : `#${id}`)
    expect(describeRule('large-trade', { assetId: 0, minUsd: 10_000 }, symbolOf)).toBe('trades over $10k on HDX')
    expect(describeRule('large-transfer', { minUsd: 10_000 })).toBe('transfers over $10k')
    expect(describeRule('large-transfer', { assetId: 0, minUsd: 10_000 }, symbolOf)).toBe('transfers over $10k of HDX')
    expect(describeRule('price', { assetId: 0, direction: 'below', price: 0.005 }, symbolOf)).toBe('HDX price below $0.005')
    expect(describeRule('health-factor', { address: SS58, threshold: 1.1 })).toContain('health factor below 1.1')
    expect(describeRule('referendum', { phases: ['deciding'] })).toBe('referenda — deciding')
    expect(describeRule('referendum', { track: '1' })).toBe('referenda — any phase on whitelisted_caller')
    expect(describeRule('tc-motion', {})).toBe('technical committee motions — any phase')
    expect(describeRule('tc-motion', { phases: ['voted', 'approved'] })).toBe('technical committee motions — voted, approved')
    expect(describeRule('safety', {})).toBe('Security · every action')
    expect(describeRule('extrinsic', { section: 'Utility', success: false })).toBe('extrinsic Utility.* (failed)')
    expect(describeRule('event', { section: 'Balances', method: 'Slashed' })).toBe('event Balances.Slashed')
    expect(REFERENDUM_PHASES.length).toBeGreaterThan(0)
  })

  // A tag target names a group, so the summary names the group — and says so
  // from the reader's own vocabulary, via the lookup the caller supplies.
  it('names a tag target rather than an address', () => {
    const labelOf = () => ({ name: 'Kraken' })
    expect(describeRule('account-activity', { target: { kind: 'tag', tagId: 'kraken' } }, undefined, labelOf))
      .toBe('Any activity by tag "Kraken"')
    expect(describeRule('account-activity', { target: { kind: 'tag', tagId: 'kraken' }, type: 'trade', minUsd: 5000 }, undefined, labelOf))
      .toBe('trade activity over $5k by tag "Kraken"')
    expect(describeRule('account-activity', { target: { kind: 'list-tag', listId: 'l1', tagId: 't1' } }, undefined,
      () => ({ name: 'watchlist', listName: 'My lists' }))).toBe('Any activity by "watchlist" (My lists)')
    // Without a lookup — or for a tag the owner can no longer see — the rule
    // still describes itself, generically, and never leaks the id.
    const generic = describeRule('account-activity', { target: { kind: 'list-tag', listId: 'l1', tagId: 't1' } })
    expect(generic).toBe('Any activity by a list tag')
    expect(describeRule('account-activity', { target: { kind: 'tag', tagId: 'kraken' } })).toBe('Any activity by a tag')
  })

  // A rule persisted under an older param shape must still render rather than
  // throwing on the rules list.
  it('falls back to the kind label for params that no longer parse', () => {
    expect(describeRule('price', { nope: true })).toBe(KIND_LABELS.price)
  })
})

// The chain reports a numeric track id; people write "root". Both have to reach
// the matcher as the same id, or a rule written by name never matches.
describe('OpenGov tracks', () => {
  it('normalizes a name or an id to the numeric id, loosely on the name', () => {
    expect(referendumTrackId('0')).toBe(0)
    expect(referendumTrackId('root')).toBe(0)
    expect(referendumTrackId('Whitelisted Caller')).toBe(1)
    expect(referendumTrackId('whitelisted-caller')).toBe(1)
    expect(referendumTrackId('economic_parameters')).toBe(9)
    expect(referendumTrackId('nonexistent')).toBeNull()
    expect(referendumTrackId('42')).toBeNull()
  })

  it('stores the id whichever form the rule used', () => {
    const byName = parseRuleParams('referendum', { track: 'treasurer' })
    const byId = parseRuleParams('referendum', { track: '5' })
    expect(byName.ok && byName.params.track).toBe('5')
    expect(byId.ok && byId.params.track).toBe('5')
  })

  it('names every track exactly once', () => {
    expect(REFERENDUM_TRACKS.map(t => t.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(REFERENDUM_TRACKS.map(t => t.name)).size).toBe(REFERENDUM_TRACKS.length)
    expect(referendumTrackName(8)).toBe('omnipool_admin')
    expect(referendumTrackName(42)).toBeNull()
  })
})

// The money markets are isolated pools with their own health factors and their
// own caps, so a rule about either names WHICH market it watches. A health-factor
// rule written before markets existed watched the primary one, and re-parses
// into exactly that.
describe('money-market rules name their market', () => {
  const marketLabel = (key: string) => (key === 'gigahdx' ? 'GIGAHDX' : key === 'core' ? 'Money Market' : null)

  it('defaults a health-factor rule to the primary market and accepts another', () => {
    const core = parseRuleParams('health-factor', { address: SS58 })
    expect(core.ok && core.params.market).toBe('core')
    const giga = parseRuleParams('health-factor', { address: SS58, market: 'gigahdx' })
    expect(giga.ok && giga.params.market).toBe('gigahdx')
    expect(parseRuleParams('health-factor', { address: SS58, market: 'not a market!' }).ok).toBe(false)
  })

  it('accepts one cap rule per market, optionally narrowed to a token', () => {
    expect(parseRuleParams('mm-cap', { market: 'gigahdx' }).ok).toBe(true)
    expect(parseRuleParams('mm-cap', { market: 'gigahdx', assetId: 222 }).ok).toBe(true)
    expect(parseRuleParams('mm-cap', {}).ok).toBe(false)
    expect(parseRuleParams('mm-cap', { market: 'gigahdx', minUsd: 5 }).ok).toBe(false)
    expect(KIND_LABELS['mm-cap']).toBe('Money market cap')
  })

  it('names the market in a summary unless it is the primary one', () => {
    expect(describeRule('health-factor', { address: SS58, threshold: 1.1 })).toBe('health factor below 1.1')
    expect(describeRule('health-factor', { address: SS58, threshold: 1.1, market: 'gigahdx' }, undefined, undefined, marketLabel))
      .toBe('GIGAHDX health factor below 1.1')
    expect(describeRule('mm-cap', { market: 'gigahdx' }, undefined, undefined, marketLabel)).toBe('reserve caps on GIGAHDX')
    expect(describeRule('mm-cap', { market: 'gigahdx', assetId: 222 }, id => (id === 222 ? 'HOLLAR' : `#${id}`), undefined, marketLabel))
      .toBe('HOLLAR cap on GIGAHDX')
    // Without a label lookup the key stands in rather than nothing.
    expect(describeRule('mm-cap', { market: 'bil' })).toBe('reserve caps on bil')
  })
})

// Where the account is drawn beside the sentence, the sentence must not repeat
// it. Address targets used to spell out a truncated address that the rule's
// auto-generated name ALSO spelled out, so one row said "Activity of 1C1rAh…"
// twice over.
describe('describeRule — an address target names no account', () => {
  const ADDR = '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ'
  it('leaves the account to the pill for every kind that targets one', () => {
    expect(describeRule('account-activity', { target: { kind: 'address', address: ADDR } })).toBe('any activity')
    expect(describeRule('health-factor', { target: { kind: 'address', address: ADDR }, threshold: 1.2 }))
      .toBe('health factor below 1.2')
    expect(describeRule('liquidation', { target: { kind: 'address', address: ADDR } })).toBe('liquidations')
  })

  it('still names a TAG, which the pill alone would not identify by list', () => {
    const tag = () => ({ name: 'Treasury', members: [], memberCount: 2, icon: '', color: '' })
    expect(describeRule('account-activity', { target: { kind: 'tag', tagId: 't' } }, () => '', tag))
      .toBe('Any activity by tag "Treasury"')
  })
})
