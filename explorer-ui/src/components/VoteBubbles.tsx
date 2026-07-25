import { useMemo, useState } from 'react'
import type { ReferendumVoter } from '../types'
import { HEIGHT, WIDTH, pack, type Bubble } from './voteBubbleLayout'
import { F } from './ui'

// Conviction-weighted vote power as a bubble map.
//
// Hand-rolled SVG, like every other chart in this app (the sparkline, the daily
// histogram, the portfolio chart) — a packed-circle layout needs no library.
//
// AREA encodes power, not radius: a 6x-conviction whale outweighs a small voter by
// several orders of magnitude, and scaling the radius linearly would make everyone
// else a dot. Aye and Nay are laid out as two opposed clusters so the balance of the
// vote is legible at a glance.
export function VoteBubbles({ voters, decimals, symbol }: { voters: ReferendumVoter[]; decimals: number; symbol: string }) {
  const [hover, setHover] = useState<Bubble | null>(null)

  const bubbles = useMemo(() => {
    // Withdrawn votes back nothing, so they are not drawn — the tally excludes them too.
    const live = voters.filter(voter => !voter.removed)
    const weights = live.flatMap(voter => [Number(voter.weightedAye), Number(voter.weightedNay)])
    const maxWeight = Math.max(1, ...weights)
    // Largest first: big circles claim the centre, small ones fill around them.
    const byWeight = (pick: (v: ReferendumVoter) => string) =>
      [...live].sort((a, b) => Number(pick(b)) - Number(pick(a)))
    return [
      ...pack(byWeight(v => v.weightedAye), 'aye', maxWeight, WIDTH * 0.28),
      ...pack(byWeight(v => v.weightedNay), 'nay', maxWeight, WIDTH * 0.74),
    ]
  }, [voters])

  if (!bubbles.length) return <div className="empty-note">No conviction-weighted votes to plot</div>

  const power = (bubble: Bubble) => (bubble.side === 'aye' ? bubble.voter.weightedAye : bubble.voter.weightedNay)

  return (
    <div className="vote-bubbles">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Conviction-weighted votes by account">
        <text x={WIDTH * 0.28} y={16} className="vb-axis" textAnchor="middle">AYE</text>
        <text x={WIDTH * 0.74} y={16} className="vb-axis" textAnchor="middle">NAY</text>
        {bubbles.map(bubble => (
          <circle
            key={`${bubble.side}-${bubble.voter.blockHeight}-${bubble.voter.eventIndex}`}
            cx={bubble.x} cy={bubble.y} r={bubble.r}
            className={`vb-bubble vb-${bubble.side}${hover === bubble ? ' on' : ''}`}
            onMouseEnter={() => setHover(bubble)}
            onMouseLeave={() => setHover(current => (current === bubble ? null : current))}
          />
        ))}
      </svg>
      <div className="vb-legend">
        {hover ? (
          <>
            <span className="mono">{hover.voter.account?.address ? `${hover.voter.account.address.slice(0, 6)}…${hover.voter.account.address.slice(-5)}` : 'unknown'}</span>
            {' · '}<span className={hover.side === 'aye' ? 'vb-aye-text' : 'vb-nay-text'}>{hover.side.toUpperCase()}</span>
            {hover.voter.conviction ? <> · {hover.voter.conviction}</> : null}
            {' · '}<span className="mono">{F.amount(power(hover), decimals)} {symbol}</span>
            <span className="muted"> weighted from {F.amount(hover.voter.balance, decimals)}</span>
          </>
        ) : (
          <span className="muted">Area is conviction-weighted voting power · hover a bubble for the account</span>
        )}
      </div>
    </div>
  )
}
