import { useAccountActivityCounts, useAccountVotes, useTagActivityCounts, useTagVotes } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { setQuery, useQuery } from '../router'
import { Pager } from './ui'
import { ActivityTable } from './ActivityTable'
import { voteToActivityRow } from '../utils/voteRows'

const PAGE_SIZE = 25

type VotesScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }

// Governance votes cast by the account (or every member of a tag): OpenGov and Democracy
// referendum votes plus Council / Technical Committee collective votes. Keeps its own
// `vpage` query param so it deep-links independently of the activity pager.
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
  const rows = (votes.data ?? []).map(voteToActivityRow)
  const voteCount = counts.data?.votes
  const totalPages = voteCount != null && voteCount > 0 ? Math.ceil(voteCount / PAGE_SIZE) : undefined
  const setPage = (nextPage: number) => setQuery({ vpage: nextPage > 0 ? String(nextPage) : null })

  return (
    <>
      {/* A tag page shows which member cast each vote; an account page IS that account,
          so the actor column drops there — the same rule the activity feed follows. */}
      <ActivityTable
        rows={rows}
        now={now}
        noActor={scope.kind === 'account'}
        live={page === 0}
        loading={votes.isFetching && !votes.data?.length}
        error={votes.error}
        onRetry={() => { void votes.refetch() }}
      />
      <Pager page={page} totalPages={totalPages} hasNext={rows.length === PAGE_SIZE} onPage={setPage} />
    </>
  )
}
