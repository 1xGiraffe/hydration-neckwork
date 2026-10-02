import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { VolumeSection } from '../src/components/AccountSections'
import { api } from '../src/api/explorer'
import type { VolumeHistory, VolumeScope } from '../src/types'
import { volumeHistoryKey } from '../src/hooks/useExplorerData'

// The account/tag Overview's Volume section: the header's "Trading" figure over
// time. It exists exactly where the header says the scope traded, shows its
// skeleton while the history loads, and states the total volume as its headline
// beside the 24H / 7D / 30D / 12M strip (the Value strip's windows), with neutral
// bars drawn like the Value chart (no axes).

const HISTORY: VolumeHistory = {
  stepSec: 86_400,
  buckets: [
    { ts: '2026-09-28 00:00:00', endTs: '2026-09-29 00:00:00', blockHeight: 100, volumeUsd: 1_200, trades: 3 },
    { ts: '2026-09-29 00:00:00', endTs: '2026-09-30 00:00:00', blockHeight: 200, volumeUsd: 0, trades: 0 },
    { ts: '2026-09-30 00:00:00', endTs: '2026-10-01 00:00:00', blockHeight: 300, volumeUsd: 4_870, trades: 7 },
  ],
  totals: { d1: 4_870, d7: 6_070, d30: 6_070, d365: 90_100, all: 112_000 },
  asOfBlock: 299,
}

function render(scope: VolumeScope, tradingVolumeUsd: number | undefined, data?: VolumeHistory): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (data) queryClient.setQueryData(volumeHistoryKey(scope), data)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><VolumeSection scope={scope} tradingVolumeUsd={tradingVolumeUsd} /></QueryClientProvider>)
}

const ACCOUNT: VolumeScope = { kind: 'account', address: '12VN3cXsgAjkQnbjEBRkydickdnnuAZwdUYaJWj1NJjzoq25' }

describe('VolumeSection', () => {
  it('renders nothing for a scope that never traded', () => {
    expect(render(ACCOUNT, undefined, HISTORY)).toBe('')
    expect(render(ACCOUNT, 0, HISTORY)).toBe('')
  })

  it('shows the card skeleton while the history loads', () => {
    const html = render(ACCOUNT, 112_000)
    expect(html).toContain('Volume')
    expect(html).toContain('chart-card-skeleton')
  })

  it('states the total as its headline, the four trailing figures and the bars', () => {
    const html = render(ACCOUNT, 112_000, HISTORY)
    expect(html).not.toContain('traded in view')
    expect(html).not.toContain('All time')
    expect(html).toContain('pf-head')
    for (const label of ['24H', '7D', '30D', '12M']) expect(html).toContain(`>${label}<`)
    expect(html).toContain('$90.1k')
    // The headline is the total, the header's own "Trading" figure.
    expect(html.indexOf('$112k')).toBeLessThan(html.indexOf('>24H<'))
    // Bars like the Value chart: no axis labels.
    expect(html).not.toContain('hdx-ax')
    expect(html).toContain('<rect')
    expect(html).toContain('$6.07k')
    expect(html).toContain('$4.87k')
    expect(html).toContain('$112k')
    // The neutral ink of /activity's unfiltered daily bars.
    expect(html).toContain('var(--chart-neutral)')
    expect(html).not.toContain('var(--cat-trade)')
    expect(html).toContain('data-zoom-key="zv"')
    expect(html).not.toContain('members counts for both')
  })

  it('carries no members note on a tag', () => {
    const html = render({ kind: 'tag', tagId: 'treasury' }, 112_000, HISTORY)
    expect(html).toContain('<div class="sec-title">Volume</div>')
    expect(html).not.toContain('members counts for both')
  })

  it('renders on a list tag and keys it by list and tag', () => {
    const scope: VolumeScope = { kind: 'list-tag', listId: 'L1', tagId: 'T1' }
    const html = render(scope, 112_000, HISTORY)
    expect(html).not.toContain('members counts for both')
    expect(html).toContain('$112k')
    expect(html).toContain('data-zoom-key="zv"')
    expect(render(scope, 0, HISTORY)).toBe('')
    // The public surface (empty list id) and an authed one never share an entry.
    expect(volumeHistoryKey(scope)).not.toEqual(volumeHistoryKey({ kind: 'list-tag', listId: '', tagId: 'T1' }))
    expect(volumeHistoryKey({ kind: 'tag', tagId: 'T1' })).not.toEqual(volumeHistoryKey({ kind: 'list-tag', listId: '', tagId: 'T1' }))
  })
})

describe('api.volumeHistory addresses each scope\'s own route', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('account, tag, an authed list tag and a public list tag, with the zoom window', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request) => {
      urls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(HISTORY), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))
    await api.volumeHistory(ACCOUNT)
    await api.volumeHistory({ kind: 'tag', tagId: 'treasury' }, { fromBlock: 5, toBlock: 9 })
    await api.volumeHistory({ kind: 'list-tag', listId: 'L1', tagId: 'T1' })
    await api.volumeHistory({ kind: 'list-tag', listId: '', tagId: 'T1' }, { fromBlock: 5, toBlock: 9 })
    const paths = urls.map(u => { const x = new URL(u, 'http://x'); return x.pathname + x.search })
    expect(paths[0]).toMatch(/\/explorer\/address\/12VN3cXsgAjkQnbjEBRkydickdnnuAZwdUYaJWj1NJjzoq25\/volume-history$/)
    expect(paths[1]).toMatch(/\/explorer\/tag\/treasury\/volume-history\?fromBlock=5&toBlock=9$/)
    expect(paths[2]).toMatch(/\/user\/list-tag\/L1\/T1\/volume-history$/)
    expect(paths[3]).toMatch(/\/explorer\/list-tag\/T1\/volume-history\?fromBlock=5&toBlock=9$/)
  })
})
