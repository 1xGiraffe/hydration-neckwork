import { useDcaExecution, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, F, AddrPill, AssetChip, AssetAmount, StatusBadge, FinalizedBadge, FailureReasonRow, SkeletonRows, Ago } from '../components/ui'
import { DcaResolve } from './DcaSchedule'

// One DCA execution attempt: the block/time it ran, the swap it performed (or,
// for a failed attempt, the intended sell and the decoded failure reason), and
// a link up to its owning schedule.
export function DcaExecution({ height, eventIndex }: { height: number; eventIndex: number }) {
  const { data, isLoading, isError } = useDcaExecution(height, eventIndex)
  const { data: stats } = useStats(!!data)
  const now = useNow()
  useDocumentTitle(`DCA execution ${height}-e${eventIndex}`)

  // Legacy event-form links carried the swap event index, not the DCA event
  // index, so nothing resolves exactly there — fall back to the schedule
  // resolver (old behavior) rather than dead-ending.
  if (isError) return <DcaResolve height={height} index={eventIndex} kind="event" />

  const crumbs = [
    { label: 'Home', to: paths.dashboard() },
    { label: 'Activity', to: paths.activity() + '?tab=trade' },
    ...(data ? [{ label: `DCA #${data.scheduleId}`, to: paths.dcaSchedule(data.scheduleId) }] : []),
    { label: `${height}-e${eventIndex}` },
  ]

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={crumbs} />
        <div className="page-title">DCA execution <span className="num">{height}-e{eventIndex}</span>
          {data && <span className="sub">{data.status === 'failed' ? 'failed attempt' : 'executed'}</span>}
        </div>
      </div>

      {isLoading || !data ? <div className="detail-card"><SkeletonRows rows={5} /></div> : (
        <div className="detail-card"><div className="dl">
          <div className="dt">Schedule</div><div className="dd"><Link to={paths.dcaSchedule(data.scheduleId)} className="hash">DCA #{data.scheduleId}</Link></div>
          <div className="dt">Result</div><div className="dd"><StatusBadge ok={data.status === 'executed'} /></div>
          {data.status === 'failed' && data.failureReason && <FailureReasonRow reason={data.failureReason} />}
          <div className="dt">{data.status === 'failed' ? 'Attempted' : 'Swap'}</div>
          <div className="dd"><span className="asset-flow">
            <AssetAmount asset={data.assetIn} raw={data.amountIn} />
            {data.amountOut != null && <> → <AssetAmount asset={data.assetOut} raw={data.amountOut} /></>}
          </span></div>
          {data.valueUsd != null && <><div className="dt">Value</div><div className="dd mono">{F.usd(data.valueUsd)}</div></>}
          {data.executionPrice != null && <>
            <div className="dt">Execution price</div>
            <div className="dd"><span className="asset-flow">
              <span className="trade-leg"><AssetChip asset={data.assetIn} /> <span className="mono">1</span></span>
              {' = '}
              <span className="trade-leg"><AssetChip asset={data.assetOut} /> <span className="mono">{data.executionPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })}</span></span>
            </span></div>
          </>}
          {data.who && <><div className="dt">Owner</div><div className="dd"><AddrPill account={data.who} /></div></>}
          <div className="dt">Timestamp</div><div className="dd mono">{F.datetime(data.timestamp)} <span className="muted">· <Ago ts={data.timestamp} now={now} /></span></div>
          <div className="dt">Block</div><div className="dd mono"><Link to={paths.block(data.blockHeight)} className="hash">{F.int(data.blockHeight)}</Link> <FinalizedBadge finalized={data.blockHeight <= (stats?.finalizedBlock ?? -1)} /></div>
          <div className="dt">Event</div><div className="dd mono"><Link to={paths.event(`${data.blockHeight}-${data.eventIndex}`)} className="hash">{data.blockHeight}-{data.eventIndex}</Link></div>
          {data.extrinsicIndex != null && <><div className="dt">Extrinsic</div><div className="dd mono"><Link to={paths.extrinsic(`${data.blockHeight}-${data.extrinsicIndex}`)} className="hash">{data.blockHeight}-{data.extrinsicIndex}</Link></div></>}
        </div></div>
      )}
    </div>
  )
}
