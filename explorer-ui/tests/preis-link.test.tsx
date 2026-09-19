import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Assets } from '../src/pages/Assets'
import { PREIS_URL } from '../src/surfaces'

// Preis is a separate app on its own host, reached from the Assets list and
// from the Assets nav menu. Both entries have to leave the Explorer in a way a
// reader can see BEFORE clicking, which is the part a refactor loses silently:
// a router Link renders the same text, navigates in place, and would try to
// route an absolute URL as a path.

const ASSETS = [
  { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', price: 0.00007706, change24h: 0.04, change7d: 0.06, holderCount: 60620, amountUsd: 49_500_000, sparkline: null, xcDestination: null },
]

function render(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['assets'], ASSETS)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><Assets /></QueryClientProvider>)
}

describe('the preis offer on the assets page', () => {
  const html = render()

  it('opens preis in a new window, with the tab-nabbing guards', () => {
    const anchor = /<a[^>]*href="([^"]*)"[^>]*>Open preis[^<]*<\/a>/.exec(html)
    expect(anchor, 'no preis link on the assets page').not.toBeNull()
    expect(anchor![1]).toBe(PREIS_URL)
    const tag = anchor![0]
    expect(tag).toContain('target="_blank"')
    expect(tag).toContain('rel="noopener noreferrer"')
  })

  it('says what is on the other side rather than only where it goes', () => {
    // A bare URL is not an offer. The line names what preis adds over the
    // 7-day sparkline this table already shows.
    expect(html).toMatch(/candle by candle/)
    expect(html).toMatch(/7-day glance/)
  })

  it('marks the link as leaving the Explorer in its own text', () => {
    // The trailing ↗ is the app's existing external affordance (AssetDetail's
    // "Open in preis", Account's "Open in Hydration"), so it reads the same
    // wherever it appears — including to a reader who cannot see the cursor.
    expect(html).toContain('Open preis ↗')
  })
})
