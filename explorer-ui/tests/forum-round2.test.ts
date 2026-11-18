import { describe, expect, it } from 'vitest'
import { applyEdit, matchReason, suggestionsFrom, toggleWrap, type TextState } from '../src/markdown/editorCommands'
import { clearAccountDrafts, saveDraft, loadDraft, scopedDraftKey } from '../src/markdown/drafts'
import { actionGate, threadIsWritable } from '../src/forumSession'
import type { ForumMe } from '../src/governanceTypes'
import type { SearchResult } from '../src/types'

// Per-line emphasis, mention suggestions that say why they matched, drafts kept per
// account, and the per-action gate copy the forum shows before anyone clicks.

const at = (text: string, start: number, end: number): TextState => ({ text, start, end })
const whole = (text: string) => at(text, 0, text.length)
const run = (s: TextState, marker: string) => applyEdit(s.text, toggleWrap(s, marker, 'x')).text

describe('emphasis on a multi-line selection', () => {
  it('bolds each non-blank line on its own and leaves blank lines alone', () => {
    expect(run(whole('one\n\ntwo'), '**')).toBe('**one**\n\n**two**')
  })
  it('keeps list bullets, numbers and quote marks outside the markers', () => {
    expect(run(whole('- alpha\n2. beta\n> gamma'), '_')).toBe('- _alpha_\n2. _beta_\n> _gamma_')
  })
  it('unwraps when every line is already wrapped', () => {
    expect(run(whole('**one**\n\n**two**'), '**')).toBe('one\n\ntwo')
  })
  it('wraps all lines when only some are wrapped', () => {
    expect(run(whole('**one**\ntwo'), '**')).toBe('****one****\n**two**')
  })
  it('a single line with a trailing newline stays one span', () => {
    expect(run(whole('word\n'), '**')).toBe('**word**\n')
  })
})

describe('mention suggestions', () => {
  const hit = (over: Partial<SearchResult>): SearchResult => ({ type: 'address', value: `0x${'11'.repeat(32)}`, label: '15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV', ...over })
  it('say why each account matched', () => {
    expect(matchReason('15U8', hit({}))).toBe('address starts with this')
    expect(matchReason('ali', hit({ identity: { display: 'Alice', verified: true, email: '', web: '', twitter: '' } }))).toBe('verified identity matches')
    expect(matchReason('pig', hit({ emojiName: 'pig' }))).toBe('account emoji name matches')
  })
  it('name the account by its identity and emoji, with the address beside it', () => {
    const [s] = suggestionsFrom('@', [hit({ emoji: '🐷', identity: { display: 'Alice', verified: true, email: '', web: '', twitter: '' } })], 'ali')
    expect(s.primary).toBe('🐷 Alice ✓')
    expect(s.secondary).toMatch(/^15U8rq…oamXQV · verified identity matches$/)
    expect(s.token).toBe('@15U8rqSKTZuNz1doFgiaiCzeRTbEpxmHGAPQi1nRc6oamXQV')
  })
})

function memoryStore() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size },
    raw: m,
  }
}

describe('drafts per account', () => {
  it('keeps each account\'s drafts apart, and signed-out ones under anon', () => {
    const s = memoryStore()
    saveDraft(scopedDraftKey('comment:s9', '0xaa'), 'alice writes', s, 1)
    saveDraft(scopedDraftKey('comment:s9', '0xbb'), 'bob writes', s, 1)
    saveDraft(scopedDraftKey('comment:s9', null), 'anon writes', s, 1)
    expect(loadDraft(scopedDraftKey('comment:s9', '0xaa'), s, 2)?.text).toBe('alice writes')
    expect(loadDraft(scopedDraftKey('comment:s9', '0xbb'), s, 2)?.text).toBe('bob writes')
    expect(loadDraft(scopedDraftKey('comment:s9', undefined), s, 2)?.text).toBe('anon writes')
  })
  it('logout clears only that account\'s drafts (and old unscoped ones)', () => {
    const s = memoryStore()
    saveDraft(scopedDraftKey('a', '0xaa'), 'mine', s, 1)
    saveDraft(scopedDraftKey('b', '0xaa'), 'mine too', s, 1)
    saveDraft(scopedDraftKey('a', '0xbb'), 'theirs', s, 1)
    saveDraft('legacy', 'old unscoped', s, 1)
    clearAccountDrafts('0xaa', s)
    expect([...s.raw.keys()]).toEqual(['forum-draft:0xbb|a'])
  })
})

describe('per-action gates', () => {
  const me = (over: Partial<ForumMe>): ForumMe => ({
    account: { accountId: '0x', address: 'x' } as ForumMe['account'], canPost: false, canComment: true, gate: { reason: 'no-stake-post', detail: 'fallback' },
    mutedUntil: null, moderator: false, linksUnlimited: false, topics: [],
    limits: { titleChars: 160, postBodyChars: 50000, commentBodyChars: 10000, labelsPerPost: 3, mentionsPerItem: 10, reportNoteChars: 500, linksPerBody: 20, discussionsPerHour: 3, commentsPerMinute: 10 },
    upload: { usedBytes: 0, maxBytes: 1, maxFileBytes: 1 }, ready: true, ...over,
  })
  it('signed out, every action is a sign-in, never a failure', () => {
    expect(actionGate('comment', undefined, false)).toMatchObject({ ok: false, signIn: true })
  })
  it('names the balance and the next step when the api gives no reason', () => {
    const g = actionGate('post', me({ facts: { hdx: '5000000000000', identity: false, voted: false }, thresholds: { commentHdx: 1, postHdx: 100 } }), true)
    expect(g.ok).toBe(false)
    expect(g.reason).toMatch(/^Starting a discussion needs at least 100 HDX/)
    expect(g.reason).toMatch(/holds 5 HDX/)
    expect(g.reason).toMatch(/add HDX, set an identity, or vote/)
    expect(actionGate('comment', me({}), true).ok).toBe(true)
  })
  it('the api\'s own per-action reason wins', () => {
    const g = actionGate('upload', me({ actions: { upload: { ok: false, reason: 'Adding images needs 1 HDX — this account holds 0.4 HDX.' } } }), true)
    expect(g).toMatchObject({ ok: false, reason: 'Adding images needs 1 HDX — this account holds 0.4 HDX.' })
  })
})

describe('thread keys', () => {
  it('only canonical referendum keys are writable', () => {
    expect(threadIsWritable('opengov:450')).toBe(true)
    expect(threadIsWritable('opengov:0')).toBe(true)
    expect(threadIsWritable('opengov:0450')).toBe(false)
    expect(threadIsWritable('democracy:5')).toBe(false)
  })
})
