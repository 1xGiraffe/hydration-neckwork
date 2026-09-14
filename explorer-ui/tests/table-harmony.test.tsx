import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssetDetailSkeleton, Dash, Sparkline } from '../src/components/ui'
import { ActivityTable } from '../src/components/ActivityTable'
import type { AssetRef, ActivityRow } from '../src/types'

// Harmonized table conventions: every null/empty cell shows the same muted
// MONOSPACE em dash (a bare `.muted` dash in a sans-serif cell renders a
// visibly wider glyph), and USD value columns are bright like in the
// accounts/holders tables — only the placeholder stays muted.

const hdx: AssetRef = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null }
const usdt: AssetRef = { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000 }

function row(valueUsd: number | null): ActivityRow {
  return {
    type: 'trade', blockHeight: 12848613, timestamp: '2026-07-11 10:00:00', extrinsicIndex: 4,
    who: null, to: null, asset: null, assetIn: hdx, assetOut: usdt,
    amount: null, amountIn: '1000000000000', amountOut: '1000000', valueUsd,
  }
}

describe('Dash — uniform table placeholder', () => {
  it('is a muted monospace em dash', () => {
    const html = renderToStaticMarkup(<Dash />)
    expect(html).toContain('mono muted')
    expect(html).toContain('—')
  })

  it('Sparkline falls back to the same monospace placeholder', () => {
    const html = renderToStaticMarkup(<Sparkline data={[1]} />)
    expect(html).toContain('mono muted')
    expect(html).toContain('—')
  })
})

describe('ActivityTable — Value column emphasis', () => {
  it('shows USD values bright (not muted), matching the accounts/holders tables', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[row(1234)]} now={0} noActor />)
    expect(html).toMatch(/data-label="Value" class="r mono"/)
    expect(html).toContain('$1.23k')
  })

  it('keeps a null value as the shared muted dash', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[row(null)]} now={0} noActor />)
    const value = html.match(/<td data-label="Value"[^>]*>(.*?)<\/td>/)?.[1] ?? ''
    expect(value).toContain('mono muted')
    expect(value).toContain('—')
  })

  it('renders the missing-account placeholder in monospace too', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[row(50)]} now={0} />)
    const account = html.match(/<td data-label="Account"[^>]*>(.*?)<\/td>/)?.[1] ?? ''
    expect(account).toContain('mono muted')
  })
})

// A placeholder row has to cover the whole table. When a column is added to the
// header and the colSpan constant is left behind, nothing errors: the skeleton,
// the empty note and the error row simply stop under the last column and the
// table's right edge collapses while it loads. Counting the header instead of
// hardcoding a number means the next column added is covered by construction.
const headerCols = (html: string) => (html.match(/<th[\s>]/g) ?? []).length
const spans = (html: string) => [...html.matchAll(/colspan="(\d+)"/gi)].map(m => Number(m[1]))
const skeletonCells = (html: string) =>
  [...html.matchAll(/<tr class="sk-tr">(.*?)<\/tr>/g)].map(m => (m[1].match(/<td[\s>]/g) ?? []).length)

describe('activity placeholder rows cover every column', () => {
  for (const noActor of [false, true]) {
    const label = noActor ? ' (no actor column)' : ''

    it(`the loading skeleton fills the header's width${label}`, () => {
      const html = renderToStaticMarkup(<ActivityTable rows={[]} now={0} loading pageSize={3} noActor={noActor} />)
      const cells = skeletonCells(html)

      expect(cells).toHaveLength(3)
      for (const n of cells) expect(n).toBe(headerCols(html))
    })

    it(`the empty note spans the header's width${label}`, () => {
      const html = renderToStaticMarkup(<ActivityTable rows={[]} now={0} noActor={noActor} />)

      expect(spans(html)).toEqual([headerCols(html)])
    })

    it(`the error row spans the header's width${label}`, () => {
      const html = renderToStaticMarkup(<ActivityTable rows={[]} now={0} error={new Error('nope')} noActor={noActor} />)

      expect(spans(html)).toEqual([headerCols(html)])
    })
  }
})

describe('the asset page skeleton reserves the activity table it precedes', () => {
  // It cannot reuse ActivityTable (that component imports ui.tsx, which owns this
  // skeleton), so the two headers are kept in step by this test instead.
  it('has the same columns as the table that replaces it', () => {
    const table = renderToStaticMarkup(<ActivityTable rows={[]} now={0} loading pageSize={5} />)
    const skeleton = renderToStaticMarkup(<AssetDetailSkeleton />)
    const panel = skeleton.slice(skeleton.lastIndexOf('<div class="panel">'))

    expect(headerCols(panel)).toBe(headerCols(table))
    for (const n of skeletonCells(panel)) expect(n).toBe(headerCols(table))
  })
})
