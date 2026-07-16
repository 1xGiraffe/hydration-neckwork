import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Dash, Sparkline } from '../src/components/ui'
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
    expect(html).toContain('$1.2k')
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
