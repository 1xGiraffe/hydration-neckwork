import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Combo, FilterZone } from '../src/components/Filters'
import { eventFilterFields, extrinsicFilterFields, nameFilterOptions } from '../src/components/activityFilters'
import { mockSync } from './fixtures/mockApi'
import type { FilterNames } from '../src/types'

// The call/event name filters became pickers over the indexed name catalogue
// (/explorer/filter-names) instead of blind text boxes. Two properties have to
// hold together: the names are now DISCOVERABLE, and a name that is not in the
// list — a partial pallet name, or something too new for the catalogue's window —
// must still be usable, because the server matches partially and the catalogue is
// a snapshot of a block window rather than the set of legal values.
const names = mockSync<FilterNames>('/explorer/filter-names')!

describe('the name filters', () => {
  it('offers the indexed names on the same filter keys as before', () => {
    const call = extrinsicFilterFields(false, names.calls).find(f => f.key === 'call')!
    const event = eventFilterFields(names.events).find(f => f.key === 'event')!
    expect(call.kind).toBe('combo')
    expect(event.kind).toBe('combo')
    // Same keys, so every deep link, every `useFilters` clear and every request
    // parameter keeps working untouched.
    expect(call.placeholder).toBe('Call name')
    expect(event.placeholder).toBe('Event name')
    expect(call.options).toEqual(nameFilterOptions(names.calls))
    expect(call.options!.map(o => o.value)).toContain('Omnipool.sell')
    expect(event.options!.map(o => o.value)).toContain('Referenda.Submitted')
    // Both accept a typed value that is not in the list.
    expect(call.freeText).toBe(true)
    expect(event.freeText).toBe(true)
  })

  // With no catalogue loaded (or none at all) the field is still a working filter
  // — an empty dropdown, not a broken box.
  it('degrades to an empty option list rather than disappearing', () => {
    const call = extrinsicFilterFields().find(f => f.key === 'call')!
    expect(call.kind).toBe('combo')
    expect(call.options).toEqual([])
    expect(call.freeText).toBe(true)
  })

  it('shows a value the option list does not contain, so a partial filter reads back', () => {
    const html = renderToStaticMarkup(<Combo value="omnipool" options={nameFilterOptions(names.calls)} freeText onChange={() => {}} placeholder="Call name" />)
    expect(html).toContain('value="omnipool"')
    // A picked full name reads back the same way.
    const picked = renderToStaticMarkup(<Combo value="Omnipool.sell" options={nameFilterOptions(names.calls)} freeText onChange={() => {}} placeholder="Call name" />)
    expect(picked).toContain('value="Omnipool.sell"')
  })

  it('renders inside the filter zone with its value and a way to clear it', () => {
    const html = renderToStaticMarkup(
      <FilterZone fields={extrinsicFilterFields(false, names.calls)} values={{ call: 'Omnipool.sell' }} onChange={() => {}} onClear={() => {}} />,
    )
    expect(html).toContain('class="combo"')
    expect(html).toContain('value="Omnipool.sell"')
    // The filter count and the Clear button are the zone's own, and both still
    // see the field: nothing about the control changed except how it is filled.
    expect(html).toContain('class="fb"')
    expect(html).toContain('>Clear<')
  })
})
