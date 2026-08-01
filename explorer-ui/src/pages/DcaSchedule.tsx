import { Fragment, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useDcaSchedule, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, redirect } from '../router'
import { Ago, Crumbs, F, AddrPill, AssetChip, AssetAmount, PoolBadge, ProgressRing, SkeletonRows, MomentLink, Pager } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { estimateBlockCountdown } from '../utils/blockCountdown'
import { blockSeconds, dcaCadence, dcaProgress, dcaRunway, dcaUnspentBudget, fmtDuration, fmtPermill } from '../utils/dca'
import type { DcaScheduleDetail } from '../types'

const PAGE = 25

// The order in one sentence, the way its owner would say it: what it trades, how
// much of it, and how often — cadence as a duration, with the block count that
// produces it kept as the footnote it is.
function OrderLine({ data, cadence }: { data: DcaScheduleDetail; cadence: number }) {
  const every = <span className="dca-every">every {fmtDuration(cadence)}</span>
  return (
    <div className="dca-order">
      {/* amountPer follows the order type: a Sell fixes the sold amount, a Buy
          fixes the bought amount. */}
      {data.direction === 'Buy'
        ? <>buys <AssetAmount asset={data.assetOut} raw={data.amountPer} /> with <AssetChip asset={data.assetIn} /> {every}</>
        : <>sells <AssetAmount asset={data.assetIn} raw={data.amountPer} /> → <AssetChip asset={data.assetOut} /> {every}</>}
    </div>
  )
}

const STATUS_TONE: Record<DcaScheduleDetail['status'], string> = {
  active: 'var(--green)', completed: 'var(--sky)', terminated: 'var(--red)', cancelled: 'var(--text-low)',
}

// The dollar figure beside a planned amount. A live schedule still has that money
// to spend, so it is priced today; a finished one is priced at the day it stopped
// — the era its own executions traded in — and says "then" so the number is never
// read as current.
function Usd({ value, basis, at }: { value: number | null; basis: DcaScheduleDetail['usdBasis']; at: string }) {
  if (value == null) return null
  const historical = basis === 'ended'
  return (
    <span className="muted mono" title={historical ? `At the ${at.slice(0, 16)} price, when this schedule stopped` : 'At today’s price'}>
      {' · '}{F.usd(value)}{historical && <span className="dca-then"> then</span>}
    </span>
  )
}

// A DCA is a schedule, not a single fill. The page reads in the order the
// schedule lives: what it does and how far it has got (the hero), the plan it is
// working through, where it stands right now, who set it up and when, and
// finally every execution it has attempted.
export function DcaSchedule({ scheduleId }: { scheduleId: number }) {
  const [page, setPage] = useState(0)
  const { data, isLoading, isError } = useDcaSchedule(scheduleId, page * PAGE)
  const active = data?.status === 'active'
  const { data: stats } = useStats(!!active)
  const now = useNow()
  useDocumentTitle(`DCA #${scheduleId}`)

  // An open-ended order has no budget to be a fraction of, so its progress and
  // its end are projected from the wallet still funding it.
  const progress = data
    ? dcaProgress(data.totalAmount, data.executions.totalIn, data.fundingBalance)
    : { pct: null, projected: false }
  const pct = progress.pct
  // How often this order really fires. Measured from its own executions wherever
  // it has any, so a schedule from the 12s era — or one that lived through a
  // block-time change and was migrated onto a new period — reads at the pace it
  // actually ran, not at today's seconds-per-block.
  const cadence = data ? dcaCadence(data.periodSeconds, data.period, stats?.avgBlockSec) : null
  // The next planned block is the only live anchor a schedule has; its countdown
  // also starts the estimate of how long the rest of the budget takes. A distance
  // to a specific future block is the one place the chain's CURRENT pace is the
  // right rate, whatever this schedule averaged over its life.
  const countdown = active && data?.nextExecutionBlock && stats?.headBlock
    ? estimateBlockCountdown(data.nextExecutionBlock, stats.headBlock, stats.headTime, now, blockSeconds(stats.avgBlockSec))
    : null
  const runway = active && data && cadence
    ? dcaRunway({
      direction: data.direction, amountPer: data.amountPer, totalAmount: data.totalAmount,
      filledAmount: data.executions.totalIn, executionsDone: data.executions.count,
      periodSeconds: cadence.seconds, secondsToNext: countdown?.secondsUntil ?? null,
      fundingBalance: data.fundingBalance,
    })
    : null
  // Only worth stating where the ring visibly falls short of full — which is the
  // one case a reader has to explain to themselves (see dcaUnspentBudget).
  const unspent = data && !active && pct != null && Math.round(pct) < 100
    ? dcaUnspentBudget(data.totalAmount, data.executions.totalIn)
    : null

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity', to: paths.activity() + '?tab=trade' }, { label: `DCA #${scheduleId}` }]} />
        <div className="page-title">DCA #{scheduleId}
          {data && <span className="sub">{data.status === 'active' ? 'active' : `${data.status}${data.statusReason ? ' · ' + data.statusReason : ''}${data.statusAt ? ' · ' + data.statusAt.slice(0, 10) : ''}`}</span>}
        </div>
      </div>
      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>DCA schedule not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows rows={5} /></div> : (
          <>
            <div className="detail-card dca-card">
              {/* Hero: the order, its progress, and the one number a reader of an
                  active schedule came for — when it fires next. */}
              <div className="dca-hero">
                <ProgressRing
                  pct={pct} size={62} stroke={5}
                  label={pct != null
                    ? <span className="pr-pct">{Math.round(pct)}<span className="pr-unit">%</span></span>
                    : <span className="pr-runs mono">{F.int(data.executions.count)}×</span>}
                  title={pct == null ? 'Open-ended schedule — no budget and no balance to project against'
                    : progress.projected ? `${pct.toFixed(1)}% of what it has spent plus what the owner’s balance still funds`
                      : `${pct.toFixed(1)}% of the budget spent`}
                />
                <div className="dca-hero-body">
                  <OrderLine data={data} cadence={cadence?.seconds ?? 0} />
                  <div className="dca-hero-facts">
                    <span className="dca-state" style={{ color: STATUS_TONE[data.status] }}>● {data.status}</span>
                    {/* Separators are drawn by CSS between the facts that survive, so
                        a wrap never strands a dangling "·" at the end of a line. */}
                    {countdown && <span>{countdown.secondsUntil > 0
                      ? <>next in <span className="mono">{fmtDuration(countdown.secondsUntil, { seconds: true })}</span></>
                      : <span title="Its planned block is at the head — the trade is awaiting its turn">next trade due</span>}</span>}
                    {runway && runway.trades > 0 && <span title={runway.funded
                      ? 'Projected from the owner’s current balance of the sold asset — a top-up extends it'
                      : runway.estimated
                        ? 'Estimated from what this order has spent per trade so far — a Buy order fixes what it buys, not what it costs'
                        : 'At this order\'s per-trade amount and cadence'}>
                      {runway.estimated ? '~' : ''}<span className="mono">{fmtDuration(runway.seconds)}</span> left
                    </span>}
                    {/* A schedule still running knows roughly how many trades it is
                        going to be; a finished one just knows how many it was. */}
                    {runway && runway.trades > 0
                      ? <span className="muted"><span className="mono">{F.int(data.executions.count)}</span> of ~<span className="mono">{F.int(data.executions.count + runway.trades)}</span> trades</span>
                      : <span className="muted"><span className="mono">{F.int(data.executions.count)}</span> {data.executions.count === 1 ? 'trade' : 'trades'}</span>}
                  </div>
                </div>
              </div>

              <div className="dl">
                {/* The plan */}
                <div className="dt">Every</div>
                <div className="dd" title={cadence?.measured
                  ? 'Measured from the gaps between this schedule\u2019s own trades, so it holds for the block time of the era it ran in'
                  : 'Estimated from the chain\u2019s current block time \u2014 this schedule has not run twice yet'}>
                  <span className="mono">{cadence?.measured ? '' : '~'}{fmtDuration(cadence?.seconds ?? 0)}</span>
                  <span className="muted mono dca-blocks">· {F.int(data.period)} blocks</span>
                </div>
                <div className="dt">Per trade</div>
                <div className="dd"><AssetAmount asset={data.direction === 'Buy' ? data.assetOut : data.assetIn} raw={data.amountPer} />
                  <Usd value={data.amountPerUsd} basis={data.usdBasis} at={data.statusAt ?? data.createdAt.timestamp} />
                  {data.direction === 'Buy' && <span className="muted"> (bought)</span>}
                </div>
                <div className="dt">Budget</div>
                {/* The funding balance is plain text, not an asset chip: a 20px icon
                    mid-sentence sets its own line height and lifts the words around
                    it out of line. The sold asset is named in the row above. */}
                <div className="dd">{data.totalAmount === '0'
                  ? <span className="mono muted">open-ended — runs until stopped or unfunded
                    {data.fundingBalance != null && <> · funded by {F.amount(data.fundingBalance, data.assetIn.decimals)} {data.assetIn.symbol} in the wallet</>}
                  </span>
                  : <><AssetAmount asset={data.assetIn} raw={data.totalAmount} />
                    <Usd value={data.budgetUsd} basis={data.usdBasis} at={data.statusAt ?? data.createdAt.timestamp} /></>}
                </div>

                {/* The limits the order trades under, most-tuned first: slippage is
                    the one an owner sets per schedule, then the absolute bound, then
                    what happens when a trade misses them. Two different limits, so
                    each is named for what it bounds — slippage is per trade and
                    relative to the oracle price, the min/max is absolute and fixed
                    for the schedule's whole life.
                    Every one of these is omitted rather than shown as a zero when it
                    is absent, and absent has three causes: an Option the schedule
                    left unset, an EVM permit whose inner call is not indexed, and —
                    for the bound — a deliberate zero, which is no bound at all. */}
                {data.slippagePermill != null && <>
                  <div className="dt">Slippage</div>
                  <div className="dd"><span className="mono">{fmtPermill(data.slippagePermill)}</span>
                    <span className="muted"> · allowed per trade, against the oracle price</span>
                  </div>
                </>}
                {(data.minAmountOut ?? data.maxAmountIn) && <>
                  <div className="dt">{data.direction === 'Buy' ? 'Max paid' : 'Min received'}</div>
                  <div className="dd">
                    <AssetAmount
                      asset={data.direction === 'Buy' ? data.assetIn : data.assetOut}
                      raw={(data.direction === 'Buy' ? data.maxAmountIn : data.minAmountOut) as string} />
                    <span className="muted"> · per trade, or it fails</span>
                  </div>
                </>}
                {data.maxRetries != null && <>
                  <div className="dt">Retries</div>
                  <div className="dd"><span className="mono">{F.int(data.maxRetries)}</span>
                    <span className="muted"> · attempts after a failed trade before the schedule is terminated</span>
                  </div>
                </>}

                {/* The route is not one of those limits — it is the path itself, and
                    the only row here that draws rather than states — so it sits after
                    them rather than among them. */}
                {data.route && <>
                  <div className="dt">Route</div>
                  <div className="dd">{data.route.length === 0
                    ? <span className="muted">chosen per trade by the router</span>
                    : <span className="asset-flow dca-route">
                      <AssetChip asset={data.route[0].assetIn} />
                      {data.route.map((hop, i) => (
                        <Fragment key={`${hop.pool}-${hop.assetIn.assetId}-${hop.assetOut.assetId}-${i}`}>
                          <PoolBadge pool={hop.pool} poolId={hop.poolId} />
                          <AssetChip asset={hop.assetOut} />
                        </Fragment>
                      ))}
                    </span>}
                  </div>
                </>}

                {/* Where it stands */}
                <div className="dt">Traded</div>
                <div className="dd"><span className="asset-flow"><AssetAmount asset={data.assetIn} raw={data.executions.totalIn} /> → <AssetAmount asset={data.assetOut} raw={data.executions.totalOut} /></span>
                  <span className="muted mono"> · {F.int(data.executions.count)} {data.executions.count === 1 ? 'trade' : 'trades'}</span>
                  {data.executions.failed > 0 && <span style={{ color: 'var(--red)' }} className="mono"> · {F.int(data.executions.failed)} failed</span>}
                </div>
                {unspent && <>
                  <div className="dt">Unspent</div>
                  <div className="dd"><AssetAmount asset={data.assetIn} raw={unspent} />
                    <span className="muted"> · {data.status === 'completed'
                      ? 'left of the budget, released when the schedule closed — too little to fund another trade'
                      : 'left of the budget, released when the schedule ended'}</span>
                  </div>
                </>}
                {countdown && data.nextExecutionBlock && <>
                  <div className="dt">Next trade</div>
                  <div className="dd"><span className="mono">{countdown.secondsUntil > 0 ? `in ${fmtDuration(countdown.secondsUntil, { seconds: true })}` : 'due'}</span>
                    <span className="muted mono dca-blocks"> · block <Link to={paths.block(data.nextExecutionBlock)} className="hash">{F.int(data.nextExecutionBlock)}</Link></span>
                    <span className="muted"> · ~{new Date(countdown.etaMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </>}
                {runway && runway.trades > 0 && <>
                  <div className="dt">{runway.funded ? 'Balance lasts' : 'Runs out in'}</div>
                  <div className="dd"><span className="mono">{runway.estimated ? '~' : ''}{fmtDuration(runway.seconds)}</span>
                    <span className="muted"> · {runway.estimated ? 'about ' : ''}{F.int(runway.trades)} more {runway.trades === 1 ? 'trade' : 'trades'}
                      {runway.funded
                        ? ', at the owner’s current balance — a top-up extends it'
                        : runway.estimated ? ', averaged from what it has spent so far' : ''}</span>
                  </div>
                </>}

                {/* Who and when */}
                <div className="dt">Owner</div><div className="dd">{data.who ? <AddrPill account={data.who} /> : '—'}</div>
                <div className="dt">Started</div><div className="dd mono"><MomentLink at={data.createdAt} now={now} /></div>
                {data.statusAt && <>
                  <div className="dt">{data.status === 'completed' ? 'Completed' : 'Ended'}</div>
                  {/* statusAt is a chain timestamp with no block of its own, so it
                      cannot use MomentLink — but it reads like every other moment
                      on the page: how long ago, with the date behind it. */}
                  <div className="dd mono"><Ago ts={data.statusAt} now={now} />
                    <span className="muted"> · {data.statusAt.slice(0, 16).replace(' ', ' · ')}</span>
                    {data.statusReason && <span className="muted"> · {data.statusReason}</span>}
                  </div>
                </>}
              </div>
            </div>

            <div className="sec-title" style={{ marginTop: 22 }}>Executions <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>· newest first</span></div>
            <ActivityTable rows={data.rows} now={now} noActor dcaExecutionLinks />
            <Pager page={page} totalPages={Math.max(1, Math.ceil(data.executions.attempts / PAGE))} hasNext={(page + 1) * PAGE < data.executions.attempts} onPage={setPage} />
          </>
        )}
    </div>
  )
}

// Legacy per-execution links (/dca/<height>-<index>, /dca/<height>-e<index>)
// resolve to the owning schedule; anything unresolvable lands on the raw
// event/extrinsic page instead of a dead end.
export function DcaResolve({ height, index, kind }: { height: number; index: number; kind: 'event' | 'extrinsic' }) {
  const q = useQuery({ queryKey: ['dca-at', height, index, kind], queryFn: ({ signal }) => api.dcaScheduleAt(height, index, kind, signal), retry: false, staleTime: 60_000 })
  useEffect(() => {
    if (q.data) redirect(paths.dcaSchedule(q.data.scheduleId))
    else if (q.isError) redirect(kind === 'event' ? `/event/${height}-${index}` : `/extrinsic/${height}-${index}`)
  }, [q.data, q.isError, height, index, kind])
  return <div className="wrap"><div className="detail-card"><SkeletonRows rows={3} /></div></div>
}
