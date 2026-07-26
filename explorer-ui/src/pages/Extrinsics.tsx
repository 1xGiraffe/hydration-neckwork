import { useExtrinsics, useDaily, useCounts } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { paths, usePageParam, setPage } from '../router'
import { Crumbs, F, DayBarChart, EmptyRow, TableSkeleton, Pager } from '../components/ui'
import { UNFILTERED_COLOR } from '../components/activityColors'
import { ExtRow } from '../components/ActivityRows'
import { useNewRows } from '../hooks/useNewRows'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { FilterZone, useFilters } from '../components/Filters'
import { extrinsicFilterFields } from '../components/activityFilters'
import { offeredPages } from '../utils/activityPaging'

const PAGE = 25
export function Extrinsics() {
  useDocumentTitle('Extrinsics')
  const page = usePageParam()
  const { values: f, onChange, onClear, setDay } = useFilters()
  const { data, isFetching } = useExtrinsics(PAGE, true, f.from, f.to, page * PAGE, { call: f.call, result: f.result })
  const { data: daily } = useDaily('extrinsics')
  const { data: counts } = useCounts()
  const now = useNow()

  const rows = data ?? []
  const fresh = useNewRows(rows.map(x => `${x.blockHeight}-${x.index}`), page === 0)
  // counts.extrinsics is the signed total, matching this list's signedOnly read. Any
  // filter makes it the wrong total, and then the pager walks a page at a time
  // instead of numbering pages that may not exist.
  const pages = offeredPages({
    page,
    rowsOnPage: rows.length,
    rowCount: counts && !f.from && !f.to && !f.call && !f.result ? counts.extrinsics : undefined,
    maxOffset: counts?.maxOffset,
  })

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Extrinsics' }]} />
        <div className="page-title">Extrinsics <span className="sub">signed calls</span></div>
      </div>
      <DayBarChart data={daily ?? []} color={UNFILTERED_COLOR} label="Daily signed extrinsics" selected={f.from === f.to ? f.from : undefined} onSelect={setDay} fmt={F.int} loading={!daily} />
      <FilterZone fields={extrinsicFilterFields()} values={f} onChange={(k, v) => { onChange(k, v); setPage(0) }} onClear={onClear} />
      <div className="panel">
        <table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Call</th><th>Signer</th><th className="r">Result</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody>
            {isFetching && !rows.length ? <TableSkeleton cols={7} /> : !rows.length ? <EmptyRow cols={7}>No extrinsics</EmptyRow> : rows.map(x => <ExtRow key={`${x.blockHeight}-${x.index}`} x={x} now={now} isNew={fresh.has(`${x.blockHeight}-${x.index}`)} />)}
          </tbody>
        </table>
        <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={setPage} />
      </div>
    </div>
  )
}
