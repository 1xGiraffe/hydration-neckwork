/* eslint-disable react-refresh/only-export-components -- page + its smol-filter helpers */
import { useState } from 'react'
import { useActivity, useDaily, useAssets } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, usePageParam, setPage, useQueryValue, setQuery } from '../router'
import { Crumbs, F, DayBarChart, Pager, ActivityChips, normalizeActivityType, normalizeActivityAction } from '../components/ui'
import { ActivityTable } from '../components/ActivityTable'
import { FilterZone, useFilters } from '../components/Filters'
import { activityFilterFields } from '../components/activityFilters'

const PAGE = 25
// "smol" threshold — same $10 line ActivityTable uses for the .dim row treatment.
export const SMOL_USD = 10

// Server-side min filter actually sent: an explicit "$ from" filter always wins;
// otherwise the smol toggle supplies the $10 floor (the server also drops
// rows with no USD value when min is set, matching the .dim rule).
export function effectiveMin(userMin: string | undefined, hideSmol: boolean): string | undefined {
  return userMin || (hideSmol ? String(SMOL_USD) : undefined)
}

// Persisted smol preference — hidden by default, survives reloads.
export function useHideSmol(): [boolean, () => void] {
  const [hide, setHide] = useState(() => {
    try { return localStorage.getItem('explorer-hide-smol') !== '0' } catch { return true }
  })
  const toggle = () => setHide(h => {
    try { localStorage.setItem('explorer-hide-smol', h ? '0' : '1') } catch { /* ignore */ }
    return !h
  })
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
  const { values: f, onChange, onClear, setDay } = useFilters()
  const [hideSmol, toggleSmol] = useHideSmol()
  // Failed attempts have no executed USD value. Selecting either DCA action
  // must therefore bypass the implicit "hide smol" floor, while an explicit
  // user-entered minimum remains authoritative.
  const activityMin = (action === 'dca' || action === 'dca-failed') && !f.min
    ? undefined
    : effectiveMin(f.min, hideSmol)
  const { data, isFetching } = useActivity(PAGE, f.from, f.to, page * PAGE, type, { token: f.token, min: activityMin }, action || undefined)  // filters applied server-side
  // The daily histogram mirrors the active tab + action/token filters.
  const { data: daily } = useDaily('activity', { type, action: action || undefined, token: f.token || undefined })
  const assets = useAssets()
  const now = useNow()

  const rows = data ?? []

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Activity' }]} />
        <div className="page-title">Activity <span className="sub">on-chain activity, interpreted</span></div>
      </div>
      <DayBarChart data={daily ?? []} label="Daily activity" selected={f.from === f.to ? f.from : undefined} onSelect={setDay} fmt={F.int} loading={!daily} />
      <ActivityChips value={type} onChange={v => setQuery({ tab: v === 'all' ? null : v, action: null, page: null })} />
      <FilterZone fields={activityFilterFields(type, assets.data ?? [])} values={f} onChange={onChange} onClear={onClear}
        extra={<SmolToggle hiding={hideSmol} onToggle={() => { toggleSmol(); setQuery({ page: null }) }} />} />
      <ActivityTable rows={rows} now={now} live={page === 0} loading={isFetching && rows.length === 0} />
      <Pager page={page} hasNext={(data?.length ?? 0) === PAGE} onPage={setPage} />
    </div>
  )
}
