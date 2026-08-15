import { useBlocks, useStats, useCounts } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useNewRows } from '../hooks/useNewRows'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, usePageParam, setPage } from '../router'
import { Crumbs, F, FinalizedBadge, AddrPill, AreaChart, ChartCardSkeleton, TableSkeleton, EmptyRow, Pager, rowNav, Ago, Dash, pendingRows, LiveAnchor } from '../components/ui'
import { UNFILTERED_COLOR } from '../components/activityColors'
import { parseUtcTimestamp } from '../utils/time'
import { blockSeconds } from '../utils/dca'
import { offeredPages } from '../utils/activityPaging'

const PAGE = 25
// A gap this long is a relay-backing stall, not a block time: it belongs in
// neither the average nor the plot. Relay backing does not get quicker when the
// parachain does, so the bound is wall-clock seconds rather than a block count.
const MAX_GAP_SECONDS = 600
// The plot clamps at this multiple of the typical block, so a single 30s stall
// cannot flatten the normal line into the baseline. Taken against the MEASURED
// pace, the chart keeps exactly this shape when block time changes — at ~6s the
// ceiling is ~18s, at 2s it is ~6s.
const CLAMP_FACTOR = 3

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
  // Rows still answering the previous page while the next loads (see pendingRows).
  // Page one is a slice of the always-live recent query, so only deeper pages hold.
  const pending = page > 0 && pageQuery.isPlaceholderData
  const stats = useStats()
  const { data: counts } = useCounts()
  const now = useNow()

  const rows = data ?? []
  const fresh = useNewRows(rows.map(b => String(b.height)), page === 0)

  // Inter-block times (recent window, page-independent). Hydration mostly runs
  // at its scheduled pace with occasional relay-backing stalls (30s+); the chart
  // clamps outliers and pins its baseline to 0 so the normal line stays visible.
  const byHeight = [...(recent ?? [])].sort((a, b) => a.height - b.height)
  const deltas: number[] = []
  for (let i = 1; i < byHeight.length; i++) {
    if (byHeight[i].height - byHeight[i - 1].height !== 1) continue
    const d = (parseUtcTimestamp(byHeight[i].timestamp) - parseUtcTimestamp(byHeight[i - 1].timestamp)) / 1000
    if (d > 0 && d < MAX_GAP_SECONDS) deltas.push(d)
  }
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0
  // The reference line is the window's own median block, not a fixed target: the
  // chain publishes no target block time, and a hard-coded one is wrong for every
  // era but the one it was written in (blocks have run at 12s, run at ~6s and are
  // heading for 2s). The median is the typical block — a stall lifts the average
  // above it and leaves it where it is, which is exactly what the line is for.
  const sorted = [...deltas].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = !sorted.length ? 0 : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  // Before two consecutive blocks are in the window there is no median to draw,
  // so the chain's measured pace scales the placeholder.
  const pace = median || blockSeconds(stats.data?.avgBlockSec)
  const chartData = deltas.map(d => Math.min(d, pace * CLAMP_FACTOR))
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: counts?.blocks, maxOffset: counts?.maxOffset })

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Blocks' }]} />
        <div className="page-title">Blocks <span className="sub">{stats.data ? F.int(stats.data.headBlock) + ' indexed head' : ''}</span></div>
      </div>

      <div className="sec-title">Average block time</div>
      {/* One trailing figure (the median beside the average), so the placeholder
          is the loaded card's own chrome around a 220px plot. It used to reserve
          168px against a 309px card, dropping the block table 141px the moment
          the series landed — this page's whole layout shift. */}
      {!recent ? <ChartCardSkeleton metrics={1} /> : (
      <div className="pf-card">
        <div className="pf-head"><div className="pf-now" title="Mean gap between consecutive blocks in the recent window">mean {avg ? avg.toFixed(2) + 's' : '—'}</div><div className="pf-chg muted" title="The typical block: half the window is quicker, half slower. A stall lifts the mean and leaves this where it is.">median {median ? median.toFixed(2) + 's' : '—'}</div></div>
        <AreaChart data={chartData.length > 1 ? chartData : [pace, pace]} h={120} target={pace} floor={0} color={UNFILTERED_COLOR} valueFmt={v => v.toFixed(2) + 's'} />
      </div>
      )}

      <div className="panel">
        {/* Page one renders the always-live recent query, so that is the list whose
            top edge decides whether an arrival lands or waits. */}
        <LiveAnchor anchorRef={recentQuery.anchorRef} />
        <table className="tbl">
          <thead><tr><th>Block</th><th>Status</th><th className="r">Extrinsics</th><th className="r">Events</th><th>Collator</th><th className="r">Time</th></tr></thead>
          <tbody {...pendingRows(pending)}>
            {isLoading && !data ? <TableSkeleton cols={6} rows={PAGE} /> : !rows.length ? <EmptyRow cols={6}>No blocks</EmptyRow> : rows.map(b => (
              <tr key={b.height} {...rowNav(paths.block(b.height))} title={b.finalized === false ? 'Awaiting finality — may still reorganize' : undefined} className={['clickable', fresh.has(String(b.height)) ? 'row-new' : '', b.finalized === false ? 'unfinalized' : ''].filter(Boolean).join(' ')}>
                <td data-label="Block" className="mono"><Link to={paths.block(b.height)} className="hash">{F.int(b.height)}</Link></td>
                <td data-label="Status"><FinalizedBadge finalized={b.finalized !== false && b.height <= (stats.data?.finalizedBlock ?? b.height)} /></td>
                <td data-label="Extrinsics" className="r mono">{b.extrinsicCount}</td>
                <td data-label="Events" className="r mono">{b.eventCount}</td>
                <td data-label="Collator">{b.author ? <AddrPill account={b.author} noCopy /> : <Dash />}</td>
                <td data-label="Time" className="r mono muted"><Ago ts={b.timestamp} now={now} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={setPage} />
      </div>
    </div>
  )
}
