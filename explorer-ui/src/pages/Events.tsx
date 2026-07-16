import { useEvents, useDaily, useCounts } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { paths, usePageParam, setPage } from '../router'
import { Crumbs, F, DayBarChart, EmptyRow, TableSkeleton, Pager } from '../components/ui'
import { EvRow } from '../components/ActivityRows'
import { useNewRows } from '../hooks/useNewRows'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { FilterZone, useFilters } from '../components/Filters'
import { eventFilterFields } from '../components/activityFilters'

const PAGE = 25
export function Events() {
  useDocumentTitle('Events')
  const page = usePageParam()
  const { values: f, onChange, onClear, setDay } = useFilters()
  const { data, isFetching } = useEvents(PAGE, f.from, f.to, page * PAGE, { event: f.event })
  const { data: daily } = useDaily('events')
  const { data: counts } = useCounts()
  const now = useNow()

  const rows = data ?? []
  const fresh = useNewRows(rows.map(e => `${e.blockHeight}-${e.eventIndex}`), page === 0)
  const totalPages = counts && !f.from && !f.to && !f.event ? Math.ceil(counts.events / PAGE) : undefined

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Events' }]} />
        <div className="page-title">Events <span className="sub">emitted by extrinsics</span></div>
      </div>
      <DayBarChart data={daily ?? []} label="Daily events emitted" selected={f.from === f.to ? f.from : undefined} onSelect={setDay} fmt={F.int} loading={!daily} />
      <FilterZone fields={eventFilterFields} values={f} onChange={(k, v) => { onChange(k, v); setPage(0) }} onClear={onClear} />
      <div className="panel">
        <table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Extrinsic</th><th>Event</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody>
            {isFetching && !rows.length ? <TableSkeleton cols={6} /> : !rows.length ? <EmptyRow cols={6}>No events</EmptyRow> : rows.map(e => <EvRow key={`${e.blockHeight}-${e.eventIndex}`} e={e} now={now} isNew={fresh.has(`${e.blockHeight}-${e.eventIndex}`)} />)}
          </tbody>
        </table>
        <Pager page={page} totalPages={totalPages} hasNext={(data?.length ?? 0) === PAGE} onPage={setPage} />
      </div>
    </div>
  )
}
