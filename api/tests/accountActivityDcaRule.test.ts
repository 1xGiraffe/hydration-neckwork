import { describe, expect, it } from 'vitest'
import { evaluateAccountActivity } from '../src/notifications/evaluator.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'
import type { NotificationRule } from '../src/notifications/notificationStore.ts'

// 'dca' is not a row type. The feed categorises DCA executions under the Trade chip
// and keeps a `dca` flag for the badge — `normalizeActivityTypeKey` does that mapping
// on the FETCH side, so asking for type=dca correctly returns rows whose own `type`
// reads 'trade'. The matcher then compared the rule's word to `row.type` directly, so
// 'trade' === 'dca' was never true and every dca rule was permanently silent.
//
// Measured live 2026-08-20: rule b6cb22d7 (dca activity of 14DnBuA7Qt…) sat 46h and
// two real DCA executions — 2026-08-19 03:02 and 2026-08-20 01:42 — without firing.
const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  type: 'trade', blockHeight: 100, eventIndex: 1, timestamp: '2026-08-20 01:42:48',
  finalized: true, ...over,
} as ActivityRow)

const rule = (type: string): NotificationRule => ({
  ruleId: 'r1', accountId: '0xacct', kind: 'account-activity', name: '',
  params: { target: { address: '14DnBuA7', kind: 'address' }, type },
  channels: [], muted: false, cooldownS: 0,
})

const WINDOW = { from: 99, to: 100 }

describe('an account-activity rule scoped to dca', () => {
  it('matches the DCA execution the feed returns as a flagged trade row', () => {
    const matches = evaluateAccountActivity([row({ dca: true })], [rule('dca')], WINDOW)

    expect(matches).toHaveLength(1)
  })

  it('does not match a plain swap, which is the same row type without the flag', () => {
    const matches = evaluateAccountActivity([row({ dca: false })], [rule('dca')], WINDOW)

    expect(matches).toHaveLength(0)
  })
})

// The neighbouring types must keep working exactly as they did.
describe('the other account-activity types', () => {
  it('still match their own row type, and a trade rule still takes dca and otc rows', () => {
    expect(evaluateAccountActivity([row({ dca: true })], [rule('trade')], WINDOW)).toHaveLength(1)
    expect(evaluateAccountActivity([row({ type: 'otc' } as Partial<ActivityRow>)], [rule('trade')], WINDOW)).toHaveLength(1)
    expect(evaluateAccountActivity([row({ type: 'transfer' } as Partial<ActivityRow>)], [rule('transfer')], WINDOW)).toHaveLength(1)
    expect(evaluateAccountActivity([row({ type: 'staking' } as Partial<ActivityRow>)], [rule('stake')], WINDOW)).toHaveLength(1)
    expect(evaluateAccountActivity([row({ type: 'transfer' } as Partial<ActivityRow>)], [rule('trade')], WINDOW)).toHaveLength(0)
  })
})
