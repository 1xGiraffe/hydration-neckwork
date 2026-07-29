import { useAccountListCount, useAccountVotes, useTagListCount, useTagVotes } from '../hooks/useExplorerData'
import { useListTagListCount, useListTagVotes } from '../hooks/useUser'
import { useNow } from '../hooks/useNow'
import { setQuery, useQuery } from '../router'
import { Pager } from './ui'
import { VotesTable, type VoteTableRow } from './VotesTable'
import { assetDescriptorFallback } from '../utils/voteRows'
import { PAGE_SIZE, hasNextPage, pageCount, voteListCount } from '../utils/activityPaging'
import type { VoteRow } from '../types'

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

export function VotesTab({ scope }: { scope: VotesScope }) {
  const accountAddress = scope.kind === 'account' ? scope.address : null
  const systemTagId = scope.kind === 'tag' ? scope.tagId : null
  const listId = scope.kind === 'list-tag' ? scope.listId : null
  const listTagId = scope.kind === 'list-tag' ? scope.tagId : null
  const now = useNow()
  const query = useQuery()
  const requestedPage = Number.parseInt(query.get('vpage') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const offset = page * PAGE_SIZE
  const accountVotes = useAccountVotes(accountAddress, offset)
  const tagVotes = useTagVotes(systemTagId, offset)
  const listTagVotes = useListTagVotes(listId, listTagId, offset)
  const votes = scope.kind === 'account' ? accountVotes : scope.kind === 'tag' ? tagVotes : listTagVotes
  const rows = (votes.data ?? []).map(toTableRow)
  // The list exposes no filters, so its total is the whole vote history — counted
  // from the same sources the list merges (OpenGov/Democracy plus collectives).
  const accountTotal = useAccountListCount(accountAddress, voteListCount())
  const tagTotal = useTagListCount(systemTagId, voteListCount())
  const listTagTotal = useListTagListCount(listId, listTagId, voteListCount())
  const totalPages = pageCount((scope.kind === 'account' ? accountTotal : scope.kind === 'tag' ? tagTotal : listTagTotal).data?.total)
  const setPage = (nextPage: number) => setQuery({ vpage: nextPage > 0 ? String(nextPage) : null })

  return (
    <>
      {/* Same table the referendum page uses. A tag/list-tag page shows which
          member cast each vote; an account page IS that account, so its account
          column drops — and here the REFERENDUM is the column that matters, which
          the referendum page in turn omits. */}
      <VotesTable
        rows={rows}
        asset={votes.data?.[0]?.asset ?? assetDescriptorFallback}
        now={now}
        showAccount={scope.kind !== 'account'}
        showReferendum
        loading={votes.isFetching && !votes.data?.length}
        pending={votes.isPlaceholderData}
        pageSize={PAGE_SIZE}
        error={votes.error}
        onRetry={() => { void votes.refetch() }}
      />
      <Pager page={page} totalPages={totalPages} hasNext={hasNextPage(totalPages, page, rows.length)} onPage={setPage} />
    </>
  )
}
