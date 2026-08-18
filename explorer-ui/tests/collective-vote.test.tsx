import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTable } from '../src/components/ActivityTable'
import { VotesTable } from '../src/components/VotesTable'
import { voteSubjectLabel, voteToActivityRow, assetDescriptorFallback } from '../src/utils/voteRows'
import { collectiveVoteRowAtHeight, MOCK_TC_MOTION_HASH } from './fixtures/mockApi'
import type { ActivityRow, VoteRow } from '../src/types'

// A Council / Technical Committee vote is vote activity like any other, and it
// reaches every vote surface: the merged feed, an account's feed, its own block and
// the votes tables. What makes it different is what it does NOT have — no locked
// capital, no conviction, and a proposal HASH instead of a referendum index — so
// these tests pin how it reads without a referendum page behind it.

const now = Date.UTC(2026, 7, 18, 12)
const row = collectiveVoteRowAtHeight(7_000_000)

describe('voteSubjectLabel', () => {
  it('names a motion a motion, and never calls a hash an index', () => {
    expect(voteSubjectLabel(MOCK_TC_MOTION_HASH, null, null)).toBe(`Motion ${MOCK_TC_MOTION_HASH}`)
    expect(voteSubjectLabel('380', 'opengov', null)).toBe('Referendum #380')
    // A known off-chain title always wins: it is what the vote was about.
    expect(voteSubjectLabel('380', 'opengov', 'Runtime upgrade v50')).toBe('Runtime upgrade v50')
    expect(voteSubjectLabel(null, null, null)).toBe('Referendum')
  })
})

describe('a collective vote in the activity feed', () => {
  const html = renderToStaticMarkup(<ActivityTable rows={[row]} now={now} />)

  it('reads as a motion, with no link and no invented index', () => {
    expect(html).toContain(`Motion ${MOCK_TC_MOTION_HASH}`)
    // No referendum page exists for a motion, so nothing offers one — and the
    // "#index" lead a numbered referendum gets would be the hash a second time.
    expect(html).not.toContain('/referendum/')
    expect(html).not.toContain('ref-num')
  })

  it('keeps the vote itself — the side badge and the committee that cast it', () => {
    expect(html).toContain('AYE')
    // Nothing claims a conviction: a collective vote has none.
    expect(html).not.toContain('conviction')
    expect(renderToStaticMarkup(<ActivityTable rows={[collectiveVoteRowAtHeight(7_000_001)]} now={now} />)).toContain('NAY')
  })

  it('carries the pallet and no capital through to the row', () => {
    expect(row.votePallet).toBe('Technical Committee')
    expect(row.amount).toBeNull()
    expect(row.voteConviction).toBeNull()
    expect(row.voteRefPallet).toBeNull()
  })
})

describe('a collective vote in the votes table', () => {
  const vote: VoteRow = {
    blockHeight: 7_000_000, timestamp: row.timestamp, eventIndex: 96, extrinsicIndex: 4,
    account: row.who ?? null, pallet: 'Technical Committee', action: 'Voted',
    referendum: MOCK_TC_MOTION_HASH, side: 'Aye', conviction: null, amount: null,
    weighted: null, voteRefPallet: null, voteRefTitle: null,
    asset: assetDescriptorFallback, valueUsd: 0,
  }
  const activity: ActivityRow = voteToActivityRow(vote)

  it('shows the same subject the feed shows, and no vote weight', () => {
    const html = renderToStaticMarkup(
      <VotesTable
        rows={[{
          key: 'v1', account: vote.account, referendum: vote.referendum,
          referendumPallet: null, referendumTitle: null, side: vote.side,
          conviction: vote.conviction, weighted: vote.weighted ?? null,
          blockHeight: vote.blockHeight, eventIndex: vote.eventIndex,
          extrinsicIndex: vote.extrinsicIndex, timestamp: vote.timestamp,
        }]}
        asset={assetDescriptorFallback}
        now={now}
        showReferendum
      />,
    )
    expect(html).toContain(`Motion ${MOCK_TC_MOTION_HASH}`)
    expect(html).toContain('AYE')
    expect(html).not.toContain('/referendum/')
  })

  // The two surfaces are one renderer for a reason: the tab maps its rows onto the
  // feed's own shape, so a vote cannot read two ways.
  it('maps onto the same activity row the feed renders', () => {
    expect(activity.votePallet).toBe('Technical Committee')
    expect(activity.voteRef).toBe(MOCK_TC_MOTION_HASH)
    expect(activity.voteRefPallet).toBeNull()
    expect(activity.amount).toBeNull()
  })
})
