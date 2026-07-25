import {
  useAccountEvents,
  useAccountExtrinsics,
  useAccountActivity,
  useAccountActivityCounts,
  useAccountActivityCount,
  useAssets,
  useTagActivityCounts,
  useTagEvents,
  useTagExtrinsics,
  useTagActivity,
  useTagActivityCount,
} from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { setQuery, useQuery, useQueryValue } from '../router'
import { FilterZone, useFilters } from './Filters'
import { EvRow, ExtRow } from './ActivityRows'
import { ActivityTable } from './ActivityTable'
import { eventFilterFields, extrinsicFilterFields, activityFilterFields } from './activityFilters'
import { EmptyRow, ErrorRow, F, Pager, ActivityChips, TableSkeleton, normalizeActivityAction, normalizeActivityType } from './ui'
import { PAGE_SIZE, activityTailOffset, pageCount, provenPageCount, tailOffsetForPage, tailPageParam, trimFinalTailPage } from '../utils/activityPaging'

type ActivityScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }

function hasNoValues(values: Record<string, string | undefined>): boolean {
  return Object.values(values).every(value => !value)
}

// Account and tag detail pages expose the same activity controls. Both APIs are
// queried through disabled hooks here so one implementation owns their filtering,
// pagination, tail paging, and table layout.
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
  const filterOptions = { reservedKeys: ['page', 'tab', 'view', 'atab', 'type', 'apage', 'atail'], pageKey: 'apage' }
  const activityFilters = useFilters({ ...filterOptions, keys: ['action', 'token', 'from', 'to', 'min'] })
  const extrinsicFilters = useFilters({ ...filterOptions, keys: ['call', 'result', 'origin', 'from', 'to'] })
  const eventFilters = useFilters({ ...filterOptions, keys: ['event', 'from', 'to'] })
  const activityAction = normalizeActivityAction(activityType, activityFilters.values.action ?? '')
  const assets = useAssets(false)   // filter options only; the Assets page owns the poll
  const query = useQuery()
  const requestedPage = Number.parseInt(query.get('apage') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  // `atail` pages from the OLDEST end (0 = last page). It exists because the row count
  // overshoots the feed, so a count-derived last page misses; tail mode walks back from
  // the true oldest row instead. When set it takes over from the forward offset.
  const tailPage = tailPageParam(query.get('atail'))
  const offset = tailPage == null ? page * PAGE_SIZE : 0
  const minimumUsd = activityFilters.values.min || undefined
  const activityHasCount = activityType === 'all'
    && !activityAction
    && !activityFilters.values.token
    && !activityFilters.values.from
    && !activityFilters.values.to

  const countAccount = activeTab === 'activity' && activityHasCount && minimumUsd != null ? accountAddress : null
  const countTag = activeTab === 'activity' && activityHasCount && minimumUsd != null ? tagId : null
  const accountMinimumCount = useAccountActivityCount(countAccount, minimumUsd != null ? Number(minimumUsd) : null)
  const tagMinimumCount = useTagActivityCount(countTag, minimumUsd != null ? Number(minimumUsd) : null)
  const minimumCount = scope.kind === 'account' ? accountMinimumCount : tagMinimumCount
  const activityRowCount = activityHasCount
    ? (minimumUsd != null ? minimumCount.data?.activity : counts.data?.activity)
    : undefined
  const activityTail = tailPage != null ? tailOffsetForPage(tailPage) : activityTailOffset(activityRowCount, offset)

  const commonActivityArgs = [
    activityType,
    offset,
    activityAction || undefined,
    activityFilters.values.from,
    activityFilters.values.to,
    { token: activityFilters.values.token, min: minimumUsd },
    activityTail,
  ] as const
  const accountActivity = useAccountActivity(activeTab === 'activity' ? accountAddress : null, ...commonActivityArgs)
  const tagActivity = useTagActivity(activeTab === 'activity' ? tagId : null, ...commonActivityArgs)
  const activity = scope.kind === 'account' ? accountActivity : tagActivity
  const activityRows = tailPage != null
    ? (activity.data ?? [])
    : trimFinalTailPage(activity.data ?? [], activityRowCount, offset, activityTail)
  // Only ever advertise a page count the feed has proven; activityRowCount overshoots it
  // (see provenPageCount). Its other uses stay: the tab badge is an activity tally, and
  // activityTail/trimFinalTailPage already treat it as approximate.
  const activityTotalPages = tailPage == null ? provenPageCount(activityRows.length, page, activity.isFetching) : undefined
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
  const setPage = (nextPage: number) => setQuery({ apage: nextPage > 0 ? String(nextPage) : null, atail: null })
  const setTailPage = (nextTail: number) => setQuery({ apage: null, atail: String(Math.max(0, nextTail)) })
  const extrinsicPages = hasNoValues(extrinsicFilters.values) ? pageCount(counts.data?.extrinsics) : undefined
  const eventPages = hasNoValues(eventFilters.values) ? pageCount(counts.data?.events) : undefined

  return (
    <>
      <div className="tabs">
        <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab(null)}>Activity{counts.data ? <> <span className="cnt">{F.int(counts.data.activity)}</span></> : null}</button>
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
        {/* Two axes, one pager. Forward paging counts from the newest row; tail paging
            counts back from the oldest, which is how the last page is reachable at all
            (the row count overshoots the feed, so it cannot locate the end). In tail
            mode "previous" is one page NEWER and "next" one page older, and the numbered
            buttons step out of tail mode entirely. */}
        <Pager
          page={page}
          totalPages={activityTotalPages}
          hasNext={tailPage != null ? tailPage > 0 : activityRows.length === PAGE_SIZE}
          pastEnd={tailPage == null && !activity.isFetching && !activity.error && page > 0 && activityRows.length === 0}
          label={tailPage == null ? undefined : tailPage === 0 ? 'Last page' : `${tailPage === 1 ? '1 page' : `${tailPage} pages`} from last`}
          onPage={setPage}
          onFirst={tailPage == null ? undefined : () => setPage(0)}
          onPrev={tailPage == null ? undefined : () => setTailPage(tailPage + 1)}
          onNext={tailPage == null ? undefined : () => setTailPage(Math.max(0, tailPage - 1))}
          onLast={() => setTailPage(0)}
        />
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
        <Pager page={page} totalPages={extrinsicPages} hasNext={(extrinsics.data?.length ?? 0) === PAGE_SIZE} onPage={setPage} />
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
        <Pager page={page} totalPages={eventPages} hasNext={(events.data?.length ?? 0) === PAGE_SIZE} onPage={setPage} />
      </>}
    </>
  )
}
