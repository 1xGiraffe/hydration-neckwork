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
import { EmptyRow, F, Pager, ActivityChips, TableSkeleton, normalizeActivityAction, normalizeActivityType } from './ui'

const PAGE_SIZE = 25
const MAX_FORWARD_OFFSET = 2_000
const MAX_TAIL_OFFSET = 6_000

type ActivityScope =
  | { kind: 'account'; address: string }
  | { kind: 'tag'; tagId: string }

function pageCount(rowCount?: number | null): number | undefined {
  return rowCount != null && rowCount > 0 ? Math.ceil(rowCount / PAGE_SIZE) : undefined
}

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
  const filterOptions = { reservedKeys: ['page', 'tab', 'view', 'atab', 'type', 'apage'], pageKey: 'apage' }
  const activityFilters = useFilters({ ...filterOptions, keys: ['action', 'token', 'from', 'to', 'min'] })
  const extrinsicFilters = useFilters({ ...filterOptions, keys: ['call', 'result', 'from', 'to'] })
  const eventFilters = useFilters({ ...filterOptions, keys: ['event', 'from', 'to'] })
  const activityAction = normalizeActivityAction(activityType, activityFilters.values.action ?? '')
  const assets = useAssets()
  const query = useQuery()
  const requestedPage = Number.parseInt(query.get('apage') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const offset = page * PAGE_SIZE
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
  const tailOffset = activityRowCount != null ? Math.max(0, activityRowCount - offset - PAGE_SIZE) : null
  const activityTail = activityRowCount != null
    && offset + PAGE_SIZE > MAX_FORWARD_OFFSET
    && tailOffset != null
    && tailOffset + PAGE_SIZE <= MAX_TAIL_OFFSET
    ? tailOffset
    : undefined

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
  const accountExtrinsics = useAccountExtrinsics(
    activeTab === 'extrinsics' ? accountAddress : null,
    offset,
    extrinsicFilters.values.from,
    extrinsicFilters.values.to,
    { call: extrinsicFilters.values.call, result: extrinsicFilters.values.result },
  )
  const tagExtrinsics = useTagExtrinsics(
    activeTab === 'extrinsics' ? tagId : null,
    offset,
    extrinsicFilters.values.from,
    extrinsicFilters.values.to,
    { call: extrinsicFilters.values.call, result: extrinsicFilters.values.result },
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
  const showSigner = scope.kind === 'tag'
  const extrinsicColumns = showSigner ? 8 : 7

  const setActiveTab = (tab: string | null) => setQuery({ atab: tab, apage: null })
  const setActivityType = (value: string) => setQuery({ type: value === 'all' ? null : value, action: null, apage: null })
  const setPage = (nextPage: number) => setQuery({ apage: nextPage > 0 ? String(nextPage) : null })
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
        <ActivityTable rows={activity.data ?? []} now={now} live={page === 0} loading={activity.isFetching && !activity.data?.length} />
        <Pager page={page} totalPages={pageCount(activityRowCount)} hasNext={(activity.data?.length ?? 0) === PAGE_SIZE} onPage={setPage} />
      </>}

      {activeTab === 'extrinsics' && <>
        <FilterZone fields={extrinsicFilterFields} values={extrinsicFilters.values} onChange={extrinsicFilters.onChange} onClear={extrinsicFilters.onClear} />
        <div className="panel"><table className="tbl">
          <thead><tr><th>ID</th><th>Block</th><th>Call</th>{showSigner && <th>Signer</th>}<th className="r">Fee</th><th className="r">Result</th><th className="r">Time</th><th style={{ width: 34 }}></th></tr></thead>
          <tbody>
            {extrinsics.isFetching && !extrinsics.data?.length ? <TableSkeleton cols={extrinsicColumns} />
              : !extrinsics.data?.length ? <EmptyRow cols={extrinsicColumns}>No extrinsics</EmptyRow>
                : extrinsics.data.map(extrinsic => <ExtRow key={`${extrinsic.blockHeight}-${extrinsic.index}`} x={extrinsic} now={now} noSigner={!showSigner} />)}
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
              : !events.data?.length ? <EmptyRow cols={6}>No events</EmptyRow>
                : events.data.map(event => <EvRow key={`${event.blockHeight}-${event.eventIndex}`} e={event} now={now} />)}
          </tbody>
        </table></div>
        <Pager page={page} totalPages={eventPages} hasNext={(events.data?.length ?? 0) === PAGE_SIZE} onPage={setPage} />
      </>}
    </>
  )
}
