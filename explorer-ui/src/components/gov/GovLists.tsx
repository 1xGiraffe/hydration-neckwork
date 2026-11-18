import { useState, type FormEvent } from 'react'
import { Link, paths } from '../../router'
import { waitingForSnapshot } from '../../hooks/useGovernance'
import { GOV_WATCH_MAX, setWatchedAccounts, useWatchedAccounts } from '../../governanceAccounts'
import { forumPostLabel, forumPostPath } from '../../governanceSubjects'
import type { DiscussionRow, NeedsVoteReferendum } from '../../governanceTypes'
import { ForumAuthorName, GovPopover, MomentText, NotReady, forumLabelText, relativeTime, trackLabel } from './GovUi'
import { useReaderVotes } from './readerVotes'
import { InfoTip } from './Disclosure'
import { F } from '../ui'
import { openVote, toggleCart, useCart, type Direction } from '../../vote/voteBus'

// The lists the hub and "my governance" share: a discussion row, the referenda a
// reader's accounts still need to vote on (and the `Vote ▾` control they carry), the
// deadlines ahead, and the small form that adds an address to follow.

/** The author as one plain word for a compact meta line (their name, else the short address). */
function authorText(row: DiscussionRow): string {
  const a = row.author
  if (!a) return 'deleted'
  if (a.account) return a.account.identity?.display ?? a.account.profile?.name ?? F.shortAddr(a.account.address)
  return a.legacyName || 'unknown'
}

export function DiscussionItem({ row, now, compact }: { row: DiscussionRow; now: number; compact?: boolean }) {
  // An id with no page of its own is listed without a link rather than sent to a 404.
  const to = forumPostPath(row.postId)
  const title = to ? <Link to={to} className="gov-disc-title">{row.title || 'Untitled'}</Link> : <span className="gov-disc-title">{row.title || 'Untitled'}</span>
  // The overview's short list: title and one meta line; the excerpt stays on /discussions.
  if (compact) {
    return (
      <li className="gov-disc compact">
        {title}
        <div className="gov-disc-meta">
          <span>{authorText(row)}</span>
          <span title={row.lastActivityAt}>active {relativeTime(row.lastActivityAt, now)}</span>
          <span>💬 {row.commentsCount} {row.commentsCount === 1 ? 'comment' : 'comments'}</span>
        </div>
      </li>
    )
  }
  return (
    <li className="gov-disc">
      {title}
      {row.excerpt && <p className="gov-disc-excerpt">{row.excerpt}</p>}
      <div className="gov-disc-meta">
        <ForumAuthorName author={row.author} />
        <span className="muted" title={row.lastActivityAt}>active {relativeTime(row.lastActivityAt, now)}</span>
        <span className="gov-disc-stat" aria-label={`${row.commentsCount} comments`}>💬 {row.commentsCount}</span>
        {row.labels.map(l => <span key={l} className="gov-label">{forumLabelText(l)}</span>)}
        {row.linked.slice(0, 2).map(id => {
          const path = forumPostPath(id)
          return path ? <Link key={id} to={path} className="gov-linked">{forumPostLabel(id)}</Link> : null
        })}
        {row.hasPoll && <span className="gov-label">poll</span>}
      </div>
    </li>
  )
}

const DEADLINE_WORD: Record<string, string> = {
  'decision-end': 'closes',
  'confirm-end': 'confirms',
  timeout: 'times out without a deposit',
  'prepare-end': 'decision can start',
}

export function DeadlineList({ rows, now, empty }: { rows: NeedsVoteReferendum[]; now: number; empty: string }) {
  if (!rows.length) return <p className="gov-empty">{empty}</p>
  return (
    <ul className="gov-deadlines">
      {rows.map(r => (
        <li key={r.index}>
          <Link to={paths.referendum('opengov', r.index)} className="gov-deadline-title"><span className="mono muted">#{r.index}</span> {r.title ?? `Referendum #${r.index}`}</Link>
          <div className="gov-deadline-meta">
            {r.track && <span>{trackLabel(r.track.name)}</span>}
            {r.ends && <span>{DEADLINE_WORD[r.ends.kind] ?? r.ends.kind} <MomentText at={r.ends.at} now={now} relative /></span>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Add or remove an address to follow (watch-only, this device). */
export function WatchAccountsForm({ compact, idSuffix = '' }: { compact?: boolean; idSuffix?: string }) {
  const watched = useWatchedAccounts()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const v = value.trim()
    const invalid = 'That does not look like a Hydration, Polkadot or EVM address.'
    if (!/^([1-9A-HJ-NP-Za-km-z]{46,48}|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$/.test(v)) { setError(invalid); return }
    if (watched.length >= GOV_WATCH_MAX) { setError(`You can follow up to ${GOV_WATCH_MAX} addresses.`); return }
    // Kept in the explorer's format (Polkadot SS58, or the H160), whatever prefix was pasted.
    const { toPolkadotAddress } = await import('../../ss58')
    const address = /^0x[0-9a-fA-F]{40}$/.test(v) ? v : toPolkadotAddress(v)
    if (!address) { setError(invalid); return }
    setWatchedAccounts([...watched, address])
    setValue('')
    setError(null)
  }
  return (
    <div className={`gov-watch${compact ? ' compact' : ''}`}>
      <form onSubmit={e => void submit(e)} className="gov-watch-form">
        <label htmlFor={`gov-watch-input${idSuffix}`} className="sr-only">Address to follow</label>
        <input id={`gov-watch-input${idSuffix}`} value={value} onChange={e => setValue(e.target.value)} placeholder="Paste an address to follow" autoComplete="off" spellCheck={false} />
        <button type="submit" className="gov-btn">Follow</button>
        {!compact && <InfoTip label="About followed addresses">Followed addresses stay on this device. Nothing is signed or shared; this only reads what the chain already shows.</InfoTip>}
      </form>
      {error && <p className="gov-form-error" role="alert">{error}</p>}
      {!compact && watched.length > 0 && (
        <ul className="gov-watch-list">
          {watched.map(a => (
            <li key={a}>
              <Link to={paths.account(a)} className="hash mono">{a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a}</Link>
              <button type="button" className="link-btn" onClick={() => setWatchedAccounts(watched.filter(w => w !== a))} aria-label={`Stop following ${a}`}>remove</button>
            </li>
          ))}
        </ul>
      )}
      {compact && <p className="gov-fineprint">Followed addresses stay on this device. Nothing is signed or shared; this only reads what the chain already shows.</p>}
    </div>
  )
}

const Chevron = () => <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>

const QUICK: { id: Direction; label: string }[] = [{ id: 'aye', label: 'Aye' }, { id: 'nay', label: 'Nay' }, { id: 'abstain', label: 'Abstain' }]

/**
 * `Vote ▾`: the button opens the composer; with `quick`, the ▾ holds the Aye / Nay /
 * Abstain choices that put the referendum in the vote cart, so several can be signed at once.
 * It is shown only where one of the reader's accounts still has to vote, and always in
 * the vote lavender: every such referendum asks the same of the reader, so none is
 * marked out over another (a referendum already voted on shows how, in words, instead).
 */
export function VoteSplit({ index, title, track, quick }: { index: number; title: string | null; track: number | null; quick?: boolean }) {
  const cart = useCart()
  const inCart = cart.find(c => c.index === index)
  const open = () => openVote({ kind: 'composer', target: { index, title, track } })
  return (
    <span className={`gov-split${quick ? ' has-menu' : ''}`}>
      {inCart && <span className="gov-split-cart">{QUICK.find(x => x.id === inCart.direction)?.label} in cart</span>}
      <button type="button" className="gov-btn gov-btn-primary gov-split-main" onClick={open}>Vote</button>
      {quick && (
        <GovPopover label={`Add #${index} to the vote cart`} icon={<Chevron />} buttonClass="gov-btn gov-btn-primary gov-split-more" className="gov-split-pop">
          <div className="gov-split-menu">
            {QUICK.map(x => {
              const on = inCart?.direction === x.id
              return (
                <button key={x.id} type="button" aria-pressed={on} className={`gov-split-item ${x.id}${on ? ' on' : ''}`} onClick={() => toggleCart({ index, title, track, direction: x.id })}>
                  {on ? `Take ${x.label} out of the cart` : `Add ${x.label} to cart`}
                </button>
              )
            })}
          </div>
        </GovPopover>
      )}
    </span>
  )
}

/**
 * "Needs your vote" on /governance/me: one line per live referendum the accounts in
 * view have not all voted on, soonest deadline first, each with `Vote ▾`. Renders
 * nothing when there is nothing to vote on (the page's ribbon says so).
 */
export function NeedsYourVote({ now, only, onShowAll }: { now: number; only?: string[] | null; onShowAll?: () => void }) {
  const r = useReaderVotes(only)
  // Narrowed to some accounts, the referenda only the others still need are said, not
  // dropped: the menu's count covers every account.
  const all = useReaderVotes(null)
  const elsewhere = only ? all.rows.filter(row => !r.missing.has(row.index)).length : 0
  if (!r.mine.length) return null
  if (waitingForSnapshot(r.q)) return <NotReady what="vote state" />
  if (r.q.isLoading) return <div className="skeleton gov-needs-sk" aria-hidden="true" />
  if (!r.q.data) return <p className="gov-empty">Your votes could not be checked right now.</p>
  const others = elsewhere > 0 && (
    <p className="gov-fineprint gov-needs-elsewhere">
      {elsewhere} more {elsewhere === 1 ? 'referendum needs' : 'referenda need'} a vote from your other accounts.
      {onShowAll && <>{' '}<button type="button" className="link-btn" onClick={onShowAll}>Show all accounts</button></>}
    </p>
  )
  if (!r.rows.length) return others || null
  const n = r.known.length
  return (
    <section className="gov-section gov-needs" aria-labelledby="needs-vote">
      <h2 id="needs-vote" className="gov-h2">Needs your vote <span className="gov-count">{r.rows.length}</span></h2>
      {others}
      <ul className="gov-needs-list">
        {r.rows.map(row => (
          <li key={row.index} className="gov-needs-row">
            <Link to={paths.referendum('opengov', row.index)} className="gov-needs-title"><span className="mono muted">#{row.index}</span> {row.title ?? `Referendum #${row.index}`}</Link>
            <span className="gov-needs-meta">
              {n > 1 && <>{r.missing.get(row.index)} of {n} accounts · </>}
              {row.ends ? <>{DEADLINE_WORD[row.ends.kind] ?? row.ends.kind} <MomentText at={row.ends.at} now={now} relative /></> : trackLabel(row.track?.name)}
            </span>
            <VoteSplit index={row.index} title={row.title} track={row.track?.id ?? null} quick={r.hasVoted} />
          </li>
        ))}
      </ul>
      {r.q.data.accounts.some(a => a.delegated.length > 0) && <p className="gov-fineprint">Some of these accounts delegate their vote on a track; those referenda count as voted.</p>}
    </section>
  )
}
