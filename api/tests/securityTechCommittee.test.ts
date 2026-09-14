import { describe, it, expect } from 'vitest'
import { newestEnactedRoster } from '../src/services/securityService.ts'

// pallet_collective emits no membership event, so the technical committee's
// roster is only recorded in a referendum preimage. `referendum_proposals` holds
// every hash a `Referenda.Submitted` named, whatever became of it, and
// submitting a referendum is PERMISSIONLESS — so "newest set_members preimage"
// is "newest roster anybody proposed", not the live committee. The Security
// dashboard derives size, majority and super-majority from it.
const roster = (...members: string[]) => JSON.stringify({ newMembers: members, prime: null, oldCount: members.length })

const A = '0x' + 'aa'.repeat(32)
const B = '0x' + 'bb'.repeat(32)
const C = '0x' + 'cc'.repeat(32)

describe('newestEnactedRoster', () => {
  const enacted = { proposal_hash: '0x01', block_height: 100, args_json: roster(A, B) }
  const proposed = { proposal_hash: '0x02', block_height: 200, args_json: roster(C) }

  it('takes the newest roster whose referendum was CONFIRMED, not the newest noted', () => {
    const out = newestEnactedRoster(
      [enacted, proposed],
      [{ proposal_hash: '0x01', ref_index: 10 }, { proposal_hash: '0x02', ref_index: 11 }],
      [{ ref_index: 10, block_height: 150 }],
    )
    expect(out?.args_json).toBe(enacted.args_json)
  })

  it('carries NO roster rather than a proposed one when nothing resolves', () => {
    // Explicit incompleteness: a dashboard that publishes an unenacted roster as
    // the live committee is worse than one that publishes none.
    expect(newestEnactedRoster([proposed], [{ proposal_hash: '0x02', ref_index: 11 }], [])).toBeNull()
    expect(newestEnactedRoster([proposed], [], [{ ref_index: 11, block_height: 250 }])).toBeNull()
    expect(newestEnactedRoster([], [], [])).toBeNull()
  })

  it('orders by ENACTMENT, not by the block the preimage was noted at', () => {
    // A preimage can be noted long before its referendum confirms, and two
    // referenda can confirm out of noting order; the roster in force is the one
    // enacted last.
    const older = { proposal_hash: '0x01', block_height: 900, args_json: roster(A) }
    const newer = { proposal_hash: '0x02', block_height: 100, args_json: roster(B, C) }
    const out = newestEnactedRoster(
      [older, newer],
      [{ proposal_hash: '0x01', ref_index: 1 }, { proposal_hash: '0x02', ref_index: 2 }],
      [{ ref_index: 1, block_height: 1_000 }, { ref_index: 2, block_height: 2_000 }],
    )
    expect(out?.args_json).toBe(newer.args_json)
  })

  it('ignores a confirmation belonging to a referendum that named another hash', () => {
    expect(newestEnactedRoster(
      [proposed],
      [{ proposal_hash: '0xff', ref_index: 11 }],
      [{ ref_index: 11, block_height: 250 }],
    )).toBeNull()
  })
})
