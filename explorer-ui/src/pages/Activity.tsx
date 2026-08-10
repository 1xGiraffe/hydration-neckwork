/* eslint-disable react-refresh/only-export-components -- page + its smol-filter helpers */
import { useActivity, useActivityCount, useDaily, useAssetFilterOptions } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, usePageParam, setPage, useQueryValue, setQuery } from '../router'
import { Crumbs, F, DayBarChart, Pager, ActivityChips, normalizeActivityType, normalizeActivityAction } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { FilterZone, useFilters } from '../components/Filters'
import { activityFilterFields } from '../components/activityFilters'
import { categoryColor } from '../components/activityColors'
import { offeredPages } from '../utils/activityPaging'

const PAGE = 25
// "smol" threshold — same $10 line ActivityTable uses for the .dim row treatment.
export const SMOL_USD = 10

// Server-side min filter actually sent: an explicit "$ from" filter always wins;
// otherwise the smol toggle supplies the $10 floor (the server also drops
// rows with no USD value when min is set, matching the .dim rule).
export function effectiveMin(userMin: string | undefined, hideSmol: boolean): string | undefined {
  return userMin || (hideSmol ? String(SMOL_USD) : undefined)
}

// The smol preference resolves URL-first so a shared link shows exactly what
// its sender saw: hiding is the default, so only `?smol=show` exists — an
// absent param falls back to the persisted preference. Toggling writes both:
// the URL (param set or removed, with the pager reset since the row set
// changes) and the preference, which keeps the fallback consistent when the
// param is removed.
export function smolHiddenFrom(urlValue: string, storedHide: boolean): boolean {
  return urlValue === 'show' ? false : storedHide
}
export function useHideSmol(): [boolean, () => void] {
  const urlValue = useQueryValue('smol', '')
  const storedHide = (() => {
    try { return localStorage.getItem('explorer-hide-smol') !== '0' } catch { return true }
  })()
  const hide = smolHiddenFrom(urlValue, storedHide)
  const toggle = () => {
    const nextHide = !hide
    try { localStorage.setItem('explorer-hide-smol', nextHide ? '1' : '0') } catch { /* ignore */ }
    setQuery({ smol: nextHide ? null : 'show', page: null })
  }
  return [hide, toggle]
}

// The word "smol" gets the same dim+strike treatment the rows it hides would get.
export function SmolToggle({ hiding, onToggle }: { hiding: boolean; onToggle: () => void }) {
  return (
    <button
      className={`smol-toggle${hiding ? ' hiding' : ''}`} onClick={onToggle} aria-pressed={hiding}
      title={hiding ? `Activity under $${SMOL_USD} is hidden — click to show` : `Showing activity under $${SMOL_USD} — click to hide`}
    >
      {hiding
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>}
      <span className="smol-word">smol</span>
    </button>
  )
}
export function Activity() {
  useDocumentTitle('Activity')
  const page = usePageParam()
  const type = normalizeActivityType(useQueryValue('tab', 'all'))   // deep-linked active tab
  const action = normalizeActivityAction(type, useQueryValue('action', ''))   // per-type action filter
  // `smol` is a view preference with its own toggle, not a filter — reserved so
  // it never renders as a filter chip and "clear filters" leaves it alone.
  const { values: f, onChange, onClear, setDay } = useFilters({ reservedKeys: ['page', 'tab', 'smol'] })
  const [hideSmol, toggleSmol] = useHideSmol()
  // Failed attempts have no executed USD value. Selecting either DCA action
  // must therefore bypass the implicit "hide smol" floor, while an explicit
  // user-entered minimum remains authoritative.
  const activityMin = (action === 'dca' || action === 'dca-failed') && !f.min
    ? undefined
    : effectiveMin(f.min, hideSmol)
  // isPlaceholderData: these rows answer the PREVIOUS filter/tab/page, kept on screen
  // while the new one loads. A high "$ from" here takes tens of seconds, so without
  // marking them the feed reads as ignoring the filter (see pendingRows).
  const { data, isFetching, isPlaceholderData, error, refetch, anchorRef } = useActivity(PAGE, f.from, f.to, page * PAGE, type, { token: f.token, min: activityMin, identity: f.identity }, action || undefined)  // filters applied server-side
  // The pager's two bounds, under exactly the filters above: how many rows the feed
  // holds where the API can count it (the vote feed pages in SQL over one source, so
  // its length is that source's own count), and always how deep the API serves this
  // category. The categories assembled from several sources report no total, so they
  // get no page numbers — but their › arrow still stops at the servable depth
  // instead of walking a reader into a refused request.
  const { data: count } = useActivityCount(type, f.from, f.to, { token: f.token, min: activityMin, identity: f.identity }, action || undefined)
  // The daily histogram mirrors the active tab + action/token filters.
  const { data: daily } = useDaily('activity', { type, action: action || undefined, token: f.token || undefined })
  const assets = useAssetFilterOptions()
  const now = useNow()

  const rows = data ?? []
  const pages = offeredPages({ page, rowsOnPage: rows.length, rowCount: count?.total, maxOffset: count?.maxOffset })

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity' }]} />
        <div className="page-title">Activity <span className="sub">on-chain activity, interpreted</span></div>
      </div>
      {/* The histogram wears whatever category is filtered, so the chart and the
          rows under it agree on what you are looking at. */}
      <DayBarChart data={daily ?? []} color={categoryColor(type)} label="Daily activity" selected={f.from === f.to ? f.from : undefined} onSelect={setDay} fmt={F.int} loading={!daily} />
      <ActivityChips value={type} onChange={v => setQuery({ tab: v === 'all' ? null : v, action: null, page: null })} />
      <FilterZone fields={activityFilterFields(type, assets.data ?? [])} values={f} onChange={onChange} onClear={onClear}
        extra={<SmolToggle hiding={hideSmol} onToggle={toggleSmol} />} />
      <ActivityTable rows={rows} now={now} live={page === 0} anchorRef={anchorRef} loading={isFetching && rows.length === 0} pending={isPlaceholderData} pageSize={PAGE} error={error} onRetry={() => { void refetch() }} />
      <Pager page={page} totalPages={pages.totalPages} hasNext={pages.hasNext} note={pages.note} onPage={setPage} />
    </div>
  )
}
