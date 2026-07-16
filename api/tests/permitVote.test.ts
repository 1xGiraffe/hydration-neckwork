import { describe, expect, it } from 'vitest'
import { voteFromPermitData, nestedVoteInfos } from '../src/services/explorerService.ts'

// Real Hydration dispatch_permit payloads (gasless EVM votes); expected values
// cross-checked against the ConvictionVoting.Voted events the extrinsics emitted.
describe('voteFromPermitData', () => {
  it('decodes an Aye Locked4x standard vote', () => {
    expect(voteFromPermitData('0x2400a50500844f677d0a95ef14070000000000000000')).toEqual({
      ref: '361',
      details: { amount: '510296081204864847', side: 'Aye', conviction: 'Locked4x' },
    })
  })

  it('decodes an Aye Locked2x standard vote', () => {
    expect(voteFromPermitData('0x2400a5050082b458186e322dd0040000000000000000')).toEqual({
      ref: '361',
      details: { amount: '346826865926232244', side: 'Aye', conviction: 'Locked2x' },
    })
  })

  it('rejects payloads that are not ConvictionVoting.vote', () => {
    // EVM.call-style payload (different pallet/call indexes)
    expect(voteFromPermitData('0x0f00a5050084ffffffffffffffff0000000000000000')).toBeNull()
    expect(voteFromPermitData('0x2400')).toBeNull()
    expect(voteFromPermitData(42)).toBeNull()
    expect(voteFromPermitData(undefined)).toBeNull()
  })
})

describe('nestedVoteInfos', () => {
  it('extracts a vote wrapped in Proxy.proxy', () => {
    const args = JSON.parse('{"real":"0x41ddf2ded434f3b236eca63124ea45b9034a03249dec7b072c2b4efa8efa3eae","call":{"__kind":"ConvictionVoting","value":{"pollIndex":360,"vote":{"vote":134,"balance":"24805000000000000000","__kind":"Standard"},"__kind":"vote"}}}')
    expect(nestedVoteInfos(args)).toEqual([
      { ref: '360', details: { amount: '24805000000000000000', side: 'Aye', conviction: 'Locked6x' } },
    ])
  })

  it('extracts every vote from a batch of calls', () => {
    const vote = (pollIndex: number) => ({ __kind: 'ConvictionVoting', value: { __kind: 'vote', pollIndex, vote: { __kind: 'Standard', vote: 129, balance: '10' } } })
    const args = { calls: [vote(1), { __kind: 'System', value: { __kind: 'remark' } }, vote(2)] }
    expect(nestedVoteInfos(args).map(i => i.ref)).toEqual(['1', '2'])
  })

  it('returns nothing for non-vote wrappers', () => {
    expect(nestedVoteInfos({ real: '0xabc', call: { __kind: 'Router', value: { __kind: 'sell' } } })).toEqual([])
  })
})
