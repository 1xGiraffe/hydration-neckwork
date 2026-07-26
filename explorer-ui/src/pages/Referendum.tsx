import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths } from '../router'
import { Crumbs, F, SkeletonRows, MomentLink } from '../components/ui'
import { VoteBubbles } from '../components/VoteBubbles'
import { VotesTable } from '../components/VotesTable'
import { ProposalCall } from '../components/ProposalCall'
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

function SortHead({ label, value, sort, onSort }: { label: string; value: VoteSort; sort: VoteSort; onSort: (v: VoteSort) => void }) {
  return (
    <button type="button" className={`th-sort${sort === value ? ' on' : ''}`} onClick={() => onSort(value)}>
      {label}{sort === value ? ' ▼' : ''}
    </button>
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
                  {/* dd-stack: .dd is a flex ROW, which put the bar beside the numbers
                      and collapsed it to zero width (its children are percentages). */}
                  <div className="dd dd-stack">
                    <TallyBar ayes={data.onChainTally.ayes} nays={data.onChainTally.nays} />
                    <div className="mono">
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
                  <div className="dd mono"><MomentLink at={data.submittedAt} now={now} /></div>
                </>}
                {data.concludedAt && <>
                  <div className="dt">Concluded</div>
                  <div className="dd mono"><MomentLink at={data.concludedAt} now={now} /></div>
                </>}

              </div>
            </div>

            {/* What the referendum would actually DO. Only place a reader can see it: the
                chain stores it as SCALE bytes behind the hash. */}
            {(data.proposalCall || data.proposalHash) && <>
              <div className="sec-title" style={{ marginTop: 22 }}>Proposal
                {data.proposalCall && !data.proposalCall.decodeError && <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>
                  {' '}· {data.proposalCall.pallet}.{data.proposalCall.callName}
                </span>}
              </div>
              {data.proposalCall
                ? <ProposalCall call={data.proposalCall} hash={data.proposalHash} />
                : <div className="panel pc-panel"><div className="pc-unavailable">Preimage not indexed yet{data.proposalHash && <div className="pc-hash mono">{data.proposalHash}</div>}</div></div>}
            </>}

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
            {/* The same table the account/tag votes tab renders; there the referendum is
                the column that matters, here the account is. */}
            <VotesTable
              rows={shown.map(voter => ({
                key: `${voter.blockHeight}-${voter.eventIndex}`,
                account: voter.account,
                referendum: null, referendumPallet: null, referendumTitle: null,
                side: voter.side,
                conviction: voter.conviction,
                weighted: voter.weighted,
                blockHeight: voter.blockHeight,
                extrinsicIndex: voter.extrinsicIndex,
                timestamp: voter.timestamp,
                withdrawn: voter.removed,
              }))}
              asset={data.asset}
              now={now}
              showAccount
              sortHeads={{
                votes: <SortHead label="Votes" value="votes" sort={sort} onSort={setSort} />,
                time: <SortHead label="Time" value="time" sort={sort} onSort={setSort} />,
              }}
            />
          </>
        )}
    </div>
  )
}
