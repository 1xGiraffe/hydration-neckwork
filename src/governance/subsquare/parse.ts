// Strict, hand-written validators for Subsquare's public JSON API
// (https://hydration-api.subsquare.io). Every response is untrusted: a value of an
// unexpected shape makes its item `null` (the caller logs a warning and skips the
// item — never a partial overwrite), and every text field is carried through
// byte-identical, because it is HOSTILE (live XSS probes exist) and is made safe only
// by the renderer, at display time.
//
// `emailMd5` (a Gravatar hash identifying an email address) is dropped HERE and never
// reaches a row, a log line or a report: no parser output type has a field for it.

export type Json = unknown

const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: Json): v is string => typeof v === 'string'
/**
 * A Subsquare document id: a MongoDB ObjectId, 24 lower-case hex. Nothing else is
 * accepted — our ids are built from it by prefix (`s<id>` a comment, `su<id>` an
 * Update), so an id like `u<x>` would make a comment collide with an Update.
 */
export const SS_ID = /^[0-9a-f]{24}$/
const isId = (v: Json): v is string => isStr(v) && SS_ID.test(v)

/** An ISO timestamp → epoch ms, or null when absent/unparseable. */
export function isoMs(v: Json): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (!isStr(v)) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}
const intOf = (v: Json): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : isStr(v) && /^\d{1,12}$/.test(v) ? Number(v) : null)
const optStr = (v: Json): string | null => (isStr(v) ? v : null)

/** A Subsquare author with its email hash removed. */
export interface SsAuthor {
  username: string
  /** hex WITHOUT 0x as Subsquare spells it (32-byte substrate key or 20-byte EVM address), or null */
  publicKey: string | null
  /** SS58 (any prefix) or 0x H160, as Subsquare spells it, or null */
  address: string | null
}

export function parseAuthor(v: Json): SsAuthor | null | 'invalid' {
  if (v == null) return null
  if (!isObj(v)) return 'invalid'
  const username = optStr(v.username) ?? ''
  const publicKey = v.publicKey == null ? null : isStr(v.publicKey) && /^(0x)?[0-9a-fA-F]{40,64}$/.test(v.publicKey) ? v.publicKey.replace(/^0x/, '') : 'bad'
  const address = v.address == null ? null : isStr(v.address) && v.address.length <= 80 ? v.address : 'bad'
  if (publicKey === 'bad' || address === 'bad') return 'invalid'
  if (!username && !publicKey && !address) return 'invalid'
  return { username, publicKey, address }
}

/** The ten Subsquare collections the forum imports. */
export type CollectionName =
  | 'discussions' | 'opengov' | 'democracy' | 'democracy_proposal' | 'external'
  | 'council' | 'tc' | 'treasury' | 'spend' | 'tip'

/** Our `kind` column per collection (021_forum.sql). */
export const KIND_OF: Record<CollectionName, string> = {
  discussions: 'discussion', opengov: 'opengov', democracy: 'democracy', democracy_proposal: 'democracy_proposal',
  external: 'external', council: 'council', tc: 'tc', treasury: 'treasury_proposal', spend: 'treasury_spend', tip: 'tip',
}

/** List path per collection; an item's detail is `<path>/<_id>` (discussions: `/posts/<uid>`), its thread `<path>/<_id>/comments`. */
export const LIST_PATH: Record<CollectionName, string> = {
  discussions: '/posts', opengov: '/gov2/referendums', democracy: '/democracy/referendums',
  democracy_proposal: '/democracy/proposals', external: '/democracy/externals', council: '/motions',
  tc: '/tech-comm/motions', treasury: '/treasury/proposals', spend: '/treasury/spends', tip: '/treasury/tips',
}

/** The /summary key whose `all` is each collection's total. */
export const SUMMARY_KEY: Record<CollectionName, string> = {
  discussions: 'discussions', opengov: 'gov2Referenda', democracy: 'referenda', democracy_proposal: 'publicProposals',
  external: 'externalProposals', council: 'motions', tc: 'techCommMotions', treasury: 'treasuryProposals',
  spend: 'treasurySpends', tip: 'tips',
}

export const COLLECTIONS: CollectionName[] = ['discussions', 'opengov', 'democracy', 'democracy_proposal', 'external', 'council', 'tc', 'treasury', 'spend', 'tip']

export interface SsPoll { title: string; options: string[]; expiresTime: number | null; anonymous: boolean }

/** One root document: a discussion, or an on-chain subject's description. */
export interface SsItem {
  collection: CollectionName
  /** our post_id / subject key */
  subject: string
  sourceId: string
  /** discussions only */
  uid: number | null
  rootPostId: string
  rootPostType: string
  /** the post an on-chain item is bound to (Subsquare's refToPost), when it is a discussion */
  boundDiscussionId: string | null
  title: string
  content: string
  contentType: 'markdown' | 'html'
  contentHash: string | null
  author: SsAuthor | null
  /** SIMA posts carry no author object, only the signer's address */
  proposer: string | null
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  commentsCount: number
  labels: string[]
  poll: (SsPoll & { id: string }) | null
  bannerCid: string | null
  cid: string | null
  dataSource: string | null
  hide: boolean
  isMalicious: boolean
  edited: boolean
  /** an on-chain item's call or reason hash (lower-case) and its block, as Subsquare names it in URLs (`<block>_<hash>`) */
  hash: string | null
  height: number | null
  /** the indexes an on-chain item carries, used to resolve its thread's owner */
  refs: { referendumIndex: number | null; proposalIndex: number | null; motionIndex: number | null }
  /** SIMA appendants inlined in a discussion's detail, unparsed */
  appendantsRaw: Json[] | null
}

/** Our subject key for an item of `collection`, or null when the item lacks its identity. */
export function subjectOf(collection: CollectionName, v: Record<string, Json>): string | null {
  switch (collection) {
    case 'discussions': { const uid = intOf(v.postUid); return uid == null ? null : `s${uid}` }
    case 'opengov': case 'democracy': { const i = intOf(v.referendumIndex); return i == null ? null : `${collection}:${i}` }
    case 'democracy_proposal': { const i = intOf(v.proposalIndex); return i == null ? null : `democracy_proposal:${i}` }
    case 'treasury': { const i = intOf(v.proposalIndex); return i == null ? null : `treasury:${i}` }
    case 'spend': { const i = intOf(v.index); return i == null ? null : `spend:${i}` }
    case 'council': case 'tc': {
      // Two early TC motions (2023-01) carry no motion index on Subsquare: named by their hash and block.
      const i = intOf(v.motionIndex)
      if (i != null) return `${collection}:${i}`
      const hash = optStr(v.hash)
      const height = isObj(v.indexer) ? intOf(v.indexer.blockHeight) : intOf(v.height)
      return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) && height != null ? `${collection}:${hash.toLowerCase()}@${height}` : null
    }
    case 'external': {
      const hash = optStr(v.externalProposalHash) ?? optStr(v.hash)
      const height = isObj(v.indexer) ? intOf(v.indexer.blockHeight) : intOf(v.height)
      return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) && height != null ? `external:${hash.toLowerCase()}@${height}` : null
    }
    case 'tip': {
      // A tip's hash repeats when the same reason is tipped again (5 retracted-and-reopened
      // pairs on Hydration), so its block is part of the identity, as for externals.
      const hash = optStr(v.hash)
      const height = isObj(v.indexer) ? intOf(v.indexer.blockHeight) : intOf(v.height)
      return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) && height != null ? `tip:${hash.toLowerCase()}@${height}` : null
    }
  }
}

function parsePoll(v: Json): (SsPoll & { id: string }) | null | 'invalid' {
  // A list item names its poll by id only; the detail carries the poll itself.
  if (v == null || isStr(v)) return null
  if (!isObj(v) || !isId(v._id)) return 'invalid'
  const options = Array.isArray(v.options) && v.options.length <= POLL_MAX_OPTIONS && v.options.every(isStr) ? (v.options as string[]).map(o => o.slice(0, POLL_OPTION_CHARS)) : null
  if (!options) return 'invalid'
  return { id: v._id, title: (optStr(v.title) ?? '').slice(0, 300), options, expiresTime: typeof v.expiresTime === 'number' ? v.expiresTime : null, anonymous: v.anonymous === true }
}

export function parseItem(collection: CollectionName, v: Json): SsItem | null {
  if (!isObj(v) || !isId(v._id)) return null
  const subject = subjectOf(collection, v)
  if (!subject) return null
  const author = parseAuthor(v.author)
  if (author === 'invalid') return null
  const createdAt = isoMs(v.createdAt) ?? (isObj(v.indexer) ? isoMs(v.indexer.blockTime) : null)
  if (createdAt == null) return null
  const updatedAt = isoMs(v.updatedAt) ?? createdAt
  const lastActivityAt = isoMs(v.lastActivityAt) ?? updatedAt
  const contentType = v.contentType === 'html' ? 'html' : 'markdown'
  if (v.contentType != null && v.contentType !== 'html' && v.contentType !== 'markdown') return null
  if (v.content != null && !isStr(v.content)) return null
  if (v.title != null && !isStr(v.title)) return null
  const poll = parsePoll(v.poll)
  if (poll === 'invalid') return null
  const root = isObj(v.rootPost) && isStr(v.rootPost.postId) ? v.rootPost : null
  const labels = Array.isArray(v.labels) ? v.labels.filter(isStr).slice(0, 16) : []
  return {
    collection,
    subject,
    sourceId: v._id,
    uid: collection === 'discussions' ? intOf(v.postUid) : null,
    // A discussion owns its own thread: its comments name the discussion's _id.
    rootPostId: root ? root.postId as string : v._id,
    rootPostType: root ? optStr(root.postType) ?? '' : 'post',
    boundDiscussionId: collection !== 'discussions' && isObj(v.refToPost) && v.refToPost.postType === 'post' && isStr(v.refToPost.postId) ? v.refToPost.postId : null,
    title: optStr(v.title) ?? '',
    content: optStr(v.content) ?? '',
    contentType,
    contentHash: optStr(v.contentHash),
    author,
    proposer: optStr(v.proposer),
    createdAt,
    updatedAt,
    lastActivityAt,
    commentsCount: intOf(v.commentsCount) ?? 0,
    labels,
    poll,
    bannerCid: optStr(v.bannerCid),
    cid: optStr(v.cid),
    dataSource: optStr(v.dataSource),
    hide: v.hide === true,
    isMalicious: v.isMalicious === true,
    edited: v.edited === true,
    hash: isStr(v.hash) && /^0x[0-9a-fA-F]{64}$/.test(v.hash) ? v.hash.toLowerCase() : null,
    height: isObj(v.indexer) ? intOf(v.indexer.blockHeight) : intOf(v.height),
    refs: { referendumIndex: intOf(v.referendumIndex), proposalIndex: intOf(v.proposalIndex), motionIndex: intOf(v.motionIndex) },
    appendantsRaw: Array.isArray(v.appendants) ? v.appendants : null,
  }
}

export interface SsPage { items: Json[]; total: number; page: number; pageSize: number }

export function parsePage(v: Json): SsPage | null {
  if (!isObj(v) || !Array.isArray(v.items)) return null
  const total = intOf(v.total)
  if (total == null) return null
  return { items: v.items, total, page: intOf(v.page) ?? 1, pageSize: intOf(v.pageSize) ?? v.items.length }
}

/** The owner fields a comment can name its merged thread's root post by. */
export const OWNER_FIELDS = ['post', 'referendaReferendum', 'democracy', 'motion', 'techCommMotion', 'treasuryProposal', 'tip', 'treasurySpend'] as const

export interface SsComment {
  id: string
  ownerType: string
  ownerId: string
  replyToComment: string | null
  content: string
  contentType: 'markdown' | 'html'
  author: SsAuthor | null
  proposer: string | null
  height: number
  createdAt: number
  updatedAt: number
  dataSource: string | null
  cid: string | null
  hasEditHistory: boolean
  replies: SsComment[]
}

export function parseComment(v: Json, depth = 0): SsComment | null {
  if (!isObj(v) || !isId(v._id)) return null
  const ownerType = OWNER_FIELDS.find(f => isStr(v[f]))
  if (!ownerType) return null
  const author = parseAuthor(v.author)
  if (author === 'invalid') return null
  if (v.content != null && !isStr(v.content)) return null
  const createdAt = isoMs(v.createdAt)
  if (createdAt == null) return null
  const replies: SsComment[] = []
  if (Array.isArray(v.replies) && depth === 0) {
    for (const r of v.replies) {
      const reply = parseComment(r, depth + 1)
      if (!reply) return null
      replies.push(reply)
    }
  }
  const replyTo = v.replyToComment == null ? null : isId(v.replyToComment) ? v.replyToComment : isObj(v.replyToComment) && isId(v.replyToComment._id) ? v.replyToComment._id : null
  return {
    id: v._id,
    ownerType,
    ownerId: v[ownerType] as string,
    replyToComment: replyTo,
    content: optStr(v.content) ?? '',
    contentType: v.contentType === 'html' ? 'html' : 'markdown',
    author,
    proposer: optStr(v.proposer),
    height: intOf(v.height) ?? 0,
    createdAt,
    updatedAt: isoMs(v.updatedAt) ?? createdAt,
    dataSource: optStr(v.dataSource),
    cid: optStr(v.cid),
    hasEditHistory: v.hasEditHistory === true,
    replies,
  }
}

/** A proposer's appendant ("update") under a description. */
export interface SsAppendant { id: string; content: string; contentType: 'markdown' | 'html'; author: SsAuthor | null; proposer: string | null; createdAt: number; updatedAt: number; cid: string | null }

export function parseAppendant(v: Json): SsAppendant | null {
  if (!isObj(v) || !isId(v._id)) return null
  const author = parseAuthor(v.author)
  if (author === 'invalid') return null
  if (v.content != null && !isStr(v.content)) return null
  const createdAt = isoMs(v.createdAt) ?? (isObj(v.indexer) ? isoMs(v.indexer.blockTime) : null)
  if (createdAt == null) return null
  return {
    id: v._id, content: optStr(v.content) ?? '', contentType: v.contentType === 'html' ? 'html' : 'markdown',
    author, proposer: optStr(v.proposer) ?? optStr(v.who), createdAt, updatedAt: isoMs(v.updatedAt) ?? createdAt, cid: optStr(v.cid),
  }
}

/** Bounds on a poll: options, an option's text, voters kept per option (the count stays exact). */
export const POLL_MAX_OPTIONS = 32
export const POLL_OPTION_CHARS = 200
export const POLL_MAX_VOTERS = 2_000

export interface SsPollVotes {
  /** option → vote count */
  counts: Record<string, number>
  /** option → its voters, for a public (non-anonymous) poll; null for an anonymous one */
  voters: Record<string, SsAuthor[]> | null
}

/**
 * Poll results. An anonymous poll answers option → count; a public one option → its
 * voters (author objects, whose email hash parseAuthor drops). An option nobody chose
 * is absent from both.
 */
export function parsePollVotes(v: Json): SsPollVotes | null {
  if (!isObj(v)) return null
  const entries = Object.entries(v)
  if (entries.length > POLL_MAX_OPTIONS) return null
  // Prototype-less: an option may be named anything, `__proto__` included.
  const counts: Record<string, number> = Object.create(null)
  const voters: Record<string, SsAuthor[]> = Object.create(null)
  let named = false
  for (const [k, n] of entries) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) { counts[k] = n; continue }
    if (!Array.isArray(n)) return null
    const list: SsAuthor[] = []
    for (const raw of n.slice(0, POLL_MAX_VOTERS)) {
      const a = parseAuthor(raw)
      if (a === 'invalid' || a == null) return null
      list.push(a)
    }
    counts[k] = n.length
    voters[k] = list
    named = true
  }
  return { counts, voters: named ? voters : null }
}
