import { useAccountActivityCounts, useAccountVotes, useTagActivityCounts, useTagVotes } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { setQuery, useQuery } from '../router'
import { Pager } from './ui'
import { VotesTable, type VoteTableRow } from './VotesTable'
import { assetDescriptorFallback } from '../utils/voteRows'
import type { VoteRow } from '../types'

const PAGE_SIZE = 25

type VotesScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }

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
  const tagId = scope.kind === 'tag' ? scope.tagId : null
  const now = useNow()
  const accountCounts = useAccountActivityCounts(accountAddress)
  const tagCounts = useTagActivityCounts(tagId)
  const counts = scope.kind === 'account' ? accountCounts : tagCounts
  const query = useQuery()
  const requestedPage = Number.parseInt(query.get('vpage') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const offset = page * PAGE_SIZE
  const accountVotes = useAccountVotes(accountAddress, offset)
  const tagVotes = useTagVotes(tagId, offset)
  const votes = scope.kind === 'account' ? accountVotes : tagVotes
  const rows = (votes.data ?? []).map(toTableRow)
  const voteCount = counts.data?.votes
  const totalPages = voteCount != null && voteCount > 0 ? Math.ceil(voteCount / PAGE_SIZE) : undefined
  const setPage = (nextPage: number) => setQuery({ vpage: nextPage > 0 ? String(nextPage) : null })

  return (
    <>
      {/* Same table the referendum page uses. A tag page shows which member cast each
          vote; an account page IS that account, so its account column drops — and here the
          REFERENDUM is the column that matters, which the referendum page in turn omits. */}
      <VotesTable
        rows={rows}
        asset={votes.data?.[0]?.asset ?? assetDescriptorFallback}
        now={now}
        showAccount={scope.kind === 'tag'}
        showReferendum
        loading={votes.isFetching && !votes.data?.length}
        error={votes.error}
        onRetry={() => { void votes.refetch() }}
      />
      <Pager page={page} totalPages={totalPages} hasNext={rows.length === PAGE_SIZE} onPage={setPage} />
    </>
  )
}
