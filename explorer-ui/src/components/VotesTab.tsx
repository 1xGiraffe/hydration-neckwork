import { useAccountActivityCounts, useAccountVotes, useTagActivityCounts, useTagVotes } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { Link, paths, setQuery, useQuery } from '../router'
import { AddrPill, Ago, AssetAmount, Dash, EmptyRow, F, Pager, TableSkeleton, VoteSideBadge, rowNav } from './ui'
import type { VoteRow } from '../types'

const PAGE_SIZE = 25

type VotesScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }

// Readable governance-era label for the vote's source pallet. Conviction votes
// are the OpenGov era; Democracy/Council/Technical Committee keep their names.
function palletLabel(pallet: string): string {
  return pallet === 'ConvictionVoting' ? 'OpenGov' : pallet
}

// "Ref 304" for referendum votes; collective votes carry the (already
// shortened) proposal hash instead of an index.
function referendumLabel(referendum: string | null): string | null {
  if (!referendum) return null
  return /^\d+$/.test(referendum) ? `Ref ${referendum}` : referendum
}

// The conviction the voter actually used, as its OpenGov vote-weight multiplier
// (None = no lock = 0.1x; Locked{n}x = nx), rather than the raw lock label.
function convictionLabel(conviction: string | null): string | null {
  if (!conviction) return null
  if (conviction === 'None') return '0.1x'
  const m = /^Locked(\d)x$/.exec(conviction)
  return m ? `${m[1]}x` : conviction
}

// Governance votes cast by the account (or every member of a tag): OpenGov and
// Democracy referendum votes plus Council / Technical Committee collective
// votes. Same paginated-table shell as ScopedActivity, with its own `vpage`
// query param so it deep-links independently of the activity pager.
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
  // Tag pages show which member cast each vote, like the extrinsics signer.
  const showVoter = scope.kind === 'tag'
  const cols = showVoter ? 8 : 7
  const voteCount = counts.data?.votes
  const totalPages = voteCount != null && voteCount > 0 ? Math.ceil(voteCount / PAGE_SIZE) : undefined
  const setPage = (nextPage: number) => setQuery({ vpage: nextPage > 0 ? String(nextPage) : null })

  const row = (v: VoteRow) => {
    // Only OpenGov/Democracy votes have a working vote-detail page; collective
    // (Council / Technical Committee) events aren't resolved there, so render them
    // as plain text instead of a dead link.
    const linkable = (v.pallet === 'ConvictionVoting' || v.pallet === 'Democracy') && v.eventIndex != null
    const aid = linkable ? `${v.blockHeight}-e${v.eventIndex}` : null
    const nav = aid ? rowNav(paths.activityDetail('vote', aid)) : null
    const label = referendumLabel(v.referendum)
    return (
      <tr key={`${v.blockHeight}-${v.eventIndex}`} {...(nav ?? {})}>
        <td data-label="Referendum" className="mono">{aid
          ? <Link to={paths.activityDetail('vote', aid)} className="hash">{label ?? '—'}</Link>
          : label ?? <Dash />}</td>
        <td data-label="Type"><span className="muted">{palletLabel(v.pallet)}</span></td>
        {showVoter && <td data-label="Account">{v.account ? <AddrPill account={v.account} noCopy /> : <Dash />}</td>}
        <td data-label="Side"><VoteSideBadge side={v.side} /></td>
        <td data-label="Conviction" className="mono muted">{convictionLabel(v.conviction) ?? <Dash />}</td>
        <td data-label="Amount" className="r">{v.amount != null ? <AssetAmount asset={v.asset} raw={v.amount} /> : <Dash />}</td>
        <td data-label="Value" className="r mono">{v.amount != null && v.valueUsd != null ? F.usd(v.valueUsd) : <Dash />}</td>
        <td data-label="Time" className="r mono muted"><Ago ts={v.timestamp} now={now} /></td>
      </tr>
    )
  }

  return (
    <>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Referendum</th><th>Type</th>{showVoter && <th>Account</th>}<th>Side</th><th>Conviction</th><th className="r">Amount</th><th className="r">Value</th><th className="r">Time</th></tr></thead>
        <tbody>
          {votes.isFetching && !votes.data?.length ? <TableSkeleton cols={cols} />
            : !votes.data?.length ? <EmptyRow cols={cols}>No votes</EmptyRow>
              : votes.data.map(row)}
        </tbody>
      </table></div>
      <Pager page={page} totalPages={totalPages} hasNext={(votes.data?.length ?? 0) === PAGE_SIZE} onPage={setPage} />
    </>
  )
}
