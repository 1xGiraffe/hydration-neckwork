import { describe, expect, it } from 'vitest'
import { nestedRemovalRefs, nestedVoteInfos, removalRefsFromPermitData, voteFromPermitData } from '../src/services/explorerService.ts'

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

// A removal names its poll only on the CALL — ConvictionVoting.VoteRemoved carries the
// account and the vote it dropped, but no index — so a wrapped removal is invisible
// unless the wrapper is decoded. Real Hydration payloads; every expected index is the
// one whose referendum the extrinsic's VoteRemoved event belongs to.
describe('removalRefsFromPermitData', () => {
  it('decodes a bare remove_vote', () => {
    // pallet 0x24, call 0x04, Some(class 1), poll 364 as a plain u32 — NOT compact, which
    // is how remove_vote differs from vote.
    expect(removalRefsFromPermitData('0x24040101006c010000')).toEqual(['364'])
  })

  it('decodes every removal in a batch', () => {
    expect(removalRefsFromPermitData('0x0d021824040100002c00000024040105002d00000024040105001c00000024040105001e0000002404010000240000004504e9140000000000000000000000000000'))
      .toEqual(['44', '45', '28', '30', '36'])
  })

  it('reads a removal whose class is None', () => {
    expect(removalRefsFromPermitData('0x0d0208240400' + '2c000000' + '4504371b0000')).toEqual(['44'])
  })

  // The app appends an unrelated Staking call to these batches. Without runtime metadata
  // there is no way to know how long that call is, so the walk STOPS there rather than
  // guessing an offset and inventing poll indexes from unrelated bytes. Verified against
  // every wrapped removal on the chain: a byte-pattern scan of all 23 permit payloads
  // finds no removal the walk misses, because the Staking call is always last.
  it('stops at the first call that is not a removal', () => {
    expect(removalRefsFromPermitData('0x0d020824040104004a0000004504371b0000000000000000000000000000')).toEqual(['74'])
  })

  it('rejects payloads that are not removals', () => {
    // A ConvictionVoting.vote payload: same pallet, call 0x00.
    expect(removalRefsFromPermitData('0x2400a50500844f677d0a95ef14070000000000000000')).toEqual([])
    expect(removalRefsFromPermitData('0x2404')).toEqual([])
    expect(removalRefsFromPermitData('0x')).toEqual([])
    expect(removalRefsFromPermitData(42)).toEqual([])
    expect(removalRefsFromPermitData(undefined)).toEqual([])
  })
})

describe('nestedRemovalRefs', () => {
  // The extrinsic that withdrew the abstain vote on OpenGov 200 at block 9683538, whose
  // missing removal left that referendum's attributed support 100 HDX above the chain's.
  it('extracts a removal wrapped in Utility.batch_all', () => {
    const args = JSON.parse('{"calls":[{"__kind":"ConvictionVoting","value":{"class":5,"index":200,"__kind":"remove_vote"}},{"__kind":"Staking","value":{"positionId":"7689","__kind":"unstake"}}]}')

    expect(nestedRemovalRefs(args)).toEqual(['200'])
  })

  // remove_other_vote and force_remove_vote drop someone else's vote; the account comes
  // off the VoteRemoved event either way, so only the poll matters here.
  it('extracts every removal call kind', () => {
    const removal = (kind: string, index: number) => ({ __kind: 'ConvictionVoting', value: { __kind: kind, index } })
    const args = { calls: [removal('remove_vote', 1), removal('remove_other_vote', 2), removal('force_remove_vote', 3)] }

    expect(nestedRemovalRefs(args)).toEqual(['1', '2', '3'])
  })

  it('ignores votes and unrelated calls', () => {
    const args = {
      calls: [
        { __kind: 'ConvictionVoting', value: { __kind: 'vote', pollIndex: 7, vote: { __kind: 'Standard', vote: 129, balance: '10' } } },
        { __kind: 'Staking', value: { __kind: 'unstake', positionId: '1' } },
      ],
    }

    expect(nestedRemovalRefs(args)).toEqual([])
  })
})
