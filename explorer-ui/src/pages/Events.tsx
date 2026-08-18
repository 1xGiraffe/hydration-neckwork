import { useEvents, useDaily, useCounts, useFilterNames } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { paths, usePageParam, setPage } from '../router'
import { Crumbs, F, DayBarChart, EmptyRow, TableSkeleton, Pager, pendingRows, LiveAnchor } from '../components/ui'
import { UNFILTERED_COLOR } from '../components/activityColors'
import { EvRow } from '../components/ActivityRows'
import { useNewRows } from '../hooks/useNewRows'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { FilterZone, useFilters } from '../components/Filters'
import { eventFilterFields } from '../components/activityFilters'
import { offeredPages } from '../utils/activityPaging'

const PAGE = 25
export function Events() {
  useDocumentTitle('Events')
  const page = usePageParam()
  const { values: f, onChange, onClear, setDay } = useFilters()
  // isPlaceholderData: rows answering the previous filter/page, held while the new
  // key loads (see pendingRows) — the skeleton gate below cannot catch that case.
  const { data, isFetching, isPlaceholderData, anchorRef } = useEvents(PAGE, f.from, f.to, page * PAGE, { event: f.event })
  const { data: daily } = useDaily('events')
  const { data: counts } = useCounts()
  const { data: names } = useFilterNames()
  const now = useNow()

  const rows = data ?? []
  // Projected pool events share block 0, so their key is transaction hash +
  // index — otherwise two pool transactions' events would collide.
  const rowKey = (e: (typeof rows)[number]) => e.mempool ? `${e.hash}-${e.eventIndex}` : `${e.blockHeight}-${e.eventIndex}`
  const fresh = useNewRows(rows.map(rowKey), page === 0)
  // 302.9M events is 12.1M pages, far past the offset the API serves — skipping N
  // rows reads N rows — so the pager numbers the servable ones and says the rest are
  // there. Any filter makes the unfiltered total the wrong one, leaving no total.
  const pages = offeredPages({
    page,
    rowsOnPage: rows.length,
    rowCount: counts && !f.from && !f.to && !f.event ? counts.events : undefined,
    maxOffset: counts?.maxOffset,
  })

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Events' }]} />
        <div className="page-title">Events <span className="sub">emitted by extrinsics</span></div>
      </div>
      <DayBarChart data={daily ?? []} color={UNFILTERED_COLOR} label="Daily events emitted" selected={f.from === f.to ? f.from : undefined} onSelect={setDay} fmt={F.int} loading={!daily} />
      <FilterZone fields={eventFilterFields(names?.events)} values={f} onChange={(k, v) => { onChange(k, v); setPage(0) }} onClear={onClear} />
      <div className="panel">
        <LiveAnchor anchorRef={anchorRef} />
        <table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Extrinsic</th><th>Event</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody {...pendingRows(isPlaceholderData)}>
            {isFetching && !rows.length ? <TableSkeleton cols={6} mobileCols={5} rows={PAGE} /> : !rows.length ? <EmptyRow cols={6}>No events</EmptyRow> : rows.map(e => <EvRow key={rowKey(e)} e={e} now={now} isNew={fresh.has(rowKey(e))} />)}
          </tbody>
        </table>
        <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={setPage} />
      </div>
    </div>
  )
}
