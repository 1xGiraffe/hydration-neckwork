import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import {
  getDailyActivity,
  initExplorerService,
  isIntentOnlyTradeRequest,
  resolveBilAction,
  resolveIntentActions,
  resolveJuicerAction,
  v3LiquidityHistogramNames,
} from '../src/services/explorerService.ts'

// A feed's `action` is request input. Every table it is looked up in must answer a
// key that only exists on Object.prototype as an unknown action — never with the
// inherited member, which would fail further down as a 500.
const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']

describe('action lookups ignore prototype keys', () => {
  it.each(PROTOTYPE_KEYS)('resolves %s as no action', key => {
    expect(resolveJuicerAction(key)).toBeNull()
    expect(resolveBilAction(key)).toBeNull()
    expect(resolveIntentActions(key)).toBeUndefined()
    expect(v3LiquidityHistogramNames(key)).toEqual([])
    expect(isIntentOnlyTradeRequest('trade', key)).toBe(false)
  })

  it('still resolves the real actions', () => {
    expect(resolveIntentActions('intent-fill')).toEqual(['Fill', 'PartialFill'])
    expect(isIntentOnlyTradeRequest('trade', 'intent-place')).toBe(true)
    expect(resolveJuicerAction('nonsense')).toBeNull()
  })
})

describe('daily activity with a prototype-key action', () => {
  const queries: string[] = []
  initExplorerService({
    query: async (opts: { query: string }) => {
      queries.push(opts.query)
      return { json: async () => [] }
    },
  } as unknown as ClickHouseClient)

  // Each type's own action table: staking, bond, otc, and otc again under trade.
  it.each(PROTOTYPE_KEYS.flatMap(action => ['staking', 'bond', 'otc', 'trade'].map(type => [type, action])))(
    'answers type=%s action=%s without throwing',
    async (type, action) => {
      queries.length = 0
      const days = await getDailyActivity('activity', { type, action })
      expect(days.every(day => day.value === 0)).toBe(true)
      expect(queries.join('\n')).not.toContain('native code')
    },
  )
})
