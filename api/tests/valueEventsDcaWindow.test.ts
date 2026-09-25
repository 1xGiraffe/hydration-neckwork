import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dcaScheduleOfHookSwap } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const fn = (name: string) => {
  const at = explorerService.indexOf(`async function ${name}(`)
  expect(at, name).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf('\n}\n', at))
}

// The value chart's jump attribution collapses hook-context swap legs under the
// DCA schedule that executed them. Which schedule is asked of dca_events_by_account
// at exactly the candidate legs' blocks — a primary-key read bounded by the
// candidates (at most VALUE_JUMP_WINDOW_ROWS per window). The read used to cover
// the scoped accounts' executions across every jump window: the treasury pot's
// buyback schedules execute in 100k+ of its windows' blocks, past the client's
// result-row cap, so /tag/treasury/value-events answered 500 and the chart lost
// every marker.
describe('value-event jump windows resolve DCA executions at the candidate blocks', () => {
  const body = fn('getAccountValueEvents')

  it('reads DCA.TradeExecuted at the candidate blocks, never across the windows', () => {
    expect(body).toContain("WHERE event_name = 'DCA.TradeExecuted' AND who IN (${list}) AND block_height IN {blocks:Array(UInt32)}")
    expect(body).not.toContain("WHERE event_name = 'DCA.TradeExecuted' AND who IN (${list}) AND (${windowCondFor('block_height')})")
  })

  it('takes the candidates from the window rows — hook-context swap legs only — after they are read', () => {
    expect(body).toContain('.filter(r => r.extrinsic_index == null && SWAP_EVENTS.includes(r.event_name))')
    expect(body.indexOf('const windowRows = ')).toBeLessThan(body.indexOf('const dcaCandidateBlocks = '))
    expect(body).toContain('const dcaWindowRows = dcaCandidateBlocks.length ? await')
  })

  it('resolves each leg through dcaScheduleOfHookSwap', () => {
    expect(body).toContain('dcaScheduleOfHookSwap(dcaExecutionsByBlock.get(Number(r.block_height)), Number(r.event_index))')
    expect(body).toContain('const scheduleId = r.extrinsic_index == null ? dcaScheduleFor(r) : undefined')
  })
})

// An execution's swap legs precede its DCA.TradeExecuted in the block (block
// 15,027,912: Router.Executed at event 34, TradeExecuted at 35), and several of the
// scoped accounts' schedules can execute in one block.
describe('dcaScheduleOfHookSwap', () => {
  const execs = [{ eventIndex: 35, scheduleId: 37917 }, { eventIndex: 60, scheduleId: 40000 }]

  it('is undefined outside an execution block', () => {
    expect(dcaScheduleOfHookSwap(undefined, 34)).toBeUndefined()
    expect(dcaScheduleOfHookSwap([], 34)).toBeUndefined()
  })

  it('names the block\'s one schedule whichever side of its event the leg is', () => {
    expect(dcaScheduleOfHookSwap([execs[0]], 34)).toBe(37917)
    expect(dcaScheduleOfHookSwap([execs[0]], 36)).toBe(37917)
  })

  it('picks the nearest execution event after the leg when several schedules execute', () => {
    expect(dcaScheduleOfHookSwap(execs, 34)).toBe(37917)
    expect(dcaScheduleOfHookSwap(execs, 35)).toBe(37917)
    expect(dcaScheduleOfHookSwap(execs, 36)).toBe(40000)
    // The read's row order carries no meaning.
    expect(dcaScheduleOfHookSwap([...execs].reverse(), 34)).toBe(37917)
  })

  it('gives a leg past the last execution event to that execution', () => {
    expect(dcaScheduleOfHookSwap(execs, 61)).toBe(40000)
    expect(dcaScheduleOfHookSwap([...execs].reverse(), 61)).toBe(40000)
  })
})
