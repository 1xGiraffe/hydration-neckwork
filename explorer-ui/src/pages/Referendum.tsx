import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, F, AddrPill, SkeletonRows, Ago } from '../components/ui'
import { VoteBubbles } from '../components/VoteBubbles'
import type { ReferendumDetail, ReferendumVoter } from '../types'

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
    <div className="tally-bar" title={`${ayePct.toFixed(2)}% aye`}>
      <div className="tally-aye" style={{ width: `${ayePct}%` }} />
      <div className="tally-nay" style={{ width: `${100 - ayePct}%` }} />
    </div>
  )
}

function SideBadge({ side }: { side: ReferendumVoter['side'] }) {
  const cls = side === 'Aye' ? 'vote-aye' : side === 'Nay' ? 'vote-nay' : 'vote-split'
  return <span className={`badge ${cls}`}>{side.toUpperCase()}</span>
}

function VoterRows({ detail, now }: { detail: ReferendumDetail; now: number }) {
  const { decimals, symbol } = detail.asset
  return (
    <>
      {detail.voters.map(voter => (
        <tr key={`${voter.blockHeight}-${voter.eventIndex}`} className={voter.removed ? 'row-muted' : undefined}>
          <td data-label="Account">{voter.account ? <AddrPill account={voter.account} /> : <span className="muted">unknown</span>}</td>
          <td data-label="Vote"><SideBadge side={voter.side} />{voter.conviction ? <span className="muted"> {voter.conviction}</span> : null}
            {voter.removed && <span className="badge badge-quiet" title="Withdrawn before the referendum closed, so it is not counted">withdrawn</span>}</td>
          <td data-label="Locked" className="r mono">{F.amount(voter.balance, decimals)}</td>
          <td data-label="Weighted" className="r mono">{F.amount(voter.weighted, decimals)} <span className="muted">{symbol}</span></td>
          <td data-label="Value" className="r mono">{voter.valueUsd == null ? '—' : F.usd(voter.valueUsd)}</td>
          <td data-label="When" className="r">
            <Link to={paths.block(voter.blockHeight)} className="hash">{F.int(voter.blockHeight)}</Link>{' '}
            <Ago ts={voter.timestamp} now={now} />
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
  const now = useNow()
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
            <div className="detail-card">
              <div className="dl">
                {/* The chain's own tally is authoritative: it is already
                    conviction-weighted and includes delegated power. */}
                {data.onChainTally && <>
                  <div className="dt">On-chain tally</div>
                  <div className="dd">
                    <TallyBar ayes={data.onChainTally.ayes} nays={data.onChainTally.nays} />
                    <div className="mono" style={{ marginTop: 6 }}>
                      <span className="vb-aye-text">{F.amount(data.onChainTally.ayes, data.asset.decimals)} aye</span>
                      {' · '}
                      <span className="vb-nay-text">{F.amount(data.onChainTally.nays, data.asset.decimals)} nay</span>
                      {data.onChainTally.support && <span className="muted"> · support {F.amount(data.onChainTally.support, data.asset.decimals)}</span>}
                    </div>
                  </div>
                </>}
                <div className="dt">Indexed votes</div>
                <div className="dd">
                  <span className="mono">{F.int(data.directTally.voters)}</span> accounts ·{' '}
                  <span className="vb-aye-text mono">{F.int(data.directTally.ayeVoters)} aye</span> ·{' '}
                  <span className="vb-nay-text mono">{F.int(data.directTally.nayVoters)} nay</span>
                  {data.directTally.splitVoters > 0 && <> · <span className="mono">{F.int(data.directTally.splitVoters)} split</span></>}
                  <div className="mono" style={{ marginTop: 4 }}>
                    {F.amount(data.directTally.ayes, data.asset.decimals)} / {F.amount(data.directTally.nays, data.asset.decimals)} weighted
                    <span className="muted"> (from {F.amount(data.directTally.rawAyes, data.asset.decimals)} / {F.amount(data.directTally.rawNays, data.asset.decimals)} locked)</span>
                  </div>
                </div>
                {/* Delegated power casts no vote of its own, so it can only appear as
                    the gap between the chain's tally and the votes we can attribute.
                    Stated rather than folded into someone's weight. */}
                {data.indirectTally && <>
                  <div className="dt">Delegated / unattributed</div>
                  <div className="dd mono">
                    {F.amount(data.indirectTally.ayes, data.asset.decimals)} aye · {F.amount(data.indirectTally.nays, data.asset.decimals)} nay
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
                <div className="dt">Discussion</div>
                <div className="dd">
                  <a href={data.subsquareUrl} target="_blank" rel="noopener" className="ext-link">
                    SubSquare <span className="ext-site">subsquare.io</span>
                  </a>
                </div>
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
                {' '}· {F.int(data.votesTotal)} {data.votesTotal === 1 ? 'account' : 'accounts'}, heaviest first
                {data.votesShown < data.votesTotal ? ` · showing ${F.int(data.votesShown)}` : ''}
              </span>
            </div>
            <div className="panel"><table className="tbl">
              <thead><tr>
                <th>Account</th><th>Vote</th><th className="r">Locked</th>
                <th className="r">Weighted</th><th className="r">Value</th><th className="r">When</th>
              </tr></thead>
              <tbody><VoterRows detail={data} now={now} /></tbody>
            </table></div>
          </>
        )}
    </div>
  )
}
