import { describe, expect, it } from 'vitest'
import { describeRule, healthFactorParams, parseRuleParams } from '../src/notifications/notificationRules.ts'
import { parseMemberArmStates } from '../src/notifications/evaluator.ts'

const ADDR = '0x' + 'ab'.repeat(20)   // H160 form — the params schema takes SS58 or 0x-40-hex

// Health-factor rules take the account-activity target union (address | tag |
// list-tag); the legacy `{ address }` spelling keeps parsing by normalizing
// into the address target on every load, so stored rules need no migration.
describe('health-factor target params', () => {
  it('normalizes the legacy address form into an address target', () => {
    const parsed = healthFactorParams.parse({ address: ADDR, threshold: 1.6 })
    // …and, having been written before markets existed, into the primary market.
    expect(parsed).toEqual({ target: { kind: 'address', address: ADDR }, threshold: 1.6, market: 'core' })
  })

  it('accepts tag and list-tag targets and defaults the threshold', () => {
    expect(healthFactorParams.parse({ target: { kind: 'tag', tagId: 'treasury' } }))
      .toEqual({ target: { kind: 'tag', tagId: 'treasury' }, threshold: 1.1, market: 'core' })
    expect(healthFactorParams.parse({ target: { kind: 'list-tag', listId: 'l1', tagId: 't1' } }).target)
      .toEqual({ kind: 'list-tag', listId: 'l1', tagId: 't1' })
  })

  it('rejects params with neither spelling', () => {
    expect(parseRuleParams('health-factor', { threshold: 1.1 }).ok).toBe(false)
  })

  it('describes an address rule by the threshold alone and a tag rule by the resolved tag name', () => {
    // The account is drawn as a pill beside the sentence, so the sentence says
    // what is watched rather than repeating whose account it is.
    expect(describeRule('health-factor', { address: ADDR, threshold: 1.2 }, () => ''))
      .toBe('health factor below 1.2')
    expect(describeRule('health-factor', { target: { kind: 'tag', tagId: 'treasury' }, threshold: 1.2 }, () => '',
      () => ({ name: 'Treasury', members: [], memberCount: 0, icon: '', color: '' })))
      .toBe('health factor below 1.2 in tag "Treasury"')
  })
})

// A tag rule keeps ONE state row bundling per-member arm states (the row the
// store already deletes with the rule); the legacy plain shape stays readable.
describe('per-member arm-state bundling', () => {
  it('round-trips the bundled shape and ignores garbage members', () => {
    const raw = JSON.stringify({ members: {
      [ADDR]: { armed: true, lastValue: 2.1, epoch: 0 },
      bad: { armed: 'nope' },
    } })
    const states = parseMemberArmStates(raw)
    expect(states?.size).toBe(1)
    expect(states?.get(ADDR)).toEqual({ armed: true, lastValue: 2.1, epoch: 0 })
  })

  it('returns null for the legacy plain shape and for garbage', () => {
    expect(parseMemberArmStates(JSON.stringify({ armed: true, lastValue: 2, epoch: 0 }))).toBeNull()
    expect(parseMemberArmStates('not json')).toBeNull()
    expect(parseMemberArmStates(null)).toBeNull()
  })
})
