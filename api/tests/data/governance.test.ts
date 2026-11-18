import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { encodeAddress } from '@polkadot/util-crypto'
import { setForumSnapshotForTest, type ForumPostMeta } from '../../src/services/forumStore.ts'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for /v1/governance/*: the referendum lifecycle fold (statuses,
// tally, track/hash extraction, deposit events ignored), the decoded proposal,
// and the two raw vote-call feeds with the Standard-vote byte decode.

type Row = Record<string, unknown>

const VOTER = `0x${'33'.repeat(32)}`
const VOTER_SS58 = encodeAddress(VOTER, 0)
const PROPOSAL_HASH = `0x${'ee'.repeat(32)}`

// One confirmed opengov referendum (with a deposit refund AFTER Confirmed —
// the fold must not let it un-decide the status) and one passed democracy one.
const LIFECYCLE_ROWS: Row[] = [
  { pallet: 'opengov', ref_index: 381, event_name: 'Referenda.Submitted', block_height: 1000, event_index: 1, ts: '2026-08-01 00:00:00', args_json: JSON.stringify({ index: 381, track: 5, proposal: { hash: PROPOSAL_HASH, len: 115, __kind: 'Lookup' } }), ingested_at: '2026-08-01 00:00:05' },
  { pallet: 'opengov', ref_index: 381, event_name: 'Referenda.DecisionDepositPlaced', block_height: 1001, event_index: 1, ts: '2026-08-01 00:01:00', args_json: JSON.stringify({ index: 381, who: VOTER, amount: '750' }), ingested_at: '2026-08-01 00:01:05' },
  { pallet: 'opengov', ref_index: 381, event_name: 'Referenda.DecisionStarted', block_height: 1100, event_index: 1, ts: '2026-08-02 00:00:00', args_json: JSON.stringify({ index: 381, track: 5, proposal: { hash: PROPOSAL_HASH, __kind: 'Lookup' }, tally: { ayes: '100', nays: '5', support: '50' } }), ingested_at: '2026-08-02 00:00:05' },
  { pallet: 'opengov', ref_index: 381, event_name: 'Referenda.ConfirmStarted', block_height: 1200, event_index: 1, ts: '2026-08-03 00:00:00', args_json: JSON.stringify({ index: 381 }), ingested_at: '2026-08-03 00:00:05' },
  { pallet: 'opengov', ref_index: 381, event_name: 'Referenda.Confirmed', block_height: 1300, event_index: 1, ts: '2026-08-04 00:00:00', args_json: JSON.stringify({ index: 381, tally: { ayes: '3430', nays: '69', support: '737' } }), ingested_at: '2026-08-04 00:00:05' },
  { pallet: 'opengov', ref_index: 381, event_name: 'Referenda.DecisionDepositRefunded', block_height: 1400, event_index: 1, ts: '2026-08-05 00:00:00', args_json: JSON.stringify({ index: 381, who: VOTER, amount: '750' }), ingested_at: '2026-08-05 00:00:05' },
  { pallet: 'democracy', ref_index: 200, event_name: 'Democracy.Started', block_height: 500, event_index: 1, ts: '2026-01-01 00:00:00', args_json: JSON.stringify({ refIndex: 200, threshold: { __kind: 'SimpleMajority' } }), ingested_at: '2026-01-01 00:00:05' },
  { pallet: 'democracy', ref_index: 200, event_name: 'Democracy.Passed', block_height: 600, event_index: 1, ts: '2026-01-02 00:00:00', args_json: JSON.stringify({ refIndex: 200 }), ingested_at: '2026-01-02 00:00:05' },
]

// Referendum titles are the forum descriptions' (the process's forum snapshot).
const forumPost = (postId: string, kind: string, title: string, extra: Partial<ForumPostMeta> = {}): ForumPostMeta => ({
  postId, kind, title, excerpt: '', bodyFormat: 'markdown', bodyLength: 0, tldr: '', labels: [], linked: [], authorAccountId: '', authorLegacyName: '',
  authority: 'subsquare', source: 'subsquare', sourceId: 'x', sourceCid: '', sourceRemoved: false, bannerCid: '', pollJson: '', revision: 0,
  hidden: false, hiddenReason: '', deleted: false, locked: false, moderated: false, createdAt: 1, editedAt: null, lastActivityAt: 1, updatedAt: 0, ...extra,
})

function installForum(extra: Partial<ForumPostMeta> = {}): void {
  setForumSnapshotForTest({
    posts: new Map([
      ['opengov:381', forumPost('opengov:381', 'opengov', 'GIGAHDX voting rewards', extra)],
      // A description with an empty title (a placeholder): no title on the wire.
      ['democracy:200', forumPost('democracy:200', 'democracy', '')],
    ]),
  })
}

const VOTE_ROWS: Row[] = [
  // A Standard aye at 6x: byte 134 = 128 | 6.
  { who: VOTER, pallet: 'opengov', ref_index: 381, call_name: 'ConvictionVoting.vote', vote_kind: 'Standard', vote_byte: 134, balance: '5000', aye: '', nay: '', abstain: '', success: 1, block_height: 1150, extrinsic_index: 2, call_address: 'root', ts: '2026-08-02 12:00:00', ingested_at: '2026-08-02 12:00:05' },
  // A later removal of that vote.
  { who: VOTER, pallet: 'opengov', ref_index: 381, call_name: 'ConvictionVoting.remove_vote', vote_kind: '', vote_byte: 0, balance: '', aye: '', nay: '', abstain: '', success: 1, block_height: 1250, extrinsic_index: 1, call_address: 'root', ts: '2026-08-03 12:00:00', ingested_at: '2026-08-03 12:00:05' },
  // A SplitAbstain from another account.
  { who: `0x${'44'.repeat(32)}`, pallet: 'opengov', ref_index: 381, call_name: 'ConvictionVoting.vote', vote_kind: 'SplitAbstain', vote_byte: 0, balance: '', aye: '10', nay: '2', abstain: '30', success: 1, block_height: 1160, extrinsic_index: 3, call_address: 'root', ts: '2026-08-02 13:00:00', ingested_at: '2026-08-02 13:00:05' },
]

function govClient(overrides: { lifecycle?: Row[]; votes?: Row[]; voterVotes?: Row[]; proposal?: Row[] } = {}) {
  return fakeDataClient(
    (query, params) => {
      if (query.includes('-- data:governance:referendum')) {
        return (overrides.lifecycle ?? LIFECYCLE_ROWS).filter(row => row.pallet === params.pallet && Number(row.ref_index) === Number(params.refIndex))
      }
      return undefined
    },
    query => (query.includes('-- data:governance:referenda') ? (overrides.lifecycle ?? LIFECYCLE_ROWS) : undefined),
    (query, params) => (query.includes('-- data:forum:post-body')
      ? (params.id === 'opengov:381' ? [{ shown_body: 'Pay voters', hidden: 0, deleted: 0 }] : [{ shown_body: '', hidden: 0, deleted: 0 }])
      : undefined),
    (query, params) => (query.includes('-- data:governance:proposal')
      ? (overrides.proposal ?? [{ pallet: 'Utility', call_name: 'force_batch', args_json: '{"calls":[]}', byte_length: 115, decode_error: '' }]).filter(() => params.hash === PROPOSAL_HASH)
      : undefined),
    (query, params) => (query.includes('-- data:governance:votes:by-ref')
      ? (overrides.votes ?? VOTE_ROWS).filter(row => row.pallet === params.pallet && Number(row.ref_index) === Number(params.refIndex))
      : undefined),
    (query, params) => (query.includes('-- data:governance:votes:by-voter')
      ? (overrides.voterVotes ?? VOTE_ROWS.filter(row => row.who === VOTER)).filter(() => params.voter === VOTER).map(row => ({ ...row, voter: row.who }))
      : undefined),
  )
}

let app: FastifyInstance | undefined

// Titles and the detail's description answer from the forum snapshot (the forum
// routes have their own tests, forum.test.ts).
beforeEach(() => installForum())

afterEach(async () => {
  await app?.close()
  app = undefined
  setForumSnapshotForTest(null)
})

describe('GET /v1/governance/referenda', () => {
  it('folds lifecycle events into status/tally/track and ignores deposit bookkeeping', async () => {
    app = await freshDataApp(govClient())
    const res = await app.inject({ url: '/v1/governance/referenda', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { items, hasMore } = res.json()
    expect(hasMore).toBe(false)
    expect(items).toHaveLength(2)
    // Newest submission first.
    expect(items[0]).toEqual({
      pallet: 'opengov', refIndex: 381, title: 'GIGAHDX voting rewards',
      // The deposit refund at block 1400 must not override Confirmed.
      status: 'confirmed', track: 5, proposalHash: PROPOSAL_HASH,
      tally: { ayes: '3430', nays: '69', support: '737' },
      submittedAt: '2026-08-01T00:00:00.000Z', submittedAtBlock: 1000, decidedAt: '2026-08-04T00:00:00.000Z',
    })
    expect(items[1]).toMatchObject({
      pallet: 'democracy', refIndex: 200, title: null, status: 'passed',
      track: null, proposalHash: null, tally: null, submittedAtBlock: 500,
    })
  })

  it('filters by pallet and status, and pages by (pallet, refIndex) cursor', async () => {
    app = await freshDataApp(govClient())
    const opengov = await app.inject({ url: '/v1/governance/referenda?pallet=opengov', headers: AUTH })
    expect(opengov.json().items.map((r: { refIndex: number }) => r.refIndex)).toEqual([381])
    const passed = await app.inject({ url: '/v1/governance/referenda?status=passed', headers: AUTH })
    expect(passed.json().items.map((r: { refIndex: number }) => r.refIndex)).toEqual([200])

    const first = await app.inject({ url: '/v1/governance/referenda?limit=1', headers: AUTH })
    expect(first.json().hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/governance/referenda?limit=1&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((r: { refIndex: number }) => r.refIndex)).toEqual([200])
    expect(second.json().hasMore).toBe(false)
  })

  it('rejects a garbage cursor', async () => {
    app = await freshDataApp(govClient())
    expect((await app.inject({ url: '/v1/governance/referenda?cursor=@@@', headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/governance/referenda/:pallet/:index', () => {
  it('returns the fold plus lifecycle history and the decoded proposal', async () => {
    app = await freshDataApp(govClient())
    const res = await app.inject({ url: '/v1/governance/referenda/opengov/381', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ pallet: 'opengov', refIndex: 381, status: 'confirmed' })
    expect(body.events).toHaveLength(6)
    expect(body.events[0]).toMatchObject({ eventName: 'Referenda.Submitted', blockHeight: 1000, args: { index: 381, track: 5 } })
    expect(body.proposal).toEqual({ pallet: 'Utility', callName: 'force_batch', args: { calls: [] }, byteLength: 115, decodeError: null })
    expect(body.title).toBe('GIGAHDX voting rewards')
    expect(body.descriptionStatus).toBe('ok')
    expect(body.description).toMatchObject({ postId: 'opengov:381', title: 'GIGAHDX voting rewards', body: 'Pay voters' })
  })

  it('drops a hidden description\'s title from the list and the detail as soon as the snapshot holds the hide', async () => {
    app = await freshDataApp(govClient())
    expect((await app.inject({ url: '/v1/governance/referenda', headers: AUTH })).json().items[0].title).toBe('GIGAHDX voting rewards')
    // The moderator's hide lands in the snapshot; the cached fold is not rebuilt.
    installForum({ hidden: true, hiddenReason: 'spam' })
    const list = await app.inject({ url: '/v1/governance/referenda', headers: AUTH })
    expect(list.json().items[0].title).toBeNull()
    const detail = (await app.inject({ url: '/v1/governance/referenda/opengov/381', headers: AUTH })).json()
    expect(detail.title).toBeNull()
    expect(detail.descriptionStatus).toBe('hidden')
    expect(detail.description).toMatchObject({ hidden: true, hiddenReason: 'spam', title: null, body: null })
  })

  it('serves the referendum whole when the forum snapshot is not loaded, saying so', async () => {
    setForumSnapshotForTest(null)
    app = await freshDataApp(govClient())
    const res = await app.inject({ url: '/v1/governance/referenda/opengov/381', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'confirmed', title: null, description: null, descriptionStatus: 'unavailable' })
    expect(res.json().events).toHaveLength(6)
  })

  it('reports none for a referendum the forum holds no record of', async () => {
    setForumSnapshotForTest({})
    app = await freshDataApp(govClient())
    const body = (await app.inject({ url: '/v1/governance/referenda/opengov/381', headers: AUTH })).json()
    expect(body).toMatchObject({ description: null, descriptionStatus: 'none' })
  })

  it('404s an unknown referendum with the enumeration hint', async () => {
    app = await freshDataApp(govClient())
    const res = await app.inject({ url: '/v1/governance/referenda/opengov/9999', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.context.hint).toMatch(/\/v1\/governance\/referenda/)
  })

  it('rejects an unknown pallet segment', async () => {
    app = await freshDataApp(govClient())
    expect((await app.inject({ url: '/v1/governance/referenda/treasury/1', headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/governance/referenda/:pallet/:index/votes', () => {
  it('decodes Standard vote bytes and keeps removals as raw history, newest first', async () => {
    app = await freshDataApp(govClient())
    const res = await app.inject({ url: '/v1/governance/referenda/opengov/381/votes', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { items } = res.json()
    expect(items.map((v: { callName: string }) => v.callName)).toEqual([
      'ConvictionVoting.remove_vote', 'ConvictionVoting.vote', 'ConvictionVoting.vote',
    ])
    expect(items[1]).toMatchObject({
      voter: { address: encodeAddress(`0x${'44'.repeat(32)}`, 0) },
      voteKind: 'SplitAbstain', aye: null, conviction: null,
      ayeAmount: '10', nayAmount: '2', abstainAmount: '30',
    })
    expect(items[2]).toMatchObject({
      voter: { address: VOTER_SS58, accountIdHex: VOTER, evmAddress: null },
      voteKind: 'Standard', voteByte: 134, aye: true, conviction: 6, balance: '5000',
      blockHeight: 1150, success: true,
    })
    // The removal is not a vote: no kind, no decode.
    expect(items[0]).toMatchObject({ voteKind: null, aye: null, conviction: null, balance: null })
  })

  it('pages by cursor without overlap', async () => {
    app = await freshDataApp(govClient())
    const first = await app.inject({ url: '/v1/governance/referenda/opengov/381/votes?limit=2', headers: AUTH })
    expect(first.json().hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/governance/referenda/opengov/381/votes?limit=2&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((v: { blockHeight: number }) => v.blockHeight)).toEqual([1150])
    expect(second.json().hasMore).toBe(false)
  })

  it('replays oldest first with order=asc and continues from its cursor', async () => {
    app = await freshDataApp(govClient())
    const first = await app.inject({ url: '/v1/governance/referenda/opengov/381/votes?order=asc&limit=2', headers: AUTH })
    expect(first.json().items.map((v: { blockHeight: number }) => v.blockHeight)).toEqual([1150, 1160])
    const second = await app.inject({ url: `/v1/governance/referenda/opengov/381/votes?order=asc&limit=2&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((v: { blockHeight: number }) => v.blockHeight)).toEqual([1250])
    expect(second.json().hasMore).toBe(false)
  })

  it('separates an unknown referendum (404) from a voteless one (200 empty)', async () => {
    app = await freshDataApp(govClient({ votes: [] }))
    const known = await app.inject({ url: '/v1/governance/referenda/democracy/200/votes', headers: AUTH })
    expect(known.statusCode).toBe(200)
    expect(known.json().items).toEqual([])
    const unknown = await app.inject({ url: '/v1/governance/referenda/democracy/9998/votes', headers: AUTH })
    expect(unknown.statusCode).toBe(404)
  })
})

describe('GET /v1/governance/votes', () => {
  it('requires a parseable voter and reads the voter-first projection with the canonical id', async () => {
    const client = govClient()
    app = await freshDataApp(client)
    // SS58 input resolves to the same hex identity the projection stores.
    const res = await app.inject({ url: `/v1/governance/votes?voter=${VOTER_SS58}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(2)
    expect(res.json().items[0]).toMatchObject({ callName: 'ConvictionVoting.remove_vote', refIndex: 381, pallet: 'opengov' })
    const read = client.seen.find(s => s.query.includes('-- data:governance:votes:by-voter'))!
    expect(read.params.voter).toBe(VOTER)

    const bad = await app.inject({ url: '/v1/governance/votes?voter=nonsense', headers: AUTH })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.message).toMatch(/SS58/)
  })

  it('answers an account that never voted with empty items, not 404', async () => {
    app = await freshDataApp(govClient())
    // A DIFFERENT voter: the per-voter read is cached process-wide, so reusing
    // VOTER here would replay the previous test's non-empty history.
    const quietVoter = encodeAddress(`0x${'55'.repeat(32)}`, 0)
    const res = await app.inject({ url: `/v1/governance/votes?voter=${quietVoter}&limit=99`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], hasMore: false })
  })
})

describe('GET /v1/governance/treasury/spends', () => {
  const BEN = `0x${'ab'.repeat(32)}`
  const ev = (event_name: string, block_height: number, args: Row): Row => ({ event_name, block_height, event_index: 1, extrinsic_index: null, ts: '2026-08-01 00:00:00', args_json: JSON.stringify(args) })
  const spendsClient = () => fakeDataClient(query => (query.includes('-- data:governance:treasury-spends') ? [
    ev('Treasury.AssetSpendApproved', 100, { index: 0, amount: '763636000000000000', beneficiary: BEN, validFrom: 100, expireAt: 1000 }),
    ev('Treasury.Paid', 200, { index: 0 }),
    ev('Treasury.AssetSpendApproved', 300, { index: 1, amount: '5', beneficiary: BEN, validFrom: 300, expireAt: 400 }),
    ev('Treasury.AssetSpendApproved', 500, { index: 2, amount: '7', beneficiary: BEN, validFrom: 500, expireAt: 999_999_999 }),
  ] : undefined))

  it('folds each spend to its state and what anyone may sign next, newest first, paged by index', async () => {
    app = await freshDataApp(spendsClient())
    const res = await app.inject({ url: '/v1/governance/treasury/spends?limit=2', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.map((s: { index: number; state: string; canPayout: boolean; canCheckStatus: boolean }) => [s.index, s.state, s.canPayout, s.canCheckStatus]))
      .toEqual([[2, 'claimable', true, false], [1, 'expired', false, true]])
    expect(body.items[0].beneficiary.accountIdHex).toBe(BEN)
    const next = await app.inject({ url: `/v1/governance/treasury/spends?limit=2&cursor=${body.nextCursor}`, headers: AUTH })
    expect(next.json().items.map((s: { index: number; state: string; paidAtBlock: number }) => [s.index, s.state, s.paidAtBlock])).toEqual([[0, 'paid', 200]])
    const paid = await app.inject({ url: '/v1/governance/treasury/spends?state=paid', headers: AUTH })
    expect(paid.json().items).toHaveLength(1)
  })
})
