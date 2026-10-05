import { describe, it, expect } from 'vitest'
import { SectionBoundary } from '../src/components/SectionBoundary'
import { isChunkLoadError } from '../src/lazyWithReload'

// The route-level boundary (App.tsx) keeps a page's render error inside the
// layout, clears it on navigation (resetKey = pathname), and passes a chunk-load
// failure up to the root's "A new version is live" card.
describe('SectionBoundary as the route boundary', () => {
  const make = (error: Error | null) => {
    const b = new SectionBoundary({ label: 'This page', resetKey: '/a', passThrough: isChunkLoadError, children: 'page' })
    b.state = { error, resetKey: '/a' }
    return b
  }
  it('renders the error card in place for an ordinary render error', () => {
    expect(make(null).render()).toBe('page')
    expect(() => make(new TypeError('x is undefined')).render()).not.toThrow()
  })
  it('rethrows a chunk-load failure to the root boundary', () => {
    const chunk = new TypeError('Failed to fetch dynamically imported module: /assets/Account-abc.js')
    expect(isChunkLoadError(chunk)).toBe(true)
    expect(() => make(chunk).render()).toThrow(chunk)
  })
  it('clears the error when the path changes', () => {
    expect(SectionBoundary.getDerivedStateFromProps({ label: 'p', resetKey: '/b', children: null }, { error: new Error('e'), resetKey: '/a' })).toEqual({ error: null, resetKey: '/b' })
    expect(SectionBoundary.getDerivedStateFromProps({ label: 'p', resetKey: '/a', children: null }, { error: new Error('e'), resetKey: '/a' })).toBeNull()
  })
})
