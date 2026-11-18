import { openVote, toggleCart, useCart } from '../../vote/voteBus'
import type { Direction } from '../../vote/voteBus'

// The one place a "Vote" action enters the UI, on the referendum page, its phone
// bar and the "needs your vote" rows. The button opens the vote composer (a sheet
// that loads with the voting code on first use); with `quick`, a row also gets
// Aye / Nay / Abstain toggles that put the referendum in the vote cart, so several
// can be signed at once.
//
// Callers pass what the composer needs to open on the right referendum and, when
// one of the reader's accounts has voted, that position, so the button reads
// "Change vote".

export interface VoteEntryProps {
  pallet: 'opengov' | 'democracy'
  index: number
  /** Voting is open (preparing, deciding or confirming). */
  open: boolean
  /** The reader's standing vote on it, when one of their accounts has voted. */
  current?: { side: string; conviction: string | null } | null
  title?: string | null
  track?: number | null
  compact?: boolean
  /** Show the Aye/Nay/Abstain cart toggles. */
  quick?: boolean
}

const QUICK: { id: Direction; label: string }[] = [
  { id: 'aye', label: 'Aye' },
  { id: 'nay', label: 'Nay' },
  { id: 'abstain', label: 'Abstain' },
]

export function VoteEntry({ pallet, index, open, current, title, track, compact, quick }: VoteEntryProps) {
  const cart = useCart()
  if (!open || pallet !== 'opengov') return null
  const inCart = cart.find(c => c.index === index)
  return (
    <div className={`gov-vote-entry${compact ? ' compact' : ''}`}>
      {quick && (
        <div className="gov-quick" role="group" aria-label={`Add #${index} to the vote cart`}>
          {QUICK.map(q => (
            <button key={q.id} type="button" aria-pressed={inCart?.direction === q.id} className={`gov-quick-btn ${q.id}${inCart?.direction === q.id ? ' on' : ''}`}
              title={inCart?.direction === q.id ? `Take #${index} out of the cart` : `Put ${q.label} on #${index} in the vote cart`}
              onClick={() => toggleCart({ index, title: title ?? null, track: track ?? null, direction: q.id })}>
              {q.label}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="gov-vote-btn" onClick={() => openVote({ kind: 'composer', target: { index, title: title ?? null, track: track ?? null, intent: current ? 'change' : 'vote' } })}>
        {current ? 'Change vote' : 'Vote'}
      </button>
    </div>
  )
}
