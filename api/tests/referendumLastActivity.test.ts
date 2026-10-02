import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { NON_ACTIVITY_EVENTS, latestMoment } from '../src/services/governanceService.ts'

// The /governance list sorts by last activity. A deposit refund is the pallet settling
// up after a referendum ended — one refund batch floated dozens of old referenda to the
// top — so it does not count; the enactment and the scheduled executions it files
// (which are not lifecycle events at all) do.
describe('referendum last activity', () => {
  it('excludes exactly the two deposit refunds', () => {
    expect([...NON_ACTIVITY_EVENTS]).toEqual(['Referenda.DecisionDepositRefunded', 'Referenda.SubmissionDepositRefunded'])
    const src = readFileSync(new URL('../src/services/governanceService.ts', import.meta.url), 'utf8')
    expect(src).toContain('maxIf(block_height, event_name NOT IN (${NON_ACTIVITY_EVENTS_SQL}))')
  })

  it('takes the latest of the lifecycle, the enactment and its scheduled executions', () => {
    const lifecycle = { blockHeight: 100, timestamp: 'a' }
    const enactment = { blockHeight: 150, timestamp: 'b' }
    const scheduled = { blockHeight: 151, timestamp: 'c' }
    expect(latestMoment([lifecycle, enactment, scheduled])).toEqual(scheduled)
    expect(latestMoment([lifecycle, null, undefined])).toEqual(lifecycle)
    expect(latestMoment([])).toBeNull()
  })
})
