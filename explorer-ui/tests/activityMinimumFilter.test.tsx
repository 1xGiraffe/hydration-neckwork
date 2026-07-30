import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { effectiveMin, SmolToggle, SMOL_USD } from '../src/pages/Activity'

describe('smol filter — effectiveMin', () => {
  it('supplies the $10 floor when hiding and no explicit "$ from" filter', () => {
    expect(effectiveMin(undefined, true)).toBe(String(SMOL_USD))
    expect(effectiveMin('', true)).toBe(String(SMOL_USD))
  })
  it('is inactive when showing smol entries', () => {
    expect(effectiveMin(undefined, false)).toBeUndefined()
    expect(effectiveMin('', false)).toBeUndefined()
  })
  it('lets an explicit "$ from" filter win over the smol default', () => {
    expect(effectiveMin('5', true)).toBe('5')
    expect(effectiveMin('50', true)).toBe('50')
    expect(effectiveMin('5', false)).toBe('5')
  })
})

describe('SmolToggle', () => {
  it('renders the hiding state with strike treatment and pressed aria', () => {
    const html = renderToStaticMarkup(<SmolToggle hiding onToggle={() => {}} />)
    expect(html).toContain('smol-toggle hiding')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('smol')
  })
  it('renders the showing state without the hiding class', () => {
    const html = renderToStaticMarkup(<SmolToggle hiding={false} onToggle={() => {}} />)
    expect(html).not.toContain('hiding')
    expect(html).toContain('aria-pressed="false"')
  })
})
