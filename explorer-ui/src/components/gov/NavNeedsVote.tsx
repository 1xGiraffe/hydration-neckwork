import { useStillToVoteCount } from './readerVotes'

// The count beside "My governance" in the Governance menu: the live referenda at
// least one of the reader's accounts (signed in, connected wallets, followed
// addresses) still has to vote on — the same reckoning, and so the same number, as
// the "Needs your vote" list on /governance/me. Nothing shows while it is unknown or
// zero. Loaded as its own chunk by the top bar, only once the reader opens the menu
// or is on a governance page, so other pages carry no wallet code.

export function NavNeedsVote() {
  const n = useStillToVoteCount()
  if (!n) return null
  const text = `${n} ${n === 1 ? 'referendum needs' : 'referenda need'} your vote`
  return <span className="nav-count" aria-label={text} title={text}>{n}</span>
}
