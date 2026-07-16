import { useBlocks, useStats, useCounts } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useNewRows } from '../hooks/useNewRows'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, usePageParam, setPage } from '../router'
import { Crumbs, F, FinalizedBadge, AddrPill, AreaChart, ChartSkeleton, TableSkeleton, EmptyRow, Pager, rowNav, Ago, Dash } from '../components/ui'
import { parseUtcTimestamp } from '../utils/time'

const PAGE = 25

export function Blocks() {
  useDocumentTitle('Blocks')
  const page = usePageParam()
  // Page one is a slice of the same recent-block query that feeds the chart:
  // reusing it keeps this to one live query per poll rather than two.
  const pageQuery = useBlocks(PAGE, page * PAGE, page > 0)
  const recentQuery = useBlocks(60, 0)
  const recent = recentQuery.data
  const data = page === 0 ? recent?.slice(0, PAGE) : pageQuery.data
  const isLoading = page === 0 ? recentQuery.isLoading : pageQuery.isLoading
  const stats = useStats()
  const { data: counts } = useCounts()
  const now = useNow()

  const rows = data ?? []
  const fresh = useNewRows(rows.map(b => String(b.height)), page === 0)

  // Inter-block times (recent window, page-independent). Hydration mostly runs
  // fast (~3-6s) with occasional relay-backing stalls (30s+); the chart clamps
  // outliers and pins its baseline to 0 so the normal line stays visible.
  const byHeight = [...(recent ?? [])].sort((a, b) => a.height - b.height)
  const deltas: number[] = []
  for (let i = 1; i < byHeight.length; i++) {
    if (byHeight[i].height - byHeight[i - 1].height !== 1) continue
    const d = (parseUtcTimestamp(byHeight[i].timestamp) - parseUtcTimestamp(byHeight[i - 1].timestamp)) / 1000
    if (d > 0 && d < 600) deltas.push(d)
  }
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0
  const chartData = deltas.map(d => Math.min(d, 18))
  const totalPages = counts ? Math.ceil(counts.blocks / PAGE) : undefined

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Blocks' }]} />
        <div className="page-title">Blocks <span className="sub">{stats.data ? F.int(stats.data.headBlock) + ' indexed head' : ''}</span></div>
      </div>

      <div className="sec-title">Average block time</div>
      {!recent ? <ChartSkeleton h={168} /> : (
      <div className="pf-card">
        <div className="pf-head"><div className="pf-now">{avg ? avg.toFixed(2) + 's' : '—'}</div><div className="pf-chg muted">target 6.00s</div></div>
        <AreaChart data={chartData.length > 1 ? chartData : [6, 6]} h={120} target={6} floor={0} color="var(--lavender-deep)" valueFmt={v => v.toFixed(2) + 's'} />
      </div>
      )}

      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Block</th><th>Status</th><th className="r">Extrinsics</th><th className="r">Events</th><th>Collator</th><th className="r">Time</th></tr></thead>
          <tbody>
            {isLoading && !data ? <TableSkeleton cols={6} /> : !rows.length ? <EmptyRow cols={6}>No blocks</EmptyRow> : rows.map(b => (
              <tr key={b.height} {...rowNav(paths.block(b.height))} className={['clickable', fresh.has(String(b.height)) ? 'row-new' : ''].filter(Boolean).join(' ')}>
                <td data-label="Block" className="mono"><Link to={paths.block(b.height)} className="hash">{F.int(b.height)}</Link></td>
                <td data-label="Status"><FinalizedBadge finalized={b.height <= (stats.data?.finalizedBlock ?? b.height)} /></td>
                <td data-label="Extrinsics" className="r mono">{b.extrinsicCount}</td>
                <td data-label="Events" className="r mono">{b.eventCount}</td>
                <td data-label="Collator">{b.author ? <AddrPill account={b.author} noCopy /> : <Dash />}</td>
                <td data-label="Time" className="r mono muted"><Ago ts={b.timestamp} now={now} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} totalPages={totalPages} hasNext={rows.length === PAGE} onPage={setPage} />
      </div>
    </div>
  )
}
