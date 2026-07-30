import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { routeFor, hitKey, TYPE_LABEL, SearchResultBody } from '../src/components/SearchBar'
import type { SearchResult } from '../src/types'

// A referendum result is only ever addressable by (pallet, index) — Democracy and
// OpenGov both index from 0, so "263" alone names two different referenda. `value`
// is already pallet-qualified (`opengov:263`) for exactly this reason.
const opengov263: SearchResult = {
  type: 'referendum', value: 'opengov:263', label: 'Treasury spend for Bifrost integration',
  pallet: 'opengov', index: 263, status: 'deciding',
}
const democracy263: SearchResult = {
  type: 'referendum', value: 'democracy:263', label: 'Treasury Council election',
  pallet: 'democracy', index: 263, status: 'passed',
}
const untitled: SearchResult = { type: 'referendum', value: 'opengov:2634', pallet: 'opengov', index: 2634, status: 'submitted' }

describe('routeFor (referendum)', () => {
  it('routes to the pallet-qualified referendum page', () => {
    expect(routeFor(opengov263)).toBe('/referendum/opengov/263')
    expect(routeFor(democracy263)).toBe('/referendum/democracy/263')
  })

  // Same index, different pallet: the route (and thus the page it opens) must
  // differ, or clicking one would silently open the other's referendum.
  it('never routes two different pallets to the same page for the same index', () => {
    expect(routeFor(opengov263)).not.toBe(routeFor(democracy263))
  })

  it('falls back rather than building a malformed route when pallet is missing', () => {
    expect(routeFor({ type: 'referendum', value: 'x', index: 1 })).toBe('/')
  })
})

describe('hitKey (referendum)', () => {
  // React list keys must stay unique across the whole flat result list, including
  // when Democracy and OpenGov each have their own referendum #263.
  it('keeps opengov and democracy referenda of the same index distinct', () => {
    expect(hitKey(opengov263)).not.toBe(hitKey(democracy263))
  })
})

describe('TYPE_LABEL (referendum)', () => {
  it('labels the group "Referendum"', () => {
    expect(TYPE_LABEL.referendum).toBe('Referendum')
  })
})

describe('SearchResultBody (referendum)', () => {
  it('renders the title, index and status', () => {
    const html = renderToStaticMarkup(<SearchResultBody r={opengov263} />)
    expect(html).toContain('Treasury spend for Bifrost integration')
    expect(html).toContain('#263')
    expect(html).toContain('deciding')
  })

  // An index without a fetched title yet must still show something addressable,
  // not a blank row — the same "state the absence" rule the API side follows.
  it('falls back to "Referendum #N" when no title has been fetched yet', () => {
    const html = renderToStaticMarkup(<SearchResultBody r={untitled} />)
    expect(html).toContain('Referendum #2634')
    expect(html).toContain('submitted')
  })
})
