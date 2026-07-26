import { memo } from 'react'
import type { ReactNode } from 'react'
import { Link, paths } from '../router'
import { AddrPill, Dash, EmptyRow, ErrorRow, F, MomentLink, TableSkeleton, VoteSideBadge, type Moment } from './ui'
import type { AccountRef, AssetRef } from '../types'

// The one votes table.
//
// A referendum page lists who voted on it; an account or tag page lists what they voted
// on. Same facts either way — the side and conviction, the conviction-weighted votes, and
// when — so they share a renderer and the two cannot drift apart again. The columns that
// differ are exactly the ones the context already answers: a referendum page needs the
// ACCOUNT and knows its own referendum, an account page needs the REFERENDUM and knows
// its own account.
// A row is one moment (when the vote was cast, and where) plus the vote itself.
export interface VoteTableRow extends Moment {
  key: string
  account: AccountRef | null
  referendum: string | null
  referendumPallet: 'opengov' | 'democracy' | null
  referendumTitle: string | null
  side: string | null
  conviction: string | null
  // Conviction-weighted power, planck. Null when the vote has no weight to report (a
  // collective vote has neither balance nor conviction).
  weighted: string | null
  withdrawn?: boolean
}

function ReferendumCell({ row }: { row: VoteTableRow }) {
  if (!row.referendum) return <Dash />
  const label = row.referendumTitle ?? `Referendum #${row.referendum}`
  return (
    <>
      <span className="muted mono ref-num">#{row.referendum}</span>
      {row.referendumPallet
        ? <Link to={paths.referendum(row.referendumPallet, row.referendum)} className="ref-link">{row.referendumTitle ?? 'Referendum'}</Link>
        : <span className="muted">{label}</span>}
    </>
  )
}

// Memoised, and fed row objects whose identity survives a re-sort: a referendum
// carries a couple of hundred of these, and sorting or filtering only reorders the
// same votes, so React can move the rows without re-rendering any of them.
const VoteRow = memo(function VoteRow({ row, asset, now, showAccount, showReferendum }: {
  row: VoteTableRow; asset: AssetRef; now: number; showAccount?: boolean; showReferendum?: boolean
}) {
  return (
    <tr className={row.withdrawn ? 'row-muted' : undefined}>
      {showReferendum && <td data-label="Referendum"><ReferendumCell row={row} /></td>}
      {showAccount && <td data-label="Account">{row.account ? <AddrPill account={row.account} /> : <span className="muted">unknown</span>}</td>}
      <td data-label="Vote">
        <VoteSideBadge side={row.side} />
        {row.conviction ? <span className="muted"> {row.conviction}</span> : null}
        {row.withdrawn && <span className="badge badge-quiet" title="Withdrawn before the referendum closed, so it is not counted">withdrawn</span>}
      </td>
      <td data-label="Votes" className="r mono">
        {row.weighted == null ? <Dash /> : <>{F.amount(row.weighted, asset.decimals)} <span className="muted">{asset.symbol}</span></>}
      </td>
      <td data-label="Time" className="r">
        {/* Links to the extrinsic that cast the vote (see MomentLink). */}
        <MomentLink at={row} now={now} />
      </td>
    </tr>
  )
})

export function VotesTable({ rows, asset, now, showAccount, showReferendum, sortHeads, loading, error, onRetry, pageSize }: {
  rows: VoteTableRow[]
  asset: AssetRef
  now: number
  showAccount?: boolean
  showReferendum?: boolean
  // Sortable headers, supplied by a caller that sorts (the referendum page). Absent, the
  // columns are plain labels, so both tables read the same either way.
  sortHeads?: { votes: ReactNode; time: ReactNode }
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  // Sizes the loading skeleton on the paged surface so the pager under it holds still.
  pageSize?: number
}) {
  const cols = 2 + (showAccount ? 1 : 0) + (showReferendum ? 1 : 0)
  return (
    <div className="panel"><table className="tbl">
      <thead><tr>
        {showReferendum && <th>Referendum</th>}
        {showAccount && <th>Account</th>}
        <th>Vote</th>
        <th className="r">{sortHeads?.votes ?? 'Votes'}</th>
        <th className="r">{sortHeads?.time ?? 'Time'}</th>
      </tr></thead>
      <tbody>
        {loading ? <TableSkeleton cols={cols + 1} rows={pageSize} />
          : error && !rows.length ? <ErrorRow cols={cols + 1} title="Couldn’t load votes" error={error} onRetry={onRetry} />
            : !rows.length ? <EmptyRow cols={cols + 1}>No votes</EmptyRow>
              : rows.map(row => (
                <VoteRow key={row.key} row={row} asset={asset} now={now} showAccount={showAccount} showReferendum={showReferendum} />
              ))}
      </tbody>
    </table></div>
  )
}
