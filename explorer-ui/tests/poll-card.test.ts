import { describe, expect, it } from 'vitest'
import { readPoll } from '../src/components/gov/poll'

describe('readPoll', () => {
  it('reads an anonymous poll with counts, filling options nobody chose with 0', () => {
    const p = readPoll({ title: 'How many?', options: ['a', 'b', 'c'], expiresTime: 1677600315091, anonymous: true, votes: { a: 3, b: 5 } })
    expect(p).toEqual({ title: 'How many?', options: ['a', 'b', 'c'], expiresTime: 1677600315091, anonymous: true, votes: { a: 3, b: 5, c: 0 }, voters: null })
  })

  it('counts a public poll from its voter lists when no counts are stored', () => {
    const p = readPoll({ title: 'Buffer?', options: ['Yes', 'No'], expiresTime: 1, anonymous: false, voters: { Yes: ['0x' + '1'.repeat(64), 'legacy:bob'], No: [] } })
    expect(p?.votes).toEqual({ Yes: 2, No: 0 })
    expect(p?.voters?.Yes).toEqual(['0x' + '1'.repeat(64), 'legacy:bob'])
  })

  it('keeps a poll without results (counts unknown) and refuses what is not a poll', () => {
    expect(readPoll({ title: 't', options: ['x'], anonymous: false })?.votes).toBeNull()
    expect(readPoll(null)).toBeNull()
    expect(readPoll({ options: [] })).toBeNull()
    expect(readPoll({ options: [1, null] })).toBeNull()
    // An anonymous poll never lists voters, whatever the stored row holds.
    expect(readPoll({ options: ['x'], anonymous: true, voters: { x: ['0xab'] } })?.voters).toBeNull()
  })
})
