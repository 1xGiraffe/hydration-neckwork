import { useAccountListCount, useAccountVotes, useTagListCount, useTagVotes, useTagVotesByReferendum } from '../hooks/useExplorerData'
import { useListTagListCount, useListTagVotes, useListTagVotesByReferendum } from '../hooks/useUser'
import { useNow } from '../hooks/useNow'
import { setQuery, useQuery } from '../router'
import { Pager } from './ui'
import { VotesTable, type VoteTableRow } from './VotesTable'
import { assetDescriptorFallback, avgConvictionLabel } from '../utils/voteRows'
import { PAGE_SIZE, hasNextPage, pageCount, voteListCount } from '../utils/activityPaging'
import type { VoteGroupRow, VoteRow } from '../types'

type VotesScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }
  | { kind: 'list-tag'; listId: string; tagId: string }

function toTableRow(vote: VoteRow): VoteTableRow {
  return {
    key: `${vote.blockHeight}-${vote.eventIndex}`,
    account: vote.account,
    referendum: vote.referendum,
    referendumPallet: vote.voteRefPallet ?? null,
    referendumTitle: vote.voteRefTitle ?? null,
    side: vote.side,
    conviction: vote.conviction,
    weighted: vote.weighted ?? null,
    blockHeight: vote.blockHeight,
    extrinsicIndex: vote.extrinsicIndex,
    timestamp: vote.timestamp,
  }
}

// A grouped row: the tag's members' latest votes on one referendum, combined.
// The conviction cell carries the capital-weighted average — derived from the
// same two integer sums the referendum bubble chart uses for a folded tag.
function groupToTableRow(group: VoteGroupRow): VoteTableRow {
  return {
    key: `ref:${group.voteRefPallet ?? group.pallet}:${group.referendum ?? `${group.blockHeight}-${group.eventIndex}`}`,
    account: null,
    referendum: group.referendum,
    referendumPallet: group.voteRefPallet ?? null,
    referendumTitle: group.voteRefTitle ?? null,
    side: group.side,
    conviction: avgConvictionLabel(group.weighted, group.amount),
    weighted: group.weighted,
    voters: group.voters,
    blockHeight: group.blockHeight,
    extrinsicIndex: group.extrinsicIndex,
    timestamp: group.timestamp,
  }
}

export function VotesTab({ scope }: { scope: VotesScope }) {
  const accountAddress = scope.kind === 'account' ? scope.address : null
  const listId = scope.kind === 'list-tag' ? scope.listId : null
  const listTagId = scope.kind === 'list-tag' ? scope.tagId : null
  const now = useNow()
  const query = useQuery()
  const requestedPage = Number.parseInt(query.get('vpage') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const offset = page * PAGE_SIZE
  // Tag scopes group members' votes per referendum by default — the aggregate
  // is what a group page is FOR — with every individual vote one chip away.
  // An account page has exactly one voter, so there is nothing to group.
  const canGroup = scope.kind !== 'account'
  const grouped = canGroup && query.get('vmode') !== 'each'
  const systemTagId = scope.kind === 'tag' ? scope.tagId : null
  const accountVotes = useAccountVotes(accountAddress, offset)
  const tagVotes = useTagVotes(grouped ? null : systemTagId, offset)
  const listTagVotes = useListTagVotes(grouped ? null : listId, listTagId, offset)
  const tagGrouped = useTagVotesByReferendum(systemTagId, offset, grouped)
  const listTagGrouped = useListTagVotesByReferendum(listId, listTagId, offset, grouped)
  const groupedPage = scope.kind === 'tag' ? tagGrouped : listTagGrouped
  const votes = scope.kind === 'account' ? accountVotes : scope.kind === 'tag' ? tagVotes : listTagVotes
  const rows = grouped
    ? (groupedPage.data?.rows ?? []).map(groupToTableRow)
    : (votes.data ?? []).map(toTableRow)
  // The list exposes no filters, so its total is the whole vote history — counted
  // from the same sources the list merges (OpenGov/Democracy plus collectives).
  // Grouped mode counts referenda instead, straight off its own response.
  const accountTotal = useAccountListCount(accountAddress, voteListCount())
  const tagTotal = useTagListCount(grouped ? null : systemTagId, voteListCount())
  const listTagTotal = useListTagListCount(grouped ? null : listId, listTagId, voteListCount())
  const totalPages = grouped
    ? pageCount(groupedPage.data?.total)
    : pageCount((scope.kind === 'account' ? accountTotal : scope.kind === 'tag' ? tagTotal : listTagTotal).data?.total)
  const setPage = (nextPage: number) => setQuery({ vpage: nextPage > 0 ? String(nextPage) : null })
  const active = grouped ? groupedPage : votes

  return (
    <>
      {canGroup && (
        <div className="activity-chips">
          {([['grouped', 'By referendum'], ['each', 'Each vote']] as const).map(([value, label]) => (
            <button
              key={value}
              className={`activity-chip${(grouped ? 'grouped' : 'each') === value ? ' on' : ''}`}
              onClick={() => setQuery({ vmode: value === 'grouped' ? null : value, vpage: null })}
            >
              {label}
            </button>
          ))}
          {grouped && groupedPage.data?.complete === false && (
            <span className="muted" style={{ fontSize: 12 }}>covers the newest votes only</span>
          )}
        </div>
      )}
      {/* Same table the referendum page uses. A tag/list-tag page shows which
          member cast each vote (or, grouped, how many members' votes each
          referendum row combines); an account page IS that account, so its
          account column drops — and here the REFERENDUM is the column that
          matters, which the referendum page in turn omits. */}
      <VotesTable
        rows={rows}
        asset={(grouped ? groupedPage.data?.rows?.[0]?.asset : votes.data?.[0]?.asset) ?? assetDescriptorFallback}
        now={now}
        showAccount={scope.kind !== 'account' && !grouped}
        showReferendum
        loading={active.isFetching && !rows.length}
        pending={active.isPlaceholderData}
        pageSize={PAGE_SIZE}
        anchorRef={grouped ? undefined : votes.anchorRef}
        error={active.error}
        onRetry={() => { void active.refetch() }}
      />
      <Pager page={page} totalPages={totalPages} hasNext={hasNextPage(totalPages, page, rows.length)} onPage={setPage} />
    </>
  )
}
