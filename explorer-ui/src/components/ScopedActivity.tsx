import {
  useAccountEvents,
  useAccountExtrinsics,
  useAccountActivity,
  useAccountActivityCounts,
  useAccountListCount,
  useAssets,
  useTagActivityCounts,
  useTagEvents,
  useTagExtrinsics,
  useTagActivity,
  useTagListCount,
} from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { setQuery, useQuery, useQueryValue } from '../router'
import { FilterZone, useFilters } from './Filters'
import { EvRow, ExtRow } from './ActivityRows'
import { ActivityTable } from './ActivityTable'
import { eventFilterFields, extrinsicFilterFields, activityFilterFields } from './activityFilters'
import { EmptyRow, ErrorRow, F, Pager, ActivityChips, TableSkeleton, normalizeActivityAction, normalizeActivityType } from './ui'
import { PAGE_SIZE, activityListCount, eventListCount, extrinsicListCount, hasNextPage, pageCount } from '../utils/activityPaging'
import type { ListCountQuery } from '../api/explorer'

type ActivityScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }

// Account and tag detail pages expose the same activity controls. Both APIs are
// queried through disabled hooks here so one implementation owns their filtering,
// pagination, totals, and table layout.
export function ScopedActivity({ scope }: { scope: ActivityScope }) {
  const accountAddress = scope.kind === 'account' ? scope.address : null
  const tagId = scope.kind === 'tag' ? scope.tagId : null
  const now = useNow()
  const accountCounts = useAccountActivityCounts(accountAddress)
  const tagCounts = useTagActivityCounts(tagId)
  const counts = scope.kind === 'account' ? accountCounts : tagCounts
  const rawTab = useQueryValue('atab', 'activity')
  const activeTab = rawTab === 'extrinsics' || rawTab === 'events' ? rawTab : 'activity'
  const activityType = normalizeActivityType(useQueryValue('type', 'all'))
  const filterOptions = { reservedKeys: ['page', 'tab', 'view', 'atab', 'type', 'apage'], pageKey: 'apage' }
  const activityFilters = useFilters({ ...filterOptions, keys: ['action', 'token', 'from', 'to', 'min'] })
  const extrinsicFilters = useFilters({ ...filterOptions, keys: ['call', 'result', 'origin', 'from', 'to'] })
  const eventFilters = useFilters({ ...filterOptions, keys: ['event', 'from', 'to'] })
  const activityAction = normalizeActivityAction(activityType, activityFilters.values.action ?? '')
  const assets = useAssets(false)   // filter options only; the Assets page owns the poll
  const query = useQuery()
  const requestedPage = Number.parseInt(query.get('apage') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const offset = page * PAGE_SIZE
  const minimumUsd = activityFilters.values.min || undefined

  // One exact total per list, under exactly the filters that list is showing —
  // the same builder that produces the rows counts them, so "Page N of M" and the
  // » jump land on real pages. Only the visible tab's total is requested; the
  // activity one walks the whole classified feed and is the page's costliest read.
  const activeCountQuery: ListCountQuery = activeTab === 'activity'
    ? activityListCount(activityType, activityAction, activityFilters.values)
    : activeTab === 'extrinsics'
      ? extrinsicListCount(extrinsicFilters.values)
      : eventListCount(eventFilters.values)
  const accountTotal = useAccountListCount(accountAddress, activeCountQuery)
  const tagTotal = useTagListCount(tagId, activeCountQuery)
  const total = (scope.kind === 'account' ? accountTotal : tagTotal).data?.total
  const totalPages = pageCount(total)
  // null (not undefined) is the API saying this feed is too deep to walk to its
  // end. Say so, rather than leaving the missing "of M" unexplained.
  const countNote = total === null ? 'too much history to count exactly' : undefined
  // The unfiltered activity length doubles as the tab badge. When no filter is
  // set it IS the total above, so the two share one request.
  const accountActivityTotal = useAccountListCount(accountAddress, activityListCount('all', '', {}))
  const tagActivityTotal = useTagListCount(tagId, activityListCount('all', '', {}))
  const activityTotal = (scope.kind === 'account' ? accountActivityTotal : tagActivityTotal).data?.total

  const commonActivityArgs = [
    activityType,
    offset,
    activityAction || undefined,
    activityFilters.values.from,
    activityFilters.values.to,
    { token: activityFilters.values.token, min: minimumUsd },
  ] as const
  const accountActivity = useAccountActivity(activeTab === 'activity' ? accountAddress : null, ...commonActivityArgs)
  const tagActivity = useTagActivity(activeTab === 'activity' ? tagId : null, ...commonActivityArgs)
  const activity = scope.kind === 'account' ? accountActivity : tagActivity
  const activityRows = activity.data ?? []
  const accountExtrinsics = useAccountExtrinsics(
    activeTab === 'extrinsics' ? accountAddress : null,
    offset,
    extrinsicFilters.values.from,
    extrinsicFilters.values.to,
    { call: extrinsicFilters.values.call, result: extrinsicFilters.values.result, origin: extrinsicFilters.values.origin },
  )
  const tagExtrinsics = useTagExtrinsics(
    activeTab === 'extrinsics' ? tagId : null,
    offset,
    extrinsicFilters.values.from,
    extrinsicFilters.values.to,
    { call: extrinsicFilters.values.call, result: extrinsicFilters.values.result, origin: extrinsicFilters.values.origin },
  )
  const extrinsics = scope.kind === 'account' ? accountExtrinsics : tagExtrinsics
  const accountEvents = useAccountEvents(
    activeTab === 'events' ? accountAddress : null,
    offset,
    eventFilters.values.from,
    eventFilters.values.to,
    { event: eventFilters.values.event },
  )
  const tagEvents = useTagEvents(
    activeTab === 'events' ? tagId : null,
    offset,
    eventFilters.values.from,
    eventFilters.values.to,
    { event: eventFilters.values.event },
  )
  const events = scope.kind === 'account' ? accountEvents : tagEvents
  // On-behalf rows (proxy/multisig) carry a real sender and an origin badge;
  // both columns appear only when the account has such history, so ordinary
  // accounts keep the compact layout. Count-driven (not row-presence) so it
  // stays stable across pages/filters and doesn't flash while the rows query
  // resolves before the slower counts query.
  const showOrigin = (counts.data?.extrinsicsOnBehalf ?? 0) > 0
  const showSigner = scope.kind === 'tag' || showOrigin
  const extrinsicColumns = 6 + (showSigner ? 1 : 0) + (showOrigin ? 1 : 0)

  const setActiveTab = (tab: string | null) => setQuery({ atab: tab, apage: null })
  const setActivityType = (value: string) => setQuery({ type: value === 'all' ? null : value, action: null, apage: null })
  const setPage = (nextPage: number) => setQuery({ apage: nextPage > 0 ? String(nextPage) : null })

  return (
    <>
      <div className="tabs">
        <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab(null)}>Activity{activityTotal != null ? <> <span className="cnt">{F.int(activityTotal)}</span></> : null}</button>
        <button className={activeTab === 'extrinsics' ? 'active' : ''} onClick={() => setActiveTab('extrinsics')}>Extrinsics{counts.data ? <> <span className="cnt">{F.int(counts.data.extrinsics)}</span></> : null}</button>
        <button className={activeTab === 'events' ? 'active' : ''} onClick={() => setActiveTab('events')}>Events{counts.data ? <> <span className="cnt">{F.int(counts.data.events)}</span></> : null}</button>
      </div>

      {activeTab === 'activity' && <>
        <ActivityChips value={activityType} onChange={setActivityType} />
        <FilterZone
          fields={activityFilterFields(activityType, assets.data ?? [])}
          values={{ ...activityFilters.values, action: activityAction }}
          onChange={activityFilters.onChange}
          onClear={activityFilters.onClear}
        />
        <ActivityTable rows={activityRows} now={now} live={page === 0} loading={activity.isFetching && !activity.data?.length}
          error={activity.error} onRetry={() => { void activity.refetch() }} />
        <Pager page={page} totalPages={totalPages} hasNext={hasNextPage(totalPages, page, activityRows.length)} note={countNote} onPage={setPage} />
      </>}

      {activeTab === 'extrinsics' && <>
        <FilterZone fields={extrinsicFilterFields(showOrigin)} values={extrinsicFilters.values} onChange={extrinsicFilters.onChange} onClear={extrinsicFilters.onClear} />
        <div className="panel"><table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Call</th>{showSigner && <th>Sender</th>}{showOrigin && <th>Origin</th>}<th className="r">Result</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody>
            {extrinsics.isFetching && !extrinsics.data?.length ? <TableSkeleton cols={extrinsicColumns} />
              : extrinsics.error && !extrinsics.data?.length
                ? <ErrorRow cols={extrinsicColumns} title="Couldn’t load extrinsics" error={extrinsics.error} onRetry={() => { void extrinsics.refetch() }} />
                : !extrinsics.data?.length ? <EmptyRow cols={extrinsicColumns}>No extrinsics</EmptyRow>
                  : extrinsics.data.map(extrinsic => <ExtRow key={`${extrinsic.blockHeight}-${extrinsic.index}`} x={extrinsic} now={now} noSigner={!showSigner} showOrigin={showOrigin} senderLabel />)}
          </tbody>
        </table></div>
        <Pager page={page} totalPages={totalPages} hasNext={hasNextPage(totalPages, page, extrinsics.data?.length ?? 0)} note={countNote} onPage={setPage} />
      </>}

      {activeTab === 'events' && <>
        <FilterZone fields={eventFilterFields} values={eventFilters.values} onChange={eventFilters.onChange} onClear={eventFilters.onClear} />
        <div className="panel"><table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Extrinsic</th><th>Event</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody>
            {events.isFetching && !events.data?.length ? <TableSkeleton cols={6} />
              : events.error && !events.data?.length
                ? <ErrorRow cols={6} title="Couldn’t load events" error={events.error} onRetry={() => { void events.refetch() }} />
                : !events.data?.length ? <EmptyRow cols={6}>No events</EmptyRow>
                  : events.data.map(event => <EvRow key={`${event.blockHeight}-${event.eventIndex}`} e={event} now={now} />)}
          </tbody>
        </table></div>
        <Pager page={page} totalPages={totalPages} hasNext={hasNextPage(totalPages, page, events.data?.length ?? 0)} note={countNote} onPage={setPage} />
      </>}
    </>
  )
}
