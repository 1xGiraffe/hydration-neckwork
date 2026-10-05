import { describe, expect, it } from 'vitest'
import { holderClassifier, rowHolderClass } from '../src/services/userRevenueHolders.ts'

const USER = '0x' + 'ab'.repeat(32)
const TREASURY = '0x6d6f646c' + '00'.repeat(28)            // a pallet (modl) account
const SOVEREIGN = '0x7369626c' + '00'.repeat(28)           // a sibling sovereign
const TAGGED_PROTOCOL = '0x' + 'cd'.repeat(32)              // a member of a protocol-holder tag
const ATOKEN = '0x45544800' + '11'.repeat(20) + '00'.repeat(8) // an MM contract, ETH-mapped
const SS_POOL = '0x' + 'ef'.repeat(32)                       // a stableswap pool account

const classifier = holderClassifier(new Set([TAGGED_PROTOCOL]), new Set([ATOKEN, SS_POOL]))

describe('User Revenue holder class of a directory row', () => {
  it('classes accounts as the fold does, with custodies unattributed', () => {
    expect(classifier.classOf(USER)).toBe('user')
    expect(classifier.classOf(TREASURY)).toBe('protocol')
    expect(classifier.classOf(TAGGED_PROTOCOL)).toBe('protocol')
    expect(classifier.classOf(SOVEREIGN)).toBe('unattributed')
    expect(classifier.classOf(ATOKEN)).toBe('unattributed')
    expect(classifier.classOf(SS_POOL.toUpperCase().replace('0X', '0x'))).toBe('unattributed')
  })
  it('a row is a user row as soon as one account is a user', () => {
    expect(rowHolderClass([TREASURY, USER], classifier)).toBe('user')
    expect(rowHolderClass([TREASURY, ATOKEN], classifier)).toBe('protocol')
    expect(rowHolderClass([ATOKEN, SS_POOL, SOVEREIGN], classifier)).toBe('unattributed')
    expect(rowHolderClass([], classifier)).toBeUndefined()
  })
})

describe('holder class order (custody first, foreign treasuries, bridges, the relay sovereign)', () => {
  const OMNIPOOL = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
  const PARENT = '0x506172656e740000000000000000000000000000000000000000000000000000'
  const MOONBEAM_TREASURY = '0x7369626cd4070000000000000000000000000000000000000000000000000000'
  const BRIDGE = '0x' + '77'.repeat(32)
  it('reads the Omnipool (a modl account) as a pool, a foreign treasury as a user, a bridge and an untagged Parent as unattributed', () => {
    const c = holderClassifier({ protocol: new Set(), user: new Set([MOONBEAM_TREASURY]), custody: new Set([BRIDGE]) }, new Set([OMNIPOOL]))
    expect(c.classOf(OMNIPOOL)).toBe('unattributed')
    expect(c.classOf(MOONBEAM_TREASURY)).toBe('user')
    expect(c.classOf(BRIDGE)).toBe('unattributed')
    expect(c.classOf(PARENT)).toBe('unattributed')
    const tagged = holderClassifier({ protocol: new Set(), user: new Set([PARENT]) }, new Set())
    expect(tagged.classOf(PARENT)).toBe('user')
  })
  it('names the cause an unattributed direct holder carries', async () => {
    const { unattributedHolderVia } = await import('../src/services/userRevenueStreams.ts')
    const sets = { protocol: new Set<string>(), custody: new Set([BRIDGE]) }
    expect(unattributedHolderVia('', sets)).toBe('owner-unknown')
    expect(unattributedHolderVia(BRIDGE, sets)).toBe('bridge-custody')
    expect(unattributedHolderVia(PARENT, sets)).toBe('sovereign')
  })
})
