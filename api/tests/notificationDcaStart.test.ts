import { describe, expect, it } from 'vitest'
import { dcaHourlyValueUsd, evaluateDcaStart, dcaPricedAsset, type DcaScheduleRow } from '../src/notifications/evaluator.ts'
import type { NotificationRule } from '../src/notifications/notificationStore.ts'
import { parseRuleParams } from '../src/notifications/notificationRules.ts'

// A DCA schedule is a standing order, not a trade, so "is this large?" has to be
// answered from its RATE and its SIZE together:
//
//   rate alone  overstates a short burst — schedule 35017 read as $13.1k/hour
//               while only ever moving $315 across three executions
//   total alone ignores a large slow schedule that moves real size every hour
//
// The lower of the two is what an hour of the schedule is actually worth. A
// `totalAmount` of 0 on chain means UNBOUNDED, where only the rate bounds it.
const BLOCK_MS = 4_800

describe('the hourly value of a DCA schedule', () => {
  it('is capped by the total for a short burst that finishes inside the hour', () => {
    // schedule 35017: 10k HDX (~$105) every 6 blocks, 3 executions, ~$315 total
    expect(dcaHourlyValueUsd(105, 315, 6, BLOCK_MS)).toBeCloseTo(315, 6)
  })

  it('is the rate for an unbounded schedule', () => {
    // the treasury buyback: 1.04 H2O (~$5.78) every 10 blocks, no total
    expect(dcaHourlyValueUsd(5.78, null, 10, BLOCK_MS)).toBeCloseTo(433.5, 6)
  })

  it('is capped by the rate for a large slow schedule', () => {
    // $1000 an execution, one execution an hour, $1M total
    expect(dcaHourlyValueUsd(1_000, 1_000_000, 750, BLOCK_MS)).toBeCloseTo(1_000, 6)
  })

  it('is zero for a schedule with no period or no value', () => {
    expect(dcaHourlyValueUsd(105, 315, 0, BLOCK_MS)).toBe(0)
    expect(dcaHourlyValueUsd(0, 315, 6, BLOCK_MS)).toBe(0)
  })
})

// Opt-out, not opt-in: a rule stored before this shipped carries no flag and must
// behave as enabled. `.default(true)` rather than `.optional()` so the parsed
// params always carry an explicit value — rule creation is idempotent on the
// canonical params, and an implied default would give one rule two canonical keys.
describe('the large-trade dcaStart parameter', () => {
  it('defaults to on for a rule stored without it', () => {
    const parsed = parseRuleParams('large-trade', { assetId: 0, minUsd: 500 })

    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.params).toEqual({ assetId: 0, minUsd: 500, dcaStart: true })
  })

  it('can be turned off explicitly', () => {
    const parsed = parseRuleParams('large-trade', { assetId: 0, minUsd: 500, dcaStart: false })

    expect(parsed.ok && (parsed.params as { dcaStart: boolean }).dcaStart).toBe(false)
  })

  it('is not accepted on large-transfer, which has no DCA to start', () => {
    const parsed = parseRuleParams('large-transfer', { assetId: 0, minUsd: 500, dcaStart: true })

    expect(parsed.ok).toBe(false)
  })
})

// The matcher over new schedules. Values are supplied, so this pins the decision
// (scope, floor, opt-out, identity) without touching prices or ClickHouse.
const schedule = (over: Partial<DcaScheduleRow> = {}): DcaScheduleRow => ({
  id: 35_017, blockHeight: 100, who: '0x' + 'ab'.repeat(32),
  assetIn: 0, assetOut: 1_000_767, direction: 'Sell',
  amountPer: '10000000000000000', totalAmount: '30000000000000000', periodBlocks: 6, ...over,
})

const tradeRule = (params: Record<string, unknown>): NotificationRule => ({
  ruleId: 'r1', accountId: '0xacct', kind: 'large-trade', name: '',
  params: { assetId: 0, minUsd: 1_000, dcaStart: true, ...params },
  channels: [], muted: false, cooldownS: 0,
})

// 10,000 HDX per execution at $0.0105, 30,000 HDX total.
const priceHdx = (assetId: number, raw: string): number | null =>
  (assetId === 0 ? Number(BigInt(raw) / 1_000_000n) / 1e6 * 0.0105 : null)

const WINDOW = { from: 99, to: 100 }

describe('matching a DCA start', () => {
  it('stays silent on a short burst whose total is below the floor', () => {
    // $13.1k/hour but only $315 total -> min() is $315, under a $1k rule.
    expect(evaluateDcaStart([schedule()], [tradeRule({})], WINDOW, priceHdx, 4_800)).toHaveLength(0)
  })

  it('fires on an unbounded schedule whose rate clears the floor', () => {
    const matches = evaluateDcaStart(
      [schedule({ totalAmount: '0' })], [tradeRule({ minUsd: 1_000 })], WINDOW, priceHdx, 4_800)

    expect(matches).toHaveLength(1)
    expect(matches[0].identity).toBe('dca:35017')
  })

  it('respects the asset scope on either leg', () => {
    const rows = [schedule({ totalAmount: '0' })]
    expect(evaluateDcaStart(rows, [tradeRule({ assetId: 1_000_767 })], WINDOW, priceHdx, 4_800)).toHaveLength(1)
    expect(evaluateDcaStart(rows, [tradeRule({ assetId: 42 })], WINDOW, priceHdx, 4_800)).toHaveLength(0)
  })

  it('is silent for a rule that opted out', () => {
    const rows = [schedule({ totalAmount: '0' })]
    expect(evaluateDcaStart(rows, [tradeRule({ dcaStart: false })], WINDOW, priceHdx, 4_800)).toHaveLength(0)
  })

  it('prices the leg the schedule fixed', () => {
    expect(dcaPricedAsset(schedule({ direction: 'Sell' }))).toBe(0)
    expect(dcaPricedAsset(schedule({ direction: 'Buy' }))).toBe(1_000_767)
  })

  it('ignores a schedule outside the window', () => {
    const rows = [schedule({ blockHeight: 50, totalAmount: '0' })]
    expect(evaluateDcaStart(rows, [tradeRule({})], WINDOW, priceHdx, 4_800)).toHaveLength(0)
  })
})
