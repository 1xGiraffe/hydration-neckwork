/**
 * The OpenGov readings `get_governance` gained with the explorer's governance
 * pages: track rules, the governance calendar, one account's votes and locks,
 * and a referendum's reconstructed tally trajectory.
 *
 * Shapes mirror api/src/services/governanceRead.ts as served under
 * /explorer/governance/… and /explorer/address/:a/governance; only the fields
 * rendered here are declared. Every vote-lock figure is HDX (12 decimals) —
 * conviction voting locks the native token only.
 */

import type { AccountRef } from '../types.ts'
import { DASH, formatAmount, formatCount, formatPercent, scaleAmount } from '../format/units.ts'
import { blocksToDuration, formatDuration, formatTime, relativeAge } from '../format/time.ts'
import {
  accountLabel, accountUrl, explorerLink, referendumUrl, shortAddress, treasurySpendUrl,
} from '../format/refs.ts'
import { h2, h3, joinBlocks, kv, note, table } from '../format/md.ts'
import { userLine } from '../format/untrusted.ts'
import { USER_TITLES_NOTE } from '../format/forum.ts'

const HDX_DECIMALS = 12
const hdx = (raw: string | null | undefined): string => formatAmount(raw, HDX_DECIMALS, 'HDX')
const isPositive = (raw: string | null | undefined): boolean => (scaleAmount(raw, HDX_DECIMALS) ?? 0) > 0
const title = (t: string | null | undefined, max = 70): string => userLine(t, max) || 'untitled'

/** A perbill (parts per billion) as a percentage. */
const perbill = (n: number | null | undefined, digits = 1): string =>
  n == null || !Number.isFinite(n) ? DASH : `${(n / 1e7).toFixed(digits)}%`

/* ============ shared shapes ============ */

/** A block with the moment it happened (exact) or is projected to (estimate). */
export interface BlockMoment { block: number; ts: string; exact: boolean }

/** `2026-11-13 01:23:15 UTC · in 5d (projected) · block 16,949,882` */
export function momentText(m: BlockMoment | null | undefined): string {
  if (!m) return DASH
  return `${formatTime(m.ts)} · ${relativeAge(m.ts)}${m.exact ? '' : ' (projected)'} · block ${formatCount(m.block)}`
}

export interface GovernanceClock { headBlock: number; msPerBlock: number; nominalMsPerBlock: number }

/* ============ tracks ============ */

type TrackCurve =
  | { linearDecreasing: { length: number; floor: number; ceil: number } }
  | { reciprocal: { factor: number; xOffset: number; yOffset: number } }

export interface GovernanceTrackInfo {
  id: number
  name: string
  maxDeciding: number
  decisionDeposit: string
  preparePeriod: number
  decisionPeriod: number
  confirmPeriod: number
  minEnactmentPeriod: number
  minApproval: TrackCurve
  minSupport: TrackCurve
  /** 101 samples over the decision period: x in perbill of the period, thresholds in perbill. */
  curve: { x: number; block: number; approval: number; support: number }[]
  deciding: number
  live: { index: number; title: string | null; status: string }[]
  recent: { index: number; title: string | null; status: string; concludedAt: { block: number; ts: string } | null }[]
  outcomes: { approved: number; rejected: number; cancelled: number; timedOut: number; killed: number; ongoing: number }
  passRate: number | null
}

interface ConvictionLockInfo { conviction: number; name: string; multiplierTenths: number; lockPeriods: number; lockBlocks: number; lockDays: number }

interface TracksCommon { voteLockingPeriod: number; msPerBlock: number; undecidingTimeout: number; maxVotesPerClass: number; convictions: ConvictionLockInfo[] }
export interface GovernanceTracks extends TracksCommon { tracks: GovernanceTrackInfo[] }
export interface GovernanceTrackOne extends TracksCommon { track: GovernanceTrackInfo }

/**
 * A threshold curve in words, read off the explorer's own samples rather than
 * re-derived here: where it starts, a quarter and half way through the
 * decision period, and where it ends — plus its shape, because "linear to a
 * floor" and "reciprocal" fall very differently in the first days.
 */
export function curveWords(curve: GovernanceTrackInfo['curve'], key: 'approval' | 'support', def: TrackCurve): string {
  const at = (i: number) => perbill(curve[Math.min(curve.length - 1, i)]?.[key])
  const shape = 'linearDecreasing' in def
    ? `linear, at its floor ${def.linearDecreasing.length >= 1e9 ? 'only at the end' : `from ${perbill(def.linearDecreasing.length, 0)} of the period on`}`
    : 'reciprocal: falls fastest early'
  if (!curve.length) return shape
  return `${at(0)} → ${at(25)} at ¼ → ${at(50)} at ½ → ${at(100)} at the end (${shape})`
}

function periodText(blocks: number, clock: GovernanceClock | null): string {
  const nominal = clock?.nominalMsPerBlock ? blocksToDuration(blocks, clock.nominalMsPerBlock / 1000) : null
  return `${formatCount(blocks)} blocks${nominal ? ` (${nominal})` : ''}`
}

function trackRow(t: GovernanceTrackInfo, clock: GovernanceClock | null): (string | null)[] {
  return [
    `#${t.id} ${userLine(t.name, 80)}`,
    hdx(t.decisionDeposit),
    `${formatCount(t.deciding)}/${formatCount(t.maxDeciding)}`,
    periodText(t.preparePeriod, clock),
    periodText(t.decisionPeriod, clock),
    periodText(t.confirmPeriod, clock),
    periodText(t.minEnactmentPeriod, clock),
    t.passRate == null ? DASH : formatPercent(t.passRate * 100, 1),
  ]
}

function convictionTable(convictions: ConvictionLockInfo[], clock: GovernanceClock | null): string {
  return table(
    ['Conviction', 'Vote weight', 'Lock after a won vote'],
    convictions.map(c => [
      c.name,
      `${(c.multiplierTenths / 10).toString()}×`,
      c.lockBlocks === 0
        ? 'none (the balance is free once the poll ends)'
        : `${c.lockPeriods} period${c.lockPeriods === 1 ? '' : 's'} = ${periodText(c.lockBlocks, clock)}, about ${c.lockDays} days at the measured block pace`,
    ]),
  )
}

const paceNote = (clock: GovernanceClock | null, msPerBlock: number): string | null => {
  if (!clock?.nominalMsPerBlock) return null
  const measured = clock.msPerBlock || msPerBlock
  return note(`Periods are defined in BLOCKS; the durations in brackets use the runtime's nominal ${clock.nominalMsPerBlock / 1000} s slot. Blocks are currently arriving every ${(measured / 1000).toFixed(3)} s, so real time runs about ${formatPercent((measured / clock.nominalMsPerBlock - 1) * 100, 0)} longer — the block height is the commitment, the clock time is not.`)
}

export function renderTracks(d: GovernanceTracks, clock: GovernanceClock | null): string {
  const tracks = d.tracks ?? []
  return joinBlocks(
    h2(`OpenGov tracks (${tracks.length})`),
    table(
      ['Track', 'Decision deposit', 'Deciding / max', 'Prepare', 'Decision', 'Confirm', 'Min enactment', 'Pass rate'],
      tracks.map(t => trackRow(t, clock)),
      'no tracks',
    ),
    h3('Threshold curves (the bar falls over the decision period)'),
    tracks.map(t => `- **#${t.id} ${userLine(t.name, 80)}** — approval: ${curveWords(t.curve, 'approval', t.minApproval)}; support: ${curveWords(t.curve, 'support', t.minSupport)}`).join('\n'),
    h3('Conviction'),
    convictionTable(d.convictions ?? [], clock),
    kv([
      ['Vote-locking period', periodText(d.voteLockingPeriod, clock)],
      ['Undeciding timeout', `${periodText(d.undecidingTimeout, clock)} — a referendum with no decision deposit by then times out`],
      ['Votes per track', `at most ${formatCount(d.maxVotesPerClass)} standing votes per account per track`],
    ]),
    paceNote(clock, d.msPerBlock),
    note('A referendum passes only if BOTH bars hold for the whole confirm period: approval (conviction-weighted aye over aye plus nay) and support (aye plus abstain capital over the electorate, nay excluded). "Deciding / max" is how many of the track\'s decision slots are taken now; a referendum waits in preparation until one is free and its deposit is placed. Pass rate is approved over approved-plus-rejected. Deposits are HDX.'),
  )
}

export function renderTrack(d: GovernanceTrackOne, clock: GovernanceClock | null, base: string): string {
  const t = d.track
  const o = t.outcomes
  return joinBlocks(
    h2(`OpenGov track #${t.id} ${userLine(t.name, 80)}`),
    kv([
      ['Decision deposit', hdx(t.decisionDeposit)],
      ['Decision slots', `${formatCount(t.deciding)} of ${formatCount(t.maxDeciding)} taken`],
      ['Prepare period', periodText(t.preparePeriod, clock)],
      ['Decision period', periodText(t.decisionPeriod, clock)],
      ['Confirm period', periodText(t.confirmPeriod, clock)],
      ['Min enactment', periodText(t.minEnactmentPeriod, clock)],
      ['Approval curve', curveWords(t.curve, 'approval', t.minApproval)],
      ['Support curve', curveWords(t.curve, 'support', t.minSupport)],
      ['Outcomes', `${formatCount(o.approved)} approved, ${formatCount(o.rejected)} rejected, ${formatCount(o.cancelled)} cancelled, ${formatCount(o.timedOut)} timed out, ${formatCount(o.killed)} killed, ${formatCount(o.ongoing)} ongoing`],
      ['Pass rate', t.passRate == null ? 'no decided referendum yet' : `${formatPercent(t.passRate * 100, 1)} (approved over approved plus rejected)`],
    ]),
    h3(`Live on this track (${t.live.length})`),
    table(['Referendum', 'Title (user-authored)', 'Status'], t.live.map(r => [
      explorerLink(`opengov #${r.index}`, referendumUrl(base, 'opengov', r.index)), title(r.title), r.status,
    ]), 'nothing live on this track'),
    h3('Recently concluded'),
    table(['Referendum', 'Title (user-authored)', 'Outcome', 'Concluded'], t.recent.map(r => [
      explorerLink(`opengov #${r.index}`, referendumUrl(base, 'opengov', r.index)), title(r.title), r.status,
      r.concludedAt ? `${formatTime(r.concludedAt.ts)} · ${relativeAge(r.concludedAt.ts)}` : DASH,
    ]), 'none'),
    t.live.length || t.recent.length ? note(USER_TITLES_NOTE) : null,
    h3('Conviction'),
    convictionTable(d.convictions ?? [], clock),
    paceNote(clock, d.msPerBlock),
  )
}

/* ============ calendar ============ */

type CalendarKind = 'prepare-end' | 'timeout' | 'decision-end' | 'confirm-end' | 'concluded' | 'enactment' | 'spend-valid' | 'spend-expire'

export interface CalendarEvent {
  kind: CalendarKind
  at: BlockMoment
  referendum: { index: number; title: string | null; track: { id: number; name: string } | null; status: string } | null
  spend: { index: number; amount: string; assetKind: string | null; beneficiary: string | null } | null
  detail: string | null
}

export interface GovernanceCalendar { from: string; to: string; asOfBlock: number; events: CalendarEvent[] }

const EVENT_WORDS: Record<CalendarKind, string> = {
  'prepare-end': 'preparation ends — deciding can start once a decision slot is free and the deposit is placed',
  timeout: 'times out unless a decision deposit is placed first',
  'decision-end': 'decision period ends — rejected unless it is confirming by then',
  'confirm-end': 'confirmation ends — approved if it stays passing until then',
  concluded: 'concluded',
  enactment: 'enactment',
  'spend-valid': 'treasury spend becomes claimable',
  'spend-expire': 'treasury spend expires if unclaimed',
}

function eventDetail(e: CalendarEvent): string {
  if (e.kind === 'concluded') return (e.detail ?? '').replace(/^Referenda\./, '') || DASH
  if (e.kind === 'enactment') {
    return e.detail === 'dispatched' ? 'dispatched' : e.detail === 'scheduled' ? 'scheduled (not yet dispatched)' : e.detail === 'unavailable' ? 'FAILED — the call was unavailable' : (e.detail ?? DASH)
  }
  if (e.spend) return e.detail ?? DASH
  return e.referendum?.status ?? DASH
}

export function renderCalendar(d: GovernanceCalendar, base: string, opts: { rows: number; days: number }): string {
  const events = d.events ?? []
  const shown = events.slice(0, opts.rows)
  return joinBlocks(
    h2(`Governance calendar — ${formatTime(d.from)} to ${formatTime(d.to)}`),
    table(
      ['When', 'Event', 'Subject', 'Detail'],
      shown.map(e => [
        momentText(e.at),
        EVENT_WORDS[e.kind] ?? e.kind,
        e.referendum
          ? `${explorerLink(`opengov #${e.referendum.index}`, referendumUrl(base, 'opengov', e.referendum.index))} ${title(e.referendum.title, 60)}${e.referendum.track ? ` (${e.referendum.track.name})` : ''}`
          : e.spend ? explorerLink(`Treasury spend #${e.spend.index}`, treasurySpendUrl(base, e.spend.index)) : DASH,
        eventDetail(e),
      ]),
      `nothing on the governance calendar in these ${opts.days} days`,
    ),
    shown.length ? note(USER_TITLES_NOTE) : null,
    shown.length < events.length ? note(`Showing the first ${shown.length} of ${events.length} events to fit this server's text budget; ask for fewer \`days\` to see the rest.`) : null,
    note(`OpenGov only, in block order, as of block ${formatCount(d.asOfBlock)}. A time marked "projected" is estimated from its block height at the current block pace and moves as the pace does; the block height is what the chain commits to. Past events carry their indexed time. A treasury spend's amount and beneficiary are on its page.`),
  )
}

/* ============ one account ============ */

interface GovernanceVoteRow {
  account: string
  cls: number
  trackName: string | null
  poll: number
  referendum: { index: number; title: string | null; status: string } | null
  vote: { kind: string; side: string; conviction: number | null; convictionName: string | null; balance: string; aye: string; nay: string; abstain: string }
  lockedNow: string
  afterEnd: { kind: 'if-wins' | 'won' | 'lost-staker' | 'none' | 'unknown'; amount: string; until: BlockMoment | null; estimate: boolean }
  finished: boolean
  removalForfeitsRewards: boolean
}

interface GovernanceClassRow {
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

interface AccountGovernanceLocks {
  account: string
  locked: string
  unlockableAsIs: string
  unlockableNow: string
  unlockableCollect: string
  openEnded: string
  schedule: { at: BlockMoment; freeable: string }[]
  nextUnlock: { at: BlockMoment; amount: string } | null
  staker: { staking: string; gigahdx: string } | null
  otherLocks?: { id: string; name: string; amount: string }[] | null
  spendableNow?: string | null
  spendableCollect?: string | null
}

interface Delegation { cls: number; trackName: string | null; balance: string; conviction: number; convictionName: string }
interface ProxyRow { account: AccountRef; proxyType: string; delay: number; canVote: boolean }

export interface AccountGovernance {
  account: AccountRef
  related: string[]
  asOfBlock: number | null
  votes: GovernanceVoteRow[]
  classes: GovernanceClassRow[]
  locks: AccountGovernanceLocks[]
  delegations: { in: (Delegation & { from: AccountRef; to: string })[]; out: (Delegation & { from: string; to: AccountRef })[] }
  proxies: { canActFor: ProxyRow[]; actedForBy: ProxyRow[]; pure: { creator: AccountRef; proxyType: string; blockHeight: number } | null }
  history: { referendaVoted: number; lastVote: BlockMoment | null; observedFrom: number }
  forum: { posts: number; comments: number }
  deposits?: AccountDeposits
}

/** /explorer/address/:a/governance `deposits` (governanceDeposits.ts). */
export interface AccountDeposits {
  referenda: { index: number; kind: 'submission' | 'decision'; who: string; amount: string; state: string; status: string }[]
  preimages: { hash: string; owner: string; amount: string; len: number | null; requested: boolean; legacy?: boolean; usedBy: { index: number; status: string }[]; refundable: boolean; blocked: string | null }[] | null
  preimagesAsOfBlock: number | null
  totals: { held: string; refundable: string; kept?: string }
}

const DEPOSIT_STATE: Record<string, string> = {
  held: 'held while the referendum runs',
  refundable: 'refundable now (anyone may sign the refund; it pays the depositor)',
  kept: 'kept by the chain for good (a rejected or timed-out referendum keeps its submission deposit)',
}

function renderDeposits(d: AccountDeposits, base: string, rows: number): string | null {
  const refs = d.referenda ?? []
  const pre = d.preimages ?? []
  if (!refs.length && !pre.length && d.preimages != null) return null
  return joinBlocks(
    h3(`Deposits (${hdx(d.totals?.held)} held, ${hdx(d.totals?.refundable)} refundable now${isPositive(d.totals?.kept) ? `; ${hdx(d.totals?.kept)} more kept by the chain for good` : ''})`),
    refs.length ? table(['Referendum', 'Deposit', 'Amount', 'State'], refs.slice(0, rows).map(r => [
      explorerLink(`opengov #${r.index}`, referendumUrl(base, 'opengov', r.index)), r.kind, hdx(r.amount), DEPOSIT_STATE[r.state] ?? r.state,
    ])) : null,
    pre.length ? table(['Preimage', 'Bytes', 'Deposit', 'Refund'], pre.slice(0, rows).map(p => [
      shortAddress(p.hash), p.len != null ? formatCount(p.len) : DASH, hdx(p.amount),
      p.refundable ? `the owner may unnote it now${p.usedBy.length ? ` (used by ${p.usedBy.map(u => `#${u.index} ${u.status}`).join(', ')})` : ''}` : (p.blocked ?? 'not now'),
    ])) : null,
    d.preimages == null ? note('Preimage deposits are still being read from the chain.') : d.preimagesAsOfBlock ? note(`Preimage deposits as of block ${formatCount(d.preimagesAsOfBlock)}; only the preimage's owner can unnote it.`) : null,
  )
}

export interface NeedsVoteReferendum {
  index: number
  title: string | null
  track: { id: number; name: string } | null
  status: string
  ends: { kind: string; at: BlockMoment } | null
}

export interface NeedsVote {
  asOfBlock: number | null
  referenda: NeedsVoteReferendum[]
  accounts: { input: string; accountId: string | null; needsVote: number[]; voted: unknown[]; delegated: { index: number; cls: number; target: AccountRef }[] }[]
}

function afterEndText(a: GovernanceVoteRow['afterEnd']): string {
  const until = a.until ? `${formatTime(a.until.ts)}${a.until.exact ? '' : ' (projected)'}` : 'a date not yet known'
  switch (a.kind) {
    case 'if-wins': return `if its side wins: ${hdx(a.amount)} locked until ${until}`
    case 'won': return `${hdx(a.amount)} locked until ${until}`
    case 'lost-staker': return `lost; as a staker up to ${hdx(a.amount)} stays locked until ${until}`
    case 'none': return 'nothing once the poll ends'
    default: return 'not known — the poll\'s outcome is not indexed'
  }
}

/**
 * Which of the account's related addresses a row belongs to. The api names them
 * by AccountId32, which is a public key and never printed as a label: the main
 * account needs no name, its EVM twin (the `ETH\0` + H160 mapping) is named by
 * its H160, and any other linked form is named only as such.
 */
function relatedName(id: string, main: AccountRef): string | null {
  if (!id || id.toLowerCase() === main.accountId?.toLowerCase()) return null
  if (/^0x45544800[0-9a-f]{40}0{16}$/i.test(id)) return `EVM ${shortAddress(`0x${id.slice(10, 50)}`)}`
  return 'a linked address'
}

const accountLink = (a: AccountRef, base: string): string =>
  explorerLink(accountLabel(a, { withAddress: true }), accountUrl(base, a.address))

const NEXT_DEADLINE: Record<string, string> = {
  'decision-end': 'decision ends',
  'confirm-end': 'confirmation ends',
  timeout: 'times out without a deposit',
  'prepare-end': 'preparation ends',
}

export function deadlineText(r: NeedsVoteReferendum): string {
  return r.ends ? `${NEXT_DEADLINE[r.ends.kind] ?? r.ends.kind} ${formatTime(r.ends.at.ts)} · ${relativeAge(r.ends.at.ts)}${r.ends.at.exact ? '' : ' (projected)'}` : DASH
}

export function renderAccountGovernance(
  d: AccountGovernance,
  needs: NeedsVote | null,
  base: string,
  opts: { rows: number },
): string {
  const votes = d.votes ?? []
  const live = votes.filter(v => !v.finished)
  const finished = votes.filter(v => v.finished)
  const shownVotes = [...live, ...finished].slice(0, opts.rows)
  const many = (d.related ?? []).length > 1
  const owner = (id: string) => {
    const name = relatedName(id, d.account)
    return name ? ` · ${name}` : ''
  }
  const locks = (d.locks ?? []).filter(l => isPositive(l.locked) || isPositive(l.openEnded) || (l.schedule ?? []).length)
  const delegOut = d.delegations?.out ?? []
  const delegIn = d.delegations?.in ?? []
  const p = d.proxies ?? { canActFor: [], actedForBy: [], pure: null }

  // A track the account never touched carries nothing worth a row.
  const classes = (d.classes ?? []).filter(c => c.votes > 0 || c.prior || c.delegating || isPositive(c.requiredNow) || isPositive(c.delegationsIn?.capital))
  const needsAccount = needs?.accounts?.[0]
  const unvoted = needsAccount
    ? (needs?.referenda ?? []).filter(r => needsAccount.needsVote.includes(r.index))
    : null

  return joinBlocks(
    h2(`Governance of ${accountLabel(d.account, { withAddress: true })}`),
    kv([
      ['Account', accountLink(d.account, base)],
      ['Covers', many ? `${d.related.length} related addresses (the account and its EVM twin or other linked forms); every figure below sums them` : null],
      ['Vote state as of', d.asOfBlock ? `block ${formatCount(d.asOfBlock)}` : null],
      ['Referenda voted on', `${formatCount(d.history?.referendaVoted)}${d.history?.observedFrom ? ` (votes cast through a proxy, multisig or batch are counted from block ${formatCount(d.history.observedFrom)} on)` : ''}`],
      ['Last vote', d.history?.lastVote ? momentText(d.history.lastVote) : 'never'],
      ['Forum', d.forum ? `${formatCount(d.forum.posts)} posts, ${formatCount(d.forum.comments)} comments — read them with get_forum kind 'account'` : null],
    ]),

    unvoted
      ? joinBlocks(
        h3(`Live referenda this account has not voted on (${unvoted.length})`),
        table(['Referendum', 'Title (user-authored)', 'Track', 'Next deadline'], unvoted.map(r => [
          explorerLink(`opengov #${r.index}`, referendumUrl(base, 'opengov', r.index)), title(r.title), r.track?.name ?? DASH, deadlineText(r),
        ]), 'it has voted on (or delegated) every live referendum'),
        needsAccount && needsAccount.delegated.length ? note(`Covered by delegation: ${needsAccount.delegated.map(x => `#${x.index} → ${accountLabel(x.target)}`).join(', ')}.`) : null,
      )
      : null,

    h3(`Standing votes (${votes.length}: ${live.length} on live referenda, ${finished.length} on concluded ones)`),
    table(
      ['Referendum', 'Title (user-authored)', 'Track', 'Vote', 'Balance', 'Lock after the poll'],
      shownVotes.map(v => [
        explorerLink(`opengov #${v.poll}`, referendumUrl(base, 'opengov', v.poll)),
        `${title(v.referendum?.title, 50)} (${v.referendum?.status ?? 'status unknown'})`,
        `${v.trackName ?? `#${v.cls}`}${owner(v.account)}`,
        v.vote.kind === 'Standard'
          ? `${v.vote.side} ${v.vote.convictionName ?? ''}`.trim()
          : `${v.vote.kind}: aye ${hdx(v.vote.aye)} / nay ${hdx(v.vote.nay)}${isPositive(v.vote.abstain) ? ` / abstain ${hdx(v.vote.abstain)}` : ''}`,
        hdx(v.vote.balance),
        afterEndText(v.afterEnd),
      ]),
      'no standing votes',
    ),
    shownVotes.length < votes.length ? note(`Showing ${shownVotes.length} of ${votes.length} votes (live first) to fit this server's text budget.`) : null,
    votes.length ? note('A standing vote locks its balance while the poll runs. Removing a vote on a LIVE referendum forfeits the staking/GIGAHDX rewards it would earn; a vote on a concluded one can be removed freely once its lock has passed. Balances are the capital voted; conviction multiplies weight, not the lock amount.') : null,

    locks.length
      ? joinBlocks(
        h3('Vote locks and unlocking'),
        ...locks.map(l => kv([
          ['Address', relatedName(l.account, d.account)],
          ['Conviction lock now', hdx(l.locked)],
          ['Vote lock released by `unlock` alone', hdx(l.unlockableAsIs)],
          ['Vote lock released after removing expired concluded votes, then unlock', hdx(l.unlockableNow)],
          ['Vote lock released after removing EVERY concluded vote (collects rewards), then unlock', hdx(l.unlockableCollect)],
          ['Other locks on the same HDX', l.otherLocks?.length ? l.otherLocks.map(o => `${o.name} ${hdx(o.amount)}`).join(', ') : null],
          ['Made spendable now (net of the other locks — Balances freezes the largest lock)', l.spendableNow != null ? hdx(l.spendableNow) : null],
          ['Held open-endedly by live votes and delegations', isPositive(l.openEnded) ? `${hdx(l.openEnded)} — no date until those polls end or the delegation is undone` : null],
          ['Next unlock', l.nextUnlock ? `${hdx(l.nextUnlock.amount)} more at ${momentText(l.nextUnlock.at)}` : null],
          ['Schedule', (l.schedule ?? []).length ? l.schedule.slice(0, 5).map(s => `${hdx(s.freeable)} freeable from ${formatTime(s.at.ts)}${s.at.exact ? '' : ' (projected)'}`).join('; ') : null],
          ['Staked', l.staker ? `staking ${hdx(l.staker.staking)}, GIGAHDX ${hdx(l.staker.gigahdx)} — a lost vote still locks the staked part` : null],
        ])),
        note('Unlock figures are estimates computed from indexed state; the explorer dry-runs the actual unlock before anyone signs it.'),
      )
      : null,

    classes.length
      ? joinBlocks(
        h3('Per track'),
        table(['Track', 'Mode', 'Votes', 'Prior lock', 'Locked now', 'Delegated to it'], classes.map(c => [
          `${c.trackName ?? `#${c.cls}`}${owner(c.account)}`,
          c.kind === 'delegating' && c.delegating ? `delegating to ${accountLabel(c.delegating.target)}` : 'voting directly',
          c.kind === 'casting' ? `${c.votes}/${c.maxVotes}` : DASH,
          c.prior ? `${hdx(c.prior.amount)} ${c.prior.expired ? '(expired — unlockable)' : `until ${c.prior.until ? `${formatTime(c.prior.until.ts)}${c.prior.until.exact ? '' : ' (projected)'}` : 'unknown'}`}` : DASH,
          hdx(c.requiredNow),
          isPositive(c.delegationsIn?.capital) ? `${hdx(c.delegationsIn.capital)} capital (${hdx(c.delegationsIn.votes)} votes)` : DASH,
        ])),
        note('"Prior lock" is what an already-removed vote or an undone delegation still locks; it frees on its date by `unlock` alone.'),
      )
      : null,

    delegOut.length
      ? joinBlocks(h3(`Delegating out (${delegOut.length})`), table(['Track', 'To', 'Balance', 'Conviction'], delegOut.slice(0, opts.rows).map(x => [
        `${x.trackName ?? `#${x.cls}`}${owner(x.from)}`, accountLink(x.to, base), hdx(x.balance), x.convictionName,
      ])))
      : null,
    delegIn.length
      ? joinBlocks(
        h3(`Delegated to this account (${delegIn.length})`),
        table(['Track', 'From', 'Balance', 'Conviction'], delegIn.slice(0, opts.rows).map(x => [
          x.trackName ?? `#${x.cls}`, accountLink(x.from, base), hdx(x.balance), x.convictionName,
        ])),
        delegIn.length > opts.rows ? note(`Showing ${opts.rows} of ${delegIn.length} delegators.`) : null,
      )
      : null,

    p.canActFor.length || p.actedForBy.length || p.pure
      ? joinBlocks(h3('Proxies'), kv([
        ['Can act for', p.canActFor.length ? p.canActFor.map(x => `${accountLabel(x.account)} (${x.proxyType}${x.delay ? `, delay ${formatCount(x.delay)} blocks` : ''}${x.canVote ? ', can vote' : ''})`).join('; ') : null],
        ['Can be acted for by', p.actedForBy.length ? p.actedForBy.map(x => `${accountLabel(x.account)} (${x.proxyType}${x.delay ? `, delay ${formatCount(x.delay)} blocks` : ''}${x.canVote ? ', can vote' : ''})`).join('; ') : null],
        ['Pure proxy', p.pure ? `created by ${accountLabel(p.pure.creator)} (${p.pure.proxyType}) at block ${formatCount(p.pure.blockHeight)}` : null],
      ]), note('"can vote" means an Any or Governance proxy with no delay — the proxy types the runtime lets vote.'))
      : null,

    d.deposits ? renderDeposits(d.deposits, base, opts.rows) : null,

    note('Vote locks are HDX. A delegation votes on every referendum of its track with the delegated balance and conviction.'),
  )
}

/* ============ treasury ============ */

export interface TreasuryOverview {
  account: AccountRef
  asOfBlock: number
  pot: { free: string; block: number } | null
  potHistory: { week: string; balance: string }[]
  totals: { paidOut: string; spendsPaid: number; awarded: string; proposalsAwarded: number; claimable: number; pending: number }
  spends: {
    index: number; amount: string; beneficiary: AccountRef | null; state: string; canPayout: boolean; canCheckStatus: boolean
    validFrom: BlockMoment | null; expireAt: BlockMoment | null; paidAt: { timestamp: string } | null
    referendum: { index: number; title: string | null } | null
  }[]
  proposals: { index: number; amount: string | null; beneficiary: AccountRef | null; origin: string; state: string; awardedAt: { timestamp: string } | null; referendum: { index: number; title: string | null } | null }[]
}

const SPEND_STATE: Record<string, string> = {
  pending: 'not claimable yet', claimable: 'claimable now', paid: 'paid', failed: 'payment failed (can be paid out again)', expired: 'expired unclaimed', voided: 'voided',
}

export function renderTreasury(d: TreasuryOverview, base: string, rows: number): string {
  const year = d.potHistory?.length ? d.potHistory[Math.max(0, d.potHistory.length - 53)] : null
  return joinBlocks(
    h2('Treasury'),
    kv([
      ['Account', accountLink(d.account, base)],
      ['Pot (free HDX)', d.pot ? `${hdx(d.pot.free)} at block ${formatCount(d.pot.block)}` : 'not indexed'],
      ['A year ago', year ? `${hdx(year.balance)} (week of ${year.week})` : null],
      ['Paid by spends', `${hdx(d.totals.paidOut)} over ${formatCount(d.totals.spendsPaid)} spends`],
      ['Paid at the spend period', `${hdx(d.totals.awarded)} over ${formatCount(d.totals.proposalsAwarded)} proposals`],
      ['Claimable now', formatCount(d.totals.claimable)],
    ]),
    h3('Spends (treasury.spend)'),
    table(['Spend', 'Beneficiary', 'Amount', 'State', 'Window', 'Approved by (title user-authored)'], (d.spends ?? []).slice(0, rows).map(s => [
      explorerLink(`#${s.index}`, treasurySpendUrl(base, s.index)),
      s.beneficiary ? accountLink(s.beneficiary, base) : DASH,
      hdx(s.amount),
      `${SPEND_STATE[s.state] ?? s.state}${s.canCheckStatus ? '; check_status would clear it' : ''}`,
      s.paidAt ? `paid ${formatTime(s.paidAt.timestamp)}` : `${s.validFrom ? `from ${formatTime(s.validFrom.ts)}` : ''}${s.expireAt ? ` until ${formatTime(s.expireAt.ts)}${s.expireAt.exact ? '' : ' (projected)'}` : ''}`,
      s.referendum ? `${explorerLink(`opengov #${s.referendum.index}`, referendumUrl(base, 'opengov', s.referendum.index))} ${title(s.referendum.title, 40)}` : DASH,
    ]), 'no spends'),
    h3('Paid at the spend period (spend_local and pre-OpenGov proposals)'),
    table(['Proposal', 'Beneficiary', 'Amount', 'State'], (d.proposals ?? []).slice(0, rows).map(p => [
      `#${p.index}${p.referendum ? ` (opengov #${p.referendum.index})` : ''}`, p.beneficiary ? accountLink(p.beneficiary, base) : DASH, p.amount ? hdx(p.amount) : DASH, p.state,
    ]), 'none'),
    note('The treasury pays HDX only. Anyone may sign payout(index) inside a spend\'s window and check_status(index) once it is paid or expired; the treasury pays the beneficiary, never the signer.'),
  )
}

/* ============ tally trajectory ============ */

export interface TallyHistory {
  points: { block: number; ts: string | null; ayes: string; nays: string; support: string; approval: number | null }[]
  chain: { ayes: string; nays: string; support: string | null; source: 'final' | 'live'; block: number | null } | null
  residual: { ayes: string; nays: string; support: string | null } | null
  residualShare: number | null
  trajectoryReliable: boolean
  reason: string | null
  delegationsAttributed: boolean
  electorate: string | null
  periodsApproximate: boolean
  projection: { state: string; confirmableAtBlock: number | null } | null
}

const TRAJECTORY_POINTS = 6

/** A handful of points spread over the trajectory, always keeping the first and the last. */
export function samplePoints<T>(points: T[], n = TRAJECTORY_POINTS): T[] {
  if (points.length <= n) return points
  const out: T[] = []
  for (let i = 0; i < n; i += 1) out.push(points[Math.round((i * (points.length - 1)) / (n - 1))])
  return out
}

export function renderTrajectory(h: TallyHistory, clock: GovernanceClock | null): string {
  const points = h.points ?? []
  const sampled = samplePoints(points)
  const anchor = h.chain
    ? `the chain's own ${h.chain.source === 'final' ? 'final tally (from the concluding event)' : 'live tally (storage read)'}${h.chain.block ? ` at block ${formatCount(h.chain.block)}` : ''}: aye ${hdx(h.chain.ayes)}, nay ${hdx(h.chain.nays)}${h.chain.support ? `, support ${hdx(h.chain.support)}` : ''}`
    : 'nothing — no chain tally is available for this referendum, so the points below are the indexed votes alone'
  const confirmAt = h.projection?.confirmableAtBlock
  const eta = confirmAt && clock?.headBlock && clock.msPerBlock && confirmAt > clock.headBlock
    ? ` (about ${formatDuration(((confirmAt - clock.headBlock) * clock.msPerBlock) / 1000)} from now at the current pace)`
    : ''
  return joinBlocks(
    h3('Tally trajectory (reconstructed)'),
    h.trajectoryReliable && sampled.length
      ? table(['Block', 'Time', 'Aye (weighted)', 'Nay (weighted)', 'Support', 'Approval'], sampled.map(pt => [
        formatCount(pt.block), pt.ts ? formatTime(pt.ts) : DASH, hdx(pt.ayes), hdx(pt.nays), hdx(pt.support), perbill(pt.approval, 2),
      ]))
      : note(h.trajectoryReliable ? 'No vote has moved the tally yet.' : `The trajectory is withheld: ${h.reason ?? 'the reconstruction does not match the chain closely enough'}. The explorer does not draw it either; quote only the chain anchor below.`),
    kv([
      ['Points', h.trajectoryReliable && points.length ? `${sampled.length} of ${formatCount(points.length)} tally changes shown, first and last included` : null],
      ['Anchored to', anchor],
      ['Residual (chain minus reconstruction)', h.residual ? `aye ${hdx(h.residual.ayes)}, nay ${hdx(h.residual.nays)}${h.residual.support != null ? `, support ${hdx(h.residual.support)}` : ''}${h.residualShare != null ? ` — ${formatPercent(h.residualShare * 100, 2)} of turnout` : ''}` : null],
      ['Delegated power', h.delegationsAttributed ? 'attributed to the delegates\' points' : 'NOT attributed — before block 15,622,703 delegated power stays in the residual'],
      ['Projection', h.projection ? `${h.projection.state}${confirmAt ? `, confirmable at block ${formatCount(confirmAt)}${eta}` : ''}` : null],
      ['Periods', h.periodsApproximate ? 'approximate — the decision ran across a change of the block-time constants' : null],
    ]),
    note('The points are RECONSTRUCTED by replaying the indexed votes; only the anchor is read from the chain. The residual is the gap at the last point and is stated, never smoothed into the points — above 0.5% of turnout the trajectory is withheld.'),
  )
}
