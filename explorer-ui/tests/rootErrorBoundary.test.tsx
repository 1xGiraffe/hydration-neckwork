import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RootErrorBoundary, RootErrorCard } from '../src/components/RootErrorBoundary'

describe('RootErrorBoundary', () => {
  it('says a new version is live for a chunk-load error', () => {
    const state = RootErrorBoundary.getDerivedStateFromError(new TypeError('Failed to fetch dynamically imported module: /assets/Account-abc.js'))
    const html = renderToStaticMarkup(<RootErrorCard chunk={true} />)
    expect(state.error).toBeInstanceOf(TypeError)
    expect(html).toContain('A new version is live')
    expect(html).toContain('Reload')
  })

  it('shows a generic card for any other error', () => {
    const html = renderToStaticMarkup(<RootErrorCard chunk={false} />)
    expect(html).toContain('Something went wrong')
    expect(html).not.toContain('new version')
  })

  it('picks the card from the caught error', () => {
    const b = new RootErrorBoundary({ children: null })
    b.state = { error: new Error('Importing a module script failed.') }
    expect(renderToStaticMarkup(<>{b.render()}</>)).toContain('A new version is live')
    b.state = { error: new Error('x is undefined') }
    expect(renderToStaticMarkup(<>{b.render()}</>)).toContain('Something went wrong')
    b.state = { error: null }
    expect(b.render()).toBeNull()
  })
})
