import { describe, it, expect } from 'vitest'
import { buildDemocracyEvents, type DemocracyEventRow } from '../src/services/securityService.ts'

const row = (block_height: number, event_name: string, args: unknown, extrinsic_index: number | null = null, event_index = 0): DemocracyEventRow =>
  ({ block_height, block_timestamp: '2026-10-17 10:00:00', event_index, extrinsic_index, event_name, args_json: JSON.stringify(args) })

describe('buildDemocracyEvents', () => {
  // Real rows: public proposal #9 (Oct 2026) tabled into referendum #207.
  it('words each old-governance step from the event alone', () => {
    const events = buildDemocracyEvents([
      row(15940150, 'Democracy.Proposed', { proposalIndex: 9, deposit: '100000000000000000' }, 2, 7),
      row(15940800, 'Democracy.Tabled', { proposalIndex: 9, deposit: '100000000000000000' }, null, 1),
      row(15940800, 'Democracy.Started', { refIndex: 207, threshold: { __kind: 'SuperMajorityApprove' } }, null, 2),
      row(7452000, 'Democracy.NotPassed', { refIndex: 33 }),
      row(2797200, 'Democracy.Executed', { refIndex: 48, result: { __kind: 'Err' } }),
    ])
    expect(events.map(e => [e.kind, e.label, e.detail, e.extrinsicIndex])).toEqual([
      ['democracy', 'Democracy proposal made', 'proposal #9 · 100k HDX deposit', 2],
      ['democracy', 'Democracy proposal tabled', 'proposal #9 goes to a public referendum', null],
      ['democracy', 'Democracy referendum started', 'referendum #207 · passes on a super-majority to approve', null],
      ['democracy', 'Democracy referendum failed', 'referendum #33', null],
      ['democracy', 'Democracy referendum enacted', 'referendum #48 · call failed', null],
    ])
  })

  // Same block, no extrinsic, no asset: only the label tells Tabled and Started
  // apart in the safety identity, so they must differ.
  it('gives same-block steps distinct labels', () => {
    const [a, b] = buildDemocracyEvents([
      row(15940800, 'Democracy.Tabled', { proposalIndex: 9 }),
      row(15940800, 'Democracy.Started', { refIndex: 207, threshold: { __kind: 'SimpleMajority' } }),
    ])
    expect(a.label).not.toBe(b.label)
  })

  it('skips events it does not word', () => {
    expect(buildDemocracyEvents([row(1, 'Democracy.Voted', {})])).toEqual([])
  })
})
