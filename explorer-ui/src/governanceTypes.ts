import type { AccountRef, ReferendumVoter } from './types'

// Shapes of the governance and forum read routes (api/src/routes/governance.ts,
// api/src/services/{governanceRead,forumRead}.ts). Amounts are planck strings;
// a BlockMoment is a block with its moment — `exact: false` means the moment is
// projected from the head at the chain's nominal slot time.

export interface BlockMoment { block: number; ts: string; exact: boolean }

// ---- forum ----

export interface ForumAuthor { account: AccountRef | null; legacyName: string | null }

export interface DiscussionRow {
  postId: string
  title: string
  excerpt: string
  labels: string[]
  author: ForumAuthor
  createdAt: string
  lastActivityAt: string
  editedAt: string | null
  commentsCount: number
  linked: string[]
  source: { name: 'subsquare' } | null
  bannerCid: string | null
  hasPoll: boolean
}

export interface DiscussionsPage { generation: string; total: number; rows: DiscussionRow[]; nextCursor: string | null }

export type DiscussionSort = 'active' | 'new'
export type ListedPostKind = 'discussion' | 'democracy_proposal' | 'external' | 'council' | 'tc' | 'treasury_proposal' | 'treasury_spend' | 'tip'

export interface ForumPostStub { postId: string; kind: string; hidden: true; hiddenReason: string; deleted: boolean; createdAt: string }

export interface ForumPostDetail {
  postId: string
  kind: string
  title: string
  body: string
  bodyFormat: string
  tldr: string
  labels: string[]
  linked: string[]
  author: ForumAuthor
  authority: string
  revision: number
  createdAt: string
  editedAt: string | null
  lastActivityAt: string
  commentsCount: number
  updatesCount: number
  threadKey: string
  source: { name: 'subsquare'; id: string; cid: string | null; removed: boolean } | null
  bannerCid: string | null
  /** The banner as our own image (`/ipfs/<cid>`) once it is re-hosted, else null; absent from older api builds. */
  banner?: string | null
  poll: unknown
  media: Record<string, string>
  /** A moderator locked the thread: it takes no new comments. */
  locked?: boolean
  hidden: false
  generation: string
}

export type ForumPost = ForumPostDetail | ForumPostStub

export interface ForumPosition { side: string; conviction: string | null; balance: string; weighted: string }

export interface ForumComment {
  commentId: string
  parentId: string | null
  replyToId: string | null
  author: ForumAuthor | null
  body: string | null
  bodyFormat: string
  hidden: boolean
  hiddenReason: string | null
  deleted: boolean
  createdAt: string
  editedAt: string | null
  revision: number
  source: { name: 'subsquare'; id: string; cid: string | null; height: number | null } | null
  position: ForumPosition | null
  media: Record<string, string>
  replies: ForumComment[]
}

export type ThreadSort = 'old' | 'new'
export type ThreadFilter = 'voters' | 'identity' | null

export interface ForumThread {
  requested: string
  threadKey: string
  generation: string
  total: number
  rows: ForumComment[]
  updates: ForumComment[]
  nextCursor: string | null
  positionsComplete: boolean | null
  locked?: boolean
}

export interface ForumRevision { revision: number; title: string; body: string; editor: ForumAuthor | null; source: string; createdAt: string }
export interface ForumRevisions { targetId: string; generation: string; revisions: ForumRevision[] }

export interface AccountForumItem { type: 'post' | 'comment'; id: string; threadKey: string; title: string | null; excerpt: string; createdAt: string }
export interface AccountForumPage { generation: string; total: number; rows: AccountForumItem[]; nextCursor: string | null }

export interface SubjectForumRef {
  postId: string
  threadKey: string
  commentsCount: number
  hasDescription: boolean
  authority: string | null
  source: { name: 'subsquare' } | null
}

// ---- governance (chain-derived) ----

export interface NeedsVoteReferendum {
  index: number
  title: string | null
  track: { id: number; name: string } | null
  status: string
  ends: { kind: 'decision-end' | 'confirm-end' | 'timeout' | 'prepare-end'; at: BlockMoment } | null
}

export interface NeedsVote {
  asOfBlock: number | null
  referenda: NeedsVoteReferendum[]
  accounts: {
    input: string
    accountId: string | null
    needsVote: number[]
    voted: { index: number; side: string; conviction: number | null; balance: string }[]
    delegated: { index: number; cls: number; target: AccountRef }[]
  }[]
}

export type CalendarKind = 'prepare-end' | 'timeout' | 'decision-end' | 'confirm-end' | 'concluded' | 'enactment' | 'spend-valid' | 'spend-expire'

export interface CalendarEvent {
  kind: CalendarKind
  at: BlockMoment
  referendum: { index: number; title: string | null; track: { id: number; name: string } | null; status: string } | null
  spend: { index: number; amount: string; assetKind: string | null; beneficiary: string | null } | null
  detail: string | null
}

export interface GovernanceCalendar { from: string; to: string; asOfBlock: number; events: CalendarEvent[] }

export type TrackCurveDef =
  | { linearDecreasing: { length: number; floor: number; ceil: number } }
  | { steppedDecreasing: { begin: number; end: number; step: number; period: number } }
  | { reciprocal: { factor: number; xOffset: number; yOffset: number } }

export interface ConvictionLockInfo { conviction: number; name: string; multiplierTenths: number; lockPeriods: number; lockBlocks: number; lockDays: number }

export interface GovernanceTrackInfo {
  id: number
  name: string
  maxDeciding: number
  decisionDeposit: string
  preparePeriod: number
  decisionPeriod: number
  confirmPeriod: number
  minEnactmentPeriod: number
  minApproval: TrackCurveDef
  minSupport: TrackCurveDef
  curve: { x: number; block: number; approval: number; support: number }[]
  deciding: number
  live: { index: number; title: string | null; status: string }[]
  recent: { index: number; title: string | null; status: string; concludedAt: { block: number; ts: string } | null }[]
  outcomes: { approved: number; rejected: number; cancelled: number; timedOut: number; killed: number; ongoing: number }
  passRate: number | null
}

export interface GovernanceTracksResponse {
  voteLockingPeriod: number
  msPerBlock: number
  undecidingTimeout: number
  maxVotesPerClass: number
  convictions: ConvictionLockInfo[]
  tracks: GovernanceTrackInfo[]
}

/** `/explorer/governance/convictions`: the conviction table alone. */
export type GovernanceConvictionsResponse = Pick<GovernanceTracksResponse, 'voteLockingPeriod' | 'msPerBlock' | 'convictions'>

export interface TallyPoint { block: number; ts: string | null; ayes: string; nays: string; support: string; approval: number | null }

export interface TallyHistory {
  pallet: 'opengov' | 'democracy'
  index: number
  track: { id: number; name: string } | null
  submittedBlock: number | null
  decisionStartBlock: number | null
  decisionPeriod: number | null
  confirmStartBlock: number | null
  concludedBlock: number | null
  points: TallyPoint[]
  chain: { ayes: string; nays: string; support: string | null; source: 'final' | 'live'; block: number | null } | null
  residual: { ayes: string; nays: string; support: string | null } | null
  residualShare: number | null
  trajectoryReliable: boolean
  reason: string | null
  delegationsAttributed: boolean
  electorate: string | null
  thresholds: { block: number; approval: number; support: number }[]
  periodsApproximate: boolean
  projection: { state: 'passing' | 'on-track' | 'short'; confirmableAtBlock: number | null } | null
}

export interface GovernanceVoteRow {
  account: string
  cls: number
  trackName: string | null
  poll: number
  referendum: { index: number; title: string | null; status: string } | null
  vote: { kind: 'Standard' | 'Split' | 'SplitAbstain'; side: 'Aye' | 'Nay' | 'Split' | 'SplitAbstain'; conviction: number | null; convictionName: string | null; balance: string; aye: string; nay: string; abstain: string }
  weighted: { ayes: string; nays: string; support: string }
  lockedNow: string
  afterEnd: { kind: 'if-wins' | 'won' | 'lost-staker' | 'none' | 'unknown'; amount: string; until: BlockMoment | null; estimate: boolean }
  finished: boolean
  removalForfeitsRewards: boolean
}

export interface GovernanceClassRow {
  account: string
  cls: number
  trackName: string | null
  kind: 'casting' | 'delegating'
  votes: number
  maxVotes: number
  prior: { amount: string; until: BlockMoment | null; expired: boolean } | null
  delegationsIn: { votes: string; capital: string }
  delegating: { target: AccountRef; balance: string; conviction: number; convictionName: string } | null
  requiredNow: string
}

export interface AccountGovernanceLocks {
  account: string
  locked: string
  unlockableAsIs: string
  unlockableNow: string
  unlockableCollect: string
  openEnded: string
  /** `freeable`: the vote lock released from then on; `spendable`: what that makes spendable net of the other locks (null: unknown). */
  schedule: { at: BlockMoment; freeable: string; spendable?: string | null }[]
  nextUnlock: { at: BlockMoment; amount: string } | null
  staker: { staking: string; gigahdx: string } | null
  /** The account's other Balances locks (staking, GIGAHDX, vesting, …); Balances freezes the largest lock, so they can hold HDX the vote lock releases. */
  otherLocks?: { id: string; name: string; amount: string }[] | null
  /** HDX each course makes spendable, net of the other locks (null: they could not be read). */
  spendableAsIs?: string | null
  spendableNow?: string | null
  spendableCollect?: string | null
  lockObservedAt: number | null
  estimate: true
}

/**
 * One proxy relation (governanceProxies.ts reads it). `blocked` says why it cannot vote
 * and `holder` which related account (the page's account or its EVM twin) it belongs
 * to; both are absent from older api builds.
 */
export interface ProxyRelation { account: AccountRef; proxyType: string; delay: number; canVote: boolean; blocked?: 'delay' | 'type' | null; holder?: string }

export interface AccountGovernance {
  account: AccountRef
  related: string[]
  asOfBlock: number | null
  votes: GovernanceVoteRow[]
  classes: GovernanceClassRow[]
  locks: AccountGovernanceLocks[]
  delegations: {
    in: { from: AccountRef; to: string; cls: number; trackName: string | null; balance: string; conviction: number; convictionName: string }[]
    out: { from: string; to: AccountRef; cls: number; trackName: string | null; balance: string; conviction: number; convictionName: string }[]
  }
  proxies: {
    canActFor: ProxyRelation[]
    actedForBy: ProxyRelation[]
    pure: { creator: AccountRef; proxyType: string; blockHeight: number } | null
  }
  history: {
    referendaVoted: number
    lastVote: BlockMoment | null
    /** The newest Standard OpenGov vote the account cast, even if since removed (absent from older api versions). */
    lastStandardVote?: { index: number; aye: boolean; conviction: number; balance: string; at: BlockMoment } | null
    source: string
    observedFrom: number
  }
  forum: { posts: number; comments: number }
  /** HDX held in referendum and preimage deposits (absent from older api versions). */
  deposits?: AccountDeposits
  gigahdxPendingRewards: null
}

/** One running referendum a group's members vote on, their current votes combined. */
export interface MembersRunningVote {
  index: number
  title: string | null
  status: string
  trackName: string | null
  voters: number
  aye: string
  nay: string
  abstain: string
  weighted: { ayes: string; nays: string; support: string }
}

/** A tag's (or list tag's) members' governance now, summed: /explorer/tag/:id/governance. */
export interface MembersGovernance {
  asOfBlock: number | null
  members: number
  voting: number
  delegating: number
  locks: { holders: number; locked: string; unlockableNow: string; openEnded: string; nextUnlock: { at: BlockMoment; amount: string } | null }
  running: MembersRunningVote[]
  delegationsOut: { to: AccountRef; members: number; tracks: number; balance: string }[]
  forum: { posts: number; comments: number }
}

// ---- deposits, the treasury, stats ----

export type DepositState = 'held' | 'refundable' | 'refunded' | 'kept' | 'slashed'
export interface EventAt { blockHeight: number; extrinsicIndex: number | null; timestamp: string }

export interface ReferendumDeposit {
  index: number
  kind: 'submission' | 'decision'
  /** The depositor (account id hex): a refund pays this account, whoever signs. */
  who: string
  amount: string
  placedAt: EventAt
  state: DepositState
  refundedAt: EventAt | null
  /** The depositor as an account reference (on a referendum's own deposits). */
  account?: AccountRef
}

export interface ReferendumDeposits {
  index: number
  status: string
  needsDecisionDeposit: boolean
  submission: ReferendumDeposit | null
  decision: ReferendumDeposit | null
}

export interface PreimageDeposit {
  hash: string
  owner: string
  amount: string
  len: number | null
  requested: boolean
  usedBy: { index: number; status: string }[]
  refundable: boolean
  blocked: string | null
  /** Noted under the pallet's older storage (StatusFor); its owner unnotes it the same way. */
  legacy?: boolean
}

export interface AccountDeposits {
  referenda: (ReferendumDeposit & { status: string; title?: string | null })[]
  preimages: PreimageDeposit[] | null
  preimagesAsOfBlock: number | null
  /** `held` excludes what the chain keeps for good (`kept`: rejected or timed-out submission deposits; absent from older api versions, whose `held` includes it). */
  totals: { held: string; refundable: string; kept?: string }
}

export interface TurnoutRow {
  index: number
  track: number | null
  status: string
  concludedAt: string | null
  submittedAt: string | null
  voters: number
  ayeVoters: number
  nayVoters: number
  splitVoters: number
  ayeCapital: string
  nayCapital: string
  support: string
}
export interface GovernanceStats {
  asOf: string
  turnout: TurnoutRow[]
  activeVoters: { month: string; voters: number; votes: number }[]
  locked: { now: string; accounts: number; since: number; weekly: { week: string; locked: string; accounts: number }[] }
  tracks: { id: number; name: string; approved: number; rejected: number; cancelled: number; timedOut: number; killed: number; ongoing: number; passRate: number | null }[]
}

export interface ReferendumVotesPage { total: number; totalAll: number; offset: number; limit: number; rows: ReferendumVoter[] }

// ---- the forum's writes (/user/forum/*) ----

export type ForumGateReason = 'muted' | 'no-stake-post' | 'no-stake-comment'

export interface ForumMe {
  account: AccountRef
  canPost: boolean
  canComment: boolean
  gate: { reason: ForumGateReason; detail: string } | null
  mutedUntil: string | null
  moderator: boolean
  linksUnlimited: boolean
  topics: string[]
  limits: {
    titleChars: number; postBodyChars: number; commentBodyChars: number; labelsPerPost: number; mentionsPerItem: number
    reportNoteChars: number; linksPerBody: number | null; discussionsPerHour: number; commentsPerMinute: number
  }
  upload: { usedBytes: number; maxBytes: number; maxFileBytes: number }
  ready: boolean
  /** What the gate read about the account (raw HDX planck, 12 decimals). */
  facts?: { hdx: string; identity: boolean; voted: boolean }
  /** The stake each action needs, in whole HDX. */
  thresholds?: { commentHdx: number; postHdx: number; autoHideHdx?: number }
  /** Per action: allowed, or why not in words that name the next step. */
  actions?: Partial<Record<ForumAction, { ok: boolean; reason: string | null }>>
}

export type ForumAction = 'comment' | 'post' | 'report' | 'upload'

export interface ForumPermissions { edit: boolean; delete: boolean; update: boolean; comment: boolean; reason: string | null }
export interface ForumPostWrite { post: ForumPost; generation: string }
export interface ForumCommentWrite { comment: ForumComment; generation: string }

export interface ModerationItem {
  targetId: string
  kind: 'post' | 'comment'
  threadKey: string
  title: string | null
  body: string
  bodyFormat: string
  author: AccountRef | null
  createdAt: string
  hidden: boolean
  hiddenReason: string
  moderated: boolean
  reports: Array<{ reportId: string; reporter: AccountRef | null; reason: string; note: string; at: string }>
}

export interface ModerationQueue { reported: ModerationItem[]; recent: ModerationItem[]; actions: string[]; reasons: string[]; reportReasons: string[] }

export interface ModerationLogRow { actionId: string; targetId: string; action: string; reasonCode: string; moderator: ForumAuthor | { source: 'subsquare' | 'reports' }; at: string; /** A comment target's thread; absent for a post, an image or an unknown comment. */ threadKey?: string }
export interface ModerationLogPage { generation: string; total: number; rows: ModerationLogRow[]; nextCursor: string | null }
