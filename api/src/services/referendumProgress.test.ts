import { describe, expect, it } from 'vitest'
import { opengovPhase, progressFrom } from './governanceService.ts'
import { PERBILL, trackById } from './referendaTracks.ts'

const row = (event_name: string, block_height: number) => ({ event_name, block_height })

// Real lifecycle shapes from the live chain (2026-08-18/19), block numbers included.

const REF_384_DECIDING = [
  row('Referenda.Submitted', 13670146),
  row('Referenda.DecisionStarted', 13676438),
  row('Referenda.DecisionDepositPlaced', 13676438),
]

const REF_382_CONFIRMING = [
  row('Referenda.Submitted', 13657923),
  row('Referenda.DecisionDepositPlaced', 13657939),
  row('Referenda.DecisionStarted', 13658523),
  row('Referenda.ConfirmStarted', 13678964),
]

const REF_383_CONCLUDED = [
  ...REF_382_CONFIRMING.map(r => ({ ...r })),
  row('Referenda.Confirmed', 13681237),
]

describe('opengovPhase', () => {
  it('deciding once DecisionStarted, regardless of event order within the block', () => {
    expect(opengovPhase(REF_384_DECIDING)).toEqual({
      phase: 'deciding', submittedBlock: 13670146, decisionStartBlock: 13676438,
      confirmStartBlock: null, decisionDepositPlaced: true,
    })
  })

  it('confirming from the last un-aborted ConfirmStarted', () => {
    expect(opengovPhase(REF_382_CONFIRMING)?.phase).toBe('confirming')
    expect(opengovPhase(REF_382_CONFIRMING)?.confirmStartBlock).toBe(13678964)
  })

  it('an aborted confirmation falls back to deciding; a re-confirmation uses the LATER block', () => {
    const aborted = [...REF_382_CONFIRMING, row('Referenda.ConfirmAborted', 13680000)]
    expect(opengovPhase(aborted)).toMatchObject({ phase: 'deciding', confirmStartBlock: null })
    const reconfirmed = [...aborted, row('Referenda.ConfirmStarted', 13681000)]
    expect(opengovPhase(reconfirmed)).toMatchObject({ phase: 'confirming', confirmStartBlock: 13681000 })
  })

  it('preparing before DecisionStarted, and knows whether the deposit is in', () => {
    expect(opengovPhase([row('Referenda.Submitted', 100)])).toMatchObject({ phase: 'preparing', decisionDepositPlaced: false })
    expect(opengovPhase([row('Referenda.Submitted', 100), row('Referenda.DecisionDepositPlaced', 110)]))
      .toMatchObject({ phase: 'preparing', decisionDepositPlaced: true })
  })

  it('null once concluded — a concluded referendum has no phase', () => {
    expect(opengovPhase(REF_383_CONCLUDED)).toBeNull()
    for (const ending of ['Referenda.Rejected', 'Referenda.Cancelled', 'Referenda.TimedOut', 'Referenda.Killed']) {
      expect(opengovPhase([...REF_384_DECIDING, row(ending, 13700000)])).toBeNull()
    }
  })

  it('null before the Submitted row is indexed', () => {
    expect(opengovPhase([row('Referenda.DecisionStarted', 100)])).toBeNull()
    expect(opengovPhase([])).toBeNull()
  })
})

describe('progressFrom', () => {
  const treasurer = trackById(5)!
  const direct = { ayes: '0', nays: '0', support: '0' }

  it('phase boundary blocks come from the track periods', () => {
    const progress = progressFrom(opengovPhase(REF_382_CONFIRMING)!, treasurer, 13680000, null, direct)
    expect(progress.decisionEndBlock).toBe(13658523 + 100_800)
    expect(progress.confirmEndBlock).toBe(13678964 + 7_200)
    expect(progress.earliestDecisionBlock).toBeNull()
    expect(progress.timeoutBlock).toBeNull()
  })

  it('preparing without a deposit carries the undeciding timeout; with one it does not', () => {
    const noDeposit = progressFrom(opengovPhase([row('Referenda.Submitted', 1000)])!, treasurer, 1500, null, direct)
    expect(noDeposit.earliestDecisionBlock).toBe(1000 + 600)
    expect(noDeposit.timeoutBlock).toBe(1000 + 28_800)
    expect(noDeposit.approval).toBeNull()
    expect(noDeposit.support).toBeNull()
    const deposited = progressFrom(
      opengovPhase([row('Referenda.Submitted', 1000), row('Referenda.DecisionDepositPlaced', 1010)])!,
      treasurer, 1500, null, direct,
    )
    expect(deposited.timeoutBlock).toBeNull()
  })

  it('gauges read the live tally against the curves at the elapsed decision fraction', () => {
    // One day into a 7-day decision period: approval bar sits at the curve's
    // constructed 80% anchor. 90% approval passes it; 10% support clears the
    // linear support bar (which has decayed below 18%·6/7 ≈ 15.43%... it is
    // 18%·(1 − 1/7) = 15.43%, so 10% FAILS).
    const phase = opengovPhase([
      row('Referenda.Submitted', 0),
      row('Referenda.DecisionDepositPlaced', 0),
      row('Referenda.DecisionStarted', 0),
    ])!
    const head = treasurer.decisionPeriod / 7
    const live = { ayes: '9000', nays: '1000', support: '100000', electorate: '1000000' }
    const progress = progressFrom(phase, treasurer, head, live, direct)
    expect(progress.approval).toMatchObject({ currentPerbill: 0.9 * PERBILL, passing: true, source: 'chain' })
    expect(Math.abs(progress.approval!.thresholdPerbill - 0.8 * PERBILL)).toBeLessThan(10)
    expect(progress.support).toMatchObject({ currentPerbill: 0.1 * PERBILL, passing: false, source: 'chain' })
    expect(Math.abs(progress.support!.thresholdPerbill - (6 / 7) * 0.18 * PERBILL)).toBeLessThan(5)
  })

  it('falls back to attributed approval without a live tally, and leaves support blank', () => {
    const phase = opengovPhase(REF_384_DECIDING)!
    const progress = progressFrom(phase, treasurer, 13700000, null, { ayes: '3000', nays: '1000', support: '4000' })
    expect(progress.approval).toMatchObject({ currentPerbill: 0.75 * PERBILL, source: 'attributed' })
    expect(progress.support).toMatchObject({ currentPerbill: null, passing: null, source: null })
    expect(progress.support!.thresholdPerbill).toBeGreaterThan(0)
  })

  it('clamps the curve clock at the decision period end (a confirm can straddle it)', () => {
    const phase = opengovPhase(REF_382_CONFIRMING)!
    const farPast = progressFrom(phase, treasurer, 13658523 + treasurer.decisionPeriod + 50_000, { ayes: '1', nays: '1', support: '1', electorate: '100' }, direct)
    // At x = 1 the treasurer approval curve bottoms out at 50%.
    expect(Math.abs(farPast.approval!.thresholdPerbill - 0.5 * PERBILL)).toBeLessThan(10)
  })
})
