import {
  useAccountEvents,
  useAccountExtrinsics,
  useAccountActivity,
  useAccountActivityCounts,
  useAccountListCount,
  useAssetFilterOptions,
  useTagActivityCounts,
  useTagEvents,
  useTagExtrinsics,
  useTagActivity,
  useTagListCount,
} from '../hooks/useExplorerData'
import {
  useListTagActivityCounts, useListTagListCount, useListTagActivity, useListTagExtrinsics, useListTagEvents,
} from '../hooks/useUser'
import { useNow } from '../hooks/useNow'
import { setQuery, useQuery, useQueryValue } from '../router'
import { FilterZone, useFilters } from './Filters'
import { EvRow, ExtRow } from './ActivityRows'
import { ActivityTable } from './ActivityTable'
import { eventFilterFields, extrinsicFilterFields, activityFilterFields } from './activityFilters'
import { EmptyRow, ErrorRow, F, Pager, ActivityChips, TableSkeleton, normalizeActivityAction, normalizeActivityType, pendingRows, LiveAnchor } from './ui'
import { PAGE_SIZE, activityListCount, eventListCount, extrinsicListCount, hasNextPage, pageCount } from '../utils/activityPaging'
import type { ListCountQuery } from '../api/explorer'

type ActivityScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }
  | { kind: 'list-tag'; listId: string; tagId: string }

// Account, system-tag and list-tag detail pages expose the same activity
// controls. All three APIs are queried through disabled hooks here so one
// implementation owns their filtering, pagination, totals, and table layout.
export function ScopedActivity({ scope }: { scope: ActivityScope }) {
  const accountAddress = scope.kind === 'account' ? scope.address : null
  const systemTagId = scope.kind === 'tag' ? scope.tagId : null
  const listId = scope.kind === 'list-tag' ? scope.listId : null
  const listTagId = scope.kind === 'list-tag' ? scope.tagId : null
  const now = useNow()
  const accountCounts = useAccountActivityCounts(accountAddress)
  const tagCounts = useTagActivityCounts(systemTagId)
  const listTagCounts = useListTagActivityCounts(listId, listTagId)
  const counts = scope.kind === 'account' ? accountCounts : scope.kind === 'tag' ? tagCounts : listTagCounts
  const rawTab = useQueryValue('atab', 'activity')
  const activeTab = rawTab === 'extrinsics' || rawTab === 'events' ? rawTab : 'activity'
  const activityType = normalizeActivityType(useQueryValue('type', 'all'))
  // `contract` is the account page's contract sub-tab key — reserved so a
  // lingering ?contract=read never reads as a filter value here.
  const filterOptions = { reservedKeys: ['page', 'tab', 'view', 'atab', 'type', 'apage', 'contract'], pageKey: 'apage' }
  const activityFilters = useFilters({ ...filterOptions, keys: ['action', 'token', 'from', 'to', 'min'] })
  const extrinsicFilters = useFilters({ ...filterOptions, keys: ['call', 'result', 'origin', 'from', 'to'] })
  const eventFilters = useFilters({ ...filterOptions, keys: ['event', 'from', 'to'] })
  const activityAction = normalizeActivityAction(activityType, activityFilters.values.action ?? '')
  const assets = useAssetFilterOptions()
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
  const tagTotal = useTagListCount(systemTagId, activeCountQuery)
  const listTagTotal = useListTagListCount(listId, listTagId, activeCountQuery)
  const count = (scope.kind === 'account' ? accountTotal : scope.kind === 'tag' ? tagTotal : listTagTotal).data
  const total = count?.total
  const totalPages = pageCount(total)
  // A total the API marked incomplete is exact for the pages it numbers, but the
  // feed runs past them — say so, rather than letting the last page read as the end
  // of the account's history. null (not undefined) is the rarer case of a feed whose
  // narrowest window would not assemble, which leaves the "of M" missing entirely.
  const countNote = total == null
    ? (count ? 'too much history to count exactly' : undefined)
    : count?.complete === false ? 'older history beyond the counted window' : undefined
  // The unfiltered activity length doubles as the tab badge. When no filter is
  // set it IS the total above, so the two share one request.
  const accountActivityTotal = useAccountListCount(accountAddress, activityListCount('all', '', {}))
  const tagActivityTotal = useTagListCount(systemTagId, activityListCount('all', '', {}))
  const listTagActivityTotal = useListTagListCount(listId, listTagId, activityListCount('all', '', {}))
  const activityCount = (scope.kind === 'account' ? accountActivityTotal : scope.kind === 'tag' ? tagActivityTotal : listTagActivityTotal).data
  const activityTotal = activityCount?.total

  const commonActivityArgs = [
    activityType,
    offset,
    activityAction || undefined,
    activityFilters.values.from,
    activityFilters.values.to,
    { token: activityFilters.values.token, min: minimumUsd },
  ] as const
  const accountActivity = useAccountActivity(activeTab === 'activity' ? accountAddress : null, ...commonActivityArgs)
  const tagActivity = useTagActivity(activeTab === 'activity' ? systemTagId : null, ...commonActivityArgs)
  const listTagActivity = useListTagActivity(listId, activeTab === 'activity' ? listTagId : null, ...commonActivityArgs)
  const activity = scope.kind === 'account' ? accountActivity : scope.kind === 'tag' ? tagActivity : listTagActivity
  const activityRows = activity.data ?? []
  const accountExtrinsics = useAccountExtrinsics(
    activeTab === 'extrinsics' ? accountAddress : null,
    offset,
    extrinsicFilters.values.from,
    extrinsicFilters.values.to,
    { call: extrinsicFilters.values.call, result: extrinsicFilters.values.result, origin: extrinsicFilters.values.origin },
  )
  const tagExtrinsics = useTagExtrinsics(
    activeTab === 'extrinsics' ? systemTagId : null,
    offset,
    extrinsicFilters.values.from,
    extrinsicFilters.values.to,
    { call: extrinsicFilters.values.call, result: extrinsicFilters.values.result, origin: extrinsicFilters.values.origin },
  )
  const listTagExtrinsics = useListTagExtrinsics(
    listId,
    activeTab === 'extrinsics' ? listTagId : null,
    offset,
    extrinsicFilters.values.from,
    extrinsicFilters.values.to,
    { call: extrinsicFilters.values.call, result: extrinsicFilters.values.result, origin: extrinsicFilters.values.origin },
  )
  const extrinsics = scope.kind === 'account' ? accountExtrinsics : scope.kind === 'tag' ? tagExtrinsics : listTagExtrinsics
  const accountEvents = useAccountEvents(
    activeTab === 'events' ? accountAddress : null,
    offset,
    eventFilters.values.from,
    eventFilters.values.to,
    { event: eventFilters.values.event },
  )
  const tagEvents = useTagEvents(
    activeTab === 'events' ? systemTagId : null,
    offset,
    eventFilters.values.from,
    eventFilters.values.to,
    { event: eventFilters.values.event },
  )
  const listTagEvents = useListTagEvents(
    listId,
    activeTab === 'events' ? listTagId : null,
    offset,
    eventFilters.values.from,
    eventFilters.values.to,
    { event: eventFilters.values.event },
  )
  const events = scope.kind === 'account' ? accountEvents : scope.kind === 'tag' ? tagEvents : listTagEvents
  // On-behalf rows (proxy/multisig) carry a real sender and an origin badge;
  // both columns appear only when the account has such history, so ordinary
  // accounts keep the compact layout. Count-driven (not row-presence) so it
  // stays stable across pages/filters and doesn't flash while the rows query
  // resolves before the slower counts query.
  const showOrigin = (counts.data?.extrinsicsOnBehalf ?? 0) > 0
  const showSigner = scope.kind === 'tag' || scope.kind === 'list-tag' || showOrigin
  const extrinsicColumns = 6 + (showSigner ? 1 : 0) + (showOrigin ? 1 : 0)

  const setActiveTab = (tab: string | null) => setQuery({ atab: tab, apage: null })
  const setActivityType = (value: string) => setQuery({ type: value === 'all' ? null : value, action: null, apage: null })
  const setPage = (nextPage: number) => setQuery({ apage: nextPage > 0 ? String(nextPage) : null })

  return (
    <>
      <div className="tabs">
        {/* A partial total is the newest rows of a longer feed, so the badge reads
            "210k+" rather than claiming that is all the account did. */}
        <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab(null)}>Activity{activityTotal != null ? <> <span className="cnt">{F.int(activityTotal)}{activityCount?.complete === false ? '+' : ''}</span></> : null}</button>
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
        <ActivityTable rows={activityRows} now={now} live={page === 0} anchorRef={activity.anchorRef} loading={activity.isFetching && !activity.data?.length} pending={activity.isPlaceholderData} pageSize={PAGE_SIZE}
          error={activity.error} onRetry={() => { void activity.refetch() }} />
        <Pager page={page} totalPages={totalPages} hasNext={hasNextPage(totalPages, page, activityRows.length)} note={countNote} onPage={setPage} />
      </>}

      {activeTab === 'extrinsics' && <>
        <FilterZone fields={extrinsicFilterFields(showOrigin)} values={extrinsicFilters.values} onChange={extrinsicFilters.onChange} onClear={extrinsicFilters.onClear} />
        <div className="panel"><LiveAnchor anchorRef={extrinsics.anchorRef} /><table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Call</th>{showSigner && <th>Sender</th>}{showOrigin && <th>Origin</th>}<th className="r">Result</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody {...pendingRows(extrinsics.isPlaceholderData)}>
            {extrinsics.isFetching && !extrinsics.data?.length ? <TableSkeleton cols={extrinsicColumns} mobileCols={extrinsicColumns - 1} rows={PAGE_SIZE} />
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
        <div className="panel"><LiveAnchor anchorRef={events.anchorRef} /><table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Extrinsic</th><th>Event</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody {...pendingRows(events.isPlaceholderData)}>
            {events.isFetching && !events.data?.length ? <TableSkeleton cols={6} mobileCols={5} rows={PAGE_SIZE} />
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
