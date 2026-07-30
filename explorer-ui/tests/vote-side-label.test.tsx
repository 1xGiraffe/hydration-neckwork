import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { voteSideLabel } from '../src/utils/voteRows'
import { VoteSideBadge, ACTIVITY_ACTIONS } from '../src/components/ui'
import { VoteBubbles } from '../src/components/VoteBubbles'
import type { ReferendumVoter } from '../src/types'

// Every surface that shows a vote side goes through one mapping, so nothing can leak a
// raw AccountVote variant name (a SplitAbstain vote used to badge as "SplitAbstain"
// while the bubble map called the same vote "SPLIT") and nothing can write a side in
// anything but caps.

describe('voteSideLabel', () => {
  it('writes a standard side in caps', () => {
    expect(voteSideLabel('Aye')).toBe('AYE')
    expect(voteSideLabel('Nay')).toBe('NAY')
  })

  // Split and SplitAbstain are different votes: the first backs aye and nay, the second
  // also parks capital on neither side. Both must read as themselves, in caps.
  it('names both split kinds without leaking the enum', () => {
    expect(voteSideLabel('Split')).toBe('SPLIT')
    expect(voteSideLabel('SplitAbstain')).toBe('SPLIT ABSTAIN')
  })

  // Sides reach the UI from two paths that spelled SplitAbstain differently in the past.
  it('accepts any spacing or casing of the same side', () => {
    expect(voteSideLabel('split abstain')).toBe('SPLIT ABSTAIN')
    expect(voteSideLabel('split_abstain')).toBe('SPLIT ABSTAIN')
    expect(voteSideLabel('AYE')).toBe('AYE')
    expect(voteSideLabel('nay')).toBe('NAY')
  })

  // A collective vote whose side could not be decoded, and a missing side.
  it('falls back to a deliberate label, never an empty badge', () => {
    expect(voteSideLabel('Vote')).toBe('VOTE')
    expect(voteSideLabel(null)).toBe('VOTE')
    expect(voteSideLabel(undefined)).toBe('VOTE')
    expect(voteSideLabel('Abstain')).toBe('VOTE')
  })
})

describe('VoteSideBadge', () => {
  it('badges each side with its shared label', () => {
    for (const side of ['Aye', 'Nay', 'Split', 'SplitAbstain', 'Vote', null]) {
      expect(renderToStaticMarkup(<VoteSideBadge side={side} />)).toContain(voteSideLabel(side))
    }
  })

  // Valence is green/red; a vote that backs both sides or neither has none, so it keeps
  // the vote category's colour rather than borrowing aye's green.
  it('colours only aye and nay', () => {
    expect(renderToStaticMarkup(<VoteSideBadge side="Aye" />)).toContain('--green')
    expect(renderToStaticMarkup(<VoteSideBadge side="Nay" />)).toContain('--red')
    for (const side of ['Split', 'SplitAbstain', 'Vote']) {
      const html = renderToStaticMarkup(<VoteSideBadge side={side} />)
      expect(html).toContain('--cat-vote')
      expect(html).not.toContain('--green')
      expect(html).not.toContain('--red')
    }
  })

  it('backs the activity feed side filter with the same words', () => {
    expect(ACTIVITY_ACTIONS.vote.map(a => a.label)).toEqual(['AYE', 'NAY'])
  })
})

const voter = (over: Partial<ReferendumVoter>): ReferendumVoter => ({
  account: null, kind: 'Standard', side: 'Aye', conviction: 'Locked1x', convictionIndex: 1,
  balance: '0', ayeBalance: '0', nayBalance: '0', abstainBalance: '0',
  weightedAye: '0', weightedNay: '0', weighted: '0', valueUsd: null,
  blockHeight: 1, eventIndex: 0, extrinsicIndex: 0, timestamp: '', removed: false, ...over,
})

// The bubbles feed the account hover card its vote row, so a card and the votes table
// underneath it must not disagree about the same vote.
describe('VoteBubbles vote side', () => {
  const render = (v: ReferendumVoter) => renderToStaticMarkup(<VoteBubbles voters={[v]} decimals={12} symbol="HDX" />)

  it('hands the hover card the side actually cast, not the side its weight landed on', () => {
    const splitAbstain = voter({
      kind: 'SplitAbstain', side: 'SplitAbstain', conviction: null, convictionIndex: null,
      ayeBalance: '10', abstainBalance: '990', weightedAye: '1', weighted: '1',
    })

    expect(render(splitAbstain)).toContain('data-vote-side="SPLIT ABSTAIN"')
  })

  it('still says AYE and NAY for a standard vote', () => {
    expect(render(voter({ weightedAye: '10', weighted: '10' }))).toContain('data-vote-side="AYE"')
    expect(render(voter({ side: 'Nay', weightedNay: '10', weighted: '10' }))).toContain('data-vote-side="NAY"')
  })
})
