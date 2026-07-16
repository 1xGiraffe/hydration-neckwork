/* eslint-disable react-refresh/only-export-components -- filter primitives + helpers module */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery, setQuery } from '../router'
import type { AssetListItem } from '../types'
import { parseUtcTimestamp } from '../utils/time'

export interface ComboOption { value: string; label: string; sub?: string; search?: string }
export interface FilterField {
  kind: 'date' | 'combo' | 'select' | 'number' | 'text'
  key: string
  placeholder?: string
  title?: string
  width?: number
  options?: ComboOption[]
}
export type FilterValues = Record<string, string>
const FILTER_DEBOUNCE_MS = 300

// Free-form filters can trigger expensive ClickHouse scans. Keep typing local
// and commit once the user pauses (or immediately on blur/Enter), rather than
// issuing one distinct, uncancellable query for every partial word.
function DebouncedInput({ value, onCommit, type, placeholder, title, label, width }: {
  value: string
  onCommit: (value: string) => void
  type: 'text' | 'number'
  placeholder?: string
  title?: string
  label: string
  width?: number
}) {
  const [draft, setDraft] = useState(value)
  const [lastExternalValue, setLastExternalValue] = useState(value)
  const timer = useRef<number | undefined>(undefined)
  const onCommitRef = useRef(onCommit)

  // React permits a guarded render-time adjustment when local draft state is
  // derived from a prop. This preserves focus (the component key is stable)
  // while making Back/Clear update the visible value immediately.
  if (value !== lastExternalValue) {
    setLastExternalValue(value)
    setDraft(value)
  }

  useEffect(() => { onCommitRef.current = onCommit }, [onCommit])
  useEffect(() => {
    if (draft === value) return
    timer.current = window.setTimeout(() => onCommitRef.current(draft), FILTER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer.current)
  }, [draft, value])

  const commit = () => {
    window.clearTimeout(timer.current)
    if (draft !== value) onCommitRef.current(draft)
  }
  return <input
    type={type}
    min={type === 'number' ? 0 : undefined}
    maxLength={type === 'text' ? 128 : undefined}
    placeholder={placeholder}
    value={draft}
    onChange={e => setDraft(e.target.value)}
    onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') commit() }}
    title={title}
    aria-label={label}
    style={width ? { width } : undefined}
  />
}

// Token combo options: value = asset id (unique — so filtering is unambiguous and
// React keys don't collide), with a muted "name #id" detail line so duplicate
// symbols (4× USDC, 3× USDT, …) are distinguishable. Searchable by symbol, name, id.
export function tokenFilterOptions(assets: AssetListItem[]): ComboOption[] {
  return assets.map(a => ({
    value: String(a.assetId),
    label: a.symbol,
    sub: a.name && a.name !== a.symbol ? `${a.name} #${a.assetId}` : `#${a.assetId}`,
    search: `${a.symbol} ${a.name ?? ''} ${a.assetId}`,
  }))
}

function Combo({ value, placeholder, label, width, options, onChange }: { value: string; placeholder?: string; label?: string; width?: number; options: ComboOption[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const blurTimer = useRef<number | undefined>(undefined)
  const matched = value ? options.find(o => o.value === value) : undefined
  // When the picked symbol is shared by other assets, show its id in the collapsed
  // input so which one is active stays clear (e.g. "USDC #1000766").
  const dup = matched ? options.some(o => o !== matched && o.label === matched.label) : false
  const selectedLabel = matched ? (dup ? `${matched.label} #${matched.value}` : matched.label) : (value || '')
  // Reset the query and open — used on focus AND on click, so clicking an already-
  // focused input (e.g. right after a selection) reopens the full list instead of
  // staying closed (no onFocus fires when focus never left).
  const reopen = () => {
    window.clearTimeout(blurTimer.current)
    setQ('')
    setActiveIndex(matched ? options.indexOf(matched) + 1 : 0)
    setOpen(true)
  }
  const list = q
    ? options.filter(o => (o.search ?? `${o.label} ${o.sub ?? ''}`).toLowerCase().includes(q.toLowerCase()))
    : options
  const selectIndex = (index: number) => {
    if (index === 0) onChange('')
    else if (list[index - 1]) onChange(list[index - 1].value)
    else return
    setOpen(false)
  }
  useEffect(() => () => window.clearTimeout(blurTimer.current), [])
  return (
    <div className="combo">
      <input
        className="combo-input" style={width ? { width } : undefined} placeholder={placeholder} autoComplete="off"
        aria-label={label ?? placeholder ?? 'Filter'}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${Math.min(activeIndex, list.length)}` : undefined}
        value={open ? q : selectedLabel}
        onChange={e => { setQ(e.target.value); setActiveIndex(1); setOpen(true) }}
        onFocus={reopen}
        onMouseDown={() => { if (!open) reopen() }}
        onBlur={() => { blurTimer.current = window.setTimeout(() => setOpen(false), 160) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) reopen()
            else setActiveIndex(index => Math.min(index + 1, list.length))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) reopen()
            else setActiveIndex(index => Math.max(index - 1, 0))
          } else if (event.key === 'Enter' && open) {
            event.preventDefault()
            selectIndex(Math.min(activeIndex, list.length))
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            setOpen(false)
          }
        }}
      />
      {open && (
        <div id={listboxId} className="combo-pop" role="listbox" aria-label={label ?? placeholder ?? 'Filter options'}>
          <div
            id={`${listboxId}-option-0`}
            role="option"
            aria-selected={!value}
            className={`combo-opt${activeIndex === 0 ? ' active' : ''}`}
            onMouseEnter={() => setActiveIndex(0)}
            onMouseDown={event => { event.preventDefault(); selectIndex(0) }}
          >
            {placeholder}
          </div>
          {list.map((o, index) => (
            <div
              key={o.value}
              id={`${listboxId}-option-${index + 1}`}
              role="option"
              aria-selected={o.value === value}
              className={`combo-opt${activeIndex === index + 1 ? ' active' : ''}`}
              onMouseEnter={() => setActiveIndex(index + 1)}
              onMouseDown={event => { event.preventDefault(); selectIndex(index + 1) }}
            >
              <span className="combo-opt-sym">{o.label}</span>
              {o.sub && <span className="combo-opt-sub">{o.sub}</span>}
            </div>
          ))}
          {!list.length && <div className="combo-opt combo-empty">No matches</div>}
        </div>
      )}
    </div>
  )
}

export function FilterZone({ fields, values, onChange, onClear, extra }: { fields: FilterField[]; values: FilterValues; onChange: (k: string, v: string) => void; onClear: () => void; extra?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const filtersId = useId()
  const active = Object.entries(values).filter(([, v]) => v).length
  return (
    <div className="filter-zone">
      <div className="filter-head">
        <button className={`filter-toggle ${active ? 'has' : ''} ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={filtersId}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
          Filters{active ? <span className="fb">{active}</span> : null}
          <span className="chev">{open ? '▴' : '▾'}</span>
        </button>
        {extra}
      </div>
      <div id={filtersId} className={`filters ${open ? '' : 'hidden'}`}>
        {fields.map(f => {
          const label = f.title ?? f.placeholder ?? f.key
          if (f.kind === 'date') return <input key={f.key} type="date" value={values[f.key] || ''} onChange={e => onChange(f.key, e.target.value)} title={f.title} aria-label={label} />
          if (f.kind === 'number' || f.kind === 'text') {
            const value = values[f.key] || ''
            return <DebouncedInput key={f.key} type={f.kind} placeholder={f.placeholder} value={value} onCommit={v => onChange(f.key, v)} title={f.title} label={label} width={f.width} />
          }
          if (f.kind === 'select') return <select key={f.key} value={values[f.key] || ''} onChange={e => onChange(f.key, e.target.value)} title={f.title} aria-label={label}>{f.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          if (f.kind === 'combo') return <Combo key={f.key} value={values[f.key] || ''} placeholder={f.placeholder} label={label} width={f.width} options={f.options!} onChange={v => onChange(f.key, v)} />
          return null
        })}
        <button className="fclear" onClick={onClear}>Clear</button>
      </div>
    </div>
  )
}

interface UseFiltersOptions {
  reservedKeys?: string[]
  pageKey?: string
  keys?: string[]
}

// Filter values are backed by the URL hash query so every filtered view is
// deep-linkable and restored by the back button. Reserved keys are managed by
// the surrounding page, and `keys` lets compound pages expose only the filters
// for the currently visible tab.
export function useFilters(options: UseFiltersOptions = {}) {
  const q = useQuery()
  const pageKey = options.pageKey ?? 'page'
  const reserved = new Set([pageKey, ...(options.reservedKeys ?? ['page', 'tab'])])
  const allowed = options.keys ? new Set(options.keys) : null
  const values: FilterValues = {}
  for (const [k, v] of q.entries()) {
    if (reserved.has(k) || (allowed && !allowed.has(k)) || !v) continue
    values[k] = v
  }
  const onChange = (k: string, v: string) => setQuery({ [k]: v || null, [pageKey]: null })
  const onClear = () => {
    const patch: Record<string, null> = { [pageKey]: null }
    for (const k of options.keys ?? Object.keys(values)) patch[k] = null
    setQuery(patch)
  }
  const setDay = (d: string | null) => setQuery({ from: d || null, to: d || null, [pageKey]: null })
  return { values, onChange, onClear, setDay }
}

// shared apply helpers
export function tsInRange(ts: string, from?: string, to?: string): boolean {
  const t = parseUtcTimestamp(ts)
  if (!Number.isFinite(t)) return false
  if (from) { const d = parseUtcTimestamp(from); if (Number.isFinite(d) && t < d) return false }
  if (to) { const d = parseUtcTimestamp(to); if (Number.isFinite(d) && t >= d + 86_400_000) return false }
  return true
}
