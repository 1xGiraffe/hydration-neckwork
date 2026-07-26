import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths } from '../router'
import { Crumbs, F, SkeletonRows, MomentLink } from '../components/ui'
import { VoteBubbles } from '../components/VoteBubbles'
import { VotesTable, type VoteTableRow } from '../components/VotesTable'
import { ProposalCall } from '../components/ProposalCall'
import { ayeSharePct, orderVoters, selectTally, type DisplayTally, type SideFilter, type VoteSort } from '../utils/referendumVotes'

const PALLET_LABEL: Record<string, string> = { opengov: 'OpenGov', democracy: 'Democracy' }

function useReferendum(pallet: 'opengov' | 'democracy', index: number) {
  return useQuery({
    queryKey: ['referendum', pallet, index],
    queryFn: ({ signal }) => api.referendum(pallet, index, signal),
    staleTime: 30_000,
  })
}

function TallyBar({ ayes, nays }: { ayes: string; nays: string }) {
  const ayePct = ayeSharePct(ayes, nays)
  if (ayePct == null) return <div className="empty-note">No votes counted yet</div>
  return (
    <div className="tally-bar" title={`${ayePct.toFixed(2)}% AYE`}>
      <div className="tally-aye" style={{ width: `${ayePct}%` }} />
      <div className="tally-nay" style={{ width: `${100 - ayePct}%` }} />
    </div>
  )
}

// The tally, with the bar and the AYE/NAY amounts both pallets get — and a label that
// says which figure this is. OpenGov carries the chain's own tally on its lifecycle
// events; Democracy carries none anywhere, so a Democracy page can only show what its
// indexed votes add up to and has to say so (see selectTally).
export function TallySummary({ tally, voters, decimals }: { tally: DisplayTally; voters: number; decimals: number }) {
  return (
    <>
      <div className="dt">{tally.source === 'chain' ? 'On-chain tally' : 'Attributed votes'}</div>
      {/* dd-stack: .dd is a flex ROW, which put the bar beside the numbers and collapsed
          it to zero width (its children are percentages). */}
      <div className="dd dd-stack">
        <TallyBar ayes={tally.ayes} nays={tally.nays} />
        <div className="mono">
          <span className="vb-aye-text">{F.amount(tally.ayes, decimals)} AYE</span>
          {' · '}
          <span className="vb-nay-text">{F.amount(tally.nays, decimals)} NAY</span>
          {tally.support && <span className="muted"> · support {F.amount(tally.support, decimals)}</span>}
        </div>
        {tally.source === 'attributed' && <div className="tally-note">
          Not the chain’s own tally: the Democracy pallet publishes its tally only in storage while a
          referendum is open, so this sums the {F.int(voters)} indexed{voters === 1 ? ' vote' : ' votes'} —
          the chain’s direct tally, without delegated power.
        </div>}
      </div>
    </>
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
  // Row objects keyed on the voter, not rebuilt per render: sorting and the side chips
  // only reorder and filter the same votes, so the memoised VoteRow can skip all ~176
  // of them and React just moves the <tr>s.
  const rowOf = useMemo(() => new Map((data?.voters ?? []).map(voter => [voter, {
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
  } satisfies VoteTableRow])), [data?.voters])
  const voteRows = useMemo(() => shown.map(voter => rowOf.get(voter)!), [shown, rowOf])
  const tally = data ? selectTally(data) : null

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
        : isLoading || !data || !tally ? <div className="detail-card"><SkeletonRows rows={5} /></div> : (
          <>
            {/* Above the card and right-aligned, matching "Open in preis" on the
                asset page rather than sitting in the detail list. */}
            <div className="ext-link-row">
              <a href={data.subsquareUrl} target="_blank" rel="noopener" className="ext-link">Open in Subsquare ↗</a>
            </div>
            <div className="detail-card">
              <div className="dl">
                <TallySummary tally={tally} voters={data.directTally.voters} decimals={data.asset.decimals} />
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
              rows={voteRows}
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
