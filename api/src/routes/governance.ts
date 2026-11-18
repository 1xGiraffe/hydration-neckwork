import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { parseReferendumPallet } from '../services/governanceService.ts'
import { getReferendum } from '../services/governanceService.ts'
import { pageVoters } from '../services/referendumVotesPage.ts'
import { normalizeAddress } from '../services/addressIdentity.ts'
import {
  NEEDS_VOTE_MAX_ACCOUNTS, getAccountGovernance, getGovernanceClock, getMembersGovernance, getGovernanceCalendar, getGovernanceTracks, getNeedsVote, getTallyHistory,
} from '../services/governanceRead.ts'
import {
  BadCursorError, LISTED_POST_KINDS, discussionLabels, getAccountForum, getForumPost, getForumRevisions, getForumThread, getModerationLog,
  listDiscussions, type DiscussionSort, type ListedPostKind, type ThreadFilter, type ThreadSort,
} from '../services/forumRead.ts'
import { forumMedia, forumReady } from '../services/forumStore.ts'
import { mayServeMedia } from '../services/forumMedia.ts'
import { convictionSnapshotReady } from '../services/convictionState.ts'
import { tagMembers } from '../services/explorerService.ts'
import { getTreasury } from '../services/governanceTreasury.ts'
import { getGovernanceStats } from '../services/governanceStats.ts'

// Governance and forum read routes (all anonymous, under /explorer/), plus the forum
// image route the explorer's nginx maps /ipfs/<cid> onto.
//
// Forum reads answer `public, max-age=0, s-maxage=2`: inside the explorer's /api/
// micro-cache for at most two seconds, never in a browser — a reader's own write is
// visible on its next read (the write returns the new `generation`, and a `?g=` on the
// re-read is a key the micro-cache has not seen).

const FORUM_CACHE = 'public, max-age=0, s-maxage=2'
// Every voter of a referendum (the largest has a few hundred): one cached read serves every page.
const ALL_VOTERS = 1_000_000
const MAX_LIMIT = 100

const uint32 = z.coerce.number().int().min(0).max(0xffff_ffff)
const addressParam = z.object({ address: z.string().min(1).max(128) })
// A forum id: a post id ('s248', '42', 'opengov:450', 'external:0x…@6429878'), a
// comment id ('s<ObjectId>', 'c<ULID>') or a thread key — printable, bounded.
const forumId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_:@.#-]+$/)

function pageParams(q: Record<string, unknown>, defLimit = 25): { offset: number; limit: number } | null {
  const offset = q.cursor == null || q.cursor === '' ? 0 : Number(q.cursor)
  const limit = q.limit == null || q.limit === '' ? defLimit : Number(q.limit)
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return null
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null
  return { offset, limit }
}

// A route that answers from a background snapshot answers 503 until that snapshot
// has loaded — an empty answer would read as real ("no votes", "no discussions").
// Both load before listen; this covers a boot whose load failed until its refresh
// succeeds.
function notReady(reply: FastifyReply, what: 'conviction-state' | 'forum'): FastifyReply {
  return reply.status(503).header('cache-control', 'no-store').header('retry-after', '10')
    .send({ error: what === 'forum' ? 'The forum store is still loading' : 'Governance vote state is still loading', reason: 'not-ready', snapshot: what })
}

function forumReply<T>(reply: FastifyReply, body: T): T {
  reply.header('cache-control', FORUM_CACHE)
  return body
}

// CIDv1 in base32 (what the node adds: 'b' + lower-case base32), or CIDv0 (imported
// Subsquare CIDs: base58btc 'Qm' + 44).
export const CID_RE = /^(b[a-z2-7]{58,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/

const IPFS_GATEWAY_URL = (process.env.IPFS_GATEWAY_URL ?? 'http://hydration-neckwork-ipfs:8080').replace(/\/+$/, '')
const MEDIA_MAX_BYTES = 6 * 1024 * 1024

export async function governanceRoutes(fastify: FastifyInstance): Promise<void> {
  // ---- governance (chain-derived) ----

  fastify.get('/explorer/governance/tracks', async () => getGovernanceTracks())

  // The conviction table alone (lock length per conviction at the chain's pace),
  // for pages that explain a vote's lock without drawing every track's curves.
  fastify.get('/explorer/governance/convictions', async () => {
    const { voteLockingPeriod, msPerBlock, convictions } = await getGovernanceTracks()
    return { voteLockingPeriod, msPerBlock, convictions }
  })

  fastify.get('/explorer/governance/tracks/:id', async (req, reply) => {
    const p = z.object({ id: uint32 }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid track id' })
    const all = await getGovernanceTracks()
    const track = all.tracks.find(t => t.id === p.data.id)
    if (!track) return reply.status(404).send({ error: 'Track not found' })
    return { ...all, tracks: undefined, track }
  })

  // The projector every governance date is placed with (see governanceRead's clock):
  // the explorer's own countdowns use it so a page never projects a deadline the API
  // dated differently.
  fastify.get('/explorer/governance/clock', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=5')
    return getGovernanceClock()
  })

  // A referendum's voters a page at a time (sort power|time, side all|aye|nay|abstain, q = an
  // address in any spelling or a name), with exact totals — the same voter list the
  // referendum detail reads.
  fastify.get('/explorer/referendum/:pallet/:index/votes', async (req, reply) => {
    const p = z.object({ pallet: z.string(), index: uint32 }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid referendum reference' })
    const pallet = parseReferendumPallet(p.data.pallet)
    if (!pallet) return reply.status(400).send({ error: "Referendum pallet must be 'opengov' or 'democracy'" })
    const q = req.query as Record<string, unknown>
    const page = pageParams({ cursor: q.offset, limit: q.limit })
    if (!page) return reply.status(400).send({ error: `offset must be a non-negative integer and limit 1-${MAX_LIMIT}` })
    const sort = q.sort === 'time' ? 'time' : 'power'
    const side = q.side === 'aye' || q.side === 'nay' || q.side === 'abstain' ? q.side : 'all'
    const search = typeof q.q === 'string' ? q.q.trim().slice(0, 128) : ''
    const detail = await getReferendum(pallet, p.data.index, ALL_VOTERS)
    if (!detail) return reply.status(404).send({ error: 'Referendum not found' })
    const accountId = search ? normalizeAddress(search)?.accountId ?? null : null
    return pageVoters(detail.voters, { sort, side, q: search, accountId, ...page })
  })

  fastify.get('/explorer/referendum/:pallet/:index/tally-history', async (req, reply) => {
    const p = z.object({ pallet: z.string(), index: uint32 }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid referendum reference' })
    const pallet = parseReferendumPallet(p.data.pallet)
    if (!pallet) return reply.status(400).send({ error: "Referendum pallet must be 'opengov' or 'democracy'" })
    const history = await getTallyHistory(pallet, p.data.index)
    if (!history) return reply.status(404).send({ error: 'Referendum not found' })
    return history
  })

  // ?from=&to= as ISO dates (or unix seconds); default: a week back to sixty days ahead.
  fastify.get('/explorer/governance/calendar', async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const at = (v: unknown, def: number): number | null => {
      if (v == null || v === '') return def
      const s = String(v)
      const t = /^\d{9,11}$/.test(s) ? Number(s) * 1000 : Date.parse(s)
      return Number.isFinite(t) ? t : null
    }
    const now = Date.now()
    const from = at(q.from, now - 7 * 86_400_000), to = at(q.to, now + 60 * 86_400_000)
    if (from == null || to == null || to < from || to - from > 400 * 86_400_000) {
      return reply.status(400).send({ error: 'from/to must be dates (ISO or unix seconds), to >= from, at most 400 days apart' })
    }
    // Day-aligned so concurrent readers share one cache entry.
    const day = 86_400_000
    return getGovernanceCalendar(Math.floor(from / day) * day, Math.ceil(to / day) * day)
  })

  // A tag's Governance tab: its members' locks, delegations and running votes, summed.
  fastify.get('/explorer/tag/:tagId/governance', async (req, reply) => {
    if (!convictionSnapshotReady()) return notReady(reply, 'conviction-state')
    const p = z.object({ tagId: z.string().min(1).max(64) }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid tag id' })
    const members = tagMembers(p.data.tagId)
    if (!members) return reply.status(404).send({ error: 'Tag not found' })
    return getMembersGovernance(members, `tag:${p.data.tagId}`)
  })

  fastify.get('/explorer/address/:address/governance', async (req, reply) => {
    if (!convictionSnapshotReady()) return notReady(reply, 'conviction-state')
    const p = addressParam.safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid address' })
    const out = await getAccountGovernance(p.data.address)
    if (!out) return reply.status(404).send({ error: 'Address not recognized' })
    return out
  })

  // The explorer asks for a reader's accounts in a POST body: a URL would put the whole
  // set — every account one person holds, follows or proxies for — into the api's and
  // the edge's access logs beside their IP. The body is never logged, and the answer
  // is never cached. The GET form stays for the MCP server, which asks about one
  // address it was given.
  const needsVoteAccounts = (accounts: string[]) =>
    accounts.length > 0 && accounts.length <= NEEDS_VOTE_MAX_ACCOUNTS && accounts.every(a => typeof a === 'string' && a.length > 0 && a.length <= 128)
  fastify.post('/explorer/governance/needs-vote', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const raw = (req.body as { accounts?: unknown } | null)?.accounts
    const accounts = Array.isArray(raw) ? [...new Set(raw.map(a => (typeof a === 'string' ? a.trim() : '')))].filter(Boolean) : []
    if (!needsVoteAccounts(accounts)) return reply.status(400).send({ error: `accounts must list 1-${NEEDS_VOTE_MAX_ACCOUNTS} addresses` })
    if (!convictionSnapshotReady()) return notReady(reply, 'conviction-state')
    return getNeedsVote(accounts)
  })

  fastify.get('/explorer/governance/needs-vote', async (req, reply) => {
    if (!convictionSnapshotReady()) return notReady(reply, 'conviction-state')
    const raw = (req.query as Record<string, unknown>).accounts
    const accounts = typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : []
    if (!needsVoteAccounts(accounts)) {
      return reply.status(400).send({ error: `accounts must list 1-${NEEDS_VOTE_MAX_ACCOUNTS} addresses, comma-separated` })
    }
    return getNeedsVote(accounts)
  })

  // The treasury: its pot (now and weekly), every spend with its state and what anyone
  // may do about it (payout, check_status), and the proposals it paid at its spend period.
  fastify.get('/explorer/governance/treasury', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=5')
    return getTreasury()
  })

  // The hub's Stats view (governanceStats.ts): turnout per referendum, active voters per
  // month, HDX locked in votes and the pass rate per track.
  fastify.get('/explorer/governance/stats', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60')
    return getGovernanceStats()
  })

  // ---- forum ----

  fastify.get('/explorer/forum/discussions', async (req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    const q = req.query as Record<string, unknown>
    const page = pageParams(q)
    if (!page) return reply.status(400).send({ error: `cursor must be a non-negative integer and limit 1-${MAX_LIMIT}` })
    const sort: DiscussionSort = q.sort === 'new' ? 'new' : 'active'
    const label = typeof q.label === 'string' && q.label.length <= 40 ? q.label : undefined
    const search = typeof q.q === 'string' ? q.q.slice(0, 120) : undefined
    // ?kind= lists another collection the forum holds (an archive body's imported
    // records); absent, the discussions.
    const kind = q.kind == null || q.kind === '' ? 'discussion' : (LISTED_POST_KINDS as readonly string[]).includes(String(q.kind)) ? String(q.kind) as ListedPostKind : null
    if (!kind) return reply.status(400).send({ error: `kind must be one of ${LISTED_POST_KINDS.join(', ')}` })
    return forumReply(reply, listDiscussions({ sort, label, q: search, kind, ...page }))
  })

  fastify.get('/explorer/forum/labels', async (_req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    return forumReply(reply, { labels: discussionLabels() })
  })

  fastify.get('/explorer/forum/post/:postId', async (req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    const p = z.object({ postId: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid post id' })
    const post = await getForumPost(p.data.postId)
    if (!post) return reply.status(404).send({ error: 'Post not found' })
    return forumReply(reply, post)
  })

  fastify.get('/explorer/forum/thread/:threadKey', async (req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    const p = z.object({ threadKey: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid thread key' })
    const q = req.query as Record<string, unknown>
    const limit = q.limit == null || q.limit === '' ? 50 : Number(q.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return reply.status(400).send({ error: `limit must be 1-${MAX_LIMIT}` })
    const cursor = typeof q.cursor === 'string' && q.cursor ? q.cursor.slice(0, 400) : null
    const sort: ThreadSort = q.sort === 'new' ? 'new' : 'old'
    const filter: ThreadFilter = q.filter === 'voters' || q.filter === 'identity' ? q.filter : null
    try {
      return forumReply(reply, await getForumThread(p.data.threadKey, { sort, filter, cursor, limit }))
    } catch (err) {
      if (err instanceof BadCursorError) return reply.status(400).send({ error: 'Invalid cursor for this sort' })
      throw err
    }
  })

  fastify.get('/explorer/forum/revisions/:targetId', async (req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    const p = z.object({ targetId: forumId }).safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid target id' })
    const out = await getForumRevisions(p.data.targetId)
    if (!out) return reply.status(404).send({ error: 'Not found' })
    return forumReply(reply, out)
  })

  fastify.get('/explorer/forum/moderation-log', async (req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    const page = pageParams(req.query as Record<string, unknown>, 50)
    if (!page) return reply.status(400).send({ error: `cursor must be a non-negative integer and limit 1-${MAX_LIMIT}` })
    return forumReply(reply, await getModerationLog(page.offset, page.limit))
  })

  fastify.get('/explorer/address/:address/forum', async (req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    const p = addressParam.safeParse(req.params)
    if (!p.success) return reply.status(400).send({ error: 'Invalid address' })
    const page = pageParams(req.query as Record<string, unknown>)
    if (!page) return reply.status(400).send({ error: `cursor must be a non-negative integer and limit 1-${MAX_LIMIT}` })
    const out = await getAccountForum(p.data.address, page.offset, page.limit)
    if (!out) return reply.status(404).send({ error: 'Address not recognized' })
    return forumReply(reply, out)
  })

  // ---- forum images: /ipfs/<cid> (nginx) → here ----
  //
  // Only a CID with a live forum_media row is served — the node is not an open
  // gateway, and its gateway serves local blocks only (Gateway.NoFetch). The
  // Content-Type is the one the server validated, never the node's or the original
  // host's; the response is sandboxed and never sniffed. A day of caching rather
  // than a year keeps a moderator's removal effective within a day everywhere.
  fastify.get('/forum/media/:cid', async (req, reply) => {
    if (!forumReady()) return notReady(reply, 'forum')
    const cid = (req.params as { cid?: string }).cid ?? ''
    if (!CID_RE.test(cid)) return reply.status(404).send({ error: 'Not found' })
    const media = forumMedia(cid)
    if (!media) return reply.status(404).send({ error: 'Not found' })
    // Pinned is not enough: an image only hidden, deleted or purged items use is not
    // served (see mayServeMedia — a fresh upload is, for the editor's preview).
    let servable: boolean
    try { servable = await mayServeMedia(media) } catch { return reply.status(503).send({ error: 'Image unavailable' }) }
    if (!servable) return reply.status(404).send({ error: 'Not found' })
    let bytes: Buffer
    try {
      const res = await fetch(`${IPFS_GATEWAY_URL}/ipfs/${cid}`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return reply.status(502).send({ error: 'Image unavailable' })
      bytes = Buffer.from(await res.arrayBuffer())
    } catch {
      return reply.status(502).send({ error: 'Image unavailable' })
    }
    if (bytes.length > MEDIA_MAX_BYTES || (media.bytes > 0 && bytes.length !== media.bytes)) return reply.status(502).send({ error: 'Image unavailable' })
    reply
      .header('content-type', media.mime)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .header('content-security-policy', "default-src 'none'; sandbox")
      // A CID names its bytes, so they never change under this URL: a reader's
      // browser keeps them for a year without revalidating. Only availability
      // changes (an image whose items were hidden or removed stops being served),
      // and a page stops asking for it at once, since it renders only the images
      // in its own media map. The HTTPS-only origin leaves no shared cache between
      // readers but nginx's own, which keeps a day (nginx.conf, /ipfs/).
      .header('cache-control', 'public, max-age=31536000, immutable')
    return reply.send(bytes)
  })
}
