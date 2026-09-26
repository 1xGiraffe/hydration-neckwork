import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { atokenAnchorDecision, incentiveAnchorDecision, reconcileOutcome, runAnchorCycle, type AtokenAnchorPort, type IncentiveAnchorPort, type LmEntryReconcilePort } from '../../src/scripts/anchorLoop.ts'
import type { LmReconcileResult } from '../../src/scripts/lmEntryCapture.ts'

// The anchors loop (snapshot-atoken-anchors.ts --loop, the atoken-anchor service):
// one process, two B0 anchors and the LM entry reconcile, each on its own gate,
// none able to block another.

const LOGS_FROM = 7_346_900
const MM_FROM = 6_382_800
const B0 = 8_200_000
const GAP = { fromBlock: 7_400_000, toBlock: 7_400_999 }

const CLEAN: LmReconcileResult = { openBefore: 0, uncapturedBlocks: 0, unparsedDepositIds: 0, firstUnparsed: [], truncated: false, blocks: 0, rows: 0, gone: 0, failed: [], openAfter: 0 }

function fakes(state: { atokenRows?: number; incentiveRows?: number; gaps?: Array<{ fromBlock: number; toBlock: number }>; atokenGaps?: Array<{ fromBlock: number; toBlock: number }>; atokenFails?: 'map' | 'capture'; incentiveFails?: boolean; lm?: LmReconcileResult | 'throw' } = {}) {
  const calls: string[] = []
  const atoken: AtokenAnchorPort = {
    refreshReserveMap: async () => { calls.push('atoken.map'); if (state.atokenFails === 'map') throw new Error('reserve map unreadable') },
    anchorRowCount: async () => { calls.push('atoken.count'); return state.atokenRows ?? 0 },
    logGaps: async () => { calls.push('atoken.gaps'); return state.atokenGaps ?? [] },
    capture: async mode => { calls.push(`atoken.capture:${mode}`); if (state.atokenFails === 'capture') throw new Error('rpc down') },
  }
  const incentive: IncentiveAnchorPort = {
    anchorRowCount: async () => { calls.push('incentive.count'); return state.incentiveRows ?? 0 },
    controllerLogGaps: async () => { calls.push('incentive.gaps'); return state.gaps ?? [] },
    capture: async mode => { calls.push(`incentive.capture:${mode}`); if (state.incentiveFails) throw new Error('empty return') },
  }
  const lmEntries: LmEntryReconcilePort = {
    reconcile: async () => { calls.push('lm.reconcile'); if (state.lm === 'throw') throw new Error('clickhouse down'); return state.lm ?? CLEAN },
  }
  const logs: Array<Record<string, unknown>> = []
  return { ports: { atoken, incentive, lmEntries }, calls, logs, log: (r: Record<string, unknown>) => { logs.push(r) } }
}
const opts = { forceAtoken: false, forceIncentive: false, atokenLogsFrom: MM_FROM, incentiveLogsFrom: LOGS_FROM, anchorBlock: B0 }

describe('each anchor keeps its own gate', () => {
  it('aToken: needs complete money-market log coverage; then a full capture on an empty table (or --force), a top-up otherwise', async () => {
    const port = (rows: number, gaps: typeof GAP[]) => ({ anchorRowCount: async () => rows, logGaps: async () => gaps })
    expect(await atokenAnchorDecision(port(0, []), false, MM_FROM, B0)).toEqual({ capture: true, mode: 'full' })
    // A non-empty table is topped up, never left alone: a holder no source named at
    // the first capture is anchored once a source names it.
    expect(await atokenAnchorDecision(port(12, []), false, MM_FROM, B0)).toEqual({ capture: true, mode: 'top-up' })
    expect(await atokenAnchorDecision(port(0, [GAP]), false, MM_FROM, B0)).toMatchObject({ capture: false, reason: `raw ingestion has not completed ${MM_FROM}..${B0} (the money market's logs)`, detail: { gaps: 1, first_gaps: [GAP] } })
    expect(await atokenAnchorDecision(port(12, []), true, MM_FROM, B0)).toEqual({ capture: true, mode: 'full' })
    expect(await atokenAnchorDecision(port(12, [GAP]), true, MM_FROM, B0)).toMatchObject({ capture: false })
    expect(await atokenAnchorDecision(port(0, [GAP]), true, MM_FROM, B0)).toMatchObject({ capture: false })
    // The gate is decided before the table is counted: a gap skips a top-up too.
    expect(await atokenAnchorDecision(port(12, [GAP]), false, MM_FROM, B0)).toMatchObject({ capture: false, reason: `raw ingestion has not completed ${MM_FROM}..${B0} (the money market's logs)` })
  })

  it('incentive: needs complete controller-log coverage; then a full capture on an empty table (or --force-incentive), a top-up otherwise', async () => {
    const port = (rows: number, gaps: typeof GAP[]) => ({ anchorRowCount: async () => rows, controllerLogGaps: async () => gaps })
    expect(await incentiveAnchorDecision(port(0, []), false, LOGS_FROM, B0)).toEqual({ capture: true, mode: 'full' })
    // A non-empty table is topped up, never left alone: a user no source named at
    // the first capture (its every pre-B0 log in a gap) is anchored once one does.
    expect(await incentiveAnchorDecision(port(5, []), false, LOGS_FROM, B0)).toEqual({ capture: true, mode: 'top-up' })
    expect(await incentiveAnchorDecision(port(0, [GAP]), false, LOGS_FROM, B0)).toMatchObject({ capture: false, reason: `raw ingestion has not completed ${LOGS_FROM}..${B0} (the controller's logs)`, detail: { gaps: 1, first_gaps: [GAP] } })
    expect(await incentiveAnchorDecision(port(5, []), true, LOGS_FROM, B0)).toEqual({ capture: true, mode: 'full' })
    expect(await incentiveAnchorDecision(port(5, [GAP]), true, LOGS_FROM, B0)).toMatchObject({ capture: false })
    // The gate is decided before the table is counted: a gap skips a top-up too.
    expect(await incentiveAnchorDecision(port(5, [GAP]), false, LOGS_FROM, B0)).toMatchObject({ capture: false, reason: `raw ingestion has not completed ${LOGS_FROM}..${B0} (the controller's logs)` })
  })
})

describe('runAnchorCycle', () => {
  it('on a fresh database captures the aToken anchor first, then the incentive anchor once its logs are in', async () => {
    const f = fakes()
    expect(await runAnchorCycle(f.ports, opts, f.log)).toEqual({ atoken: 'captured', incentive: 'captured', lmEntries: 'clean' })
    // The incentive candidates include the aToken anchor's holders: it runs second.
    expect(f.calls).toEqual(['atoken.map', 'atoken.gaps', 'atoken.count', 'atoken.capture:full', 'incentive.gaps', 'incentive.count', 'incentive.capture:full', 'lm.reconcile'])
  })

  it('in steady state refreshes the reserve map, tops both anchors up and runs the LM reconcile', async () => {
    const f = fakes({ atokenRows: 900, incentiveRows: 70 })
    expect(await runAnchorCycle(f.ports, opts, f.log)).toEqual({ atoken: 'topped-up', incentive: 'topped-up', lmEntries: 'clean' })
    expect(f.calls).toEqual(['atoken.map', 'atoken.gaps', 'atoken.count', 'atoken.capture:top-up', 'incentive.gaps', 'incentive.count', 'incentive.capture:top-up', 'lm.reconcile'])
    expect(f.logs.map(l => l.type)).toEqual(['lm_entries_reconcile'])
  })

  it('waits for the backfill before the incentive anchor, cycle after cycle, while the aToken anchor goes ahead', async () => {
    const f = fakes({ gaps: [GAP] })
    expect(await runAnchorCycle(f.ports, opts, f.log)).toEqual({ atoken: 'captured', incentive: 'skipped', lmEntries: 'clean' })
    expect(f.calls.filter(c => c.startsWith('incentive.capture'))).toEqual([])
    expect(f.logs[0]).toMatchObject({ type: 'mm_incentive_anchor_done', skipped: true, gaps: 1, first_gaps: [GAP] })
    // Gated while the table is non-empty too: a top-up on a partial backfill would read a partial candidate set.
    const partial = fakes({ incentiveRows: 70, gaps: [GAP] })
    expect((await runAnchorCycle(partial.ports, opts, partial.log)).incentive).toBe('skipped')
    expect(partial.calls.filter(c => c.startsWith('incentive.capture'))).toEqual([])
  })

  it('on a fresh database with a partial backfill captures neither anchor, and captures the aToken one once its range is in', async () => {
    const partial = fakes({ atokenGaps: [GAP], gaps: [GAP] })
    expect(await runAnchorCycle(partial.ports, opts, partial.log)).toEqual({ atoken: 'skipped', incentive: 'skipped', lmEntries: 'clean' })
    expect(partial.calls.filter(c => c.startsWith('atoken.capture'))).toEqual([])
    expect(partial.logs[0]).toMatchObject({ type: 'atoken_anchor_done', skipped_anchor: true, gaps: 1, first_gaps: [GAP] })
    // Still gated under --force: the table staying empty is what lets a later cycle capture.
    const forced = fakes({ atokenGaps: [GAP] })
    expect((await runAnchorCycle(forced.ports, { ...opts, forceAtoken: true }, forced.log)).atoken).toBe('skipped')
    const later = fakes()
    expect((await runAnchorCycle(later.ports, opts, later.log)).atoken).toBe('captured')
  })

  it('never lets one anchor failure skip the other', async () => {
    const mapDown = fakes({ atokenFails: 'map' })
    expect(await runAnchorCycle(mapDown.ports, opts, mapDown.log)).toEqual({ atoken: 'failed', incentive: 'captured', lmEntries: 'clean' })
    // The reserve map failing aborts the aToken capture (it would anchor nothing).
    expect(mapDown.calls.filter(c => c.startsWith('atoken.capture'))).toEqual([])
    expect(mapDown.logs[0]).toEqual({ type: 'atoken_anchor_error', reason: 'reserve map unreadable' })

    const incentiveDown = fakes({ incentiveFails: true })
    expect(await runAnchorCycle(incentiveDown.ports, opts, incentiveDown.log)).toEqual({ atoken: 'captured', incentive: 'failed', lmEntries: 'clean' })
    expect(incentiveDown.logs[0]).toEqual({ type: 'mm_incentive_anchor_error', reason: 'empty return' })

    const lmDown = fakes({ lm: 'throw', atokenFails: 'capture', incentiveFails: true })
    expect(await runAnchorCycle(lmDown.ports, opts, lmDown.log)).toEqual({ atoken: 'failed', incentive: 'failed', lmEntries: 'failed' })
    expect(lmDown.calls.at(-1)).toBe('lm.reconcile')
    expect(lmDown.logs.at(-1)).toEqual({ type: 'lm_entries_reconcile_error', reason: 'clickhouse down' })
  })

  it('logs the open warning set either side of the LM repair', async () => {
    const f = fakes({ atokenRows: 900, incentiveRows: 70, lm: { ...CLEAN, openBefore: 2, uncapturedBlocks: 1, blocks: 3, rows: 5, gone: 1, failed: [{ block: 42, reason: 'State already discarded' }], openAfter: 1 } })
    expect((await runAnchorCycle(f.ports, opts, f.log)).lmEntries).toBe('open')
    expect(f.logs.at(-1)).toEqual({
      type: 'lm_entries_reconcile', outcome: 'open', open_before: 2, uncaptured_blocks: 1, unparsed_deposit_ids: 0, first_unparsed: [], truncated: false,
      blocks: 3, rows: 5, gone: 1, failed_blocks: 1, first_failures: [{ block: 42, reason: 'State already discarded' }], open_after: 1,
    })
  })
})

describe('reconcileOutcome', () => {
  it('clean only when nothing was found; repaired only when every gap closed', () => {
    expect(reconcileOutcome(CLEAN)).toBe('clean')
    expect(reconcileOutcome({ ...CLEAN, openBefore: 1, blocks: 1, rows: 2, openAfter: 0 })).toBe('repaired')
    expect(reconcileOutcome({ ...CLEAN, uncapturedBlocks: 1, blocks: 1, rows: 2, openAfter: 0 })).toBe('repaired')
    expect(reconcileOutcome({ ...CLEAN, openBefore: 1, blocks: 1, failed: [{ block: 1, reason: 'x' }], openAfter: 1 })).toBe('open')
    expect(reconcileOutcome({ ...CLEAN, openBefore: 2_000, blocks: 2_000, truncated: true, openAfter: 0 })).toBe('open')
    // An entry event with no readable deposit id is a gap no re-read closes.
    expect(reconcileOutcome({ ...CLEAN, unparsedDepositIds: 1 })).toBe('open')
    expect(reconcileOutcome({ ...CLEAN, uncapturedBlocks: 1, blocks: 1, rows: 2, openAfter: 0, unparsedDepositIds: 1 })).toBe('open')
    // A dry run writes nothing, so it cannot claim a repair.
    expect(reconcileOutcome({ ...CLEAN, openBefore: 1, blocks: 1, rows: 2, openAfter: null })).toBe('open')
  })

  it('passes each force flag to its own anchor only', async () => {
    const f = fakes({ atokenRows: 900, incentiveRows: 70 })
    expect(await runAnchorCycle(f.ports, { ...opts, forceAtoken: true }, f.log)).toEqual({ atoken: 'captured', incentive: 'topped-up', lmEntries: 'clean' })
    expect(f.calls).toContain('atoken.capture:full')
    expect(f.calls).toContain('incentive.capture:top-up')
    const g = fakes({ atokenRows: 900, incentiveRows: 70 })
    expect(await runAnchorCycle(g.ports, { ...opts, forceIncentive: true }, g.log)).toEqual({ atoken: 'topped-up', incentive: 'captured', lmEntries: 'clean' })
    expect(g.calls).toContain('atoken.capture:top-up')
    expect(g.calls).toContain('incentive.capture:full')
  })
})

describe('the service wiring', () => {
  it('one loop process runs both anchors and the entry reconcile', () => {
    const atoken = readFileSync(new URL('../../src/scripts/snapshot-atoken-anchors.ts', import.meta.url), 'utf8')
    expect(atoken).toMatch(/try \{ await runLoopCycle\(\) \}/)
    expect(atoken).toContain('createIncentiveAnchorJob(')
    expect(atoken).toContain('reconcileLmEntries(createLmReconcileSource(client)')
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')
    expect(compose).toContain('"src/scripts/snapshot-atoken-anchors.ts", "--loop"')
  })
})
