import { describe, expect, it } from 'vitest'
import { accountIdOfAddress, authorKey, evmAccountId, voterActor } from '../../src/governance/subsquare/authors.js'
import { parseAuthor, parseComment, parseItem, parsePage, subjectOf } from '../../src/governance/subsquare/parse.js'
import { postRow } from '../../src/governance/subsquare/rows.js'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbbbbbbbbbb', D = 'dddddddddddddddddddddddd'

// Alice's well-known dev key: public key, its Polkadot (prefix 0) and Hydration (63) SS58 forms.
const ALICE_HEX = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
const ALICE_DOT = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5'
const BOB_DOT = '14E5nqKAp3oAJcmzgZhUD2RcptBeUBScxKHgJKU4HPNcKVf3'

const discussion = (over: Record<string, unknown> = {}) => ({
  _id: '6adfc8b49191dae9e13689f1', postUid: '361', title: 'Test"><img src=x>',
  content: '<img src=x onerror="fetch(\'https://example.invalid/takeover\')">', contentHash: 'b046854b3015d1befc1967fff1c93039',
  contentType: 'markdown', createdAt: '2026-10-26T21:40:04.076Z', updatedAt: '2026-10-26T21:40:04.076Z',
  lastActivityAt: '2026-10-26T21:40:04.076Z', author: { username: 'legacy-user', emailMd5: 'c4d3fc5aef63ba948dbe037316d4cb5c' },
  commentsCount: 0, reactions: [], ...over,
})

describe('Subsquare parsers', () => {
  it('drops emailMd5 at the parser: no parsed author carries it', () => {
    const author = parseAuthor({ username: 'u', emailMd5: 'c4d3fc5aef63ba948dbe037316d4cb5c' })
    expect(author).toEqual({ username: 'u', publicKey: null, address: null })
    const item = parseItem('discussions', discussion())!
    expect(JSON.stringify(item)).not.toContain('c4d3fc5aef63ba948dbe037316d4cb5c')
    const row = postRow({ item, linked: [], removed: false, pollJson: '' })
    expect(JSON.stringify(row)).not.toContain('emailMd5')
    expect(JSON.stringify(row)).not.toContain('c4d3fc5aef63ba948dbe037316d4cb5c')
  })

  it('stores hostile title and body byte-identical (made safe only at render)', () => {
    const item = parseItem('discussions', discussion())!
    const row = postRow({ item, linked: [], removed: false, pollJson: '' })
    if ('skip' in row) throw new Error('skipped')
    expect(row.title).toBe('Test"><img src=x>')
    expect(row.body).toBe('<img src=x onerror="fetch(\'https://example.invalid/takeover\')">')
  })

  it('imports Subsquare hide as hidden/imported-hidden and isMalicious as hidden/spam', () => {
    const hide = postRow({ item: parseItem('discussions', discussion({ hide: true }))!, linked: [], removed: false, pollJson: '' })
    const spam = postRow({ item: parseItem('discussions', discussion({ isMalicious: true }))!, linked: [], removed: false, pollJson: '' })
    const gone = postRow({ item: parseItem('discussions', discussion())!, linked: [], removed: true, pollJson: '' })
    expect(hide).toMatchObject({ hidden: 1, hidden_reason: 'imported-hidden' })
    expect(spam).toMatchObject({ hidden: 1, hidden_reason: 'spam' })
    expect(gone).toMatchObject({ hidden: 1, hidden_reason: 'removed-on-subsquare', source_removed: 1 })
  })

  it('refuses unknown shapes instead of returning a partial item', () => {
    expect(parseItem('discussions', discussion({ content: 42 }))).toBeNull()
    expect(parseItem('discussions', discussion({ postUid: 'abc' }))).toBeNull()
    expect(parseItem('discussions', discussion({ createdAt: 'never' }))).toBeNull()
    expect(parseItem('discussions', discussion({ author: { username: 'x', publicKey: 'not-hex' } }))).toBeNull()
    expect(parsePage({ items: 'x', total: 1 })).toBeNull()
    expect(parseComment({ _id: 'c', content: 'x', createdAt: '2025-01-01T00:00:00Z' })).toBeNull() // no owner field
  })

  it('names every collection\'s subject by the spec\'s id scheme', () => {
    expect(subjectOf('opengov', { referendumIndex: 450 })).toBe('opengov:450')
    expect(subjectOf('democracy', { referendumIndex: 207 })).toBe('democracy:207')
    expect(subjectOf('democracy_proposal', { proposalIndex: 9 })).toBe('democracy_proposal:9')
    expect(subjectOf('treasury', { proposalIndex: 31, referendumIndex: 390 })).toBe('treasury:31')
    expect(subjectOf('spend', { index: 6 })).toBe('spend:6')
    expect(subjectOf('council', { motionIndex: 250 })).toBe('council:250')
    expect(subjectOf('tc', { motionIndex: 425 })).toBe('tc:425')
    const h = '0x' + 'AB'.repeat(32)
    expect(subjectOf('external', { externalProposalHash: h, indexer: { blockHeight: 6820789 } })).toBe(`external:${h.toLowerCase()}@6820789`)
    expect(subjectOf('tip', { hash: h, indexer: { blockHeight: 6327088 } })).toBe(`tip:${h.toLowerCase()}@6327088`)
    expect(subjectOf('discussions', { postUid: '248' })).toBe('s248')
  })

  it('parses comments with one level of replies and their owner field', () => {
    const c = parseComment({
      _id: A, motion: 'root1', replyToComment: null, content: 'hi', createdAt: '2025-01-01T00:00:00Z', author: null, reactions: [],
      replies: [{ _id: B, motion: 'root1', replyToComment: A, content: 'yo', createdAt: '2025-01-02T00:00:00Z', author: null, reactions: [], replies: [{ _id: D, motion: 'root1', content: '', createdAt: '2025-01-03T00:00:00Z', reactions: [] }] }],
    })!
    expect(c.ownerType).toBe('motion')
    expect(c.ownerId).toBe('root1')
    expect(c.replies.map(r => r.id)).toEqual([B])
    expect(c.replies[0].replies).toEqual([]) // two levels only
  })
})

describe('ids', () => {
  it('accepts only a 24-hex document id (`u<x>` would make a comment collide with an Update)', () => {
    const c = (id: unknown) => parseComment({ _id: id, motion: 'root1', content: 'x', createdAt: '2025-01-01T00:00:00Z', reactions: [] })
    expect(c(A)).not.toBeNull()
    for (const bad of ['u' + 'a'.repeat(23), 'A'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), 7, null]) expect(c(bad)).toBeNull()
  })
})

describe('author mapping', () => {
  it('maps a 32-byte publicKey to the AccountId32 key and cross-checks the address', () => {
    expect(authorKey({ username: 'a', publicKey: ALICE_HEX, address: ALICE_DOT })).toEqual({ ok: true, accountId: '0x' + ALICE_HEX, legacyName: '' })
    expect(authorKey({ username: 'a', publicKey: ALICE_HEX, address: BOB_DOT })).toEqual({ ok: false, reason: 'address-mismatch' })
  })

  it('maps an EVM key or 0x address to the runtime\'s truncated form', () => {
    const h160 = '1234567890abcdef1234567890abcdef12345678'
    const want = '0x45544800' + h160 + '0000000000000000'
    expect(evmAccountId(h160)).toBe(want)
    expect(authorKey({ username: 'e', publicKey: h160, address: '0x' + h160.toUpperCase() })).toEqual({ ok: true, accountId: want, legacyName: '' })
    expect(accountIdOfAddress('0x' + h160)).toBe(want)
    // A pallet account's H160 (modl…) is its real account, zero-padded.
    expect(evmAccountId('6d6f646c' + '00'.repeat(16))).toBe('0x6d6f646c' + '00'.repeat(16) + '000000000000000000000000')
  })

  it('keeps an address-less (email-only) author as a legacy name only', () => {
    expect(authorKey({ username: 'tanishah', publicKey: null, address: null })).toEqual({ ok: true, accountId: '', legacyName: 'tanishah' })
    expect(voterActor({ username: 'tanishah', publicKey: null, address: null })).toBe('legacy:tanishah')
  })

  it('resolves a SIMA item\'s signer from its proposer address', () => {
    expect(authorKey(null, ALICE_DOT)).toEqual({ ok: true, accountId: '0x' + ALICE_HEX, legacyName: '' })
    expect(authorKey(null, 'garbage')).toEqual({ ok: false, reason: 'unresolvable' })
  })
})
