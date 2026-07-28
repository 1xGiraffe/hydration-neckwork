import { memo, useMemo } from 'react'
import { Link, paths } from '../router'
import type { ReferendumVoter } from '../types'
import { HEIGHT, WIDTH, packVoters } from './voteBubbleLayout'
import { voteSideLabel } from '../utils/voteRows'
import { AccountEmoji, F, ShortAddr, TagIcon, moduleName } from './ui'
import { resolveTag, useTagMapVersion } from '../userTags'
import type { AccountRef } from '../types'

// Conviction-weighted vote power as ONE bubble map, aye and nay in the same cluster
// so the balance of the vote reads as a colour mix rather than two charts to compare.
//
// Laid out in plain HTML rather than SVG on purpose: each bubble is an `.addr-pill`
// anchor to its account, so it inherits the app's global hover card and click-through
// for free, and the emoji and shortened address render with the very same components
// every table uses. Positions come from voteBubbleLayout in a fixed 720x340 space and
// are converted to percentages, so the chart scales with its container.
// A bubble's label follows the very same precedence AddrPill uses in every list —
// priority-resolved tag, then module account, then self-set profile name, then
// on-chain identity, then shortened address — so an account reads identically
// here and in the tables. AddrPill itself cannot be nested inside the bubble (it
// carries its own link and copy button, and an anchor inside an anchor is
// invalid), so its content is mirrored with the same components and classes.
function BubbleLabel({ account, label }: { account: AccountRef | null; label: 'full' | 'emoji' | 'none' }) {
  if (!account || label === 'none') return null
  const resolved = resolveTag(account)
  const mod = moduleName(account.accountId)
  const identity = account.identity
  const profile = account.profile
  const icon = resolved
    ? <TagIcon icon={resolved.icon} title={resolved.name} className="vb-emoji" />
    : mod ? <span className="vb-emoji">⚙️</span>
      : <AccountEmoji account={account} className="vb-emoji" imgClass="vb-emoji-img" title="identity" />
  if (label === 'emoji') return icon
  // No `·xyz` member-disambiguation suffix here (unlike AddrPill/ExternalAccountPill):
  // a bubble's label is already clamped to a handful of characters at a few px tall,
  // with no room for a tag name AND a tail.
  const name = resolved
    ? <span className="vb-addr vb-name" style={resolved.color ? { color: resolved.color } : undefined}>{resolved.name}</span>
    : mod ? <span className="vb-addr vb-name">{mod}</span>
      : profile?.name
        ? <span className="vb-addr vb-name profile-name">{profile.name}</span>
        : identity?.display
          ? <span className="vb-addr vb-name">{identity.display}{identity.verified && <span className="id-verified" title="Verified identity">✓</span>}</span>
          : <span className="vb-addr mono"><ShortAddr addr={account.address} /></span>
  return <>{icon}{name}</>
}

// Memoised: the chart is ~900 nodes and depends only on the vote set, but the page
// around it re-renders on the shared 1 Hz clock and on every sort/side chip, and
// each of those re-reconciled the whole cluster for nothing.
export const VoteBubbles = memo(function VoteBubbles({ voters, decimals, symbol }: { voters: ReferendumVoter[]; decimals: number; symbol: string }) {
  useTagMapVersion()   // re-render when the viewer's tag map changes (memo() only skips parent-driven re-renders)
  const bubbles = useMemo(() => packVoters(voters), [voters])

  if (!bubbles.length) return <div className="empty-note">No conviction-weighted votes to plot</div>

  return (
    <div className="vote-bubbles">
      <div className="vb-canvas" style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}>
        {bubbles.map(bubble => {
          const account = bubble.voter.account
          const key = `${bubble.voter.blockHeight}-${bubble.voter.eventIndex}`
          const body = <BubbleLabel account={account} label={bubble.label} />
          const common = {
            // addr-pill is what the global hover card hooks on, so a bubble shows the
            // same account card as any pill in a table (HoverCard.tsx SELECTOR). The
            // vote itself rides along in data attributes, so that card can add this
            // account's side, conviction and weighted power to its own rows.
            //
            // The COLOUR follows where the power landed (bubbleSide, from the weighted
            // legs) because that is what the cluster's colour mix reads as; the WORD is
            // the side actually cast, through the same mapping the votes table below
            // badges it with, so a card and a row never disagree about one vote.
            className: `vb-bubble addr-pill vb-${bubble.side}`,
            data: {
              'data-vote-side': voteSideLabel(bubble.voter.side),
              'data-vote-conviction': bubble.voter.conviction ?? '',
              'data-vote-weighted': `${F.amount(bubble.voter.weighted, decimals)} ${symbol}`,
            },
            style: {
              left: `${(bubble.x / WIDTH) * 100}%`,
              top: `${(bubble.y / HEIGHT) * 100}%`,
              width: `${(bubble.r * 2 / WIDTH) * 100}%`,
            },
          }
          // An unattributable vote (no account id) is still plotted, just not linkable.
          return account
            ? <Link key={key} to={paths.account(account.address)} {...common}>{body}</Link>
            : <span key={key} {...{ ...common, data: undefined }} {...common.data}>{body}</span>
        })}
      </div>
    </div>
  )
})
