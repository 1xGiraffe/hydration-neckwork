import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useDcaSchedule } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, redirect } from '../router'
import { Crumbs, F, AddrPill, AssetChip, AssetAmount, SkeletonRows, Ago, Pager } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'

const PAGE = 25

// A DCA is a schedule, not a single fill: this page shows how it was initiated
// (owner, order, budget, cadence) and every execution it has performed so far.
export function DcaSchedule({ scheduleId }: { scheduleId: number }) {
  const [page, setPage] = useState(0)
  const { data, isLoading, isError } = useDcaSchedule(scheduleId, page * PAGE)
  const now = useNow()
  useDocumentTitle(`DCA #${scheduleId}`)
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity', to: paths.activity() + '?tab=trade' }, { label: `DCA #${scheduleId}` }]} />
        <div className="page-title">DCA #{scheduleId}
          {data && <span className="sub">{data.status === 'active' ? 'active' : `${data.status}${data.statusAt ? ' · ' + data.statusAt.slice(0, 10) : ''}`}</span>}
        </div>
      </div>
      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>DCA schedule not found</div>
        : isLoading || !data ? <div className="detail-card"><SkeletonRows rows={5} /></div> : (
          <>
            <div className="detail-card">
              <div className="dl">
                <div className="dt">Owner</div><div className="dd">{data.who ? <AddrPill account={data.who} /> : '—'}</div>
                <div className="dt">Initiated</div><div className="dd mono">
                  <Link to={paths.block(data.createdAt.blockHeight)} className="hash">{F.int(data.createdAt.blockHeight)}</Link>
                  {data.createdAt.extrinsicIndex != null && <> · <Link to={paths.extrinsic(`${data.createdAt.blockHeight}-${data.createdAt.extrinsicIndex}`)} className="hash">{data.createdAt.blockHeight}-{data.createdAt.extrinsicIndex}</Link></>}
                  {' '}· <Ago ts={data.createdAt.timestamp} now={now} />
                </div>
                <div className="dt">Order</div><div className="dd">
                  sells <AssetAmount asset={data.assetIn} raw={data.amountPer} /> → <AssetChip asset={data.assetOut} /> every <span className="mono">{data.period}</span> blocks
                </div>
                <div className="dt">Budget</div><div className="dd">{data.totalAmount === '0'
                  ? <span className="mono">open-ended (runs until stopped or unfunded)</span>
                  : <><AssetAmount asset={data.assetIn} raw={data.totalAmount} />{Number(data.totalAmount) > 0 && <span className="muted"> · {Math.min(100, Number(data.executions.totalIn) / Number(data.totalAmount) * 100).toFixed(0)}% filled</span>}</>}</div>
                <div className="dt">Executed</div><div className="dd">{F.int(data.executions.count)} trades · <AssetAmount asset={data.assetIn} raw={data.executions.totalIn} /> → <AssetAmount asset={data.assetOut} raw={data.executions.totalOut} />{data.executions.failed > 0 && <> · <span style={{ color: 'var(--red)' }}>{F.int(data.executions.failed)} failed {data.executions.failed === 1 ? 'attempt' : 'attempts'}</span></>}</div>
              </div>
            </div>

            <div className="sec-title" style={{ marginTop: 22 }}>Executions <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>· newest first</span></div>
            <ActivityTable rows={data.rows} now={now} noActor />
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
