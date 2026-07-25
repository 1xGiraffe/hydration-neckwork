import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, F, AddrPill, SkeletonRows, Ago } from '../components/ui'
import { VoteBubbles } from '../components/VoteBubbles'
import type { ReferendumDetail, ReferendumVoter } from '../types'
import { orderVoters, type SideFilter, type VoteSort } from '../utils/referendumVotes'

const PALLET_LABEL: Record<string, string> = { opengov: 'OpenGov', democracy: 'Democracy' }

function useReferendum(pallet: 'opengov' | 'democracy', index: number) {
  return useQuery({
    queryKey: ['referendum', pallet, index],
    queryFn: ({ signal }) => api.referendum(pallet, index, signal),
    staleTime: 30_000,
  })
}

// Share of the weighted tally, as a percentage of aye + nay. Computed in BigInt: the
// values are 21-digit planck figures that a double would round.
function sharePct(part: string, other: string): number | null {
  try {
    const a = BigInt(part), b = BigInt(other)
    if (a + b === 0n) return null
    return Number((a * 10_000n) / (a + b)) / 100
  } catch { return null }
}

function TallyBar({ ayes, nays }: { ayes: string; nays: string }) {
  const ayePct = sharePct(ayes, nays)
  if (ayePct == null) return <div className="empty-note">No votes counted yet</div>
  return (
    <div className="tally-bar" title={`${ayePct.toFixed(2)}% AYE`}>
      <div className="tally-aye" style={{ width: `${ayePct}%` }} />
      <div className="tally-nay" style={{ width: `${100 - ayePct}%` }} />
    </div>
  )
}

function SideBadge({ side }: { side: ReferendumVoter['side'] }) {
  const cls = side === 'Aye' ? 'vote-aye' : side === 'Nay' ? 'vote-nay' : 'vote-split'
  return <span className={`badge ${cls}`}>{side.toUpperCase()}</span>
}

function SortHead({ label, value, sort, onSort }: { label: string; value: VoteSort; sort: VoteSort; onSort: (v: VoteSort) => void }) {
  return (
    <button type="button" className={`th-sort${sort === value ? ' on' : ''}`} onClick={() => onSort(value)}>
      {label}{sort === value ? ' ▼' : ''}
    </button>
  )
}

function VoterRows({ voters, detail, now }: { voters: ReferendumVoter[]; detail: ReferendumDetail; now: number }) {
  const { decimals, symbol } = detail.asset
  return (
    <>
      {voters.map(voter => (
        <tr key={`${voter.blockHeight}-${voter.eventIndex}`} className={voter.removed ? 'row-muted' : undefined}>
          <td data-label="Account">{voter.account ? <AddrPill account={voter.account} /> : <span className="muted">unknown</span>}</td>
          <td data-label="Vote"><SideBadge side={voter.side} />{voter.conviction ? <span className="muted"> {voter.conviction}</span> : null}
            {voter.removed && <span className="badge badge-quiet" title="Withdrawn before the referendum closed, so it is not counted">withdrawn</span>}</td>
          <td data-label="Votes" className="r mono">{F.amount(voter.weighted, decimals)} <span className="muted">{symbol}</span></td>
          <td data-label="Time" className="r">
            {/* The vote's own extrinsic, so a row leads to the transaction that cast it. */}
            {voter.extrinsicIndex != null
              ? <Link to={paths.extrinsic(`${voter.blockHeight}-${voter.extrinsicIndex}`)} className="hash"><Ago ts={voter.timestamp} now={now} /></Link>
              : <Ago ts={voter.timestamp} now={now} />}
          </td>
        </tr>
      ))}
    </>
  )
}

// One referendum: what it was, how it ended, and who voted with how much
// conviction-weighted power.
export function Referendum({ pallet, index }: { pallet: 'opengov' | 'democracy'; index: number }) {
  const { data, isLoading, isError } = useReferendum(pallet, index)
  const [sort, setSort] = useState<VoteSort>('time')
  const [side, setSide] = useState<SideFilter>('all')
  const now = useNow()
  const shown = useMemo(() => orderVoters(data?.voters ?? [], sort, side), [data?.voters, sort, side])

  const label = `${PALLET_LABEL[pallet] ?? pallet} #${index}`
  useDocumentTitle(data?.title ? `${data.title} · ${label}` : label)

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[
          { label: 'Home', to: paths.dashboard() },
          { label: 'Activity', to: `${paths.activity()}?tab=vote` },
          { label: label },
        ]} />
        <div className="page-title">
          {data?.title ?? label}
          <span className="sub">{data ? `${PALLET_LABEL[pallet] ?? pallet} #${index} · ${data.status}${data.track != null ? ` · track ${data.track}` : ''}` : ''}</span>
        </div>
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Referendum not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows rows={5} /></div> : (
          <>
            {/* Above the card and right-aligned, matching "Open in preis" on the
                asset page rather than sitting in the detail list. */}
            <div className="ext-link-row">
              <a href={data.subsquareUrl} target="_blank" rel="noopener" className="ext-link">Open in Subsquare ↗</a>
            </div>
            <div className="detail-card">
              <div className="dl">
                {/* The chain's own tally is authoritative: it is already
                    conviction-weighted and includes delegated power. */}
                {data.onChainTally && <>
                  <div className="dt">On-chain tally</div>
                  <div className="dd">
                    <TallyBar ayes={data.onChainTally.ayes} nays={data.onChainTally.nays} />
                    <div className="mono" style={{ marginTop: 6 }}>
                      <span className="vb-aye-text">{F.amount(data.onChainTally.ayes, data.asset.decimals)} AYE</span>
                      {' · '}
                      <span className="vb-nay-text">{F.amount(data.onChainTally.nays, data.asset.decimals)} NAY</span>
                      {data.onChainTally.support && <span className="muted"> · support {F.amount(data.onChainTally.support, data.asset.decimals)}</span>}
                    </div>
                  </div>
                </>}
                {/* Delegated power casts no vote of its own, so it can only appear as
                    the gap between the chain's tally and the votes we can attribute.
                    Stated rather than folded into someone's weight. */}
                {data.indirectTally && <>
                  <div className="dt">Delegated / unattributed</div>
                  <div className="dd mono">
                    {F.amount(data.indirectTally.ayes, data.asset.decimals)} AYE · {F.amount(data.indirectTally.nays, data.asset.decimals)} NAY
                    <span className="muted"> — in the chain tally, with no Voted event of its own</span>
                  </div>
                </>}
                {data.submittedAt && <>
                  <div className="dt">Submitted</div>
                  <div className="dd mono">
                    <Link to={paths.block(data.submittedAt.blockHeight)} className="hash">{F.int(data.submittedAt.blockHeight)}</Link>{' '}
                    <Ago ts={data.submittedAt.timestamp} now={now} />
                  </div>
                </>}
                {data.concludedAt && <>
                  <div className="dt">Concluded</div>
                  <div className="dd mono">
                    <Link to={paths.block(data.concludedAt.blockHeight)} className="hash">{F.int(data.concludedAt.blockHeight)}</Link>{' '}
                    <Ago ts={data.concludedAt.timestamp} now={now} />
                  </div>
                </>}
                {data.proposalHash && <>
                  <div className="dt">Proposal</div>
                  <div className="dd mono hash-cell">{data.proposalHash}</div>
                </>}
              </div>
            </div>

            <div className="sec-title" style={{ marginTop: 22 }}>Voting power
              <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · one bubble per account, area = conviction-weighted power</span>
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <VoteBubbles voters={data.voters} decimals={data.asset.decimals} symbol={data.asset.symbol} />
            </div>

            <div className="sec-title" style={{ marginTop: 22 }}>Votes
              <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>
                {' '}· {F.int(shown.length)}{shown.length !== data.votesTotal ? ` of ${F.int(data.votesTotal)}` : ''} {data.votesTotal === 1 ? 'account' : 'accounts'}
                {data.votesShown < data.votesTotal ? ` · loaded ${F.int(data.votesShown)}` : ''}
              </span>
            </div>
            <div className="activity-chips">
              {(['all', 'aye', 'nay'] as SideFilter[]).map(value => (
                <button key={value} className={`activity-chip${side === value ? ' on' : ''}`} onClick={() => setSide(value)}>
                  {value === 'all' ? 'All' : value.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="panel"><table className="tbl">
              <thead><tr>
                <th>Account</th><th>Vote</th>
                <th className="r"><SortHead label="Votes" value="votes" sort={sort} onSort={setSort} /></th>
                <th className="r"><SortHead label="Time" value="time" sort={sort} onSort={setSort} /></th>
              </tr></thead>
              <tbody><VoterRows voters={shown} detail={data} now={now} /></tbody>
            </table></div>
          </>
        )}
    </div>
  )
}
